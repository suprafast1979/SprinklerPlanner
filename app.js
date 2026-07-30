
const map = L.map('map', { zoomControl: true }).setView([44.05, -123.1], 16);

const street = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 20,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const imagery = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 20, attribution: 'Tiles &copy; Esri' }
);

L.control.layers({ Satellite: imagery, Streets: street }).addTo(map);
imagery.addTo(map);
street.remove();

let currentPosition = null;
let userMarker = null;
let accuracyCircle = null;
let watchId = null;
let walking = false;
let boundary = [];
let boundaryLine = null;
let boundaryPolygon = null;
let sprinklerMarkers = [];
let sprinklerCircles = [];

const $ = id => document.getElementById(id);
const statusEl = $('status');

function setStatus(text) { statusEl.textContent = text; }

function feetToMeters(ft) { return Number(ft) * 0.3048; }
function metersToFeet(m) { return m / 0.3048; }

function distanceMeters(a, b) {
  const R = 6371000;
  const p1 = a.lat * Math.PI / 180;
  const p2 = b.lat * Math.PI / 180;
  const dp = (b.lat - a.lat) * Math.PI / 180;
  const dl = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function localXY(point, origin) {
  const R = 6371000;
  const lat0 = origin.lat * Math.PI / 180;
  return {
    x: (point.lng - origin.lng) * Math.PI / 180 * R * Math.cos(lat0),
    y: (point.lat - origin.lat) * Math.PI / 180 * R
  };
}

function xyToLatLng(p, origin) {
  const R = 6371000;
  const lat0 = origin.lat * Math.PI / 180;
  return {
    lat: origin.lat + (p.y / R) * 180 / Math.PI,
    lng: origin.lng + (p.x / (R * Math.cos(lat0))) * 180 / Math.PI
  };
}

function pointInPolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > p.y) !== (yj > p.y)) &&
      (p.x < (xj - xi) * (p.y - yi) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function polygonAreaMeters2(points) {
  if (points.length < 3) return 0;
  const origin = points[0];
  const xy = points.map(p => localXY(p, origin));
  let area = 0;
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) {
    area += xy[j].x * xy[i].y - xy[i].x * xy[j].y;
  }
  return Math.abs(area / 2);
}

function updateBoundaryDisplay() {
  if (boundaryLine) map.removeLayer(boundaryLine);
  if (boundaryPolygon) map.removeLayer(boundaryPolygon);

  if (boundary.length >= 2) {
    boundaryLine = L.polyline(boundary, { color: '#176b3a', weight: 4 }).addTo(map);
  }
  if (boundary.length >= 3 && !walking) {
    boundaryPolygon = L.polygon(boundary, {
      color: '#176b3a', weight: 3, fillColor: '#4fae70', fillOpacity: 0.18
    }).addTo(map);
  }

  $('pointCount').textContent = boundary.length;
  const areaM2 = polygonAreaMeters2(boundary);
  $('areaValue').textContent = areaM2 ? `${Math.round(areaM2 * 10.7639).toLocaleString()} sq ft` : '—';
}

function addBoundaryPoint(point, force = false) {
  if (!point) return;
  const last = boundary[boundary.length - 1];
  if (!force && last && distanceMeters(last, point) < 2.5) return;
  boundary.push({ lat: point.lat, lng: point.lng });
  updateBoundaryDisplay();
}

function updatePosition(pos) {
  const p = {
    lat: pos.coords.latitude,
    lng: pos.coords.longitude,
    accuracy: pos.coords.accuracy
  };
  currentPosition = p;
  $('accuracy').textContent = `±${Math.round(metersToFeet(p.accuracy))} ft`;

  if (!userMarker) {
    userMarker = L.circleMarker(p, { radius: 7, color: '#ffffff', weight: 3, fillColor: '#176b3a', fillOpacity: 1 }).addTo(map);
    accuracyCircle = L.circle(p, { radius: p.accuracy, color: '#176b3a', weight: 1, fillOpacity: 0.06 }).addTo(map);
  } else {
    userMarker.setLatLng(p);
    accuracyCircle.setLatLng(p).setRadius(p.accuracy);
  }

  if (walking && p.accuracy <= 12) addBoundaryPoint(p);
  setStatus(`GPS active • accuracy ±${Math.round(metersToFeet(p.accuracy))} ft`);
}

function startGPS(center = false) {
  if (!navigator.geolocation) {
    setStatus('This browser does not support GPS');
    return;
  }
  if (watchId !== null) {
    if (center && currentPosition) map.setView(currentPosition, 19);
    return;
  }
  setStatus('Requesting location permission…');
  watchId = navigator.geolocation.watchPosition(
    pos => {
      updatePosition(pos);
      if (center) {
        map.setView([pos.coords.latitude, pos.coords.longitude], 19);
        center = false;
      }
    },
    err => setStatus(`GPS error: ${err.message}`),
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
  );
}

function finishBoundary() {
  walking = false;
  if (boundary.length >= 3) {
    updateBoundaryDisplay();
    map.fitBounds(L.latLngBounds(boundary), { padding: [25, 25] });
    setStatus('Boundary finished');
  } else {
    setStatus('Add at least 3 boundary points');
  }
}

function clearSprinklers() {
  sprinklerMarkers.forEach(m => map.removeLayer(m));
  sprinklerCircles.forEach(c => map.removeLayer(c));
  sprinklerMarkers = [];
  sprinklerCircles = [];
  updateSprinklerMetrics();
}

function getRadiusMeters() {
  const sizeFt = Math.max(1, Number($('spraySize').value) || 35);
  return feetToMeters($('measureMode').value === 'diameter' ? sizeFt / 2 : sizeFt);
}

function markerIcon(n) {
  return L.divIcon({
    className: '',
    html: `<div class="sprinkler-icon">${n}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });
}

function addSprinkler(latlng, radius, index) {
  const circle = L.circle(latlng, {
    radius, color: '#1670c5', weight: 2, fillColor: '#3a91df', fillOpacity: 0.16
  }).addTo(map);

  const marker = L.marker(latlng, { draggable: true, icon: markerIcon(index + 1) }).addTo(map);
  marker.bindPopup(`Sprinkler ${index + 1}<br>Radius: ${Math.round(metersToFeet(radius))} ft`);
  marker.on('drag', e => circle.setLatLng(e.target.getLatLng()));

  sprinklerMarkers.push(marker);
  sprinklerCircles.push(circle);
}

function generateLayout() {
  if (boundary.length < 3) {
    setStatus('Finish a boundary first');
    return;
  }

  clearSprinklers();
  const radius = getRadiusMeters();
  const spacing = radius * 2 * Number($('overlap').value);
  const rowSpacing = spacing * Math.sqrt(3) / 2;
  const origin = boundary[0];
  const poly = boundary.map(p => localXY(p, origin));

  const xs = poly.map(p => p.x);
  const ys = poly.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  const candidates = [];
  let row = 0;
  for (let y = minY; y <= maxY; y += rowSpacing) {
    const offset = (row % 2) * spacing / 2;
    for (let x = minX + offset; x <= maxX; x += spacing) {
      const p = { x, y };
      if (pointInPolygon(p, poly)) candidates.push(xyToLatLng(p, origin));
    }
    row++;
  }

  if (!candidates.length) {
    const center = boundaryPolygon ? boundaryPolygon.getBounds().getCenter() : boundary[0];
    candidates.push(center);
  }

  candidates.forEach((p, i) => addSprinkler(p, radius, i));
  updateSprinklerMetrics();
  setStatus(`Suggested ${candidates.length} sprinkler location${candidates.length === 1 ? '' : 's'}`);
}

function updateSprinklerMetrics() {
  const radius = getRadiusMeters();
  $('radiusValue').textContent = `${Math.round(metersToFeet(radius))} ft`;
  $('sprinklerCount').textContent = sprinklerMarkers.length;

  const boundaryArea = polygonAreaMeters2(boundary);
  if (boundaryArea && sprinklerMarkers.length) {
    const rawCoverage = sprinklerMarkers.length * Math.PI * radius * radius;
    const ratio = Math.min(100, Math.round(rawCoverage / boundaryArea * 100));
    $('coverageValue').textContent = `${ratio}% raw`;
  } else {
    $('coverageValue').textContent = '—';
  }
}

function serializePlan() {
  return {
    version: 1,
    name: $('planName').value.trim() || 'Sprinkler plan',
    createdAt: new Date().toISOString(),
    boundary,
    measureMode: $('measureMode').value,
    spraySize: Number($('spraySize').value),
    overlap: $('overlap').value,
    sprinklers: sprinklerMarkers.map(m => {
      const p = m.getLatLng();
      return { lat: p.lat, lng: p.lng };
    })
  };
}

function loadPlan(data) {
  if (!data || !Array.isArray(data.boundary)) throw new Error('Invalid plan file');
  boundary = data.boundary;
  walking = false;
  $('planName').value = data.name || 'Sprinkler plan';
  $('measureMode').value = data.measureMode || 'radius';
  $('spraySize').value = data.spraySize || 35;
  $('overlap').value = data.overlap || '0.80';
  updateBoundaryDisplay();
  clearSprinklers();
  const radius = getRadiusMeters();
  (data.sprinklers || []).forEach((p, i) => addSprinkler(p, radius, i));
  updateSprinklerMetrics();
  if (boundary.length) map.fitBounds(L.latLngBounds(boundary), { padding: [25, 25] });
  setStatus(`Loaded ${data.name || 'saved plan'}`);
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tabbody').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    $(`${tab.dataset.tab}Tab`).classList.add('active');
    setTimeout(() => map.invalidateSize(), 100);
  });
});

$('locateBtn').addEventListener('click', () => startGPS(true));
$('startWalkBtn').addEventListener('click', () => {
  startGPS(true);
  walking = true;
  boundary = [];
  clearSprinklers();
  updateBoundaryDisplay();
  setStatus('Walking perimeter • GPS points recording');
});
$('addPointBtn').addEventListener('click', () => {
  startGPS(false);
  if (currentPosition) {
    addBoundaryPoint(currentPosition, true);
    setStatus('Corner point added');
  } else {
    setStatus('Waiting for GPS position');
  }
});
$('finishWalkBtn').addEventListener('click', finishBoundary);
$('clearBoundaryBtn').addEventListener('click', () => {
  walking = false;
  boundary = [];
  clearSprinklers();
  updateBoundaryDisplay();
  setStatus('Boundary cleared');
});
$('generateBtn').addEventListener('click', generateLayout);
$('clearSprinklersBtn').addEventListener('click', clearSprinklers);
$('spraySize').addEventListener('input', updateSprinklerMetrics);
$('measureMode').addEventListener('change', updateSprinklerMetrics);

$('saveBtn').addEventListener('click', () => {
  localStorage.setItem('sprinklerPlannerPlan', JSON.stringify(serializePlan()));
  setStatus('Plan saved on this device');
});
$('loadBtn').addEventListener('click', () => {
  const raw = localStorage.getItem('sprinklerPlannerPlan');
  if (!raw) return setStatus('No saved plan found');
  try { loadPlan(JSON.parse(raw)); } catch (e) { setStatus(e.message); }
});
$('exportBtn').addEventListener('click', () => {
  const data = serializePlan();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${data.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});
$('importInput').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try { loadPlan(JSON.parse(await file.text())); }
  catch (e) { setStatus(`Import failed: ${e.message}`); }
});

map.on('click', e => {
  if (!walking) return;
  addBoundaryPoint(e.latlng, true);
  setStatus('Manual boundary point added');
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js').catch(() => {});
}

updateSprinklerMetrics();
