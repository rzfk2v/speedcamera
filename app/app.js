'use strict';

/* Nordic Speed Camera Alert — standalone PWA.
   Foreground geolocation -> directional proximity detection -> spoken + visual warning.
   Camera data: OSM highway=speed_camera, bundled as cameras.json (see ../data). */

const CONFIG = {
  searchRadius: 1200,  // m — only consider cameras within this range
  leadSeconds: 18,     // warn ~this many seconds before reaching the camera
  minWarn: 250,        // m — floor for the pre-warning distance
  maxWarn: 800,        // m — ceiling for the pre-warning distance
  nearDist: 180,       // m — second, closer chime + red flash
  aheadCone: 55,       // deg — camera must be within this of heading to count as "ahead"
  dirTolerance: 70,    // deg — camera's enforced direction must match heading within this
  passClear: 1.6,      // clear a camera once distance > warnDist * this (we've passed it)
  minMoveSpeed: 1.5,   // m/s (~5 km/h) — below this we don't warn (parked / crawling)
  poorAccuracy: 100,   // m — above this the fix is too coarse to warn on (shows a banner)
  radarRange: 1000,    // m — outer ring of the radar view
};

const APP_VERSION = 'v0.3';

let CAMERAS = [];
let muted = false;
let radarOn = localStorage.getItem('radarOn') !== '0';  // default ON
let wakeLock = null;
let prev = null;            // previous fix {lat,lon,t}
let derivedHeading = null;  // heading inferred from movement when GPS heading is absent
const warnState = { id: null, stage: 0 };  // 0 none, 1 pre-warned, 2 near-warned

// ---------- geo helpers ----------
const R = 6371000;
const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;

function haversine(lat1, lon1, lat2, lon2){
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function bearing(lat1, lon1, lat2, lon2){
  const y = Math.sin(toRad(lon2-lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1))*Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1))*Math.cos(toRad(lat2))*Math.cos(toRad(lon2-lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}
function angleDiff(a, b){
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// ---------- data ----------
function loadCameras(){
  return fetch('cameras.json').then(r => r.json()).then(d => {
    CAMERAS = (d.cameras || []).map(c => ({
      id: c.id, lat: c.lat, lon: c.lon,
      dir: c.dir != null ? parseFloat(c.dir) : null,
      limit: c.maxspeed != null ? parseInt(c.maxspeed, 10) : null,
    }));
    return d;
  });
}

// ---------- core loop ----------
function nearestAhead(lat, lon, heading){
  let best = null, bestD = Infinity;
  for (const cam of CAMERAS){
    const d = haversine(lat, lon, cam.lat, cam.lon);
    if (d > CONFIG.searchRadius || d >= bestD) continue;
    if (heading != null){
      if (angleDiff(heading, bearing(lat, lon, cam.lat, cam.lon)) > CONFIG.aheadCone) continue; // behind/beside us
      if (cam.dir != null && angleDiff(heading, cam.dir) > CONFIG.dirTolerance) continue;        // opposite carriageway
    }
    best = cam; bestD = d;
  }
  if (best) best._d = bestD;
  return best;
}

function warnDistFor(speed){
  return Math.min(CONFIG.maxWarn, Math.max(CONFIG.minWarn, speed * CONFIG.leadSeconds));
}

function onPosition(pos){
  const c = pos.coords, t = pos.timestamp;
  const lat = c.latitude, lon = c.longitude;

  let speed = (c.speed != null && !Number.isNaN(c.speed)) ? Math.max(0, c.speed) : 0;
  if (prev){
    const moved = haversine(prev.lat, prev.lon, lat, lon);
    const dt = (t - prev.t) / 1000;
    if (dt > 0 && (c.speed == null || Number.isNaN(c.speed))) speed = moved / dt;
    if (moved > 5) derivedHeading = bearing(prev.lat, prev.lon, lat, lon);
  }
  const heading = (c.heading != null && !Number.isNaN(c.heading) && speed > 1)
    ? c.heading : derivedHeading;
  prev = { lat, lon, t };

  const acc = c.accuracy;
  updateSpeedUI(speed, acc);
  updateGpsBanner(acc);
  drawRadar(lat, lon, heading);

  const accurate = acc != null && acc <= CONFIG.poorAccuracy;
  const reliable = accurate && heading != null && speed >= CONFIG.minMoveSpeed;
  const target = reliable ? nearestAhead(lat, lon, heading) : null;
  handleWarning(target, speed);
  updateNextCamUI(target);
}

function handleWarning(target, speed){
  if (!target){ clearAlertUI(); warnState.id = null; warnState.stage = 0; return; }

  const d = target._d;
  const wd = warnDistFor(speed);

  if (warnState.id !== target.id){ warnState.id = target.id; warnState.stage = 0; }

  if (d > wd * CONFIG.passClear){ clearAlertUI(); warnState.stage = 0; return; }

  showAlertUI(target, d);

  if (warnState.stage < 1 && d <= wd){
    warnState.stage = 1;
    beep(0.12, 880);
    speakCamera(target);
  } else if (warnState.stage < 2 && d <= CONFIG.nearDist){
    warnState.stage = 2;
    beep(0.22, 1320);
  }
}

// ---------- audio ----------
let audioCtx = null;
function beep(dur = 0.12, freq = 880){
  if (muted) return;
  try{
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = freq;
    o.connect(g); g.connect(audioCtx.destination);
    const now = audioCtx.currentTime;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.4, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    o.start(now); o.stop(now + dur + 0.02);
  }catch(e){ /* ignore */ }
}
function speak(text){
  if (muted || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05; u.lang = 'en-GB';
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
function speakCamera(cam){
  speak(cam.limit ? `Speed camera ahead, limit ${cam.limit}` : 'Speed camera ahead');
}

// ---------- UI ----------
const $ = id => document.getElementById(id);
function updateSpeedUI(speed, acc){
  $('speed').textContent = Math.round(speed * 3.6);
  $('gpsStatus').textContent = acc != null ? `GPS ±${Math.round(acc)} m` : 'waiting for GPS…';
}
function updateNextCamUI(target){
  $('nextCam').textContent = target ? `camera ${Math.round(target._d)} m ahead` : 'no camera ahead';
}
function updateGpsBanner(acc){
  const b = $('gpsBanner');
  if (acc == null){
    b.textContent = '📡 Acquiring GPS…';
    b.className = 'banner';
  } else if (acc > CONFIG.poorAccuracy){
    b.textContent = `⚠ GPS accuracy low (±${Math.round(acc)} m) — turn on Precise location and move to open sky`;
    b.className = 'banner warn';
  } else {
    b.className = 'banner hidden';
  }
}

const radarRings = [250, 500, 1000]; // metres
function drawRadar(lat, lon, heading){
  const cv = $('radar'); if (!cv || cv.classList.contains('hidden')) return;
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const px = Math.round((cv.clientWidth || 300) * dpr);
  if (cv.width !== px){ cv.width = px; cv.height = px; }
  const S = cv.width, cx = S / 2, cy = S / 2, R = (S / 2) * 0.92;
  const maxM = CONFIG.radarRange;
  ctx.clearRect(0, 0, S, S);

  // range rings + labels
  ctx.font = `${12 * dpr}px -apple-system, system-ui, sans-serif`;
  for (const m of radarRings){
    if (m > maxM) continue;
    const rr = R * (m / maxM);
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,.30)';
    ctx.fillText(m >= 1000 ? (m / 1000) + ' km' : m + ' m', cx + 4 * dpr, cy - rr + 15 * dpr);
  }

  const hd = (heading == null) ? 0 : heading;   // heading-up (north-up if heading unknown)
  for (const cam of CAMERAS){
    const d = haversine(lat, lon, cam.lat, cam.lon);
    if (d > maxM) continue;
    const b = bearing(lat, lon, cam.lat, cam.lon);
    const rel = toRad((b - hd + 360) % 360);
    const rr = R * (d / maxM);
    const x = cx + rr * Math.sin(rel), y = cy - rr * Math.cos(rel);
    const ahead = heading != null && angleDiff(hd, b) <= CONFIG.aheadCone &&
                  (cam.dir == null || angleDiff(hd, cam.dir) <= CONFIG.dirTolerance);
    ctx.beginPath();
    ctx.arc(x, y, (ahead ? 5 : 3.5) * dpr, 0, Math.PI * 2);
    ctx.fillStyle = ahead ? '#ff453a' : 'rgba(255,255,255,.32)';
    ctx.fill();
  }

  // "you" marker — arrow pointing up (your direction of travel)
  ctx.save(); ctx.translate(cx, cy); ctx.fillStyle = '#4da3ff';
  ctx.beginPath();
  ctx.moveTo(0, -11 * dpr); ctx.lineTo(8 * dpr, 9 * dpr); ctx.lineTo(0, 5 * dpr); ctx.lineTo(-8 * dpr, 9 * dpr);
  ctx.closePath(); ctx.fill(); ctx.restore();
}
function applyRadar(){
  $('radar').classList.toggle('hidden', !radarOn);
  $('radarBtn').classList.toggle('off', !radarOn);
}
function showAlertUI(cam, d){
  $('alertCard').classList.remove('hidden');
  $('alertDist').textContent = Math.round(d);
  $('alertLimit').textContent = cam.limit ? `limit ${cam.limit} km/h` : '';
  document.body.classList.toggle('danger', d <= CONFIG.nearDist);
}
function clearAlertUI(){
  $('alertCard').classList.add('hidden');
  document.body.classList.remove('danger');
}

// ---------- lifecycle ----------
async function requestWakeLock(){
  try{
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  }catch(e){ /* not fatal */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestWakeLock();
});

function start(){
  $('startScreen').hidden = true;
  $('hud').hidden = false;
  updateGpsBanner(null);   // show "Acquiring GPS…" until the first fix arrives
  beep(0.001, 440);   // unlock WebAudio on the user gesture
  speak(' ');         // prime speechSynthesis
  requestWakeLock();
  if (!('geolocation' in navigator)){ $('gpsStatus').textContent = 'no geolocation support'; return; }
  navigator.geolocation.watchPosition(onPosition,
    err => { $('gpsStatus').textContent = 'GPS error: ' + err.message; },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
}

function init(){
  $('version').textContent = APP_VERSION;
  loadCameras().then(d => {
    $('camCount').textContent = d.count;
    $('startInfo').textContent = `${d.count} cameras loaded · OSM ${d.generated} · ${APP_VERSION}`;
    $('startBtn').disabled = false;
  }).catch(e => { $('startInfo').textContent = 'Failed to load cameras: ' + e; });

  $('startBtn').addEventListener('click', start);
  $('muteBtn').addEventListener('click', () => {
    muted = !muted;
    $('muteBtn').textContent = muted ? '🔇' : '🔊';
    if (muted && 'speechSynthesis' in window) speechSynthesis.cancel();
  });
  $('radarBtn').addEventListener('click', () => {
    radarOn = !radarOn;
    localStorage.setItem('radarOn', radarOn ? '1' : '0');
    applyRadar();
  });
  applyRadar();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();

// Test hook: drive a synthetic position, e.g. __sim(59.5882,16.9969, 25, 180)
window.__sim = (lat, lon, speed = 25, heading = null, accuracy = 5) =>
  onPosition({ coords: { latitude: lat, longitude: lon, speed, heading, accuracy }, timestamp: Date.now() });
