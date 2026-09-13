// --- Config ---------------------------------------------------------------

// Rough bounding box for Nordvest, Copenhagen (south, west, north, east)
const BBOX = { south: 55.696, west: 12.515, north: 55.722, east: 12.565 };
const CENTER = [ (BBOX.west + BBOX.east) / 2, (BBOX.south + BBOX.north) / 2 ];

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter'
];
const DMI_OBS_URL = 'https://opendataapi.dmi.dk/v2/metObs/collections/observation/items';

const SUNNY_CLOUD_THRESHOLD = 60; // cloud_cover value (0-100 scale) below which we consider it "sunny enough"
const SHADOW_RAY_METERS = 200;    // how far to search for occluding buildings

const panel = document.getElementById('panel');

// --- Overpass fetch ---------------------------------------------------------

function bboxStr() {
  return `${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchOverpass(query, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    for (const url of OVERPASS_URLS) {
      try {
        const res = await fetch(url, { method: 'POST', body: query });
        if (!res.ok) throw new Error(`Overpass ${url} responded ${res.status}`);
        return await res.json();
      } catch (err) {
        console.warn('Overpass endpoint failed', url, err);
        lastErr = err;
      }
    }
    if (attempt < retries) await sleep(2000 * (attempt + 1)); // backoff before retrying all mirrors again
  }
  throw lastErr;
}

const BUILDINGS_CACHE_KEY = 'followthesun_buildings_v1';
const BUILDINGS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 day — building footprints rarely change

function loadCachedBuildings() {
  try {
    const raw = localStorage.getItem(BUILDINGS_CACHE_KEY);
    if (!raw) return null;
    const { savedAt, data } = JSON.parse(raw);
    if (Date.now() - savedAt > BUILDINGS_CACHE_MAX_AGE_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function saveCachedBuildings(data) {
  try {
    localStorage.setItem(BUILDINGS_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    // ignore quota errors, caching is a best-effort optimization
  }
}

async function fetchBuildings() {
  const cached = loadCachedBuildings();
  if (cached) return cached;

  const query = `
    [out:json][timeout:60];
    way["building"](${bboxStr()});
    out geom;
  `;
  const data = await fetchOverpass(query);
  const geojson = overpassBuildingsToGeoJSON(data);
  saveCachedBuildings(geojson);
  return geojson;
}

async function fetchVenues() {
  const query = `
    [out:json][timeout:25];
    (
      node["amenity"~"^(cafe|bar|restaurant|pub)$"](${bboxStr()});
      way["amenity"~"^(cafe|bar|restaurant|pub)$"](${bboxStr()});
    );
    out center;
  `;
  const data = await fetchOverpass(query);
  return overpassVenuesToGeoJSON(data);
}

function overpassBuildingsToGeoJSON(data) {
  const features = data.elements
    .filter(el => el.type === 'way' && el.geometry && el.geometry.length > 2)
    .map(el => {
      const coords = el.geometry.map(pt => [pt.lon, pt.lat]);
      const first = coords[0], last = coords[coords.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);

      const tags = el.tags || {};
      let height;
      if (tags.height) height = parseFloat(tags.height);
      else if (tags['building:levels']) height = parseFloat(tags['building:levels']) * 3;
      else height = 9; // default ~3 storeys

      return {
        type: 'Feature',
        properties: { id: el.id, height: isNaN(height) ? 9 : height },
        geometry: { type: 'Polygon', coordinates: [coords] }
      };
    });
  return { type: 'FeatureCollection', features };
}

function overpassVenuesToGeoJSON(data) {
  const features = data.elements
    .map(el => {
      const lon = el.type === 'node' ? el.lon : el.center && el.center.lon;
      const lat = el.type === 'node' ? el.lat : el.center && el.center.lat;
      if (lon == null || lat == null) return null;
      const tags = el.tags || {};
      return {
        type: 'Feature',
        properties: {
          id: el.id,
          name: tags.name || 'Unnamed',
          amenity: tags.amenity || '',
          icon: amenityIconName(tags.amenity),
          outdoor_seating: tags.outdoor_seating || 'unknown',
          state: 'night'
        },
        geometry: { type: 'Point', coordinates: [lon, lat] }
      };
    })
    .filter(Boolean);
  return { type: 'FeatureCollection', features };
}

// --- DMI weather ------------------------------------------------------------

async function fetchCloudCover(lat, lon) {
  const d = 0.2;
  const bbox = `${lon - d},${lat - d},${lon + d},${lat + d}`;
  const url = `${DMI_OBS_URL}?parameterId=cloud_cover&bbox=${bbox}&limit=20&sortorder=observed,DESC`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`DMI request failed: ${res.status}`);
    const data = await res.json();
    if (!data.features || !data.features.length) return null;

    // Take the most recent reading per station, then average across stations.
    const latestByStation = {};
    for (const f of data.features) {
      const sid = f.properties.stationId;
      if (!(sid in latestByStation)) latestByStation[sid] = f.properties.value;
    }
    const values = Object.values(latestByStation).filter(v => typeof v === 'number');
    if (!values.length) return null;
    return values.reduce((a, b) => a + b, 0) / values.length;
  } catch (err) {
    console.error('DMI fetch failed', err);
    return null;
  }
}

// --- Venue icons ------------------------------------------------------------

function amenityIconName(amenity) {
  if (amenity === 'cafe') return 'icon-cafe';
  if (amenity === 'bar' || amenity === 'pub') return 'icon-bar';
  return 'icon-restaurant'; // restaurant, or unrecognized amenity
}

function makeIconCanvas(draw) {
  const size = 24;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#fff';
  ctx.fillStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  draw(ctx, size);
  return ctx.getImageData(0, 0, size, size);
}

function drawCafeIcon(ctx, s) {
  // coffee cup: body + handle + saucer
  ctx.beginPath();
  ctx.moveTo(6, 9);
  ctx.lineTo(7, 18);
  ctx.quadraticCurveTo(7, 20, 12, 20);
  ctx.quadraticCurveTo(17, 20, 18, 18);
  ctx.lineTo(19, 9);
  ctx.closePath();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(20, 12, 2.5, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();
}

function drawBarIcon(ctx, s) {
  // wine glass: bowl + stem + base
  ctx.beginPath();
  ctx.moveTo(7, 5);
  ctx.lineTo(8, 12);
  ctx.quadraticCurveTo(8, 16, 12, 16);
  ctx.quadraticCurveTo(16, 16, 17, 12);
  ctx.lineTo(18, 5);
  ctx.closePath();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(12, 16);
  ctx.lineTo(12, 20);
  ctx.moveTo(8, 20);
  ctx.lineTo(16, 20);
  ctx.stroke();
}

function drawRestaurantIcon(ctx, s) {
  // fork (left): two tines converging into a single handle
  ctx.beginPath();
  ctx.moveTo(6, 4);
  ctx.lineTo(6, 9);
  ctx.lineTo(8, 11);
  ctx.lineTo(8, 20);
  ctx.moveTo(9, 4);
  ctx.lineTo(9, 9);
  ctx.lineTo(8, 11);
  ctx.stroke();

  // knife (right): angled blade + straight handle
  ctx.beginPath();
  ctx.moveTo(16, 4);
  ctx.quadraticCurveTo(19, 7, 16, 11);
  ctx.lineTo(16, 20);
  ctx.stroke();
}

function registerVenueIcons(map) {
  map.addImage('icon-cafe', makeIconCanvas(drawCafeIcon), { pixelRatio: 2 });
  map.addImage('icon-bar', makeIconCanvas(drawBarIcon), { pixelRatio: 2 });
  map.addImage('icon-restaurant', makeIconCanvas(drawRestaurantIcon), { pixelRatio: 2 });
}

// --- Sun position -------------------------------------------------------

function getSunInfo(lat, lon) {
  const now = new Date();
  const pos = SunCalc.getPosition(now, lat, lon);
  const altitudeDeg = pos.altitude * 180 / Math.PI;
  const bearingDeg = (pos.azimuth * 180 / Math.PI + 180) % 360; // compass bearing, from north, clockwise
  return { time: now, altitudeDeg, bearingDeg, altitudeRad: pos.altitude };
}

// --- Shadow calc ----------------------------------------------------------

function isVenueShadowed(venueCoord, buildings, bearingDeg, altitudeRad) {
  const end = turf.destination(venueCoord, SHADOW_RAY_METERS / 1000, bearingDeg, { units: 'kilometers' }).geometry.coordinates;
  const ray = turf.lineString([venueCoord, end]);

  for (const building of buildings.features) {
    // Cheap pre-filter: skip buildings clearly too far to matter before running exact geometry checks.
    const approxCoord = building.geometry.coordinates[0][0];
    if (turf.distance(venueCoord, approxCoord, { units: 'meters' }) > SHADOW_RAY_METERS * 1.5) continue;
    if (!turf.booleanIntersects(ray, building)) continue;

    const line = turf.polygonToLine(building);
    const intersections = turf.lineIntersect(ray, line);
    if (!intersections.features.length) continue;

    let minDist = Infinity;
    for (const pt of intersections.features) {
      const dist = turf.distance(venueCoord, pt, { units: 'meters' });
      if (dist > 1 && dist < minDist) minDist = dist; // ignore self-intersections at ~0m
    }
    if (minDist === Infinity) continue;

    const requiredHeight = minDist * Math.tan(altitudeRad);
    if (building.properties.height >= requiredHeight) return true;
  }
  return false;
}

// --- Main -------------------------------------------------------------------

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: CENTER,
  zoom: 15.5,
  pitch: 45
});

map.addControl(new maplibregl.NavigationControl());

map.on('load', async () => {
  panel.textContent = 'Fetching buildings & venues from OpenStreetMap…';

  let buildings, venues;
  try {
    [buildings, venues] = await Promise.all([fetchBuildings(), fetchVenues()]);
  } catch (err) {
    console.error('Failed to load OSM data', err);
    panel.innerHTML = 'Could not load map data from OpenStreetMap (Overpass API may be busy). <br><button onclick="location.reload()">Retry</button>';
    return;
  }

  panel.textContent = 'Fetching cloud cover from DMI…';
  const cloudCover = await fetchCloudCover(CENTER[1], CENTER[0]);
  const sun = getSunInfo(CENTER[1], CENTER[0]);

  const sunIsUp = sun.altitudeDeg > 0;
  const skyIsClearEnough = cloudCover == null ? true : cloudCover <= SUNNY_CLOUD_THRESHOLD;
  const sunAvailable = sunIsUp && skyIsClearEnough;

  for (const f of venues.features) {
    let state;
    if (!sunIsUp) {
      state = 'night';
    } else if (!skyIsClearEnough) {
      state = 'cloudy';
    } else {
      state = isVenueShadowed(f.geometry.coordinates, buildings, sun.bearingDeg, sun.altitudeRad)
        ? 'building-shade'
        : 'sun';
    }
    f.properties.state = state;
  }

  map.addSource('buildings', { type: 'geojson', data: buildings });
  map.addLayer({
    id: 'buildings-3d',
    type: 'fill-extrusion',
    source: 'buildings',
    paint: {
      'fill-extrusion-color': '#888',
      'fill-extrusion-height': ['get', 'height'],
      'fill-extrusion-opacity': 0.6
    }
  });

  registerVenueIcons(map);

  map.addSource('venues', { type: 'geojson', data: venues });
  map.addLayer({
    id: 'venues-dots',
    type: 'circle',
    source: 'venues',
    paint: {
      'circle-radius': 10,
      'circle-color': [
        'match', ['get', 'state'],
        'sun', '#ffd166',
        'building-shade', '#4a5568',
        'cloudy', '#cbd5e0',
        'night', '#1a2a6c',
        '#4a5568'
      ],
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#1a1a1a'
    }
  });
  map.addLayer({
    id: 'venues-icons',
    type: 'symbol',
    source: 'venues',
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-size': 0.7,
      'icon-allow-overlap': true
    }
  });

  const STATE_LABELS = {
    'sun': '☀️ In the sun',
    'building-shade': '🏢 In shade (blocked by a building)',
    'cloudy': '☁️ Shaded (too cloudy for direct sun)',
    'night': '🌙 Shaded (sun is down)'
  };

  const popup = new maplibregl.Popup({ closeButton: false, offset: 10 });
  map.on('mouseenter', 'venues-dots', (e) => {
    map.getCanvas().style.cursor = 'pointer';
    const f = e.features[0];
    popup.setLngLat(f.geometry.coordinates)
      .setHTML(`<b>${f.properties.name}</b><br>${f.properties.amenity}<br>${STATE_LABELS[f.properties.state]}`)
      .addTo(map);
  });
  map.on('mouseleave', 'venues-dots', () => {
    map.getCanvas().style.cursor = '';
    popup.remove();
  });

  const counts = { sun: 0, 'building-shade': 0, cloudy: 0, night: 0 };
  for (const f of venues.features) counts[f.properties.state]++;

  panel.innerHTML = `
    <b>${sun.time.toLocaleTimeString('da-DK')}</b><br>
    Sun altitude: ${sun.altitudeDeg.toFixed(1)}°<br>
    Cloud cover: ${cloudCover == null ? 'unknown' : cloudCover.toFixed(0) + '%'}<br>
    ${sunAvailable ? 'Sun is out' : (sunIsUp ? 'Too cloudy' : 'Sun is down')}<br>
    <div id="legend">
      <span class="dot sun"></span>In sun (${counts.sun})<br>
      <span class="dot shade"></span>Building shade (${counts['building-shade']})<br>
      <span class="dot cloudy"></span>Cloudy (${counts.cloudy})<br>
      <span class="dot night"></span>Night (${counts.night})
    </div>
  `;
});
