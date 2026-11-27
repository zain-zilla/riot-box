// AIR//RIOT (formerly Gesture Synth): play RIOT//BOX with bare hands (WebXR hand tracking). Gestures are recognised
// on the headset from joint positions (simple geometry), so no camera data leaves the device.
import * as THREE from "./vendor/three.module.min.js";
import { ctx, chain, analyser, freqData, ensureAudio, toggleBeat, beatOn, kickFlash, midiToFreq } from "./xr-audio.js";

const PINK = 0xff2e88, LIME = 0xc6ff00, CYAN = 0x2ef2ff;

// ---------------------------------------------------------------- musical mapping

// C minor pentatonic over two octaves + the top C: every height lands on a note that fits
const STEPS = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24];
const BASE = 60; // C4
const LOW_Y = 0.85, HIGH_Y = 1.75; // metres above the floor
const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const noteName = (m) => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
const stepY = (i) => LOW_Y + (i / (STEPS.length - 1)) * (HIGH_Y - LOW_Y);
function stepForHeight(y) {
  const t = THREE.MathUtils.clamp((y - LOW_Y) / (HIGH_Y - LOW_Y), 0, 1);
  return Math.round(t * (STEPS.length - 1));
}

// ---------------------------------------------------------------- expressive voices

// A mono voice that glides between notes while the pinch is held (like a theremin, but in key)
class GlideVoice {
  constructor(type = "sawtooth", unison = 3, detune = 12, q = 4) {
    const t = ctx.currentTime;
    this.oscs = [];
    this.mix = ctx.createGain();
    this.mix.gain.value = 1 / Math.sqrt(unison);
    this.filter = ctx.createBiquadFilter();
    this.filter.Q.value = q;
    this.filter.frequency.value = state.cutoff;
    this.amp = ctx.createGain();
    this.amp.gain.value = 0;
    this.vib = ctx.createOscillator();
    this.vib.frequency.value = 5.5;
    this.vibDepth = ctx.createGain();
    this.vibDepth.gain.value = 6; // cents
    this.vib.connect(this.vibDepth);
    for (let i = 0; i < unison; i++) {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = unison === 1 ? 0 : ((i / (unison - 1)) * 2 - 1) * detune;
      this.vibDepth.connect(o.detune);
      o.connect(this.mix);
      o.start(t);
      this.oscs.push(o);
    }
    this.vib.start(t);
    this.mix.connect(this.filter).connect(this.amp).connect(chain.bus);
  }
  play(freq, level = 0.8) {
    const t = ctx.currentTime;
    this.oscs.forEach((o) => o.frequency.setValueAtTime(freq, t));
    this.amp.gain.cancelScheduledValues(t);
    this.amp.gain.setTargetAtTime(level, t, 0.015);
  }
  glide(freq) {
    const t = ctx.currentTime;
    this.oscs.forEach((o) => o.frequency.setTargetAtTime(freq, t, 0.035));
  }
  cutoff(hz) { this.filter.frequency.setTargetAtTime(hz, ctx.currentTime, 0.04); }
  stop() {
    const t = ctx.currentTime;
    this.amp.gain.cancelScheduledValues(t);
    this.amp.gain.setTargetAtTime(0, t, 0.08);
  }
}

const state = { lead: null, bass: null, playing: false, step: -1, bassOn: false, cutoff: 1800, reverb: 0.25, fistFlash: 0 };

function setupVoices() {
  ensureAudio();
  if (state.lead) return;
  state.lead = new GlideVoice("sawtooth", 3, 12, 5);
  state.bass = new GlideVoice("triangle", 1, 0, 1);
  chain.delayWet.gain.value = 0.2;
  setReverb(state.reverb);
}
function setReverb(v) {
  state.reverb = THREE.MathUtils.clamp(v, 0, 0.85);
  if (chain) chain.verbWet.gain.setTargetAtTime(state.reverb, ctx.currentTime, 0.1);
}
function setCutoff(hz) {
  state.cutoff = THREE.MathUtils.clamp(hz, 150, 9000);
  if (state.lead) state.lead.cutoff(state.cutoff);
  if (state.bass) state.bass.cutoff(Math.min(1200, state.cutoff));
}
function leadOn(step) {
  setupVoices();
  state.step = step;
  state.playing = true;
  state.lead.play(midiToFreq(BASE + STEPS[step]));
}
function leadMove(step) {
  if (!state.playing || step === state.step) return;
  state.step = step;
  state.lead.glide(midiToFreq(BASE + STEPS[step]));
}
function leadOff() {
  if (!state.playing) return;
  state.playing = false;
  state.lead.stop();
}
function bass(on) {
  setupVoices();
  if (on === state.bassOn) return;
  state.bassOn = on;
  if (on) state.bass.play(midiToFreq(36), 0.7); // C2 drone
  else state.bass.stop();
}
function fist() {
  setupVoices();
  toggleBeat();
  state.fistFlash = 1;
}

// ---------------------------------------------------------------- scene

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.getElementById("scene").appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0c0c0f);
scene.fog = new THREE.Fog(0x0c0c0f, 4, 12);
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);
camera.position.set(0, 1.4, 0.9);
camera.lookAt(0, 1.3, -0.4);
scene.add(new THREE.HemisphereLight(0xffffff, 0x220011, 1.2));
scene.add(new THREE.GridHelper(20, 40, PINK, 0x2a1020));

function canvasTex(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { c, g: c.getContext("2d"), tex };
}
function textPlane(text, w, h, worldW, color = "#f3f0e8", font = "Anton") {
  const { g, tex } = canvasTex(w, h);
  g.fillStyle = color;
  g.font = `${Math.floor(h * 0.7)}px ${font}, Impact, sans-serif`;
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(text, w / 2, h / 2);
  return new THREE.Mesh(new THREE.PlaneGeometry(worldW, worldW * (h / w)), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
}

const title = textPlane("AIR//RIOT", 1024, 160, 0.9);
title.position.set(0, 1.95, -1.1);
scene.add(title);

// note ladder: one ring per note, at the height that plays it
const ladder = [];
for (let i = 0; i < STEPS.length; i++) {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.006, 8, 32),
    new THREE.MeshBasicMaterial({ color: new THREE.Color().lerpColors(new THREE.Color(PINK), new THREE.Color(LIME), i / (STEPS.length - 1)) }));
  ring.position.set(0.32, stepY(i), -0.45);
  ring.userData.base = ring.material.color.clone();
  const lbl = textPlane(noteName(BASE + STEPS[i]), 256, 64, 0.07, "#c9c6d3", "JetBrains Mono");
  lbl.position.set(0.1, 0, 0);
  ring.add(lbl);
  scene.add(ring);
  ladder.push(ring);
}

// HUD panel
const hud = canvasTex(512, 256);
const hudMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.21), new THREE.MeshBasicMaterial({ map: hud.tex, transparent: true }));
hudMesh.position.set(-0.42, 1.35, -0.55);
hudMesh.rotation.y = 0.45;
scene.add(hudMesh);
function drawHud() {
  const g = hud.g;
  g.clearRect(0, 0, 512, 256);
  g.fillStyle = "rgba(21,21,25,0.88)"; g.fillRect(0, 0, 512, 256);
  g.strokeStyle = "#ff2e88"; g.lineWidth = 4; g.strokeRect(2, 2, 508, 252);
  const row = (label, value, y, color) => {
    g.font = "26px 'JetBrains Mono', monospace"; g.fillStyle = "#8d8a99"; g.textAlign = "left"; g.fillText(label, 24, y);
    g.font = "40px Anton, Impact, sans-serif"; g.fillStyle = color; g.textAlign = "right"; g.fillText(value, 488, y + 4);
  };
  row("NOTE", state.playing ? noteName(BASE + STEPS[state.step]) : "—", 62, "#f3f0e8");
  row("FILTER", Math.round(state.cutoff) + " Hz", 122, "#c6ff00");
  row("REVERB", Math.round(state.reverb * 100) + "%", 182, "#2ef2ff");
  row("BEAT", beatOn ? "ON" : "OFF", 238, beatOn ? "#ff2e88" : "#8d8a99");
  hud.tex.needsUpdate = true;
}

// spectrum ring
const BARS = 48, bars = [];
const barGeo = new THREE.BoxGeometry(0.06, 1, 0.06);
barGeo.translate(0, 0.5, 0);
for (let i = 0; i < BARS; i++) {
  const a = (i / BARS) * Math.PI * 2;
  const bar = new THREE.Mesh(barGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color().lerpColors(new THREE.Color(PINK), new THREE.Color(LIME), Math.abs(i / BARS - 0.5) * 2) }));
  bar.position.set(Math.sin(a) * 1.8, 0, Math.cos(a) * 1.8);
  bar.scale.y = 0.02;
  scene.add(bar);
  bars.push(bar);
}

// trail behind the playing fingertip
const TRAIL = 60;
const trailPos = new Float32Array(TRAIL * 3);
const trailGeo = new THREE.BufferGeometry();
trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPos, 3));
const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: PINK }));
trail.frustumCulled = false;
scene.add(trail);
let trailCount = 0;
function pushTrail(p) {
  trailPos.copyWithin(3, 0, (TRAIL - 1) * 3);
  trailPos[0] = p.x; trailPos[1] = p.y; trailPos[2] = p.z;
  trailCount = Math.min(TRAIL, trailCount + 1);
  trailGeo.setDrawRange(0, trailCount);
  trailGeo.attributes.position.needsUpdate = true;
}

// ---------------------------------------------------------------- hand tracking + gestures

const TIPS = ["thumb-tip", "index-finger-tip", "middle-finger-tip", "ring-finger-tip", "pinky-finger-tip"];
const hands = { left: null, right: null };
const tipMat = new THREE.MeshBasicMaterial({ color: 0xf3f0e8 });
const tipGeo = new THREE.SphereGeometry(0.008, 10, 10);
for (let i = 0; i < 2; i++) {
  const hand = renderer.xr.getHand(i);
  hand.addEventListener("connected", (e) => {
    const side = e.data.handedness;
    hand.userData = { side, pinch: false, fistSince: 0, lastFist: 0 };
    hands[side] = hand;
  });
  hand.addEventListener("disconnected", () => {
    if (hand.userData.side) hands[hand.userData.side] = null;
    if (hand.userData.side === "right") leadOff();
    if (hand.userData.side === "left") bass(false);
  });
  scene.add(hand);
}

const A = new THREE.Vector3(), B = new THREE.Vector3(), W = new THREE.Vector3();
function joint(hand, name, out) {
  const j = hand.joints && hand.joints[name];
  if (!j || !j.visible) return null;
  if (!j.userData.marker && TIPS.includes(name)) { j.add(new THREE.Mesh(tipGeo, tipMat)); j.userData.marker = true; }
  return j.getWorldPosition(out);
}
// pinch: thumb tip close to index tip (with hysteresis so it doesn't flicker)
function readPinch(hand) {
  const t = joint(hand, "thumb-tip", A), ix = joint(hand, "index-finger-tip", B);
  if (!t || !ix) return hand.userData.pinch;
  const d = t.distanceTo(ix);
  if (!hand.userData.pinch && d < 0.018) hand.userData.pinch = true;
  else if (hand.userData.pinch && d > 0.035) hand.userData.pinch = false;
  return hand.userData.pinch;
}
// fist: all four fingertips curled in close to the wrist, held for 0.35 s
function readFist(hand, now) {
  const w = joint(hand, "wrist", W);
  if (!w) return false;
  let sum = 0, n = 0;
  for (const name of TIPS.slice(1)) { const p = joint(hand, name, A); if (p) { sum += p.distanceTo(w); n++; } }
  const closed = n === 4 && sum / n < 0.095;
  if (!closed) { hand.userData.fistSince = 0; return false; }
  if (!hand.userData.fistSince) hand.userData.fistSince = now;
  if (now - hand.userData.fistSince > 350 && now - hand.userData.lastFist > 1500) { hand.userData.lastFist = now; return true; }
  return false;
}

const tipR = new THREE.Vector3(), tipL = new THREE.Vector3();
function updateHands(now) {
  const R = hands.right, L = hands.left;
  let rTip = null, lTip = null;
  if (R) {
    rTip = joint(R, "index-finger-tip", tipR);
    const pinched = readPinch(R);
    if (rTip) {
      const step = stepForHeight(rTip.y);
      if (pinched && !state.playing) leadOn(step);
      else if (pinched) leadMove(step);
      if (pinched) pushTrail(rTip);
    }
    if (!pinched) leadOff();
    if (readFist(R, now)) fist();
  }
  if (L) {
    lTip = joint(L, "index-finger-tip", tipL);
    if (lTip) setCutoff(200 * Math.pow(9000 / 200, THREE.MathUtils.clamp((lTip.y - 0.8) / 1.0, 0, 1)));
    bass(readPinch(L));
    if (readFist(L, now)) fist();
  }
  if (rTip && lTip) setReverb(THREE.MathUtils.mapLinear(rTip.distanceTo(lTip), 0.15, 0.9, 0, 0.85));
}

// ---------------------------------------------------------------- desktop fallback

const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
const ladderPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0.45);
const hit = new THREE.Vector3();
let mouseDown = false;
function mouseToWorld(e) {
  ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  return ray.ray.intersectPlane(ladderPlane, hit);
}
renderer.domElement.addEventListener("pointerdown", (e) => {
  const p = mouseToWorld(e);
  if (!p) return;
  mouseDown = true;
  leadOn(stepForHeight(p.y));
  pushTrail(p);
});
window.addEventListener("pointermove", (e) => {
  setCutoff(200 * Math.pow(9000 / 200, e.clientX / window.innerWidth));
  if (!mouseDown) return;
  const p = mouseToWorld(e);
  if (p) { leadMove(stepForHeight(p.y)); pushTrail(p); }
});
window.addEventListener("pointerup", () => { mouseDown = false; leadOff(); });
window.addEventListener("wheel", (e) => setReverb(state.reverb - e.deltaY * 0.0008));
window.addEventListener("keydown", (e) => { if (e.key.toLowerCase() === "b" && !e.repeat) fist(); });

// enter VR (hand tracking requested so the headset switches to hands)
const vrBtn = document.getElementById("enterVR");
(async () => {
  const ok = navigator.xr && (await navigator.xr.isSessionSupported("immersive-vr").catch(() => false));
  if (!ok) { vrBtn.textContent = "VR not available here"; return; }
  vrBtn.disabled = false;
  vrBtn.textContent = "Enter VR";
  vrBtn.addEventListener("click", async () => {
    setupVoices();
    const session = await navigator.xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor", "hand-tracking"] });
    renderer.xr.setReferenceSpaceType("local-floor");
    await renderer.xr.setSession(session);
    document.getElementById("overlay").style.display = "none";
    session.addEventListener("end", () => { document.getElementById("overlay").style.display = ""; leadOff(); bass(false); });
  });
})();

// ---------------------------------------------------------------- render loop

let hudTimer = 0;
renderer.setAnimationLoop((time) => {
  if (renderer.xr.isPresenting) updateHands(performance.now());
  ladder.forEach((ring, i) => {
    const on = state.playing && i === state.step;
    ring.scale.setScalar(on ? 1.6 : 1);
    ring.material.color.copy(on ? new THREE.Color(0xffffff) : ring.userData.base);
  });
  if (state.playing) trail.material.color.lerpColors(new THREE.Color(PINK), new THREE.Color(LIME), state.step / (STEPS.length - 1));
  else if (trailCount > 0 && time % 3 < 1) { trailCount--; trailGeo.setDrawRange(0, trailCount); }
  if (analyser) {
    analyser.getByteFrequencyData(freqData);
    const nyq = ctx.sampleRate / 2;
    for (let i = 0; i < BARS; i++) {
      const half = i < BARS / 2 ? i : BARS - 1 - i;
      const hz = 40 * Math.pow(12000 / 40, half / (BARS / 2));
      const v = freqData[Math.min(freqData.length - 1, Math.floor((hz / nyq) * freqData.length))] / 255;
      bars[i].scale.y += (0.02 + v * 1.6 - bars[i].scale.y) * 0.35;
    }
    const pulse = kickFlash > 0 ? Math.max(0, 1 - (ctx.currentTime - kickFlash) / 0.3) : 0;
    title.scale.setScalar(1 + pulse * 0.06 + state.fistFlash * 0.15);
  }
  state.fistFlash *= 0.9;
  if (time - hudTimer > 100) { hudTimer = time; drawHud(); }
  renderer.render(scene, camera);
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// hooks for automated tests
window.__gesture = { state, readPinch, readFist, leadOn, leadMove, leadOff, bass, fist, setCutoff, setReverb, stepForHeight, get analyser() { return analyser; } };
