#!/usr/bin/env python3
"""
Static file server + local caching proxy for Københavns Sol.

Overpass and DMI requests are proxied through here and cached to disk under
data/, keyed by request content. OSM data (venues, buildings) changes rarely,
so it's cached for 15 days; weather is cached for only 20 minutes since it
needs to stay current. This means clicking areas on and off re-uses cached
data instead of re-hitting the public Overpass/DMI APIs every time.
"""
import hashlib
import http.server
import json
import os
import re
import threading
import time
import urllib.request
import urllib.error
from collections import defaultdict, deque
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs, quote

USER_AGENT = 'FollowTheSun/1.0 (personal weather/shadow map; contact: github.com/iasonrap)'

# OSM data (venues, buildings) barely changes day to day, so it's cached
# far longer than the weather, which needs to stay fresh.
OVERPASS_CACHE_TTL_SECONDS = 25 * 24 * 60 * 60  # 25 days

# DMI's observation stations report a new reading every 10 minutes
# (confirmed empirically: temp_dry/wind_speed timestamps for station 06180
# land on :X0, :X0+10, :X0+20...) — caching any longer than that just serves
# staler-than-necessary data for no reason; any shorter just re-fetches the
# same 10-minute reading.
WEATHER_CACHE_TTL_SECONDS = 10 * 60  # 10 minutes

# The HARMONIE DINI forecast model itself only recomputes every 3 hours
# (00/03/06/09/12/15/18/21 UTC — confirmed via DMI's own docs), but each run
# publishes hourly-resolution steps ~2.5 days out. We pick the step nearest
# to "now", and that selection only ever changes once an hour — so there is
# no data-freshness benefit to polling more often than hourly; it would just
# re-fetch the same run's data against an endpoint that rate-limits more
# aggressively than the observation one. 60 minutes is the actual useful
# resolution here, not an arbitrary choice.
FORECAST_CACHE_TTL_SECONDS = 60 * 60
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')

OVERPASS_URLS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
]
DMI_OBS_URL = 'https://opendataapi.dmi.dk/v2/metObs/collections/observation/items'
DMI_FORECAST_URL = 'https://opendataapi.dmi.dk/v1/forecastedr/collections/harmonie_dini_sf/position'

# The only files this app ever intends to serve over HTTP. Everything else in
# the project directory (server.py, CLAUDE.md, .git/, data/, .gitignore) must
# stay unreachable — see the do_GET allowlist check for why this is an
# allowlist and not a blocklist.
PUBLIC_PATHS = {'/', '/index.html', '/app.js', '/readme.md'}

# --- Hardening for running this publicly, not just on localhost --------
#
# These endpoints proxy to third-party APIs with no auth in front of them.
# Without limits, anyone who finds the URL could use this server as a free
# open proxy to Overpass/DMI (burning our quota, risking our IP getting
# rate-limited or blocked by them) or fill the disk with cache files keyed
# by arbitrary input. None of this matters for local personal use, but it
# does the moment this is reachable from the internet.
MAX_OVERPASS_BODY_BYTES = 20_000  # our real queries are a few hundred bytes
ALLOWED_WEATHER_PARAMETERS = {'cloud_cover', 'temp_dry', 'wind_speed', 'wind_dir'}
STATION_ID_RE = re.compile(r'^\d{4,6}$')
RATE_LIMIT_WINDOW_SECONDS = 60


def make_rate_limiter(max_requests):
    lock = threading.Lock()
    hits = defaultdict(deque)  # client_ip -> deque of recent request timestamps

    def check(client_ip):
        now = time.time()
        with lock:
            q = hits[client_ip]
            while q and now - q[0] > RATE_LIMIT_WINDOW_SECONDS:
                q.popleft()
            if len(q) >= max_requests:
                return True
            q.append(now)
            return False
    return check


# Two separate budgets, not one shared one — they were originally one
# (RATE_LIMIT_MAX_REQUESTS = 30 for everything), which broke real usage: a
# single area load fans out into an Overpass call, several per-tile forecast
# calls, and a few observation calls, and static page-load/tab-switch
# requests were sharing that same 30/min ceiling once those got rate-limited
# too — confirmed live, a single area load followed by opening the About tab
# tripped the limit and readme.md failed to fetch. What actually matters for
# *external* safety is capping the calls that cost a real third-party
# request (Overpass/DMI) — that budget stays tight, but not *this* tight:
# 30/min was still too low even after the split, confirmed live a second
# time — one area load alone costs ~7-10 of these (2 Overpass + 3 weather +
# 2-5 forecast tiles), and multi-select area browsing is a real, intended
# feature of this app, not abuse. Loading 3-4 areas in quick succession
# exhausted the budget and every area after that failed with "Overpass API
# may be busy," which was our own rate limiter, not Overpass — a doubly
# misleading failure (see fetchOverpass's ownRateLimit tag in app.js,
# which exists specifically to stop this from being misattributed again).
# 120/min comfortably covers loading all ten areas back to back while still
# bounding runaway/scripted abuse well below what a real one is capable of.
api_rate_limited = make_rate_limiter(120)     # protects the Overpass/DMI proxies specifically
static_rate_limited = make_rate_limiter(120)  # protects the server itself from flooding

# HARMONIE DINI's native resolution is ~2km — querying at a venue's exact
# coordinate buys no real accuracy over querying at the cell it falls in, but
# it does mean every venue in an area would otherwise be a separate cache
# entry and a separate upstream request. Snapping to this grid before caching
# means venues (even across different areas) that land in the same cell share
# one cache file and one DMI request.
FORECAST_GRID_LAT_STEP = 0.018   # ~2km of latitude
FORECAST_GRID_LON_STEP = 0.032   # ~2km of longitude at Copenhagen's latitude

_forecast_fetch_locks = defaultdict(threading.Lock)
_forecast_fetch_locks_guard = threading.Lock()


def snap_to_forecast_grid(lat, lon):
    snapped_lat = round(lat / FORECAST_GRID_LAT_STEP) * FORECAST_GRID_LAT_STEP
    snapped_lon = round(lon / FORECAST_GRID_LON_STEP) * FORECAST_GRID_LON_STEP
    return round(snapped_lat, 4), round(snapped_lon, 4)


def _forecast_lock_for(key):
    # A dict of per-key locks so concurrent requests for *different* cells
    # don't block each other, only requests racing for the *same* cell do.
    with _forecast_fetch_locks_guard:
        return _forecast_fetch_locks[key]


def valid_latlon(value, lo, hi):
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if lo <= f <= hi else None


os.makedirs(DATA_DIR, exist_ok=True)

# --- API call log (for the "Track" tab) ---------------------------------
#
# Every proxied request (Overpass venues/buildings, DMI forecast tiles, DMI
# observation stations) gets one line appended here, regardless of whether
# it was served from cache — the whole point is to make cache effectiveness
# (and any accidental spamming) visible, not just successful fetches.
LOG_PATH = os.path.join(DATA_DIR, 'api_log.jsonl')
MAX_LOG_BYTES = 5 * 1024 * 1024  # trim well before this becomes slow to parse
LOG_TRIM_KEEP_LINES = 10_000
_log_lock = threading.Lock()


def log_api_call(kind, detail, cache_status):
    entry = {'ts': datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z'),
              'kind': kind, 'cache': cache_status, **detail}
    line = json.dumps(entry) + '\n'
    with _log_lock:
        try:
            if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > MAX_LOG_BYTES:
                with open(LOG_PATH, 'r', encoding='utf-8') as f:
                    lines = f.readlines()[-LOG_TRIM_KEEP_LINES:]
                with open(LOG_PATH, 'w', encoding='utf-8') as f:
                    f.writelines(lines)
            with open(LOG_PATH, 'a', encoding='utf-8') as f:
                f.write(line)
        except OSError as err:
            print('Warning: failed to write api log', err)


def read_log_entries(limit):
    if not os.path.exists(LOG_PATH):
        return []
    try:
        with open(LOG_PATH, 'r', encoding='utf-8') as f:
            lines = f.readlines()
    except OSError:
        return []
    entries = []
    for line in lines[-limit:]:
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return entries


# Only used for the log's own query-string fields (areaId, kind), which are
# never trusted for anything but display. app.js's Track tab already
# HTML-escapes every log field before rendering it, but validating here too
# (rather than relying on that alone) means a client sending garbage can't
# even get it written to the log file, let alone pollute the charts/table.
_LOG_FIELD_RE = re.compile(r'^[a-zA-Z0-9_-]{1,60}$')


def log_field(value):
    return value if value and _LOG_FIELD_RE.match(value) else ''


def cache_path(prefix, key):
    digest = hashlib.sha1(key.encode('utf-8')).hexdigest()
    return os.path.join(DATA_DIR, f'{prefix}_{digest}.json')


def read_cache(path, ttl_seconds):
    if not os.path.exists(path):
        return None
    if time.time() - os.path.getmtime(path) > ttl_seconds:
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return f.read()
    except OSError:
        return None


def read_stale_cache(path):
    """Ignore TTL entirely — used as a last-resort fallback when the live
    fetch fails, so a past-expiry (or orphaned, e.g. from an old bbox) cache
    file is still better than a hard error."""
    if not os.path.exists(path):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return f.read()
    except OSError:
        return None


def write_cache(path, body):
    try:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(body)
    except OSError as err:
        print('Warning: failed to write cache file', path, err)


def fetch_overpass(query, retries=2):
    last_err = None
    for attempt in range(retries + 1):
        for url in OVERPASS_URLS:
            try:
                req = urllib.request.Request(
                    url, data=query.encode('utf-8'), method='POST',
                    headers={'User-Agent': USER_AGENT}
                )
                with urllib.request.urlopen(req, timeout=90) as resp:
                    return resp.read().decode('utf-8')
            except Exception as err:
                print('Overpass mirror failed', url, err, flush=True)
                last_err = err
        if attempt < retries:
            time.sleep(2 * (attempt + 1))
    raise last_err


def fetch_dmi(station_id, parameter_id):
    url = (f'{DMI_OBS_URL}?parameterId={quote(parameter_id)}&stationId={quote(station_id)}'
           f'&limit=1&sortorder=observed,DESC')
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode('utf-8')


def _parse_iso(t):
    return datetime.strptime(t, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc)


def fetch_dmi_forecast_cloud_cover(lat, lon, retries=2):
    """Cloud cover from DMI's HARMONIE DINI forecast model (2km grid), read at the
    nearest available hour to now. Used instead of the sparse observation stations
    because the model gives genuinely different values area-to-area (~2km resolution)
    where only two-ish observation stations cover all of central Copenhagen.

    This endpoint rate-limits more aggressively than the observation API — retry
    with backoff rather than erroring out on the first 429.

    retries=2 (worst case ~6s of backoff) is deliberately much lower than the
    weather/overpass proxies' own retry budgets — this used to be retries=4
    with a 3/6/9/12s backoff (worst case ~30s) from when only one forecast
    call happened per area load. Since the per-venue grid-tiling change,
    an area load fires off one call per distinct grid cell *in parallel*
    (Promise.all in fetchVenueForecasts), so when DMI is genuinely
    rate-limiting hard, every one of those parallel calls pays this same
    worst-case tax independently, and the user is stuck looking at the
    loading overlay for however long the *slowest* one takes — confirmed
    live at over 60s total with the old budget during a real DMI 429
    spell. The stale-cache fallback is already a good answer within its
    60-minute TTL, so failing fast into it beats making someone wait
    a full minute for marginally fresher data."""
    url = (f'{DMI_FORECAST_URL}?coords={quote(f"POINT({lon} {lat})")}'
           f'&parameter-name=fraction-of-cloud-cover&crs=crs84')
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})

    last_err = None
    data = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            break
        except Exception as err:
            print('DMI forecast attempt failed', err, flush=True)
            last_err = err
            if attempt < retries:
                time.sleep(2 * (attempt + 1))
    if data is None:
        raise last_err

    times = data['domain']['axes']['t']['values']
    values = data['ranges']['fraction-of-cloud-cover']['values']
    now = datetime.now(timezone.utc)

    best_i, best_diff = 0, None
    for i, t in enumerate(times):
        diff = abs((_parse_iso(t) - now).total_seconds())
        if best_diff is None or diff < best_diff:
            best_diff, best_i = diff, i

    return json.dumps({'cloudCover': round(values[best_i] * 100), 'time': times[best_i]})


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # This is a local dev tool under active development — never let the
        # browser cache index.html/app.js/readme.md, or edits silently don't
        # show up until a hard refresh (which varies by browser).
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def _send_json(self, status, body, cache_status):
        payload = body.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('X-Cache', cache_status)
        self.end_headers()
        self.wfile.write(payload)

    def _send_error_json(self, status, message):
        self._send_json(status, json.dumps({'error': message}), 'ERROR')

    def _client_ip(self):
        return self.client_address[0]

    def do_POST(self):
        if self.path.startswith('/api/overpass'):
            if api_rate_limited(self._client_ip()):
                self._send_error_json(429, 'Too many requests')
                return

            try:
                length = int(self.headers.get('Content-Length', 0))
            except ValueError:
                length = -1
            if length < 0 or length > MAX_OVERPASS_BODY_BYTES:
                self._send_error_json(413, 'Request body too large')
                self.close_connection = True
                return

            query = self.rfile.read(length).decode('utf-8', errors='replace')
            path = cache_path('overpass', query)

            # areaId/kind are for the Track tab's logging only — never part of
            # the cache key, and never trusted beyond display.
            qs = parse_qs(urlparse(self.path).query)
            log_detail = {
                'areaId': log_field(qs.get('areaId', [''])[0]),
                'requestKind': log_field(qs.get('kind', [''])[0])
            }

            cached = read_cache(path, OVERPASS_CACHE_TTL_SECONDS)
            if cached is not None:
                log_api_call('overpass', log_detail, 'HIT')
                self._send_json(200, cached, 'HIT')
                return

            try:
                body = fetch_overpass(query)
                write_cache(path, body)
                log_api_call('overpass', log_detail, 'MISS')
                self._send_json(200, body, 'MISS')
            except Exception as err:
                stale = read_stale_cache(path)
                if stale is not None:
                    print('Overpass fetch failed, serving stale cache', path, err, flush=True)
                    log_api_call('overpass', log_detail, 'STALE')
                    self._send_json(200, stale, 'STALE')
                else:
                    print('Overpass fetch failed, no stale cache available', path, err, flush=True)
                    log_api_call('overpass', log_detail, 'ERROR')
                    self._send_error_json(502, 'Upstream request failed')
            return

        self.send_error(404)

    def do_GET(self):
        # Every GET is rate-limited — static files included, not just
        # /api/forecast/weather — so basic request-flooding can't dodge the
        # limit just by hitting a non-API path (confirmed before this fix:
        # 40/40 rapid requests to /index.html returned 200 with zero
        # throttling). Which budget applies depends on whether the route
        # costs a real upstream Overpass/DMI request or not — see
        # api_rate_limited/static_rate_limited above.
        is_upstream_route = self.path.startswith('/api/forecast') or self.path.startswith('/api/weather')
        limiter = api_rate_limited if is_upstream_route else static_rate_limited
        if limiter(self._client_ip()):
            if self.path.startswith('/api/'):
                self._send_error_json(429, 'Too many requests')
            else:
                self.send_error(429, 'Too many requests')
            return

        if self.path.startswith('/api/forecast'):
            qs = parse_qs(urlparse(self.path).query)
            # Denmark-ish bounding box — generous, just enough to catch garbage/injection
            # attempts rather than to be a precise territorial check.
            lat = valid_latlon(qs.get('lat', [''])[0], 54, 58)
            lon = valid_latlon(qs.get('lon', [''])[0], 7, 16)
            if lat is None or lon is None:
                self._send_error_json(400, 'Invalid lat/lon')
                return

            snapped_lat, snapped_lon = snap_to_forecast_grid(lat, lon)
            key = f'{snapped_lat},{snapped_lon}'
            path = cache_path('forecast', key)
            log_detail = {'cell': key}

            cached = read_cache(path, FORECAST_CACHE_TTL_SECONDS)
            if cached is not None:
                log_api_call('forecast', log_detail, 'HIT')
                self._send_json(200, cached, 'HIT')
                return

            # Per-venue querying means many requests can land on the same grid
            # cell within milliseconds of each other (a whole area's worth of
            # venues loading at once) — without this lock they'd all miss the
            # not-yet-written cache and fire off duplicate DMI requests, which
            # is exactly the rate-limit stampede the grid-snapping is meant to
            # avoid in the first place.
            with _forecast_lock_for(key):
                cached = read_cache(path, FORECAST_CACHE_TTL_SECONDS)
                if cached is not None:
                    log_api_call('forecast', log_detail, 'HIT')
                    self._send_json(200, cached, 'HIT')
                    return
                try:
                    body = fetch_dmi_forecast_cloud_cover(snapped_lat, snapped_lon)
                    write_cache(path, body)
                    log_api_call('forecast', log_detail, 'MISS')
                    self._send_json(200, body, 'MISS')
                except Exception as err:
                    stale = read_stale_cache(path)
                    if stale is not None:
                        print('DMI forecast fetch failed, serving stale cache', path, err, flush=True)
                        log_api_call('forecast', log_detail, 'STALE')
                        self._send_json(200, stale, 'STALE')
                    else:
                        print('DMI forecast fetch failed, no stale cache available', path, err, flush=True)
                        log_api_call('forecast', log_detail, 'ERROR')
                        self._send_error_json(502, 'Upstream request failed')
            return

        if self.path.startswith('/api/weather'):
            qs = parse_qs(urlparse(self.path).query)
            station_id = qs.get('stationId', [''])[0]
            parameter_id = qs.get('parameterId', ['cloud_cover'])[0]
            if not STATION_ID_RE.match(station_id):
                self._send_error_json(400, 'Invalid stationId')
                return
            if parameter_id not in ALLOWED_WEATHER_PARAMETERS:
                self._send_error_json(400, 'Invalid parameterId')
                return
            path = cache_path('weather', f'{parameter_id}|{station_id}')
            log_detail = {'stationId': station_id, 'parameterId': parameter_id}

            cached = read_cache(path, WEATHER_CACHE_TTL_SECONDS)
            if cached is not None:
                log_api_call('weather', log_detail, 'HIT')
                self._send_json(200, cached, 'HIT')
                return

            try:
                body = fetch_dmi(station_id, parameter_id)
                write_cache(path, body)
                log_api_call('weather', log_detail, 'MISS')
                self._send_json(200, body, 'MISS')
            except Exception as err:
                stale = read_stale_cache(path)
                if stale is not None:
                    print('DMI fetch failed, serving stale cache', path, err, flush=True)
                    log_api_call('weather', log_detail, 'STALE')
                    self._send_json(200, stale, 'STALE')
                else:
                    print('DMI fetch failed, no stale cache available', path, err, flush=True)
                    log_api_call('weather', log_detail, 'ERROR')
                    self._send_error_json(502, 'Upstream request failed')
            return

        if self.path.startswith('/api/logs'):
            qs = parse_qs(urlparse(self.path).query)
            try:
                limit = min(max(int(qs.get('limit', ['5000'])[0]), 1), 10_000)
            except ValueError:
                limit = 5000
            entries = read_log_entries(limit)
            self._send_json(200, json.dumps({'entries': entries}), 'N/A')
            return

        # Everything else must be an exact match against the small, fixed set
        # of files this app actually intends to serve. This is an allowlist,
        # not a blocklist, on purpose — a blocklist (deny .git/, deny data/,
        # deny server.py, ...) is exactly the kind of thing that's fine until
        # the next file is added and someone forgets to extend it. This was a
        # real, confirmed vulnerability before this fix: with plain
        # SimpleHTTPRequestHandler serving the whole project directory,
        # anyone could browse a live directory listing of data/ (every
        # cached Overpass/DMI response plus the *entire* unbounded
        # api_log.jsonl, bypassing /api/logs' own size cap), download
        # server.py's full source, and pull the whole .git/ history
        # (.git/config, .git/HEAD, .git/logs/HEAD all returned 200) —
        # confirmed live with curl, not theoretical.
        url_path = urlparse(self.path).path
        if url_path in PUBLIC_PATHS:
            super().do_GET()
            return
        self.send_error(404)


if __name__ == '__main__':
    port = 8123
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f'Serving Københavns Sol on http://localhost:{port} '
          f'(cache in ./data/ — OSM: {OVERPASS_CACHE_TTL_SECONDS // 86400}d, '
          f'weather: {WEATHER_CACHE_TTL_SECONDS // 60}m, forecast: {FORECAST_CACHE_TTL_SECONDS // 60}m)')
    # ThreadingHTTPServer, not plain HTTPServer — the latter handles one
    # connection at a time, so a single slow/hanging client would block
    # every other request. Trivial fix, meaningfully better once this is
    # reachable from more than just your own browser.
    http.server.ThreadingHTTPServer(('localhost', port), Handler).serve_forever()
