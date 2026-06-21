'use strict';

/* Speed Camera Alert — standalone PWA.
   Foreground geolocation -> directional proximity detection -> spoken + visual warning.
   Data: OSM highway=speed_camera (points) + enforcement=average_speed (zones). */

const CONFIG = {
  searchRadius: 1200,  // m — only consider cameras within this range
  leadSeconds: 18,     // warn ~this many seconds before reaching the camera
  minWarn: 250,        // m — floor for the pre-warning distance
  maxWarn: 800,        // m — ceiling for the pre-warning distance
  nearDist: 180,       // m — second, closer chime + red flash
  aheadCone: 55,       // deg — camera must be within this of heading to count as "ahead"
  dirTolerance: 70,    // deg — camera's enforced direction must match heading within this
  passClear: 1.6,      // clear once distance > warnDist * this (we've passed it)
  minMoveSpeed: 1.5,   // m/s (~5 km/h) — below this we don't warn (parked / crawling)
  poorAccuracy: 250,   // m — warnings paused + banner above this (coarse/approximate fix;
                       // 100 m was too strict — it muted real warnings on normal driving GPS jitter)
  radarRange: 1000,    // m — outer ring of the radar view
};

const CONFIG_DEFAULTS = { ...CONFIG };
for (const k of Object.keys(CONFIG)){
  const v = localStorage.getItem('cfg_' + k);
  if (v != null) CONFIG[k] = Number(v);
}

const APP_VERSION = 'v0.14';

let CAMERAS = [];
let ZONES = [];
let muted = false;
let radarOn = localStorage.getItem('radarOn') !== '0';   // default ON
let diagOn = localStorage.getItem('diag') !== '0';       // diagnostics line, default ON
let animOn = localStorage.getItem('anim') !== '0';       // radar animation (sweep/pulse), default ON
let vibrateOn = localStorage.getItem('vibrate') !== '0'; // haptic feedback, default ON
let units = localStorage.getItem('units') || 'metric';   // 'metric' | 'imperial'
let lang  = localStorage.getItem('lang')  || 'en';       // 'en' | 'sv'
let voiceName = localStorage.getItem('voice') || '';     // '' = auto
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

// ---------- units & language ----------
function speedNum(mps){ return Math.round(mps * (units === 'imperial' ? 2.236936 : 3.6)); }
function speedUnit(){ return units === 'imperial' ? 'mph' : 'km/h'; }
function limitNum(kmh){ return units === 'imperial' ? Math.round(kmh * 0.621371) : kmh; }
function distLabel(m){
  if (units === 'imperial'){
    const yd = m * 1.093613;
    if (yd >= 1760){ const mi = yd / 1760; return (Number.isInteger(mi) ? mi : mi.toFixed(1)) + ' mi'; }
    return Math.round(yd) + ' yd';
  }
  if (m >= 1000){ const km = m / 1000; return (Number.isInteger(km) ? km : km.toFixed(1)) + ' km'; }
  return Math.round(m) + ' m';
}
function cameraPhrase(limitKmh){
  const n = limitKmh ? limitNum(limitKmh) : null;
  if (lang === 'sv') return n ? `Fartkamera, ${n}` : 'Fartkamera';
  return n ? `Speed camera ahead, limit ${n}` : 'Speed camera ahead';
}
function zonePhrase(limitKmh){
  const n = limitKmh ? limitNum(limitKmh) : null;
  if (lang === 'sv') return n ? `Medelhastighetskontroll, ${n}` : 'Medelhastighetskontroll';
  return n ? `Average speed zone, limit ${n}` : 'Average speed zone';
}
function zoneEndPhrase(){ return lang === 'sv' ? 'Slut på medelhastighetskontroll' : 'End of average speed zone'; }
function pickVoice(){
  const vs = ('speechSynthesis' in window) ? speechSynthesis.getVoices() : [];
  if (voiceName){ const v = vs.find(v => v.name === voiceName); if (v) return v; }
  const pref = lang === 'sv' ? 'sv' : 'en';
  return vs.find(v => v.lang.toLowerCase().startsWith(pref) && v.localService)
      || vs.find(v => v.lang.toLowerCase().startsWith(pref)) || null;
}

// ---------- data ----------
function loadCameras(){
  return fetch('cameras.json').then(r => r.json()).then(d => {
    CAMERAS = (d.cameras || []).map(c => ({
      id: c.id, lat: c.lat, lon: c.lon,
      dir: c.dir != null ? parseFloat(c.dir) : null,
      limit: c.maxspeed != null ? parseInt(c.maxspeed, 10) : null,
    }));
    ZONES = (d.zones || []).map(z => ({
      id: z.id,
      a: { lat: z.a[0], lon: z.a[1] },
      b: { lat: z.b[0], lon: z.b[1] },
      limit: z.maxspeed != null ? parseInt(z.maxspeed, 10) : null,
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

// The relevant average-speed-zone event ahead: 'start' if we're approaching an entry
// while heading into the zone, or 'end' if we're inside and approaching the exit.
function nearestZoneEvent(lat, lon, heading){
  if (heading == null) return null;
  let best = null, bestD = Infinity;
  for (const z of ZONES){
    const dirAB = bearing(z.a.lat, z.a.lon, z.b.lat, z.b.lon);
    let entry, exit;
    if (angleDiff(heading, dirAB) <= CONFIG.dirTolerance){ entry = z.a; exit = z.b; }
    else if (angleDiff(heading, (dirAB + 180) % 360) <= CONFIG.dirTolerance){ entry = z.b; exit = z.a; }
    else continue;  // not travelling along this zone
    const dE = haversine(lat, lon, entry.lat, entry.lon);
    const dX = haversine(lat, lon, exit.lat, exit.lon);
    const entryAhead = angleDiff(heading, bearing(lat, lon, entry.lat, entry.lon)) <= CONFIG.aheadCone;
    const exitAhead  = angleDiff(heading, bearing(lat, lon, exit.lat, exit.lon))  <= CONFIG.aheadCone;
    if (entryAhead && dE <= CONFIG.searchRadius && dE < bestD){
      best = { type:'zone', kind:'start', id:'zs' + z.id, dist:dE, limit:z.limit, title:'AVG SPEED ZONE' };
      bestD = dE;
    } else if (!entryAhead && exitAhead && dX <= CONFIG.searchRadius && dX < bestD){
      best = { type:'zone', kind:'end', id:'ze' + z.id, dist:dX, limit:null, title:'ZONE END' };
      bestD = dX;
    }
  }
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
  updateRadar(lat, lon, heading);

  const accurate = acc != null && acc <= CONFIG.poorAccuracy;
  const reliable = accurate && heading != null && speed >= CONFIG.minMoveSpeed;
  let active = null;
  if (reliable){
    const cam = nearestAhead(lat, lon, heading);
    const ze = nearestZoneEvent(lat, lon, heading);
    if (cam && (!ze || cam._d <= ze.dist))
      active = { type:'cam', id:'c' + cam.id, dist:cam._d, limit:cam.limit, title:'SPEED CAMERA' };
    else if (ze) active = ze;
  }
  handleAlert(active, speed);
  updateNextCamUI(active);
  $('diag').textContent = diagOn ? diagnose(lat, lon, heading, speed, acc, active) : '';
}

// Explain why the nearest point camera is NOT producing a spoken warning (field debugging).
function diagnose(lat, lon, heading, speed, acc, active){
  if (active) return '';   // something IS warning — the alert card shows it
  let nd = Infinity, nc = null;
  for (const cam of CAMERAS){
    const d = haversine(lat, lon, cam.lat, cam.lon);
    if (d < nd){ nd = d; nc = cam; }
  }
  if (!nc || nd > CONFIG.searchRadius) return '';   // nothing close enough to explain
  const pre = `nearest cam ${distLabel(nd)} — `;
  if (acc == null) return pre + 'acquiring GPS';
  if (acc > CONFIG.poorAccuracy) return pre + `GPS ±${distLabel(acc)} (paused)`;
  if (speed < CONFIG.minMoveSpeed) return pre + 'too slow/stopped';
  if (heading == null) return pre + 'no heading yet';
  if (angleDiff(heading, bearing(lat, lon, nc.lat, nc.lon)) > CONFIG.aheadCone) return pre + 'behind/beside you';
  if (nc.dir != null && angleDiff(heading, nc.dir) > CONFIG.dirTolerance) return pre + 'enforces other direction';
  return pre + 'in range';
}

function handleAlert(active, speed){
  if (!active){ clearAlertUI(); warnState.id = null; warnState.stage = 0; return; }

  const d = active.dist, wd = warnDistFor(speed);
  if (warnState.id !== active.id){ warnState.id = active.id; warnState.stage = 0; }
  if (d > wd * CONFIG.passClear){ clearAlertUI(); warnState.stage = 0; return; }

  showAlertUI(active, d);

  if (warnState.stage < 1 && d <= wd){
    warnState.stage = 1;
    beep(0.12, active.type === 'zone' ? 660 : 880);
    vibrate(200);
    announce(active);
  } else if (warnState.stage < 2 && d <= CONFIG.nearDist){
    warnState.stage = 2;
    beep(0.22, 1320);
    vibrate([200, 100, 300]);
  }
}
function announce(active){
  if (active.type === 'cam') speak(cameraPhrase(active.limit));
  else if (active.kind === 'start') speak(zonePhrase(active.limit));
  else speak(zoneEndPhrase());
}

// ---------- haptic ----------
function vibrate(pattern){
  if (vibrateOn && navigator.vibrate) navigator.vibrate(pattern);
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
function utter(text){            // build an utterance with the chosen voice/lang
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v){ u.voice = v; u.lang = v.lang; } else u.lang = lang === 'sv' ? 'sv-SE' : 'en-GB';
  u.rate = 1.05;
  return u;
}
function speak(text){
  if (muted || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(utter(text));
}

// ---------- UI ----------
const $ = id => document.getElementById(id);
function updateSpeedUI(speed, acc){
  $('speed').textContent = speedNum(speed);
  $('speedUnit').textContent = speedUnit();
  $('gpsStatus').textContent = acc != null ? `GPS ±${distLabel(acc)}` : 'waiting for GPS…';
}
function updateNextCamUI(active){
  if (!active){ $('nextCam').textContent = 'no camera ahead'; return; }
  const what = active.type === 'zone' ? 'avg-speed zone' : 'camera';
  $('nextCam').textContent = `${what} ${distLabel(active.dist)} ahead`;
}
function updateGpsBanner(acc){
  const b = $('gpsBanner');
  if (acc == null){
    b.textContent = '📡 Acquiring GPS…';
    b.className = 'banner';
  } else if (acc > CONFIG.poorAccuracy){
    b.textContent = `⚠ GPS accuracy low (±${distLabel(acc)}) — turn on Precise location and move to open sky`;
    b.className = 'banner warn';
  } else {
    b.className = 'banner hidden';
  }
}

const radarRings = [250, 500, 1000]; // metres

// Camera blips are recomputed per GPS tick (not per frame); the rAF loop only
// animates the sweep/pulse + redraws the cached blips. Keeps per-frame work tiny.
let radarFix = null;        // { heading: number|null }
let radarDots = [];         // [{ rr:0..1, ang:rad (0 = up = heading), ahead:bool }]
let radarNearest = null;    // nearest "ahead" blip (gets the pulse)
let radarRAF = 0, radarLastDraw = 0;

function updateRadar(lat, lon, heading){
  radarFix = { heading };
  radarDots = []; radarNearest = null;
  const maxM = CONFIG.radarRange, hd = heading == null ? 0 : heading;
  let nd = Infinity;
  for (const cam of CAMERAS){
    const d = haversine(lat, lon, cam.lat, cam.lon);
    if (d > maxM) continue;
    const b = bearing(lat, lon, cam.lat, cam.lon);
    const ahead = heading != null && angleDiff(hd, b) <= CONFIG.aheadCone &&
                  (cam.dir == null || angleDiff(hd, cam.dir) <= CONFIG.dirTolerance);
    const dot = { rr: d / maxM, ang: toRad((b - hd + 360) % 360), ahead };
    radarDots.push(dot);
    if (ahead && d < nd){ nd = d; radarNearest = dot; }
  }
  if (animOn) ensureRadarLoop(); else drawRadar(performance.now());
}

function drawRadar(ts){
  const cv = $('radar'); if (!cv || cv.classList.contains('hidden')) return;
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const px = Math.round((cv.clientWidth || 300) * dpr);
  if (cv.width !== px){ cv.width = px; cv.height = px; }
  const S = cv.width, cx = S / 2, cy = S / 2, R = (S / 2) * 0.94;
  const pos = (ang, r) => [cx + r * Math.sin(ang), cy - r * Math.cos(ang)]; // ang 0 = up
  ctx.clearRect(0, 0, S, S);

  // backdrop glow
  let g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  g.addColorStop(0, 'rgba(46,80,104,0.30)');
  g.addColorStop(0.72, 'rgba(18,28,38,0.10)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

  // forward detection cone (±aheadCone)
  const cone = toRad(CONFIG.aheadCone);
  g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
  g.addColorStop(0, 'rgba(77,163,255,0.20)');
  g.addColorStop(1, 'rgba(77,163,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, R, -Math.PI/2 - cone, -Math.PI/2 + cone); ctx.closePath(); ctx.fill();

  // rotating sweep with a fading trail (only while animation is on)
  if (animOn){
    const sweep = (ts % 4000) / 4000 * Math.PI * 2;     // one turn / 4 s
    const trail = toRad(80);
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, sweep - Math.PI/2 - trail, sweep - Math.PI/2); ctx.closePath();
    g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    g.addColorStop(0, 'rgba(90,210,170,0)');
    g.addColorStop(1, 'rgba(90,210,170,0.16)');
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = 'rgba(130,235,190,0.55)'; ctx.lineWidth = 1.5 * dpr;
    const p = pos(sweep, R);
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(p[0], p[1]); ctx.stroke();
  }

  // range rings + labels, then the outer ring
  ctx.font = `${11 * dpr}px -apple-system, system-ui, sans-serif`;
  for (const m of radarRings){
    if (m > CONFIG.radarRange) continue;
    const rr = R * (m / CONFIG.radarRange);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = dpr;
    ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.30)';
    ctx.fillText(distLabel(m), cx + 5 * dpr, cy - rr + 14 * dpr);
  }
  ctx.strokeStyle = 'rgba(120,200,230,0.22)'; ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();

  // compass bezel (rotates heading-up): ticks every 30°, cardinals labelled, N red
  const chd = (radarFix && radarFix.heading != null) ? radarFix.heading : 0;
  for (let deg = 0; deg < 360; deg += 30){
    const rel = toRad((deg - chd + 360) % 360);
    const major = (deg % 90 === 0);
    const ip = pos(rel, R - (major ? 10 : 6) * dpr), op = pos(rel, R - 1.5 * dpr);
    ctx.strokeStyle = major ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.16)';
    ctx.lineWidth = (major ? 1.5 : 1) * dpr;
    ctx.beginPath(); ctx.moveTo(ip[0], ip[1]); ctx.lineTo(op[0], op[1]); ctx.stroke();
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = `bold ${12 * dpr}px -apple-system, system-ui, sans-serif`;
  for (const card of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]){
    const lp = pos(toRad((card[1] - chd + 360) % 360), R - 22 * dpr);
    ctx.fillStyle = (card[0] === 'N') ? '#ff5a4d' : 'rgba(255,255,255,0.55)';
    ctx.fillText(card[0], lp[0], lp[1]);
  }
  ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';

  // camera blips
  for (const dot of radarDots){
    const [x, y] = pos(dot.ang, R * dot.rr);
    if (dot.ahead){
      ctx.save(); ctx.shadowColor = '#ff453a'; ctx.shadowBlur = 9 * dpr;
      ctx.fillStyle = '#ff453a';
      ctx.beginPath(); ctx.arc(x, y, 4.5 * dpr, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.32)';
      ctx.beginPath(); ctx.arc(x, y, 3 * dpr, 0, Math.PI * 2); ctx.fill();
    }
  }

  // pulse ring on the nearest camera ahead
  if (animOn && radarNearest){
    const [x, y] = pos(radarNearest.ang, R * radarNearest.rr);
    const ph = (ts % 1600) / 1600;
    ctx.strokeStyle = `rgba(255,69,58,${(1 - ph) * 0.55})`; ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.arc(x, y, (5 + ph * 13) * dpr, 0, Math.PI * 2); ctx.stroke();
  }

  // "you" marker — glowing chevron pointing up
  ctx.save(); ctx.translate(cx, cy);
  ctx.shadowColor = '#4da3ff'; ctx.shadowBlur = 8 * dpr; ctx.fillStyle = '#5bb0ff';
  ctx.beginPath();
  ctx.moveTo(0, -12 * dpr); ctx.lineTo(8.5 * dpr, 9 * dpr); ctx.lineTo(0, 4.5 * dpr); ctx.lineTo(-8.5 * dpr, 9 * dpr);
  ctx.closePath(); ctx.fill(); ctx.restore();
}

function ensureRadarLoop(){
  if (!radarOn || !animOn || $('hud').hidden || radarRAF) return;
  const loop = (ts) => {
    radarRAF = requestAnimationFrame(loop);
    if (ts - radarLastDraw < 33) return;   // throttle to ~30 fps
    radarLastDraw = ts; drawRadar(ts);
  };
  radarRAF = requestAnimationFrame(loop);
}
function stopRadarLoop(){
  if (radarRAF){ cancelAnimationFrame(radarRAF); radarRAF = 0; }
  const cv = $('radar'); if (cv){ const c = cv.getContext('2d'); if (c) c.clearRect(0, 0, cv.width, cv.height); }
}
function applyRadar(){
  const hidden = !radarOn;
  $('radar').classList.toggle('hidden', hidden);
  if (hidden){ stopRadarLoop(); return; }
  if (animOn) ensureRadarLoop(); else { stopRadarLoop(); drawRadar(performance.now()); }
}
function showAlertUI(active, d){
  $('alertCard').classList.remove('hidden');
  $('alertTitle').textContent = active.title;
  $('alertDist').textContent = distLabel(d);
  $('alertLimit').textContent = active.limit ? `limit ${limitNum(active.limit)} ${speedUnit()}` : '';
  document.body.classList.toggle('danger', d <= CONFIG.nearDist);
}
function clearAlertUI(){
  $('alertCard').classList.add('hidden');
  document.body.classList.remove('danger');
}

// ---------- settings ----------
const CFG_SLIDERS = [
  ['leadSeconds', ' s'], ['minWarn', ' m'], ['maxWarn', ' m'],
  ['nearDist', ' m'], ['radarRange', ' m'],
];
function syncSegs(){
  document.querySelectorAll('#unitSeg button').forEach(b => b.classList.toggle('on', b.dataset.units === units));
  document.querySelectorAll('#langSeg button').forEach(b => b.classList.toggle('on', b.dataset.lang === lang));
  document.querySelectorAll('#radarSeg button').forEach(b => b.classList.toggle('on', (b.dataset.radar === 'on') === radarOn));
  document.querySelectorAll('#diagSeg button').forEach(b => b.classList.toggle('on', (b.dataset.diag === 'on') === diagOn));
  document.querySelectorAll('#animSeg button').forEach(b => b.classList.toggle('on', (b.dataset.anim === 'on') === animOn));
  document.querySelectorAll('#vibSeg button').forEach(b => b.classList.toggle('on', (b.dataset.vib === 'on') === vibrateOn));
}
function syncConfigSliders(){
  for (const [key, unit] of CFG_SLIDERS){
    const el = $('cfg_' + key);
    if (!el) continue;
    el.value = CONFIG[key];
    const lbl = $('cfg_' + key + '_val');
    if (lbl) lbl.textContent = CONFIG[key] + unit;
  }
}
function resetConfig(){
  Object.assign(CONFIG, CONFIG_DEFAULTS);
  for (const k of Object.keys(CONFIG_DEFAULTS)) localStorage.removeItem('cfg_' + k);
  syncConfigSliders();
}
function populateVoices(){
  const sel = $('voiceSel'); if (!sel) return;
  const vs = ('speechSynthesis' in window) ? speechSynthesis.getVoices() : [];
  const pref = lang === 'sv' ? 'sv' : 'en';
  const match = vs.filter(v => v.lang.toLowerCase().startsWith(pref));
  const list = match.length ? match : vs;
  sel.innerHTML = '<option value="">Auto (best match)</option>' +
    list.map(v => `<option value="${v.name.replace(/"/g, '')}">${v.name} (${v.lang})${v.localService ? '' : ' ☁'}</option>`).join('');
  sel.value = voiceName;
}
function openSettings(){ syncSegs(); syncConfigSliders(); populateVoices(); $('settings').hidden = false; }
function closeSettings(){ $('settings').hidden = true; }

// ---------- lifecycle ----------
async function requestWakeLock(){
  try{
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  }catch(e){ /* not fatal */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible'){ requestWakeLock(); checkForUpdate(); ensureRadarLoop(); }
});

// ---------- service worker + update flow ----------
let swReg = null, lastUpdateCheck = 0;
function showUpdateChip(){ const c = $('updateChip'); if (c) c.hidden = false; }
function checkForUpdate(){
  if (!swReg) return;
  if (Date.now() - lastUpdateCheck < 60000) return;   // throttle to ~1/min
  lastUpdateCheck = Date.now();
  swReg.update().catch(() => {});
}
function registerSW(){
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    swReg = reg; lastUpdateCheck = Date.now();
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateChip();   // update already staged
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing; if (!nw) return;
      nw.addEventListener('statechange', () => {
        // installed + an existing controller = a fresh version (not the first install)
        if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateChip();
      });
    });
  }).catch(() => {});
}
async function forceRefresh(){
  try{
    if (navigator.serviceWorker){
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if (window.caches){
      const ks = await caches.keys();
      await Promise.all(ks.map(k => caches.delete(k)));
    }
  }catch(e){ /* ignore */ }
  location.reload();
}

function start(){
  $('startScreen').hidden = true;
  $('hud').hidden = false;
  applyRadar();            // draw/animate the scope (respects the animation on/off setting)
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
  $('speedUnit').textContent = speedUnit();
  loadCameras().then(d => {
    $('camCount').textContent = d.count;
    $('startInfo').textContent = `${d.count} cameras · ${(d.zones || []).length} zones · OSM ${d.generated} · ${APP_VERSION}`;
    $('startBtn').disabled = false;
  }).catch(e => { $('startInfo').textContent = 'Failed to load cameras: ' + e; });

  $('startBtn').addEventListener('click', start);
  $('muteBtn').addEventListener('click', () => {
    muted = !muted;
    $('muteBtn').textContent = muted ? '🔇' : '🔊';
    if (muted && 'speechSynthesis' in window) speechSynthesis.cancel();
  });

  // settings menu
  $('menuBtn').addEventListener('click', openSettings);
  $('settingsDone').addEventListener('click', closeSettings);
  $('settings').addEventListener('click', e => { if (e.target.id === 'settings') closeSettings(); });
  $('unitSeg').addEventListener('click', e => {
    const u = e.target.dataset.units; if (!u) return;
    units = u; localStorage.setItem('units', u); syncSegs(); $('speedUnit').textContent = speedUnit();
  });
  $('langSeg').addEventListener('click', e => {
    const l = e.target.dataset.lang; if (!l) return;
    lang = l; localStorage.setItem('lang', l); syncSegs(); populateVoices();
  });
  $('radarSeg').addEventListener('click', e => {
    const r = e.target.dataset.radar; if (!r) return;
    radarOn = (r === 'on');
    localStorage.setItem('radarOn', radarOn ? '1' : '0');
    syncSegs(); applyRadar();
  });
  $('diagSeg').addEventListener('click', e => {
    const x = e.target.dataset.diag; if (!x) return;
    diagOn = (x === 'on');
    localStorage.setItem('diag', diagOn ? '1' : '0');
    syncSegs(); if (!diagOn) $('diag').textContent = '';
  });
  $('animSeg').addEventListener('click', e => {
    const x = e.target.dataset.anim; if (!x) return;
    animOn = (x === 'on'); localStorage.setItem('anim', animOn ? '1' : '0');
    syncSegs(); applyRadar();
  });
  $('vibSeg').addEventListener('click', e => {
    const x = e.target.dataset.vib; if (!x) return;
    vibrateOn = (x === 'on'); localStorage.setItem('vibrate', vibrateOn ? '1' : '0');
    syncSegs();
  });
  for (const [key, unit] of CFG_SLIDERS){
    const el = $('cfg_' + key);
    if (!el) continue;
    el.addEventListener('input', () => {
      CONFIG[key] = Number(el.value);
      localStorage.setItem('cfg_' + key, CONFIG[key]);
      const lbl = $('cfg_' + key + '_val');
      if (lbl) lbl.textContent = CONFIG[key] + unit;
    });
  }
  $('resetConfig').addEventListener('click', resetConfig);
  $('voiceSel').addEventListener('change', e => { voiceName = e.target.value; localStorage.setItem('voice', voiceName); });
  $('voiceTest').addEventListener('click', () => {
    if ('speechSynthesis' in window){ speechSynthesis.cancel(); speechSynthesis.speak(utter(cameraPhrase(60))); }
  });
  if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => { if (!$('settings').hidden) populateVoices(); };

  applyRadar();
  $('updateChip').addEventListener('click', () => location.reload());
  $('forceRefresh').addEventListener('click', forceRefresh);
  registerSW();
}
init();

// Test hook: drive a synthetic position, e.g. __sim(59.5882,16.9969, 25, 180)
window.__sim = (lat, lon, speed = 25, heading = null, accuracy = 5) =>
  onPosition({ coords: { latitude: lat, longitude: lon, speed, heading, accuracy }, timestamp: Date.now() });
