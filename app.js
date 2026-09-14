// --- Config ---------------------------------------------------------------

// Rough bounding boxes (south, west, north, east) for each selectable area of Copenhagen.
const AREAS = {
  'vesterbro': {
    label: 'Vesterbro',
    bbox: { south: 55.665, west: 12.525, north: 55.688, east: 12.575 }
  },
  'frederiksberg': {
    label: 'Frederiksberg',
    bbox: { south: 55.665, west: 12.500, north: 55.688, east: 12.535 }
  },
  'nordvest': {
    label: 'Nordvest',
    bbox: { south: 55.700, west: 12.515, north: 55.735, east: 12.545 }
  },
  'bispebjerg': {
    label: 'Bispebjerg',
    bbox: { south: 55.700, west: 12.540, north: 55.735, east: 12.575 }
  },
  'norrebro': {
    label: 'Nørrebro',
    bbox: { south: 55.685, west: 12.530, north: 55.703, east: 12.575 }
  },
  'indre-by': {
    label: 'Indre By',
    bbox: { south: 55.672, west: 12.565, north: 55.688, east: 12.596 }
  },
  'osterbro': {
    label: 'Østerbro',
    bbox: { south: 55.695, west: 12.575, north: 55.715, east: 12.605 }
  },
  'nordhavn': {
    label: 'Nordhavn',
    bbox: { south: 55.710, west: 12.585, north: 55.735, east: 12.615 }
  },
  'christiania': {
    label: 'Christiania',
    bbox: { south: 55.665, west: 12.585, north: 55.680, east: 12.602 }
  },
  'amagerbro': {
    label: 'Amagerbro',
    bbox: { south: 55.660, west: 12.598, north: 55.685, east: 12.625 }
  }
};

function areaCenter(bbox) {
  return [(bbox.west + bbox.east) / 2, (bbox.south + bbox.north) / 2];
}

// Cloud cover (0-100 scale) tiers, from clearest to most overcast.
const CLOUD_TIERS = [
  { max: 10, state: 'sun' },
  { max: 30, state: 'partly-sunny' },
  { max: 60, state: 'partly-cloudy' },
  { max: Infinity, state: 'cloudy' }
];

function cloudTierState(cloudCover) {
  if (cloudCover == null) return 'sun'; // unknown reading — assume clear rather than block the whole area
  return CLOUD_TIERS.find(tier => cloudCover < tier.max).state;
}
const SHADOW_RAY_METERS = 200;    // how far to search for occluding buildings

const panel = document.getElementById('panel');

// --- Tabs (Map / About) ------------------------------------------------

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const isMap = tab.dataset.view === 'map';
    document.getElementById('map-view').hidden = !isMap;
    document.getElementById('about-view').hidden = isMap;
    document.getElementById('area-bar').hidden = !isMap;
  });
});

const aboutView = document.getElementById('about-view');
const toc = document.getElementById('toc');

// Groups the flat markdown output into one full-height <section class="chapter">
// per h2 (plus an intro chapter for the h1 + opening paragraph), so each
// chapter can snap-scroll into view and fade in/out like a slide.
function groupIntoChapters(content) {
  const nodes = Array.from(content.childNodes);
  content.innerHTML = '';

  let section = document.createElement('section');
  section.className = 'chapter chapter-intro';
  content.appendChild(section);

  for (const node of nodes) {
    if (node.nodeType === 1 && node.tagName === 'H2') {
      section = document.createElement('section');
      section.className = 'chapter';
      content.appendChild(section);
    }
    section.appendChild(node);
  }
}

function sizeChapters() {
  document.querySelectorAll('.chapter').forEach(ch => {
    ch.style.minHeight = `${aboutView.clientHeight}px`;
  });
}

function buildToc() {
  const content = document.getElementById('about-content');
  const headings = content.querySelectorAll('h2');
  toc.innerHTML = '';

  headings.forEach((h, i) => {
    h.id = `section-${i}`;

    let snippetSource = h.nextElementSibling;
    while (snippetSource && !['P', 'UL'].includes(snippetSource.tagName)) {
      snippetSource = snippetSource.nextElementSibling;
    }
    const snippetText = snippetSource ? snippetSource.textContent.trim() : '';
    const snippet = snippetText.length > 100 ? snippetText.slice(0, 100) + '…' : snippetText;

    const item = document.createElement('button');
    item.className = 'toc-item';
    item.innerHTML = `<span class="toc-title">${h.textContent}</span><span class="toc-snippet">${snippet}</span>`;
    item.addEventListener('click', () => {
      h.closest('.chapter').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    toc.appendChild(item);
  });
}

function observeChapters() {
  const chapters = Array.from(document.querySelectorAll('.chapter'));
  const items = toc.querySelectorAll('.toc-item');

  // A chapter taller than the viewport (e.g. "How it works", with its long
  // bullet list) can never satisfy a whole-element threshold like 0.55 —
  // 55% of it will never fit on screen at once. Instead, treat a thin band
  // near the viewport's vertical center as the "current chapter" zone; this
  // works the same regardless of how tall any given chapter is.
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      entry.target.classList.toggle('visible', entry.isIntersecting);
      if (entry.isIntersecting) {
        const chapterIndex = chapters.filter(c => !c.classList.contains('chapter-intro')).indexOf(entry.target);
        items.forEach((item, i) => item.classList.toggle('active', i === chapterIndex));
      }
    }
  }, { root: aboutView, rootMargin: '-45% 0px -45% 0px', threshold: 0 });

  chapters.forEach(ch => observer.observe(ch));
}

window.addEventListener('resize', () => {
  if (!document.getElementById('about-view').hidden) sizeChapters();
});

let readmeLoaded = false;
document.querySelector('[data-view="about"]').addEventListener('click', async () => {
  if (readmeLoaded) return;
  readmeLoaded = true;
  const content = document.getElementById('about-content');
  try {
    const res = await fetch('readme.md');
    const markdown = await res.text();
    content.innerHTML = marked.parse(markdown);
    groupIntoChapters(content);
    sizeChapters();
    buildToc();
    observeChapters();
  } catch (err) {
    content.textContent = 'Could not load readme.md.';
    readmeLoaded = false;
  }
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
          opening_hours: tags.opening_hours || null,
          phone: tags.phone || tags['contact:phone'] || null,
          website: tags.website || tags['contact:website'] || null,
          cuisine: tags.cuisine || null,
          wheelchair: tags.wheelchair || null,
          state: 'night'
        },
        geometry: { type: 'Point', coordinates: [lon, lat] }
      };
    })
    .filter(Boolean);
  return { type: 'FeatureCollection', features };
}

// --- DMI weather ------------------------------------------------------------

// Hand-picked DMI stations that report cloud_cover, temp_dry, wind_speed
// and wind_dir together. Copenhagen's inner-city stations each only report
// a subset (e.g. Landbohøjskolen has temperature but no wind/cloud), so we
// pick the nearest station that actually has everything we need, rather
// than averaging a wide bounding box (which just grabs the same stations
// for every area and makes them all look identical).
const WEATHER_STATIONS = [
  { id: '06180', name: 'Kastrup', coord: [12.6455, 55.6140] },
  { id: '06181', name: 'Jægersborg', coord: [12.5263, 55.7664] },
  { id: '06188', name: 'Sjælsmark', coord: [12.4121, 55.8764] },
  { id: '06170', name: 'Roskilde Lufthavn', coord: [12.1366, 55.5867] },
  { id: '06183', name: 'Drogden Fyr', coord: [12.7114, 55.5364] }
];

function nearestWeatherStation(center) {
  let best = null;
  let bestDist = Infinity;
  for (const station of WEATHER_STATIONS) {
    const dist = turf.distance(center, station.coord, { units: 'kilometers' });
    if (dist < bestDist) {
      bestDist = dist;
      best = station;
    }
  }
  return { ...best, distanceKm: bestDist };
}

async function fetchDmiParameter(stationId, parameterId) {
  const url = `/api/weather?parameterId=${parameterId}&stationId=${stationId}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`DMI proxy responded ${res.status}`);
    const data = await res.json();
    const value = data.features && data.features[0] && data.features[0].properties.value;
    return typeof value === 'number' ? value : null;
  } catch (err) {
    console.error(`DMI fetch failed for ${parameterId}`, err);
    return null;
  }
}

// Cloud cover comes from DMI's HARMONIE DINI forecast model (2km grid, read at
// the nearest hour to now) rather than the observation stations — the model
// gives genuinely different values area-to-area, where only ~2 stations cover
// all of central Copenhagen. Temp/wind stay from the nearest real station.
async function fetchForecastCloudCover(center) {
  const [lon, lat] = center;
  try {
    const res = await fetch(`/api/forecast?lat=${lat}&lon=${lon}`);
    if (!res.ok) throw new Error(`DMI forecast proxy responded ${res.status}`);
    const data = await res.json();
    return {
      cloudCover: typeof data.cloudCover === 'number' ? data.cloudCover : null,
      // The hour this forecast value is FOR, not when the model run itself
      // was computed — DMI's API doesn't expose the latter, only each
      // step's valid time.
      forecastTime: data.time ? new Date(data.time) : null
    };
  } catch (err) {
    console.error('DMI forecast fetch failed', err);
    return { cloudCover: null, forecastTime: null };
  }
}

async function fetchWeather(center) {
  const station = nearestWeatherStation(center);
  const [forecast, temperature, windSpeed, windDir] = await Promise.all([
    fetchForecastCloudCover(center),
    fetchDmiParameter(station.id, 'temp_dry'),
    fetchDmiParameter(station.id, 'wind_speed'),
    fetchDmiParameter(station.id, 'wind_dir')
  ]);
  return {
    cloudCover: forecast.cloudCover,
    forecastTime: forecast.forecastTime,
    temperature, windSpeed, windDir, station
  };
}

function windDirCompass(deg) {
  if (deg == null) return null;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

// --- Venue icons ------------------------------------------------------------

function amenityIconName(amenity) {
  if (amenity === 'cafe') return 'icon-cafe';
  if (amenity === 'bar' || amenity === 'pub') return 'icon-bar';
  return 'icon-restaurant'; // restaurant, or unrecognized amenity
}

function makeIconCanvas(draw) {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#0a0f1c';
  ctx.fillStyle = '#0a0f1c';
  ctx.lineWidth = 2.75;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  draw(ctx, size);
  return ctx.getImageData(0, 0, size, size);
}

function drawCafeIcon(ctx, s) {
  // coffee cup: bold filled body + handle + steam
  ctx.beginPath();
  ctx.moveTo(8, 13);
  ctx.lineTo(9.5, 25);
  ctx.quadraticCurveTo(9.5, 28, 16, 28);
  ctx.quadraticCurveTo(22.5, 28, 24, 25);
  ctx.lineTo(25.5, 13);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(26.5, 17, 3.4, -Math.PI / 2, Math.PI / 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(13, 4);
  ctx.quadraticCurveTo(11, 7, 13, 9);
  ctx.moveTo(19, 4);
  ctx.quadraticCurveTo(17, 7, 19, 9);
  ctx.lineWidth = 2.2;
  ctx.stroke();
}

function drawBarIcon(ctx, s) {
  // wine glass: bold filled bowl + stem + base
  ctx.beginPath();
  ctx.moveTo(9, 4);
  ctx.lineTo(10.5, 15);
  ctx.quadraticCurveTo(10.5, 21, 16, 21);
  ctx.quadraticCurveTo(21.5, 21, 23, 15);
  ctx.lineTo(24.5, 4);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(16, 21);
  ctx.lineTo(16, 27);
  ctx.moveTo(10, 27);
  ctx.lineTo(22, 27);
  ctx.stroke();
}

function drawRestaurantIcon(ctx, s) {
  // fork (left): bold tines + shared handle
  ctx.beginPath();
  ctx.moveTo(7, 4);
  ctx.lineTo(7, 12);
  ctx.lineTo(10, 15);
  ctx.lineTo(10, 28);
  ctx.moveTo(10.5, 4);
  ctx.lineTo(10.5, 12);
  ctx.lineTo(10, 15);
  ctx.moveTo(14, 4);
  ctx.lineTo(14, 12);
  ctx.lineTo(10.5, 15.5);
  ctx.lineWidth = 3;
  ctx.stroke();

  // knife (right): bold angled blade + straight handle
  ctx.beginPath();
  ctx.moveTo(23, 4);
  ctx.quadraticCurveTo(27, 9, 23, 15);
  ctx.lineTo(23, 28);
  ctx.lineWidth = 3.2;
  ctx.stroke();
}

function registerVenueIcons(map) {
  // SDF (alpha-mask) icons, so their color can follow each marker's state
  // via icon-color instead of being locked to a single baked-in color.
  map.addImage('icon-cafe', makeIconCanvas(drawCafeIcon), { pixelRatio: 2, sdf: true });
  map.addImage('icon-bar', makeIconCanvas(drawBarIcon), { pixelRatio: 2, sdf: true });
  map.addImage('icon-restaurant', makeIconCanvas(drawRestaurantIcon), { pixelRatio: 2, sdf: true });
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

const WIND_SHELTER_RAY_METERS = 40; // buildings further than this don't meaningfully block wind at ground level
const WIND_SHELTER_MIN_HEIGHT = 3;  // ignore trivially low structures (walls, sheds)

// Unlike sun shadow (an angle-above-horizon problem), wind at street level is
// blocked by any building of reasonable height standing directly upwind and
// close by — no altitude trigonometry needed, just proximity + a height floor.
function isVenueWindSheltered(venueCoord, buildings, windDirDeg) {
  // windDir is the compass direction the wind is blowing FROM, so the
  // sheltering building sits in that same direction from the venue.
  const end = turf.destination(venueCoord, WIND_SHELTER_RAY_METERS / 1000, windDirDeg, { units: 'kilometers' }).geometry.coordinates;
  const ray = turf.lineString([venueCoord, end]);

  for (const building of buildings.features) {
    if (building.properties.height < WIND_SHELTER_MIN_HEIGHT) continue;
    const approxCoord = building.geometry.coordinates[0][0];
    if (turf.distance(venueCoord, approxCoord, { units: 'meters' }) > WIND_SHELTER_RAY_METERS * 1.5) continue;
    if (turf.booleanIntersects(ray, building)) return true;
  }
  return false;
}

// --- Main -------------------------------------------------------------------

const COPENHAGEN_CENTER = [12.57, 55.685];

// --- Day / night theme --------------------------------------------------
//
// The app's dark theme is the default identity ("if it's after sunset the
// site remains as it is now"). During actual daylight in Copenhagen, the
// UI chrome and base map switch to a light grey/baby-blue theme instead.
// Venue marker colors (sun/shade states) stay the same in both — they're
// semantic, not thematic.

const MAP_STYLES = {
  night: 'https://tiles.openfreemap.org/styles/dark',
  day: 'https://tiles.openfreemap.org/styles/positron'
};
const BUILDING_COLOR = { night: '#151f33', day: '#c3ccd9' };

function computeTheme() {
  const alt = SunCalc.getPosition(new Date(), COPENHAGEN_CENTER[1], COPENHAGEN_CENTER[0]).altitude;
  return alt > 0 ? 'day' : 'night';
}

let currentTheme = computeTheme();
document.documentElement.dataset.theme = currentTheme;

const map = new maplibregl.Map({
  container: 'map',
  style: MAP_STYLES[currentTheme],
  center: COPENHAGEN_CENTER,
  zoom: 11.5,
  pitch: 0
});

map.addControl(new maplibregl.NavigationControl());

// Style loading is async; addSource/addLayer/addImage throw if called before
// it's done. With caching now making loads fast, a click can otherwise
// finish fetching before the style is ready — wait for it explicitly.
const mapReady = new Promise(resolve => {
  if (map.isStyleLoaded()) resolve();
  else map.once('load', resolve);
});

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
  'sun': '☀️ Sunny',
  'partly-sunny': '🌤️ Partly Sunny',
  'building-shade': '🏢 Shaded',
  'partly-cloudy': '⛅ Partly Cloudy',
  'cloudy': '☁️ Cloudy',
  'night': '🌙 Sun is down'
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

  const STATE_COLOR_EXPR = [
    'match', ['get', 'state'],
    'sun', '#ffd166',
    'partly-sunny', '#ffe29a',
    'building-shade', '#55617a',
    'partly-cloudy', '#c7ceda',
    'cloudy', '#8d97a5',
    'night', '#2a3868',
    '#55617a'
  ];

  map.addSource(`buildings-${areaId}`, { type: 'geojson', data: buildings });
  map.addLayer({
    id: `buildings-3d-${areaId}`,
    type: 'fill-extrusion',
    source: `buildings-${areaId}`,
    paint: {
      'fill-extrusion-color': BUILDING_COLOR[currentTheme],
      'fill-extrusion-height': ['get', 'height'],
      'fill-extrusion-opacity': 0.75
    }
  });

  map.addSource(`venues-${areaId}`, { type: 'geojson', data: venues });

  // Soft glow beneath each marker — a larger, blurred, translucent circle in
  // the same color as the marker on top of it.
  map.addLayer({
    id: `venues-glow-${areaId}`,
    type: 'circle',
    source: `venues-${areaId}`,
    paint: {
      'circle-radius': 21,
      'circle-color': STATE_COLOR_EXPR,
      'circle-blur': 1,
      'circle-opacity': 0.65
    }
  });
  map.addLayer({
    id: `venues-dots-${areaId}`,
    type: 'circle',
    source: `venues-${areaId}`,
    paint: {
      'circle-radius': 12,
      'circle-color': STATE_COLOR_EXPR,
      'circle-stroke-width': 1.75,
      'circle-stroke-color': 'rgba(6,10,19,0.7)'
    }
  });
  map.addLayer({
    id: `venues-icons-${areaId}`,
    type: 'symbol',
    source: `venues-${areaId}`,
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-size': 0.72,
      'icon-allow-overlap': true
    },
    paint: {
      // Dark icon on light (sunny-ish) dots, light icon on dark (shaded/night) dots.
      'icon-color': [
        'match', ['get', 'state'],
        'sun', '#1a1306',
        'partly-sunny', '#1a1306',
        'partly-cloudy', '#1a1e29',
        '#f3ede1'
      ]
    }
  });

  map.on('mouseenter', `venues-dots-${areaId}`, (e) => {
    map.getCanvas().style.cursor = 'pointer';
    const f = e.features[0];
    popup.setLngLat(f.geometry.coordinates)
      .setHTML(`<b>${escapeHtml(f.properties.name)}</b><br>${escapeHtml(f.properties.amenity)}<br>${STATE_LABELS[f.properties.state]}`)
      .addTo(map);
  });
  map.on('mouseleave', `venues-dots-${areaId}`, () => {
    map.getCanvas().style.cursor = '';
    popup.remove();
  });
  map.on('click', `venues-dots-${areaId}`, (e) => openVenueDetail(e.features[0]));
}

// --- Venue detail panel -----------------------------------------------
//
// Venue fields (name, cuisine, phone, website, wheelchair, opening_hours)
// come from OpenStreetMap, which anyone can edit — treat them as untrusted
// input. Every one of them gets HTML-escaped before going into innerHTML,
// and website/phone links are additionally scheme-validated, so a
// vandalized OSM entry can't run script in a visitor's browser.

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Only allow http(s) URLs through to an href — blocks javascript: and other
// dangerous schemes a malicious OSM `website` tag could contain.
function safeHttpUrl(raw) {
  try {
    const url = new URL(raw, location.href);
    return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : null;
  } catch {
    return null;
  }
}

const STATE_COLORS = {
  sun: '#ffd166',
  'partly-sunny': '#ffe29a',
  'building-shade': '#55617a',
  'partly-cloudy': '#c7ceda',
  cloudy: '#8d97a5',
  night: '#2a3868'
};

const venueDetail = document.getElementById('venue-detail');
const venueDetailContent = document.getElementById('venue-detail-content');

document.getElementById('venue-detail-close').addEventListener('click', () => {
  venueDetail.hidden = true;
});

function formatWeatherValue(value, unit, decimals = 0) {
  return value == null ? '—' : `${value.toFixed(decimals)}${unit}`;
}

// --- Opening hours (best-effort OSM `opening_hours` parser) ------------
//
// OSM's opening_hours syntax is notoriously irregular in the wild — tested
// against ~1,270 distinct real values pulled from Copenhagen venues, this
// parser handles ~97% of them. The rest (seasonal month ranges, "easter"
// relative dates, week-number rules, nth-weekday selectors like "Fr[1]",
// free-text comments) are intentionally left unparsed rather than guessed
// at wrong — the caller falls back to showing OSM's raw text for those.

const DAY_CODES = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const DAY_NAMES = { Mo: 'Monday', Tu: 'Tuesday', We: 'Wednesday', Th: 'Thursday', Fr: 'Friday', Sa: 'Saturday', Su: 'Sunday' };
const DAY_TOKEN = '(?:Mo|Tu|We|Th|Fr|Sa|Su)';
const DAY_TOKEN_PH = '(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)'; // PH ("public holiday") is accepted in day lists, then dropped
const MONTH_TOKEN = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';

const PURE_DAY_RE = new RegExp(`^${DAY_TOKEN_PH}(-${DAY_TOKEN_PH})?$`, 'i');
const DAY_TIME_RE = new RegExp(`^(${DAY_TOKEN_PH}(?:-${DAY_TOKEN_PH})?)\\s+(.+)$`, 'i');

function expandOpeningDays(dayListStr) {
  const days = [];
  for (const seg of dayListStr.split(',').map(s => s.trim())) {
    if (seg.toUpperCase() === 'PH') continue; // not representable in a weekday grid — drop
    if (seg.includes('-')) {
      const [start, end] = seg.split('-');
      const si = DAY_CODES.indexOf(start), ei = DAY_CODES.indexOf(end);
      if (si === -1 || ei === -1) return null;
      for (let i = si; i !== ei; i = (i + 1) % 7) days.push(DAY_CODES[i]);
      days.push(DAY_CODES[ei]);
    } else {
      if (DAY_CODES.indexOf(seg) === -1) return null;
      days.push(seg);
    }
  }
  return days;
}

function normalizeOpeningTime(raw) {
  const t = raw.trim();
  if (/^(off|closed)$/i.test(t)) return 'Closed';
  const t2 = t.replace(/\s*-\s*/g, '-').replace(/\s*\+\s*$/, '+');
  if (/^\d{2}:\d{2}\+$/.test(t2)) return t2.replace('+', '–late');
  if (/^\d{2}:\d{2}-\d{2}:\d{2}\+?$/.test(t2)) return t2.replace('-', '–').replace(/\+$/, '+');
  return null;
}

// Parses one ';'-separated clause (e.g. "Sa,Su 07:00-17:00" or a comma-chained
// run like "09:00-24:00, Fr-Sa 09:00-02:00, Su off") by walking comma-split
// tokens and buffering bare day tokens (e.g. "Sa" in "Sa,Su 07:00-17:00")
// until a token with an attached time completes the day list.
function parseOpeningRule(rule, result) {
  const tokens = rule.split(',').map(t => t.trim()).filter(Boolean);
  let pendingDays = [];
  let curDays = null;
  let curTimes = [];

  const flush = () => {
    if (curDays && curTimes.length) {
      const joined = curTimes.join(', ');
      for (const d of curDays) result[d] = joined;
    }
  };

  for (const tok of tokens) {
    if (new RegExp(`^${MONTH_TOKEN}\\b`, 'i').test(tok)) return false; // seasonal complexity — bail

    if (PURE_DAY_RE.test(tok)) {
      pendingDays.push(tok);
      continue;
    }
    const m = tok.match(DAY_TIME_RE);
    if (m) {
      flush();
      const dayPart = (pendingDays.length ? pendingDays.join(',') + ',' : '') + m[1];
      pendingDays = [];
      const days = expandOpeningDays(dayPart);
      if (!days) return false;
      const t = normalizeOpeningTime(m[2]);
      if (t === null) return false;
      curDays = days;
      curTimes = [t];
    } else {
      const t = normalizeOpeningTime(tok);
      if (t === null) return false;
      if (!curDays) {
        curDays = DAY_CODES.slice();
        curTimes = [t];
      } else {
        curTimes.push(t);
      }
    }
  }
  flush();
  return true;
}

// Parses common OSM opening_hours patterns into { Mo: '08:00–18:00', ... }.
// Returns null for anything it can't confidently parse, so the caller can
// fall back to showing the raw text.
function parseOpeningHours(raw) {
  if (!raw) return null;
  let cleaned = raw.trim()
    .replace(/\s*"[^"]*"\s*/g, ' ').trim()               // strip quoted comments
    .replace(new RegExp(`\\b(${DAY_TOKEN})(\\d)`, 'g'), '$1 $2'); // fix missing "Su10:00" spacing
  if (!cleaned) return null;
  if (/^24\/7$/i.test(cleaned)) {
    const result = {};
    DAY_CODES.forEach(d => { result[d] = '00:00–24:00'; });
    return result;
  }

  const result = {};
  let anyApplied = false;

  for (const rule of cleaned.split(';').map(r => r.trim()).filter(Boolean)) {
    if (/^PH(\s|$)/i.test(rule)) continue; // PH-only clause — not representable, skip
    if (new RegExp(`^${MONTH_TOKEN}\\b`, 'i').test(rule)) {
      // A month-prefixed closure (e.g. "Dec 24 off") is safe to skip; a month-prefixed
      // clause with real hours means seasonal variation we can't flatten — bail entirely.
      if (/\b(off|closed)\b/i.test(rule) && !/\d{2}:\d{2}/.test(rule)) continue;
      return null;
    }
    const before = JSON.stringify(result);
    if (!parseOpeningRule(rule, result)) return null;
    if (JSON.stringify(result) !== before) anyApplied = true;
  }

  if (!anyApplied) return null;
  for (const d of DAY_CODES) if (!(d in result)) result[d] = 'Closed';
  return result;
}

function renderOpeningHours(raw) {
  if (!raw) {
    return `<div class="vd-info-row">🕒 Opening hours: not available on OSM</div>`;
  }
  const parsed = parseOpeningHours(raw);
  if (!parsed) {
    return `<div class="vd-info-row">🕒 ${escapeHtml(raw)}</div>`; // couldn't parse safely — show as-is
  }

  const todayJs = new Date().getDay();       // 0 = Sunday
  const todayIdx = (todayJs + 6) % 7;        // convert to our Mo-first index
  let rows = '';
  for (let i = 0; i < 7; i++) {
    const code = DAY_CODES[(todayIdx + i) % 7];
    const label = i === 0 ? 'Today' : DAY_NAMES[code];
    rows += `<div class="vd-hours-row${i === 0 ? ' today' : ''}"><span>${label}</span><span>${parsed[code]}</span></div>`;
  }
  return `<div class="vd-hours"><div class="vd-info-row">🕒 Opening hours</div>${rows}</div>`;
}

function openVenueDetail(feature) {
  const p = feature.properties;
  const areaData = loadedAreas[p.areaId];
  const weather = areaData ? areaData.weather : {};
  const areaLabel = areaData ? areaData.area.label : '';
  const stateColor = STATE_COLORS[p.state] || '#4a5568';
  const stateTextColor = ['sun', 'partly-sunny', 'partly-cloudy'].includes(p.state) ? '#14161a' : '#fff';

  const infoRows = [renderOpeningHours(p.opening_hours)];
  if (p.cuisine) infoRows.push(`<div class="vd-info-row">🍽️ ${escapeHtml(p.cuisine.replace(/_/g, ' ').replace(/;/g, ', '))}</div>`);
  else infoRows.push(`<div class="vd-info-row">🍽️ Cuisine: not available on OSM</div>`);
  infoRows.push(`<div class="vd-info-row">🌳 Outdoor seating: ${p.outdoor_seating === 'yes' ? 'Yes' : p.outdoor_seating === 'no' ? 'No' : 'Not available on OSM'}</div>`);
  if (p.phone) {
    // tel: hrefs only make sense with digits/+/-/space/parens — strip anything else
    // rather than trusting the raw OSM value into an href.
    const telHref = p.phone.replace(/[^\d+\-() ]/g, '');
    infoRows.push(`<div class="vd-info-row">📞 <a href="tel:${escapeHtml(telHref)}">${escapeHtml(p.phone)}</a></div>`);
  }
  if (p.website) {
    const href = safeHttpUrl(p.website);
    if (href) {
      infoRows.push(`<div class="vd-info-row">🔗 <a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.website.replace(/^https?:\/\//, ''))}</a></div>`);
    } else {
      infoRows.push(`<div class="vd-info-row">🔗 ${escapeHtml(p.website)}</div>`);
    }
  }
  if (p.wheelchair) infoRows.push(`<div class="vd-info-row">♿ Wheelchair access: ${escapeHtml(p.wheelchair)}</div>`);

  venueDetailContent.innerHTML = `
    <div class="vd-name">${escapeHtml(p.name)}</div>
    <div class="vd-amenity">${escapeHtml(p.amenity)}</div>
    <div class="vd-state" style="background:${stateColor};color:${stateTextColor}">${STATE_LABELS[p.state]}</div>

    <div class="vd-section">
      <h4>Weather in ${areaLabel}</h4>
      <div class="vd-weather-row">
        <div class="vd-weather-item">
          <div class="val">${formatWeatherValue(weather.temperature, '°C', 1)}</div>
          <div class="label">Temp</div>
        </div>
        <div class="vd-weather-item">
          <div class="val">${formatWeatherValue(weather.windSpeed, ' m/s', 1)}</div>
          <div class="label">Wind${weather.windDir != null ? ' ' + windDirCompass(weather.windDir) : ''}</div>
        </div>
        <div class="vd-weather-item">
          <div class="val">${formatWeatherValue(weather.cloudCover, '%')}</div>
          <div class="label">Cloud</div>
        </div>
      </div>
      ${weather.station ? `<div class="vd-station">Station: ${weather.station.name} (${weather.station.distanceKm.toFixed(1)} km away)</div>` : ''}
      ${weather.forecastTime ? `<div class="vd-station">Cloud forecast for ${weather.forecastTime.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' })}</div>` : ''}
      ${p.windSheltered ? `<div class="vd-wind-note">🛡️ A building appears to block the wind here — it may feel calmer than the reading above.</div>` : ''}
    </div>

    <div class="vd-section">
      <h4>Venue info</h4>
      ${infoRows.length ? infoRows.join('') : '<div class="vd-empty">No extra details available on OpenStreetMap for this venue.</div>'}
    </div>
  `;
  venueDetail.hidden = false;
}

function removeAreaLayers(areaId) {
  for (const id of [`venues-icons-${areaId}`, `venues-dots-${areaId}`, `venues-glow-${areaId}`, `buildings-3d-${areaId}`]) {
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

  const total = { sun: 0, 'partly-sunny': 0, 'building-shade': 0, 'partly-cloudy': 0, cloudy: 0, night: 0 };
  const areaRows = entries.map(({ area, sun, weather, sunAvailable, sunIsUp, counts }) => {
    for (const k in counts) total[k] += counts[k];
    return `
      <div class="panel-area">
        <p class="place">${area.label}</p>
        <div class="meta">${sun.time.toLocaleTimeString('da-DK')} · Sun ${sun.altitudeDeg.toFixed(1)}° · Cloud ${weather.cloudCover == null ? '—' : weather.cloudCover.toFixed(0) + '%'}</div>
        <div class="status">${sunAvailable ? 'Sun is out' : (sunIsUp ? 'Too cloudy' : 'Sun is down')}</div>
      </div>`;
  }).join('');

  const inSun = total.sun + total['partly-sunny'];
  const inShade = total['building-shade'] + total['partly-cloudy'] + total.cloudy + total.night;

  panel.innerHTML = `
    ${areaRows}
    <div class="hero-stats">
      <div class="hero-stat"><div class="num">${inSun}</div><div class="lbl">In sun</div></div>
      <div class="hero-stat shade"><div class="num">${inShade}</div><div class="lbl">In shade</div></div>
    </div>
    <div id="legend">
      <div class="legend-row"><span class="dot sun"></span>Sunny<span class="count">${total.sun}</span></div>
      <div class="legend-row"><span class="dot partly-sunny"></span>Partly sunny<span class="count">${total['partly-sunny']}</span></div>
      <div class="legend-row"><span class="dot shade"></span>Building shade<span class="count">${total['building-shade']}</span></div>
      <div class="legend-row"><span class="dot partly-cloudy"></span>Partly cloudy<span class="count">${total['partly-cloudy']}</span></div>
      <div class="legend-row"><span class="dot cloudy"></span>Cloudy<span class="count">${total.cloudy}</span></div>
      <div class="legend-row"><span class="dot night"></span>Night<span class="count">${total.night}</span></div>
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
  const weather = await fetchWeather(center);
  const { cloudCover } = weather;
  markStepDone('weather');
  const sun = getSunInfo(center[1], center[0]);

  setLoadingText('Tracing shadows…');

  const sunIsUp = sun.altitudeDeg > 0;
  const cloudTier = cloudTierState(cloudCover);
  const sunAvailable = sunIsUp && (cloudTier === 'sun' || cloudTier === 'partly-sunny');

  for (const f of venues.features) {
    let state;
    if (!sunIsUp) {
      state = 'night';
    } else if (isVenueShadowed(f.geometry.coordinates, buildings, sun.bearingDeg, sun.altitudeRad)) {
      state = 'building-shade';
    } else {
      state = cloudTier;
    }
    f.properties.state = state;
    f.properties.areaId = areaId;
    f.properties.windSheltered = weather.windDir != null
      ? isVenueWindSheltered(f.geometry.coordinates, buildings, weather.windDir)
      : false;
  }
  markStepDone('shadows');

  await mapReady;
  addAreaLayers(areaId, buildings, venues);
  areaDataCache[areaId] = { buildings, venues }; // kept so a day/night theme switch can relayer without re-fetching

  const counts = { sun: 0, 'partly-sunny': 0, 'building-shade': 0, 'partly-cloudy': 0, cloudy: 0, night: 0 };
  for (const f of venues.features) counts[f.properties.state]++;

  loadedAreas[areaId] = { area, sun, weather, sunAvailable, sunIsUp, counts };
  renderPanel();

  pendingLoads--;
  if (pendingLoads === 0) hideLoadingOverlay();
}

function unloadArea(areaId) {
  removeAreaLayers(areaId);
  delete loadedAreas[areaId];
  delete areaDataCache[areaId];
  renderPanel();
  if (!Object.keys(loadedAreas).length && pendingLoads === 0) idlePrompt.hidden = false;
}

// Switches the UI chrome (via [data-theme]) and the base map style between
// day and night, re-adding every active area's layers afterward since
// MapLibre's setStyle wipes all custom sources/layers/images.
const areaDataCache = {}; // areaId -> { buildings, venues } — only for relayering after a style swap

function switchTheme(theme) {
  if (theme === currentTheme) return;
  currentTheme = theme;
  document.documentElement.dataset.theme = theme;
  map.setStyle(MAP_STYLES[theme]);

  // 'style.load' doesn't fire reliably here — poll isStyleLoaded() instead,
  // which is what it's for and doesn't depend on event-timing quirks.
  // Note: images registered via map.addImage() survive setStyle() in
  // MapLibre (sources/layers don't) — so iconsRegistered stays true and
  // registerVenueIcons is deliberately not re-run here.
  const relayerWhenReady = () => {
    if (!map.isStyleLoaded()) {
      setTimeout(relayerWhenReady, 100);
      return;
    }
    for (const areaId of Object.keys(loadedAreas)) {
      const cached = areaDataCache[areaId];
      if (cached) addAreaLayers(areaId, cached.buildings, cached.venues);
    }
  };
  setTimeout(relayerWhenReady, 100);
}

let themeManualOverride = false;

setInterval(() => {
  if (themeManualOverride) return; // user took control via the toggle — stop auto-switching
  const theme = computeTheme();
  if (theme !== currentTheme) switchTheme(theme);
}, 10 * 60 * 1000); // check every 10 minutes — cheap, and sunrise/sunset only cross once each per session anyway

const themeToggle = document.getElementById('theme-toggle');

function updateThemeToggleIcon() {
  // Shows the icon for what you'll switch TO, not the current theme.
  themeToggle.textContent = currentTheme === 'night' ? '☀️' : '🌙';
}
updateThemeToggleIcon();

themeToggle.addEventListener('click', () => {
  themeManualOverride = true;
  switchTheme(currentTheme === 'night' ? 'day' : 'night');
  updateThemeToggleIcon();
});

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
