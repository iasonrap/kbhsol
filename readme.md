# Follow The Sun

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
  `data/` for 20 minutes. Toggling areas on and off repeatedly reuses
  the cached file instead of re-hitting the public APIs — useful since
  those are shared, rate-limited services.
- **Sun position** — computed locally with [SunCalc](https://github.com/mourner/suncalc)
  (altitude + azimuth for the current time and location). No API needed.
- **Cloud cover** — pulled from [DMI Open Data](https://opendataapi.dmi.dk)'s
  Meteorological Observation API (`parameterId=cloud_cover`), averaged
  across nearby stations. No API key required — DMI's endpoint is open,
  subject only to fair-use rate limiting.
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

- The header has two tabs: **Map** (the sun/shade view) and **About**,
  which fetches and renders this very readme live — edits to `readme.md`
  show up there automatically, no rebuild needed.
- Below the header is the area bar. On open, the map shows a wide view
  of Copenhagen and loads nothing — pick one or more areas
  (Vesterbro/Frederiksberg, Nordvest/Bispebjerg, Nørrebro,
  Østerbro/Nordhavn, Christiania/Amagerbro).
- Clicking an area toggles it on (loads its data) or off (removes it from
  the map) — you can have several areas active at once, and the panel
  aggregates counts across all of them.
- While an area is loading, a full-screen overlay shows a pulsing sun
  animation with live status text and four progress dots (venues,
  buildings, weather, shadows) so you can see what stage it's at.
- The footer has a GitHub link and a "Built with Claude" note.
- Each dot is a café, bar, or restaurant, colored by its current state:
  - 🟡 **yellow** — in the sun right now
  - ⚫ **dark grey** — in shade because a building is blocking the sun
  - ⚪ **light grey** — shaded because it's too cloudy for direct sun,
    even though the sun is up
  - 🔵 **dark blue** — shaded because the sun is down (night)
- Each dot also shows a small icon for its type: a cup (café), a wine
  glass (bar/pub), or a fork & knife (restaurant).
- Hover over a dot to see its name, type, and the specific reason it's
  sunny or shaded (e.g. "In shade (blocked by a building)").
- The panel in the top-left shows the current time, sun altitude,
  cloud cover %, and a running count of venues in each of the four
  states.
- If OpenStreetMap's Overpass API is temporarily down, you'll see a
  "Could not load map data" message with a retry button instead of a
  silent hang.

## Known limitations

- Only covers five predefined areas — their bounding boxes are hand-drawn
  estimates in `app.js` (`AREAS`), not sourced from an official district
  boundary dataset, so edges may clip or overreach slightly.
- Building heights are often estimated (many OSM buildings lack a
  `height` tag), so shadow edges won't be pixel-accurate.
- Venue and building data are fetched live from Overpass through the
  local caching proxy rather than saved into static `.geojson` files, so
  the app still depends on Overpass being reachable the first time an
  area is loaded (or once every 20 minutes after that).
