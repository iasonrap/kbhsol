# Københavns Sol

A map that shows, right now, which cafés/bars/restaurants in Copenhagen
are sitting in sun vs. shade — based on live cloud cover, real sun
position, and actual building shadows. Pick one or more areas and only
those load; nothing loads until you choose.

## How it works

- **Venues & buildings** — fetched from the [Overpass API](https://overpass-api.de)
  (OpenStreetMap): venues by querying `amenity=cafe|bar|restaurant|pub`,
  buildings as footprints with height (from the `height` or
  `building:levels` tag, default 9m if untagged), inside the bounding
  box of whichever area(s) you've selected.
- **Local caching proxy (`server.py`)** — the browser never calls
  Overpass or DMI directly. A small Python server (stdlib only) sits in
  front, proxies those requests, and caches each response to disk under
  `data/`. Toggling areas on and off repeatedly reuses the cached file
  instead of re-hitting the public APIs — useful since those are shared,
  rate-limited services. Each cache TTL is set to match how often that
  data source *actually* changes, confirmed empirically rather than
  guessed, so nothing is over- or under-cached:
  - **Venue/building data (Overpass) — 25 days.** OSM edits to a café's
    tags or a building's footprint are rare enough that this is
    effectively "until you think it's stale."
  - **Observation weather (temp/wind) — 10 minutes.** DMI's stations
    report a new reading exactly every 10 minutes (confirmed by checking
    consecutive timestamps: `:X0`, `:X0+10`, `:X0+20`...) — caching
    longer just serves staler data for no reason.
  - **Forecast weather (cloud cover) — 60 minutes.** This one's less
    obvious: DMI's HARMONIE DINI model only *recomputes* every 3 hours
    (00/03/06/09/12/15/18/21 UTC), but each run publishes hourly-resolution
    forecast steps for the following ~2.5 days. The app always picks the
    step nearest to "now," and that choice only changes once an hour —
    so there's no freshness gained by polling more often than hourly; it
    would just re-fetch the same 3-hourly run's data against an endpoint
    that already rate-limits more aggressively than the observation one.
- **Sun position** — computed locally with [SunCalc](https://github.com/mourner/suncalc)
  (altitude + azimuth for the current time and location). No API needed.
- **Weather** — from [DMI Open Data](https://opendataapi.dmi.dk), split
  across two sources:
  - **Cloud cover** (drives the sun/shade classification, bucketed into
    four tiers: sunny <10%, partly sunny 10–30%, partly cloudy 30–60%,
    cloudy 60%+) comes from DMI's **forecast** model (HARMONIE DINI,
    2km grid), read at the nearest hour to now, queried per *venue* (at
    the ~2km grid cell each venue falls in, not the area's center) —
    this was a deliberate switch from observation stations — Copenhagen
    only has ~2 stations covering all ten areas, so every area showed
    identical weather; the 2km forecast grid gives genuinely different
    values area-to-area (confirmed empirically: two areas ~2km apart
    showed 18% vs 81% cloud cover at the same moment). Querying per
    venue rather than per area center matters at an area's edges — a
    café near the boundary between two neighborhoods can sit in a
    different grid cell than its own area's center, so sharing one
    area-wide reading was giving edge venues the wrong number. Venues
    are grouped by grid cell before fetching, so this is one request per
    distinct cell actually in play, not one per venue (confirmed: a
    286-venue area spanned only 4 cells).
  - **Temperature, wind speed/direction** (shown in a venue's detail
    panel, don't affect the classification) still come from the nearest
    real **observation** station, picked from a curated list of stations
    known to report all three together (see "Weather is per-area, not
    per-venue" further down).
  - No API key required for either — DMI's endpoints are open, subject
    only to fair-use rate limiting. The forecast endpoint enforces a
    noticeably stricter limit than the observation one; caching it at
    15 minutes (fresher than the model's own ~hourly update cadence) is
    a deliberate tradeoff of more current-feeling data against a higher
    chance of hitting that limit under heavy use (see "Why cloud cover,
    not solar radiation" below for the classification logic itself).
- **Wind shelter** — a venue's wind reading is area-wide (see above), but
  each venue is individually checked for whether a nearby building stands
  directly upwind within ~40m — if so, its detail panel notes that the
  wind may feel calmer there than the reading suggests. Uses the same
  ray-casting approach as the sun shadow check, just without the
  altitude trigonometry (wind shelter is a proximity/height question,
  not an angle-above-horizon one).
- **Shadow calculation** — for each venue, a ray is cast from its
  location toward the sun's compass bearing (using [Turf.js](https://turfjs.org)).
  If that ray hits a building whose height is enough to block the sun
  at its current altitude (`height >= distance * tan(altitude)`), the
  venue is marked as shaded.
- **Map rendering** — [MapLibre GL](https://maplibre.org) with the free
  [OpenFreeMap](https://openfreemap.org) style, 3D building extrusions,
  and venue markers colored by why they are (or aren't) sunny right now
  — see the state colors below. Each marker also shows a small icon for
  its type: cup (café), wine glass (bar/pub), fork & knife (restaurant)
  — drawn on the fly with canvas, no icon files needed.

**Why cloud cover, not solar radiation.** DMI also exposes measured solar
radiation (`radia_glob`), which sounds like a more direct "is the sun
out" signal — but it conflates two things: how covered the sky is, and
how high the sun is (which swings hugely by time of day/season). A clear
sky at 8am reads similarly to an overcast noon. Cloud cover is roughly
time-of-day-independent, and the app already computes sun altitude
separately (for the shadow math), so combining the two — rather than
using one blended radiation number — keeps each signal doing one job.

Every data source here (OpenStreetMap/Overpass, DMI Open Data, MapLibre GL,
OpenFreeMap, Turf.js, SunCalc) is free and open, with no API keys or
billing required.

This app genuinely couldn't exist without the open-source and open-data
community: free building footprints and venue data from OpenStreetMap's
volunteer mappers, a free public weather API from DMI, and free open-source
mapping tools maintained by people who chose to give this away. Small,
personal projects like this one are only possible because that infrastructure
exists and is freely shared — it's worth appreciating, and supporting where
you can (OpenStreetMap in particular runs on volunteer contributions).

## Running it

```bash
python3 server.py
```

Then open **http://localhost:8123** in a browser. `server.py` both serves
the static files and proxies/caches the Overpass and DMI requests — don't
use plain `python3 -m http.server` any more, since that skips the caching
layer entirely.

## Using the app

- The header has three tabs: **Map** (the sun/shade view), **About**, which
  fetches and renders this very readme live — edits to `readme.md` show up
  there automatically, no rebuild needed — and **Track**. The area bar is
  hidden on About and Track.
- The About page renders each `##` section as a full-height, scroll-snapped
  slide that fades/slides into view as you reach it (similar to Apple's
  product pages) — a sidebar table of contents on the left tracks your
  position, expanding the current chapter's title with a short preview
  and collapsing the rest. Click a chapter to jump straight to it.
- **Track** shows every API call this server has made to Overpass and DMI,
  and whether the local cache absorbed it — a stat row (total requests,
  cache hits, real upstream calls, hit rate, errors), then three charts
  (venues & buildings per area, cloud forecast per grid tile, weather
  observations per station) as hourly-last-24h or daily-last-14-days
  stacked bars, and a raw log table underneath. It exists to make the
  caching design's effectiveness visible rather than something you have
  to take on faith from server console output — if a bug ever starts
  hammering an upstream API, this is where it'd show up as a spike.
- Below the header is the area bar. On open, the map shows a wide view
  of Copenhagen and loads nothing — pick one or more of ten
  neighborhoods (Vesterbro, Frederiksberg, Nordvest, Bispebjerg,
  Nørrebro, Indre By, Østerbro, Nordhavn, Christiania, Amagerbro).
- Clicking an area toggles it on (loads its data) or off (removes it from
  the map) — you can have several areas active at once, and the panel
  aggregates counts across all of them.
- While an area is loading, a full-screen overlay shows a pulsing sun
  animation with live status text and four progress dots (venues,
  buildings, weather, shadows) so you can see what stage it's at.
- The footer has a GitHub link and a "Built with Claude" note.
- **The whole UI theme follows the actual sun** in Copenhagen: dark navy
  (the default identity) after sunset, switching automatically to a light
  grey/baby-blue theme — including the base map style — while the sun is
  genuinely up. Checked once on load and every 10 minutes after (`app.js`'s
  `computeTheme`/`switchTheme`), so a tab left open across sunrise/sunset
  will flip on its own. The 🌙/☀️ button in the header toggles it manually
  at any time — doing so stops the automatic sunrise/sunset checks for the
  rest of the session, so your choice sticks. Venue marker colors (the
  sun/shade states) don't change between themes — they're semantic, not
  decorative.
- Each dot is a café, bar, or restaurant, colored by its current state —
  checked in this order, so a building blocking the sun always wins over
  the cloud reading:
  - 🌙 **dark blue** — sun is down (night)
  - 🏢 **dark grey** — a building is blocking the sun right now
  - 🟡 **yellow** — sunny (DMI cloud cover under 10%)
  - 🟠 **pale gold** — partly sunny (10–30% cloud cover)
  - ⚪ **light grey** — partly cloudy (30–60% cloud cover)
  - ⚫ **mid grey** — cloudy (60%+ cloud cover)
  - 💗 **pink** — no forecast available for that venue right now (DMI's
    forecast endpoint failed for its grid cell, most often rate-limiting)
    — shown as "N/A" rather than guessed at, since assuming clear skies
    when the reading is simply missing would be actively misleading
- Each dot also shows a small icon for its type: a cup (café), a wine
  glass (bar/pub), or a fork & knife (restaurant).
- Hover over a dot for a quick popup with its name, type, and current
  state. Click a dot to open a detail panel on the right with:
  - **Weather in [area]** — temperature and wind speed/direction come
    from the nearest DMI observation station, shared by every venue in
    the area (different *areas* do get different stations, e.g. Nordvest
    nearest to Jægersborg, Christiania nearest to Kastrup, since the
    city's inner stations each only report a partial set of parameters
    and the fully-equipped ones sit on the outskirts). Cloud cover,
    though, *is* per-venue — it's this specific venue's own forecast
    grid-cell reading, which can differ from the area-wide average shown
    in the top-left panel if the venue sits near the edge of its area.
    If a building stands directly upwind of that specific venue, a note
    below the weather tiles says so — also per-venue.
  - **Venue info** — whatever OpenStreetMap has tagged for that place.
    Opening hours get parsed into a weekly table, reordered to start from
    today and highlight it. OSM's `opening_hours` syntax is notoriously
    irregular in the wild — the parser (`app.js`'s `parseOpeningHours`)
    was built and tuned against ~1,270 distinct real values pulled from
    Copenhagen venues and handles about 97% of them (comma-chained day
    blocks, mixed semicolon/comma styles, "PH" and month-specific closure
    exceptions, trailing `+` for approximate closing times, stray quoted
    comments, missing whitespace). The remaining ~3% — genuine seasonal
    month ranges, "easter"-relative dates, week-number rules, nth-weekday
    selectors like `Fr[1]`, free-text descriptions — fall back to showing
    OSM's raw text rather than risk displaying the wrong hours. Cuisine,
    outdoor seating, phone, website, and wheelchair access each show a
    plain "not available on OSM" line when that tag is missing, rather
    than silently vanishing — coverage is crowd-sourced and inconsistent,
    so it's often missing.
- The panel in the top-left shows the current time, sun altitude,
  cloud cover %, and a running count of venues across all six states.
- If OpenStreetMap's Overpass API is temporarily down, you'll see a
  "Could not load map data" message with a retry button instead of a
  silent hang.
- If DMI's weather API is temporarily rate-limited, the app falls back to
  the last cached reading rather than erroring — but it tells you: a
  small ⚠️ appears next to the cloud % in the area panel, and the venue
  detail panel shows an amber note explaining the data may be several
  hours old, so a mismatch (like a forecast timestamped hours away from
  the current time) is never silently confusing.

## Known limitations

- Only covers ten predefined neighborhoods — their bounding boxes are hand-drawn
  estimates in `app.js` (`AREAS`), not sourced from an official district
  boundary dataset, so edges may clip or overreach slightly.
- Building heights are often estimated (many OSM buildings lack a
  `height` tag), so shadow edges won't be pixel-accurate.
- Venue and building data are fetched live from Overpass through the
  local caching proxy rather than saved into static `.geojson` files, so
  the app still depends on Overpass being reachable the first time an
  area is loaded (or once every 20 minutes after that).

## Security notes

- **OSM venue data (name, cuisine, phone, website, wheelchair, opening
  hours) is treated as untrusted input** — OpenStreetMap is community-edited,
  so any of it could contain a crafted HTML/script payload. Every field is
  HTML-escaped before insertion (`app.js`'s `escapeHtml`), and `website`
  links are scheme-validated (`safeHttpUrl`) so a `javascript:` URL in a
  vandalized OSM entry can't run. Don't insert any OSM-derived field via
  `innerHTML` without going through these first.
- **Static file serving is an explicit allowlist, not "serve the project
  directory."** This closed a real, confirmed vulnerability found during a
  pre-production review: `server.py` was serving the *entire* project
  folder over plain HTTP via `SimpleHTTPRequestHandler`'s default
  behavior. Confirmed live with `curl` (not theoretical) — `GET /data/`
  returned a directory listing of every cached Overpass/DMI response plus
  the complete, unbounded API request log (bypassing the Track tab's own
  endpoint entirely), `GET /server.py` returned the full backend source,
  and `GET /.git/config` (and `.git/HEAD`, `.git/logs/HEAD`) all returned
  200 — the whole git history was downloadable. Now only four exact paths
  (`/`, `/index.html`, `/app.js`, `/readme.md`) are servable; everything
  else 404s before it ever reaches the file-serving code, so there's no
  directory to list and nothing else to enumerate.
- **`server.py` binds to `localhost` only** by default — that's what makes
  the endpoints below safe today. The moment it's exposed beyond your own
  machine (a public deploy, a reverse proxy, changing the bind address),
  the following start to matter: `/api/overpass`, `/api/weather`, and
  `/api/forecast` are unauthenticated proxies to third-party APIs, so
  they're hardened against being used as an open relay — per-IP rate
  limiting, a body-size cap on Overpass queries, an allowlist for
  `parameterId`, and bounds-checked `lat`/`lon`. Rate limiting is two
  separate budgets: 30 requests/minute for the routes that cost a real
  Overpass/DMI call, and a more generous 120/minute for static files and
  `/api/logs` (which never leave this server) — otherwise a single normal
  area load's fan-out of Overpass/forecast/observation calls could exhaust
  a shared budget and start blocking your own next page load, which is
  exactly what happened during testing before they were split.
  `ThreadingHTTPServer` is used instead of plain `HTTPServer` so one slow
  client can't block every other request. None of this is a substitute
  for real auth if this ever needs to be more than a personal tool on the
  open internet — and none of it includes TLS, which a reverse proxy in
  front of this server would need to provide for any deployment beyond
  localhost.
