#!/usr/bin/env python3
"""
Static file server + caching proxy for Københavns Sol.

Proxies three upstreams and caches each response under data/:
  - Overpass (OSM venues and buildings), cached for weeks.
  - MET Norway Locationforecast (Yr): temp/wind/cloud per ~2km grid cell,
    cached until the Expires header Yr sends.
  - DMI's radar composite: rain, sampled per venue with a motion-based
    nowcast. Needs h5py and numpy (see requirements.txt).
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
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlparse, parse_qs

import numpy as np

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
os.makedirs(DATA_DIR, exist_ok=True)

USER_AGENT = 'KobenhavnsSol/1.0 (personal weather/shadow map; contact: github.com/iasonrap)'

OVERPASS_URLS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
]
OVERPASS_CACHE_TTL_SECONDS = 25 * 24 * 60 * 60

# Fallback only. The real lifetime comes from Yr's Expires header, which
# their Terms of Service require clients to respect.
WEATHER_CACHE_TTL_SECONDS = 60 * 60
# Bump whenever the JSON shape from fetch_yr_weather changes, including
# RADAR_NOWCAST_OFFSETS_MINUTES. Otherwise old cache files are served to a
# client that no longer understands them.
WEATHER_SCHEMA_VERSION = 2
YR_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact'

DMI_RADAR_ITEMS_URL = 'https://opendataapi.dmi.dk/v1/radardata/collections/composite/items'
# DMI's own publish pipeline already lags real time by 8-12 minutes, so
# caching the composite for longer than its 5-minute cadence stacks on top of that.
RADAR_CACHE_TTL_SECONDS = 5 * 60

# Only these files are served. Everything else (server.py, data/, .git/)
# must stay unreachable, so this is an allowlist, not a blocklist.
PUBLIC_PATHS = {'/', '/index.html', '/app.js', '/readme.md', '/exeo.png'}

# Hardening. These routes proxy third-party APIs with no auth, so they need
# body caps and rate limits before this is reachable beyond localhost.
MAX_OVERPASS_BODY_BYTES = 20_000
MAX_PRECIPITATION_BODY_BYTES = 30_000
MAX_PRECIPITATION_POINTS = 1000  # Indre By alone has 700+ venues
RATE_LIMIT_WINDOW_SECONDS = 60


def make_rate_limiter(max_requests):
    lock = threading.Lock()
    hits = defaultdict(deque)  # client_ip -> recent request timestamps

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


# Two budgets so static page loads can't starve the upstream proxies (and
# vice versa). 120/min covers loading all ten areas back to back.
api_rate_limited = make_rate_limiter(120)     # Overpass/Yr/radar proxies
static_rate_limited = make_rate_limiter(120)  # static files and /api/logs

# Weather is cached per ~2km cell rather than per venue, so venues sharing a
# cell share one cache file and one upstream request.
WEATHER_GRID_LAT_STEP = 0.018  # ~2km of latitude
WEATHER_GRID_LON_STEP = 0.032  # ~2km of longitude at Copenhagen's latitude

_weather_fetch_locks = defaultdict(threading.Lock)
_weather_fetch_locks_guard = threading.Lock()
# One composite covers all of Denmark, so one lock coalesces concurrent fetches.
_radar_fetch_lock = threading.Lock()


def snap_to_weather_grid(lat, lon):
    snapped_lat = round(lat / WEATHER_GRID_LAT_STEP) * WEATHER_GRID_LAT_STEP
    snapped_lon = round(lon / WEATHER_GRID_LON_STEP) * WEATHER_GRID_LON_STEP
    return round(snapped_lat, 4), round(snapped_lon, 4)


def _weather_lock_for(key):
    # Per-cell locks: requests for different cells don't block each other.
    with _weather_fetch_locks_guard:
        return _weather_fetch_locks[key]


def valid_latlon(value, lo, hi):
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if lo <= f <= hi else None


# --- API call log (feeds the Track tab) --------------------------------------

LOG_PATH = os.path.join(DATA_DIR, 'api_log.jsonl')
MAX_LOG_BYTES = 5 * 1024 * 1024
LOG_TRIM_KEEP_LINES = 10_000
_log_lock = threading.Lock()
# Only the areaId/kind query params are logged, so they're checked here
# rather than trusted. The client escapes them too.
_LOG_FIELD_RE = re.compile(r'^[a-zA-Z0-9_-]{1,60}$')


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


def log_field(value):
    return value if value and _LOG_FIELD_RE.match(value) else ''


# --- Disk cache ---------------------------------------------------------------

def cache_path(prefix, key, ext='json'):
    digest = hashlib.sha1(key.encode('utf-8')).hexdigest()
    return os.path.join(DATA_DIR, f'{prefix}_{digest}.{ext}')


def read_cache(path, ttl_seconds=None, binary=False):
    """Returns the file's contents, or None if it's missing, unreadable, or
    older than ttl_seconds. ttl_seconds=None ignores age, which is the
    stale-fallback path: an expired or orphaned file beats a hard error."""
    if not os.path.exists(path):
        return None
    if ttl_seconds is not None and time.time() - os.path.getmtime(path) > ttl_seconds:
        return None
    try:
        if binary:
            with open(path, 'rb') as f:
                return f.read()
        with open(path, 'r', encoding='utf-8') as f:
            return f.read()
    except OSError:
        return None


def write_cache(path, body):
    try:
        if isinstance(body, bytes):
            with open(path, 'wb') as f:
                f.write(body)
        else:
            with open(path, 'w', encoding='utf-8') as f:
                f.write(body)
    except OSError as err:
        print('Warning: failed to write cache file', path, err)


# Weather stores its Yr expiry next to the body in one JSON envelope, not in
# file mtime, so the expiry survives copying the file.
def write_cache_with_expiry(path, body, expires_ts):
    write_cache(path, json.dumps({'expires': expires_ts, 'body': body}))


def read_cache_with_expiry(path, allow_stale=False):
    raw = read_cache(path)
    if raw is None:
        return None
    try:
        wrapper = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not allow_stale and time.time() > wrapper.get('expires', 0):
        return None
    return wrapper.get('body')


# --- Upstream fetches ---------------------------------------------------------

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
    """Temp, wind and cloud cover for one grid cell, plus a symbol code, from
    one Yr call. Returns a "steps" list, one entry per
    RADAR_NOWCAST_OFFSETS_MINUTES offset, each taken from the same response
    (no extra upstream cost). Returns (body_json, expires_unix_ts).

    Retries are kept small on purpose: a down upstream fails the same way
    however long you wait, so a larger budget only makes failures slower."""
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
    entry_times = [_parse_iso(e['time']) for e in timeseries]
    now = datetime.now(timezone.utc)

    def nearest_entry(target):
        best = min(range(len(timeseries)), key=lambda i: abs((entry_times[i] - target).total_seconds()))
        return timeseries[best]

    steps = []
    for offset in RADAR_NOWCAST_OFFSETS_MINUTES:
        entry = nearest_entry(now + timedelta(minutes=offset))
        details = entry['data']['instant']['details']
        # symbol_code lives under whichever summary window exists: finer near
        # "now", coarser further out.
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

    return json.dumps({'steps': steps}), expires_ts


def fetch_dmi_radar_pair(retries=2, target_gap_minutes=15):
    """Fetches the newest DMI radar composite and an earlier one about
    target_gap_minutes before it, as raw HDF5 bytes. The earlier frame is
    only used to estimate motion; it is never displayed directly.

    One listing call returns both. Its datetime filter is required: without
    it the listing returns an old composite instead of the newest one."""
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

            # Items come back newest-first, so features[0] is "now".
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
    """Returns (cache_status, curr_bytes, prev_bytes). Cache, lock and
    stale-fallback follow the same pattern as the Overpass and Yr routes,
    applied to the pair of files."""
    curr_path = cache_path('radar', 'composite_curr', ext='h5')
    prev_path = cache_path('radar', 'composite_prev', ext='h5')

    def both_cached():
        c = read_cache(curr_path, RADAR_CACHE_TTL_SECONDS, binary=True)
        p = read_cache(prev_path, RADAR_CACHE_TTL_SECONDS, binary=True)
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
            write_cache(curr_path, curr)
            write_cache(prev_path, prev)
            return 'MISS', curr, prev
        except Exception as err:
            stale_curr = read_cache(curr_path, binary=True)
            stale_prev = read_cache(prev_path, binary=True)
            if stale_curr is not None and stale_prev is not None:
                print('DMI radar fetch failed, serving stale cache', curr_path, err, flush=True)
                return 'STALE', stale_curr, stale_prev
            print('DMI radar fetch failed, no stale cache available', curr_path, err, flush=True)
            return 'ERROR', None, None


# --- Radar decoding and nowcast -----------------------------------------------

# The composite's projection, from its HDF5 "where" group:
#   +proj=stere +ellps=WGS84 +lat_0=56 +lon_0=10.5666 +lat_ts=56
# A spherical stereographic approximation is accurate to ~0.4% over Denmark,
# which is well inside one ~500m pixel. It is only exact because lat_ts
# equals lat_0 here (scale factor k0 = 1).
_RADAR_LAT0 = math.radians(56.0)
_RADAR_LON0 = math.radians(10.5666)
_RADAR_EARTH_RADIUS_M = 6371000.0


def _radar_project(lat_deg, lon_deg):
    """Works on scalars and numpy arrays alike."""
    lat = np.radians(lat_deg)
    lon = np.radians(lon_deg)
    k = 2 * _RADAR_EARTH_RADIUS_M / (
        1 + math.sin(_RADAR_LAT0) * np.sin(lat)
        + math.cos(_RADAR_LAT0) * np.cos(lat) * np.cos(lon - _RADAR_LON0))
    x = k * np.cos(lat) * np.sin(lon - _RADAR_LON0)
    y = k * (math.cos(_RADAR_LAT0) * np.sin(lat)
             - math.sin(_RADAR_LAT0) * np.cos(lat) * np.cos(lon - _RADAR_LON0))
    return x, y


def decode_radar_composite(raw_bytes):
    """Parses an ODIM_H5 composite. h5py is imported lazily, so a missing
    install only breaks /api/precipitation, not the rest of the server."""
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
        'data': data, 'ul_x': float(ul_x), 'ul_y': float(ul_y), 'xscale': xscale, 'yscale': yscale,
        'gain': gain, 'offset': offset, 'nodata': nodata, 'undetect': undetect,
        'zr_a': zr_a, 'zr_b': zr_b, 'time': time_iso,
    }


# Offsets are relative to the newest composite. Only 0 is a raw observation;
# every other offset projects along the motion vector, so no offset reads the
# earlier frame directly. Must match TIMELINE_OFFSETS_MINUTES in app.js.
RADAR_NOWCAST_OFFSETS_MINUTES = tuple(range(-10, 51, 5))

# Decoding and motion estimation are CPU-heavy, so the decoded frame, rain
# grid and motion vector are cached in memory. The cache is keyed by a hash
# of the raw bytes, because read_cache returns a fresh bytes object each call.
_radar_state_cache = {'key': None, 'curr': None, 'dx': 0.0, 'dy': 0.0, 'dt_minutes': 0.0}
_radar_state_lock = threading.Lock()


def radar_rain_grid(radar):
    """Per-pixel rain rate in mm/h, NaN where the radar has no coverage. Uses
    the composite's own zr-a/zr-b constants. 'undetect' is a real 0 mm/h, and
    'nodata' is excluded from every average."""
    raw = radar['data'].astype('float64')
    z = 10 ** ((raw * radar['gain'] + radar['offset']) / 10)
    rate = (z / radar['zr_a']) ** (1 / radar['zr_b'])
    rate[raw == radar['undetect']] = 0.0
    rate[raw == radar['nodata']] = np.nan
    return rate


def get_radar_nowcast_state():
    """Returns (cache_status, curr, dx, dy, dt_minutes). curr is None if
    the radar is unavailable and there is no stale copy to serve."""
    cache_status, curr_raw, prev_raw = get_radar_composite_pair()
    if curr_raw is None:
        return cache_status, None, 0.0, 0.0, 0.0
    key = hashlib.sha1(curr_raw).digest()
    with _radar_state_lock:
        if _radar_state_cache['key'] == key:
            c = _radar_state_cache
            return cache_status, c['curr'], c['dx'], c['dy'], c['dt_minutes']
    curr = decode_radar_composite(curr_raw)
    prev = decode_radar_composite(prev_raw)
    curr['rate'] = radar_rain_grid(curr)
    dx, dy, dt_minutes = estimate_radar_motion(prev, curr)
    with _radar_state_lock:
        _radar_state_cache.update(key=key, curr=curr, dx=dx, dy=dy, dt_minutes=dt_minutes)
    return cache_status, curr, dx, dy, dt_minutes


def estimate_radar_motion(prev, curr):
    """Returns one Denmark-wide (dx, dy) pixel drift between two frames via
    FFT phase correlation, plus the real elapsed minutes between them.

    dx/dy are motion FROM prev TO curr in raster (column, row) space, so
    dy > 0 means moving south. The sign was checked against a synthetic
    shifted blob, because a backwards sign would predict rain moving the
    wrong way with no error.

    This is one global vector, so it cannot capture growth, decay or
    rotation. It is a rough estimate, not a meteorological forecast."""
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
        # Nothing to correlate (e.g. a dry day). Zero motion means the nowcast
        # just holds the current reading, which is correct when there's no rain.
        return 0.0, 0.0, dt_minutes

    # Motion is large-scale, so a 4x downsample is enough and far cheaper.
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


def radar_values(radar, dx, dy, dt_minutes, lats, lons, offsets, window=1):
    """Returns an (N, len(offsets)) array of rain rates in mm/h, NaN where
    there is no radar coverage.

    Offset 0 reads the current frame at each point. Any other offset is
    semi-Lagrangian: the rain at a point at time t+offset is what sits
    upstream along the motion vector now. Error grows with |offset|, since a
    single linear vector can't capture a storm turning or dissipating.

    Each value averages a (2*window+1)^2 pixel box, so one noisy pixel
    doesn't blank a reading. A box with no coverage is NaN, not 0."""
    rate = radar['rate']
    h, w = rate.shape
    x, y = _radar_project(np.asarray(lats, dtype=float), np.asarray(lons, dtype=float))
    col0 = (x - radar['ul_x']) / radar['xscale']
    row0 = (radar['ul_y'] - y) / radar['yscale']

    out = np.empty((len(col0), len(offsets)))
    for j, offset in enumerate(offsets):
        frac = (offset / dt_minutes) if dt_minutes > 0 else 0.0
        col = np.round(col0 - dx * frac).astype(int)
        row = np.round(row0 - dy * frac).astype(int)
        total = np.zeros(len(col0))
        count = np.zeros(len(col0))
        for dr in range(-window, window + 1):
            for dc in range(-window, window + 1):
                r, c = row + dr, col + dc
                inside = (r >= 0) & (r < h) & (c >= 0) & (c < w)
                v = rate[np.clip(r, 0, h - 1), np.clip(c, 0, w - 1)]
                ok = inside & ~np.isnan(v)
                total += np.where(ok, v, 0.0)
                count += ok
        out[:, j] = np.where(count > 0, total / np.maximum(count, 1), np.nan)
    return out


# --- HTTP handler -------------------------------------------------------------

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Dev tool: never let the browser cache app files, or edits don't show.
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

    def _read_body(self, max_bytes):
        """Returns the request body, or None after sending a 413 and closing."""
        try:
            length = int(self.headers.get('Content-Length', 0))
        except ValueError:
            length = -1
        if length < 0 or length > max_bytes:
            self._send_error_json(413, 'Request body too large')
            self.close_connection = True
            return None
        return self.rfile.read(length)

    def do_POST(self):
        if self.path.startswith('/api/overpass'):
            if api_rate_limited(self._client_ip()):
                self._send_error_json(429, 'Too many requests')
                return
            raw = self._read_body(MAX_OVERPASS_BODY_BYTES)
            if raw is None:
                return
            query = raw.decode('utf-8', errors='replace')
            path = cache_path('overpass', query)

            # areaId/kind are for the Track tab only. They're never part of the cache key.
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
                stale = read_cache(path)
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
            raw_body = self._read_body(MAX_PRECIPITATION_BODY_BYTES)
            if raw_body is None:
                return
            try:
                points = json.loads(raw_body.decode('utf-8'))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._send_error_json(400, 'Invalid JSON body')
                return
            if not isinstance(points, list) or len(points) > MAX_PRECIPITATION_POINTS:
                self._send_error_json(400, 'Invalid points list')
                return

            lats, lons = [], []
            for p in points:
                if not (isinstance(p, list) and len(p) == 2):
                    self._send_error_json(400, 'Invalid point')
                    return
                lat = valid_latlon(p[0], 54, 58)
                lon = valid_latlon(p[1], 7, 16)
                if lat is None or lon is None:
                    self._send_error_json(400, 'Invalid lat/lon in points')
                    return
                lats.append(lat)
                lons.append(lon)

            log_detail = {'points': len(lats)}
            try:
                cache_status, curr, dx, dy, dt_minutes = get_radar_nowcast_state()
            except Exception as err:
                print('Radar decode/motion failed', err, flush=True)
                log_api_call('radar', log_detail, 'ERROR')
                self._send_error_json(502, 'Radar data unreadable')
                return
            if curr is None:
                log_api_call('radar', log_detail, 'ERROR')
                self._send_error_json(502, 'Upstream request failed')
                return

            values = radar_values(curr, dx, dy, dt_minutes, lats, lons, RADAR_NOWCAST_OFFSETS_MINUTES)
            values = [[None if math.isnan(v) else round(v, 2) for v in row] for row in values.tolist()]
            log_api_call('radar', log_detail, cache_status)
            self._send_json(200, json.dumps({
                'values': values,
                'steps': list(RADAR_NOWCAST_OFFSETS_MINUTES),
                'radarTime': curr['time']
            }), cache_status)
            return

        self.send_error(404)

    def do_GET(self):
        # Every GET is rate-limited, including static files. Only routes that
        # cost a real Yr call use the upstream budget.
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
            lat = valid_latlon(qs.get('lat', [''])[0], 54, 58)
            lon = valid_latlon(qs.get('lon', [''])[0], 7, 16)
            if lat is None or lon is None:
                self._send_error_json(400, 'Invalid lat/lon')
                return

            snapped_lat, snapped_lon = snap_to_weather_grid(lat, lon)
            key = f'{snapped_lat},{snapped_lon}'
            # The schema version goes into the file path, not the logged key,
            # so a version bump can't collide with an old file for the same cell.
            path = cache_path('weather', f'{key}:v{WEATHER_SCHEMA_VERSION}')
            log_detail = {'cell': key}

            cached = read_cache_with_expiry(path)
            if cached is not None:
                log_api_call('weather', log_detail, 'HIT')
                self._send_json(200, cached, 'HIT')
                return

            # A whole area loading at once sends many venues into the same cell
            # simultaneously. Without this lock they'd all miss the cache and fire
            # duplicate upstream requests.
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

        url_path = urlparse(self.path).path
        if url_path in PUBLIC_PATHS:
            super().do_GET()
            return
        self.send_error(404)


# --- Startup ------------------------------------------------------------------

def _lan_ip():
    # connect() on UDP sends nothing; it only asks the OS which interface it
    # would route through, which is the address other devices on the Wi-Fi can use.
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
    # Binds to all interfaces so a phone on the same Wi-Fi can reach it. The
    # hardening above is what makes that safe.
    lan_ip = _lan_ip()
    print(f'Serving Københavns Sol — cache in ./data/ '
          f'(OSM: {OVERPASS_CACHE_TTL_SECONDS // 86400}d, '
          f'weather: per Yr\'s own Expires header, ~{WEATHER_CACHE_TTL_SECONDS // 60}m fallback)')
    print(f'  On this machine:        http://localhost:{port}')
    if lan_ip:
        print(f'  On your phone/Wi-Fi:    http://{lan_ip}:{port}')
    else:
        print('  Could not detect a LAN IP for phone access — check you\'re connected to Wi-Fi.')
    # Threaded, so one slow client can't block every other request.
    http.server.ThreadingHTTPServer(('0.0.0.0', port), Handler).serve_forever()
