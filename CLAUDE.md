# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A static web app (`index.html` + `app.js`) that shows which cafés/bars/
restaurants in selected Copenhagen areas are currently in sun or shade,
combining live cloud cover from Yr (MET Norway), rain from DMI's radar,
computed sun position, and OSM building shadow geometry. Full details of
the current implementation live in `readme.md` — read it first, and keep
it in sync with any change you make (the app's own About tab renders it
live, so it's user-facing, not just internal docs).

The original weather source was DMI; it was replaced with MET Norway's
Locationforecast API (the data behind yr.no) after a sustained real outage
(DMI's forecast endpoint 429-ing/timing out for an evening, confirmed not
fixable by a bigger retry budget) — see the "Why Yr, not DMI" bullet
further down and readme.md's section of the same name for the full story.

**This is the `precipitation` branch.** It adds rain (mm/h) per venue,
sourced from DMI's radar composite, not from Yr — Yr has no radar
product. This is a third upstream and the one dependency this project has
beyond Python's standard library (`h5py`, to decode the radar's raw HDF5
format) — see the "Rain, from DMI's radar" bullet further down.

## Running it

```bash
python3 server.py
```

Never use plain `python3 -m http.server` — `server.py` serves the static
files *and* proxies/caches Overpass + Yr + DMI radar requests to disk
under `data/`. Skipping it means every click hits the public APIs
directly. `server.py` itself is otherwise stdlib-only Python; the one
exception is `h5py` (`pip3 install -r requirements.txt`), needed only to
decode DMI's radar composite — see the "Rain, from DMI's radar" bullet.

To restart during development:

```bash
lsof -ti:8123 -sTCP:LISTEN | xargs -r kill; sleep 1
python3 server.py > /tmp/proxy_server.log 2>&1 &
```

## Architecture

- `index.html` — structure + all CSS (no separate stylesheet).
- `app.js` — everything: area config, Overpass/Yr/radar fetch wrappers,
  sun/shadow math, MapLibre rendering, the tabs/About-page/TOC logic, the
  Track tab's charts and log table.
- `server.py` — static file server + caching proxy. No other backend.
- `data/` — cache files (gitignored), named `<prefix>_<sha1-of-request>.json`
  (or `.h5` for the cached radar composite), plus `data/api_log.jsonl` —
  one line per proxied API call (see "Track tab" below).
- `readme.md` — user-facing docs, also rendered live inside the app's About tab.
- `requirements.txt` — the one dependency this project has, `h5py`, needed
  only for decoding DMI's radar composite.

No build step, no bundler, no npm — everything loads from CDNs
(MapLibre GL, Turf.js, SunCalc, marked.js) directly in `index.html`.

## Things to know before changing code

- **Area bounding boxes are hand-drawn estimates** in `app.js` (`AREAS`).
  Editing a bbox changes the exact Overpass query text sent for that area,
  which changes its cache key — so old cache files for that area become
  permanently orphaned (harmless, just dead weight in `data/`; safe to
  delete manually if it matters).
- **Why Yr, not DMI.** DMI's forecast endpoint spent an evening either
  429-rate-limiting or timing out outright, confirmed directly (not
  assumed) by querying it repeatedly outside the app — 6+ consecutive
  failures, and critically, a *larger* retry budget still failed after
  39s, proving it was a genuinely down/overloaded endpoint, not one
  that just needed more patience (see the retry-budget bullet below).
  Cross-checking DMI's own observation stations at the same moment also
  showed real disagreement between nearby stations (75% cloud cover
  coastal, 10% inland, same moment) — not conclusive alone, but combined
  with the sustained outage, enough to switch. MET Norway's
  Locationforecast API (api.met.no, the data behind yr.no) replaces it:
  free, no API key, identified by `User-Agent` only, and a 20 req/s
  Terms-of-Service rate limit — an order of magnitude more generous than
  DMI's aggressive per-minute throttling. As a bonus (not the reason for
  switching): Yr bundles temp/wind/cloud into **one** per-grid-cell
  response, replacing DMI's split between a forecast grid (cloud cover)
  and a hand-curated observation-station list (temp/wind) — see below.
- **Weather cache TTL is dynamic, not fixed** — `read_cache_with_expiry`/
  `write_cache_with_expiry` in `server.py` store Yr's own `Expires`
  response header alongside the cached body (as one small JSON envelope,
  not file-mtime-based like Overpass's cache) and check against that,
  not a constant. This isn't just tidiness: Yr's Terms of Service
  specifically ask clients to respect that header rather than poll on a
  guessed schedule. `WEATHER_CACHE_TTL_SECONDS` (60 min) is only the
  fallback used if the header is ever missing/unparseable. Overpass
  data (venues/buildings) still uses the older fixed-TTL `read_cache`
  (25 days — OSM edits are rare enough that "until you think it's
  stale" is the right model, and Overpass doesn't send comparable
  freshness metadata anyway) — don't conflate the two caching schemes
  or try to unify them; they solve different problems.
- **Never store a `Date` object in a venue feature's GeoJSON `properties`.**
  MapLibre round-trips feature properties through its internal tiling
  worker between `addSource` and a later click event, and a `Date` comes
  back out as a plain string — not a `Date`, and not `null` either, so a
  `weather.forecastTime ? ...` truthy guard still passes and then
  `.toLocaleTimeString()` throws on every single click. This was a real,
  confirmed regression from the per-venue forecast refactor (`f.properties
  .forecastTime = forecast.forecastTime`, a `Date`) — it broke the venue
  detail popup completely, confirmed by clicking hundreds of venues in a
  real browser and seeing the same `toLocaleTimeString is not a function`
  error every time. Fixed by storing an ISO string in `properties`
  (`fetchVenueWeather` in `app.js`) and reconstructing the `Date` only
  at render time in `openVenueDetail`. Any other per-venue value that
  needs a non-JSON-safe type has the same trap.
- **A venue with no successful cloud-cover reading must never default to
  "sunny."** `cloudTierState(null)` returns a dedicated `unknown` state
  (pink `#ec4899`, marker + legend + detail panel all wired up) rather
  than falling through to `sun`. This was a real, confirmed bug: the
  old code had `if (cloudCover == null) return 'sun'` with a comment
  claiming it was safer to "assume clear rather than block the whole
  area" — backwards, since a failed weather fetch silently painted
  venues as sunny with no way to tell the reading was fake. Confirmed
  via a Playwright test that intercepts `/api/weather` and forces every
  request to fail: all affected venues correctly went pink instead of
  yellow. If you add another place that infers a UI state from
  `cloudCover`, check for `null` explicitly first, the same way
  `cloudTierState` does — don't assume a missing reading is safe to
  treat as any particular tier.
- **Stale-cache fallback**: if a live Overpass/Yr fetch fails, the server
  serves whatever cache file exists for that exact key even if expired,
  rather than hard-erroring. Don't remove this without good reason — it's
  what keeps the app usable when the public Overpass mirrors (or Yr) are
  flaky. The server marks these responses `X-Cache: STALE` and the
  client checks that header (`weatherStale`, one flag now — see below)
  to show a visible warning in the venue panel and area panel. Don't let
  a stale response render as if it were fresh — always surface the
  `X-Cache` header when adding a new weather/data display.
  **`weatherStale` is a single flag, not the two independent ones
  (`forecastStale`/`obsStale`) this app used to have** — DMI split
  cloud cover and temp/wind across two APIs that failed independently,
  which needed two separate stale notes to say which reading was cached;
  Yr bundles everything into one call, so one flag is the correct,
  simpler behavior now, not a regression. `renderStaleNotes` in `app.js`
  reflects this — if you ever add a second weather source again, give it
  its own independent stale check rather than folding it into this one.
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
- **Weather is per-venue now, not per-area** — a side effect of moving
  to Yr, not extra work: DMI needed a hand-curated station list
  (`WEATHER_STATIONS`, since removed) because Copenhagen's inner-city
  observation stations each only reported a subset of parameters, so
  temp/wind were area-wide (one station's reading shared by every venue
  in that area) while only cloud cover was per-venue. Yr's
  Locationforecast API has no comparable "station" concept — every grid
  cell carries temp/wind/cloud together — so `fetchVenueWeather` in
  `app.js` just assigns all three (plus `symbolCode`) to every venue from
  its own cell's reading. The area panel's summary figures are still an
  average across the area's distinct cells (temp/wind-speed/cloud via
  plain mean, wind direction via `circularMeanDegrees` — a plain average
  of e.g. 350° and 10° gives 180°, due south, not the correct ~0°) purely
  for that one-line display; a venue's own detail panel always shows its
  own cell's un-averaged reading.
- **Cloud cover is read per-venue, not per-area-center.** One fetch at
  the area's center coordinate applied to every venue would be wrong for
  a venue near an area's edge, which can sit in a genuinely different
  ~2km grid cell than its own area's center (e.g. an Østerbro café close
  to the Nordhavn border) — sharing one area-wide reading gives edge
  venues the wrong number. `fetchVenueWeather` (`app.js`) groups venues
  by which grid cell they fall in (`weatherGridCell`, step sizes
  `WEATHER_GRID_LAT_STEP`/`WEATHER_GRID_LON_STEP`) and fetches once per
  distinct cell, not once per venue — confirmed live: Nørrebro's 286
  venues spanned only 4 distinct cells, so it's 4 `/api/weather` calls,
  not 286. The server independently re-snaps to the same grid
  (`snap_to_weather_grid` in `server.py`) before building the cache key,
  so cells line up for caching even if a client ever computed them
  slightly differently, and a per-cell lock (`_weather_lock_for`)
  coalesces concurrent requests for the same cell so a whole area
  loading at once can't fire duplicate upstream Yr calls for it. **The
  grid step constants are duplicated between `app.js` and `server.py` —
  there's no shared config file, so if you change one, change the
  other.** (This grid-snapping pattern predates Yr — it was originally
  built for DMI's forecast grid and carried over unchanged, since it's
  upstream-agnostic: any per-cell weather API benefits the same way.)
- **`fetch_yr_weather`'s retry budget (`server.py`) is deliberately
  tight — `retries=2`, 2s/4s backoff, worst case ~6s** — not because Yr
  is known to be flaky (the opposite, so far), but because of a hard
  lesson from DMI: **no retry budget fixes a genuinely-down upstream, it
  only makes failures take longer.** Confirmed live while investigating
  the DMI outage that prompted this branch — raising the budget (to
  `retries=3`, 3/6/9s backoff) didn't help; the same request still
  failed after 39s instead of a lower number, since the endpoint was
  actually down, not momentarily busy. Small-and-cheap is the correct
  default; only raise it with live evidence a bigger budget actually
  recovers something, not on the assumption that it might.
- **Rain, from DMI's radar, not Yr** (`fetch_dmi_radar_pair`,
  `get_radar_composite_pair`, `decode_radar_composite`,
  `radar_value_at_offset`, all in `server.py`; `fetchVenuePrecipitation`
  in `app.js`). Yr has no radar product — its Locationforecast API is a
  point forecast, not useful for "is it raining right now, exactly here."
  DMI operates Denmark's actual radar network, so it's the only source
  for this, independent of the forecast-endpoint reliability problem that
  drove this app off DMI for everything else (a different DMI service —
  no evidence it shares that history). Things that are easy to get wrong
  if you touch this:
  - **DMI's radar items listing needs an explicit `datetime` range
    filter, or it does NOT return the newest composite.** Confirmed
    live: a bare `?limit=1` came back with a file from two months
    earlier, while the same call with `&datetime=<3h-ago>/<now>` at the
    same moment correctly returned one ~10 minutes old. This silently
    served stale-looking-fresh radar data (no error, no STALE cache
    header — the "old" response was a clean 200 MISS) until caught by
    actually checking the returned timestamp against the real clock, not
    by any test that only checks HTTP status. Don't drop that filter.
  - **Two composite files are fetched and cached per window, not one —
    `curr` (newest) and `prev` (whichever earlier item is closest to a
    10-minute gap)** — needed to derive a motion vector (see
    `estimate_radar_motion` below), which a single frame can't give you.
    `get_radar_composite_pair` caches and locks around two fixed keys
    (`cache_path('radar', 'composite_curr'/'composite_prev', ext='h5')`,
    one shared `_radar_fetch_lock`), not per-location the way
    `_weather_lock_for` works — there's only ever one pair in play for
    the whole city, not one per grid cell. `fetchVenuePrecipitation`
    sends every venue's exact coordinate in one bulk POST
    (`/api/precipitation`) rather than deduping into shared grid cells
    first — there's nothing to dedupe against, since answering any point
    costs the same cheap array lookup once the pair is cached and its
    motion estimated, not a new upstream call.
  - **The timeline is `RADAR_NOWCAST_OFFSETS_MINUTES` in `server.py` /
    `TIMELINE_OFFSETS_MINUTES` in `app.js` — keep them in sync, no shared
    config file, same as the weather grid steps. Currently -10 to +50 in
    5-minute steps (13 total), stress-testing the motion model's range on
    request.** Only offset 0 is a true unprojected observation (reads
    curr directly, frac=0) — every other step, negative or positive,
    goes through `radar_value_at_offset`'s SAME semi-Lagrangian
    projection from curr along the single motion vector. This is a
    deliberate change from an earlier version where negative offsets
    read the "prev" frame's own raw value directly as a real
    observation — that only worked with exactly one negative step (-15)
    that happened to be targeted to roughly match prev's actual ~15-
    minute gap; it doesn't generalize to multiple negative steps on a
    fine grid, since prev is only ONE frame at ONE actual timestamp (-10
    and -5 would've shown identical values reading it directly). If you
    ever reduce the step count back down to something coarse, don't
    reflexively bring the "negative reads prev directly" special case
    back without checking whether it still makes sense at that grid
    density. `fetch_dmi_radar_pair`'s `target_gap_minutes` (15) no longer
    needs to line up with any specific displayed step — it now only
    affects motion-estimate quality (too short a gap: noisy velocity from
    500m pixel quantization; too long: assumes linear motion over a
    longer window, risking more error for fast-changing storms).
  - **`get_radar_nowcast_state()` caches the DECODED frames and motion
    vector in memory, not just the raw bytes** — without it, every single
    `/api/precipitation` request re-decoded both HDF5 files and re-ran
    the FFT motion estimate from scratch, even on a cache HIT, which was
    real, confirmed, avoidable repeated CPU work (a warm request dropped
    from ~55ms to ~12ms once this was added) — reported live as "tracing
    shadows now takes forever" (the loading step that runs right after
    this fetch, so it read as the slow part even though the actual delay
    was upstream of it). Keyed by a hash of the raw curr bytes, not
    identity — `read_cache_bytes` returns a fresh `bytes` object per call
    even when the underlying file hasn't changed, so `is`/`id()` would
    never hit. If you touch this path, don't decode/re-estimate motion
    directly in the route handler again — always go through this
    function so a cache HIT stays cheap.
    `estimate_radar_motion(prev, curr)` derives ONE Denmark-wide (dx, dy)
    pixel drift vector via FFT phase correlation on downsampled
    (factor-4) frames — a genuinely approximate technique (one global
    vector, not per-cell motion, so it can't capture a storm growing,
    shrinking, rotating, or splitting), confirmed as a reasonable first
    version, not meteorological-grade, per an explicit conversation about
    the tradeoff before this was built. **The sign convention was
    verified against a synthetic test before being wired in, not trusted
    by inspection** — a shifted synthetic blob confirmed `cross = fb *
    conj(fa)` (not `fa * conj(fb)`, which is backwards) gives the correct
    prev→curr motion direction; getting this backwards would have
    silently predicted rain moving the wrong way with no error to catch
    it. `radar_value_at_offset` does semi-Lagrangian sampling for any
    non-zero offset (past or future) — to predict what's at a fixed
    point at curr's time plus that offset, it reads the CURRENT frame at
    the position upstream (or downstream, for a negative offset) along
    the motion vector, not the current frame at that same fixed point.
    This is more trustworthy close to offset 0 than far from it — a
    single global linear vector can't capture a storm turning, growing,
    or dissipating over a longer window, so error compounds with
    distance from curr in either direction; there's no per-step
    confidence indicator for this in the UI currently, just the general
    understanding that steps far from 0 are less reliable. If either
    frame has no rain signal at all (`np.any(a)`/`np.any(b)` both false),
    motion falls back to `(0, 0)` — the whole timeline then degrades to
    persistence (every step equals the current reading), which is the
    *correct* behavior for "nothing to track," not a bug. The client
    (`fetchVenuePrecipitation` in `app.js`) fetches all steps in one POST
    per area load, not one request per step — `timelineStepIndex()`/
    `setTimelineOffset()` switch which already-downloaded step is
    displayed instantly, no re-fetch on scrub. **Yr's temp/wind/cloud get
    the same multi-step treatment for free** (`fetch_yr_weather` returns
    a `steps` array, one entry per offset, each just the nearest
    timeseries entry to now+offset from the SAME single Yr response — no
    extra upstream cost, since Yr's timeseries already covers many hours,
    we're just reading N different points in one response instead of 1).
    Since Yr's near-term resolution is hourly, steps that don't cross an
    hour boundary often resolve to the identical entry — expected, not a
    bug.
  - **The timeline UI has no individual per-step dot buttons any more —
    just a draggable handle on a track with light tick marks (CSS
    `repeating-linear-gradient` on `.timeline-track::after`), not 13 DOM
    elements.** This is a deliberate change from the original 4-step
    design, which rendered one `<button class="timeline-stop">` per
    offset with a hardcoded `left` percentage per `data-offset` value in
    CSS — that doesn't scale past a handful of steps (13 individually
    clickable dots on a ~280px track would be unusably small targets, and
    hardcoding 13 CSS position rules is exactly the kind of thing that
    breaks the next time the step count changes). Clicking anywhere on
    the track or dragging the handle both route through the same
    `timelineOffsetForClientX`, which computes the nearest step generically
    from `TIMELINE_OFFSETS_MINUTES.length` — this already scales to any
    step count, so if the range/granularity changes again, only
    `TIMELINE_OFFSETS_MINUTES` (`app.js`) and `RADAR_NOWCAST_OFFSETS_MINUTES`
    (`server.py`) need to change, nothing in the click/drag handling.
  - **Only the numeric figures scrub with the timeline — venue marker
    colors, sun/shade state, and building shadows stay pinned to "now."**
    A deliberate scope decision (confirmed with the user before building
    this), not a missing feature: recomputing sun position/shadows for
    +15/+30 would be a separate, real feature. If you ever add that,
    don't assume the existing per-venue `state`/`cloudTierState` call
    sites should just start reading a step-indexed value — check whether
    marker recoloring was actually asked for first.
  - **The timeline's stop labels show real clock times (`17:30`,
    `17:45`, …), not relative text (`-15 min`, `Now`) — a deliberate
    fix, not the original design.** The original relative labels implied
    a precision the data doesn't have: DMI's radar composite lags real
    time by ~8-12 minutes on its own (see `RADAR_CACHE_TTL_SECONDS`
    above), so "Now" was showing a reading up to that far behind the
    viewer's actual clock, and "-15 min" was picked from whatever frame
    was actually available (DMI publishes every 5 minutes), so it wasn't
    reliably exactly -15 either — reported live as confusing/looking
    broken when a venue's "Now" step showed 17:35 while the user had
    clicked at 17:47. `updateTimelineClockTimes` (`app.js`) computes all
    4 steps' real times from the radar response alone (`radarTime`/
    `radarPrevTime`, both already real observation timestamps) — it does
    NOT use the device's own clock, so the timeline is internally
    consistent with itself and with the per-venue "Radar as of…"/"…
    (nowcast)" labels, even though neither is a promise about your
    actual wall clock. If you ever want to anchor +15/+30 to the
    viewer's device time instead of the radar frame's own time, that's a
    deliberate design change (discussed and explicitly deferred — the
    relative-label version silently baked in this same assumption
    without saying so, which is what caused the confusion), not a bug
    fix — don't do it without re-confirming that's actually wanted.
  - **Cached for a fixed 5 minutes (`RADAR_CACHE_TTL_SECONDS`), matching
    (not tracking via a header — DMI sends none, unlike Yr's `Expires`)
    the composite's own ~5-minute refresh cadence.** This was 15 minutes
    originally, on the theory that rain moves slowly enough not to need
    tighter caching — wrong in practice: DMI's own publish pipeline
    already lags real time by ~8-12 minutes on its own (confirmed live: a
    14:45 composite wasn't available until 14:53), and stacking up to 15
    more minutes of our own cache on top of that meant a "Now" reading
    could be shown up to ~25 minutes stale — confirmed live and reported
    as feeling "super in the past" at a 20-minute gap. 5 minutes still
    dedupes a burst of area loads within the same window, without adding
    meaningfully to the lag DMI's pipeline already has. Don't raise this
    back toward 15 without re-checking that math.
  - **The reflectivity-to-rain-rate conversion (dBZH → Z → mm/h) uses the
    composite's own `zr-a`/`zr-b` constants from its `how` HDF5 group**,
    not hardcoded Marshall-Palmer textbook values — confirmed live these
    are present in every composite file DMI publishes, so there's no
    reason to hardcode a possibly-stale assumption instead.
  - **A pixel that's `nodata` is excluded from the average; a pixel
    that's `undetect` is included as a real 0.0 mm/h** — these are
    different things (no radar coverage there vs. radar looked and found
    nothing), the same "don't invent a value for a missing reading" rule
    `cloudTierState(null)` already follows for cloud cover. If every
    sampled pixel around a point is `nodata`, `radar_value_at_offset`
    returns `None`, not `0` — the venue then shows `—` for rain, not "no rain."
  - **The composite's stereographic projection (`_radar_project` in
    server.py) is a spherical approximation, not full WGS84-ellipsoidal**
    — confirmed against the file's own corner coordinates to be accurate
    to within ~0.4% across the whole Denmark-to-Sweden extent (987.7km
    computed vs. 992km actual grid width), comfortably inside the margin
    needed to land in the right ~500m pixel for one city. This also
    relies on the composite's `lat_ts` equaling its `lat_0` (56°, both),
    which is what makes the scale factor `k0` come out to exactly `1` —
    don't reuse that shortcut for a different projection where those two
    values differ.
  - **`precipitationStale`/`precipitationTime` are kept independent of
    `weatherStale`/`weatherTime`, not folded together** — same reasoning
    CLAUDE.md already documents for why `forecastStale`/`obsStale` used
    to be two flags back when DMI split cloud cover and temp/wind across
    two calls: Yr and DMI radar are two genuinely separate upstreams that
    fail independently, so `renderStaleNotes` in `app.js` shows up to two
    notes, and the venue panel shows two separate "as of" timestamps
    ("Weather forecast for…" / "Radar as of…").
  - **`MAX_PRECIPITATION_POINTS` is 1000, not something smaller** —
    confirmed live that a lower cap (500) silently 400'd a real,
    non-abusive area load: Indre By alone has 700+ venues in one POST
    body. If you add a new area with even more venues, re-check this
    isn't the bottleneck before assuming something else broke.
- **The UI theme (dark by default, light "day" theme while it's actually
  light out in Copenhagen) is driven by `computeTheme()`/`switchTheme()`
  in `app.js`, toggling `document.documentElement.dataset.theme` and
  swapping the MapLibre style between `MAP_STYLES.night`/`.day`.**
  **`computeTheme()`'s threshold is civil twilight (sun 6° below the
  horizon, `CIVIL_TWILIGHT_ALTITUDE_RAD`), not geometric sunrise/sunset
  (0°)** — this was 0° originally, but Copenhagen's flat terrain and open
  horizon mean there's real ambient daylight for a while after the sun's
  actual altitude crosses 0°, so the dark theme was kicking in while it
  visibly still looked light outside (a real, reported complaint, not a
  theoretical one). One threshold gives a buffer on both ends for free:
  day theme now starts ~20-30 minutes before actual sunrise and lasts
  ~20-30 minutes past actual sunset (varies by season/day length) — don't
  special-case morning vs. evening separately, the single comparison in
  `computeTheme()` already covers both. `map.setStyle()`
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
- **`--accent` is overridden per-theme** (`:root[data-theme="day"]`) to a
  darker goldenrod — the bright night-mode gold (`#ffd166`) has poor
  contrast against the light day background. Don't reuse the base
  `--accent` value for day-theme UI without checking contrast first.
- **`#idle-prompt`'s text color is deliberately hardcoded, not themed**
  (`#f6f1e6` on a fixed dark scrim) — it was originally `var(--ink)`,
  which is exactly backwards: that token flips to a *dark* color in the
  day theme while the scrim stayed dark, making the text unreadable
  (real bug, since fixed). It sits over the map, not the chrome, so it
  shouldn't follow the light/dark theme switch at all — keep it fixed.
- **OSM venue fields (name, cuisine, phone, website, wheelchair, opening
  hours) are untrusted input** — OpenStreetMap is community-edited, so
  any of it can contain arbitrary text, including HTML/script. Every
  insertion point runs it through `escapeHtml()` first (`website` also
  through `safeHttpUrl()`, which rejects non-http(s) schemes like
  `javascript:`). If you add a new place that renders an OSM field via
  `innerHTML`, escape it the same way — this was a real, confirmed XSS
  gap before it got fixed, not a hypothetical.
- **`server.py` binds to `0.0.0.0`, not `localhost`** — deliberate, so a
  phone or other device on the same Wi-Fi can reach it (the startup
  banner prints both the `localhost` and LAN-IP URLs, via `_lan_ip()`'s
  UDP-connect-without-sending trick to ask the OS which interface it'd
  use). This used to be `localhost`-only; **all of the hardening below
  is what made changing it safe, and it's no longer optional/conditional
  — it always applies now**, not just "if this ever gets exposed."
  Don't bind to `localhost` again without re-adding an explicit opt-in
  for LAN access, and don't add a new `/api/*` route without the same
  hardening pattern: per-IP rate limiting (`api_rate_limited()`/
  `static_rate_limited()`), a body-size cap (`/api/overpass`,
  `/api/precipitation`) plus a point-count cap on the latter
  (`MAX_PRECIPITATION_POINTS`, since 1000 tiny points can still fit under
  a byte cap sized for a few hundred), and bounds-checked `lat`/`lon` in
  `/api/weather` and `/api/precipitation`.
- **Static file serving is an allowlist (`PUBLIC_PATHS`), not a
  blocklist — do not change this back.** This was a real, confirmed,
  serious vulnerability, not a theoretical one: before this fix,
  `server.py` served the *entire* project directory via
  `SimpleHTTPRequestHandler`'s default behavior, meaning
  `GET /data/` returned a live directory listing of every cached
  Overpass/Yr/radar response plus the full, unbounded `api_log.jsonl` (bypassing
  `/api/logs`' own size cap entirely), `GET /server.py` returned the
  complete backend source, and `GET /.git/config` / `.git/HEAD` /
  `.git/logs/HEAD` all returned 200 — the whole git history was
  downloadable. Confirmed live with `curl`, not inferred. The fix is
  `PUBLIC_PATHS = {'/', '/index.html', '/app.js', '/readme.md'}` in
  `server.py`, checked before ever calling `super().do_GET()`; anything
  not in that exact set gets a 404 with no directory listing possible.
  **If a new local file needs to be servable (an image, a font, another
  page), add its exact path to `PUBLIC_PATHS` — never restore the
  catch-all fallback**, and never add a whole directory to it (that
  reopens the `data/`-style listing risk for whatever else ends up in
  that directory later).
- **Rate limiting is two separate budgets, not one shared one, and both
  are 120/min** — `api_rate_limited` protects the Overpass/Yr/DMI-radar
  proxies specifically; `static_rate_limited` protects the server itself (static
  files and `/api/logs`, neither of which costs an upstream call). They
  used to be one shared 30/min bucket covering everything, which broke
  real usage: a single area load fans out into an Overpass call plus
  several per-tile weather calls, and once static file requests started
  sharing that same budget, a normal
  single-session flow (load the page, pick an area, open the About tab)
  could exhaust it before `readme.md` even fetched — confirmed live, not
  theoretical. Splitting the budgets wasn't enough on its own, either:
  `api_rate_limited` was left at 30/min after the split and *still* broke
  real usage a second time, confirmed live again — one area load alone
  costs ~7-10 of those requests, so loading even 3-4 areas back to back
  (completely normal use of the multi-select area picker, not abuse)
  exhausted it, and every area after that failed with a misleading
  "Overpass API may be busy" message — misleading because the 429 was
  this server's own limiter, not Overpass. Fixed two ways: raised
  `api_rate_limited` to 120/min (comfortably covers all ten areas back
  to back), and `fetchOverpass` in `app.js` now tags a 429 response with
  `err.ownRateLimit = true` so `loadArea`'s catch block can show an
  accurate message instead of blaming Overpass for something Overpass
  didn't do. If you add a new route, decide which budget it belongs to
  based on whether it costs a real third-party request, not by
  default/habit — and if you ever need to lower either budget again,
  load-test actual multi-area usage first, not just a single area, since
  that's what broke this twice.

- **The "Track" tab (third header tab, alongside Map/About) visualizes every
  proxied API call** — Overpass venues/buildings per area, Yr weather per
  grid tile, DMI radar per area load — as hourly/daily stacked-bar charts
  plus a raw log table, so cache effectiveness (or accidental API
  spamming) is visible rather than only inferable from server console
  output. Three chart cards, not two — the radar card groups by cache
  status (`HIT`/`MISS`/`STALE`) rather than by tile/cell the way the
  weather card does, since one radar composite covers the whole city
  rather than being split per grid cell; don't force it into the same
  per-cell grouping the other two charts use, there's no cell dimension
  to group by. `server.py`'s `log_api_call()` appends one JSON line per
  request (cache status included — `HIT`/`MISS`/`STALE`/`ERROR`) to
  `data/api_log.jsonl` at every response branch of `/api/overpass`,
  `/api/weather`, and `/api/precipitation` — **if you add a new branch to
  any of those routes (a new error path, a new cache outcome), log it
  too, or that branch becomes invisible to the Track tab.** The log is
  trimmed to the last
  `LOG_TRIM_KEEP_LINES` (10,000) once it exceeds `MAX_LOG_BYTES` (5MB), so it
  won't grow unbounded on a long-running server. `GET /api/logs` serves the
  raw entries (capped, rate-limited like the other routes) to
  `app.js`'s `loadTrackData()`, which does all aggregation/bucketing
  client-side — the server stays a dumb log, no pre-aggregation. The
  `areaId`/`kind` query params on `/api/overpass` (added purely for this
  logging) are appended to the URL, never folded into the POST body, so they
  can't affect the cache key. Charts are hand-rolled inline SVG (no charting
  library) to match the project's no-dependency pattern — see
  `renderStackedBarSVG` in `app.js`.
- **Phone layout lives in exactly one `@media (max-width: 700px)` block,
  placed at the very end of `index.html`'s `<style>`, after every base
  rule it overrides.** This is a hard rule, not a preference — CSS
  resolves same-specificity ties by source order, so a media-query
  override placed *earlier* in the file than the base rule it's meant to
  override loses to it regardless of viewport width, silently. This bit
  twice while building this section, both confirmed live, not
  theoretical: (1) an earlier draft put the `#venue-detail`/`footer`
  mobile overrides inside the *other*, earlier `@media` block that used
  to exist further up the file — `#venue-detail`'s `width:100%` override
  lost to the later `width:320px` base rule, so the drawer only ever
  rendered ~320px wide even on a 390px screen; (2) `#toc`'s base rule
  sets `flex: 0 0 210px` to size the desktop sidebar's *width*
  (`.about-layout` is a row there) — the mobile override flips
  `.about-layout` to `flex-direction: column`, which flips which axis
  `flex-basis` sizes too, so that same `210px` silently became the
  mobile TOC bar's *height* instead of doing nothing; it rendered 231px
  tall with its pills vertically centered in dead space until an
  explicit `flex: 0 0 auto` override fixed it. **Both classes of bug are
  invisible unless you actually screenshot at a real phone viewport
  width — resizing a desktop browser window doesn't reliably reproduce
  either one.** If you add a new mobile rule, add it to this one
  end-of-file block, not a new one, and verify it live at 390px and
  320px widths, not just by reading the CSS.
- **Area selection is a dropdown only below 700px** (`#area-dropdown-toggle`
  / `.open` classes in `app.js`) — desktop keeps the always-visible pill
  row (`#area-dropdown-toggle` stays `display:none` there). The dropdown
  panel is `position:absolute` and overlays the map while open, which is
  correct dropdown behavior, but means clicks on it can be mistaken for
  clicks on the map underneath if a test script (or a user) doesn't
  close it first — confirmed while testing this: leaving it open and
  then "clicking around the map center" actually hammered several
  different area-box buttons stacked in that same screen region,
  triggering a burst of unrelated `loadArea`/`unloadArea` calls. Always
  close the dropdown (tap the toggle again, or let the outside-click
  handler catch it) before interacting with the map underneath.
- **The About page's desktop "Apple product page" effect (each `##`
  section forced to a full viewport-height slide via `sizeChapters()`'s
  inline `min-height`, fading in via scroll-snap) is switched off
  entirely below 700px**, not just resized — it's a bad mobile fit,
  since most chapters don't have a full screen's worth of content at
  phone width, which read as mostly-empty space with a barely-visible
  ghost of the next section peeking in ("doesn't look very responsive",
  a real complaint that led to this). The mobile override
  (`.chapter { min-height: auto !important; opacity: 1 !important;
  transform: none !important; }`) has to use `!important` since
  `sizeChapters()` sets `min-height` as an inline style, which nothing
  but `!important` in a stylesheet can beat. Mobile gets a normal,
  continuously-flowing article instead; the TOC's active-chapter
  tracking still works unchanged, since `observeChapters()`'s
  IntersectionObserver was never height-dependent. The desktop slide
  effect itself is untouched.
- **`#panel` (the top-left stats overlay) is collapsible** — a real,
  user-reported problem: with several areas selected at once, the
  per-area rows stack up and the panel can grow tall enough to cover
  most of the map. `#panel-toggle` (the small ‹/› tab clipped half
  outside its edge) toggles a `.collapsed` class on `#panel` itself,
  which shrinks the whole box down to just that tab. **The toggle
  button lives in `index.html` as a persistent sibling of
  `#panel-content`, not inside the markup `renderPanel()` rewrites** —
  `renderPanel()` reruns on every area load/unload/refresh, so if the
  toggle (or the collapsed state) lived inside the HTML it replaces,
  collapsing the panel would silently un-collapse itself the next time
  any area's data changed. Confirmed live that the collapsed state
  survives a fresh area load. If you touch `renderPanel()`, target
  `panelContent.innerHTML`, never `panel.innerHTML` — the latter would
  wipe out the toggle button entirely.
  **The tab sits on the panel's right edge on desktop but the left edge
  on mobile** (`#panel-toggle { left: -13px; right: auto; }` in the
  end-of-file phone block) — another real, user-reported bug: on a
  phone the panel spans nearly the full width, so a right-edge toggle
  landed directly under MapLibre's zoom +/-/compass control, which also
  sits top-right. Confirmed live with bounding-box coordinates that the
  two no longer overlap at any panel width, collapsed or not. If the
  map's own control position ever changes, recheck this.
- **The venue detail panel's "🧭 Navigate" button opens a custom bottom
  sheet (`#nav-sheet`/`#nav-sheet-backdrop`), not the OS's native
  app-picker.** There is no browser API that invokes that — it's
  `MKMapItem`/`UIActivityViewController` on iOS or an Intent chooser on
  Android, both native-app-only, unreachable from a web page. The sheet
  is styled to feel like the native one (the user's actual ask, prompted
  by a screenshot of iOS's own "Navigate with…" sheet) while staying
  fully within our control. Two things worth knowing if you touch this:
  (1) `navTargetCoords` is a single shared module-level variable, not
  per-instance state — the sheet's two option buttons (`#nav-google-maps`,
  `#nav-apple-maps`) are static, created once in `index.html`, and
  `openNavigateSheet(lat, lon)` just overwrites `navTargetCoords` each
  time a venue's Navigate button is clicked, rather than the sheet being
  rebuilt per-venue the way `openVenueDetail`'s content is — this is
  deliberate and fine precisely because only one sheet can ever be open
  at a time. (2) The links are `https://www.google.com/maps/dir/?api=1&
  destination={lat},{lon}&travelmode=walking` and `https://maps.apple.com
  /?daddr={lat},{lon}&dirflg=w` — both universal web links (not `geo:`/
  `maps://` custom schemes), confirmed live to correctly hand off to the
  respective app when installed or fall back to each provider's own web
  maps otherwise; `travelmode=walking`/`dirflg=w` default to walking
  directions since these are cafés/bars/restaurants someone's walking to,
  not driving.

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
