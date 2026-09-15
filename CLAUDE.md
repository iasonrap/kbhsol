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
  math, MapLibre rendering, the tabs/About-page/TOC logic, the Track tab's
  charts and log table.
- `server.py` — static file server + caching proxy. No other backend.
- `data/` — cache files (gitignored), named `<prefix>_<sha1-of-request>.json`,
  plus `data/api_log.jsonl` — one line per proxied API call (see "Track tab"
  below).
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
  (`fetchVenueForecasts` in `app.js`) and reconstructing the `Date` only
  at render time in `openVenueDetail`. Any other per-venue value that
  needs a non-JSON-safe type has the same trap.
- **A venue with no successful cloud-cover reading must never default to
  "sunny."** `cloudTierState(null)` returns a dedicated `unknown` state
  (pink `#ec4899`, marker + legend + detail panel all wired up) rather
  than falling through to `sun`. This was a real, confirmed bug: the
  old code had `if (cloudCover == null) return 'sun'` with a comment
  claiming it was safer to "assume clear rather than block the whole
  area" — backwards, since DMI's forecast endpoint is the one that
  rate-limits hardest, so a failed fetch silently painted venues as
  sunny with no way to tell the reading was fake. Confirmed via a
  Playwright test that intercepts `/api/forecast` and forces every
  request to fail: all affected venues correctly went pink instead of
  yellow. If you add another place that infers a UI state from
  `cloudCover`, check for `null` explicitly first, the same way
  `cloudTierState` does — don't assume a missing reading is safe to
  treat as any particular tier.
- **Stale-cache fallback**: if a live Overpass/DMI fetch fails, the server
  serves whatever cache file exists for that exact key even if expired,
  rather than hard-erroring. Don't remove this without good reason — it's
  what keeps the app usable when the public Overpass mirrors are flaky
  (which happens often). The server marks these responses `X-Cache: STALE`
  and the client checks that header (`fetchWeather`'s `forecastStale`/
  `obsStale`) to show a visible warning in the venue panel and area
  panel — this was a real bug found live: DMI's forecast endpoint was
  429-rate-limited, silently serving an **11-hour-old** cached reading
  with no indication, so a venue's "Cloud forecast for 23:00" showed up
  at 10am with no way to tell it wasn't current. Don't let a stale
  response render as if it were fresh — always surface the `X-Cache`
  header when adding a new weather/data display.
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
  uses the **forecast** model (`harmonie_dini_sf`) at a 2km grid. Temp/wind
  (`fetchDmiParameter`) still come from the nearest observation station,
  since those don't need the same spatial granularity and observation
  data is a real measurement rather than a model's nearest-hour value.
  Don't switch temp/wind to the forecast source without a reason — it'd
  add rate-limit risk for no benefit.
- **Cloud cover is read per-venue, not per-area-center.** It used to be
  one fetch at the area's center coordinate applied to every venue in
  that area — wrong for a venue near an area's edge, which can sit in a
  genuinely different 2km grid cell than its own area's center (e.g. an
  Østerbro café close to the Nordhavn border). Now `fetchVenueForecasts`
  (`app.js`) groups venues by which grid cell they fall in
  (`forecastGridCell`, step sizes `FORECAST_GRID_LAT_STEP`/
  `FORECAST_GRID_LON_STEP`) and fetches once per distinct cell, not once
  per venue — confirmed live: Nørrebro's 286 venues spanned only 4
  distinct cells, so it's 4 `/api/forecast` calls, not 286. The server
  independently re-snaps to the same grid (`snap_to_forecast_grid` in
  `server.py`) before building the cache key, so cells line up for
  caching even if a client ever computed them slightly differently, and
  a per-cell lock (`_forecast_lock_for`) coalesces concurrent requests
  for the same cell so a whole area loading at once can't fire duplicate
  upstream DMI calls for it. **The grid step constants are duplicated
  between `app.js` and `server.py` — there's no shared config file, so
  if you change one, change the other.** The area panel's single
  "Cloud X%" figure is now an average across the area's distinct cells
  (`avgCloudCover` in `loadArea`); a venue's own detail panel shows its
  own cell's reading, which can legitimately differ from that average.
- **`fetch_dmi_forecast_cloud_cover`'s retry budget (`server.py`) is
  deliberately tight — `retries=2`, 2s/4s backoff, worst case ~6s.** It
  used to be `retries=4` with a 3/6/9/12s backoff (worst case ~30s),
  tuned back when only one forecast call happened per area load. Since
  the per-venue grid-tiling change above, an area load fires one call
  per distinct grid cell *in parallel*, so when DMI is genuinely
  rate-limiting, every one of those parallel calls pays the same
  worst-case tax independently and the user is stuck on the loading
  overlay for as long as the *slowest* one takes — confirmed live at
  over 60s (once even 150s) during a real DMI 429 spell, which is
  exactly what read as "an error on the map" even though nothing had
  actually crashed. Don't raise this back up without re-checking that
  math — the stale-cache fallback is already a good answer within its
  60-minute TTL, so failing into it fast matters more than marginally
  fresher data bought with a much longer hang.
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
  `static_rate_limited()`), a body-size cap on `/api/overpass`, an
  allowlist for `parameterId` in `/api/weather`, and bounds-checked
  `lat`/`lon` in `/api/forecast`.
- **Static file serving is an allowlist (`PUBLIC_PATHS`), not a
  blocklist — do not change this back.** This was a real, confirmed,
  serious vulnerability, not a theoretical one: before this fix,
  `server.py` served the *entire* project directory via
  `SimpleHTTPRequestHandler`'s default behavior, meaning
  `GET /data/` returned a live directory listing of every cached
  Overpass/DMI response plus the full, unbounded `api_log.jsonl` (bypassing
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
  are 120/min** — `api_rate_limited` protects the Overpass/DMI proxies
  specifically; `static_rate_limited` protects the server itself (static
  files and `/api/logs`, neither of which costs an upstream call). They
  used to be one shared 30/min bucket covering everything, which broke
  real usage: a single area load fans out into an Overpass call plus
  several per-tile forecast calls plus a few observation calls, and once
  static file requests started sharing that same budget, a normal
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
  proxied API call** — Overpass venues/buildings per area, DMI forecast per
  grid tile, DMI observation per station — as hourly/daily stacked-bar charts
  plus a raw log table, so cache effectiveness (or accidental API spamming)
  is visible rather than only inferable from server console output.
  `server.py`'s `log_api_call()` appends one JSON line per request (cache
  status included — `HIT`/`MISS`/`STALE`/`ERROR`) to `data/api_log.jsonl` at
  every response branch of `/api/overpass`, `/api/forecast`, and
  `/api/weather` — **if you add a new branch to any of those three routes
  (a new error path, a new cache outcome), log it too, or that branch
  becomes invisible to the Track tab.** The log is trimmed to the last
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
