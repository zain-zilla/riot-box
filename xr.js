// RIOT//BOX XR: a WebXR synth for Meta Quest (hands or controllers), with a desktop fallback.
import * as THREE from "./vendor/three.module.min.js";

const PINK = 0xff2e88, LIME = 0xc6ff00, CYAN = 0x2ef2ff, INK = 0xf3f0e8;

import { PRESETS, ctx, analyser, freqData, presetName, ensureAudio, applyPreset, noteOn, noteOff, held, beatOn, kickFlash, toggleBeat } from "./xr-audio.js";

// ---------------------------------------------------------------- scene

const container = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0c0c0f);
scene.fog = new THREE.Fog(0x0c0c0f, 4, 12);
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);
camera.position.set(0, 1.5, 0.35);
camera.lookAt(0, 1.15, -0.7);

scene.add(new THREE.HemisphereLight(0xffffff, 0x220011, 1.2));
const grid = new THREE.GridHelper(20, 40, PINK, 0x2a1020);
scene.add(grid);

function label(text, w = 256, h = 64, color = "#000", bg = null, font = "Anton") {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
  g.fillStyle = color;
  g.font = `${Math.floor(h * 0.62)}px ${font}, Impact, sans-serif`;
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText(text, w / 2, h / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// title sign
const title = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.225),
  new THREE.MeshBasicMaterial({ map: label("RIOT//BOX XR", 1024, 256, "#f3f0e8"), transparent: true }));
title.position.set(0, 1.78, -1.0);
scene.add(title);

// pads: two rows, C minor over two octaves
const SCALE = [0, 2, 3, 5, 7, 8, 10, 12];
const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const pads = [];
const padGeo = new THREE.BoxGeometry(0.095, 0.095, 0.03);
const interactive = [];
for (let row = 0; row < 2; row++) {
  for (let i = 0; i < 8; i++) {
    const note = 48 + 12 * row + SCALE[i];
    const angle = (i - 3.5) * 0.145; // ~11 cm apart so pads never touch
    const mat = new THREE.MeshStandardMaterial({ color: row ? 0x3a1430 : 0x30122a, emissive: row ? PINK : LIME, emissiveIntensity: 0.15, roughness: 0.4 });
    const pad = new THREE.Mesh(padGeo, mat);
    const r = 0.75;
    pad.position.set(Math.sin(angle) * r, 1.05 + row * 0.13, -Math.cos(angle) * r);
    pad.lookAt(0, pad.position.y, 0);
    const txt = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.02),
      new THREE.MeshBasicMaterial({ map: label(NOTE_NAMES[note % 12] + (Math.floor(note / 12) - 1), 256, 64, "#f3f0e8", null, "JetBrains Mono"), transparent: true }));
    txt.position.set(0, -0.032, 0.0155);
    pad.add(txt);
    pad.userData = { kind: "pad", note, glow: 0, base: 0.15 };
    scene.add(pad);
    pads.push(pad);
    interactive.push(pad);
  }
}

// buttons: presets + beat
const buttons = [];
const btnNames = ["FAT BASS", "PLUCK", "PAD", "LEAD", "BEAT"];
btnNames.forEach((name, i) => {
  const isBeat = name === "BEAT";
  const mat = new THREE.MeshBasicMaterial({ map: label(name, 256, 64, "#000", isBeat ? "#2ef2ff" : "#c6ff00") });
  const b = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.04, 0.02), [null, null, null, null, mat, null].map((m) => m || new THREE.MeshBasicMaterial({ color: 0x111111 })));
  const angle = (i - 2) * 0.24;
  b.position.set(Math.sin(angle) * 0.7, 0.9, -Math.cos(angle) * 0.7);
  b.lookAt(0, b.position.y, 0);
  b.userData = { kind: "button", name, active: name === presetName };
  scene.add(b);
  buttons.push(b);
  interactive.push(b);
});
function refreshButtons() {
  buttons.forEach((b) => {
    const on = b.userData.name === "BEAT" ? beatOn : b.userData.name === presetName;
    b.scale.setScalar(on ? 1.12 : 1);
    b.position.z = -Math.cos(Math.atan2(b.position.x, -b.position.z)) * (on ? 0.68 : 0.7);
  });
}
refreshButtons();

function pressButton(b) {
  ensureAudio();
  if (b.userData.name === "BEAT") toggleBeat();
  else applyPreset(b.userData.name);
  refreshButtons();
}

// spectrum ring around the player
const BARS = 48;
const bars = [];
const barGeo = new THREE.BoxGeometry(0.06, 1, 0.06);
barGeo.translate(0, 0.5, 0);
for (let i = 0; i < BARS; i++) {
  const t = i / BARS, a = t * Math.PI * 2;
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color().lerpColors(new THREE.Color(PINK), new THREE.Color(LIME), Math.abs(t - 0.5) * 2) });
  const bar = new THREE.Mesh(barGeo, mat);
  bar.position.set(Math.sin(a) * 1.8, 0, Math.cos(a) * 1.8);
  bar.scale.y = 0.02;
  scene.add(bar);
  bars.push(bar);
}

// ---------------------------------------------------------------- interaction

const raycaster = new THREE.Raycaster();
const tmpMatrix = new THREE.Matrix4();

function hitTest(origin, direction) {
  raycaster.set(origin, direction);
  const hits = raycaster.intersectObjects(interactive, false);
  return hits.length ? hits[0].object : null;
}

function triggerObject(obj, key, velocity) {
  if (!obj) return;
  if (obj.userData.kind === "pad") { noteOn(key, obj.userData.note, velocity); obj.userData.glow = 1; obj.userData.heldBy = key; }
  else pressButton(obj);
}
function releaseKey(key) {
  noteOff(key);
  pads.forEach((p) => { if (p.userData.heldBy === key) p.userData.heldBy = null; });
}

// controllers / pinch: point and pull the trigger (a hand pinch fires the same events)
const touchers = []; // grips + hands, used for touch-to-play
for (let i = 0; i < 2; i++) {
  const c = renderer.xr.getController(i);
  const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  const ray = new THREE.Line(rayGeo, new THREE.LineBasicMaterial({ color: i ? PINK : LIME }));
  ray.scale.z = 1.2;
  c.add(ray);
  c.addEventListener("selectstart", () => {
    tmpMatrix.identity().extractRotation(c.matrixWorld);
    const origin = new THREE.Vector3().setFromMatrixPosition(c.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -1).applyMatrix4(tmpMatrix);
    triggerObject(hitTest(origin, dir), "ctrl" + i, 0.9);
  });
  c.addEventListener("selectend", () => releaseKey("ctrl" + i));
  scene.add(c);
  const grip = renderer.xr.getControllerGrip(i);
  grip.add(new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 12), new THREE.MeshBasicMaterial({ color: i ? PINK : LIME })));
  scene.add(grip);
  grip.userData.touchKey = "grip" + i;
  const hand = renderer.xr.getHand(i);
  scene.add(hand);
  hand.userData.touchKey = "hand" + i;
  touchers.push(grip, hand);
}

// touch to play: fingertips (hand tracking) or controller tips tapping pads
const tipPos = new THREE.Vector3(), local = new THREE.Vector3();
const touching = new Map(); // touchKey -> pad
function touchPoint(obj) {
  if (obj.joints && obj.joints["index-finger-tip"]) {
    const j = obj.joints["index-finger-tip"];
    if (!j.visible) return null;
    return j.getWorldPosition(tipPos);
  }
  if (!obj.visible) return null;
  return obj.getWorldPosition(tipPos);
}
function updateTouch() {
  for (const t of touchers) {
    const key = t.userData.touchKey;
    const p = touchPoint(t);
    let hitPad = null;
    if (p) {
      for (const pad of pads) {
        local.copy(p);
        pad.worldToLocal(local);
        if (Math.abs(local.x) < 0.055 && Math.abs(local.y) < 0.055 && local.z < 0.03 && local.z > -0.05) { hitPad = pad; break; }
      }
    }
    const prev = touching.get(key);
    if (hitPad !== prev) {
      if (prev) releaseKey(key);
      if (hitPad) triggerObject(hitPad, key, 1);
      touching.set(key, hitPad);
    }
  }
}

// desktop fallback: mouse + keyboard
const mouse = new THREE.Vector2();
renderer.domElement.addEventListener("pointerdown", (e) => {
  mouse.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
  const hits = raycaster.intersectObjects(interactive, false);
  triggerObject(hits.length ? hits[0].object : null, "mouse", 0.85);
});
window.addEventListener("pointerup", () => releaseKey("mouse"));
const KEYS = "asdfghjkqwertyui";
window.addEventListener("keydown", (e) => {
  const i = KEYS.indexOf(e.key.toLowerCase());
  if (i < 0 || e.repeat) return;
  triggerObject(pads[i], "key" + e.key.toLowerCase(), 0.85);
});
window.addEventListener("keyup", (e) => releaseKey("key" + e.key.toLowerCase()));

// enter VR
const vrBtn = document.getElementById("enterVR");
async function setupVRButton() {
  const ok = navigator.xr && (await navigator.xr.isSessionSupported("immersive-vr").catch(() => false));
  if (!ok) { vrBtn.textContent = "VR not available here"; return; }
  vrBtn.disabled = false;
  vrBtn.textContent = "Enter VR";
  vrBtn.addEventListener("click", async () => {
    ensureAudio();
    const session = await navigator.xr.requestSession("immersive-vr", { optionalFeatures: ["local-floor", "hand-tracking"] });
    renderer.xr.setReferenceSpaceType("local-floor");
    await renderer.xr.setSession(session);
    document.getElementById("overlay").style.display = "none";
    session.addEventListener("end", () => { document.getElementById("overlay").style.display = ""; });
  });
}
setupVRButton();

// ---------------------------------------------------------------- render loop

renderer.setAnimationLoop(() => {
  if (renderer.xr.isPresenting) updateTouch();
  for (const p of pads) {
    const target = p.userData.heldBy ? 1 : 0;
    p.userData.glow += (target - p.userData.glow) * 0.25;
    p.material.emissiveIntensity = p.userData.base + p.userData.glow * 2.2;
    p.scale.z = 1 - p.userData.glow * 0.4;
  }
  if (analyser) {
    analyser.getByteFrequencyData(freqData);
    const nyq = ctx.sampleRate / 2;
    for (let i = 0; i < BARS; i++) {
      // mirror the ring: both halves show low to high
      const half = i < BARS / 2 ? i : BARS - 1 - i;
      const hz = 40 * Math.pow(12000 / 40, half / (BARS / 2));
      const v = freqData[Math.min(freqData.length - 1, Math.floor((hz / nyq) * freqData.length))] / 255;
      bars[i].scale.y += (0.02 + v * 1.6 - bars[i].scale.y) * 0.35;
    }
    const pulse = kickFlash > 0 ? Math.max(0, 1 - (ctx.currentTime - kickFlash) / 0.3) : 0;
    title.scale.setScalar(1 + pulse * 0.06);
  }
  renderer.render(scene, camera);
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// tiny hook for automated tests
window.__riotXR = { pads, buttons, triggerObject, releaseKey, held, get ctx() { return ctx; }, get analyser() { return analyser; } };
