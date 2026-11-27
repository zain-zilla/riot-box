(() => {
  "use strict";

  const GITHUB_REPO_URL = "https://github.com/zain-zilla/web-synth-1";
  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const midiToFreq = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const noteName = (n) => NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);

  // ---------- Settings & presets ----------

  const DEFAULTS = {
    waveform: "sawtooth",
    unison: 1,
    detune: 12,
    attack: 0.01,
    decay: 0.2,
    sustain: 0.7,
    release: 0.3,
    cutoff: 3000,
    resonance: 1,
    filterEnv: 2000,
    lfoTarget: "off",
    lfoWave: "sine",
    lfoRate: 4,
    lfoDepth: 0.5,
    drive: 0,
    delayTime: 0.25,
    delayFeedback: 0.3,
    delayMix: 0,
    reverbSize: 2.5,
    reverbMix: 0,
    scSource: "kick",
    scAmount: 0,
    scRelease: 0.25,
    volume: 0.4,
    drumVolume: 0.7,
  };

  // Keys a preset is allowed to change (volumes stay where the player set them).
  const SOUND_KEYS = Object.keys(DEFAULTS).filter((k) => k !== "volume" && k !== "drumVolume");

  const PRESETS = {
    Init: {},
    "Fat Bass": {
      waveform: "sawtooth", unison: 3, detune: 14, attack: 0.005, decay: 0.25, sustain: 0.6, release: 0.12,
      cutoff: 500, resonance: 6, filterEnv: 1800, drive: 0.35, reverbMix: 0.05,
    },
    "Warm Pad": {
      waveform: "sawtooth", unison: 5, detune: 18, attack: 0.9, decay: 1, sustain: 0.8, release: 1.8,
      cutoff: 1800, resonance: 1, filterEnv: 600, lfoTarget: "filter", lfoWave: "sine", lfoRate: 0.3, lfoDepth: 0.25,
      delayMix: 0.2, delayTime: 0.38, delayFeedback: 0.35, reverbMix: 0.45, reverbSize: 4,
    },
    Lead: {
      waveform: "square", unison: 2, detune: 8, attack: 0.01, decay: 0.2, sustain: 0.75, release: 0.25,
      cutoff: 3500, resonance: 4, filterEnv: 2500, lfoTarget: "pitch", lfoRate: 5.5, lfoDepth: 0.25, drive: 0.2,
      delayMix: 0.25, delayTime: 0.3, delayFeedback: 0.35, reverbMix: 0.2, reverbSize: 2,
    },
    Pluck: {
      waveform: "triangle", unison: 1, attack: 0.002, decay: 0.18, sustain: 0, release: 0.2,
      cutoff: 900, resonance: 3, filterEnv: 5000, drive: 0.1,
      delayMix: 0.3, delayTime: 0.25, delayFeedback: 0.4, reverbMix: 0.25, reverbSize: 2.5,
    },
    Wobble: {
      waveform: "sawtooth", unison: 3, detune: 10, attack: 0.01, decay: 0.1, sustain: 0.9, release: 0.15,
      cutoff: 400, resonance: 10, filterEnv: 300, lfoTarget: "filter", lfoWave: "sine", lfoRate: 3, lfoDepth: 0.7,
      drive: 0.5, reverbMix: 0.1,
    },
    "Pumping Chords": {
      waveform: "sawtooth", unison: 4, detune: 16, attack: 0.02, decay: 0.4, sustain: 0.8, release: 0.4,
      cutoff: 2600, resonance: 1.5, filterEnv: 800, drive: 0.1, delayMix: 0.15, reverbMix: 0.35, reverbSize: 3,
      scSource: "beat", scAmount: 0.8, scRelease: 0.3,
    },
  };

  const settings = { ...DEFAULTS };

  // ---------- DSP helpers ----------

  // Soft-clip curve: (1+k)x / (1 + k|x|). k = 0 is a straight line (clean).
  function makeDriveCurve(amount) {
    const n = 1024;
    const curve = new Float32Array(n);
    const k = amount * 60;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / (n - 1) - 1;
      curve[i] = k === 0 ? x : ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    return curve;
  }
  const driveMakeup = (amount) => 1 - amount * 0.35;

  // Synthetic reverb: stereo noise with a power-curve decay, rendered once per size change.
  function makeImpulse(audioCtx, seconds) {
    const rate = audioCtx.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const buf = audioCtx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
  }

  function makeNoise(audioCtx) {
    const len = audioCtx.sampleRate;
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  const LFO_SCALE = { pitch: 60, filter: 3000 }; // cents / Hz at full depth

  // ---------- Signal chain (shared by live playback and WAV export) ----------
  //
  // voices -> voiceBus -> tremolo -> drive -> { dry, delay, reverb } -> duck (sidechain) -> master
  // drums  -> drumBus ---------------------------------------------------------------> master
  // LFO -> pitch (each voice's detune) | filter (each voice's cutoff) | tremolo gain
  function createSignalChain(audioCtx, destination, s) {
    const gain = (v) => {
      const g = audioCtx.createGain();
      g.gain.value = v;
      return g;
    };
    const c = {};
    c.ctx = audioCtx;
    c.voiceBus = gain(1);
    c.tremolo = gain(1);
    c.shaper = audioCtx.createWaveShaper();
    c.shaper.oversample = "4x";
    c.driveOut = gain(1);
    c.dry = gain(1);
    c.delay = audioCtx.createDelay(2.0);
    c.feedback = gain(0);
    c.delayWet = gain(0);
    c.convolver = audioCtx.createConvolver();
    c.reverbWet = gain(0);
    c.duck = gain(1);
    c.drumBus = gain(s.drumVolume);
    c.master = gain(s.volume);

    c.voiceBus.connect(c.tremolo).connect(c.shaper).connect(c.driveOut);
    c.driveOut.connect(c.dry).connect(c.duck);
    c.driveOut.connect(c.delay);
    c.delay.connect(c.feedback).connect(c.delay);
    c.delay.connect(c.delayWet).connect(c.duck);
    c.driveOut.connect(c.convolver);
    c.convolver.connect(c.reverbWet).connect(c.duck);
    c.duck.connect(c.master);
    c.drumBus.connect(c.master);
    c.master.connect(destination);

    c.lfo = audioCtx.createOscillator();
    c.lfoPitch = gain(0);
    c.lfoFilter = gain(0);
    c.lfoAmp = gain(0);
    c.lfo.connect(c.lfoPitch);
    c.lfo.connect(c.lfoFilter);
    c.lfo.connect(c.lfoAmp);
    c.lfoAmp.connect(c.tremolo.gain);
    c.lfo.start(0);

    c.noise = makeNoise(audioCtx);
    c.reverbSize = null;
    applyChainSettings(c, s);
    return c;
  }

  function applyChainSettings(c, s) {
    c.master.gain.value = s.volume;
    c.drumBus.gain.value = s.drumVolume;
    c.delay.delayTime.value = s.delayTime;
    c.feedback.gain.value = s.delayFeedback;
    c.delayWet.gain.value = s.delayMix;
    c.reverbWet.gain.value = s.reverbMix;
    c.shaper.curve = makeDriveCurve(s.drive);
    c.driveOut.gain.value = driveMakeup(s.drive);
    if (c.reverbSize !== s.reverbSize) {
      c.convolver.buffer = makeImpulse(c.ctx, s.reverbSize);
      c.reverbSize = s.reverbSize;
    }
    c.lfo.type = s.lfoWave;
    c.lfo.frequency.value = s.lfoRate;
    c.lfoPitch.gain.value = s.lfoTarget === "pitch" ? s.lfoDepth * LFO_SCALE.pitch : 0;
    c.lfoFilter.gain.value = s.lfoTarget === "filter" ? s.lfoDepth * LFO_SCALE.filter : 0;
    const trem = s.lfoTarget === "volume" ? s.lfoDepth * 0.5 : 0;
    c.tremolo.gain.value = 1 - trem;
    c.lfoAmp.gain.value = trem;
  }

  // ---------- Voice: unison oscillators -> filter (+env) -> amp (+env) ----------

  class Voice {
    constructor(audioCtx, chainObj, note, velocity, startTime, s, bendCents = 0) {
      const freq = midiToFreq(note);
      const n = clamp(Math.round(s.unison), 1, 7);
      this.chain = chainObj;
      this.s = s;
      this.oscs = [];
      this.baseDetune = [];
      this.nodes = [];

      this.mix = audioCtx.createGain();
      this.mix.gain.value = 1 / Math.sqrt(n);
      this.filter = audioCtx.createBiquadFilter();
      this.filter.type = "lowpass";
      this.filter.Q.value = s.resonance;
      this.amp = audioCtx.createGain();
      this.amp.gain.value = 0;

      for (let i = 0; i < n; i++) {
        const spread = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
        const osc = audioCtx.createOscillator();
        osc.type = s.waveform;
        osc.frequency.value = freq;
        const det = spread * s.detune;
        osc.detune.value = det + bendCents;
        this.baseDetune.push(det);
        if (n > 1 && audioCtx.createStereoPanner) {
          const pan = audioCtx.createStereoPanner();
          pan.pan.value = spread * 0.7;
          osc.connect(pan).connect(this.mix);
          this.nodes.push(pan);
        } else {
          osc.connect(this.mix);
        }
        chainObj.lfoPitch.connect(osc.detune);
        osc.start(startTime);
        this.oscs.push(osc);
      }
      this.mix.connect(this.filter).connect(this.amp).connect(chainObj.voiceBus);
      chainObj.lfoFilter.connect(this.filter.frequency);

      const peak = clamp(velocity, 0.0001, 1);
      this.sustainLevel = peak * s.sustain;
      const g = this.amp.gain;
      g.setValueAtTime(0, startTime);
      g.linearRampToValueAtTime(peak, startTime + s.attack + 0.001);
      g.linearRampToValueAtTime(this.sustainLevel, startTime + s.attack + s.decay + 0.002);

      const f = this.filter.frequency;
      const peakFreq = Math.min(20000, s.cutoff + s.filterEnv);
      f.setValueAtTime(s.cutoff, startTime);
      f.linearRampToValueAtTime(peakFreq, startTime + s.attack + 0.001);
      f.linearRampToValueAtTime(s.cutoff, startTime + s.attack + s.decay + 0.002);
      this.released = false;
    }

    bend(cents, at) {
      this.oscs.forEach((o, i) => o.detune.setValueAtTime(this.baseDetune[i] + cents, at));
    }

    release(atTime) {
      if (this.released) return;
      this.released = true;
      const g = this.amp.gain;
      if (g.cancelAndHoldAtTime) {
        g.cancelAndHoldAtTime(atTime);
      } else {
        g.cancelScheduledValues(atTime);
        g.setValueAtTime(this.sustainLevel, atTime);
      }
      g.linearRampToValueAtTime(0, atTime + this.s.release);
      const end = atTime + this.s.release + 0.05;
      this.oscs.forEach((o) => o.stop(end));
      const last = this.oscs[this.oscs.length - 1];
      last.onended = () => this.cleanup();
    }

    cleanup() {
      try {
        this.oscs.forEach((o) => {
          this.chain.lfoPitch.disconnect(o.detune);
          o.disconnect();
        });
        this.chain.lfoFilter.disconnect(this.filter.frequency);
        this.nodes.forEach((n) => n.disconnect());
        this.mix.disconnect();
        this.filter.disconnect();
        this.amp.disconnect();
      } catch (e) {}
    }
  }

  // ---------- Drums (synthesized, never ducked) ----------

  function playDrum(audioCtx, c, type, t, vel) {
    const out = audioCtx.createGain();
    out.connect(c.drumBus);
    const done = [];
    if (type === "kick") {
      const osc = audioCtx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(150, t);
      osc.frequency.exponentialRampToValueAtTime(45, t + 0.12);
      out.gain.setValueAtTime(vel, t);
      out.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
      osc.connect(out);
      osc.start(t);
      osc.stop(t + 0.5);
      done.push(osc);
    } else {
      const src = audioCtx.createBufferSource();
      src.buffer = c.noise;
      const hp = audioCtx.createBiquadFilter();
      hp.type = "highpass";
      const len = type === "snare" ? 0.18 : 0.05;
      hp.frequency.value = type === "snare" ? 1200 : 7000;
      out.gain.setValueAtTime(type === "snare" ? vel * 0.8 : vel * 0.45, t);
      out.gain.exponentialRampToValueAtTime(0.001, t + len);
      src.connect(hp).connect(out);
      src.start(t);
      src.stop(t + len + 0.02);
      done.push(src, hp);
      if (type === "snare") {
        const tone = audioCtx.createOscillator();
        tone.type = "triangle";
        tone.frequency.value = 190;
        const tg = audioCtx.createGain();
        tg.gain.setValueAtTime(vel * 0.5, t);
        tg.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        tone.connect(tg).connect(out);
        tone.start(t);
        tone.stop(t + 0.12);
        done.push(tone, tg);
      }
    }
    done[0].onended = () => {
      try {
        done.forEach((n) => n.disconnect());
        out.disconnect();
      } catch (e) {}
    };
  }

  // ---------- Sidechain ----------

  const duckEvents = []; // live only, for the meter: { t, amount, release }

  function duckAt(c, t, s, record) {
    if (s.scAmount <= 0) return;
    const g = c.duck.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(1 - s.scAmount, t);
    g.linearRampToValueAtTime(1, t + s.scRelease);
    if (record) {
      duckEvents.push({ t, amount: s.scAmount, release: s.scRelease });
      if (duckEvents.length > 64) duckEvents.shift();
    }
  }

  function duckGainAt(now) {
    let ev = null;
    for (let i = duckEvents.length - 1; i >= 0; i--) {
      if (duckEvents[i].t <= now) {
        ev = duckEvents[i];
        break;
      }
    }
    if (!ev || now > ev.t + ev.release) return 1;
    return 1 - ev.amount * (1 - (now - ev.t) / ev.release);
  }

  // ---------- Live audio context ----------

  let ctx = null;
  let analyser = null;
  let chain = null;
  const voices = new Map(); // note -> Voice (keyboard / MIDI notes)
  let bendCents = 0;

  function ensureContext() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;
    chain = createSignalChain(ctx, analyser, settings);
    analyser.connect(ctx.destination);
  }

  function setStatus() {
    $("statusText").textContent = ctx && ctx.state === "running" ? "audio running" : "audio suspended";
  }

  function voiceOn(note, velocity) {
    ensureContext();
    if (ctx.state === "suspended") ctx.resume().then(setStatus);
    if (voices.has(note)) {
      voices.get(note).release(ctx.currentTime);
      voices.delete(note);
    }
    voices.set(note, new Voice(ctx, chain, note, velocity, ctx.currentTime, settings, bendCents));
  }

  function voiceOff(note) {
    const v = voices.get(note);
    if (v) {
      v.release(ctx.currentTime);
      voices.delete(note);
    }
  }

  // ---------- Note routing: keyboard / MIDI -> arp or voices, with sustain pedal ----------

  const physicalDown = new Set();
  const sustained = new Set();
  let sustainOn = false;

  function playNote(note, velocity = 0.9) {
    ensureContext();
    physicalDown.add(note);
    sustained.delete(note);
    highlightKey(note, true);
    if (arp.on) arpNoteOn(note);
    else voiceOn(note, velocity);
  }

  function stopNote(note) {
    physicalDown.delete(note);
    if (sustainOn) {
      sustained.add(note);
      return;
    }
    highlightKey(note, false);
    if (arp.on) arpNoteOff(note);
    else if (ctx) voiceOff(note);
  }

  function setSustain(on) {
    sustainOn = on;
    if (!on) {
      for (const n of Array.from(sustained)) {
        sustained.delete(n);
        if (!physicalDown.has(n)) {
          highlightKey(n, false);
          if (arp.on) arpNoteOff(n);
          else if (ctx) voiceOff(n);
        }
      }
    }
  }

  function allNotesOff() {
    physicalDown.clear();
    sustained.clear();
    sustainOn = false;
    if (ctx) for (const n of Array.from(voices.keys())) voiceOff(n);
    arpHeld.length = 0;
    stopArp();
    document.querySelectorAll(".key.active").forEach((k) => k.classList.remove("active"));
  }

  function setBend(cents) {
    bendCents = cents;
    if (!ctx) return;
    voices.forEach((v) => v.bend(cents, ctx.currentTime));
  }

  // ---------- Arpeggiator ----------

  const arp = { on: false, latch: false, mode: "up", rate: "1/16", octaves: 1, gate: 0.6 };
  const arpHeld = []; // in the order they were played
  let arpTimer = null;
  let arpNext = 0;
  let arpIndex = 0;
  let arpDir = 1;

  function bpm() {
    return clamp(parseFloat($("bpm").value) || 120, 40, 240);
  }

  function arpStepLen() {
    const beat = 60 / bpm();
    return { "1/8": beat / 2, "1/8T": beat / 3, "1/16": beat / 4, "1/16T": beat / 6, "1/32": beat / 8 }[arp.rate];
  }

  function arpNoteOn(note) {
    if (arp.latch && physicalDown.size === 1) arpHeld.length = 0; // new chord replaces a latched one
    if (!arpHeld.includes(note)) arpHeld.push(note);
    startArp();
  }

  function arpNoteOff(note) {
    if (arp.latch) return;
    const i = arpHeld.indexOf(note);
    if (i >= 0) arpHeld.splice(i, 1);
    if (arpHeld.length === 0) stopArp();
  }

  function arpSequence() {
    const base = arp.mode === "order" ? arpHeld.slice() : arpHeld.slice().sort((a, b) => a - b);
    const notes = [];
    for (let o = 0; o < arp.octaves; o++) base.forEach((n) => notes.push(n + 12 * o));
    if (arp.mode === "down") notes.reverse();
    return notes;
  }

  function nextArpNote() {
    const seq = arpSequence();
    if (!seq.length) return null;
    if (arp.mode === "random") return seq[Math.floor(Math.random() * seq.length)];
    if (arp.mode === "updown" && seq.length > 1) {
      if (arpIndex >= seq.length) arpIndex = seq.length - 1;
      const n = seq[arpIndex];
      if (arpIndex + arpDir >= seq.length || arpIndex + arpDir < 0) arpDir *= -1;
      arpIndex += arpDir;
      return n;
    }
    const n = seq[arpIndex % seq.length];
    arpIndex = (arpIndex + 1) % seq.length;
    return n;
  }

  function arpScheduler() {
    const len = arpStepLen();
    while (arpNext < ctx.currentTime + 0.1) {
      const note = nextArpNote();
      if (note === null) break;
      const v = new Voice(ctx, chain, note, 0.85, arpNext, settings, bendCents);
      v.release(arpNext + len * arp.gate);
      flashKey(note, arpNext);
      arpNext += len;
    }
  }

  function startArp() {
    if (arpTimer) return;
    ensureContext();
    if (ctx.state === "suspended") ctx.resume().then(setStatus);
    arpIndex = 0;
    arpDir = 1;
    const len = arpStepLen();
    // lock to the sequencer grid when it is running
    if (seqPlaying) {
      const since = ctx.currentTime - seqStartTime;
      arpNext = seqStartTime + Math.ceil(since / len) * len;
    } else {
      arpNext = ctx.currentTime + 0.02;
    }
    arpTimer = setInterval(arpScheduler, 25);
    arpScheduler();
  }

  function stopArp() {
    clearInterval(arpTimer);
    arpTimer = null;
  }

  function setArpOn(on) {
    allNotesOff();
    arp.on = on;
    $("arpToggle").textContent = on ? "Arp On" : "Arp Off";
    $("arpToggle").classList.toggle("active", on);
  }

  // ---------- Sequencer data ----------

  const SCALES = {
    Major: [0, 2, 4, 5, 7, 9, 11],
    Minor: [0, 2, 3, 5, 7, 8, 10],
    Dorian: [0, 2, 3, 5, 7, 9, 10],
    "Harmonic minor": [0, 2, 3, 5, 7, 8, 11],
    "Pentatonic major": [0, 2, 4, 7, 9],
    "Pentatonic minor": [0, 3, 5, 7, 10],
    Blues: [0, 3, 5, 6, 7, 10],
    Chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  };
  const ROWS = 8;
  const MAX_STEPS = 16;
  const DRUMS = ["kick", "snare", "hat"];
  const DRUM_LABELS = ["Kick", "Snare", "Hat"];

  const seq = { root: 0, scale: "Minor", length: 16, gate: 0.85, swing: 0 };

  const emptyPattern = () => ({
    notes: Array.from({ length: ROWS }, () => new Array(MAX_STEPS).fill(0)), // 0 off, 1 on, 2 accent
    drums: Array.from({ length: DRUMS.length }, () => new Array(MAX_STEPS).fill(0)),
  });
  const patterns = [emptyPattern(), emptyPattern(), emptyPattern(), emptyPattern()];
  let editSlot = 0;
  let chainMode = false;

  const patternHasNotes = (p) =>
    p.notes.some((r) => r.some(Boolean)) || p.drums.some((r) => r.some(Boolean));

  // Row 0 is the top row (highest note); rows walk up the scale from the root.
  function rowNotes(octaveRoot) {
    const sc = SCALES[seq.scale];
    const out = [];
    for (let i = 0; i < ROWS; i++) {
      const deg = sc[i % sc.length] + 12 * Math.floor(i / sc.length);
      out.push(octaveRoot + seq.root + deg);
    }
    return out.reverse();
  }

  function stepDuration() {
    return 60 / bpm() / 4;
  }

  // Schedules one step of one pattern into any context (live or offline export).
  function scheduleStep(audioCtx, c, pat, step, t, s, opts) {
    const dur = opts.dur;
    const notes = opts.rowNotes;
    for (let row = 0; row < ROWS; row++) {
      const v = pat.notes[row][step];
      if (!v) continue;
      const voice = new Voice(audioCtx, c, notes[row], v === 2 ? 1 : 0.65, t, s);
      voice.release(t + dur * opts.gate);
    }
    DRUMS.forEach((d, i) => {
      const v = pat.drums[i][step];
      if (v) playDrum(audioCtx, c, d, t, v === 2 ? 1 : 0.7);
    });
    const kickHit = pat.drums[0][step];
    if ((s.scSource === "kick" && kickHit) || (s.scSource === "beat" && step % 4 === 0)) {
      duckAt(c, t, s, opts.record);
    }
  }

  // ---------- Live sequencer transport ----------

  let seqPlaying = false;
  let seqTimer = null;
  let seqStep = 0;
  let seqNextTime = 0;
  let seqStartTime = 0;
  let playSlot = 0;

  function nextSlot(from) {
    for (let i = 1; i <= 4; i++) {
      const s = (from + i) % 4;
      if (patternHasNotes(patterns[s])) return s;
    }
    return from;
  }

  function seqScheduler() {
    while (seqNextTime < ctx.currentTime + 0.1) {
      const dur = stepDuration();
      const swingOffset = seqStep % 2 === 1 ? seq.swing * dur : 0;
      const t = seqNextTime + swingOffset;
      const slotNow = playSlot;
      scheduleStep(ctx, chain, patterns[slotNow], seqStep, t, settings, {
        dur,
        gate: seq.gate,
        rowNotes: rowNotes(baseNote()),
        record: true,
      });
      const stepNow = seqStep;
      setTimeout(() => updatePlayhead(stepNow, slotNow), Math.max(0, (t - ctx.currentTime) * 1000));
      seqNextTime += dur;
      seqStep++;
      if (seqStep >= seq.length) {
        seqStep = 0;
        playSlot = chainMode ? nextSlot(playSlot) : editSlot;
      }
    }
  }

  function startSequencer() {
    ensureContext();
    ctx.resume().then(setStatus);
    seqStep = 0;
    playSlot = editSlot;
    seqStartTime = seqNextTime = ctx.currentTime + 0.06;
    seqTimer = setInterval(seqScheduler, 25);
    seqPlaying = true;
    $("seqPlayBtn").textContent = "■ Stop";
    $("seqPlayBtn").classList.add("active");
  }

  function stopSequencer() {
    clearInterval(seqTimer);
    seqPlaying = false;
    clearPlayhead();
    $("seqPlayBtn").textContent = "▶ Play";
    $("seqPlayBtn").classList.remove("active");
  }

  function toggleSequencer() {
    if (seqPlaying) stopSequencer();
    else startSequencer();
  }

  // ---------- WAV export (offline render + hand-written PCM16 encoder) ----------

  function writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  function encodeWavBlob(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const numFrames = buffer.length;
    const blockAlign = numChannels * 2;
    const dataSize = numFrames * blockAlign;
    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);
    writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, "WAVE");
    writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, "data");
    view.setUint32(40, dataSize, true);
    const channels = [];
    for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));
    let offset = 44;
    for (let i = 0; i < numFrames; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let sample = clamp(channels[ch][i], -1, 1);
        sample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        view.setInt16(offset, sample, true);
        offset += 2;
      }
    }
    return new Blob([arrayBuffer], { type: "audio/wav" });
  }

  // Renders the pattern (or the A→D chain) with the exact same chain + scheduling code.
  async function renderPattern(loops) {
    const order = chainMode ? [0, 1, 2, 3].filter((i) => patternHasNotes(patterns[i])) : [editSlot];
    const snap = { ...settings };
    const dur = stepDuration();
    const sampleRate = ctx ? ctx.sampleRate : 44100;
    const patternTime = loops * order.length * seq.length * dur;
    const tail = snap.release + snap.delayTime * 4 + snap.reverbSize + 0.5;
    const offline = new OfflineAudioContext(2, Math.ceil((patternTime + tail) * sampleRate), sampleRate);
    const c = createSignalChain(offline, offline.destination, snap);
    const opts = { dur, gate: seq.gate, rowNotes: rowNotes(baseNote()), record: false };
    let t = 0;
    for (let l = 0; l < loops; l++) {
      for (const slot of order) {
        for (let step = 0; step < seq.length; step++) {
          const swingOffset = step % 2 === 1 ? seq.swing * dur : 0;
          scheduleStep(offline, c, patterns[slot], step, t + swingOffset, snap, opts);
          t += dur;
        }
      }
    }
    return offline.startRendering();
  }

  async function exportWav() {
    const order = chainMode ? [0, 1, 2, 3].filter((i) => patternHasNotes(patterns[i])) : [editSlot];
    if (!order.length || !patternHasNotes(patterns[order[0]])) {
      $("exportStatus").textContent = "Add some steps first.";
      return;
    }
    if (!window.OfflineAudioContext) {
      $("exportStatus").textContent = "OfflineAudioContext not supported in this browser.";
      return;
    }
    const btn = $("exportBtn");
    btn.disabled = true;
    $("exportStatus").textContent = "Rendering…";
    try {
      const rendered = await renderPattern(parseInt($("loops").value, 10) || 1);
      const blob = encodeWavBlob(rendered);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `web-synth-pattern-${Date.now()}.wav`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      $("exportStatus").textContent = `Downloaded ✓ (${rendered.duration.toFixed(1)}s, ${rendered.sampleRate}Hz PCM16 stereo)`;
    } catch (err) {
      $("exportStatus").textContent = "Export failed: " + err.message;
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- Controls ----------

  const SLIDERS = {
    unison: (v) => String(v),
    detune: (v) => Math.round(v) + " ct",
    attack: (v) => v.toFixed(2) + "s",
    decay: (v) => v.toFixed(2) + "s",
    sustain: (v) => v.toFixed(2),
    release: (v) => v.toFixed(2) + "s",
    cutoff: (v) => Math.round(v) + "Hz",
    resonance: (v) => v.toFixed(1),
    filterEnv: (v) => Math.round(v) + "Hz",
    lfoRate: (v) => v.toFixed(1) + "Hz",
    lfoDepth: (v) => Math.round(v * 100) + "%",
    drive: (v) => Math.round(v * 100) + "%",
    delayTime: (v) => v.toFixed(2) + "s",
    delayFeedback: (v) => Math.round(v * 100) + "%",
    delayMix: (v) => Math.round(v * 100) + "%",
    reverbSize: (v) => v.toFixed(1) + "s",
    reverbMix: (v) => Math.round(v * 100) + "%",
    scAmount: (v) => Math.round(v * 100) + "%",
    scRelease: (v) => v.toFixed(2) + "s",
    volume: (v) => Math.round(v * 100) + "%",
    drumVolume: (v) => Math.round(v * 100) + "%",
  };
  const SELECTS = ["lfoTarget", "lfoWave", "scSource"];

  let reverbTimer = null;
  function applyLive() {
    if (!chain) return;
    // regenerating the reverb is the only costly step, so it waits until the slider settles
    if (chain.reverbSize !== settings.reverbSize) {
      clearTimeout(reverbTimer);
      const keep = chain.reverbSize;
      reverbTimer = setTimeout(() => applyChainSettings(chain, settings), 150);
      const tmp = { ...settings, reverbSize: keep };
      applyChainSettings(chain, tmp);
      return;
    }
    applyChainSettings(chain, settings);
  }

  Object.entries(SLIDERS).forEach(([id, fmt]) => {
    const el = $(id);
    el.addEventListener("input", () => {
      settings[id] = parseFloat(el.value);
      $(id + "Val").textContent = fmt(settings[id]);
      applyLive();
      markCustom();
    });
  });
  SELECTS.forEach((id) => {
    $(id).addEventListener("change", () => {
      settings[id] = $(id).value;
      applyLive();
      markCustom();
    });
  });

  const waveButtons = document.querySelectorAll(".wave-btn");
  waveButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      settings.waveform = btn.dataset.wave;
      syncWaveButtons();
      markCustom();
    });
  });
  function syncWaveButtons() {
    waveButtons.forEach((b) => b.classList.toggle("active", b.dataset.wave === settings.waveform));
  }

  function syncUI() {
    Object.entries(SLIDERS).forEach(([id, fmt]) => {
      $(id).value = settings[id];
      $(id + "Val").textContent = fmt(settings[id]);
    });
    SELECTS.forEach((id) => ($(id).value = settings[id]));
    syncWaveButtons();
    applyLive();
  }

  $("startBtn").addEventListener("click", () => {
    ensureContext();
    ctx.resume().then(setStatus);
  });

  // ---------- Presets (built-in + saved in this browser) ----------

  const STORE_KEY = "websynth.presets.v2";
  let activePreset = "Init";

  function loadUserPresets() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    } catch (e) {
      return {};
    }
  }
  function saveUserPresets(obj) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  }

  function applyPreset(values, name) {
    SOUND_KEYS.forEach((k) => (settings[k] = DEFAULTS[k]));
    Object.entries(values).forEach(([k, v]) => {
      if (SOUND_KEYS.includes(k)) settings[k] = v;
    });
    activePreset = name;
    syncUI();
    renderPresetButtons();
  }

  function markCustom() {
    if (activePreset !== null) {
      activePreset = null;
      renderPresetButtons();
    }
  }

  function renderPresetButtons() {
    const box = $("presetButtons");
    box.innerHTML = "";
    Object.keys(PRESETS).forEach((name) => {
      const b = document.createElement("button");
      b.textContent = name;
      b.className = "preset-btn" + (activePreset === name ? " active" : "");
      b.addEventListener("click", () => applyPreset(PRESETS[name], name));
      box.appendChild(b);
    });
  }

  function renderUserPresetList() {
    const sel = $("userPresets");
    const user = loadUserPresets();
    sel.innerHTML = '<option value="">Your presets</option>';
    Object.keys(user).forEach((name) => {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name;
      sel.appendChild(o);
    });
  }

  $("savePresetBtn").addEventListener("click", () => {
    const name = $("presetName").value.trim();
    if (!name) {
      $("presetName").focus();
      return;
    }
    const user = loadUserPresets();
    const values = {};
    SOUND_KEYS.forEach((k) => (values[k] = settings[k]));
    user[name] = values;
    if (saveUserPresets(user)) {
      $("presetName").value = "";
      renderUserPresetList();
      $("userPresets").value = name;
    }
  });
  $("userPresets").addEventListener("change", () => {
    const name = $("userPresets").value;
    const user = loadUserPresets();
    if (name && user[name]) applyPreset(user[name], name);
  });
  $("deletePresetBtn").addEventListener("click", () => {
    const name = $("userPresets").value;
    if (!name) return;
    const user = loadUserPresets();
    delete user[name];
    saveUserPresets(user);
    renderUserPresetList();
  });

  // ---------- Arp controls ----------

  $("arpToggle").addEventListener("click", () => setArpOn(!arp.on));
  $("arpLatch").addEventListener("click", () => {
    arp.latch = !arp.latch;
    $("arpLatch").textContent = arp.latch ? "Latch On" : "Latch Off";
    $("arpLatch").classList.toggle("active", arp.latch);
    if (!arp.latch) {
      for (let i = arpHeld.length - 1; i >= 0; i--) if (!physicalDown.has(arpHeld[i])) arpHeld.splice(i, 1);
      if (!arpHeld.length) stopArp();
    }
  });
  $("arpMode").addEventListener("change", () => {
    arp.mode = $("arpMode").value;
    arpIndex = 0;
  });
  $("arpRate").addEventListener("change", () => (arp.rate = $("arpRate").value));
  $("arpOctaves").addEventListener("input", () => {
    arp.octaves = parseInt($("arpOctaves").value, 10);
    $("arpOctavesVal").textContent = arp.octaves;
  });
  $("arpGate").addEventListener("input", () => {
    arp.gate = parseFloat($("arpGate").value);
    $("arpGateVal").textContent = Math.round(arp.gate * 100) + "%";
  });

  // ---------- On-screen keyboard ----------

  const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11];
  const BLACK_OFFSETS = [1, 3, null, 6, 8, 10, null];
  let octave = 4;
  const baseNote = () => (octave + 1) * 12;
  const NUM_OCTAVES = 2;

  function buildKeyboard() {
    const kb = $("keyboard");
    kb.innerHTML = "";
    const start = baseNote();
    const whiteWidthPct = 100 / (NUM_OCTAVES * 7);
    let whiteIndex = 0;
    for (let oct = 0; oct < NUM_OCTAVES; oct++) {
      for (let i = 0; i < 7; i++) {
        const note = start + oct * 12 + WHITE_OFFSETS[i];
        const key = document.createElement("div");
        key.className = "key white";
        key.dataset.note = note;
        key.style.width = whiteWidthPct + "%";
        const label = document.createElement("span");
        label.className = "keylabel";
        label.textContent = noteName(note);
        key.appendChild(label);
        kb.appendChild(key);
        attachKeyEvents(key, note);
        const bo = BLACK_OFFSETS[i];
        if (bo !== null) {
          const blackNote = start + oct * 12 + bo;
          const bkey = document.createElement("div");
          bkey.className = "key black";
          bkey.dataset.note = blackNote;
          bkey.style.left = `calc(${whiteIndex * whiteWidthPct}% + ${whiteWidthPct * 0.65}%)`;
          bkey.style.width = whiteWidthPct * 0.7 + "%";
          kb.appendChild(bkey);
          attachKeyEvents(bkey, blackNote);
        }
        whiteIndex++;
      }
    }
  }

  let mouseIsDown = false;
  document.addEventListener("mousedown", () => (mouseIsDown = true));
  document.addEventListener("mouseup", () => (mouseIsDown = false));

  function attachKeyEvents(el, note) {
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      playNote(note, 0.9);
    });
    el.addEventListener("mouseenter", () => {
      if (mouseIsDown) playNote(note, 0.9);
    });
    el.addEventListener("mouseup", () => stopNote(note));
    el.addEventListener("mouseleave", () => {
      if (physicalDown.has(note)) stopNote(note);
    });
    el.addEventListener("touchstart", (e) => {
      e.preventDefault();
      playNote(note, 0.9);
    });
    el.addEventListener("touchend", (e) => {
      e.preventDefault();
      stopNote(note);
    });
  }

  function highlightKey(note, on) {
    const el = document.querySelector(`.key[data-note="${note}"]`);
    if (el) el.classList.toggle("active", on);
  }

  function flashKey(note, atTime) {
    const delay = Math.max(0, (atTime - ctx.currentTime) * 1000);
    setTimeout(() => {
      const el = document.querySelector(`.key[data-note="${note}"]`);
      if (!el) return;
      el.classList.add("arp-hit");
      setTimeout(() => el.classList.remove("arp-hit"), 90);
    }, delay);
  }

  function changeOctave(delta) {
    allNotesOff();
    octave = clamp(octave + delta, 0, 7);
    $("octaveLabel").textContent = "Octave: " + octave;
    buildKeyboard();
    renderSequencer();
  }
  $("octaveDown").addEventListener("click", () => changeOctave(-1));
  $("octaveUp").addEventListener("click", () => changeOctave(1));

  // ---------- Computer keyboard ----------

  const KEY_TO_SEMITONE = {
    a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
    k: 12, o: 13, l: 14, p: 15, ";": 16,
  };
  const activeComputerKeys = new Map();
  const isTyping = (e) => {
    const tag = (e.target && e.target.tagName) || "";
    return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
  };

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
    if (isTyping(e) || e.repeat || e.metaKey || e.ctrlKey) return;
    const key = e.key.toLowerCase();
    if (key === " ") {
      e.preventDefault();
      toggleSequencer();
      return;
    }
    if (key === "z") return changeOctave(-1);
    if (key === "x") return changeOctave(1);
    if (!(key in KEY_TO_SEMITONE) || activeComputerKeys.has(key)) return;
    const note = baseNote() + KEY_TO_SEMITONE[key];
    activeComputerKeys.set(key, note);
    playNote(note, 0.9);
  });

  window.addEventListener("keyup", (e) => {
    const key = e.key.toLowerCase();
    if (!activeComputerKeys.has(key)) return;
    const note = activeComputerKeys.get(key);
    activeComputerKeys.delete(key);
    stopNote(note);
  });

  window.addEventListener("blur", allNotesOff);

  // ---------- MIDI ----------

  let midiAccess = null;
  let ledTimer = null;

  function midiBlink() {
    $("midiLed").classList.add("on");
    clearTimeout(ledTimer);
    ledTimer = setTimeout(() => $("midiLed").classList.remove("on"), 80);
  }

  function refreshMidiDeviceList() {
    const select = $("midiDevices");
    select.innerHTML = "";
    if (!midiAccess || midiAccess.inputs.size === 0) {
      const opt = document.createElement("option");
      opt.textContent = "No devices connected";
      select.appendChild(opt);
      return;
    }
    for (const input of midiAccess.inputs.values()) {
      const opt = document.createElement("option");
      opt.value = input.id;
      opt.textContent = input.name || input.id;
      select.appendChild(opt);
    }
  }

  function handleMidiMessage(msg) {
    const [status, d1, d2] = msg.data;
    const cmd = status & 0xf0;
    midiBlink();
    if (cmd === 0x90 && d2 > 0) {
      playNote(d1, d2 / 127);
    } else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) {
      stopNote(d1);
    } else if (cmd === 0xb0) {
      if (d1 === 64) {
        setSustain(d2 >= 64);
      } else if (d1 === 1) {
        // mod wheel -> filter cutoff
        const el = $("cutoff");
        el.value = 80 + (d2 / 127) * (12000 - 80);
        el.dispatchEvent(new Event("input"));
      } else if (d1 === 123) {
        allNotesOff();
      }
    } else if (cmd === 0xe0) {
      const value = (d2 << 7) | d1; // 14-bit, centre 8192
      setBend(((value - 8192) / 8192) * 200); // ±2 semitones
    }
  }

  function midiStatusText() {
    return midiAccess.inputs.size > 0
      ? `MIDI on: ${midiAccess.inputs.size} device(s)`
      : "MIDI on: no devices yet";
  }

  $("midiBtn").addEventListener("click", () => {
    if (!navigator.requestMIDIAccess) {
      $("midiStatus").textContent = "Web MIDI not supported in this browser";
      return;
    }
    navigator
      .requestMIDIAccess()
      .then((access) => {
        midiAccess = access;
        const attach = () => {
          for (const input of midiAccess.inputs.values()) input.onmidimessage = handleMidiMessage;
          refreshMidiDeviceList();
          $("midiStatus").textContent = midiStatusText();
        };
        attach();
        midiAccess.onstatechange = attach;
      })
      .catch((err) => {
        $("midiStatus").textContent = "MIDI access denied: " + err.message;
      });
  });

  // ---------- Sequencer UI ----------

  let brush = "note";
  let painting = false;
  let paintValue = 0;

  function fillScaleSelectors() {
    const rootSel = $("seqRoot");
    NOTE_NAMES.forEach((n, i) => {
      const o = document.createElement("option");
      o.value = i;
      o.textContent = n;
      rootSel.appendChild(o);
    });
    rootSel.value = seq.root;
    const scaleSel = $("seqScale");
    Object.keys(SCALES).forEach((name) => {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name;
      scaleSel.appendChild(o);
    });
    scaleSel.value = seq.scale;
  }

  function cellValue(lane, row, step) {
    const p = patterns[editSlot];
    return lane === "n" ? p.notes[row][step] : p.drums[row][step];
  }

  function setCell(lane, row, step, v) {
    const p = patterns[editSlot];
    if (lane === "n") p.notes[row][step] = v;
    else p.drums[row][step] = v;
  }

  function cellClass(v, step) {
    let c = "seq-cell";
    if (v === 1) c += " on";
    if (v === 2) c += " accent";
    if (step >= seq.length) c += " disabled";
    if (step % 4 === 0) c += " beat";
    return c;
  }

  function renderSequencer() {
    const labels = $("seqLabels");
    const grid = $("seqGrid");
    labels.innerHTML = "";
    grid.innerHTML = "";
    const notes = rowNotes(baseNote());
    const addRow = (lane, row, label, cls) => {
      const lab = document.createElement("div");
      lab.className = "seq-label " + cls;
      lab.textContent = label;
      labels.appendChild(lab);
      const rowEl = document.createElement("div");
      rowEl.className = "seq-row " + cls;
      for (let step = 0; step < MAX_STEPS; step++) {
        const cell = document.createElement("div");
        cell.className = cellClass(cellValue(lane, row, step), step);
        cell.dataset.lane = lane;
        cell.dataset.row = row;
        cell.dataset.step = step;
        rowEl.appendChild(cell);
      }
      grid.appendChild(rowEl);
    };
    for (let r = 0; r < ROWS; r++) addRow("n", r, noteName(notes[r]), "note-row");
    const spacerL = document.createElement("div");
    spacerL.className = "seq-spacer";
    labels.appendChild(spacerL);
    const spacerG = document.createElement("div");
    spacerG.className = "seq-spacer";
    grid.appendChild(spacerG);
    DRUMS.forEach((d, i) => addRow("d", i, DRUM_LABELS[i], "drum-row"));
    renderSlots();
  }

  function updateCellEl(el) {
    const v = cellValue(el.dataset.lane, +el.dataset.row, +el.dataset.step);
    const keepPlayhead = el.classList.contains("playhead");
    el.className = cellClass(v, +el.dataset.step) + (keepPlayhead ? " playhead" : "");
  }

  function applyPaint(el) {
    if (!el || !el.classList.contains("seq-cell") || el.classList.contains("disabled")) return;
    const lane = el.dataset.lane;
    const row = +el.dataset.row;
    const step = +el.dataset.step;
    if (cellValue(lane, row, step) === paintValue) return;
    setCell(lane, row, step, paintValue);
    updateCellEl(el);
    renderSlots();
    if (paintValue && !seqPlaying) previewCell(lane, row);
  }

  function previewCell(lane, row) {
    ensureContext();
    if (ctx.state === "suspended") ctx.resume().then(setStatus);
    const t = ctx.currentTime + 0.01;
    if (lane === "n") {
      const v = new Voice(ctx, chain, rowNotes(baseNote())[row], paintValue === 2 ? 1 : 0.65, t, settings);
      v.release(t + 0.18);
    } else {
      playDrum(ctx, chain, DRUMS[row], t, 0.8);
    }
  }

  const gridEl = $("seqGrid");
  gridEl.addEventListener("pointerdown", (e) => {
    const el = e.target;
    if (!el.classList.contains("seq-cell") || el.classList.contains("disabled")) return;
    e.preventDefault();
    const cur = cellValue(el.dataset.lane, +el.dataset.row, +el.dataset.step);
    if (brush === "erase") paintValue = 0;
    else if (brush === "accent") paintValue = cur === 2 ? 0 : 2;
    else paintValue = cur ? 0 : 1;
    painting = true;
    applyPaint(el);
  });
  gridEl.addEventListener("pointermove", (e) => {
    if (!painting) return;
    applyPaint(document.elementFromPoint(e.clientX, e.clientY));
  });
  window.addEventListener("pointerup", () => (painting = false));
  gridEl.addEventListener("contextmenu", (e) => e.preventDefault());

  document.querySelectorAll("#brushGroup button").forEach((b) => {
    b.addEventListener("click", () => {
      brush = b.dataset.brush;
      document.querySelectorAll("#brushGroup button").forEach((x) => x.classList.toggle("active", x === b));
    });
  });

  function updatePlayhead(step, slot) {
    clearPlayhead();
    if (!seqPlaying || slot !== editSlot) {
      renderSlots(slot);
      return;
    }
    document.querySelectorAll(`.seq-cell[data-step="${step}"]`).forEach((c) => c.classList.add("playhead"));
    renderSlots(slot);
  }

  function clearPlayhead() {
    document.querySelectorAll(".seq-cell.playhead").forEach((c) => c.classList.remove("playhead"));
  }

  function renderSlots(playing = seqPlaying ? playSlot : -1) {
    const box = $("slotButtons");
    if (!box.children.length) {
      ["A", "B", "C", "D"].forEach((name, i) => {
        const b = document.createElement("button");
        b.className = "slot-btn";
        b.textContent = name;
        b.addEventListener("click", () => {
          editSlot = i;
          if (!chainMode) playSlot = i;
          renderSequencer();
        });
        box.appendChild(b);
      });
    }
    Array.from(box.children).forEach((b, i) => {
      b.classList.toggle("active", i === editSlot);
      b.classList.toggle("filled", patternHasNotes(patterns[i]));
      b.classList.toggle("playing", i === playing);
    });
  }

  $("seqRoot").addEventListener("change", () => {
    seq.root = parseInt($("seqRoot").value, 10);
    renderSequencer();
  });
  $("seqScale").addEventListener("change", () => {
    seq.scale = $("seqScale").value;
    renderSequencer();
  });
  $("seqLength").addEventListener("change", () => {
    seq.length = parseInt($("seqLength").value, 10);
    if (seqStep >= seq.length) seqStep = 0;
    renderSequencer();
  });
  $("seqGate").addEventListener("input", () => {
    seq.gate = parseFloat($("seqGate").value);
    $("seqGateVal").textContent = Math.round(seq.gate * 100) + "%";
  });
  $("swing").addEventListener("input", () => {
    seq.swing = parseFloat($("swing").value);
    $("swingVal").textContent = Math.round(seq.swing * 200) + "%";
  });

  function shiftPattern(dir) {
    const p = patterns[editSlot];
    const rot = (arr) => {
      const part = arr.slice(0, seq.length);
      const out = dir > 0 ? [part[part.length - 1], ...part.slice(0, -1)] : [...part.slice(1), part[0]];
      for (let i = 0; i < seq.length; i++) arr[i] = out[i];
    };
    p.notes.forEach(rot);
    p.drums.forEach(rot);
    renderSequencer();
  }
  $("seqShiftLeft").addEventListener("click", () => shiftPattern(-1));
  $("seqShiftRight").addEventListener("click", () => shiftPattern(1));

  function randomPattern() {
    const p = emptyPattern();
    const len = seq.length;
    let prevRow = ROWS - 1 - Math.floor(Math.random() * 3);
    for (let s = 0; s < len; s++) {
      const onBeat = s % 4 === 0;
      if (Math.random() < (onBeat ? 0.7 : 0.35)) {
        prevRow = clamp(prevRow + Math.floor(Math.random() * 5) - 2, 0, ROWS - 1);
        p.notes[prevRow][s] = Math.random() < (onBeat ? 0.4 : 0.15) ? 2 : 1;
      }
      if (s % 4 === 0) p.drums[0][s] = 2;
      else if (Math.random() < 0.08) p.drums[0][s] = 1;
      if (s % 8 === 4) p.drums[1][s] = 1;
      if (s % 2 === 1 || Math.random() < 0.25) p.drums[2][s] = s % 4 === 2 ? 2 : 1;
    }
    patterns[editSlot] = p;
    renderSequencer();
  }
  $("seqRandomBtn").addEventListener("click", randomPattern);
  $("seqClearBtn").addEventListener("click", () => {
    patterns[editSlot] = emptyPattern();
    renderSequencer();
  });

  $("chainBtn").addEventListener("click", () => {
    chainMode = !chainMode;
    $("chainBtn").textContent = chainMode ? "Chain On" : "Chain Off";
    $("chainBtn").classList.toggle("active", chainMode);
  });

  $("seqPlayBtn").addEventListener("click", toggleSequencer);
  $("exportBtn").addEventListener("click", exportWav);

  // ---------- Visuals: see what you hear ----------

  const ACCENT = "#6ee7c2";
  const ACCENT_2 = "#ffd166";
  const GRID = "#2c303a";
  const DIM = "#8b8f9c";

  function fit(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return null;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return { g, w, h };
  }

  function label(g, text, x, y, color = DIM, align = "left") {
    g.fillStyle = color;
    g.font = "10px -apple-system, Segoe UI, Roboto, sans-serif";
    g.textAlign = align;
    g.fillText(text, x, y);
  }

  const nowSec = () => (ctx ? ctx.currentTime : performance.now() / 1000);

  function lfoValue(phase, wave) {
    const p = phase - Math.floor(phase);
    if (wave === "sine") return Math.sin(2 * Math.PI * p);
    if (wave === "triangle") return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4;
    if (wave === "square") return p < 0.5 ? 1 : -1;
    return 2 * p - 1; // sawtooth
  }

  let timeData = null;
  let freqData = null;

  function drawScope() {
    const f = fit($("scope"));
    if (!f) return;
    const { g, w, h } = f;
    g.strokeStyle = GRID;
    g.beginPath();
    g.moveTo(0, h / 2);
    g.lineTo(w, h / 2);
    g.stroke();
    if (!analyser) {
      label(g, "Press Start Audio and play a note", w / 2, h / 2 - 6, DIM, "center");
      return;
    }
    if (!timeData) timeData = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(timeData);
    // start at a rising zero crossing so the wave stands still
    let start = 0;
    for (let i = 1; i < timeData.length / 2; i++) {
      if (timeData[i - 1] < 128 && timeData[i] >= 128) {
        start = i;
        break;
      }
    }
    const n = Math.floor(timeData.length / 2);
    g.lineWidth = 2;
    g.strokeStyle = ACCENT;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / n) * w;
      const y = (timeData[start + i] / 255) * h;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }

  function drawSpectrum() {
    const f = fit($("spectrum"));
    if (!f) return;
    const { g, w, h } = f;
    if (!analyser) {
      label(g, "Frequencies light up here", w / 2, h / 2, DIM, "center");
      return;
    }
    if (!freqData) freqData = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(freqData);
    const bars = 48;
    const nyq = ctx.sampleRate / 2;
    const bw = w / bars;
    for (let b = 0; b < bars; b++) {
      const f0 = 30 * Math.pow(16000 / 30, b / bars);
      const f1 = 30 * Math.pow(16000 / 30, (b + 1) / bars);
      const i0 = Math.floor((f0 / nyq) * freqData.length);
      const i1 = Math.max(i0 + 1, Math.floor((f1 / nyq) * freqData.length));
      let m = 0;
      for (let i = i0; i < i1 && i < freqData.length; i++) m = Math.max(m, freqData[i]);
      const bh = (m / 255) * (h - 14);
      const grad = g.createLinearGradient(0, h, 0, h - bh);
      grad.addColorStop(0, "#3a8f74");
      grad.addColorStop(1, ACCENT);
      g.fillStyle = grad;
      g.fillRect(b * bw + 1, h - 12 - bh, bw - 2, bh);
    }
    ["100", "1k", "10k"].forEach((t, i) => {
      const hz = [100, 1000, 10000][i];
      const x = (Math.log(hz / 30) / Math.log(16000 / 30)) * w;
      label(g, t + "Hz", x, h - 1, DIM, "center");
    });
  }

  function drawUnison() {
    const f = fit($("unisonViz"));
    if (!f) return;
    const { g, w, h } = f;
    const n = settings.unison;
    const mid = w / 2;
    g.strokeStyle = GRID;
    g.beginPath();
    g.moveTo(mid, 4);
    g.lineTo(mid, h - 12);
    g.stroke();
    for (let i = 0; i < n; i++) {
      const spread = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
      const x = mid + spread * (settings.detune / 50) * (w / 2 - 12);
      g.fillStyle = ACCENT;
      g.globalAlpha = 0.5 + 0.5 / n;
      g.fillRect(x - 2, 6, 4, h - 20);
      g.globalAlpha = 1;
    }
    label(g, "flat", 4, h - 2);
    label(g, "sharp", w - 4, h - 2, DIM, "right");
    label(g, `${n} voice${n > 1 ? "s" : ""}`, mid, h - 2, DIM, "center");
  }

  function drawADSR() {
    const f = fit($("adsrViz"));
    if (!f) return;
    const { g, w, h } = f;
    const { attack: a, decay: d, sustain: s, release: r } = settings;
    const hold = 0.4;
    const total = a + d + hold + r || 1;
    const X = (t) => 6 + (t / total) * (w - 12);
    const Y = (v) => h - 8 - v * (h - 16);
    g.strokeStyle = ACCENT;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(X(0), Y(0));
    g.lineTo(X(a), Y(1));
    g.lineTo(X(a + d), Y(s));
    g.lineTo(X(a + d + hold), Y(s));
    g.lineTo(X(total), Y(0));
    g.stroke();
    g.fillStyle = "rgba(110,231,194,0.12)";
    g.lineTo(X(0), Y(0));
    g.fill();
    label(g, "A", X(a / 2), h - 1, DIM, "center");
    label(g, "D", X(a + d / 2), h - 1, DIM, "center");
    label(g, "S", X(a + d + hold / 2), h - 1, DIM, "center");
    label(g, "R", X(a + d + hold + r / 2), h - 1, DIM, "center");
  }

  // A silent probe filter: same settings as the voices, used only to draw its curve.
  const probeCtx = window.OfflineAudioContext ? new OfflineAudioContext(1, 128, 44100) : null;
  const probe = probeCtx ? probeCtx.createBiquadFilter() : null;
  const FREQS = new Float32Array(160);
  for (let i = 0; i < FREQS.length; i++) FREQS[i] = 20 * Math.pow(1000, i / (FREQS.length - 1));
  const MAG = new Float32Array(FREQS.length);
  const PHASE = new Float32Array(FREQS.length);

  function drawFilter() {
    const f = fit($("filterViz"));
    if (!f || !probe) return;
    const { g, w, h } = f;
    let cutoff = settings.cutoff;
    const lfoOn = settings.lfoTarget === "filter";
    if (lfoOn) {
      const v = lfoValue(nowSec() * settings.lfoRate, settings.lfoWave);
      cutoff = clamp(cutoff + v * settings.lfoDepth * LFO_SCALE.filter, 20, 20000);
    }
    probe.type = "lowpass";
    probe.frequency.value = cutoff;
    probe.Q.value = settings.resonance;
    probe.getFrequencyResponse(FREQS, MAG, PHASE);
    const X = (hz) => (Math.log(hz / 20) / Math.log(1000)) * w;
    const Y = (db) => clamp(h - 12 - ((db + 36) / 60) * (h - 16), 2, h - 12);
    g.strokeStyle = GRID;
    g.beginPath();
    g.moveTo(0, Y(0));
    g.lineTo(w, Y(0));
    g.stroke();
    g.strokeStyle = lfoOn ? ACCENT_2 : ACCENT;
    g.lineWidth = 2;
    g.beginPath();
    for (let i = 0; i < FREQS.length; i++) {
      const db = 20 * Math.log10(Math.max(1e-5, MAG[i]));
      const x = X(FREQS[i]);
      if (i === 0) g.moveTo(x, Y(db));
      else g.lineTo(x, Y(db));
    }
    g.stroke();
    g.strokeStyle = "rgba(255,255,255,0.25)";
    g.setLineDash([3, 3]);
    g.beginPath();
    g.moveTo(X(cutoff), 2);
    g.lineTo(X(cutoff), h - 12);
    g.stroke();
    g.setLineDash([]);
    label(g, "100", X(100), h - 1, DIM, "center");
    label(g, "1k", X(1000), h - 1, DIM, "center");
    label(g, "10k", X(10000), h - 1, DIM, "center");
    if (lfoOn) label(g, "LFO moving it", w - 4, 10, ACCENT_2, "right");
  }

  function drawLFO() {
    const f = fit($("lfoViz"));
    if (!f) return;
    const { g, w, h } = f;
    const off = settings.lfoTarget === "off";
    const mid = (h - 10) / 2;
    const amp = mid - 4;
    const depth = off ? 0.3 : 0.25 + settings.lfoDepth * 0.75;
    g.strokeStyle = GRID;
    g.beginPath();
    g.moveTo(0, mid);
    g.lineTo(w, mid);
    g.stroke();
    g.strokeStyle = off ? DIM : ACCENT;
    g.lineWidth = 2;
    g.beginPath();
    for (let x = 0; x <= w; x++) {
      const y = mid - lfoValue((x / w) * 2, settings.lfoWave) * amp * depth;
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    if (!off) {
      const phase = (nowSec() * settings.lfoRate) % 2;
      const x = (phase / 2) * w;
      const y = mid - lfoValue(phase, settings.lfoWave) * amp * depth;
      g.fillStyle = ACCENT_2;
      g.beginPath();
      g.arc(x, y, 4, 0, Math.PI * 2);
      g.fill();
    }
    label(g, off ? "LFO off: pick a target" : `moving the ${settings.lfoTarget}`, 4, h - 1);
  }

  function drawDrive() {
    const f = fit($("driveViz"));
    if (!f) return;
    const { g, w, h } = f;
    const curve = makeDriveCurve(settings.drive);
    const size = Math.min(w, h) - 6;
    const ox = (w - size) / 2;
    const oy = 3;
    g.strokeStyle = GRID;
    g.strokeRect(ox, oy, size, size);
    g.beginPath();
    g.moveTo(ox, oy + size);
    g.lineTo(ox + size, oy);
    g.stroke();
    g.strokeStyle = settings.drive > 0 ? ACCENT_2 : ACCENT;
    g.lineWidth = 2;
    g.beginPath();
    for (let i = 0; i < curve.length; i += 8) {
      const x = ox + (i / (curve.length - 1)) * size;
      const y = oy + size - ((curve[i] * driveMakeup(settings.drive) + 1) / 2) * size;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    label(g, "in →", ox - 4, oy + size, DIM, "right");
    label(g, "out", ox - 4, oy + 8, DIM, "right");
  }

  function drawDelay() {
    const f = fit($("delayViz"));
    if (!f) return;
    const { g, w, h } = f;
    const span = 2.5;
    const X = (t) => 6 + (t / span) * (w - 12);
    const base = h - 12;
    g.strokeStyle = GRID;
    g.beginPath();
    g.moveTo(0, base);
    g.lineTo(w, base);
    g.stroke();
    g.fillStyle = DIM;
    g.fillRect(X(0) - 2, 4, 4, base - 4);
    let amp = settings.delayMix;
    for (let k = 1; k < 40 && amp > 0.01; k++) {
      const t = k * settings.delayTime;
      if (t > span) break;
      g.fillStyle = ACCENT;
      g.globalAlpha = 0.4 + 0.6 * amp;
      const bh = Math.sqrt(amp) * (base - 4); // sqrt so quiet echoes stay visible
      g.fillRect(X(t) - 2, base - bh, 4, bh);
      amp *= settings.delayFeedback;
    }
    g.globalAlpha = 1;
    label(g, "note", X(0) + 4, 10);
    label(g, settings.delayMix > 0 ? "echoes →" : "Mix at 0%: no echoes", w - 4, 10, DIM, "right");
    label(g, "0s", X(0), h - 1, DIM, "left");
    label(g, span + "s", w - 4, h - 1, DIM, "right");
  }

  function drawReverb() {
    const f = fit($("reverbViz"));
    if (!f) return;
    const { g, w, h } = f;
    const span = 6;
    const base = h - 12;
    const X = (t) => 4 + (t / span) * (w - 8);
    const size = settings.reverbSize;
    const mix = settings.reverbMix;
    g.strokeStyle = GRID;
    g.beginPath();
    g.moveTo(0, base);
    g.lineTo(w, base);
    g.stroke();
    for (let x = X(0); x < X(size); x += 2) {
      const t = ((x - 4) / (w - 8)) * span;
      const env = Math.pow(1 - t / size, 3);
      const jitter = 0.55 + 0.45 * Math.abs(Math.sin(x * 12.9898) * 43758.5453 % 1);
      const bh = env * jitter * Math.max(0.08, mix) * (base - 4);
      g.fillStyle = mix > 0 ? ACCENT : DIM;
      g.fillRect(x, base - bh, 1.5, bh);
    }
    label(g, `tail ${size.toFixed(1)}s`, X(size), 10, DIM, "center");
    label(g, mix > 0 ? `${Math.round(mix * 100)}% wet` : "Mix at 0%: dry", w - 4, h - 1, DIM, "right");
  }

  const duckHistory = new Array(160).fill(1);
  function drawSidechain() {
    const f = fit($("sidechainViz"));
    if (!f) return;
    const { g, w, h } = f;
    duckHistory.push(ctx ? duckGainAt(ctx.currentTime) : 1);
    duckHistory.shift();
    const Y = (v) => 4 + (1 - v) * (h - 18);
    g.strokeStyle = GRID;
    g.beginPath();
    g.moveTo(0, Y(1));
    g.lineTo(w, Y(1));
    g.stroke();
    g.strokeStyle = settings.scAmount > 0 ? ACCENT : DIM;
    g.lineWidth = 2;
    g.beginPath();
    duckHistory.forEach((v, i) => {
      const x = (i / (duckHistory.length - 1)) * w;
      if (i === 0) g.moveTo(x, Y(v));
      else g.lineTo(x, Y(v));
    });
    g.stroke();
    const cur = duckHistory[duckHistory.length - 1];
    label(g, `synth level ${Math.round(cur * 100)}%`, 4, h - 1);
    if (settings.scAmount === 0) label(g, "Amount at 0%: off", w - 4, h - 1, DIM, "right");
    else if (!seqPlaying) label(g, "Press Play to see it pump", w - 4, h - 1, DIM, "right");
  }

  function frame() {
    requestAnimationFrame(frame);
    drawScope();
    drawSpectrum();
    drawUnison();
    drawADSR();
    drawFilter();
    drawLFO();
    drawDrive();
    drawDelay();
    drawReverb();
    drawSidechain();
  }

  // ---------- About drawer ----------

  const drawer = $("aboutDrawer");
  const drawerBackdrop = $("drawerBackdrop");
  let metricsIntervalId = null;

  function updateMetrics() {
    $("metricState").textContent = ctx ? ctx.state : "not started";
    $("metricSampleRate").textContent = ctx ? ctx.sampleRate + " Hz" : "—";
    $("metricVoices").textContent = voices.size;
    const el = $("metricLatency");
    if (ctx && typeof ctx.outputLatency === "number" && ctx.outputLatency > 0) {
      el.textContent = (ctx.outputLatency * 1000).toFixed(1) + " ms";
    } else if (ctx && typeof ctx.baseLatency === "number") {
      el.textContent = (ctx.baseLatency * 1000).toFixed(1) + " ms (base)";
    } else {
      el.textContent = "n/a";
    }
  }

  function openDrawer() {
    drawer.classList.add("open");
    drawerBackdrop.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    updateMetrics();
    metricsIntervalId = setInterval(updateMetrics, 1000);
  }

  function closeDrawer() {
    drawer.classList.remove("open");
    drawerBackdrop.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    clearInterval(metricsIntervalId);
  }

  $("aboutBtn").addEventListener("click", openDrawer);
  $("closeDrawer").addEventListener("click", closeDrawer);
  drawerBackdrop.addEventListener("click", closeDrawer);
  $("githubLink").href = GITHUB_REPO_URL;

  // ---------- Boot ----------

  fillScaleSelectors();
  buildKeyboard();
  renderPresetButtons();
  renderUserPresetList();
  syncUI();
  renderSequencer();
  requestAnimationFrame(frame);

  // Small hook for automated tests (no effect on normal use).
  window.__webSynth = { settings, patterns, renderPattern, applyPreset, PRESETS, randomPattern, seq };
})();
