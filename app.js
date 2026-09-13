// --- Config ---------------------------------------------------------------

// Rough bounding boxes (south, west, north, east) for each selectable area of Copenhagen.
const AREAS = {
  'vesterbro-frederiksberg': {
    label: 'Vesterbro / Frederiksberg',
    bbox: { south: 55.665, west: 12.500, north: 55.688, east: 12.575 }
  },
  'nordvest-bispebjerg': {
    label: 'Nordvest / Bispebjerg',
    bbox: { south: 55.700, west: 12.515, north: 55.735, east: 12.575 }
  },
  'norrebro': {
    label: 'Nørrebro',
    bbox: { south: 55.685, west: 12.530, north: 55.703, east: 12.575 }
  },
  'osterbro-nordhavn': {
    label: 'Østerbro / Nordhavn',
    bbox: { south: 55.695, west: 12.575, north: 55.735, east: 12.615 }
  },
  'christiania-amagerbro': {
    label: 'Christiania / Amagerbro',
    bbox: { south: 55.660, west: 12.585, north: 55.685, east: 12.620 }
  }
};

function areaCenter(bbox) {
  return [(bbox.west + bbox.east) / 2, (bbox.south + bbox.north) / 2];
}

const SUNNY_CLOUD_THRESHOLD = 60; // cloud_cover value (0-100 scale) below which we consider it "sunny enough"
const SHADOW_RAY_METERS = 200;    // how far to search for occluding buildings

const panel = document.getElementById('panel');

// --- Tabs (Map / About) ------------------------------------------------

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('map-view').hidden = tab.dataset.view !== 'map';
    document.getElementById('about-view').hidden = tab.dataset.view !== 'about';
  });
});

const aboutView = document.getElementById('about-view');
const scrollHint = document.getElementById('scroll-hint');

scrollHint.addEventListener('click', () => {
  aboutView.scrollBy({ top: aboutView.clientHeight * 0.85, behavior: 'smooth' });
});

function updateScrollHint() {
  const nearBottom = aboutView.scrollTop + aboutView.clientHeight >= aboutView.scrollHeight - 40;
  scrollHint.classList.toggle('hidden', nearBottom);
}
aboutView.addEventListener('scroll', updateScrollHint);

let readmeLoaded = false;
document.querySelector('[data-view="about"]').addEventListener('click', async () => {
  if (readmeLoaded) return;
  readmeLoaded = true;
  const content = document.getElementById('about-content');
  try {
    const res = await fetch('readme.md');
    const markdown = await res.text();
    content.innerHTML = marked.parse(markdown);
  } catch (err) {
    content.textContent = 'Could not load readme.md.';
    readmeLoaded = false;
  }
  updateScrollHint();
});

// --- Overpass fetch ---------------------------------------------------------

function bboxStr(bbox) {
  return `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
}

// Overpass and DMI requests go through our own tiny local proxy (server.py),
// which caches responses to disk under data/ for 20 minutes — so clicking
// areas on/off repeatedly doesn't re-hit the public APIs each time.
async function fetchOverpass(query) {
  const res = await fetch('/api/overpass', { method: 'POST', body: query });
  if (!res.ok) throw new Error(`Overpass proxy responded ${res.status}`);
  return res.json();
}

async function fetchBuildings(areaId, bbox) {
  const query = `
    [out:json][timeout:60];
    way["building"](${bboxStr(bbox)});
    out geom;
  `;
  const data = await fetchOverpass(query);
  return overpassBuildingsToGeoJSON(data);
}

async function fetchVenues(bbox) {
  const query = `
    [out:json][timeout:25];
    (
      node["amenity"~"^(cafe|bar|restaurant|pub)$"](${bboxStr(bbox)});
      way["amenity"~"^(cafe|bar|restaurant|pub)$"](${bboxStr(bbox)});
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
  const url = `/api/weather?bbox=${encodeURIComponent(bbox)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`DMI proxy responded ${res.status}`);
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

const COPENHAGEN_CENTER = [12.57, 55.685];

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: COPENHAGEN_CENTER,
  zoom: 11.5,
  pitch: 0
});

map.addControl(new maplibregl.NavigationControl());

// --- Loading overlay --------------------------------------------------

const idlePrompt = document.getElementById('idle-prompt');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');

function resetLoadingSteps() {
  loadingOverlay.innerHTML = `
    <div class="sun-loader"><div class="rays"></div><div class="core"></div></div>
    <div id="loading-text">Waking up the sun…</div>
    <div id="loading-steps">
      <span data-step="venues"></span>
      <span data-step="buildings"></span>
      <span data-step="weather"></span>
      <span data-step="shadows"></span>
    </div>
  `;
  loadingOverlay.classList.remove('fade-out');
  loadingOverlay.hidden = false;
}

function markStepDone(step) {
  const dot = loadingOverlay.querySelector(`[data-step="${step}"]`);
  if (dot) dot.classList.add('done');
}

function setLoadingText(text) {
  const el = document.getElementById('loading-text');
  if (el) el.textContent = text;
}

function hideLoadingOverlay() {
  loadingOverlay.classList.add('fade-out');
  setTimeout(() => { loadingOverlay.hidden = true; }, 500);
  panel.hidden = false;
}

function showLoadingError(message) {
  loadingOverlay.innerHTML = `
    <div class="sun-loader"><div class="core" style="animation:none;filter:grayscale(1);opacity:0.6"></div></div>
    <div class="error-box">${message}</div>
    <button class="retry" onclick="location.reload()">Retry</button>
  `;
}

const STATE_LABELS = {
  'sun': '☀️ In the sun',
  'building-shade': '🏢 In shade (blocked by a building)',
  'cloudy': '☁️ Shaded (too cloudy for direct sun)',
  'night': '🌙 Shaded (sun is down)'
};

let iconsRegistered = false;
const popup = new maplibregl.Popup({ closeButton: false, offset: 10 });

// Each toggled-on area gets its own source/layer set, keyed by areaId, so
// areas can be independently added and removed without touching each other.
const loadedAreas = {}; // areaId -> { venues, counts }
let pendingLoads = 0;

function addAreaLayers(areaId, buildings, venues) {
  if (!iconsRegistered) {
    registerVenueIcons(map);
    iconsRegistered = true;
  }

  map.addSource(`buildings-${areaId}`, { type: 'geojson', data: buildings });
  map.addLayer({
    id: `buildings-3d-${areaId}`,
    type: 'fill-extrusion',
    source: `buildings-${areaId}`,
    paint: {
      'fill-extrusion-color': '#888',
      'fill-extrusion-height': ['get', 'height'],
      'fill-extrusion-opacity': 0.6
    }
  });

  map.addSource(`venues-${areaId}`, { type: 'geojson', data: venues });
  map.addLayer({
    id: `venues-dots-${areaId}`,
    type: 'circle',
    source: `venues-${areaId}`,
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
    id: `venues-icons-${areaId}`,
    type: 'symbol',
    source: `venues-${areaId}`,
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-size': 0.7,
      'icon-allow-overlap': true
    }
  });

  map.on('mouseenter', `venues-dots-${areaId}`, (e) => {
    map.getCanvas().style.cursor = 'pointer';
    const f = e.features[0];
    popup.setLngLat(f.geometry.coordinates)
      .setHTML(`<b>${f.properties.name}</b><br>${f.properties.amenity}<br>${STATE_LABELS[f.properties.state]}`)
      .addTo(map);
  });
  map.on('mouseleave', `venues-dots-${areaId}`, () => {
    map.getCanvas().style.cursor = '';
    popup.remove();
  });
}

function removeAreaLayers(areaId) {
  for (const id of [`venues-icons-${areaId}`, `venues-dots-${areaId}`, `buildings-3d-${areaId}`]) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of [`venues-${areaId}`, `buildings-${areaId}`]) {
    if (map.getSource(id)) map.removeSource(id);
  }
}

function renderPanel() {
  const entries = Object.values(loadedAreas);
  if (!entries.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const total = { sun: 0, 'building-shade': 0, cloudy: 0, night: 0 };
  const areaRows = entries.map(({ area, sun, cloudCover, sunAvailable, sunIsUp, counts }) => {
    for (const k in counts) total[k] += counts[k];
    return `
      <div class="panel-area">
        <b>${area.label}</b> — ${sun.time.toLocaleTimeString('da-DK')}<br>
        Sun altitude: ${sun.altitudeDeg.toFixed(1)}° · Cloud cover: ${cloudCover == null ? 'unknown' : cloudCover.toFixed(0) + '%'}<br>
        ${sunAvailable ? 'Sun is out' : (sunIsUp ? 'Too cloudy' : 'Sun is down')}
      </div>`;
  }).join('');

  panel.innerHTML = `
    ${areaRows}
    <div id="legend">
      <span class="dot sun"></span>In sun (${total.sun})<br>
      <span class="dot shade"></span>Building shade (${total['building-shade']})<br>
      <span class="dot cloudy"></span>Cloudy (${total.cloudy})<br>
      <span class="dot night"></span>Night (${total.night})
    </div>
  `;
}

async function loadArea(areaId) {
  const area = AREAS[areaId];
  const bbox = area.bbox;
  const center = areaCenter(bbox);

  idlePrompt.hidden = true;
  if (pendingLoads === 0) resetLoadingSteps();
  pendingLoads++;

  map.fitBounds([[bbox.west, bbox.south], [bbox.east, bbox.north]], { padding: 40, pitch: 45, duration: 800 });
  setLoadingText(`Finding cafés, bars & restaurants in ${area.label}…`);

  let buildings, venues;
  try {
    const venuesPromise = fetchVenues(bbox).then(v => { markStepDone('venues'); return v; });
    const buildingsPromise = fetchBuildings(areaId, bbox).then(b => { markStepDone('buildings'); return b; });
    setLoadingText('Fetching venues & building shapes from OpenStreetMap…');
    [buildings, venues] = await Promise.all([buildingsPromise, venuesPromise]);
  } catch (err) {
    console.error('Failed to load OSM data', err);
    pendingLoads--;
    document.querySelector(`[data-area="${areaId}"]`).classList.remove('active');
    if (pendingLoads === 0) showLoadingError('Could not load map data from OpenStreetMap — the Overpass API may be busy.');
    return;
  }

  setLoadingText('Checking the sky over Copenhagen…');
  const cloudCover = await fetchCloudCover(center[1], center[0]);
  markStepDone('weather');
  const sun = getSunInfo(center[1], center[0]);

  setLoadingText('Tracing shadows…');

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
  markStepDone('shadows');

  addAreaLayers(areaId, buildings, venues);

  const counts = { sun: 0, 'building-shade': 0, cloudy: 0, night: 0 };
  for (const f of venues.features) counts[f.properties.state]++;

  loadedAreas[areaId] = { area, sun, cloudCover, sunAvailable, sunIsUp, counts };
  renderPanel();

  pendingLoads--;
  if (pendingLoads === 0) hideLoadingOverlay();
}

function unloadArea(areaId) {
  removeAreaLayers(areaId);
  delete loadedAreas[areaId];
  renderPanel();
  if (!Object.keys(loadedAreas).length && pendingLoads === 0) idlePrompt.hidden = false;
}

document.querySelectorAll('.area-box').forEach(box => {
  box.addEventListener('click', () => {
    const areaId = box.dataset.area;
    const turningOn = !box.classList.contains('active');
    box.classList.toggle('active', turningOn);
    if (turningOn) {
      loadArea(areaId);
    } else {
      unloadArea(areaId);
    }
  });
});
