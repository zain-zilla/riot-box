(() => {
  "use strict";

  const GITHUB_REPO_URL = "https://github.com/zainluthu/web-synth";

  // ---------- Audio engine ----------

  const settings = {
    waveform: "sine",
    attack: 0.01,
    decay: 0.1,
    sustain: 0.7,
    release: 0.3,
    cutoff: 4000,
    resonance: 1,
    filterEnv: 2000,
    delayTime: 0.25,
    delayFeedback: 0.3,
    delayMix: 0,
  };

  let ctx = null;
  let analyser = null;
  let chain = null; // live signal chain: { voiceBus, master, delayNode, feedbackGain, wetGain }
  const voices = new Map(); // note number -> Voice

  // Builds the full signal chain: voices -> [dry -> master] + [delay bus -> master] -> destination.
  // Used for both the live AudioContext and offline (export) rendering, so the two paths share
  // identical topology and the exported file matches what you actually hear.
  function createSignalChain(audioCtx, destination, volume, delayTime, delayFeedback, delayMix) {
    const voiceBus = audioCtx.createGain();
    voiceBus.gain.value = 1;

    const dryGain = audioCtx.createGain();
    dryGain.gain.value = 1;

    const delayNode = audioCtx.createDelay(2.0);
    delayNode.delayTime.value = delayTime;

    const feedbackGain = audioCtx.createGain();
    feedbackGain.gain.value = delayFeedback;

    const wetGain = audioCtx.createGain();
    wetGain.gain.value = delayMix;

    const master = audioCtx.createGain();
    master.gain.value = volume;

    voiceBus.connect(dryGain).connect(master);
    voiceBus.connect(delayNode);
    delayNode.connect(feedbackGain).connect(delayNode);
    delayNode.connect(wetGain).connect(master);
    master.connect(destination);

    return { voiceBus, dryGain, delayNode, feedbackGain, wetGain, master };
  }

  function ensureContext() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    chain = createSignalChain(
      ctx,
      analyser,
      parseFloat(document.getElementById("volume").value),
      parseFloat(document.getElementById("delayTime").value),
      parseFloat(document.getElementById("delayFeedback").value),
      parseFloat(document.getElementById("delayMix").value)
    );
    analyser.connect(ctx.destination);
    drawScope();
  }

  // A single voice: oscillator -> lowpass filter (with its own envelope) -> amp envelope -> bus.
  // audioCtx/destBus/startTime are explicit parameters (not read from globals) so the exact same
  // class can render live notes in real time AND render a full sequencer pattern inside an
  // OfflineAudioContext for WAV export.
  class Voice {
    constructor(audioCtx, destBus, note, velocity, startTime, s) {
      const freq = 440 * Math.pow(2, (note - 69) / 12);

      this.osc = audioCtx.createOscillator();
      this.osc.type = s.waveform;
      this.osc.frequency.value = freq;

      this.filter = audioCtx.createBiquadFilter();
      this.filter.type = "lowpass";
      this.filter.Q.value = s.resonance;

      this.ampGain = audioCtx.createGain();
      this.ampGain.gain.value = 0;

      this.osc.connect(this.filter);
      this.filter.connect(this.ampGain);
      this.ampGain.connect(destBus);

      const peak = Math.max(0.0001, Math.min(1, velocity));
      this.sustainLevel = peak * s.sustain;
      this.s = s;

      // amp envelope: attack -> decay -> sustain
      const g = this.ampGain.gain;
      g.setValueAtTime(0, startTime);
      g.linearRampToValueAtTime(peak, startTime + s.attack);
      g.linearRampToValueAtTime(this.sustainLevel, startTime + s.attack + s.decay);

      // filter envelope: opens on attack, settles toward cutoff by end of decay
      const f = this.filter.frequency;
      const base = s.cutoff;
      const peakFreq = Math.min(20000, base + s.filterEnv);
      f.setValueAtTime(base, startTime);
      f.linearRampToValueAtTime(peakFreq, startTime + s.attack);
      f.linearRampToValueAtTime(base, startTime + s.attack + s.decay);

      this.osc.start(startTime);
      this.released = false;
    }

    // atTime: the exact audio-clock time the release ramp should begin (real "now" for live
    // note-off, or a precomputed future time when scheduling offline for export).
    release(atTime) {
      if (this.released) return;
      this.released = true;
      const s = this.s;
      const g = this.ampGain.gain;
      g.cancelScheduledValues(atTime);
      g.setValueAtTime(this.sustainLevel, atTime);
      g.linearRampToValueAtTime(0, atTime + s.release);
      this.osc.stop(atTime + s.release + 0.05);
      const osc = this.osc;
      const filter = this.filter;
      const ampGain = this.ampGain;
      osc.onended = () => {
        try {
          osc.disconnect();
          filter.disconnect();
          ampGain.disconnect();
        } catch (e) {}
      };
    }
  }

  function snapshotSettings() {
    return { ...settings };
  }

  function noteOn(note, velocity = 1) {
    ensureContext();
    if (ctx.state === "suspended") ctx.resume();
    if (voices.has(note)) {
      voices.get(note).release(ctx.currentTime);
      voices.delete(note);
    }
    voices.set(note, new Voice(ctx, chain.voiceBus, note, velocity, ctx.currentTime, settings));
    highlightKey(note, true);
  }

  function noteOff(note) {
    const v = voices.get(note);
    if (v) {
      v.release(ctx.currentTime);
      voices.delete(note);
    }
    highlightKey(note, false);
  }

  function allNotesOff() {
    for (const note of Array.from(voices.keys())) noteOff(note);
  }

  // ---------- Oscilloscope ----------

  function drawScope() {
    const canvas = document.getElementById("scope");
    const ctx2d = canvas.getContext("2d");
    const bufferLength = analyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);

    function frame() {
      requestAnimationFrame(frame);
      analyser.getByteTimeDomainData(dataArray);
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
      ctx2d.lineWidth = 2;
      ctx2d.strokeStyle = "#6ee7c2";
      ctx2d.beginPath();
      const slice = canvas.width / bufferLength;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * canvas.height) / 2;
        if (i === 0) ctx2d.moveTo(x, y);
        else ctx2d.lineTo(x, y);
        x += slice;
      }
      ctx2d.stroke();
    }
    frame();
  }

  // ---------- UI wiring: controls ----------

  document.getElementById("startBtn").addEventListener("click", () => {
    ensureContext();
    ctx.resume().then(() => {
      document.getElementById("statusText").textContent = "audio running";
    });
  });

  const waveButtons = document.querySelectorAll(".wave-btn");
  waveButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      waveButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      settings.waveform = btn.dataset.wave;
    });
  });

  function bindSlider(id, valId, fmt) {
    const el = document.getElementById(id);
    const valEl = document.getElementById(valId);
    el.addEventListener("input", () => {
      const v = parseFloat(el.value);
      settings[id] = v;
      valEl.textContent = fmt(v);
      if (id === "volume" && chain) chain.master.gain.value = v;
      if (id === "delayTime" && chain) chain.delayNode.delayTime.value = v;
      if (id === "delayFeedback" && chain) chain.feedbackGain.gain.value = v;
      if (id === "delayMix" && chain) chain.wetGain.gain.value = v;
    });
  }

  bindSlider("attack", "attackVal", (v) => v.toFixed(2) + "s");
  bindSlider("decay", "decayVal", (v) => v.toFixed(2) + "s");
  bindSlider("sustain", "sustainVal", (v) => v.toFixed(2));
  bindSlider("release", "releaseVal", (v) => v.toFixed(2) + "s");
  bindSlider("cutoff", "cutoffVal", (v) => Math.round(v) + "Hz");
  bindSlider("resonance", "resonanceVal", (v) => v.toFixed(1));
  bindSlider("filterEnv", "filterEnvVal", (v) => Math.round(v) + "Hz");
  bindSlider("volume", "volumeVal", (v) => Math.round(v * 100) + "%");
  bindSlider("delayTime", "delayTimeVal", (v) => v.toFixed(2) + "s");
  bindSlider("delayFeedback", "delayFeedbackVal", (v) => Math.round(v * 100) + "%");
  bindSlider("delayMix", "delayMixVal", (v) => Math.round(v * 100) + "%");

  // ---------- Keyboard UI (on-screen piano) ----------

  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11];
  const BLACK_OFFSETS = [1, 3, null, 6, 8, 10, null]; // aligned after white index; null = no black key after

  let octave = 4; // octave 4 => C4 = MIDI 60
  const baseNote = () => (octave + 1) * 12; // C in this octave as MIDI number

  const NUM_OCTAVES = 2;

  function buildKeyboard() {
    const kb = document.getElementById("keyboard");
    kb.innerHTML = "";
    const start = baseNote();
    const totalWhite = NUM_OCTAVES * 7;
    const whiteWidthPct = 100 / totalWhite;

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
        label.textContent = NOTE_NAMES[note % 12] + Math.floor(note / 12 - 1);
        key.appendChild(label);
        kb.appendChild(key);
        attachKeyEvents(key, note);

        const blackOffset = BLACK_OFFSETS[i];
        if (blackOffset !== null) {
          const blackNote = start + oct * 12 + blackOffset;
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
  document.addEventListener("mouseup", () => {
    mouseIsDown = false;
  });

  function attachKeyEvents(el, note) {
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      noteOn(note, 0.9);
    });
    el.addEventListener("mouseenter", () => {
      if (mouseIsDown) noteOn(note, 0.9);
    });
    el.addEventListener("mouseup", () => noteOff(note));
    el.addEventListener("mouseleave", () => noteOff(note));
    el.addEventListener("touchstart", (e) => {
      e.preventDefault();
      noteOn(note, 0.9);
    });
    el.addEventListener("touchend", (e) => {
      e.preventDefault();
      noteOff(note);
    });
  }

  function highlightKey(note, on) {
    const el = document.querySelector(`.key[data-note="${note}"]`);
    if (el) el.classList.toggle("active", on);
  }

  document.getElementById("octaveDown").addEventListener("click", () => {
    octave = Math.max(0, octave - 1);
    document.getElementById("octaveLabel").textContent = "Octave: " + octave;
    buildKeyboard();
  });
  document.getElementById("octaveUp").addEventListener("click", () => {
    octave = Math.min(7, octave + 1);
    document.getElementById("octaveLabel").textContent = "Octave: " + octave;
    buildKeyboard();
  });

  buildKeyboard();

  // ---------- Computer keyboard input ----------

  const KEY_TO_SEMITONE = {
    a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11,
    k: 12, o: 13, l: 14, p: 15, ";": 16,
  };
  const activeComputerKeys = new Set();

  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    const key = e.key.toLowerCase();
    if (key === "z") {
      document.getElementById("octaveDown").click();
      return;
    }
    if (key === "x") {
      document.getElementById("octaveUp").click();
      return;
    }
    if (!(key in KEY_TO_SEMITONE)) return;
    if (activeComputerKeys.has(key)) return;
    activeComputerKeys.add(key);
    const note = baseNote() + KEY_TO_SEMITONE[key];
    noteOn(note, 0.9);
  });

  window.addEventListener("keyup", (e) => {
    const key = e.key.toLowerCase();
    if (!(key in KEY_TO_SEMITONE)) return;
    activeComputerKeys.delete(key);
    const note = baseNote() + KEY_TO_SEMITONE[key];
    noteOff(note);
  });

  // ---------- MIDI ----------

  let midiAccess = null;

  function refreshMidiDeviceList() {
    const select = document.getElementById("midiDevices");
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
    const [status, data1, data2] = msg.data;
    const command = status & 0xf0;

    if (command === 0x90 && data2 > 0) {
      noteOn(data1, data2 / 127);
    } else if (command === 0x80 || (command === 0x90 && data2 === 0)) {
      noteOff(data1);
    } else if (command === 0xb0) {
      if (data1 === 64) {
        // sustain pedal: not tracked per-voice in this simple engine; ignored gracefully
      } else if (data1 === 1) {
        // mod wheel -> filter cutoff sweep
        const cutoffSlider = document.getElementById("cutoff");
        const newCutoff = 80 + (data2 / 127) * (12000 - 80);
        cutoffSlider.value = newCutoff;
        cutoffSlider.dispatchEvent(new Event("input"));
      }
    }
  }

  function attachMidiInputs() {
    for (const input of midiAccess.inputs.values()) {
      input.onmidimessage = handleMidiMessage;
    }
  }

  document.getElementById("midiBtn").addEventListener("click", () => {
    if (!navigator.requestMIDIAccess) {
      document.getElementById("midiStatus").textContent =
        "Web MIDI not supported in this browser";
      return;
    }
    navigator
      .requestMIDIAccess()
      .then((access) => {
        midiAccess = access;
        attachMidiInputs();
        refreshMidiDeviceList();
        document.getElementById("midiStatus").textContent =
          midiAccess.inputs.size > 0
            ? `MIDI enabled — ${midiAccess.inputs.size} device(s) connected`
            : "MIDI enabled — no devices detected yet";
        midiAccess.onstatechange = () => {
          attachMidiInputs();
          refreshMidiDeviceList();
          document.getElementById("midiStatus").textContent =
            midiAccess.inputs.size > 0
              ? `MIDI enabled — ${midiAccess.inputs.size} device(s) connected`
              : "MIDI enabled — no devices detected yet";
        };
      })
      .catch((err) => {
        document.getElementById("midiStatus").textContent =
          "MIDI access denied: " + err.message;
      });
  });

  window.addEventListener("blur", allNotesOff);

  // ---------- 16-step sequencer ----------

  const SEQ_STEPS = 16;
  // Row pitches (top to bottom), as semitone offsets from the keyboard's current octave root —
  // a descending major scale so the grid reads like a piano roll.
  const ROW_SCALE_OFFSETS = [12, 11, 9, 7, 5, 4, 2, 0];
  const grid = ROW_SCALE_OFFSETS.map(() => new Array(SEQ_STEPS).fill(false));

  let seqPlaying = false;
  let seqTimerId = null;
  let seqCurrentStep = 0;
  let seqNextNoteTime = 0;
  const SEQ_LOOKAHEAD_MS = 25;
  const SEQ_SCHEDULE_AHEAD = 0.1;

  function stepDuration() {
    const bpm = Math.max(1, parseFloat(document.getElementById("bpm").value) || 120);
    return 60 / bpm / 4; // 16th notes
  }

  function buildSequencerGrid() {
    const container = document.getElementById("seqGrid");
    container.innerHTML = "";
    for (let row = 0; row < ROW_SCALE_OFFSETS.length; row++) {
      const rowEl = document.createElement("div");
      rowEl.className = "seq-row";
      for (let step = 0; step < SEQ_STEPS; step++) {
        const cell = document.createElement("div");
        cell.className = "seq-cell";
        cell.dataset.row = row;
        cell.dataset.step = step;
        cell.addEventListener("click", () => {
          grid[row][step] = !grid[row][step];
          cell.classList.toggle("on", grid[row][step]);
        });
        rowEl.appendChild(cell);
      }
      container.appendChild(rowEl);
    }
  }
  buildSequencerGrid();

  function updatePlayhead(step) {
    document.querySelectorAll(".seq-cell.playhead").forEach((c) => c.classList.remove("playhead"));
    document.querySelectorAll(`.seq-cell[data-step="${step}"]`).forEach((c) => c.classList.add("playhead"));
  }

  function clearPlayhead() {
    document.querySelectorAll(".seq-cell.playhead").forEach((c) => c.classList.remove("playhead"));
  }

  function scheduleStep(step, time) {
    const dur = stepDuration();
    for (let row = 0; row < ROW_SCALE_OFFSETS.length; row++) {
      if (!grid[row][step]) continue;
      const note = baseNote() + ROW_SCALE_OFFSETS[row];
      const v = new Voice(ctx, chain.voiceBus, note, 0.85, time, settings);
      v.release(time + dur * 0.85);
    }
    const delayMs = (time - ctx.currentTime) * 1000;
    setTimeout(() => updatePlayhead(step), Math.max(0, delayMs));
  }

  function seqScheduler() {
    while (seqNextNoteTime < ctx.currentTime + SEQ_SCHEDULE_AHEAD) {
      scheduleStep(seqCurrentStep, seqNextNoteTime);
      seqNextNoteTime += stepDuration();
      seqCurrentStep = (seqCurrentStep + 1) % SEQ_STEPS;
    }
  }

  function startSequencer() {
    ensureContext();
    ctx.resume();
    seqCurrentStep = 0;
    seqNextNoteTime = ctx.currentTime + 0.05;
    seqTimerId = setInterval(seqScheduler, SEQ_LOOKAHEAD_MS);
    seqPlaying = true;
    document.getElementById("seqPlayBtn").textContent = "■ Stop";
  }

  function stopSequencer() {
    clearInterval(seqTimerId);
    seqPlaying = false;
    clearPlayhead();
    document.getElementById("seqPlayBtn").textContent = "▶ Play";
  }

  document.getElementById("seqPlayBtn").addEventListener("click", () => {
    if (seqPlaying) stopSequencer();
    else startSequencer();
  });

  document.getElementById("seqClearBtn").addEventListener("click", () => {
    for (let row = 0; row < grid.length; row++) grid[row].fill(false);
    document.querySelectorAll(".seq-cell.on").forEach((c) => c.classList.remove("on"));
  });

  // ---------- WAV export (OfflineAudioContext render + hand-rolled PCM16 encoder) ----------

  function writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  function encodeWavBlob(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const numFrames = buffer.length;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = numFrames * blockAlign;

    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);

    writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, "WAVE");
    writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true); // PCM fmt chunk size
    view.setUint16(20, 1, true); // audio format = PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true); // bits per sample
    writeString(view, 36, "data");
    view.setUint32(40, dataSize, true);

    const channels = [];
    for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

    let offset = 44;
    for (let i = 0; i < numFrames; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        let sample = Math.max(-1, Math.min(1, channels[ch][i]));
        sample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        view.setInt16(offset, sample, true);
        offset += 2;
      }
    }

    return new Blob([arrayBuffer], { type: "audio/wav" });
  }

  function setExportStatus(text) {
    document.getElementById("exportStatus").textContent = text;
  }

  async function exportWav() {
    const hasSteps = grid.some((row) => row.some((cell) => cell));
    if (!hasSteps) {
      setExportStatus("Add some sequencer steps first.");
      return;
    }
    if (!window.OfflineAudioContext) {
      setExportStatus("OfflineAudioContext not supported in this browser.");
      return;
    }

    const sampleRate = ctx ? ctx.sampleRate : 44100;
    const dur = stepDuration();
    const loops = parseInt(document.getElementById("loops").value, 10) || 1;
    const snap = snapshotSettings();
    const patternDuration = loops * SEQ_STEPS * dur;
    const tail = snap.release + snap.delayTime * 2 + 0.5;
    const totalDuration = patternDuration + tail;

    const offlineCtx = new OfflineAudioContext(2, Math.ceil(totalDuration * sampleRate), sampleRate);
    const offlineChain = createSignalChain(
      offlineCtx,
      offlineCtx.destination,
      parseFloat(document.getElementById("volume").value),
      snap.delayTime,
      snap.delayFeedback,
      snap.delayMix
    );

    for (let loop = 0; loop < loops; loop++) {
      for (let step = 0; step < SEQ_STEPS; step++) {
        const time = loop * SEQ_STEPS * dur + step * dur;
        for (let row = 0; row < ROW_SCALE_OFFSETS.length; row++) {
          if (!grid[row][step]) continue;
          const note = baseNote() + ROW_SCALE_OFFSETS[row];
          const v = new Voice(offlineCtx, offlineChain.voiceBus, note, 0.85, time, snap);
          v.release(time + dur * 0.85);
        }
      }
    }

    const exportBtn = document.getElementById("exportBtn");
    exportBtn.disabled = true;
    setExportStatus("Rendering…");
    try {
      const renderedBuffer = await offlineCtx.startRendering();
      const blob = encodeWavBlob(renderedBuffer);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `web-synth-pattern-${Date.now()}.wav`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      setExportStatus(
        `Downloaded ✓ (${renderedBuffer.duration.toFixed(1)}s, ${sampleRate}Hz PCM16 stereo)`
      );
    } catch (err) {
      setExportStatus("Export failed: " + err.message);
    } finally {
      exportBtn.disabled = false;
    }
  }

  document.getElementById("exportBtn").addEventListener("click", exportWav);

  // ---------- About / Tech Specs drawer ----------

  const aboutBtn = document.getElementById("aboutBtn");
  const drawer = document.getElementById("aboutDrawer");
  const drawerBackdrop = document.getElementById("drawerBackdrop");
  const closeDrawerBtn = document.getElementById("closeDrawer");
  let metricsIntervalId = null;

  function updateMetrics() {
    document.getElementById("metricState").textContent = ctx ? ctx.state : "not started";
    document.getElementById("metricSampleRate").textContent = ctx ? ctx.sampleRate + " Hz" : "—";
    document.getElementById("metricVoices").textContent = voices.size;
    const latencyEl = document.getElementById("metricLatency");
    if (ctx && typeof ctx.outputLatency === "number" && ctx.outputLatency > 0) {
      latencyEl.textContent = (ctx.outputLatency * 1000).toFixed(1) + " ms";
    } else if (ctx && typeof ctx.baseLatency === "number") {
      latencyEl.textContent = (ctx.baseLatency * 1000).toFixed(1) + " ms (base)";
    } else {
      latencyEl.textContent = "n/a";
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

  aboutBtn.addEventListener("click", openDrawer);
  closeDrawerBtn.addEventListener("click", closeDrawer);
  drawerBackdrop.addEventListener("click", closeDrawer);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });

  const githubLink = document.getElementById("githubLink");
  if (GITHUB_REPO_URL) {
    githubLink.href = GITHUB_REPO_URL;
  } else {
    githubLink.href = "#";
    githubLink.textContent = "Add your GitHub repo URL in synth.js (GITHUB_REPO_URL)";
    githubLink.classList.add("disabled");
    githubLink.addEventListener("click", (e) => e.preventDefault());
  }
})();
