#!/usr/bin/env python3
"""
Static file server + local caching proxy for Follow The Sun.

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
from urllib.parse import urlparse, parse_qs

USER_AGENT = 'FollowTheSun/1.0 (personal weather/shadow map; contact: github.com/iasonrap)'

# OSM data (venues, buildings) barely changes day to day, so it's cached
# far longer than the weather, which needs to stay fresh.
OVERPASS_CACHE_TTL_SECONDS = 15 * 24 * 60 * 60  # 15 days
WEATHER_CACHE_TTL_SECONDS = 20 * 60             # 20 minutes
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')

OVERPASS_URLS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
]
DMI_OBS_URL = 'https://opendataapi.dmi.dk/v2/metObs/collections/observation/items'

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


def fetch_dmi(bbox):
    url = f'{DMI_OBS_URL}?parameterId=cloud_cover&bbox={bbox}&limit=20&sortorder=observed,DESC'
    req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode('utf-8')


class Handler(http.server.SimpleHTTPRequestHandler):
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
        if self.path.startswith('/api/weather'):
            qs = parse_qs(urlparse(self.path).query)
            bbox = qs.get('bbox', [''])[0]
            path = cache_path('weather', bbox)

            cached = read_cache(path, WEATHER_CACHE_TTL_SECONDS)
            if cached is not None:
                self._send_json(200, cached, 'HIT')
                return

            try:
                body = fetch_dmi(bbox)
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
    print(f'Serving Follow The Sun on http://localhost:{port} '
          f'(cache in ./data/ — OSM: {OVERPASS_CACHE_TTL_SECONDS // 86400}d, weather: {WEATHER_CACHE_TTL_SECONDS // 60}m)')
    http.server.HTTPServer(('localhost', port), Handler).serve_forever()
