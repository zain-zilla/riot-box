# 🎹 Web Synth

**A polyphonic subtractive synthesizer that runs entirely in the browser — no build step, no dependencies, real MIDI hardware support, and a lossless WAV export engine written from scratch on top of the Web Audio API.**

[![Live Demo](https://img.shields.io/badge/demo-live-6ee7c2?style=for-the-badge)](https://zain-zilla.github.io/web-synth-1/)
&nbsp;
![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=flat-square&logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=flat-square&logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES2020-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![Web Audio API](https://img.shields.io/badge/Web%20Audio%20API-6ee7c2?style=flat-square)
![Web MIDI API](https://img.shields.io/badge/Web%20MIDI%20API-6ee7c2?style=flat-square)
![No dependencies](https://img.shields.io/badge/dependencies-none-success?style=flat-square)

**Repo:** [github.com/zain-zilla/web-synth-1](https://github.com/zain-zilla/web-synth-1) · **Live:** [zain-zilla.github.io/web-synth-1](https://zain-zilla.github.io/web-synth-1/)

<!-- Demo GIF goes here -->

---

## ✨ Key Features

- **Polyphonic synth engine** — every key/MIDI note/sequencer step spawns its own oscillator → filter → amp-envelope voice chain, so chords and overlapping notes never steal each other's tails. Four waveforms (sine, triangle, sawtooth, square), full ADSR amp envelope, and a filter envelope that sweeps the cutoff on every note-on.
- **16-step sequencer** — an 8-row × 16-step piano-roll grid (descending major scale) with adjustable BPM, start/stop transport, and a sample-accurate lookahead scheduler (the classic Web Audio "schedule ahead of time" pattern) so playback doesn't drift or stutter under JS event-loop jitter.
- **Real-time canvas oscilloscope** — an `AnalyserNode` feeds a `requestAnimationFrame` loop that draws the live waveform at the display's refresh rate, so you can see exactly what the filter and envelope are doing as you play.
- **Delay / effects bus** — a feedback delay line (time, feedback, wet mix) sits between the voice bus and master out, shared by every voice, with live-updating controls.
- **Web MIDI plug-and-play** — connect any class-compliant USB MIDI controller (Launchkey, Roland, Arturia, etc.); note-on/off with velocity, mod wheel → filter cutoff, all handled with zero configuration.
- **Lossless WAV export** — renders the current sequencer pattern through an `OfflineAudioContext` (1–4 loops) and encodes the result to 16-bit PCM WAV **by hand, byte-for-byte, with no external libraries**, then triggers a browser download.
- **About / Tech Specs drawer** — a slide-over panel (▸ the info icon in the header) showing a live signal-flow diagram and real-time performance metrics (audio context state, sample rate, active voice count, output latency).

---

## 🧠 Architecture & Technical Highlights

### Signal chain

```
Oscillator ──▶ ADSR Gain ──▶ BiquadFilter (lowpass, w/ its own envelope) ──┐
                                                                            ├──▶ Voice Bus
                                                                            │
Voice Bus ──▶ dry path ─────────────────────────────────────────▶ Master Gain
          └─▶ DelayNode ──▶ feedback loop ──▶ wet mix ───────────▶ Master Gain

Master Gain ──▶ AnalyserNode (oscilloscope tap) ──▶ ctx.destination
```

Every note — whether triggered by the on-screen keyboard, your computer keyboard, a MIDI controller, or the sequencer — creates a `Voice`: a fresh `OscillatorNode` → `BiquadFilterNode` → `GainNode` chain with its own scheduled ADSR automation curves (`setValueAtTime` / `linearRampToValueAtTime`), so voices never interfere with each other's envelopes. All voices sum into a shared **voice bus**, which splits into a dry path and a delay ("effects bus") path before hitting the master gain and, finally, an `AnalyserNode` used purely for visualization.

### One signal-chain builder, two contexts

The signal chain (`createSignalChain()`) and the `Voice` class both take the `AudioContext` as an explicit parameter rather than reading a global. That means the **exact same code path** builds the graph for:

1. **Live playback** — a real-time `AudioContext` wired to your speakers.
2. **WAV export** — an `OfflineAudioContext` that renders the whole sequencer pattern (all loops, full release tails) as fast as your CPU allows, with the identical topology, so the exported file matches what you actually hear.

### Hand-rolled PCM WAV encoder

There is no `MediaRecorder`, no `lamejs`, no `wav-encoder` npm package. `encodeWavBlob()` walks the rendered `AudioBuffer`'s channel data, clamps each float sample to `[-1, 1]`, converts it to 16-bit signed PCM, and writes a complete 44-byte RIFF/WAVE header plus interleaved sample data directly into an `ArrayBuffer` — which becomes a `Blob` and a one-click download. It's ~50 lines and has zero dependencies.

### Sequencer scheduling

The sequencer uses the standard Web Audio "lookahead scheduler" technique: a `setInterval` polls every 25ms and schedules any notes falling within the next 100ms using precise `AudioContext` time (not `setTimeout` timing, which drifts under load). Visual playhead updates are synced to the same schedule via a timed callback.

---

## 🎛️ MIDI Setup & Hardware Compatibility

1. Click **Enable MIDI Input** in the MIDI panel.
2. Your browser will prompt for MIDI permission — allow it.
3. Plug in any class-compliant USB MIDI controller (Novation Launchkey, Roland A/FA series, Arturia KeyLab, AKAI MPK, etc.) — it should appear in the device dropdown automatically, no drivers needed on most modern OSes.
4. Play. Note-on/off and velocity are mapped straight through to the synth engine.

**Supported CC / message mapping:**

| MIDI message | Behavior |
|---|---|
| Note On / Off (status `0x90`/`0x80`) | Triggers/releases a voice, velocity → envelope peak amplitude |
| CC 1 (Mod Wheel) | Sweeps the filter cutoff slider live |
| CC 64 (Sustain Pedal) | Recognized but not yet wired to voice hold — contribution welcome |

**Browser requirements:** Web MIDI needs a secure context (`https://` or `localhost`) and is currently supported in Chromium-based browsers (Chrome, Edge, Opera, Brave). Firefox and Safari require a flag or don't support it yet — the app degrades gracefully and reports "Web MIDI not supported" rather than breaking.

---

## 🚀 Local Development & Build Instructions

This is a **zero-build, zero-dependency** project — plain HTML, CSS, and JavaScript. There's no `package.json`, no bundler, and nothing to `npm install`.

Because Web MIDI requires a secure context, you do need to serve the files rather than open `index.html` directly with `file://`. Any static file server works:

```bash
# Option A — Python (no install needed on most systems)
python -m http.server 5500

# Option B — Node, if you have it
npx serve -l 5500
```

Then open **http://localhost:5500** in a Chromium-based browser.

To deploy, upload the three files (`index.html`, `style.css`, `synth.js`) to any static host — GitHub Pages, Netlify, Vercel, Cloudflare Pages — no build command required.

### Deploying to GitHub Pages

The live demo is deployed by [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml): every push to `main` publishes the static files as-is, with no build step.

To host your own copy, fork the repo, then go to **Settings → Pages → Source** and select **GitHub Actions**. It goes live at `https://<username>.github.io/<repo>/`.

---

## 📁 Project Structure

```
web-synth/
├── index.html   # markup: controls, keyboard, sequencer grid, About drawer
├── style.css    # dark synth-panel theme, sequencer/drawer/keyboard styling
├── synth.js     # audio engine, sequencer scheduler, WAV encoder, MIDI, UI wiring
└── README.md
```
