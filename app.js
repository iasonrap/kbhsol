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

// Cloud cover (0-100, Yr's cloud_area_fraction) tiers, clearest to most overcast.
const CLOUD_TIERS = [
  { max: 10, state: 'sun' },
  { max: 30, state: 'partly-sunny' },
  { max: 60, state: 'partly-cloudy' },
  { max: Infinity, state: 'cloudy' }
];

function cloudTierState(cloudCover) {
  // A missing reading must never look like clear sky. Show it as "unknown".
  if (cloudCover == null) return 'unknown';
  return CLOUD_TIERS.find(tier => cloudCover < tier.max).state;
}
const SHADOW_RAY_METERS = 200;    // how far to search for occluding buildings

const panel = document.getElementById('panel');
const panelContent = document.getElementById('panel-content');
const panelToggle = document.getElementById('panel-toggle');

// Lives outside renderPanel()'s innerHTML, which is rewritten on every load.
panelToggle.addEventListener('click', () => {
  const collapsed = panel.classList.toggle('collapsed');
  panelToggle.textContent = collapsed ? '›' : '‹';
  panelToggle.setAttribute('aria-label', collapsed ? 'Expand panel' : 'Collapse panel');
});

// --- Tabs (Map / About / Track) -----------------------------------------

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const view = tab.dataset.view;
    document.getElementById('map-view').hidden = view !== 'map';
    document.getElementById('about-view').hidden = view !== 'about';
    document.getElementById('track-view').hidden = view !== 'track';
    document.getElementById('area-select').hidden = view !== 'map';
    if (view === 'track') loadTrackData();
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

// --- Track tab (API request log + charts) --------------------------------
// Visualises data/api_log.jsonl (every proxied call, hit or miss), so cache
// behaviour and accidental upstream spam are visible.

const TRACK_PALETTE = ['#ffd166', '#5e96e0', '#c76dd6', '#4caf7d', '#e0955e', '#7ad1c9', '#e05d8d', '#a3a86c'];

let trackEntries = null;
let trackGranularity = 'hour';

document.querySelectorAll('.track-gran-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.track-gran-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    trackGranularity = btn.dataset.granularity;
    if (trackEntries) renderTrackView(trackEntries);
  });
});

document.getElementById('track-refresh').addEventListener('click', () => loadTrackData(true));

async function loadTrackData(forceRefresh = false) {
  if (trackEntries && !forceRefresh) return;
  const refreshBtn = document.getElementById('track-refresh');
  refreshBtn.classList.add('spinning');
  try {
    const res = await fetch('/api/logs?limit=8000');
    if (!res.ok) throw new Error(`log fetch responded ${res.status}`);
    const data = await res.json();
    trackEntries = data.entries || [];
    renderTrackView(trackEntries);
  } catch (err) {
    console.error('Failed to load API log', err);
    document.getElementById('track-summary').innerHTML =
      `<div class="track-stat bad"><div class="n">—</div><div class="l">Could not load the request log</div></div>`;
  } finally {
    refreshBtn.classList.remove('spinning');
  }
}

function buildTrackBuckets(granularity) {
  const buckets = [];
  const now = new Date();
  if (granularity === 'hour') {
    now.setMinutes(0, 0, 0);
    for (let i = 23; i >= 0; i--) {
      const start = new Date(now.getTime() - i * 3600 * 1000);
      buckets.push({ start, label: start.getHours().toString().padStart(2, '0') + ':00' });
    }
    return { buckets, bucketMs: 3600 * 1000 };
  }
  now.setHours(0, 0, 0, 0);
  for (let i = 13; i >= 0; i--) {
    const start = new Date(now.getTime() - i * 86400 * 1000);
    buckets.push({ start, label: start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) });
  }
  return { buckets, bucketMs: 86400 * 1000 };
}

function renderTrackView(entries) {
  const { buckets, bucketMs } = buildTrackBuckets(trackGranularity);
  renderTrackSummary(entries);

  renderTrackChart('chart-overpass', 'legend-overpass', entries, buckets, bucketMs, {
    filterKind: 'overpass',
    groupKey: e => e.areaId || 'unknown',
    groupLabel: g => (AREAS[g] && AREAS[g].label) || g
  });
  renderTrackChart('chart-forecast', 'legend-forecast', entries, buckets, bucketMs, {
    filterKind: 'weather',
    groupKey: e => e.cell || 'unknown',
    groupLabel: g => g
  });
  // Radar has no per-cell concept like weather does (one composite covers
  // all of Denmark, see fetchVenuePrecipitation) — grouped by cache status
  // instead, which is the more useful dimension here anyway: how often a
  // 15-minute-cached radar fetch was a HIT vs. a real upstream MISS/STALE.
  renderTrackChart('chart-radar', 'legend-radar', entries, buckets, bucketMs, {
    filterKind: 'radar',
    groupKey: e => e.cache || 'unknown',
    groupLabel: g => g
  });

  renderTrackLogTable(entries);
}

function renderTrackSummary(entries) {
  const total = entries.length;
  const upstream = entries.filter(e => e.cache === 'MISS' || e.cache === 'STALE' || e.cache === 'ERROR').length;
  const hits = entries.filter(e => e.cache === 'HIT').length;
  const errors = entries.filter(e => e.cache === 'ERROR').length;
  const hitRate = total ? Math.round((hits / total) * 100) : 0;

  document.getElementById('track-summary').innerHTML = `
    <div class="track-stat"><div class="n">${total}</div><div class="l">Total requests logged</div></div>
    <div class="track-stat good"><div class="n">${hits}</div><div class="l">Cache hits (no upstream call)</div></div>
    <div class="track-stat warn"><div class="n">${upstream}</div><div class="l">Real upstream calls</div></div>
    <div class="track-stat ${hitRate >= 50 ? 'good' : 'warn'}"><div class="n">${hitRate}%</div><div class="l">Cache hit rate</div></div>
    <div class="track-stat ${errors ? 'bad' : ''}"><div class="n">${errors}</div><div class="l">Upstream errors</div></div>
  `;
}

function renderTrackChart(chartElId, legendElId, entries, buckets, bucketMs, { filterKind, groupKey, groupLabel, topN = 6 }) {
  const chartEl = document.getElementById(chartElId);
  const legendEl = document.getElementById(legendElId);
  const filtered = entries.filter(e => e.kind === filterKind);

  if (!filtered.length) {
    chartEl.innerHTML = '<div class="track-empty">No requests logged yet</div>';
    legendEl.innerHTML = '';
    return;
  }

  const totals = new Map();
  for (const e of filtered) {
    const g = groupKey(e);
    totals.set(g, (totals.get(g) || 0) + 1);
  }
  const sortedGroups = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const keepGroups = sortedGroups.slice(0, topN).map(([g]) => g);
  const overflow = sortedGroups.slice(topN);
  const hasOther = overflow.length > 0;
  const resolveGroup = g => (keepGroups.includes(g) ? g : 'Other');

  const bucketStart0 = buckets[0].start.getTime();
  const matrix = buckets.map(() => new Map());
  for (const e of filtered) {
    const t = new Date(e.ts).getTime();
    const idx = Math.floor((t - bucketStart0) / bucketMs);
    if (idx < 0 || idx >= buckets.length) continue;
    const g = resolveGroup(groupKey(e));
    matrix[idx].set(g, (matrix[idx].get(g) || 0) + 1);
  }

  const displayGroups = hasOther ? [...keepGroups, 'Other'] : keepGroups;
  const colors = displayGroups.map((g, i) => (g === 'Other' ? '#7a8496' : TRACK_PALETTE[i % TRACK_PALETTE.length]));

  renderStackedBarSVG(chartEl, buckets, matrix, displayGroups, colors);

  const otherTotal = overflow.reduce((s, [, c]) => s + c, 0);
  legendEl.innerHTML = displayGroups.map((g, i) => {
    const count = g === 'Other' ? otherTotal : totals.get(g);
    const label = g === 'Other' ? `Other (${overflow.length})` : escapeHtml(groupLabel(g));
    return `<span class="track-legend-item"><span class="track-legend-swatch" style="background:${colors[i]}"></span>${label}: ${count}</span>`;
  }).join('');
}

function renderStackedBarSVG(container, buckets, matrix, groups, colors) {
  const W = 600, H = 170, padBottom = 20;
  const chartH = H - padBottom - 6;
  const maxTotal = Math.max(1, ...matrix.map(m => groups.reduce((s, g) => s + (m.get(g) || 0), 0)));
  const barSlot = W / buckets.length;
  const barW = Math.max(2, barSlot * 0.62);

  let bars = '';
  buckets.forEach((b, i) => {
    const m = matrix[i];
    let y = H - padBottom;
    const x = i * barSlot + (barSlot - barW) / 2;
    groups.forEach((g, gi) => {
      const v = m.get(g) || 0;
      if (v <= 0) return;
      const h = (v / maxTotal) * chartH;
      y -= h;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${colors[gi]}" rx="1.5"><title>${escapeHtml(b.label)} · ${escapeHtml(String(g))}: ${v}</title></rect>`;
    });
  });

  const labelEvery = Math.max(1, Math.ceil(buckets.length / 8));
  let labels = '';
  buckets.forEach((b, i) => {
    if (i % labelEvery !== 0 && i !== buckets.length - 1) return;
    const x = i * barSlot + barSlot / 2;
    labels += `<text x="${x.toFixed(1)}" y="${H - 5}" text-anchor="middle" font-size="9" style="fill:var(--ink-dim)">${escapeHtml(b.label)}</text>`;
  });

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:170px;display:block;overflow:visible;">
    <line x1="0" y1="${H - padBottom}" x2="${W}" y2="${H - padBottom}" style="stroke:var(--line)" stroke-width="1"/>
    ${bars}
    ${labels}
  </svg>`;
}

function renderTrackLogTable(entries) {
  const tbody = document.querySelector('#track-log-table tbody');
  const recent = entries.slice(-300).reverse();
  if (!recent.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--ink-dim);text-align:center;padding:24px;">No requests logged yet</td></tr>`;
    return;
  }

  const KIND_LABELS = { overpass: 'Overpass', weather: 'Weather', radar: 'Radar' };
  tbody.innerHTML = recent.map(e => {
    const time = new Date(e.ts).toLocaleString('da-DK', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    let detail = '';
    if (e.kind === 'overpass') {
      const label = (AREAS[e.areaId] && AREAS[e.areaId].label) || e.areaId || '—';
      detail = `${escapeHtml(label)} · ${escapeHtml(e.requestKind || '')}`;
    } else if (e.kind === 'weather') {
      detail = `tile ${escapeHtml(e.cell || '—')}`;
    } else if (e.kind === 'radar') {
      detail = `${escapeHtml(String(e.points ?? '—'))} points`;
    }
    const cache = escapeHtml(e.cache || '');
    return `<tr>
      <td>${escapeHtml(time)}</td>
      <td>${KIND_LABELS[e.kind] || escapeHtml(e.kind)}</td>
      <td>${detail}</td>
      <td><span class="track-cache-badge ${cache}">${cache}</span></td>
    </tr>`;
  }).join('');
}

// --- Overpass fetch ---------------------------------------------------------

function bboxStr(bbox) {
  return `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
}

// Overpass and Yr requests go through our own tiny local proxy (server.py),
// which caches responses to disk under data/ — so clicking areas on/off
// repeatedly doesn't re-hit the public APIs each time.
async function fetchOverpass(query, areaId, kind) {
  // areaId/kind are only for the Track tab's request log — appended as query
  // params rather than folded into the POST body, so they can't affect the
  // cache key (which is the raw query text only).
  const url = `/api/overpass?areaId=${encodeURIComponent(areaId)}&kind=${encodeURIComponent(kind)}`;
  const res = await fetch(url, { method: 'POST', body: query });
  if (!res.ok) {
    const err = new Error(`Overpass proxy responded ${res.status}`);
    // A 429 here is our OWN server's rate limiter, not Overpass itself —
    // confirmed as a real, confusing case live: loading several areas in
    // quick succession (a normal way to use a multi-select area picker)
    // exhausted the shared api budget, and every subsequent area's load
    // failed with "Overpass API may be busy," which is simply untrue and
    // points the user at the wrong system entirely. Tag it so the caller
    // can say what's actually happening.
    err.ownRateLimit = res.status === 429;
    throw err;
  }
  return res.json();
}

async function fetchBuildings(areaId, bbox) {
  const query = `
    [out:json][timeout:60];
    way["building"](${bboxStr(bbox)});
    out geom;
  `;
  const data = await fetchOverpass(query, areaId, 'buildings');
  return overpassBuildingsToGeoJSON(data);
}

async function fetchVenues(areaId, bbox) {
  const query = `
    [out:json][timeout:25];
    (
      node["amenity"~"^(cafe|bar|restaurant|pub)$"](${bboxStr(bbox)});
      way["amenity"~"^(cafe|bar|restaurant|pub)$"](${bboxStr(bbox)});
    );
    out center;
  `;
  const data = await fetchOverpass(query, areaId, 'venues');
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

// --- Yr (MET Norway) weather -------------------------------------------

// Must match server.py's WEATHER_GRID_*_STEP (no shared config). Snapping here
// means one fetch per distinct cell, not one per venue.
const WEATHER_GRID_LAT_STEP = 0.018;
const WEATHER_GRID_LON_STEP = 0.032;

function weatherGridCell(lon, lat) {
  const snappedLat = Math.round(lat / WEATHER_GRID_LAT_STEP) * WEATHER_GRID_LAT_STEP;
  const snappedLon = Math.round(lon / WEATHER_GRID_LON_STEP) * WEATHER_GRID_LON_STEP;
  return { key: `${snappedLat.toFixed(4)},${snappedLon.toFixed(4)}`, lat: snappedLat, lon: snappedLon };
}

// Timeline steps, -10 to +50 min. Must match RADAR_NOWCAST_OFFSETS_MINUTES in server.py.
const TIMELINE_OFFSETS_MINUTES = [];
for (let m = -10; m <= 50; m += 5) TIMELINE_OFFSETS_MINUTES.push(m);

async function fetchYrWeather(cell) {
  const emptyStep = offset => ({
    offsetMinutes: offset, temperature: null, windSpeed: null, windDir: null,
    cloudCover: null, symbolCode: null, time: null
  });
  try {
    const res = await fetch(`/api/weather?lat=${cell.lat}&lon=${cell.lon}`);
    if (!res.ok) throw new Error(`Yr weather proxy responded ${res.status}`);
    const data = await res.json();
    const steps = (data.steps || []).map(s => ({
      offsetMinutes: s.offsetMinutes,
      temperature: typeof s.temperature === 'number' ? s.temperature : null,
      windSpeed: typeof s.windSpeed === 'number' ? s.windSpeed : null,
      windDir: typeof s.windDir === 'number' ? s.windDir : null,
      cloudCover: typeof s.cloudCover === 'number' ? s.cloudCover : null,
      // Yr's own "how sunny does this look" classification (e.g.
      // "clearsky_day"/"partlycloudy_day"/"cloudy") — not used to drive the
      // sun/shade tiering (cloudCover does that, same proven thresholds as
      // before), but shown alongside it as a nice human-readable label MET
      // Norway's forecasters already tuned, rather than us reinventing one.
      symbolCode: s.symbolCode || null,
      // The timeseries entry this step is FOR, not when we fetched it —
      // kept as an ISO string, not a Date: GeoJSON feature properties get
      // round-tripped through MapLibre's tiling worker (addSource -> click
      // event), which silently coerces a Date into a plain string anyway
      // (a real, confirmed bug the first time this was tried) — reconstruct
      // the Date only at render time instead (see openVenueDetail).
      time: s.time || null
    }));
    // Guards against a stale on-disk cache file from an older version of
    // server.py's response shape (fewer/more steps, or no `steps` array
    // at all) — server.py now versions its cache key specifically to
    // prevent this, but this check stays as a second line of defense:
    // trusting a short/mismatched array here silently threw
    // `Cannot read properties of undefined` deep inside loadArea's
    // synchronous block (no try/catch around it), which killed the
    // whole area load with the loading overlay stuck forever and no
    // visible error — a real, confirmed incident, not a hypothetical.
    return {
      steps: steps.length === TIMELINE_OFFSETS_MINUTES.length ? steps : TIMELINE_OFFSETS_MINUTES.map(emptyStep),
      // Server fell back to a cached response older than its normal expiry
      // because the live Yr fetch failed — the data shown may be out of
      // date, surface that.
      stale: res.headers.get('X-Cache') === 'STALE'
    };
  } catch (err) {
    console.error('Yr weather fetch failed', err);
    return { steps: TIMELINE_OFFSETS_MINUTES.map(emptyStep), stale: false };
  }
}

// Weather is read per venue's grid cell, not once per area: venues near an
// area edge can sit in a different cell than the area centre. One fetch per
// distinct cell covers temp, wind and cloud together.
async function fetchVenueWeather(venues) {
  const cells = new Map(); // cellKey -> { key, lat, lon }
  for (const f of venues.features) {
    const [lon, lat] = f.geometry.coordinates;
    const cell = weatherGridCell(lon, lat);
    if (!cells.has(cell.key)) cells.set(cell.key, cell);
  }

  const results = new Map(); // cellKey -> fetchYrWeather() result
  await Promise.all([...cells.values()].map(async cell => {
    results.set(cell.key, await fetchYrWeather(cell));
  }));

  for (const f of venues.features) {
    const [lon, lat] = f.geometry.coordinates;
    const w = results.get(weatherGridCell(lon, lat).key);
    const now = w.steps[0];
    // Flat properties stay pinned to the CURRENT (offset 0) reading — this
    // is what drives the venue's marker color (cloudTierState) and the
    // wind-shelter check below in loadArea, neither of which scrub with
    // the timeline (see openVenueDetail/renderPanel for what does).
    f.properties.temperature = now.temperature;
    f.properties.windSpeed = now.windSpeed;
    f.properties.windDir = now.windDir;
    f.properties.cloudCover = now.cloudCover;
    f.properties.symbolCode = now.symbolCode;
    f.properties.weatherTime = now.time;
    f.properties.weatherStale = w.stale;
    // Full 3-step timeline, for the scrub-able venue/area panels — stored
    // as a JSON string, not a nested array/object, for the same GeoJSON-
    // round-tripping reason properties.weatherTime is an ISO string and
    // not a Date (see the CLAUDE.md note on this).
    f.properties.weatherStepsJson = JSON.stringify(w.steps);
  }

  return results;
}

// --- DMI radar (precipitation) ------------------------------------------
// One Denmark-wide composite, so every venue's exact coordinate goes in one
// bulk POST. The server answers each point with a cheap array lookup.
async function fetchVenuePrecipitation(venues) {
  const points = venues.features.map(f => {
    const [lon, lat] = f.geometry.coordinates;
    return [lat, lon];
  });
  if (!points.length) return { time: null, stale: false };
  const nowIdx = TIMELINE_OFFSETS_MINUTES.indexOf(0);
  try {
    const res = await fetch('/api/precipitation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(points)
    });
    if (!res.ok) throw new Error(`DMI radar proxy responded ${res.status}`);
    const data = await res.json();
    const stale = res.headers.get('X-Cache') === 'STALE';
    venues.features.forEach((f, i) => {
      // values[i] is a 13-entry array (-10 to +50 in 5-minute steps), in
      // the same TIMELINE_OFFSETS_MINUTES order the server used
      // (RADAR_NOWCAST_OFFSETS_MINUTES). Only the 0 (Now) entry is a real
      // observation (server reads the current frame directly); every
      // other entry, past or future, is a semi-Lagrangian nowcast
      // estimate (see radar_value_at_offset in server.py) and only ever
      // has as much confidence as that method affords — more reliable
      // close to 0, less reliable further out either direction.
      const steps = data.values[i] || [];
      f.properties.precipitation = typeof steps[nowIdx] === 'number' ? steps[nowIdx] : null;
      f.properties.precipitationTime = data.radarTime || null;
      f.properties.precipitationStale = stale;
      f.properties.precipitationStepsJson = JSON.stringify(steps);
    });
    return { time: data.radarTime || null, stale };
  } catch (err) {
    console.error('DMI radar fetch failed', err);
    venues.features.forEach(f => {
      f.properties.precipitation = null;
      f.properties.precipitationTime = null;
      f.properties.precipitationStale = false;
      f.properties.precipitationStepsJson = JSON.stringify(TIMELINE_OFFSETS_MINUTES.map(() => null));
    });
    return { time: null, prevTime: null, stale: false };
  }
}

// Circular mean: a plain average of 350° and 10° would give 180°, not 0°.
function circularMeanDegrees(degrees) {
  if (!degrees.length) return null;
  let sinSum = 0, cosSum = 0;
  for (const d of degrees) {
    const rad = d * Math.PI / 180;
    sinSum += Math.sin(rad);
    cosSum += Math.cos(rad);
  }
  const meanRad = Math.atan2(sinSum / degrees.length, cosSum / degrees.length);
  return (meanRad * 180 / Math.PI + 360) % 360;
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

// Buildings are indexed once per area with their bounding boxes. Per-venue
// checks can then reject far-away buildings with arithmetic, instead of a
// turf.distance call for every venue x building pair.
function indexBuildings(buildings) {
  return buildings.features.map(feature => {
    let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
    for (const ring of feature.geometry.coordinates) {
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
    }
    return { feature, minLon, minLat, maxLon, maxLat };
  });
}

// Approximate metres from a point to a box. Accurate enough for a pre-filter
// with a 1.5x margin; the exact turf checks still decide.
function metresToBox(lon, lat, box) {
  const dLat = lat < box.minLat ? box.minLat - lat : lat > box.maxLat ? lat - box.maxLat : 0;
  const dLon = lon < box.minLon ? box.minLon - lon : lon > box.maxLon ? lon - box.maxLon : 0;
  const mPerDegLat = 111320;
  const mPerDegLon = mPerDegLat * Math.cos(lat * Math.PI / 180);
  return Math.hypot(dLat * mPerDegLat, dLon * mPerDegLon);
}

// A segment can only touch a building if their bounding boxes overlap, so this
// rejects most candidates before the exact turf check.
function segmentBox(a, b) {
  return {
    minLon: Math.min(a[0], b[0]), maxLon: Math.max(a[0], b[0]),
    minLat: Math.min(a[1], b[1]), maxLat: Math.max(a[1], b[1])
  };
}

function boxesOverlap(a, b) {
  return a.minLon <= b.maxLon && a.maxLon >= b.minLon && a.minLat <= b.maxLat && a.maxLat >= b.minLat;
}

function isVenueShadowed(venueCoord, buildingIndex, bearingDeg, altitudeRad) {
  const end = turf.destination(venueCoord, SHADOW_RAY_METERS / 1000, bearingDeg, { units: 'kilometers' }).geometry.coordinates;
  const ray = turf.lineString([venueCoord, end]);
  const rayBox = segmentBox(venueCoord, end);
  const [lon, lat] = venueCoord;

  for (const entry of buildingIndex) {
    if (metresToBox(lon, lat, entry) > SHADOW_RAY_METERS * 1.5) continue;
    if (!boxesOverlap(rayBox, entry)) continue;
    const building = entry.feature;
    if (!turf.booleanIntersects(ray, building)) continue;

    const intersections = turf.lineIntersect(ray, turf.polygonToLine(building));
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

// Wind at street level is blocked by a building of reasonable height standing
// close upwind, so this is a proximity check, not an altitude calculation.
function isVenueWindSheltered(venueCoord, buildingIndex, windDirDeg) {
  // windDir is where the wind comes FROM, so the blocker sits in that direction.
  const end = turf.destination(venueCoord, WIND_SHELTER_RAY_METERS / 1000, windDirDeg, { units: 'kilometers' }).geometry.coordinates;
  const ray = turf.lineString([venueCoord, end]);
  const rayBox = segmentBox(venueCoord, end);
  const [lon, lat] = venueCoord;

  for (const entry of buildingIndex) {
    if (entry.feature.properties.height < WIND_SHELTER_MIN_HEIGHT) continue;
    if (metresToBox(lon, lat, entry) > WIND_SHELTER_RAY_METERS * 1.5) continue;
    if (!boxesOverlap(rayBox, entry)) continue;
    if (turf.booleanIntersects(ray, entry.feature)) return true;
  }
  return false;
}

// --- Main -------------------------------------------------------------------

const COPENHAGEN_CENTER = [12.57, 55.685];

// --- Day / night theme --------------------------------------------------
// Dark is the default. Light applies in daylight. Marker colours are semantic
// and stay the same in both themes.

const MAP_STYLES = {
  night: 'https://tiles.openfreemap.org/styles/dark',
  day: 'https://tiles.openfreemap.org/styles/positron'
};
const BUILDING_COLOR = { night: '#151f33', day: '#c3ccd9' };

// Civil twilight (sun 6° below the horizon), not 0°: the open terrain keeps it
// looking light well after the sun crosses the horizon.
const CIVIL_TWILIGHT_ALTITUDE_RAD = -6 * (Math.PI / 180);

function computeTheme() {
  const alt = SunCalc.getPosition(new Date(), COPENHAGEN_CENTER[1], COPENHAGEN_CENTER[0]).altitude;
  return alt > CIVIL_TWILIGHT_ALTITUDE_RAD ? 'day' : 'night';
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

function resetLoadingSteps() {
  loadingOverlay.innerHTML = `
    <div class="sun-loader"><div class="rays"></div><div class="core"></div></div>
    <div id="loading-text">Waking up the sun…</div>
    <div id="loading-steps">
      <span data-step="venues"></span>
      <span data-step="buildings"></span>
      <span data-step="weather"></span>
      <span data-step="radar"></span>
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
  'night': '🌙 Sun is down',
  'unknown': '❔ No forecast (N/A)'
};

let iconsRegistered = false;
const popup = new maplibregl.Popup({ closeButton: false, offset: 10 });

// Each toggled-on area gets its own source/layer set, keyed by areaId, so
// areas can be independently added and removed without touching each other.
const loadedAreas = {}; // areaId -> { venues, counts }
let pendingLoads = 0;

// --- Timeline -----------------------------------------------------------
// One control scrubs the numbers (weather, rain) for every loaded area. Marker
// colours and sun/shade stay pinned to "now" by design.
let timelineOffsetMinutes = 0;

function timelineStepIndex() {
  return TIMELINE_OFFSETS_MINUTES.indexOf(timelineOffsetMinutes);
}

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
    'unknown', '#ec4899',
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
        'unknown', '#1a0a13',
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
// OSM fields are untrusted: escape everything, and validate link schemes.

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
  night: '#2a3868',
  unknown: '#ec4899'
};

const venueDetail = document.getElementById('venue-detail');
const venueDetailContent = document.getElementById('venue-detail-content');

document.getElementById('venue-detail-close').addEventListener('click', () => {
  venueDetail.hidden = true;
  currentVenueFeature = null;
});

function formatWeatherValue(value, unit, decimals = 0) {
  return value == null ? '—' : `${value.toFixed(decimals)}${unit}`;
}

// Yr's symbol_code for display only. Sun/shade tiering uses cloudCover.
// Unmapped codes fall back to the code's own words, not blank.
const SYMBOL_INFO = {
  clearsky: { icon: '☀️', label: 'Clear sky' },
  fair: { icon: '🌤️', label: 'Fair' },
  partlycloudy: { icon: '⛅', label: 'Partly cloudy' },
  cloudy: { icon: '☁️', label: 'Cloudy' },
  fog: { icon: '🌫️', label: 'Fog' },
  rain: { icon: '🌧️', label: 'Rain' },
  lightrain: { icon: '🌦️', label: 'Light rain' },
  heavyrain: { icon: '🌧️', label: 'Heavy rain' },
  rainshowers: { icon: '🌦️', label: 'Rain showers' },
  lightrainshowers: { icon: '🌦️', label: 'Light rain showers' },
  heavyrainshowers: { icon: '🌧️', label: 'Heavy rain showers' },
  rainandthunder: { icon: '⛈️', label: 'Rain and thunder' },
  rainshowersandthunder: { icon: '⛈️', label: 'Rain showers and thunder' },
  sleet: { icon: '🌨️', label: 'Sleet' },
  snow: { icon: '❄️', label: 'Snow' },
  lightsnow: { icon: '🌨️', label: 'Light snow' },
  heavysnow: { icon: '❄️', label: 'Heavy snow' },
  snowshowers: { icon: '🌨️', label: 'Snow showers' }
};

function formatSymbolCode(code) {
  if (!code) return null;
  const base = code.replace(/_(day|night|polartwilight)$/, '');
  if (SYMBOL_INFO[base]) return SYMBOL_INFO[base];
  return { icon: '🌡️', label: base.charAt(0).toUpperCase() + base.slice(1) };
}

// Weather (Yr) and rain (DMI radar) fail independently, so each gets its own note.
function renderStaleNotes(weather) {
  let html = '';
  if (weather.weatherStale) {
    html += '<div class="vd-stale-note">🌦️ Weather data is temporarily unavailable right now — showing the last cached reading.</div>';
  }
  if (weather.precipitationStale) {
    html += '<div class="vd-stale-note">📡 Radar data is temporarily unavailable right now — showing the last cached reading.</div>';
  }
  return html;
}

// --- Opening hours (best-effort OSM `opening_hours` parser) ------------
// Covers the common forms. Anything unparsed (seasonal ranges, "easter",
// nth-weekday rules, free text) falls back to the raw OSM string, not a guess.

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

// Parses one ';'-separated clause. Bare day tokens are buffered until a time completes them.
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

// The currently open venue's own feature, so a timeline scrub can re-render
// its panel with the newly-selected step without needing a fresh click —
// cleared whenever the panel closes (see the close button's handler below).
let currentVenueFeature = null;

function openVenueDetail(feature) {
  currentVenueFeature = feature;
  const p = feature.properties;
  const areaData = loadedAreas[p.areaId];
  const stepIdx = timelineStepIndex();
  // Temperature, wind, and cloud cover are all this venue's own grid-cell
  // reading now (see fetchVenueWeather) — Yr bundles all three into one
  // per-cell response, unlike DMI's old split (temp/wind area-wide from a
  // single station, cloud cover per-venue from a separate forecast call).
  // Can genuinely differ from the area-wide average shown in the top panel.
  // The timeline picks which of the 3 fetched steps (Now/+15/+30) to show
  // — everything below is already-fetched client-side data, not a new
  // request, so scrubbing is instant.
  const weatherStep = (JSON.parse(p.weatherStepsJson || '[]'))[stepIdx] || {};
  const precipStep = (JSON.parse(p.precipitationStepsJson || '[]'))[stepIdx];
  const weather = {
    temperature: weatherStep.temperature,
    windSpeed: weatherStep.windSpeed,
    windDir: weatherStep.windDir,
    cloudCover: weatherStep.cloudCover,
    symbolCode: weatherStep.symbolCode,
    weatherTime: weatherStep.time ? new Date(weatherStep.time) : null,
    weatherStale: p.weatherStale,
    // Precipitation is DMI radar, not Yr — a separate upstream with its own
    // cache/refresh cadence (15 min fixed, see server.py), so it gets its
    // own timestamp and stale flag rather than sharing weatherTime/
    // weatherStale. Same ISO-string-until-render-time convention as
    // weatherTime, for the same MapLibre GeoJSON round-tripping reason.
    // Only offset 0 is a real observation ("Radar as of…"); every other
    // step, past or future, is a semi-Lagrangian nowcast estimate, not an
    // observation, so the render below labels it "forecast" instead —
    // see radar_value_at_offset in server.py for what that estimate
    // actually is (and isn't).
    precipitation: precipStep,
    precipitationOffsetMinutes: TIMELINE_OFFSETS_MINUTES[stepIdx],
    precipitationTime: p.precipitationTime ? new Date(p.precipitationTime) : null,
    precipitationStale: p.precipitationStale
  };
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
    <button class="vd-navigate-btn" id="vd-navigate">🧭 Navigate</button>
    <div class="vd-state" style="background:${stateColor};color:${stateTextColor}">${STATE_LABELS[p.state]}</div>

    <div class="vd-section">
      <h4>Weather in ${areaLabel}${formatSymbolCode(weather.symbolCode) ? ` · ${formatSymbolCode(weather.symbolCode).icon} ${escapeHtml(formatSymbolCode(weather.symbolCode).label)}` : ''}</h4>
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
        <div class="vd-weather-item">
          <div class="val">${formatWeatherValue(weather.precipitation, ' mm/h', 1)}</div>
          <div class="label">Rain</div>
        </div>
      </div>
      ${weather.weatherTime ? `<div class="vd-station">Weather forecast for ${weather.weatherTime.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' })}</div>` : ''}
      ${weather.precipitationTime ? `<div class="vd-station">${(() => {
        const fmt = d => d.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
        // Only offset 0 is a true unprojected observation now (see
        // radar_value_at_offset in server.py) — every other step, past or
        // future, is the same motion-vector projection from the current
        // frame, just with a smaller/larger time offset. -10/-5 aren't
        // "real" any more than +45/+50 are, just closer to the two real
        // frames the motion estimate came from, so more trustworthy —
        // not a different kind of value.
        if (weather.precipitationOffsetMinutes === 0) return `Radar as of ${fmt(weather.precipitationTime)}`;
        return `Rain forecast for ${fmt(new Date(weather.precipitationTime.getTime() + weather.precipitationOffsetMinutes * 60000))} (nowcast)`;
      })()}</div>` : ''}
      ${renderStaleNotes(weather)}
      ${p.windSheltered ? `<div class="vd-wind-note">🛡️ A building appears to block the wind here — it may feel calmer than the reading above.</div>` : ''}
    </div>

    <div class="vd-section">
      <h4>Venue info</h4>
      ${infoRows.length ? infoRows.join('') : '<div class="vd-empty">No extra details available on OpenStreetMap for this venue.</div>'}
    </div>
  `;
  venueDetail.hidden = false;

  const [lon, lat] = feature.geometry.coordinates;
  document.getElementById('vd-navigate').addEventListener('click', () => openNavigateSheet(lat, lon));
}

// --- "Navigate with..." chooser --------------------------------------------
// Browsers can't open the native app picker, so this is our own sheet.
let navTargetCoords = null;
const navSheet = document.getElementById('nav-sheet');
const navSheetBackdrop = document.getElementById('nav-sheet-backdrop');

function openNavigateSheet(lat, lon) {
  navTargetCoords = { lat, lon };
  navSheetBackdrop.hidden = false;
  navSheet.hidden = false;
  // Force layout before adding .show so the opacity/transform transition
  // actually plays instead of snapping straight to its end state.
  navSheetBackdrop.offsetHeight;
  navSheetBackdrop.classList.add('show');
  navSheet.classList.add('show');
}

function closeNavigateSheet() {
  navSheetBackdrop.classList.remove('show');
  navSheet.classList.remove('show');
  setTimeout(() => {
    navSheetBackdrop.hidden = true;
    navSheet.hidden = true;
  }, 200);
}

navSheetBackdrop.addEventListener('click', closeNavigateSheet);
document.getElementById('nav-sheet-cancel').addEventListener('click', closeNavigateSheet);
document.getElementById('nav-google-maps').addEventListener('click', () => {
  if (navTargetCoords) {
    const { lat, lon } = navTargetCoords;
    window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=walking`, '_blank', 'noopener');
  }
  closeNavigateSheet();
});
document.getElementById('nav-apple-maps').addEventListener('click', () => {
  if (navTargetCoords) {
    const { lat, lon } = navTargetCoords;
    window.open(`https://maps.apple.com/?daddr=${lat},${lon}&dirflg=w`, '_blank', 'noopener');
  }
  closeNavigateSheet();
});

// --- Timeline (Now / +15 / +30) UI ---------------------------------------
const timelineEl = document.getElementById('timeline');
const timelineTrackEl = document.querySelector('.timeline-track');
const timelineFillEl = document.querySelector('.timeline-fill');
const timelineHandleEl = document.querySelector('.timeline-handle');
const timelineLabelEl = document.getElementById('timeline-label');
const timelinePrevBtn = document.getElementById('timeline-prev');
const timelineNextBtn = document.getElementById('timeline-next');
// Shown only before radar data arrives. Real clock times replace it, since
// the radar lags real time by several minutes.
function timelineFallbackLabel(offset) {
  if (offset === 0) return 'Now';
  return offset > 0 ? `+${offset} min` : `${offset} min`;
}
// offset -> Date, from the radar response. One shared frame, so one set of times.
let timelineClockTimes = {};

function timelinePercentForOffset(offset) {
  const idx = TIMELINE_OFFSETS_MINUTES.indexOf(offset);
  return (idx / (TIMELINE_OFFSETS_MINUTES.length - 1)) * 100;
}

function timelineClockLabel(offset) {
  const d = timelineClockTimes[offset];
  return d ? d.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' }) : timelineFallbackLabel(offset);
}

// Labels are anchored to the radar frame's own time, not the device clock.
function updateTimelineClockTimes(radarTimeIso) {
  if (!radarTimeIso) return;
  const radarTime = new Date(radarTimeIso);
  timelineClockTimes = {};
  for (const offset of TIMELINE_OFFSETS_MINUTES) {
    timelineClockTimes[offset] = new Date(radarTime.getTime() + offset * 60000);
  }
  renderTimelinePosition();
}

function renderTimelinePosition() {
  const pct = timelinePercentForOffset(timelineOffsetMinutes);
  timelineHandleEl.style.left = `${pct}%`;
  timelineFillEl.style.width = `${pct}%`;
  timelineHandleEl.setAttribute('aria-valuenow', String(timelineOffsetMinutes));
  timelineLabelEl.textContent = timelineClockLabel(timelineOffsetMinutes);
  const idx = TIMELINE_OFFSETS_MINUTES.indexOf(timelineOffsetMinutes);
  timelinePrevBtn.disabled = idx <= 0;
  timelineNextBtn.disabled = idx >= TIMELINE_OFFSETS_MINUTES.length - 1;
}

// All steps are fetched up front, so this only re-renders. No network.
function setTimelineOffset(minutes) {
  if (timelineOffsetMinutes === minutes) return;
  timelineOffsetMinutes = minutes;
  renderTimelinePosition();
  renderPanel();
  if (currentVenueFeature) openVenueDetail(currentVenueFeature);
}

function timelineOffsetForClientX(clientX) {
  const rect = timelineTrackEl.getBoundingClientRect();
  const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const idx = Math.round(pct * (TIMELINE_OFFSETS_MINUTES.length - 1));
  return TIMELINE_OFFSETS_MINUTES[idx];
}

function stepTimeline(direction) {
  const idx = TIMELINE_OFFSETS_MINUTES.indexOf(timelineOffsetMinutes);
  const nextIdx = idx + direction;
  if (nextIdx < 0 || nextIdx >= TIMELINE_OFFSETS_MINUTES.length) return;
  setTimelineOffset(TIMELINE_OFFSETS_MINUTES[nextIdx]);
}

timelinePrevBtn.addEventListener('click', () => stepTimeline(-1));
timelineNextBtn.addEventListener('click', () => stepTimeline(1));

// Clicking the track jumps to the nearest step. Dragging the handle does the same.
timelineTrackEl.addEventListener('click', e => {
  if (e.target === timelineHandleEl) return;
  setTimelineOffset(timelineOffsetForClientX(e.clientX));
});

// Updates live on every move; setTimelineOffset no-ops when the step is unchanged.
let timelineDragging = false;
timelineHandleEl.addEventListener('pointerdown', e => {
  timelineDragging = true;
  timelineHandleEl.setPointerCapture(e.pointerId);
});
timelineHandleEl.addEventListener('pointermove', e => {
  if (!timelineDragging) return;
  setTimelineOffset(timelineOffsetForClientX(e.clientX));
});
timelineHandleEl.addEventListener('pointerup', () => {
  timelineDragging = false;
});
timelineHandleEl.addEventListener('keydown', e => {
  if (e.key === 'ArrowRight') stepTimeline(1);
  else if (e.key === 'ArrowLeft') stepTimeline(-1);
});

renderTimelinePosition();

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
    // Nothing loaded, nothing to scrub — same visibility rule as #panel,
    // since the timeline only ever affects data that came from loadArea.
    timelineEl.hidden = true;
    return;
  }
  panel.hidden = false;
  timelineEl.hidden = false;

  const stepIdx = timelineStepIndex();
  const total = { sun: 0, 'partly-sunny': 0, 'building-shade': 0, 'partly-cloudy': 0, cloudy: 0, night: 0, unknown: 0 };
  const areaRows = entries.map(({ area, sun, weatherSteps, sunAvailable, sunIsUp, counts }) => {
    for (const k in counts) total[k] += counts[k];
    const weather = weatherSteps[stepIdx];
    return `
      <div class="panel-area">
        <p class="place">${area.label}</p>
        <div class="meta">${sun.time.toLocaleTimeString('da-DK')} · Sun ${sun.altitudeDeg.toFixed(1)}° · Cloud forecast for area ${weather.cloudCover == null ? '—' : weather.cloudCover.toFixed(0) + '%'}${weather.weatherStale ? ' ⚠️' : ''} · Rain ${weather.precipitation == null ? '—' : weather.precipitation.toFixed(1) + ' mm/h'}${weather.precipitationStale ? ' ⚠️' : ''}</div>
        <div class="status">${sunAvailable ? 'Sun is out' : (sunIsUp ? 'Too cloudy' : 'Sun is down')}${weather.weatherStale || weather.precipitationStale ? ' · cached data' : ''}</div>
      </div>`;
  }).join('');

  const inSun = total.sun + total['partly-sunny'];
  const inShade = total['building-shade'] + total['partly-cloudy'] + total.cloudy + total.night;

  panelContent.innerHTML = `
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
      <div class="legend-row"><span class="dot unknown"></span>No forecast (N/A)<span class="count">${total.unknown}</span></div>
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
    const venuesPromise = fetchVenues(areaId, bbox).then(v => { markStepDone('venues'); return v; });
    const buildingsPromise = fetchBuildings(areaId, bbox).then(b => { markStepDone('buildings'); return b; });
    setLoadingText('Fetching venues & building shapes from OpenStreetMap…');
    [buildings, venues] = await Promise.all([buildingsPromise, venuesPromise]);
  } catch (err) {
    console.error('Failed to load OSM data', err);
    pendingLoads--;
    document.querySelector(`[data-area="${areaId}"]`).classList.remove('active');
    if (pendingLoads === 0) {
      const message = err.ownRateLimit
        ? "You're loading areas faster than this server's own request budget resets — give it a few seconds and try again."
        : 'Could not load map data from OpenStreetMap — the Overpass API may be busy.';
      showLoadingError(message);
    }
    return;
  }

  setLoadingText('Checking the sky over Copenhagen…');
  const [weatherCells, radar] = await Promise.all([
    fetchVenueWeather(venues).then(r => { markStepDone('weather'); return r; }),
    fetchVenuePrecipitation(venues).then(r => { markStepDone('radar'); return r; })
  ]);
  updateTimelineClockTimes(radar.time);
  const sun = getSunInfo(center[1], center[0]);

  setLoadingText('Tracing shadows…');

  const sunIsUp = sun.altitudeDeg > 0;

  // Area-level summary (panel header, legend) averages across whichever grid
  // cells this area's venues actually span — with one venue or one cell in
  // play that's just that cell's own reading. Temp/wind/cloud are all
  // per-venue now (Yr's per-cell grid covers all three, unlike DMI's old
  // single area-wide observation station), so this average is purely for
  // the top panel's one-line area summary — a venue's own detail panel
  // always shows its own cell's un-averaged reading.
  const cellReadings = [...weatherCells.values()]; // each: { steps: [3 entries], stale }
  const mean = values => {
    const nums = values.filter(v => typeof v === 'number');
    return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
  };
  const weatherStale = cellReadings.some(r => r.stale);
  const precipStepsPerVenue = venues.features.map(f => JSON.parse(f.properties.precipitationStepsJson || '[]'));
  // One summary object per timeline step (Now/+15/+30), not just one for
  // "now" — renderPanel picks whichever the timeline is currently on.
  // Precipitation's own mean/stale/timestamp are kept separate from
  // weather's, not folded in — it's a genuinely different upstream (DMI
  // radar vs. Yr) with its own independent cache and failure mode, the
  // same reasoning CLAUDE.md already lays out for why forecastStale and
  // obsStale used to be two flags back when temp/wind and cloud cover came
  // from two different DMI calls.
  const weatherSteps = TIMELINE_OFFSETS_MINUTES.map((offset, stepIdx) => {
    const stepReadings = cellReadings.map(r => r.steps[stepIdx] || {});
    const precipValues = precipStepsPerVenue.map(steps => steps[stepIdx]).filter(v => typeof v === 'number');
    return {
      offsetMinutes: offset,
      temperature: mean(stepReadings.map(r => r.temperature)),
      windSpeed: mean(stepReadings.map(r => r.windSpeed)),
      windDir: circularMeanDegrees(stepReadings.map(r => r.windDir).filter(v => typeof v === 'number')),
      cloudCover: mean(stepReadings.map(r => r.cloudCover)),
      weatherStale,
      precipitation: precipValues.length ? mean(precipValues) : null,
      precipitationTime: radar.time,
      precipitationStale: radar.stale
    };
  });

  const buildingIndex = indexBuildings(buildings);
  for (const f of venues.features) {
    const cloudTier = cloudTierState(f.properties.cloudCover);
    let state;
    if (!sunIsUp) {
      state = 'night';
    } else if (isVenueShadowed(f.geometry.coordinates, buildingIndex, sun.bearingDeg, sun.altitudeRad)) {
      state = 'building-shade';
    } else {
      state = cloudTier;
    }
    f.properties.state = state;
    f.properties.areaId = areaId;
    // Each venue's own wind direction now, not one area-wide reading — the
    // same per-venue-accuracy upgrade cloud cover already got, made free by
    // Yr bundling wind into the same per-cell response.
    f.properties.windSheltered = f.properties.windDir != null
      ? isVenueWindSheltered(f.geometry.coordinates, buildingIndex, f.properties.windDir)
      : false;
  }
  markStepDone('shadows');

  await mapReady;
  addAreaLayers(areaId, buildings, venues);
  areaDataCache[areaId] = { buildings, venues }; // kept so a day/night theme switch can relayer without re-fetching

  const counts = { sun: 0, 'partly-sunny': 0, 'building-shade': 0, 'partly-cloudy': 0, cloudy: 0, night: 0, unknown: 0 };
  for (const f of venues.features) counts[f.properties.state]++;
  const sunAvailable = sunIsUp && (counts.sun > 0 || counts['partly-sunny'] > 0);

  loadedAreas[areaId] = { area, sun, weatherSteps, sunAvailable, sunIsUp, counts };
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

// Phone-only dropdown. On desktop the toggle is hidden and never opened.
const areaDropdownToggle = document.getElementById('area-dropdown-toggle');
const areaDropdownLabel = document.getElementById('area-dropdown-label');
const areaBarEl = document.getElementById('area-bar');

function updateAreaDropdownLabel() {
  const active = document.querySelectorAll('.area-box.active');
  if (active.length === 0) areaDropdownLabel.textContent = 'Select areas';
  else if (active.length === 1) areaDropdownLabel.textContent = active[0].textContent;
  else areaDropdownLabel.textContent = `${active.length} areas selected`;
}

areaDropdownToggle.addEventListener('click', () => {
  const open = areaBarEl.classList.toggle('open');
  areaDropdownToggle.classList.toggle('open', open);
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#area-select')) {
    areaBarEl.classList.remove('open');
    areaDropdownToggle.classList.remove('open');
  }
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
    updateAreaDropdownLabel();
  });
});
