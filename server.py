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
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs

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

os.makedirs(DATA_DIR, exist_ok=True)


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
    url = f'{DMI_OBS_URL}?parameterId={parameter_id}&stationId={station_id}&limit=1&sortorder=observed,DESC'
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode('utf-8')


def _parse_iso(t):
    return datetime.strptime(t, '%Y-%m-%dT%H:%M:%S.%fZ').replace(tzinfo=timezone.utc)


def fetch_dmi_forecast_cloud_cover(lat, lon, retries=4):
    """Cloud cover from DMI's HARMONIE DINI forecast model (2km grid), read at the
    nearest available hour to now. Used instead of the sparse observation stations
    because the model gives genuinely different values area-to-area (~2km resolution)
    where only two-ish observation stations cover all of central Copenhagen.

    This endpoint rate-limits more aggressively than the observation API — retry
    with backoff rather than erroring out on the first 429."""
    url = f'{DMI_FORECAST_URL}?coords=POINT({lon}%20{lat})&parameter-name=fraction-of-cloud-cover&crs=crs84'
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})

    last_err = None
    data = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode('utf-8'))
            break
        except Exception as err:
            print('DMI forecast attempt failed', err, flush=True)
            last_err = err
            if attempt < retries:
                time.sleep(3 * (attempt + 1))
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

    def do_POST(self):
        if self.path == '/api/overpass':
            length = int(self.headers.get('Content-Length', 0))
            query = self.rfile.read(length).decode('utf-8')
            path = cache_path('overpass', query)

            cached = read_cache(path, OVERPASS_CACHE_TTL_SECONDS)
            if cached is not None:
                self._send_json(200, cached, 'HIT')
                return

            try:
                body = fetch_overpass(query)
                write_cache(path, body)
                self._send_json(200, body, 'MISS')
            except Exception as err:
                stale = read_stale_cache(path)
                if stale is not None:
                    print('Overpass fetch failed, serving stale cache', path, err, flush=True)
                    self._send_json(200, stale, 'STALE')
                else:
                    self._send_json(502, json.dumps({'error': str(err)}), 'ERROR')
            return

        self.send_error(404)

    def do_GET(self):
        if self.path.startswith('/api/forecast'):
            qs = parse_qs(urlparse(self.path).query)
            lat = qs.get('lat', [''])[0]
            lon = qs.get('lon', [''])[0]
            path = cache_path('forecast', f'{lat},{lon}')

            cached = read_cache(path, FORECAST_CACHE_TTL_SECONDS)
            if cached is not None:
                self._send_json(200, cached, 'HIT')
                return

            try:
                body = fetch_dmi_forecast_cloud_cover(lat, lon)
                write_cache(path, body)
                self._send_json(200, body, 'MISS')
            except Exception as err:
                stale = read_stale_cache(path)
                if stale is not None:
                    print('DMI forecast fetch failed, serving stale cache', path, err, flush=True)
                    self._send_json(200, stale, 'STALE')
                else:
                    self._send_json(502, json.dumps({'error': str(err)}), 'ERROR')
            return

        if self.path.startswith('/api/weather'):
            qs = parse_qs(urlparse(self.path).query)
            station_id = qs.get('stationId', [''])[0]
            parameter_id = qs.get('parameterId', ['cloud_cover'])[0]
            path = cache_path('weather', f'{parameter_id}|{station_id}')

            cached = read_cache(path, WEATHER_CACHE_TTL_SECONDS)
            if cached is not None:
                self._send_json(200, cached, 'HIT')
                return

            try:
                body = fetch_dmi(station_id, parameter_id)
                write_cache(path, body)
                self._send_json(200, body, 'MISS')
            except Exception as err:
                stale = read_stale_cache(path)
                if stale is not None:
                    print('DMI fetch failed, serving stale cache', path, err, flush=True)
                    self._send_json(200, stale, 'STALE')
                else:
                    self._send_json(502, json.dumps({'error': str(err)}), 'ERROR')
            return

        super().do_GET()


if __name__ == '__main__':
    port = 8123
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f'Serving Københavns Sol on http://localhost:{port} '
          f'(cache in ./data/ — OSM: {OVERPASS_CACHE_TTL_SECONDS // 86400}d, '
          f'weather: {WEATHER_CACHE_TTL_SECONDS // 60}m, forecast: {FORECAST_CACHE_TTL_SECONDS // 60}m)')
    http.server.HTTPServer(('localhost', port), Handler).serve_forever()
