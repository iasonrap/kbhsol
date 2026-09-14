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
- **Cache TTLs are intentionally split** in `server.py`, three-way, each
  matched to how often that data source actually changes (confirmed
  empirically, not guessed): Overpass data (venues/buildings) 25 days;
  DMI **observation** data (temp/wind) 10 minutes — stations report on
  the dot every 10 minutes, checked by comparing consecutive timestamps;
  DMI **forecast** data (cloud cover) 60 minutes. The forecast number is
  the one worth understanding, since it's counter-intuitive: HARMONIE
  DINI only *recomputes* every 3 hours (00/03/06/09/12/15/18/21 UTC —
  confirmed via DMI's own docs, correcting an earlier wrong assumption
  in this file that it updates hourly), but each run publishes
  hourly-resolution steps ~2.5 days out, and the app always picks the
  step nearest "now" — a choice that only changes once an hour. So
  polling more often than hourly buys zero freshness; it would just
  re-fetch the same 3-hourly run's data against an endpoint that already
  rate-limits more aggressively than the observation one (429s came fast
  during testing at higher poll rates). Don't unify these three TTLs or
  push the forecast one below ~60 minutes without re-verifying this.
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
- **`await mapReady` before any `map.addSource`/`addLayer`/`addImage`
  call.** MapLibre's style loads async and throws "Style is not done
  loading" if you touch it too early. This is easy to miss in testing
  because it only bites when data resolves *fast* — it went unnoticed
  until the weather/Overpass caching made loads fast enough to finish
  before the style did. `mapReady` is a promise resolved on the map's
  `load` event (or immediately if `map.isStyleLoaded()`); await it right
  before the layer calls, not at the top of `loadArea`, so it doesn't
  serialize with the data fetch.
- **Weather is per-area, not per-venue**, and deliberately uses a fixed
  list of DMI stations (`WEATHER_STATIONS` in `app.js`) picked by hand,
  not a bbox search. Copenhagen's inner-city stations each report only a
  subset of parameters (e.g. Landbohøjskolen has temperature but no
  wind/cloud); the ones with the full set (temp+wind+cloud together)
  sit on the outskirts (Kastrup, Jægersborg, etc.). The app picks the
  nearest station *from that curated list* per area, not the nearest
  station overall — don't replace this with a live station-search query
  without re-checking which stations actually carry every parameter.
- **Cloud cover and temp/wind come from two different DMI APIs on
  purpose.** Cloud cover (`fetchForecastCloudCover` in `app.js`, backed
  by `/api/forecast` → `fetch_dmi_forecast_cloud_cover` in `server.py`)
  uses the **forecast** model (`harmonie_dini_sf`) at a 2km grid,
  queried at each area's own center — this was switched from the
  observation station because with only ~2 stations covering nine areas,
  every area showed identical cloud cover; the forecast grid gives real
  area-to-area variation. Temp/wind (`fetchDmiParameter`) still come
  from the nearest observation station, since those don't need the same
  spatial granularity and observation data is a real measurement rather
  than a model's nearest-hour value. Don't switch temp/wind to the
  forecast source without a reason — it'd add rate-limit risk for no
  benefit.
- **The UI theme (dark by default, light "day" theme while the sun's up in
  Copenhagen) is driven by `computeTheme()`/`switchTheme()` in `app.js`,
  toggling `document.documentElement.dataset.theme` and swapping the
  MapLibre style between `MAP_STYLES.night`/`.day`.** `map.setStyle()`
  wipes all custom sources/layers, so every active area gets relayered
  from `areaDataCache` (raw buildings/venues GeoJSON kept in memory per
  loaded area) afterward — don't add a new per-area MapLibre layer
  without also handling it in `switchTheme`'s relayer loop, or it'll
  vanish on the next day/night flip.
  **Two MapLibre quirks discovered building this, both counter to what
  you'd expect:** (1) the `style.load` event does not reliably fire after
  `setStyle()` in this setup — don't gate relayering on it; poll
  `map.isStyleLoaded()` instead (see `relayerWhenReady` — this is what
  actually works). (2) images registered via `map.addImage()` **survive**
  `setStyle()` (unlike sources/layers) — calling `registerVenueIcons`
  again after a style swap throws "image already exists" for each icon.
  Harmless (MapLibre catches it internally and logs, doesn't propagate),
  but noisy — `iconsRegistered` is deliberately left `true` across a
  theme switch rather than reset.
- Marker/venue colors (the sun/shade state palette) are **semantic, not
  thematic** — they don't change between the day and night UI themes.
  Only chrome (backgrounds, panels, text, building fill color, base map
  style) is theme-aware. Keep it that way; recoloring markers by theme
  would make the sun/shade meaning ambiguous.

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
