// RIOT//BOX shared XR audio engine: synth voices, effects, drums + sidechain, analyser.
// Used by xr.html (pads) and gesture.html (Gesture Synth).

export const PRESETS = {
  "FAT BASS": { wave: "sawtooth", unison: 3, detune: 14, a: 0.005, d: 0.25, s: 0.6, r: 0.15, cutoff: 600, q: 6, env: 1800, drive: 0.35, delay: 0.05, verb: 0.08, oct: -1 },
  PLUCK: { wave: "triangle", unison: 1, detune: 0, a: 0.002, d: 0.2, s: 0, r: 0.25, cutoff: 900, q: 3, env: 5000, drive: 0.1, delay: 0.3, verb: 0.25, oct: 0 },
  PAD: { wave: "sawtooth", unison: 5, detune: 18, a: 0.6, d: 1, s: 0.8, r: 1.6, cutoff: 1800, q: 1, env: 600, drive: 0, delay: 0.2, verb: 0.5, oct: 0 },
  LEAD: { wave: "square", unison: 2, detune: 8, a: 0.01, d: 0.2, s: 0.75, r: 0.25, cutoff: 3500, q: 4, env: 2500, drive: 0.2, delay: 0.25, verb: 0.2, oct: 1 },
};
export let preset = PRESETS.PLUCK;
export let presetName = "PLUCK";

export let ctx, chain, analyser, freqData;

// live controls (the VR mixer): a preset sets the starting point, the faders change it
export const live = { cutoff: 900, q: 3, drive: 0.1, delay: 0.3, verb: 0.25, oct: 0, vol: 0.5, bpm: 120 };
export function setParam(name, value) {
  live[name] = value;
  if (!chain) return;
  const t = ctx.currentTime;
  if (name === "drive") chain.shaper.curve = driveCurve(value);
  if (name === "delay") chain.delayWet.gain.setTargetAtTime(value, t, 0.03);
  if (name === "verb") chain.verbWet.gain.setTargetAtTime(value, t, 0.03);
  if (name === "vol") chain.master.gain.setTargetAtTime(value, t, 0.03);
  if (name === "cutoff" || name === "q") {
    for (const v of held.values()) {
      const f = v.filter.frequency;
      if (name === "q") { v.filter.Q.setTargetAtTime(value, t, 0.03); continue; }
      f.cancelScheduledValues(t);
      f.setTargetAtTime(value, t, 0.03);
    }
  }
}

export function driveCurve(amount) {
  const n = 1024, c = new Float32Array(n), k = amount * 60;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    c[i] = k === 0 ? x : ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return c;
}

function impulse(seconds) {
  const len = Math.floor(ctx.sampleRate * seconds), buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  }
  return buf;
}

export function ensureAudio() {
  if (ctx) { if (ctx.state === "suspended") ctx.resume(); return; }
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
  chain = { bus: g(1), shaper: ctx.createWaveShaper(), dry: g(1), delay: ctx.createDelay(1), fb: g(0.35), delayWet: g(0),
    verb: ctx.createConvolver(), verbWet: g(0), duck: g(1), drums: g(0.7), master: g(0.5) };
  chain.shaper.oversample = "4x";
  chain.delay.delayTime.value = 0.25;
  chain.verb.buffer = impulse(2.5);
  chain.bus.connect(chain.shaper);
  chain.shaper.connect(chain.dry).connect(chain.duck);
  chain.shaper.connect(chain.delay);
  chain.delay.connect(chain.fb).connect(chain.delay);
  chain.delay.connect(chain.delayWet).connect(chain.duck);
  chain.shaper.connect(chain.verb);
  chain.verb.connect(chain.verbWet).connect(chain.duck);
  chain.duck.connect(chain.master);
  chain.drums.connect(chain.master);
  analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.75;
  freqData = new Uint8Array(analyser.frequencyBinCount);
  chain.master.connect(analyser).connect(ctx.destination);
  applyPreset(presetName);
  const st = document.getElementById("status");
  if (st) st.textContent = "audio running";
}

export function applyPreset(name) {
  presetName = name;
  preset = PRESETS[name];
  for (const k of ["cutoff", "q", "drive", "delay", "verb"]) live[k] = preset[k];
  if (!chain) return;
  chain.shaper.curve = driveCurve(live.drive);
  chain.delayWet.gain.value = live.delay;
  chain.verbWet.gain.value = live.verb;
  chain.master.gain.value = live.vol;
}

export const midiToFreq = (n) => 440 * Math.pow(2, (n - 69) / 12);

export class Voice {
  constructor(note, velocity) {
    const p = preset, t = ctx.currentTime, n = p.unison;
    this.p = p;
    this.oscs = [];
    this.mix = ctx.createGain();
    this.mix.gain.value = 1 / Math.sqrt(n);
    this.filter = ctx.createBiquadFilter();
    this.filter.Q.value = live.q;
    this.amp = ctx.createGain();
    this.amp.gain.value = 0;
    for (let i = 0; i < n; i++) {
      const spread = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
      const o = ctx.createOscillator();
      o.type = p.wave;
      o.frequency.value = midiToFreq(note + 12 * (p.oct + live.oct));
      o.detune.value = spread * p.detune;
      o.connect(this.mix);
      o.start(t);
      this.oscs.push(o);
    }
    this.mix.connect(this.filter).connect(this.amp).connect(chain.bus);
    this.level = velocity * p.s;
    this.amp.gain.setValueAtTime(0, t);
    this.amp.gain.linearRampToValueAtTime(velocity, t + p.a + 0.001);
    this.amp.gain.linearRampToValueAtTime(this.level, t + p.a + p.d + 0.002);
    const cut = live.cutoff;
    this.filter.frequency.setValueAtTime(cut, t);
    this.filter.frequency.linearRampToValueAtTime(Math.min(18000, cut + p.env), t + p.a + 0.001);
    this.filter.frequency.linearRampToValueAtTime(cut, t + p.a + p.d + 0.002);
  }
  release() {
    const t = ctx.currentTime, gain = this.amp.gain;
    if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(t);
    else { gain.cancelScheduledValues(t); gain.setValueAtTime(this.level, t); }
    gain.linearRampToValueAtTime(0, t + this.p.r);
    this.oscs.forEach((o) => o.stop(t + this.p.r + 0.05));
    this.oscs[0].onended = () => { try { this.amp.disconnect(); } catch (e) {} };
  }
}

export const held = new Map(); // key -> Voice
export function noteOn(key, note, velocity = 0.85) {
  ensureAudio();
  if (held.has(key)) held.get(key).release();
  held.set(key, new Voice(note, velocity));
}
export function noteOff(key) {
  const v = held.get(key);
  if (v) { v.release(); held.delete(key); }
}

// drums + sidechain loop
export let beatOn = false;
let beatTimer = null, nextBeat = 0, step = 0;
const noiseBuf = () => {
  const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
};
let noise;
function drum(type, t) {
  const out = ctx.createGain();
  out.connect(chain.drums);
  if (type === "kick") {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    out.gain.setValueAtTime(1, t);
    out.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    o.connect(out); o.start(t); o.stop(t + 0.5);
    // sidechain: duck the synth on every kick
    const g = chain.duck.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(0.25, t);
    g.linearRampToValueAtTime(1, t + 0.3);
    kickFlash = t;
  } else {
    const s = ctx.createBufferSource(), hp = ctx.createBiquadFilter();
    s.buffer = noise || (noise = noiseBuf());
    hp.type = "highpass";
    hp.frequency.value = type === "snare" ? 1200 : 7000;
    const len = type === "snare" ? 0.18 : 0.05;
    out.gain.setValueAtTime(type === "snare" ? 0.6 : 0.3, t);
    out.gain.exponentialRampToValueAtTime(0.001, t + len);
    s.connect(hp).connect(out); s.start(t); s.stop(t + len + 0.02);
  }
}
export let kickFlash = -1;
function beatScheduler() {
  const sixteenth = 60 / live.bpm / 4;
  while (nextBeat < ctx.currentTime + 0.1) {
    if (step % 4 === 0) drum("kick", nextBeat);
    if (step % 8 === 4) drum("snare", nextBeat);
    if (step % 2 === 1) drum("hat", nextBeat);
    nextBeat += sixteenth;
    step = (step + 1) % 16;
  }
}
export function toggleBeat() {
  ensureAudio();
  beatOn = !beatOn;
  if (beatOn) { step = 0; nextBeat = ctx.currentTime + 0.05; beatTimer = setInterval(beatScheduler, 25); }
  else { clearInterval(beatTimer); chain.duck.gain.cancelScheduledValues(ctx.currentTime); chain.duck.gain.value = 1; }
}

