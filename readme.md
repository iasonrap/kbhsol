# Københavns Sol

A map that shows, right now, which cafés/bars/restaurants in Copenhagen
are sitting in sun vs. shade — based on live cloud cover, real sun
position, and actual building shadows. Pick one or more areas and only
those load; nothing loads until you choose.

> **`precipitation` branch**: adds live rain (mm/h) to every venue, sourced
> from DMI's radar composite — not from Yr, which has no radar product.
> See "Rain, from DMI's radar, not Yr" below for why one weather source
> and one radar source now sit side by side, and what that costs in
> dependencies.

## How it works

- **Venues & buildings** — fetched from the [Overpass API](https://overpass-api.de)
  (OpenStreetMap): venues by querying `amenity=cafe|bar|restaurant|pub`,
  buildings as footprints with height (from the `height` or
  `building:levels` tag, default 9m if untagged), inside the bounding
  box of whichever area(s) you've selected.
- **Local caching proxy (`server.py`)** — the browser never calls
  Overpass or Yr directly. A small Python server (stdlib only) sits in
  front, proxies those requests, and caches each response to disk under
  `data/`. Toggling areas on and off repeatedly reuses the cached file
  instead of re-hitting the public APIs — useful since those are shared,
  rate-limited services.
  - **Venue/building data (Overpass) — 25 days.** OSM edits to a café's
    tags or a building's footprint are rare enough that this is
    effectively "until you think it's stale," confirmed empirically
    rather than guessed.
  - **Weather (Yr) — however long Yr's own `Expires` response header
    says**, not a fixed TTL. Yr's Terms of Service specifically ask
    clients to cache responses and respect that header rather than
    poll on a fixed schedule, and it's more correct anyway — they
    shorten it themselves around a forecast model run's update. In
    practice this has been observed around 30-60 minutes; a fixed
    60-minute fallback applies only if that header is ever missing.
  - **Radar (DMI) — a fixed 5 minutes, matching how often DMI actually
    refreshes it.** Unlike Yr's weather cache, this isn't following an
    upstream freshness header — DMI's radar composite doesn't send one.
    This used to be 15 minutes, which on top of DMI's own ~10-minute
    publish lag could show a "Now" reading pushing 25 minutes stale —
    tightened after that was reported as feeling "super in the past."
- **Sun position** — computed locally with [SunCalc](https://github.com/mourner/suncalc)
  (altitude + azimuth for the current time and location). No API needed.
- **Weather** — from [MET Norway's Locationforecast API](https://api.met.no/weatherapi/locationforecast/2.0/documentation),
  one call per grid cell covering everything at once:
  - **Cloud cover** (drives the sun/shade classification, bucketed into
    four tiers: sunny <10%, partly sunny 10–30%, partly cloudy 30–60%,
    cloudy 60%+ — the same thresholds this app has always used, carried
    over unchanged since this is a like-for-like "% of sky covered"
    parameter swap, not a new metric) — read at the nearest forecast
    timestep to now, queried per *venue* (at the ~2km grid cell each
    venue falls in, not the area's center), since a café near the
    boundary between two neighborhoods can sit in a different grid cell
    than its own area's center — sharing one area-wide reading was
    giving edge venues the wrong number. Venues are grouped by grid cell
    before fetching, so this is one request per distinct cell actually
    in play, not one per venue (confirmed: a 286-venue area spanned only
    4 cells).
  - **Temperature, wind speed/direction** are per-venue too now, not
    area-wide — a side effect of Yr bundling all three into one per-cell
    response rather than something extra that had to be built. Wind
    direction's *area-wide* summary figure (shown in the top-left panel)
    uses a proper circular mean across the area's distinct cells, not a
    naive average — averaging e.g. 350° and 10° arithmetically gives
    180° (due south, the opposite of correct) instead of 0° (due north,
    the right answer).
  - Also included: Yr's own `symbol_code` (e.g. `partlycloudy_day`,
    `clearsky_day`) — MET Norway's own "how sunny does this actually
    look" classification, shown as a bonus label next to the numeric
    weather tiles. Not used to drive the sun/shade tiering itself (cloud
    cover still does that, so the four-tier logic above stays simple and
    unchanged) — just a nice human-readable read, tuned by actual
    forecasters, shown alongside the numbers.
  - No API key required — Yr's endpoint is open, identified purely by a
    descriptive `User-Agent` header (no query-string key, unlike some
    APIs), subject to a generous 20 requests/second per app under their
    Terms of Service.
- **Rain** — from [DMI's radar composite](https://opendataapi.dmi.dk/v1/radardata/collections/composite/items),
  a Denmark-wide reflectivity mosaic from all of DMI's own radar stations,
  shown as mm/h at each venue's exact coordinate (not the ~2km grid cell
  the Yr weather figures above use). One radar pair (see below) covers
  the whole country, so `server.py` fetches and decodes it once per cache
  window, then answers every venue's rain figure from that same read — no
  per-venue or per-cell upstream cost the way weather has. Converted from
  the radar's raw reflectivity (dBZH) to a rain rate via the
  Marshall-Palmer Z-R relationship, using the composite's own zr-a/zr-b
  constants rather than hardcoded textbook ones. A venue right at the
  edge of radar coverage with no valid reading nearby shows no rain
  figure at all (`—`), not 0 mm/h — a genuine "radar detected nothing
  here" 0 and a missing reading are different things, and this app never
  conflates the two (same rule cloud cover already follows).
- **A 13-step timeline, not just "right now."** A bottom-center control
  (click anywhere on the track, or drag the handle — it snaps to the
  nearest step) scrubs from -10 to +50 minutes in 5-minute steps, each
  labeled with its own real clock time (not relative text like "-10 min"
  — DMI's radar naturally lags real time by several minutes, so a
  relative label implied a precision the data didn't have). Only the
  exact "now" step is a real, unprojected radar observation; every other
  step, past or future, is the same nowcast estimate, just closer to or
  further from that one real reading (so -5 min is more trustworthy than
  -10, the same way +5 is more trustworthy than +50 — proximity to the
  real observation, not sign, is what matters). Getting there needs two
  radar frames, not one: `server.py` fetches the newest composite plus
  whichever earlier one is closest to a 15-minute gap before it, and
  estimates a single citywide motion vector between the two (FFT phase
  correlation on a downsampled pair of frames — one overall drift
  direction/speed, not per-storm-cell tracking, so it can't capture a
  cell growing, shrinking, or rotating, only its broad movement). Every
  non-zero step then reads the *current* frame at the position that
  motion vector says will drift into (or out of) each venue by that
  time, rather than assuming nothing changes. If there's no rain in
  either frame to correlate, the estimate falls back to "no motion," and
  the whole timeline just repeats the current reading — the honest answer
  when there's nothing to track. Yr's temperature/wind/cloud scrub on the
  same timeline for free: its response already contains a multi-hour
  timeseries, not just one entry, so each step just reads whichever entry
  in that same response is nearest to now+offset — no extra request. Only
  the numeric figures scrub, on purpose — venue marker colors and the
  sun/shade state shown on the map stay pinned to right now.
- **Wind shelter** — each venue is individually checked for whether a
  nearby building stands directly upwind within ~40m of its own wind
  reading — if so, its detail panel notes that the wind may feel calmer
  there than the reading suggests. Uses the same ray-casting approach as
  the sun shadow check, just without the altitude trigonometry (wind
  shelter is a proximity/height question, not an angle-above-horizon one).
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

**Why Yr, not DMI.** This app's original weather source was DMI (Danish
Meteorological Institute) — a natural first choice for Danish data, and
it worked well for months. It was dropped after a real, sustained
incident: DMI's forecast endpoint spent an evening either 429-rate-limiting
or timing out outright, confirmed directly (not assumed) by querying it
repeatedly outside the app and watching it fail 6+ times in a row across
different retry budgets — including a *larger* retry budget, which still
failed after 39 seconds, proving the problem wasn't "needs more patience"
but a genuinely down/overloaded endpoint. Cross-checking DMI's own
observation stations at the same moment showed real disagreement between
nearby stations too (75% cloud cover at a coastal station, 10% at an
inland one, at the same moment) — not conclusive on its own, but combined
with the sustained forecast outage, enough to look elsewhere. MET
Norway's API (the data behind yr.no) replaces it: same free/no-key
access, a rate limit an order of magnitude more generous (20 req/s vs.
DMI's aggressive per-minute throttling), and — as a bonus, not the
reason for switching — one unified per-cell response instead of DMI's
split between a forecast grid (cloud cover) and a curated list of
observation stations (temp/wind), so temperature and wind became
per-venue for free instead of extra work.

**Rain, from DMI's radar, not Yr.** Yr (MET Norway) has no radar product —
its Locationforecast API is a point forecast, fine for temp/wind/cloud but
not for "is it raining right now, exactly here." DMI, which operates
Denmark's actual radar network, is the only source for that, independent
of the forecast-endpoint reliability problem that drove this app off DMI
for its other weather data in the first place (a different DMI service —
see "Why Yr, not DMI" above — with no evidence it shares that history).
DMI's radar composite also isn't a ready-made image: it's a raw HDF5
raster (ODIM_H5 format), so decoding it needs `h5py` — the one dependency
this project has beyond Python's standard library, and the one exception
to the "no build step, no dependencies" approach everything else here
follows (see `requirements.txt`).

Every data source here (OpenStreetMap/Overpass, MET Norway/Yr, DMI radar,
MapLibre GL, OpenFreeMap, Turf.js, SunCalc) is free and open, with no API
keys or billing required. Yr's data is CC BY 4.0 — used here under that
license, credited to the Norwegian Meteorological Institute and NRK. DMI's
open data is likewise free to reuse under their own open data terms.

This app genuinely couldn't exist without the open-source and open-data
community: free building footprints and venue data from OpenStreetMap's
volunteer mappers, a free public weather API from MET Norway, and free
open-source mapping tools maintained by people who chose to give this
away. Small, personal projects like this one are only possible because
that infrastructure exists and is freely shared — it's worth
appreciating, and supporting where you can (OpenStreetMap in particular
runs on volunteer contributions).

## Running it

```bash
python3 server.py
```

Then open **http://localhost:8123** in a browser. `server.py` both serves
the static files and proxies/caches the Overpass, Yr, and DMI radar
requests — don't use plain `python3 -m http.server` any more, since that
skips the caching layer entirely. Decoding DMI's radar composite needs
`h5py` (`pip3 install -r requirements.txt`) — everything else here is
stdlib-only Python.

The terminal also prints a second URL, `http://<your-LAN-IP>:8123` — open
that one on your phone or another device connected to the same Wi-Fi as
your laptop to use the app there too, no extra setup needed.

## Using the app

- The header has three tabs: **Map** (the sun/shade view), **About**, which
  fetches and renders this very readme live — edits to `readme.md` show up
  there automatically, no rebuild needed — and **Track**. The area bar is
  hidden on About and Track.
- The About page renders each `##` section as a full-height, scroll-snapped
  slide that fades/slides into view as you reach it (similar to Apple's
  product pages) — a sidebar table of contents on the left tracks your
  position, expanding the current chapter's title with a short preview
  and collapsing the rest. Click a chapter to jump straight to it. On a
  phone, this becomes a normal continuously-flowing article instead — the
  full-screen slide effect doesn't suit most chapters' actual content
  length at that width — with the same table of contents as a horizontal
  row of tappable pill chips underneath the header, still tracking which
  section you're reading as you scroll.
- **Track** shows every API call this server has made to Overpass, Yr, and
  DMI's radar, and whether the local cache absorbed it — a stat row (total
  requests, cache hits, real upstream calls, hit rate, errors), then three
  charts (venues & buildings per area, weather per grid tile, radar per
  area load — grouped by cache status rather than by tile, since one radar
  composite covers the whole city rather than being split per cell) as
  hourly-last-24h or daily-last-14-days stacked bars, and a raw log table
  underneath. It
  exists to make the caching design's effectiveness visible rather than
  something you have to take on faith from server console output — if a
  bug ever starts hammering an upstream API, this is where it'd show up
  as a spike.
- Below the header is the area bar. On open, the map shows a wide view
  of Copenhagen and loads nothing — pick one or more of ten
  neighborhoods (Vesterbro, Frederiksberg, Nordvest, Bispebjerg,
  Nørrebro, Indre By, Østerbro, Nordhavn, Christiania, Amagerbro). On a
  phone this collapses into a "Select areas" dropdown that expands into
  the same tappable list — still multi-select, just tucked away instead
  of permanently taking up a row under the header.
- Clicking an area toggles it on (loads its data) or off (removes it from
  the map) — you can have several areas active at once, and the panel
  aggregates counts across all of them.
- While an area is loading, a full-screen overlay shows a pulsing sun
  animation with live status text and four progress dots (venues,
  buildings, weather, shadows) so you can see what stage it's at.
- The footer has a GitHub link and a "Built with Claude" note.
- **The whole UI theme follows the actual sun** in Copenhagen: dark navy
  (the default identity) at night, switching automatically to a light
  grey/baby-blue theme — including the base map style — while it's light
  out. The switch happens at civil twilight (sun 6° below the horizon),
  not exact sunrise/sunset — Copenhagen's flat, open terrain means there's
  still real daylight for a while past geometric sunset, so using 0° made
  the dark theme kick in noticeably before it actually looked dark. This
  gives a buffer on both ends: day theme starts ~20-30 minutes before
  actual sunrise and lasts ~20-30 minutes past actual sunset. Checked once
  on load and every 10 minutes after (`app.js`'s `computeTheme`/
  `switchTheme`), so a tab left open across sunrise/sunset will flip on
  its own. The 🌙/☀️ button in the header toggles it manually
  at any time — doing so stops the automatic sunrise/sunset checks for the
  rest of the session, so your choice sticks. Venue marker colors (the
  sun/shade states) don't change between themes — they're semantic, not
  decorative.
- Each dot is a café, bar, or restaurant, colored by its current state —
  checked in this order, so a building blocking the sun always wins over
  the cloud reading:
  - 🌙 **dark blue** — sun is down (night)
  - 🏢 **dark grey** — a building is blocking the sun right now
  - 🟡 **yellow** — sunny (cloud cover under 10%)
  - 🟠 **pale gold** — partly sunny (10–30% cloud cover)
  - ⚪ **light grey** — partly cloudy (30–60% cloud cover)
  - ⚫ **mid grey** — cloudy (60%+ cloud cover)
  - 💗 **pink** — no weather data available for that venue right now (Yr's
    endpoint failed for its grid cell, and there was no cached reading to
    fall back to either) — shown as "N/A" rather than guessed at, since
    assuming clear skies when the reading is simply missing would be
    actively misleading
- Each dot also shows a small icon for its type: a cup (café), a wine
  glass (bar/pub), or a fork & knife (restaurant).
- Hover over a dot for a quick popup with its name, type, and current
  state. Click a dot to open a detail panel on the right with:
  - **A "🧭 Navigate" button**, right under the venue's name and type,
    opens a bottom-sheet chooser to get walking directions there in
    either Google Maps or Apple Maps. This isn't the OS's own native
    app-picker — no web page can actually invoke that, it's a
    native-app-only feature — it's a small in-app sheet built to feel
    like it, opening `google.com/maps/dir` or `maps.apple.com` with the
    venue's coordinates in a new tab, which the OS then hands off to
    whichever app (or its web fallback) is installed.
  - **Weather in [area]** — temperature, wind speed/direction, and cloud
    cover are all this specific venue's own forecast grid-cell reading
    (Yr bundles all three into one per-cell response), shown alongside
    Yr's own plain-language read of the sky (e.g. "☀️ Clear sky," "⛅
    Partly cloudy") next to the section heading. A fourth tile, rain
    (mm/h), comes from DMI's radar instead, read at the venue's exact
    coordinate rather than a shared grid cell. Any of these can differ
    from the area-wide average shown in the top-left panel if the venue
    sits near the edge of its area. The panel shows exactly when each
    reading was taken — "Weather forecast for…" for the Yr figures, and
    for rain either "Radar as of…" (a real observation, at the Now step)
    or "Rain forecast for… (nowcast)" (an estimate, at +15/+30) — as two
    separate timestamps, since they're two independent upstream sources
    with their own refresh cadences, not one combined reading. Every
    figure here follows the bottom-center timeline (see "A 30-minute
    nowcast" above) — switching it instantly re-renders whichever venue
    panel is open, no re-fetch, since all 3 steps were already downloaded
    when the area loaded. If a building stands directly upwind of that
    specific venue's own wind reading, a note below the weather tiles
    says so — also per-venue.
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
  "Cloud forecast for area" %, a rain mm/h figure, and a running count of
  venues across all six states. Both figures are explicitly labeled as
  area-wide (averages across the area's distinct cells/venues) since a
  venue's own detail panel shows its own reading, which can legitimately
  differ from this average near an area's edges.
  With several areas selected at once it can grow tall enough to cover
  a good chunk of the map — the small ‹ tab on its right edge collapses
  it down to just that tab (click again, now ›, to bring it back), and
  it stays collapsed even as area data keeps loading/refreshing behind
  it.
- If OpenStreetMap's Overpass API is temporarily down, you'll see a
  "Could not load map data" message with a retry button instead of a
  silent hang.
- If Yr's weather API or DMI's radar is temporarily unavailable, the app
  falls back to the last cached reading rather than erroring — but it
  tells you: a small ⚠️ appears next to the relevant figure in the area
  panel, and the venue detail panel shows its own note per source (a
  weather one and a radar one are independent, since they're independent
  upstreams), so a mismatch is never silently confusing.

## Known limitations

- Only covers ten predefined neighborhoods — their bounding boxes are hand-drawn
  estimates in `app.js` (`AREAS`), not sourced from an official district
  boundary dataset, so edges may clip or overreach slightly.
- Building heights are often estimated (many OSM buildings lack a
  `height` tag), so shadow edges won't be pixel-accurate.
- Venue and building data are fetched live from Overpass through the
  local caching proxy rather than saved into static `.geojson` files, so
  the app still depends on Overpass being reachable the first time an
  area is loaded (or after the cache expires).
- **Rain figures use a spherical approximation of the radar composite's
  stereographic projection**, not the full WGS84 ellipsoid (confirmed
  against the file's own corner coordinates to be accurate to within
  ~0.4% across the whole Denmark-to-Sweden extent) — plenty to land in
  the right ~500m pixel for a single city, but not survey-grade.
  Coordinates right at the edge of radar coverage may show no rain
  figure (`—`) rather than a real reading.

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
  returned a directory listing of every cached Overpass/Yr/radar response plus
  the complete, unbounded API request log (bypassing the Track tab's own
  endpoint entirely), `GET /server.py` returned the full backend source,
  and `GET /.git/config` (and `.git/HEAD`, `.git/logs/HEAD`) all returned
  200 — the whole git history was downloadable. Now only four exact paths
  (`/`, `/index.html`, `/app.js`, `/readme.md`) are servable; everything
  else 404s before it ever reaches the file-serving code, so there's no
  directory to list and nothing else to enumerate.
- **`server.py` binds to `0.0.0.0`**, not just `localhost` — deliberate,
  so it's reachable from a phone or another device on the same Wi-Fi
  (the terminal prints both URLs on startup: `http://localhost:8123` for
  this machine, `http://<your-LAN-IP>:8123` for everything else on the
  network). This is exactly the "reachable beyond localhost" scenario
  the hardening below exists for, and it wasn't safe to bind this way
  before that work landed — it is now, on a trusted home network. It's
  still only as safe as the network it's on, though: anyone else on that
  same Wi-Fi (a coffee shop, a shared office network) can also reach it,
  not just you. `/api/overpass`, `/api/weather`, and `/api/precipitation`
  are unauthenticated proxies to third-party APIs, so they're hardened
  against being used as an open relay — per-IP rate limiting, a body-size
  cap on Overpass queries and on the list of points a precipitation
  request can carry, and bounds-checked `lat`/`lon`. Rate limiting is two
  separate budgets: 120 requests/minute for the routes that cost a real
  Overpass/Yr/DMI call, and the same 120/minute for static files and
  `/api/logs` (which never leave this server) — otherwise a single normal
  area load's fan-out of Overpass/weather/radar calls could exhaust a
  shared budget and start blocking your own next page load, which is
  exactly what happened during testing before they were split. The
  upstream-call budget started at 30/min and had to be raised — one area
  load alone costs several of these (Overpass venues + buildings, a
  handful of weather tiles, one radar call), and loading multiple areas
  back to back is a normal
  way to use the multi-select area picker, not abuse; 30/min meant
  loading 3-4 areas in quick succession could exhaust it, and every area
  after that failed with a misleading "Overpass API may be busy" —
  misleading because the 429 was this server's own limiter, not
  Overpass. Both a real bug found live, not in review.
  `ThreadingHTTPServer` is used instead of plain `HTTPServer` so one slow
  client can't block every other request. None of this is a substitute
  for real auth if this ever needs to be more than a personal tool on the
  open internet — and none of it includes TLS, which a reverse proxy in
  front of this server would need to provide for any deployment beyond
  localhost.
