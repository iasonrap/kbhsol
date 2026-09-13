# Follow The Sun

A map that shows, right now, which cafés/bars/restaurants in Nordvest,
Copenhagen are sitting in sun vs. shade — based on live cloud cover,
real sun position, and actual building shadows.

## How it works

Everything runs client-side, no backend or build step:

- **Venues** — fetched live from the [Overpass API](https://overpass-api.de)
  (OpenStreetMap), querying `amenity=cafe|bar|restaurant|pub` inside a
  bounding box covering Nordvest. Two mirrors are tried with retries,
  since the public Overpass instance is occasionally slow/overloaded.
- **Buildings** — same source, fetched as footprints with height
  (from the `height` or `building:levels` tag, default 9m if untagged).
  Cached in the browser's `localStorage` for 24h so the ~6,000 building
  polygons aren't re-fetched on every page load.
- **Sun position** — computed locally with [SunCalc](https://github.com/mourner/suncalc)
  (altitude + azimuth for the current time and location). No API needed.
- **Cloud cover** — pulled from [DMI Open Data](https://opendataapi.dmi.dk)'s
  Meteorological Observation API (`parameterId=cloud_cover`), averaged
  across nearby stations. No API key required — DMI's new endpoint is
  open, subject only to fair-use rate limiting.
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

No Google Maps/Places API is used — everything is free, open data with
no API keys or billing required.

## Running it

This is a static site — just serve the folder and open it:

```bash
python3 -m http.server 8123
```

Then open **http://localhost:8123** in a browser.

## Using the app

- The map loads centered on Nordvest, Copenhagen with 3D buildings.
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

- Only covers Nordvest — the bounding box is hardcoded in `app.js`
  (`BBOX`), so extending coverage means widening it and expecting more
  buildings/venues to fetch.
- Building heights are often estimated (many OSM buildings lack a
  `height` tag), so shadow edges won't be pixel-accurate.
- Venue and building data are fetched live from Overpass rather than
  saved into static `.geojson` files, so the app depends on Overpass's
  public API being reachable each time it loads (buildings are cached
  for 24h in the browser to reduce this).
