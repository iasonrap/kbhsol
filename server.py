#!/usr/bin/env python3
"""
Static file server + local caching proxy for Københavns Sol.

Overpass and MET Norway (Yr) requests are proxied through here and cached to
disk under data/, keyed by request content. OSM data (venues, buildings)
changes rarely, so it's cached for weeks; weather is cached for whatever Yr's
own Expires header says. This means clicking areas on and off re-uses cached
data instead of re-hitting the public APIs every time.

DMI was this app's weather source until the `api-yr` branch — dropped after
DMI's forecast endpoint spent an evening either 429-ing or timing out
outright, sustained enough that no retry budget fixed it (see git history on
`solskin` for that investigation). MET Norway's locationforecast API
(api.met.no, the data behind yr.no) replaces both of DMI's old sources
(observation stations + forecast grid) with ONE per-cell call that returns
temp/wind/cloud together — no more curated station list, and temp/wind
become per-venue instead of per-area as a side effect, not extra work.

This branch (`precipitation`) adds a THIRD upstream: DMI's radar composite,
back for radar only, not for temp/wind/cloud — Yr has no radar product, and
DMI, which runs Denmark's actual radar network, is simply the only source
for this regardless of the forecast-endpoint history above (a different
DMI service, no evidence it shares that reliability problem). Requires
h5py (see requirements.txt) to decode its raw HDF5 composite — the one
exception to this project's stdlib-only rule, since there's no stdlib way
to read HDF5.
"""
import hashlib
import http.server
import io
import json
import math
import os
import re
import socket
import threading
import time
import urllib.request
import urllib.error
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
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

# Bumped whenever fetch_yr_weather's response JSON shape changes (folded
# into the weather cache key below) — without this, an old cache file
# written by a previous version of this code stays on disk and gets
# served as-is for up to WEATHER_CACHE_TTL_SECONDS/Yr's own Expires
# window, and the client silently gets a response shaped for an older
# version of itself. This was a real, confirmed bug, not theoretical: the
# response went from flat fields, to a 3-entry `steps` array, to today's
# 4-entry one (adding the -15m timeline step) across this session without
# this version bump, and a stale 3-entry cache file being read by the
# 4-step-aware client threw `Cannot read properties of undefined (reading
# 'temperature')` on `steps[3]` — which happened INSIDE loadArea's
# synchronous block with no try/catch around it, so the whole area load
# silently died and the loading overlay just sat there showing "Tracing
# shadows" forever, with no visible error. Bump this any time
# fetch_yr_weather's returned JSON shape changes, including changing
# RADAR_NOWCAST_OFFSETS_MINUTES (which changes how many `steps` entries
# there are).
WEATHER_SCHEMA_VERSION = 2
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

# DMI's radar composite (Denmark-wide reflectivity mosaic from all of DMI's
# radar stations) — no API key needed, confirmed live against the real
# endpoint. Refreshes roughly every 5 minutes upstream, and DMI's own
# publish pipeline already lags real time by ~8-12 minutes on its own
# (confirmed live: a composite timestamped 14:45 wasn't available until
# 14:53) — that lag is a floor we can't do anything about. This TTL was
# originally 15 minutes (deliberately not tracking the ~5-minute upstream
# cadence, on the theory that rain moves slowly enough not to need it) but
# that stacked ANOTHER up to 15 minutes on top of DMI's own lag, so a
# "Now" reading could be shown up to ~25 minutes stale — confirmed live
# and reported as feeling "super in the past" at 20 minutes. 5 minutes
# matches DMI's actual refresh cadence: it stops us from re-fetching on
# every single request (a burst of area loads within the same 5 minutes
# still shares one fetch), without adding meaningfully to the lag that's
# already baked into DMI's own pipeline.
DMI_RADAR_ITEMS_URL = 'https://opendataapi.dmi.dk/v1/radardata/collections/composite/items'
RADAR_CACHE_TTL_SECONDS = 5 * 60

# The only files this app ever intends to serve over HTTP. Everything else in
# the project directory (server.py, CLAUDE.md, .git/, data/, .gitignore) must
# stay unreachable — see the do_GET allowlist check for why this is an
# allowlist and not a blocklist.
PUBLIC_PATHS = {'/', '/index.html', '/app.js', '/readme.md', '/exeo.png'}

# --- Hardening for running this publicly, not just on localhost --------
#
# These endpoints proxy to third-party APIs with no auth in front of them.
# Without limits, anyone who finds the URL could use this server as a free
# open proxy to Overpass/Yr (burning our quota, risking our IP getting
# rate-limited or blocked by them) or fill the disk with cache files keyed
# by arbitrary input. None of this matters for local personal use, but it
# does the moment this is reachable from the internet.
MAX_OVERPASS_BODY_BYTES = 20_000  # our real queries are a few hundred bytes
MAX_PRECIPITATION_BODY_BYTES = 30_000  # a full area's worth of [lat,lon] pairs is ~20KB at most
MAX_PRECIPITATION_POINTS = 1000        # Indre By alone has 700+ venues — confirmed live that
                                        # a lower cap here silently 400'd a real, non-abusive load
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


# Unlike weather, there's only ever one radar composite in play at a time
# (it covers all of Denmark in one file, not per-cell) — a single shared
# lock is enough to coalesce a whole area's worth of concurrent requests
# into one upstream DMI fetch, the same purpose _weather_lock_for serves
# per-cell.
_radar_fetch_lock = threading.Lock()


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


def cache_path(prefix, key, ext='json'):
    digest = hashlib.sha1(key.encode('utf-8')).hexdigest()
    return os.path.join(DATA_DIR, f'{prefix}_{digest}.{ext}')


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


# Binary variants of read_cache/write_cache/read_stale_cache, used only for
# the raw DMI radar HDF5 file — it's a binary blob, not JSON text, so the
# text-mode helpers above can't be reused for it as-is.
def read_cache_bytes(path, ttl_seconds):
    if not os.path.exists(path):
        return None
    if time.time() - os.path.getmtime(path) > ttl_seconds:
        return None
    try:
        with open(path, 'rb') as f:
            return f.read()
    except OSError:
        return None


def read_stale_cache_bytes(path):
    if not os.path.exists(path):
        return None
    try:
        with open(path, 'rb') as f:
            return f.read()
    except OSError:
        return None


def write_cache_bytes(path, data):
    try:
        with open(path, 'wb') as f:
            f.write(data)
    except OSError as err:
        print('Warning: failed to write cache file', path, err)


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
    Locationforecast API (api.met.no — the data behind yr.no). This single
    call replaces both of DMI's old sources (a curated observation-station
    list for temp/wind, a separate forecast-grid call for cloud cover) —
    Yr's timeseries already carries all three per grid cell, so there's no
    separate "station" concept to curate any more, and temp/wind become
    per-venue for free instead of the old area-wide single-station reading.

    Returns a "steps" list, one entry per RADAR_NOWCAST_OFFSETS_MINUTES
    offset (0/15/30) — same timeline the radar nowcast uses, so the client
    can scrub one control and get both in sync. This costs nothing extra
    upstream: Yr's response already contains a full timeseries, not just
    one entry, so each offset just picks whichever entry in that same
    response is nearest to now+offset, rather than issuing 3 requests.
    Since Yr's near-term resolution is hourly, offsets that don't cross an
    hour boundary often resolve to the identical entry — expected, not a
    bug (there's no finer Yr data to pick between within the same hour).

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

    def nearest_entry(target):
        best_entry, best_diff = timeseries[0], None
        for entry in timeseries:
            diff = abs((_parse_iso(entry['time']) - target).total_seconds())
            if best_diff is None or diff < best_diff:
                best_diff, best_entry = diff, entry
        return best_entry

    steps = []
    for offset in RADAR_NOWCAST_OFFSETS_MINUTES:
        entry = nearest_entry(now + timedelta(minutes=offset))
        details = entry['data']['instant']['details']
        # symbol_code (Yr's own human-facing "how sunny does this look"
        # call, e.g. "clearsky_day"/"partlycloudy_day"/"cloudy") lives
        # under whichever summary window is present — next_1_hours near
        # "now", next_6_hours or next_12_hours further out where finer
        # summaries aren't published.
        symbol_code = None
        for window in ('next_1_hours', 'next_6_hours', 'next_12_hours'):
            summary = entry['data'].get(window, {}).get('summary', {})
            if summary.get('symbol_code'):
                symbol_code = summary['symbol_code']
                break
        steps.append({
            'offsetMinutes': offset,
            'temperature': details.get('air_temperature'),
            'windSpeed': details.get('wind_speed'),
            'windDir': details.get('wind_from_direction'),
            'cloudCover': details.get('cloud_area_fraction'),
            'symbolCode': symbol_code,
            'time': entry['time']
        })

    body = json.dumps({'steps': steps})
    return body, expires_ts


def fetch_dmi_radar_pair(retries=2, target_gap_minutes=15):
    """Fetches TWO Denmark-wide radar composites as raw HDF5 bytes: the
    newest one available, and whichever earlier one is closest to
    target_gap_minutes before it. The pair serves two purposes: the
    "prev" frame is shown directly as the timeline's -15m step (a real
    past observation, not a prediction), and the pair together is what
    estimate_radar_motion needs to derive a motion vector for the +15/+30
    nowcast (see that function). target_gap_minutes=15 matches the
    timeline's -15m label (RADAR_NOWCAST_OFFSETS_MINUTES) — it won't
    always land exactly on 15 (DMI publishes every 5 minutes, and gaps
    can happen), but it's the closest available real frame to that mark.

    One items-listing call gets both, not two — confirmed live that DMI's
    radar composites publish every 5 minutes and a single ranged listing
    query returns them newest-first, so asking for enough recent items in
    one call and picking two from the list avoids a second listing round
    trip. Only 2 download calls follow (one per chosen frame), and same as
    fetch_yr_weather, this whole thing only runs once per
    RADAR_CACHE_TTL_SECONDS thanks to get_radar_composite_pair's cache, so
    it's not a cost per venue or even per request.

    Same small retry budget as fetch_yr_weather, for the same reason: no
    retry budget fixes a genuinely-down upstream, it only makes failures
    take longer (confirmed the hard way with DMI's old forecast endpoint —
    see that function's docstring)."""
    # A bare `?limit=1` with no datetime filter does NOT return the newest
    # item — confirmed live: it came back with a composite from two months
    # earlier while an explicit datetime-range query at the same moment
    # correctly returned one ~10 minutes old. An explicit range covering
    # "now" is required to actually get the latest composite, not optional.
    now = datetime.now(timezone.utc)
    start = (now - timedelta(minutes=40)).strftime('%Y-%m-%dT%H:%M:%SZ')
    end = now.strftime('%Y-%m-%dT%H:%M:%SZ')
    items_url = f'{DMI_RADAR_ITEMS_URL}?limit=8&datetime={start}/{end}'

    last_err = None
    for attempt in range(retries + 1):
        try:
            list_req = urllib.request.Request(items_url, headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(list_req, timeout=15) as resp:
                listing = json.loads(resp.read().decode('utf-8'))
            features = listing.get('features') or []
            if len(features) < 2:
                raise RuntimeError('DMI radar item listing had fewer than 2 recent items')

            # Confirmed live: within a ranged query, items come back
            # newest-first — features[0] is "now". Pick whichever other
            # item's actual elapsed gap is closest to target_gap_minutes,
            # rather than assuming a fixed index/cadence.
            curr_feature = features[0]
            curr_time = _parse_iso(curr_feature['properties']['datetime'])
            prev_feature, best_diff = None, None
            for f in features[1:]:
                gap_minutes = (curr_time - _parse_iso(f['properties']['datetime'])).total_seconds() / 60
                diff = abs(gap_minutes - target_gap_minutes)
                if best_diff is None or diff < best_diff:
                    best_diff, prev_feature = diff, f

            def download(feature):
                href = feature['asset']['data']['href']
                dl_req = urllib.request.Request(href, headers={'User-Agent': USER_AGENT})
                with urllib.request.urlopen(dl_req, timeout=30) as resp:
                    return resp.read()

            return download(curr_feature), download(prev_feature)
        except Exception as err:
            print('DMI radar pair fetch attempt failed', err, flush=True)
            last_err = err
            if attempt < retries:
                time.sleep(2 * (attempt + 1))
    raise last_err


def get_radar_composite_pair():
    """Fixed 5-minute disk cache for the raw "current" and "previous"
    radar files, matching (not tracking — see RADAR_CACHE_TTL_SECONDS)
    the composite's own refresh cadence — cache/lock/stale-fallback shape
    mirrors the Overpass and Yr routes, just for a pair of files instead
    of one. Returns (cache_status, curr_bytes_or_None,
    prev_bytes_or_None)."""
    curr_path = cache_path('radar', 'composite_curr', ext='h5')
    prev_path = cache_path('radar', 'composite_prev', ext='h5')

    def both_cached():
        c = read_cache_bytes(curr_path, RADAR_CACHE_TTL_SECONDS)
        p = read_cache_bytes(prev_path, RADAR_CACHE_TTL_SECONDS)
        return (c, p) if c is not None and p is not None else (None, None)

    curr, prev = both_cached()
    if curr is not None:
        return 'HIT', curr, prev
    with _radar_fetch_lock:
        curr, prev = both_cached()
        if curr is not None:
            return 'HIT', curr, prev
        try:
            curr, prev = fetch_dmi_radar_pair()
            write_cache_bytes(curr_path, curr)
            write_cache_bytes(prev_path, prev)
            return 'MISS', curr, prev
        except Exception as err:
            stale_curr = read_stale_cache_bytes(curr_path)
            stale_prev = read_stale_cache_bytes(prev_path)
            if stale_curr is not None and stale_prev is not None:
                print('DMI radar fetch failed, serving stale cache', curr_path, err, flush=True)
                return 'STALE', stale_curr, stale_prev
            print('DMI radar fetch failed, no stale cache available', curr_path, err, flush=True)
            return 'ERROR', None, None


# The composite's own projection (from its HDF5 "where" group):
#   +proj=stere +ellps=WGS84 +lat_0=56 +lon_0=10.5666 +lat_ts=56
# A spherical (not full WGS84-ellipsoidal) stereographic forward projection
# is used here rather than pulling in pyproj — confirmed against the file's
# own corner coordinates that this is accurate to within ~0.4% over the
# whole Denmark-to-Sweden extent (987.7km computed vs. 992km actual grid
# width), which is comfortably inside the margin needed to land in the
# right ~500m pixel for a single city. lat_ts equals lat_0 here, which is
# what makes k0 (the scale factor at the projection center) come out to
# exactly 1 — this only holds because DMI's composite happens to define it
# that way; don't reuse this shortcut for a projection where lat_ts != lat_0.
_RADAR_LAT0 = math.radians(56.0)
_RADAR_LON0 = math.radians(10.5666)
_RADAR_EARTH_RADIUS_M = 6371000.0


def _radar_project(lat_deg, lon_deg):
    lat = math.radians(lat_deg)
    lon = math.radians(lon_deg)
    k = 2 * _RADAR_EARTH_RADIUS_M / (
        1 + math.sin(_RADAR_LAT0) * math.sin(lat)
        + math.cos(_RADAR_LAT0) * math.cos(lat) * math.cos(lon - _RADAR_LON0))
    x = k * math.cos(lat) * math.sin(lon - _RADAR_LON0)
    y = k * (math.cos(_RADAR_LAT0) * math.sin(lat)
             - math.sin(_RADAR_LAT0) * math.cos(lat) * math.cos(lon - _RADAR_LON0))
    return x, y


def decode_radar_composite(raw_bytes):
    """Parses the ODIM_H5 composite into the pieces radar_value_at needs.
    h5py (and its transitive numpy dependency) is the one exception to this
    project's stdlib-only rule — there's no stdlib way to read HDF5, and
    decoding this ourselves byte-by-byte isn't worth it. Imported lazily so
    a missing h5py only breaks this one route, not the whole server."""
    try:
        import h5py
    except ImportError as err:
        raise RuntimeError(
            "h5py isn't installed — run `pip3 install h5py` (see requirements.txt)") from err

    with h5py.File(io.BytesIO(raw_bytes), 'r') as f:
        data = f['dataset1/data1/data'][()]
        what = f['what'].attrs
        where = f['where'].attrs
        how = f['how'].attrs
        date_str = what['date'].decode() if isinstance(what['date'], bytes) else str(what['date'])
        time_str = what['time'].decode() if isinstance(what['time'], bytes) else str(what['time'])
        ul_lat, ul_lon = float(where['UL_lat'][0]), float(where['UL_lon'][0])
        gain, offset = float(what['gain']), float(what['offset'])
        nodata, undetect = float(what['nodata']), float(what['undetect'])
        zr_a, zr_b = float(how['zr-a'][0]), float(how['zr-b'][0])
        xscale, yscale = float(where['xscale']), float(where['yscale'])

    ul_x, ul_y = _radar_project(ul_lat, ul_lon)
    time_iso = f'{date_str[0:4]}-{date_str[4:6]}-{date_str[6:8]}T{time_str[0:2]}:{time_str[2:4]}:{time_str[4:6]}Z'
    return {
        'data': data, 'ul_x': ul_x, 'ul_y': ul_y, 'xscale': xscale, 'yscale': yscale,
        'gain': gain, 'offset': offset, 'nodata': nodata, 'undetect': undetect,
        'zr_a': zr_a, 'zr_b': zr_b, 'time': time_iso,
    }


# -10 to +50 in 5-minute steps, stress-testing the motion model's range —
# only 0 is a true unprojected observation now (reads curr directly, since
# frac=0); every other step, negative or positive, is the SAME semi-
# Lagrangian projection from curr along the single motion vector, just
# with a smaller/larger frac. This used to special-case negative offsets
# to read the "prev" frame's own raw value directly (a real observation),
# which worked when there was exactly one such step (-15) that could be
# targeted to roughly match prev's own ~15-minute gap — it doesn't
# generalize to multiple negative steps on a fine grid (prev is only ONE
# frame, at ONE actual timestamp, so -10 and -5 would've shown identical
# values reading it directly). Projecting from curr for both signs is
# simpler and gives every step a genuinely different value. Must match
# app.js's TIMELINE_OFFSETS_MINUTES.
RADAR_NOWCAST_OFFSETS_MINUTES = tuple(range(-10, 51, 5))

# Decoding the HDF5 pair and running the FFT motion estimate is real CPU
# work (confirmed live: tens to hundreds of ms depending on the machine) —
# get_radar_composite_pair's cache only avoids repeat UPSTREAM fetches, so
# without this, every single /api/precipitation request re-decoded both
# frames and re-ran the motion estimate from scratch even on a cache HIT,
# including every area load in a multi-area session hitting the exact same
# cached radar pair. Keyed by a hash of the raw curr bytes (not identity —
# read_cache_bytes returns a fresh bytes object per call even when the
# underlying file hasn't changed) so this only recomputes when the actual
# radar data changes, not on every request.
_radar_state_cache = {'key': None, 'curr': None, 'prev': None, 'dx': 0.0, 'dy': 0.0, 'dt_minutes': 0.0}
_radar_state_lock = threading.Lock()


def get_radar_nowcast_state():
    """Wraps get_radar_composite_pair with an in-memory cache of the
    already-decoded frames and estimated motion vector. Returns
    (cache_status, curr, prev, dx, dy, dt_minutes) — curr/prev are None
    if the upstream fetch failed with no cache to fall back to."""
    cache_status, curr_raw, prev_raw = get_radar_composite_pair()
    if curr_raw is None:
        return cache_status, None, None, 0.0, 0.0, 0.0
    key = hashlib.sha1(curr_raw).digest()
    with _radar_state_lock:
        if _radar_state_cache['key'] == key:
            c = _radar_state_cache
            return cache_status, c['curr'], c['prev'], c['dx'], c['dy'], c['dt_minutes']
    curr = decode_radar_composite(curr_raw)
    prev = decode_radar_composite(prev_raw)
    dx, dy, dt_minutes = estimate_radar_motion(prev, curr)
    with _radar_state_lock:
        _radar_state_cache.update(key=key, curr=curr, prev=prev, dx=dx, dy=dy, dt_minutes=dt_minutes)
    return cache_status, curr, prev, dx, dy, dt_minutes


def estimate_radar_motion(prev, curr):
    """Estimates a single Denmark-wide (dx, dy) pixel motion vector between
    two decoded radar frames via FFT phase correlation, plus the actual
    elapsed minutes between them (never assumed — see fetch_dmi_radar_pair,
    which picks whichever real frame is closest to a 10-minute gap, not
    necessarily exactly 10). Returns (dx, dy, dt_minutes).

    This is a genuinely approximate technique — one global vector for the
    whole scene, not per-cell motion, so it can't capture a storm growing,
    shrinking, rotating, or splitting, only the dominant overall drift.
    Good enough for a first version (a 15-30 minute nowcast doesn't need
    to be exact, just directionally useful), not a claim of meteorological
    accuracy.

    Sign convention verified against a synthetic test before this was
    wired in: given a known blob shifted by (+10, +4) pixels between two
    synthetic frames, this returns (+10.0, +4.0) — i.e. dx/dy describe
    motion FROM prev TO curr, in this raster's (column, row) pixel space
    (dy > 0 means moving toward higher row numbers, which is south — see
    decode_radar_composite/_radar_project for that convention). Getting
    this backwards would silently predict rain moving the wrong direction
    with no error to catch it, which is why it was checked against a
    known-answer case first rather than trusted by inspection."""
    import numpy as np

    dt_minutes = (_parse_iso(curr['time']) - _parse_iso(prev['time'])).total_seconds() / 60
    if dt_minutes <= 0:
        return 0.0, 0.0, 0.0

    def clean(radar):
        v = radar['data'].astype('float32')
        v[radar['data'] == radar['nodata']] = 0.0
        v[radar['data'] == radar['undetect']] = 0.0
        return v

    a, b = clean(prev), clean(curr)
    if not np.any(a) or not np.any(b):
        # No signal to track in one of the two frames (e.g. a dry day) —
        # nothing to correlate, so there's no motion to estimate. Falling
        # back to (0, 0) means the nowcast degrades to persistence (the
        # +15/+30 prediction equals the current reading), which is the
        # correct behavior when there's no rain to have a direction at all.
        return 0.0, 0.0, dt_minutes

    # Downsampled before the FFT — motion is a large-scale, slowly-varying
    # field, so correlating at full 500m resolution (1728x1984) buys
    # nothing here over a coarser grid, just a much bigger transform.
    factor = 4
    a_small, b_small = a[::factor, ::factor], b[::factor, ::factor]
    fa, fb = np.fft.fft2(a_small), np.fft.fft2(b_small)
    cross = fb * np.conj(fa)
    denom = np.abs(cross)
    denom[denom == 0] = 1e-9
    corr = np.abs(np.fft.fftshift(np.fft.ifft2(cross / denom)))
    peak_row, peak_col = np.unravel_index(np.argmax(corr), corr.shape)
    dy = (peak_row - a_small.shape[0] // 2) * factor
    dx = (peak_col - a_small.shape[1] // 2) * factor
    return float(dx), float(dy), dt_minutes


def radar_value_at_offset(curr, dx, dy, dt_minutes, lat, lon, offset_minutes, window=1):
    """Rain rate in mm/h at (lat, lon) at offset_minutes relative to curr
    (past or future — either sign), via the DBZH -> Z -> R Marshall-Palmer
    conversion using the composite's own zr-a/zr-b constants (dataset-
    specific, not hardcoded standard values). offset_minutes=0 reads the
    current frame at (lat, lon) directly (dx/dy have no effect). For any
    other offset, positive or negative, this is semi-Lagrangian sampling —
    to find what's at this fixed point at curr's time plus offset_minutes,
    look up what's currently sitting at the position that will drift here
    by then (upstream along the motion vector for a positive offset,
    downstream — i.e. where it must have come FROM — for a negative one),
    not what's currently at this exact spot. Physically this is more
    trustworthy close to curr (small |offset_minutes|) than far from it —
    a single global linear motion vector doesn't capture a storm turning,
    growing, or dissipating over a longer window, and error compounds
    with distance from the two real frames it was estimated from either
    direction. Averages a (2*window+1)^2 pixel box (default 3x3, ~1.5km at
    500m/px) around that sample point, both to smooth pixel-level noise
    and because landing on a single nodata pixel shouldn't blank out an
    otherwise-valid reading right next to it.

    Returns None — never 0 — when every sampled pixel is nodata (radar
    genuinely has no reading there, e.g. off the edge of coverage), the
    same "don't invent a value for a missing reading" rule the rest of
    this app follows for cloud cover. A pixel that IS 'undetect' (the
    radar looked and found nothing) is a real 0.0 mm/h, not a missing
    reading, and is included in the average as such."""
    x, y = _radar_project(lat, lon)
    col = (x - curr['ul_x']) / curr['xscale']
    row = (curr['ul_y'] - y) / curr['yscale']
    frac = (offset_minutes / dt_minutes) if dt_minutes > 0 else 0.0
    col = round(col - dx * frac)
    row = round(row - dy * frac)
    data = curr['data']
    h, w = data.shape
    samples = []
    for r in range(row - window, row + window + 1):
        for c in range(col - window, col + window + 1):
            if 0 <= r < h and 0 <= c < w:
                raw = float(data[r, c])
                if raw == curr['nodata']:
                    continue
                if raw == curr['undetect']:
                    samples.append(0.0)
                    continue
                dbz = raw * curr['gain'] + curr['offset']
                z = 10 ** (dbz / 10)
                samples.append((z / curr['zr_a']) ** (1 / curr['zr_b']))
    if not samples:
        return None
    return round(sum(samples) / len(samples), 2)


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

        if self.path.startswith('/api/precipitation'):
            if api_rate_limited(self._client_ip()):
                self._send_error_json(429, 'Too many requests')
                return

            try:
                length = int(self.headers.get('Content-Length', 0))
            except ValueError:
                length = -1
            if length < 0 or length > MAX_PRECIPITATION_BODY_BYTES:
                self._send_error_json(413, 'Request body too large')
                self.close_connection = True
                return

            raw_body = self.rfile.read(length)
            try:
                points = json.loads(raw_body.decode('utf-8'))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._send_error_json(400, 'Invalid JSON body')
                return
            if not isinstance(points, list) or len(points) > MAX_PRECIPITATION_POINTS:
                self._send_error_json(400, 'Invalid points list')
                return

            validated = []
            for p in points:
                if not (isinstance(p, list) and len(p) == 2):
                    self._send_error_json(400, 'Invalid point')
                    return
                lat = valid_latlon(p[0], 54, 58)
                lon = valid_latlon(p[1], 7, 16)
                if lat is None or lon is None:
                    self._send_error_json(400, 'Invalid lat/lon in points')
                    return
                validated.append((lat, lon))

            log_detail = {'points': len(validated)}
            try:
                cache_status, curr, prev, dx, dy, dt_minutes = get_radar_nowcast_state()
            except Exception as err:
                print('Radar decode/motion failed', err, flush=True)
                log_api_call('radar', log_detail, 'ERROR')
                self._send_error_json(502, 'Radar data unreadable')
                return
            if curr is None:
                log_api_call('radar', log_detail, 'ERROR')
                self._send_error_json(502, 'Upstream request failed')
                return

            # Every step (negative or positive) projects from curr along
            # the same motion vector now — see RADAR_NOWCAST_OFFSETS_MINUTES
            # for why the old "negative reads prev directly" special case
            # doesn't generalize to a fine-grained grid. Only offset=0
            # ends up a true unprojected observation (frac=0 inside
            # radar_value_at_offset means dx/dy have no effect).
            values = [
                [radar_value_at_offset(curr, dx, dy, dt_minutes, lat, lon, offset)
                 for offset in RADAR_NOWCAST_OFFSETS_MINUTES]
                for lat, lon in validated
            ]
            log_api_call('radar', log_detail, cache_status)
            self._send_json(200, json.dumps({
                'values': values,
                'steps': list(RADAR_NOWCAST_OFFSETS_MINUTES),
                'radarTime': curr['time']
            }), cache_status)
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
            # WEATHER_SCHEMA_VERSION is folded into the cache PATH's key
            # (not the logged `key` above, which stays clean for the
            # Track tab) so a schema bump can't collide with an old file
            # written under the same lat/lon cell.
            path = cache_path('weather', f'{key}:v{WEATHER_SCHEMA_VERSION}')
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
