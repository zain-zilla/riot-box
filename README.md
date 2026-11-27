# ⚡ RIOT//BOX: a browser synth

**A polyphonic synthesizer that runs entirely in the browser: unison, LFO, drive, delay, reverb, sidechain, an arpeggiator, a step sequencer with drums, real MIDI hardware support, live visuals for every effect, and a WAV export engine written from scratch on the Web Audio API. No build step, no dependencies.**

[![Live Demo](https://img.shields.io/badge/demo-live-ff2e88?style=for-the-badge)](https://zain-zilla.github.io/web-synth-1/)
&nbsp;
![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=flat-square&logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=flat-square&logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES2020-F7DF1E?style=flat-square&logo=javascript&logoColor=black)
![Web Audio API](https://img.shields.io/badge/Web%20Audio%20API-ff2e88?style=flat-square)
![Web MIDI API](https://img.shields.io/badge/Web%20MIDI%20API-ff2e88?style=flat-square)
![No dependencies](https://img.shields.io/badge/dependencies-none-success?style=flat-square)

**Repo:** [github.com/zain-zilla/web-synth-1](https://github.com/zain-zilla/web-synth-1) · **Live:** [zain-zilla.github.io/web-synth-1](https://zain-zilla.github.io/web-synth-1/)

<!-- Demo GIF goes here -->

---

## ✨ Key Features (v2)

**Look:** modern punk: neon pink and acid lime on black, poster type (Anton), Space Grotesk body, JetBrains Mono readouts, hand-lettered tagline.

**Sound**
- **Polyphonic engine with unison** — every note spawns its own voice: 1–7 detuned oscillators spread across the stereo field → resonant lowpass filter with its own envelope → ADSR amp envelope. Four waveforms.
- **LFO** — sine / triangle / square / saw, routed to pitch (vibrato), filter (wobble) or volume (tremolo).
- **Effects** — soft-clip **drive** (WaveShaper with 4× oversampling and auto make-up gain), feedback **delay**, and a **reverb** whose impulse response is generated in code (decaying stereo noise, no sample files).
- **Sidechain** — ducks the synth on every sequencer kick (or every beat) for the classic pumping sound. Drums bypass the duck, just like a real mix.
- **Presets** — 7 built-in sounds (Fat Bass, Warm Pad, Lead, Pluck, Wobble, Pumping Chords…) plus save / load / delete your own, stored in the browser.

**Play**
- **Arpeggiator** — up, down, up-down, random, as-played; 1/8 to 1/32 (with triplets); 1–3 octaves; gate; latch. Locks to the sequencer grid when it's running.
- **Step sequencer** — 8 note rows in any of 8 scales and 12 roots, plus a **drum lane** (kick, snare, hat). Click-drag painting, accent brush, a **mute brush** (silence a note without deleting it), **row mutes** (click a row name), swing, gate, 8/12/16-step length, shift left/right, a musical randomiser, and **4 pattern slots (A–D)** that can play as a chain. `Space` plays and stops.
- **Web MIDI** — note on/off with velocity, **sustain pedal (CC64)**, **pitch bend (±2 semitones)**, mod wheel → cutoff, CC123 all-notes-off, and an activity LED.

**See what you hear**
- Live **oscilloscope** (zero-crossing triggered so the wave stands still) and a log-scale **spectrum analyser**.
- A visual for every module: unison spread, **ADSR shape**, the filter's real **frequency-response curve** (it moves when the LFO wobbles it), animated **LFO** wave, **drive transfer curve**, **delay echo** decay, **reverb tail**, and a live **sidechain gain meter**.

**Export**
- **Lossless WAV export** — renders the pattern (or the A→D chain) through an `OfflineAudioContext` with the *same* chain, drums and sidechain as live playback, then encodes 16-bit PCM WAV by hand.

---

## 🧠 Architecture & Technical Highlights

### Signal chain

```
Voice: [osc × unison → stereo pan] → mix → BiquadFilter (lowpass + env) → Amp (ADSR)
                                         ▲ LFO→filter     ▲ LFO→pitch (osc.detune)

Voices → Voice Bus → Tremolo (LFO→gain) → Drive (WaveShaper) ─┬─ dry ───────┐
                                                              ├─ Delay ─────┤→ Duck (sidechain) → Master
                                                              └─ Reverb ────┘                        ▲
Drums (kick / snare / hat) → Drum Bus ───────────────────────────────────────────────────────────────┘
Master → AnalyserNode (scope + spectrum) → speakers
```

The LFO is a single `OscillatorNode` that runs constantly; three gain nodes scale it into cents (pitch), Hz (filter) or gain (tremolo). Changing the target only changes those gains, so there are no clicks.

### One signal-chain builder, two contexts

`createSignalChain()`, `Voice`, `playDrum()` and `scheduleStep()` all take the audio context as a parameter. The **same code** builds the live graph and the `OfflineAudioContext` used for export, so the WAV matches what you hear, sidechain pumping included.

### Effect visuals without extra audio

The filter curve comes from a silent probe `BiquadFilterNode` and `getFrequencyResponse()`, so the drawing is the real maths of the filter, not an approximation. The drive panel plots the exact curve fed to the WaveShaper. The sidechain meter replays the scheduled duck envelopes against `currentTime`.

### Hand-rolled PCM WAV encoder

No `MediaRecorder`, no npm packages. `encodeWavBlob()` clamps each float sample, converts to 16-bit PCM and writes the 44-byte RIFF/WAVE header plus interleaved data into an `ArrayBuffer`.

### Sequencer & arp scheduling

Both use the Web Audio "lookahead scheduler": a 25 ms `setInterval` schedules anything in the next 100 ms on the audio clock, which never drifts. Swing delays every off-beat 16th by a share of a step.

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
| CC 64 (Sustain Pedal) | Holds notes until the pedal is released (works with the arp too) |
| Pitch bend | ±2 semitones on every sounding voice |
| CC 123 | All notes off |

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
├── index.html   # markup: presets, visualisers, modules, sequencer, keyboard, About drawer
├── style.css    # dark synth-panel theme
├── synth.js     # audio engine, effects, arp, sequencer, visuals, WAV encoder, MIDI
└── README.md
```
