#!/usr/bin/env python3
"""
Static file server + local caching proxy for Københavns Sol.

Overpass and MET Norway (Yr) requests are proxied through here and cached to
disk under data/, keyed by request content. OSM data (venues, buildings)
changes rarely, so it's cached for weeks; weather is cached for whatever Yr's
own Expires header says. This means clicking areas on and off re-uses cached
data instead of re-hitting the public APIs every time.

DMI was this app's weather source until this branch (`api-yr`) — dropped
after DMI's forecast endpoint spent an evening either 429-ing or timing out
outright, sustained enough that no retry budget fixed it (see git history on
`solskin` for that investigation). MET Norway's locationforecast API
(api.met.no, the data behind yr.no) replaces both of DMI's old sources
(observation stations + forecast grid) with ONE per-cell call that returns
temp/wind/cloud together — no more curated station list, and temp/wind
become per-venue instead of per-area as a side effect, not extra work.
"""
import hashlib
import http.server
import json
import os
import re
import socket
import threading
import time
import urllib.request
import urllib.error
from collections import defaultdict, deque
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse, parse_qs, quote

USER_AGENT = 'KobenhavnsSol/1.0 (personal weather/shadow map; contact: github.com/iasonrap)'

# OSM data (venues, buildings) barely changes day to day, so it's cached
# far longer than the weather, which needs to stay fresh.
OVERPASS_CACHE_TTL_SECONDS = 25 * 24 * 60 * 60  # 25 days

# Fallback only — Yr sends its own Expires header per response (their Terms
# of Service require respecting it), which is what actually governs the
# weather cache's lifetime (see read_cache_with_expiry). This is just the
# ceiling used if that header is ever missing/unparseable, and a sane
# default in that gap: observed live to be ~30-60 minutes in practice.
WEATHER_CACHE_TTL_SECONDS = 60 * 60
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')

OVERPASS_URLS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
]
# MET Norway's Locationforecast API (the data behind yr.no) — free, no API
# key, no query-string identification needed (unlike DMI); it identifies
# callers purely by User-Agent, and 403s any request using a generic/library
# default one (see USER_AGENT above — it's deliberately descriptive).
# 20 req/s per app per their Terms of Service, worlds more generous than
# DMI's per-minute throttling. Coordinates must be truncated to 4 decimals
# per their ToS (snap_to_weather_grid already does more rounding than that).
YR_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact'

# The only files this app ever intends to serve over HTTP. Everything else in
# the project directory (server.py, CLAUDE.md, .git/, data/, .gitignore) must
# stay unreachable — see the do_GET allowlist check for why this is an
# allowlist and not a blocklist.
PUBLIC_PATHS = {'/', '/index.html', '/app.js', '/readme.md'}

# --- Hardening for running this publicly, not just on localhost --------
#
# These endpoints proxy to third-party APIs with no auth in front of them.
# Without limits, anyone who finds the URL could use this server as a free
# open proxy to Overpass/Yr (burning our quota, risking our IP getting
# rate-limited or blocked by them) or fill the disk with cache files keyed
# by arbitrary input. None of this matters for local personal use, but it
# does the moment this is reachable from the internet.
MAX_OVERPASS_BODY_BYTES = 20_000  # our real queries are a few hundred bytes
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
# single area load fans out into an Overpass call plus several per-tile
# weather calls, and static page-load/tab-switch requests were sharing that
# same 30/min ceiling once those got rate-limited too — confirmed live, a
# single area load followed by opening the About tab tripped the limit and
# readme.md failed to fetch. What actually matters for *external* safety is
# capping the calls that cost a real third-party request (Overpass/Yr) —
# that budget stays tight, but not *this* tight: 30/min was still too low
# even after the split, confirmed live a second time — one area load alone
# costs several of these, and multi-select area browsing is a real, intended
# feature of this app, not abuse. Loading 3-4 areas in quick succession
# exhausted the budget and every area after that failed with "Overpass API
# may be busy," which was our own rate limiter, not Overpass — a doubly
# misleading failure (see fetchOverpass's ownRateLimit tag in app.js,
# which exists specifically to stop this from being misattributed again).
# 120/min comfortably covers loading all ten areas back to back while still
# bounding runaway/scripted abuse well below what a real one is capable of —
# and it's well inside Yr's own 20 req/s ToS limit too.
api_rate_limited = make_rate_limiter(120)     # protects the Overpass/Yr proxies specifically
static_rate_limited = make_rate_limiter(120)  # protects the server itself from flooding

# Not tied to any one upstream model's native resolution the way the old
# DMI-specific grid was — this just controls how many venues share one
# cached weather cell. Kept at roughly the same ~2km size that worked well
# for DMI's forecast grid; querying at a venue's exact coordinate buys no
# real accuracy over querying at the cell it falls in, but does mean every
# venue in an area would otherwise be a separate cache entry and a separate
# upstream request. Snapping to this grid before caching means venues (even
# across different areas) that land in the same cell share one cache file
# and one Yr request — also required by Yr's own Terms of Service, which
# ask callers to truncate coordinates rather than query at full precision.
WEATHER_GRID_LAT_STEP = 0.018   # ~2km of latitude
WEATHER_GRID_LON_STEP = 0.032   # ~2km of longitude at Copenhagen's latitude

_weather_fetch_locks = defaultdict(threading.Lock)
_weather_fetch_locks_guard = threading.Lock()


def snap_to_weather_grid(lat, lon):
    snapped_lat = round(lat / WEATHER_GRID_LAT_STEP) * WEATHER_GRID_LAT_STEP
    snapped_lon = round(lon / WEATHER_GRID_LON_STEP) * WEATHER_GRID_LON_STEP
    return round(snapped_lat, 4), round(snapped_lon, 4)


def _weather_lock_for(key):
    # A dict of per-key locks so concurrent requests for *different* cells
    # don't block each other, only requests racing for the *same* cell do.
    with _weather_fetch_locks_guard:
        return _weather_fetch_locks[key]


def valid_latlon(value, lo, hi):
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if lo <= f <= hi else None


os.makedirs(DATA_DIR, exist_ok=True)

# --- API call log (for the "Track" tab) ---------------------------------
#
# Every proxied request (Overpass venues/buildings, Yr weather tiles) gets
# one line appended here, regardless of whether it was served from cache —
# the whole point is to make cache effectiveness
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


# Yr's own Expires response header governs weather cache lifetime, not a
# fixed TTL like Overpass's — their Terms of Service specifically ask
# clients to respect it, and it also happens to be more correct than a
# guessed constant (they'll shorten it around a forecast run's update, e.g.).
# The expiry travels alongside the body in one small JSON envelope on disk
# rather than as a second file or relying on file mtime (mtime would break
# the moment write_cache's file gets touched/copied for any reason, and
# doesn't let two different prefixes reuse read_cache's ttl-from-mtime
# logic with two different meanings at once).
def write_cache_with_expiry(path, body, expires_ts):
    write_cache(path, json.dumps({'expires': expires_ts, 'body': body}))


def read_cache_with_expiry(path, allow_stale=False):
    if not os.path.exists(path):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            wrapper = json.loads(f.read())
    except (OSError, json.JSONDecodeError):
        return None
    if not allow_stale and time.time() > wrapper.get('expires', 0):
        return None
    return wrapper.get('body')


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


def _parse_iso(t):
    return datetime.fromisoformat(t.replace('Z', '+00:00'))


def fetch_yr_weather(lat, lon, retries=2):
    """Temperature, wind, and cloud cover together from MET Norway's
    Locationforecast API (api.met.no — the data behind yr.no), read at the
    timeseries entry nearest to now. This single call replaces both of
    DMI's old sources (a curated observation-station list for temp/wind, a
    separate forecast-grid call for cloud cover) — Yr's timeseries already
    carries all three per grid cell, so there's no separate "station" concept
    to curate any more, and temp/wind become per-venue for free instead of
    the old area-wide single-station reading.

    Returns (body_json_string, expires_unix_ts) — the caller is responsible
    for caching against that expiry (see write_cache_with_expiry), not a
    fixed TTL, per Yr's own Terms of Service ("cache API responses and use
    cache headers").

    retries=2 with a short 2/4s backoff, not because Yr is known to be
    flaky (the opposite, in initial testing — 20 req/s ToS limit vs. DMI's
    aggressive per-minute throttling) but because *no* retry budget saves a
    genuinely-down upstream (confirmed the hard way with DMI: raising the
    budget just made failures take longer, not fewer). Small and cheap is
    the right default; revisit only with live evidence Yr needs more."""
    url = f'{YR_URL}?lat={lat}&lon={lon}'
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})

    last_err = None
    data = None
    expires_ts = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                expires_header = resp.headers.get('Expires')
                if expires_header:
                    try:
                        expires_ts = parsedate_to_datetime(expires_header).timestamp()
                    except (TypeError, ValueError):
                        expires_ts = None
            break
        except Exception as err:
            print('Yr weather attempt failed', err, flush=True)
            last_err = err
            if attempt < retries:
                time.sleep(2 * (attempt + 1))
    if data is None:
        raise last_err
    if expires_ts is None:
        expires_ts = time.time() + WEATHER_CACHE_TTL_SECONDS

    timeseries = data['properties']['timeseries']
    now = datetime.now(timezone.utc)
    best_entry, best_diff = timeseries[0], None
    for entry in timeseries:
        diff = abs((_parse_iso(entry['time']) - now).total_seconds())
        if best_diff is None or diff < best_diff:
            best_diff, best_entry = diff, entry

    details = best_entry['data']['instant']['details']
    # symbol_code (Yr's own human-facing "how sunny does this look" call,
    # e.g. "clearsky_day"/"partlycloudy_day"/"cloudy") lives under whichever
    # summary window is present — next_1_hours near "now", next_6_hours or
    # next_12_hours further out where finer summaries aren't published.
    symbol_code = None
    for window in ('next_1_hours', 'next_6_hours', 'next_12_hours'):
        summary = best_entry['data'].get(window, {}).get('summary', {})
        if summary.get('symbol_code'):
            symbol_code = summary['symbol_code']
            break

    body = json.dumps({
        'temperature': details.get('air_temperature'),
        'windSpeed': details.get('wind_speed'),
        'windDir': details.get('wind_from_direction'),
        'cloudCover': details.get('cloud_area_fraction'),
        'symbolCode': symbol_code,
        'time': best_entry['time']
    })
    return body, expires_ts


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
        # /api/weather — so basic request-flooding can't dodge the limit
        # just by hitting a non-API path (confirmed before this fix: 40/40
        # rapid requests to /index.html returned 200 with zero throttling).
        # Which budget applies depends on whether the route costs a real
        # upstream Overpass/Yr request or not — see
        # api_rate_limited/static_rate_limited above.
        is_upstream_route = self.path.startswith('/api/weather')
        limiter = api_rate_limited if is_upstream_route else static_rate_limited
        if limiter(self._client_ip()):
            if self.path.startswith('/api/'):
                self._send_error_json(429, 'Too many requests')
            else:
                self.send_error(429, 'Too many requests')
            return

        if self.path.startswith('/api/weather'):
            qs = parse_qs(urlparse(self.path).query)
            # Denmark-ish bounding box — generous, just enough to catch garbage/injection
            # attempts rather than to be a precise territorial check.
            lat = valid_latlon(qs.get('lat', [''])[0], 54, 58)
            lon = valid_latlon(qs.get('lon', [''])[0], 7, 16)
            if lat is None or lon is None:
                self._send_error_json(400, 'Invalid lat/lon')
                return

            snapped_lat, snapped_lon = snap_to_weather_grid(lat, lon)
            key = f'{snapped_lat},{snapped_lon}'
            path = cache_path('weather', key)
            log_detail = {'cell': key}

            cached = read_cache_with_expiry(path)
            if cached is not None:
                log_api_call('weather', log_detail, 'HIT')
                self._send_json(200, cached, 'HIT')
                return

            # Per-venue querying means many requests can land on the same grid
            # cell within milliseconds of each other (a whole area's worth of
            # venues loading at once) — without this lock they'd all miss the
            # not-yet-written cache and fire off duplicate upstream requests,
            # which is exactly the rate-limit stampede the grid-snapping is
            # meant to avoid in the first place.
            with _weather_lock_for(key):
                cached = read_cache_with_expiry(path)
                if cached is not None:
                    log_api_call('weather', log_detail, 'HIT')
                    self._send_json(200, cached, 'HIT')
                    return
                try:
                    body, expires_ts = fetch_yr_weather(snapped_lat, snapped_lon)
                    write_cache_with_expiry(path, body, expires_ts)
                    log_api_call('weather', log_detail, 'MISS')
                    self._send_json(200, body, 'MISS')
                except Exception as err:
                    stale = read_cache_with_expiry(path, allow_stale=True)
                    if stale is not None:
                        print('Yr weather fetch failed, serving stale cache', path, err, flush=True)
                        log_api_call('weather', log_detail, 'STALE')
                        self._send_json(200, stale, 'STALE')
                    else:
                        print('Yr weather fetch failed, no stale cache available', path, err, flush=True)
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
        # cached Overpass/Yr response plus the *entire* unbounded
        # api_log.jsonl, bypassing /api/logs' own size cap), download
        # server.py's full source, and pull the whole .git/ history
        # (.git/config, .git/HEAD, .git/logs/HEAD all returned 200) —
        # confirmed live with curl, not theoretical.
        url_path = urlparse(self.path).path
        if url_path in PUBLIC_PATHS:
            super().do_GET()
            return
        self.send_error(404)


def _lan_ip():
    # Doesn't actually send anything (UDP, connect() only sets the socket's
    # routing without a handshake) — just asks the OS which local interface
    # it would use to reach the internet, which is the LAN IP other devices
    # on the same Wi-Fi can reach this machine at.
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('8.8.8.8', 80))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


if __name__ == '__main__':
    port = 8123
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    # Binds to 0.0.0.0 (all interfaces), not just localhost — deliberate,
    # so a phone or another device on the same Wi-Fi can reach it. This is
    # exactly the "reachable beyond localhost" scenario the hardening
    # elsewhere in this file (rate limiting, the PUBLIC_PATHS allowlist,
    # input validation) was already built for; it wasn't safe to do this
    # before that work, it is now. Still only as safe as the network it's
    # on — fine for a trusted home Wi-Fi, not for a coffee shop's.
    lan_ip = _lan_ip()
    print(f'Serving Københavns Sol — cache in ./data/ '
          f'(OSM: {OVERPASS_CACHE_TTL_SECONDS // 86400}d, '
          f'weather: per Yr\'s own Expires header, ~{WEATHER_CACHE_TTL_SECONDS // 60}m fallback)')
    print(f'  On this machine:        http://localhost:{port}')
    if lan_ip:
        print(f'  On your phone/Wi-Fi:    http://{lan_ip}:{port}')
    else:
        print('  Could not detect a LAN IP for phone access — check you\'re connected to Wi-Fi.')
    # ThreadingHTTPServer, not plain HTTPServer — the latter handles one
    # connection at a time, so a single slow/hanging client would block
    # every other request. Trivial fix, meaningfully better once this is
    # reachable from more than just your own browser.
    http.server.ThreadingHTTPServer(('0.0.0.0', port), Handler).serve_forever()
