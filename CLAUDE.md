# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A static web app (`index.html` + `app.js`) that shows which cafés/bars/
restaurants in selected Copenhagen areas are currently in sun or shade,
combining live DMI cloud cover, computed sun position, and OSM building
shadow geometry. Full details of the current implementation live in
`readme.md` — read it first, and keep it in sync with any change you make
(the app's own About tab renders it live, so it's user-facing, not just
internal docs).

## Running it

```bash
python3 server.py
```

Never use plain `python3 -m http.server` — `server.py` is a stdlib-only
Python server that both serves the static files *and* proxies/caches
Overpass + DMI requests to disk under `data/`. Skipping it means every
click hits the public APIs directly.

To restart during development:

```bash
lsof -ti:8123 -sTCP:LISTEN | xargs -r kill; sleep 1
python3 server.py > /tmp/proxy_server.log 2>&1 &
```

## Architecture

- `index.html` — structure + all CSS (no separate stylesheet).
- `app.js` — everything: area config, Overpass/DMI fetch wrappers, sun/shadow
  math, MapLibre rendering, the tabs/About-page/TOC logic.
- `server.py` — static file server + caching proxy. No other backend.
- `data/` — cache files (gitignored), named `<prefix>_<sha1-of-request>.json`.
- `readme.md` — user-facing docs, also rendered live inside the app's About tab.

No build step, no bundler, no npm — everything loads from CDNs
(MapLibre GL, Turf.js, SunCalc, marked.js) directly in `index.html`.

## Things to know before changing code

- **Area bounding boxes are hand-drawn estimates** in `app.js` (`AREAS`).
  Editing a bbox changes the exact Overpass query text sent for that area,
  which changes its cache key — so old cache files for that area become
  permanently orphaned (harmless, just dead weight in `data/`; safe to
  delete manually if it matters).
- **Cache TTLs are intentionally split** in `server.py`: Overpass data
  (venues/buildings) is cached 15 days since it rarely changes; DMI
  weather is cached 20 minutes since it needs to stay current. Don't
  unify these.
- **Stale-cache fallback**: if a live Overpass/DMI fetch fails, the server
  serves whatever cache file exists for that exact key even if expired,
  rather than hard-erroring. Don't remove this without good reason — it's
  what keeps the app usable when the public Overpass mirrors are flaky
  (which happens often).
- **Nothing loads on page open.** The map starts idle; data only fetches
  when the user toggles an area on. Don't reintroduce an eager fetch.
- **Areas are multi-select, not radio buttons.** Multiple can be active
  at once; each gets its own MapLibre source/layer set keyed by area ID
  (`buildings-<areaId>`, `venues-<areaId>`, etc.) so toggling one off
  doesn't affect others.

## Testing changes

There's no test suite. This project has consistently been verified by
actually driving it in a headless browser (Playwright, installed via
`pip3 install playwright && python3 -m playwright install chromium`) and
inspecting a real screenshot — not just reading the code. Do this before
declaring a UI change done, especially for anything involving the map,
loading states, or the About page's scroll/fade behavior. The public
Overpass API is genuinely flaky (expect occasional 429/504s); the retry
and stale-cache-fallback logic is there to absorb that, not a bug when
you see it in logs.
