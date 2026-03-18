/*
  GeoPoints → CSV (Native)
  Copyright © 2026 Devin Frederick
*/

const $ = (id) => document.getElementById(id);

// ── Persistent user identity (no cookies) ────────────────────────────────────
const USER_ID_KEY = 'gps_uid';
function getUserId() {
  let uid = localStorage.getItem(USER_ID_KEY);
  if (!uid) { uid = crypto.randomUUID(); localStorage.setItem(USER_ID_KEY, uid); }
  return uid;
}
const userId = getUserId();
function userHeaders(extra) { return { 'X-User-Id': userId, ...extra }; }

const dropzone = $("dropzone");
const fileInput = $("fileInput");
const fileList = $("fileList");
const summary = $("summary");
const logEl = $("log");
const statusPill = $("statusPill");

const delimiterEl = $("delimiter");
const includeHeaderEl = $("includeHeader");
const zipOutputEl = $("zipOutput");
const precisionEl = $("precision");
const precisionFieldEl = $("precisionField");
const useDefaultPrecisionEl = $("useDefaultPrecision");

const btnConvert = $("btnConvert");
const btnClear = $("btnClear");

const progressWrap = $("progressWrap");
const progressBarEl = $("progressBar");

// fields UI
const fieldsPanel = $("fieldsPanel");
const fieldsListEl = $("fieldsList");
const fieldsHint = $("fieldsHint");
const btnKeepAll = $("btnKeepAll");
const btnDropAll = $("btnDropAll");
const btnKeepGeo = $("btnKeepGeo");

// map UI
const mapPanel = $("mapPanel");
const mapEl = $("map");
const mapHint = $("mapHint");
const mapStatus = $("mapStatus");
const btnClearFilter     = $("btnClearFilter");
const polygonLayerSelect = $("polygonLayerSelect");
const mapLayerSelect     = $("mapLayerSelect");
const btnUploadPolygon = $("btnUploadPolygon");
const polygonFileInput = $("polygonFileInput");
const keepCrossingLinesEl = $("keepCrossingLines");

// layers UI
const layersPanel = $("layersPanel");
const layersListEl = $("layersList");
const layersHint = $("layersHint");
const btnSelectAllLayers = $("btnSelectAllLayers");
const btnDeselectAllLayers = $("btnDeselectAllLayers");

let selectedFiles = [];
let currentSessionId = null;
let availableFields = [];            // [{key,type}]
let selectedFieldKeys = new Set();   // what to KEEP
let availableLayers = [];            // [{key, count}]
let selectedLayerKeys = new Set();   // which layers to include
const collapsedLayerNodes = new Set(); // tree nodes collapsed by user
const parsedCache = new Map();       // fileKey -> { rows, fields }

let leafletMap = null;
let markersLayer = null;
let drawnItems = null;
let drawControl = null;
let spatialFilter = null;            // null = no filter; {type, layer} when active
let displayLayerKey = null;          // null = all layers; string = key of layer shown on map

function showProgress(indeterminate = true, pct = 0) {
  progressWrap.hidden = false;
  if (indeterminate) {
    progressBarEl.classList.add("indeterminate");
    progressBarEl.style.width = "";
  } else {
    progressBarEl.classList.remove("indeterminate");
    progressBarEl.style.width = `${pct}%`;
  }
}
function hideProgress() {
  progressBarEl.classList.remove("indeterminate");
  progressBarEl.style.width = "100%";
  setTimeout(() => {
    progressWrap.hidden = true;
    progressBarEl.style.width = "0%";
  }, 300);
}

function log(line) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent += `[${ts}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

let loadInterval = null;

async function updateLoad() {
  try {
    const res = await fetch('load');
    if (!res.ok) return;
    const { pct } = await res.json();
    if (statusPill.textContent.startsWith('Idle')) {
      statusPill.textContent = `Idle · ${pct}%`;
    }
  } catch { /* ignore */ }
}

function setStatus(text) {
  statusPill.textContent = text;
  if (text === 'Idle') {
    if (loadInterval) clearInterval(loadInterval);
    updateLoad();
    loadInterval = setInterval(updateLoad, 1000);
  } else {
    if (loadInterval) { clearInterval(loadInterval); loadInterval = null; }
  }
}

function humanSize(bytes) {
  const units = ["B","KB","MB","GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" }[c])
  );
}

function renderFiles() {
  fileList.innerHTML = "";
  let total = 0;

  for (const f of selectedFiles) {
    total += f.size;
    const div = document.createElement("div");
    div.className = "fileItem";
    div.innerHTML = `
      <div class="fileName">${escapeHtml(f.name)}</div>
      <div class="fileMeta">${humanSize(f.size)}</div>
    `;
    fileList.appendChild(div);
  }

  const has = selectedFiles.length > 0;
  btnClear.disabled = !has;
  btnConvert.disabled = !has || selectedFieldKeys.size === 0;


  summary.textContent = has
    ? `${selectedFiles.length} file(s), ${humanSize(total)}`
    : "";
}

function updatePrecisionVisibility() {
  precisionFieldEl.hidden = useDefaultPrecisionEl.checked;
}

function renderFields() {
  const hasFields = availableFields.length > 0;
  fieldsPanel.hidden = !hasFields;
  fieldsListEl.innerHTML = "";

  if (!hasFields) return;

  fieldsHint.textContent = `Select columns to keep (${availableFields.length} available).`;

  for (const f of availableFields) {
    const id = `fld_${hashKey(f.key)}`;
    const wrap = document.createElement("label");
    wrap.className = "fieldChip";
    wrap.innerHTML = `
      <input type="checkbox" id="${id}">
      <div class="fieldName">
        <div class="k">${escapeHtml(f.key)}</div>
        <div class="t">${escapeHtml(f.type || "text")}</div>
      </div>
    `;
    const cb = wrap.querySelector("input");
    cb.checked = selectedFieldKeys.has(f.key);
    cb.addEventListener("change", () => {
      if (cb.checked) selectedFieldKeys.add(f.key);
      else selectedFieldKeys.delete(f.key);
      btnConvert.disabled = selectedFiles.length === 0 || selectedFieldKeys.size === 0;
    });

    fieldsListEl.appendChild(wrap);
  }
}

function buildLayerTree(layers) {
  const root = new Map();
  function getOrCreate(map, label, path) {
    if (!map.has(label)) map.set(label, { label, path, children: new Map(), layer: null });
    return map.get(label);
  }
  for (const lyr of layers) {
    const parts = lyr.key.split(" / ");
    let map = root;
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join(" / ");
      const node = getOrCreate(map, parts[i], path);
      if (i === parts.length - 1) node.layer = lyr;
      map = node.children;
    }
  }
  return root;
}

function getLeafKeys(node) {
  const keys = [];
  if (node.layer) keys.push(node.layer.key);
  for (const child of node.children.values()) keys.push(...getLeafKeys(child));
  return keys;
}

function renderLayerNode(node, depth, container) {
  const hasChildren = node.children.size > 0;
  const isExpanded = !collapsedLayerNodes.has(node.path);

  const row = document.createElement("div");
  row.className = "layerRow";
  row.style.paddingLeft = `${depth * 16 + 8}px`;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "layerToggle";
  if (hasChildren) {
    toggle.textContent = isExpanded ? "▾" : "▸";
    toggle.addEventListener("click", () => {
      if (collapsedLayerNodes.has(node.path)) collapsedLayerNodes.delete(node.path);
      else collapsedLayerNodes.add(node.path);
      renderLayers();
    });
  }
  row.appendChild(toggle);

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "layerCb";
  const leafKeys = getLeafKeys(node);
  const checkedCount = leafKeys.filter(k => selectedLayerKeys.has(k)).length;
  cb.checked = checkedCount === leafKeys.length && leafKeys.length > 0;
  cb.indeterminate = checkedCount > 0 && checkedCount < leafKeys.length;
  cb.addEventListener("change", () => {
    if (cb.checked) leafKeys.forEach(k => selectedLayerKeys.add(k));
    else leafKeys.forEach(k => selectedLayerKeys.delete(k));
    updateMapMarkers();
    updateMapStatus();
      renderLayers();
  });
  row.appendChild(cb);

  const labelEl = document.createElement("span");
  labelEl.className = "layerLabel";
  labelEl.textContent = node.label;
  if (node.layer) {
    const cnt = document.createElement("span");
    cnt.className = "layerCount";
    cnt.textContent = ` (${node.layer.count})`;
    labelEl.appendChild(cnt);
  }
  row.appendChild(labelEl);

  container.appendChild(row);

  if (hasChildren && isExpanded) {
    for (const child of node.children.values()) {
      renderLayerNode(child, depth + 1, container);
    }
  }
}

function renderLayers() {
  const hasLayers = availableLayers.length > 0;
  layersPanel.hidden = !hasLayers;
  layersListEl.innerHTML = "";

  if (!hasLayers) return;

  layersHint.textContent = `Select layers to include (${availableLayers.length} available).`;

  const tree = buildLayerTree(availableLayers);
  for (const node of tree.values()) {
    renderLayerNode(node, 0, layersListEl);
  }

}

function addFiles(fileListLike) {
  for (const f of fileListLike) selectedFiles.push(f);

  // de-dupe by name+size+lastModified
  const seen = new Set();
  selectedFiles = selectedFiles.filter((f) => {
    const k = fileKey(f);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  renderFiles();
  inspectFilesForFields().catch(err => {
    log(`Inspect failed: ${err?.message || String(err)}`);
    setStatus("Error");
  });
}

function clearFiles() {
  selectedFiles = [];
  fileInput.value = "";
  logEl.textContent = "";
  hideProgress();
  setStatus("Idle");

  availableFields = [];
  selectedFieldKeys = new Set();
  availableLayers = [];
  selectedLayerKeys = new Set();
  collapsedLayerNodes.clear();
  displayLayerKey = null;
  mapLayerSelect.innerHTML = '<option value="">All layers</option>';
  mapLayerSelect.hidden = true;
  currentSessionId = null;
  parsedCache.clear();
  clearSpatialFilter();
  if (markersLayer) markersLayer.clearLayers();
  updateMapStatus();

  renderLayers();
  renderFields();
  renderFiles();
}

dropzone.addEventListener("click", (e) => { if (!e.target.closest("label")) fileInput.click(); });
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") fileInput.click();
});
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("drag");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag");
  addFiles(e.dataTransfer.files);
});

fileInput.addEventListener("change", () => addFiles(fileInput.files));
btnClear.addEventListener("click", clearFiles);

btnKeepAll.addEventListener("click", () => {
  selectedFieldKeys = new Set(availableFields.map(f => f.key));
  renderFields();
  renderFiles();
});
btnDropAll.addEventListener("click", () => {
  selectedFieldKeys = new Set();
  renderFields();
  renderFiles();
});
btnKeepGeo.addEventListener("click", () => {
  const keep = new Set();
  for (const k of ["source", "placemark_id", "name", "lat", "lon", "alt"]) {
    if (availableFields.some(f => f.key === k)) keep.add(k);
  }
  selectedFieldKeys = keep;
  renderFields();
  renderFiles();
});

btnSelectAllLayers.addEventListener("click", () => {
  selectedLayerKeys = new Set(availableLayers.map(l => l.key));
  renderLayers();
  updateMapMarkers();
  updateMapStatus();
});
btnDeselectAllLayers.addEventListener("click", () => {
  selectedLayerKeys = new Set();
  renderLayers();
  updateMapMarkers();
  updateMapStatus();
});

/* =========================
   MAP (Leaflet + Leaflet.draw)
   ========================= */

function initMap() {
  if (leafletMap) return;

  mapPanel.hidden = false;

  leafletMap = L.map(mapEl).setView([39.83, -98.58], 4);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19
  }).addTo(leafletMap);

  markersLayer = L.layerGroup().addTo(leafletMap);
  drawnItems = new L.FeatureGroup().addTo(leafletMap);

  drawControl = new L.Control.Draw({
    draw: {
      polyline: false,
      circle: false,
      circlemarker: false,
      marker: false,
      rectangle: { shapeOptions: { color: "#2f6dff", weight: 2 } },
      polygon: { shapeOptions: { color: "#2f6dff", weight: 2 }, allowIntersection: false }
    },
    edit: { featureGroup: drawnItems }
  });
  leafletMap.addControl(drawControl);

  leafletMap.on(L.Draw.Event.CREATED, (e) => {
    drawnItems.clearLayers();
    drawnItems.addLayer(e.layer);
    spatialFilter = e.layer;
    btnClearFilter.disabled = false;
    updateMapMarkers();
    updateMapStatus();
    log("Spatial filter applied. Only points inside the shape will be exported.");
  });

  leafletMap.on(L.Draw.Event.EDITED, () => {
    const layers = drawnItems.getLayers();
    spatialFilter = layers.length > 0 ? layers[0] : null;
    updateMapMarkers();
    updateMapStatus();
  });

  leafletMap.on(L.Draw.Event.DELETED, () => {
    clearSpatialFilter();
    updateMapMarkers();
    updateMapStatus();
  });
}

function hideMap() {
  if (leafletMap) {
    leafletMap.remove();
    leafletMap = null;
    markersLayer = null;
    drawnItems = null;
    drawControl = null;
  }
  mapPanel.hidden = true;
  mapStatus.textContent = "";
}

function clearSpatialFilter() {
  spatialFilter = null;
  if (drawnItems) drawnItems.clearLayers();
  btnClearFilter.disabled = true;
  updateMapStatus();
}

btnClearFilter.addEventListener("click", () => {
  clearSpatialFilter();
  updateMapMarkers();
  log("Spatial filter cleared. All points will be exported.");
});

mapLayerSelect.addEventListener('change', () => {
  displayLayerKey = mapLayerSelect.value || null;
  updateMapMarkers();
  updateMapStatus();
});

polygonLayerSelect.addEventListener("change", () => {
  const key = polygonLayerSelect.value;
  if (!key) return;
  polygonLayerSelect.value = '';

  const allRows = parsedCache.get("__server__")?.rows || [];
  const layerRows = allRows.filter(r =>
    r.placemark_uid === key && (r.geometry_type === 'Polygon' || r.geometry_type === 'LinearRing')
  );
  if (layerRows.length === 0) {
    log(`No polygon geometry found for element: ${key}`);
    return;
  }
  const latlngs = layerRows.map(r => L.latLng(r.lat, r.lon));
  if (latlngs.length < 3) {
    log(`Not enough points to form a polygon for element: ${key}`);
    return;
  }
  initMap();
  drawnItems.clearLayers();
  const polygon = L.polygon(latlngs, { color: "#2f6dff", weight: 2 });
  drawnItems.addLayer(polygon);
  spatialFilter = polygon;
  btnClearFilter.disabled = false;
  leafletMap.fitBounds(polygon.getBounds().pad(0.1));
  updateMapMarkers();
  updateMapStatus();
  const selOpt = polygonLayerSelect.querySelector(`option[value="${CSS.escape(key)}"]`);
  const elLabel = selOpt ? selOpt.textContent : key;
  log(`Spatial filter applied from element: ${elLabel} (${latlngs.length} points)`);
});

btnUploadPolygon.addEventListener("click", () => polygonFileInput.click());

polygonFileInput.addEventListener("change", async () => {
  const file = polygonFileInput.files[0];
  if (!file) return;
  polygonFileInput.value = "";

  log(`Uploading polygon filter: ${file.name}…`);
  const form = new FormData();
  form.append("file", file);

  try {
    const res = await fetch("parse-polygon", { method: "POST", headers: userHeaders(), body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      log(`Polygon error: ${err.error || res.statusText}`);
      return;
    }
    const { coords } = await res.json();
    if (!coords || coords.length < 3) {
      log("No polygon found in uploaded file.");
      return;
    }

    initMap();
    drawnItems.clearLayers();
    const latlngs = coords.map(([lat, lng]) => L.latLng(lat, lng));
    const polygon = L.polygon(latlngs, { color: "#2f6dff", weight: 2 });
    drawnItems.addLayer(polygon);
    spatialFilter = polygon;
    btnClearFilter.disabled = false;
    leafletMap.fitBounds(polygon.getBounds().pad(0.1));
    updateMapMarkers();
    updateMapStatus();
    log(`Spatial filter applied from ${file.name}.`);
  } catch (e) {
    log(`Polygon error: ${e?.message || String(e)}`);
  }
});

function getAllParsedRows() {
  const cached = parsedCache.get("__server__");
  return cached ? cached.rows : [];
}

function isPointInFilter(lat, lon) {
  if (!spatialFilter) return true;
  const latlng = L.latLng(lat, lon);
  if (spatialFilter instanceof L.Rectangle) {
    return spatialFilter.getBounds().contains(latlng);
  }
  if (spatialFilter instanceof L.Polygon) {
    return pointInPolygon(latlng, spatialFilter);
  }
  return true;
}

function pointInPolygon(latlng, polygon) {
  const latlngs = polygon.getLatLngs()[0];
  if (!latlngs || latlngs.length < 3) return false;
  const x = latlng.lat;
  const y = latlng.lng;
  let inside = false;
  for (let i = 0, j = latlngs.length - 1; i < latlngs.length; j = i++) {
    const xi = latlngs[i].lat, yi = latlngs[i].lng;
    const xj = latlngs[j].lat, yj = latlngs[j].lng;
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function getLayerFilteredRows() {
  const all = getAllParsedRows();
  if (!displayLayerKey) return all;
  return all.filter(r => (r.layer ?? "(Ungrouped)") === displayLayerKey);
}

function updateMapMarkers() {
  if (!markersLayer) return;
  markersLayer.clearLayers();

  const rows = getLayerFilteredRows();
  const PRIORITY_RE = /address|household/i;
  const isPriority = !displayLayerKey || PRIORITY_RE.test(displayLayerKey);
  const MAP_CAP = isPriority ? Infinity : 5000;
  const capped = rows.length > MAP_CAP;
  const displayRows = capped ? rows.slice(0, MAP_CAP) : rows;
  let insideCount = 0;

  for (const r of displayRows) {
    if (r.lat == null || r.lon == null) continue;
    const inside = isPointInFilter(r.lat, r.lon);
    if (inside) insideCount++;

    const color = spatialFilter ? (inside ? "#2f6dff" : "#666") : "#2f6dff";
    const radius = spatialFilter ? (inside ? 5 : 3) : 4;
    const opacity = spatialFilter ? (inside ? 1 : 0.35) : 0.8;

    L.circleMarker([r.lat, r.lon], {
      radius,
      color,
      fillColor: color,
      fillOpacity: opacity,
      weight: 1
    }).bindPopup(`<b>${escapeHtml(r.name || "Point")}</b><br>Lat: ${r.lat}<br>Lon: ${r.lon}`)
      .addTo(markersLayer);
  }

  if (capped) {
    log(`Map showing first ${MAP_CAP.toLocaleString()} of ${rows.length.toLocaleString()} points. All rows are included in CSV export.`);
  }

  return { total: rows.length, inside: insideCount };
}

function updateMapStatus() {
  const rows = getLayerFilteredRows();
  if (!spatialFilter) {
    mapStatus.textContent = `${rows.length} point(s) shown. Draw a shape to filter.`;
    return;
  }
  let insideCount = 0;
  for (const r of rows) {
    if (r.lat != null && r.lon != null && isPointInFilter(r.lat, r.lon)) insideCount++;
  }
  mapStatus.textContent = `${insideCount} of ${rows.length} point(s) inside filter.`;
}

function showPointsOnMap() {
  const allRows = getAllParsedRows();
  if (allRows.length === 0) {
    hideMap();
    return;
  }

  initMap();
  leafletMap.invalidateSize();
  updateMapMarkers();

  // Fit map to all points (regardless of layer filter)
  const bounds = [];
  for (const r of allRows) {
    if (r.lat != null && r.lon != null) bounds.push([r.lat, r.lon]);
  }
  if (bounds.length > 0) {
    leafletMap.fitBounds(L.latLngBounds(bounds).pad(0.1));
  }

  updateMapStatus();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* =========================
   INSPECTION (server)
   ========================= */

function applyInspectResponse(data) {
  currentSessionId = data.sessionId;

  parsedCache.clear();
  parsedCache.set("__server__", { rows: data.rows, fields: data.fields });

  const preferredOrder = ["source", "layer", "geometry_type", "placemark_id", "name", "Address ID", "Address", "City", "State", "ZIP", "lat", "lon", "alt"];
  availableFields = data.fields.slice().sort((a, b) => {
    const ia = preferredOrder.indexOf(a.key);
    const ib = preferredOrder.indexOf(b.key);
    const pa = ia === -1 ? 999 : ia;
    const pb = ib === -1 ? 999 : ib;
    if (pa !== pb) return pa - pb;
    return a.key.localeCompare(b.key);
  });

  availableLayers = data.layers;
  selectedFieldKeys = new Set(availableFields.map(f => f.key));

  // Select ALL layers for export
  selectedLayerKeys = new Set(availableLayers.map(l => l.key));

  // Default map display to the first household layer, otherwise show all
  const HOUSEHOLD_RE = /household/i;
  const householdLayer = availableLayers.find(l => HOUSEHOLD_RE.test(l.key));
  displayLayerKey = householdLayer ? householdLayer.key : null;

  // Populate map layer dropdown
  mapLayerSelect.innerHTML = '<option value="">All layers</option>';
  for (const lyr of availableLayers) {
    const opt = document.createElement('option');
    opt.value = lyr.key;
    opt.textContent = lyr.key.split(' / ').pop() + ` (${lyr.count})`;
    opt.title = lyr.key;
    mapLayerSelect.appendChild(opt);
  }
  mapLayerSelect.value = displayLayerKey || '';
  mapLayerSelect.hidden = availableLayers.length <= 1;

  // Collapse all top-level tree nodes by default
  collapsedLayerNodes.clear();
  for (const l of availableLayers) {
    collapsedLayerNodes.add(l.key.split(' / ')[0]);
  }

  renderLayers();
  renderFields();
  renderFiles();

  // Populate polygon-layer picker: one entry per named polygon placemark
  const allRows = parsedCache.get("__server__")?.rows || [];
  const polyPlacemarks = new Map();
  for (const r of allRows) {
    if ((r.geometry_type === 'Polygon' || r.geometry_type === 'LinearRing') && !polyPlacemarks.has(r.placemark_uid)) {
      polyPlacemarks.set(r.placemark_uid, { name: r.name || '', layer: r.layer });
    }
  }
  polygonLayerSelect.innerHTML = '<option value="">Use element as filter…</option>';
  const pmLabel = ({ name, layer }) => name || layer.split(' / ').pop();
  const pmSort = (a, b) => {
    const la = pmLabel(a[1]), lb = pmLabel(b[1]);
    const aNum = /^\d/.test(la), bNum = /^\d/.test(lb);
    if (aNum !== bNum) return aNum ? -1 : 1;
    return la.localeCompare(lb, undefined, { numeric: true, sensitivity: 'base' });
  };
  const sortedPlacemarks = [...polyPlacemarks.entries()].sort(pmSort);
  for (const [uid, { name, layer }] of sortedPlacemarks) {
    const opt = document.createElement('option');
    opt.value = uid;
    opt.textContent = pmLabel({ name, layer });
    opt.title = layer + (name ? ' — ' + name : '');
    polygonLayerSelect.appendChild(opt);
  }
  polygonLayerSelect.hidden = polyPlacemarks.size === 0;
  polygonLayerSelect.value = '';

  setStatus("Idle");
  log(`Parsed ${data.rows.length} row(s) across ${selectedFiles.length} file(s).`);
  const rowsBySource = new Map();
  for (const r of data.rows) {
    rowsBySource.set(r.source, (rowsBySource.get(r.source) || 0) + 1);
  }
  for (const [src, count] of rowsBySource) log(`  → ${src}: ${count} row(s)`);

  const geomCounts = {};
  for (const r of data.rows) {
    const gt = r.geometry_type || 'point';
    geomCounts[gt] = (geomCounts[gt] || 0) + 1;
  }
  log(`Geometry: ${Object.entries(geomCounts).map(([k,v]) => `${v} ${k}(s)`).join(', ') || 'none'}`);

  log(`${availableFields.length} field(s) discovered, ${availableLayers.length} layer(s).`);
  for (const f of availableFields) log(`  field: ${f.key} (${f.type || 'text'})`);
  for (const lyr of availableLayers) log(`  layer: ${lyr.key} — ${lyr.count} row(s)`);

  hideProgress();
  showPointsOnMap();
}

async function inspectFilesForFields() {
  if (!selectedFiles.length) {
    availableFields = [];
    selectedFieldKeys = new Set();
    availableLayers = [];
    selectedLayerKeys = new Set();
    currentSessionId = null;
    parsedCache.clear();
    renderLayers();
    renderFields();
    renderFiles();
    return;
  }

  setStatus("Uploading…");
  showProgress(false, 0);
  log(`Uploading ${selectedFiles.length} file(s) for inspection…`);
  for (const f of selectedFiles) log(`  → ${f.name} (${humanSize(f.size)})`);

  const form = new FormData();
  for (const f of selectedFiles) form.append("files[]", f);

  const data = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "inspect");
    xhr.setRequestHeader('X-User-Id', userId);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        showProgress(false, pct);
        setStatus(`Uploading… ${pct}%`);
      }
    };

    xhr.upload.onload = () => {
      showProgress(true);
      setStatus("Parsing…");
      log("Upload complete — server parsing KML/KMZ…");
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error("Invalid response from server")); }
      } else {
        try { reject(new Error(JSON.parse(xhr.responseText).error || xhr.statusText)); }
        catch { reject(new Error(xhr.statusText)); }
      }
    };

    xhr.onerror = () => {
      hideProgress();
      reject(new Error("Network error during upload"));
    };

    xhr.send(form);
  });

  applyInspectResponse(data);
}

/* =========================
   Conversion (server builds CSV)
   ========================= */

async function convertAll() {
  if (!selectedFiles.length) return;
  if (selectedFieldKeys.size === 0) {
    log("No fields selected. Pick at least one column to keep.");
    return;
  }
  if (!currentSessionId) {
    log("No active session. Please re-add your files.");
    return;
  }

  const delimiter     = delimiterEl.value === "\\t" ? "\t" : delimiterEl.value;
  const includeHeader = includeHeaderEl.checked;
  const precision     = useDefaultPrecisionEl.checked ? 6 : clampInt(parseInt(precisionEl.value, 10), 0, 10);
  const keepCrossing  = keepCrossingLinesEl.checked;
  const fieldKeys     = orderFieldKeys(Array.from(selectedFieldKeys), availableFields);

  setStatus("Working…");
  showProgress(true);
  btnConvert.disabled = true;
  btnClear.disabled = true;
  log(`Starting conversion…`);
  log(`  Fields (${fieldKeys.length}): ${fieldKeys.slice(0, 6).join(', ')}${fieldKeys.length > 6 ? ` +${fieldKeys.length - 6} more` : ''}`);
  log(`  Layers: ${selectedLayerKeys.size} of ${availableLayers.length} selected`);
  if (spatialFilter) {
    log(`  Spatial filter: ${spatialFilter instanceof L.Rectangle ? 'rectangle' : 'polygon'} active`);
  } else {
    log(`  Spatial filter: none`);
  }
  log(`  Delimiter: ${delimiter === '\t' ? 'tab' : `"${delimiter}"`}, precision: ${precision}, header: ${includeHeader}`);
  log(`Sending request to server…`);

  try {
    const res = await fetch("convert", {
      method: "POST",
      headers: userHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        sessionId: currentSessionId,
        fieldKeys,
        layerKeys: Array.from(selectedLayerKeys),
        spatialFilter: serializeSpatialFilter(spatialFilter),
        keepCrossingLines: keepCrossing,
        delimiter,
        precision,
        includeHeader
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }

    const cd       = res.headers.get("content-disposition") || "";
    const match    = cd.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : "converted.zip";

    const contentLength = res.headers.get("content-length");
    const total = contentLength ? parseInt(contentLength, 10) : null;
    if (total) showProgress(false, 0);

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total) showProgress(false, Math.round((received / total) * 100));
    }
    const blob = new Blob(chunks);
    downloadBlob(blob, filename);

    currentSessionId = null;
    log(`Conversion complete.`);
    log(`  Output: ${filename} (${humanSize(blob.size)})`);
    log(`  Received ${chunks.length} chunk(s), ${humanSize(received)} total`);
    setStatus("Done");
    hideProgress();

  } catch (e) {
    log(`FATAL: ${e?.message || String(e)}`);
    setStatus("Error");
    hideProgress();
  } finally {
    btnConvert.disabled = selectedFiles.length === 0 || selectedFieldKeys.size === 0;
    btnClear.disabled = selectedFiles.length === 0;
  }
}

btnConvert.addEventListener("click", convertAll);

/* =========================
   misc helpers
   ========================= */

function fileKey(f) {
  return `${f.name}:${f.size}:${f.lastModified}`;
}

function stripExt(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

function safeName(s) {
  return s.replace(/[^\w\-\. ]+/g, "_").trim().replace(/\s+/g, "_") || "output";
}

function serializeSpatialFilter(filter) {
  if (!filter) return null;
  if (filter instanceof L.Rectangle) {
    const b = filter.getBounds();
    return { type: "rectangle", bounds: [[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]] };
  }
  if (filter instanceof L.Polygon) {
    const latlngs = filter.getLatLngs()[0];
    return { type: "polygon", coords: latlngs.map(ll => [ll.lat, ll.lng]) };
  }
  return null;
}

function clampInt(v, min, max) {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function hashKey(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function makeId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const rand = Math.random().toString(16).slice(2);
  const time = Date.now().toString(16);
  return `id_${time}_${rand}`;
}

function orderFieldKeys(keys, fields) {
  const order = new Map(fields.map((f, i) => [f.key, i]));
  return keys.slice().sort((a, b) => (order.get(a) ?? 9999) - (order.get(b) ?? 9999));
}

useDefaultPrecisionEl.addEventListener("change", updatePrecisionVisibility);
updatePrecisionVisibility();

renderFiles();
renderLayers();
renderFields();
setStatus("Idle");
log("Ready.");
initMap();
