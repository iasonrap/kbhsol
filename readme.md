# Københavns Sol

A map of which cafés, bars and restaurants in Copenhagen are in sun or shade
right now. It combines live cloud cover, the sun's real position, actual
building shadows and live rain. Pick one or more areas and only those load.
Nothing loads until you choose.

## How it works

- **Venues and buildings** come from [OpenStreetMap](https://www.openstreetmap.org)
  through the [Overpass API](https://overpass-api.de). Venues are cafés, bars,
  restaurants and pubs. Buildings are footprints with a height, taken from the
  `height` or `building:levels` tag, or 9 m when neither is set.
- **Sun position** is computed on your device with [SunCalc](https://github.com/mourner/suncalc).
- **Shadows** are checked per venue. A ray is cast from the venue toward the
  sun. If it hits a building tall enough to block the sun at its current
  altitude, the venue is in shade.
- **Wind shelter**: if a building stands within about 40 m, directly upwind of
  a venue, its detail panel says the wind may feel calmer there.
- **Cloud cover, temperature and wind** come from [MET Norway's Locationforecast
  API](https://api.met.no) (the data behind yr.no). One reading covers each
  grid cell of about 2 km, and venues in the same cell share it.
  - Cloud cover sets the sun and shade colour (see below).
  - The top panel shows an area average. Wind direction is averaged properly
    around the compass, so 350° and 10° average to north.
  - Each venue's own detail panel shows its own cell's reading.
- **Rain** comes from [DMI's radar composite](https://opendataapi.dmi.dk), a
  Denmark-wide map of rain from DMI's radar stations. It is shown in mm/h at
  each venue's exact location. Where the radar has no coverage, the figure is
  `—`, not 0.
- **The timeline** runs from -10 to +50 minutes in 5-minute steps. Only "now"
  is a real radar reading. The other steps are short-range estimates. The app
  looks at two recent radar frames and estimates the citywide direction and
  speed of movement, then projects rain along it. The estimate is rough. It
  can't follow a single storm cell growing, shrinking or turning. Steps far
  from "now" are less reliable. Temperature, wind and cloud scrub on the same
  timeline. Each step is labelled with a real clock time.
- **Caching**: a small local Python server (`server.py`) sits between the
  browser and these services and caches each response on disk.
  - Venues and buildings: 25 days, since OpenStreetMap changes slowly.
  - Weather: until the expiry time MET Norway sends, usually 30 to 60 minutes.
  - Radar: 5 minutes, matching how often DMI updates the composite.

## Using the app

- The header has three tabs.
  - **Map**: the sun and shade view.
  - **About**: this page. It is rendered live from `readme.md`.
  - **Track**: every upstream request the server has made, and whether the
    cache served it. It shows totals, hit rate and charts, plus a raw log.
- **Areas.** Pick one or more of ten neighbourhoods: Vesterbro, Frederiksberg,
  Nordvest, Bispebjerg, Nørrebro, Indre By, Østerbro, Nordhavn, Christiania and
  Amagerbro. Clicking an area toggles it on or off. On a phone the list is a
  "Select areas" dropdown.
- **Loading.** While an area loads, a sun animation shows five progress dots:
  venues, buildings, weather, radar and shadows.
- **Venue colours.** Each dot is a café, bar or restaurant, coloured by its
  current state. Checks run in this order, so a building blocking the sun
  always wins over the cloud reading.
  - 🌙 **Dark blue**: the sun is down.
  - 🏢 **Dark grey**: a building is blocking the sun.
  - 🟡 **Yellow**: sunny, cloud cover under 10%.
  - 🌤️ **Pale gold**: partly sunny, 10–30% cloud cover.
  - ⚪ **Light grey**: partly cloudy, 30–60%.
  - ⚫ **Mid grey**: cloudy, 60% or more.
  - 💗 **Pink**: no weather reading for this venue. It shows "N/A" rather than
    guessing, since a missing reading is not clear sky.
  - Each dot also has an icon for its type: a cup for cafés, a wine glass for
    bars and pubs, and a fork and knife for restaurants.
- **Hover** a dot for its name, type and state.
- **Click** a dot to open its detail panel. It shows:
  - **🧭 Navigate**: a sheet to open walking directions in Google Maps or Apple
    Maps. Your phone or computer then picks the app or the web fallback.
  - **Weather**: temperature, wind, cloud cover, a plain-language summary, and
    rain in mm/h. Each reading has its own time. Rain is either "Radar as of…"
    for the current reading, or "Rain forecast for… (nowcast)" for an estimate.
    The figures follow the timeline.
  - **Venue info**: whatever OpenStreetMap has for the place. Opening hours are
    shown as a weekly table that starts from today. Hours that can't be
    parsed reliably appear as the raw OpenStreetMap text. Missing details
    such as cuisine, phone, website or wheelchair access are marked "not
    available on OSM".
- **Timeline.** The control at the bottom of the map scrubs through -10 to
  +50 minutes. Click the track to jump, or drag the handle. The arrow buttons
  step one increment. Only the numbers change. Venue colours and building
  shadows stay on "now".
- **Top-left panel.** It shows the time, sun altitude, the area's average
  cloud cover and rain, and how many venues are in each state. It can be
  collapsed with the small tab on its edge.
- **Theme.** Dark by default. The app switches to a light theme while it is
  light outside, using civil twilight. That starts a little before sunrise and
  ends a little after sunset. The check runs every 10 minutes. The 🌙/☀️
  button in the header switches manually. A manual choice stays for the rest
  of the session. Venue colours don't change between themes.
- **If something is down.** If OpenStreetMap is unavailable, the map shows a
  message with a retry button. If the weather or radar service is
  unavailable, the app shows the last cached reading with a ⚠️ note. The two
  services are reported separately.

## Running it

```bash
pip3 install -r requirements.txt   # h5py and numpy, for the radar
python3 server.py
```

Open **http://localhost:8123**. Use `server.py` rather than a plain static
server, because it provides the caching and rate limiting. The terminal also
prints a LAN address. Open that on a phone on the same Wi-Fi to use the app
there.

## Known limitations

- The ten areas are hand-drawn rectangles, not official district boundaries.
  Edges may include or miss a street.
- Many OpenStreetMap buildings have no height tag, so shadow edges are
  estimates.
- The first load of an area needs Overpass to be reachable. After that, the
  cache serves it.
- Weather is per grid cell, about 2 km. It is not a point forecast.
- Rain uses an approximation of the radar's map projection. It is precise
  enough to place a reading in the right radar pixel over Copenhagen, but
  it is not survey-grade.
- The timeline's future steps are estimates, and their accuracy falls with
  distance from "now".

## Privacy and security

- Venue text from OpenStreetMap is untrusted, since anyone can edit it. It is
  escaped before display, and website links must be `http` or `https`.
- The server only serves the app's own files. Everything else returns 404.
- The server listens on all network interfaces, so anyone on the same Wi-Fi
  can reach it. It is meant for a home network, not the open internet, and it
  does not use TLS.
- Requests to the upstream services are rate limited, so the server can't be
  used as an open relay.

## Data and licences

- OpenStreetMap data is © OpenStreetMap contributors, under the ODbL.
- Weather data is from MET Norway, under CC BY 4.0. It is credited to the
  Norwegian Meteorological Institute and NRK.
- Radar data is from DMI's open data.
- Map tiles come from [OpenFreeMap](https://openfreemap.org) on
  [MapLibre GL](https://maplibre.org). Calculations use [Turf.js](https://turfjs.org)
  and [SunCalc](https://github.com/mourner/suncalc). The About page is rendered
  with [marked](https://marked.js.org).

The app's own code is under the PolyForm Strict License 1.0.0 (see `LICENSE`).
It is free to read. Reuse, modification and redistribution are not licensed.
