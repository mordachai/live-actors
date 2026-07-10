export class AudioEngine {
  static _context = null;
  static _stream = null;    // captured MediaStream — see _ownStream below
  // True only when _stream is OUR OWN getUserMedia capture (not Foundry's A/V
  // stream, reused as a fallback). Only an own stream is safe to stop() on
  // destroy() — stopping Foundry's stream would kill its audio broadcast too.
  static _ownStream = false;
  static _analyser = null;
  static _buffer = null;
  static _tdBuffer = null;   // time-domain waveform buffer, read per-frame by the animator
  static _intervalId = null;
  static _onState = null;
  static _visemeLatch = "closed";
  static _visemeHold = 0;
  static _VISEME_HOLD_FRAMES = 3;
  static _CLOSED_BRIDGE_FRAMES = 2;
  // FFT bin ranges for _classifyViseme, computed from the REAL sample rate at
  // init (see _computeVisemeBins) — most Windows mics run at 48000 Hz, not the
  // 44100 Hz these ranges used to assume, which biased every band ~9% high.
  static _visemeBins = null;

  // Settings snapshot read by _poll() — mode/headMode/videoMode/sensitivity are
  // otherwise fetched 30x/sec forever. Refreshed at init() and kept live via
  // each setting's onChange (see live-actors.mjs, which writes into this object).
  static _cfg = { mode: "none", headMode: "hybrid", videoMode: "hybrid", sensitivity: 20 };

  // Speaking detection with hysteresis — prevents ambient mic noise from
  // flickering animation on/off. Enter high, exit low, hold a few frames.
  static _speaking = false;
  static _silenceFrames = 0;
  static _ENTER_VOL = 0.05;
  static _EXIT_VOL  = 0.02;
  static _SILENCE_HOLD_FRAMES = 10;   // ~0.33 s at 30 Hz

  static async init(onState) {
    AudioEngine._onState = onState;
    AudioEngine._cfg = {
      mode:        game.settings.get("live-actors", "mode"),
      headMode:    game.settings.get("live-actors", "headMode"),
      videoMode:   game.settings.get("live-actors", "videoMode"),
      sensitivity: game.settings.get("live-actors", "sensitivity"),
    };

    const stream = await AudioEngine._acquireStream();
    if (!stream) return;

    const ctx = new AudioContext();
    if (ctx.state === "suspended") {
      // Chromium suspends a context created without a user gesture — the
      // analyser then returns silence with no error. Resume on the first
      // interaction; Foundry's own boot flow may also unlock it first.
      const resume = () => ctx.resume();
      document.addEventListener("pointerdown", resume, { once: true });
      document.addEventListener("keydown",     resume, { once: true });
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.4;

    ctx.createMediaStreamSource(stream).connect(analyser);

    AudioEngine._context = ctx;
    AudioEngine._stream = stream;
    AudioEngine._analyser = analyser;
    AudioEngine._visemeBins = AudioEngine._computeVisemeBins(ctx.sampleRate, analyser.fftSize);
    AudioEngine._buffer   = new Uint8Array(analyser.frequencyBinCount);
    AudioEngine._tdBuffer = new Uint8Array(analyser.fftSize);

    // If the mic device disappears (unplugged, disabled), the analyser can keep
    // returning its last non-silent buffer instead of going quiet, latching
    // "speaking" forever. Force idle and stop polling when the track ends.
    for (const track of stream.getTracks()) {
      track.onended = () => {
        if (AudioEngine._onState) AudioEngine._onState({ mode: game.settings.get("live-actors", "mode"), volume: 0, speaking: false });
        AudioEngine.destroy();
        ui.notifications.warn("Live Actors: Microphone disconnected — animation stopped.");
      };
    }

    AudioEngine._intervalId = setInterval(() => AudioEngine._poll(), 1000 / 30);
  }

  static async _acquireStream() {
    // Capture our OWN microphone stream for analysis — an independent
    // MediaStreamTrack, deliberately NOT Foundry's A/V broadcast track. This
    // decouples animation from Foundry's mic: muting the Foundry mic (Echo Guard /
    // external-voice mode) no longer kills lip-sync, and animation still works in
    // VIDEO-only A/V where Foundry captures no audio track at all. See echo-guard.mjs.
    if (navigator.mediaDevices?.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        console.log("Live Actors | Microphone access granted.");
        AudioEngine._ownStream = true;
        return stream;
      } catch (err) {
        console.error("Live Actors |", err);
      }
    } else {
      console.error("Live Actors | navigator.mediaDevices unavailable (insecure context — needs HTTPS or localhost).");
    }

    // Fallback only if our own capture was denied/unavailable: reuse Foundry's A/V stream.
    const foundryStream = game.webrtc?.client?.localStream ?? null;
    if (foundryStream) {
      ui.notifications.info("Live Actors: Using Foundry A/V microphone stream (fallback).");
      return foundryStream;
    }

    const insecure = !navigator.mediaDevices?.getUserMedia;
    ui.notifications.warn(insecure
      ? "Live Actors: Microphone blocked — connection isn't secure (HTTPS required). Ask your GM to serve Foundry over HTTPS."
      : "Live Actors: Could not access microphone. Check browser permissions.");
    return null;
  }

  static _poll() {
    if (!AudioEngine._analyser || !AudioEngine._onState) return;

    const buffer = AudioEngine._buffer;
    AudioEngine._analyser.getByteFrequencyData(buffer);

    // Cached, not read here — mode/headMode/videoMode/sensitivity are fetched
    // 30x/sec forever otherwise. Kept fresh via each setting's onChange (see
    // live-actors.mjs) and refreshed once at init().
    const { mode, headMode, videoMode, sensitivity: sensitivityPct } = AudioEngine._cfg;
    const sensitivity = sensitivityPct / 100;

    // RMS volume, normalized 0-1
    let sumSq = 0;
    for (let i = 0; i < buffer.length; i++) sumSq += (buffer[i] / 255) ** 2;
    const rms = Math.sqrt(sumSq / buffer.length);

    // Noise gate: lower sensitivity = higher gate threshold
    const noiseGate = (1 - sensitivity) * 0.15;
    const volume = Math.min(1, Math.max(0, (rms - noiseGate) / (1 - noiseGate)));

    // Hysteresis: cross ENTER to start speaking; must stay below EXIT for
    // SILENCE_HOLD_FRAMES to stop. Keeps brief pauses from chopping animation.
    if (AudioEngine._speaking) {
      if (volume < AudioEngine._EXIT_VOL) {
        if (++AudioEngine._silenceFrames >= AudioEngine._SILENCE_HOLD_FRAMES) AudioEngine._speaking = false;
      } else {
        AudioEngine._silenceFrames = 0;
      }
    } else if (volume >= AudioEngine._ENTER_VOL) {
      AudioEngine._speaking = true;
      AudioEngine._silenceFrames = 0;
    }

    const state = { mode, volume, speaking: AudioEngine._speaking };

    // Classify visemes whenever ANY surface needs them (canvas token, talking heads, or video).
    const tokenWantsVisemes = mode      === "advanced" || mode      === "hybrid" || mode      === "both";
    const headWantsVisemes  = headMode  === "advanced" || headMode  === "hybrid" || headMode  === "both";
    const videoWantsVisemes = videoMode === "advanced" || videoMode === "hybrid" || videoMode === "both";
    if (tokenWantsVisemes || headWantsVisemes || videoWantsVisemes) {
      const classified = !AudioEngine._speaking ? "closed" : AudioEngine._classifyViseme(buffer);
      if (AudioEngine._visemeHold > 0) {
        AudioEngine._visemeHold--;
      } else if (classified !== AudioEngine._visemeLatch) {
        const fromOpen = AudioEngine._visemeLatch !== "closed";
        const toOpen   = classified !== "closed";
        if (fromOpen && toOpen) {
          // Bridge through closed so the mouth doesn't jump between shapes
          AudioEngine._visemeLatch = "closed";
          AudioEngine._visemeHold = AudioEngine._CLOSED_BRIDGE_FRAMES - 1;
        } else {
          AudioEngine._visemeLatch = classified;
          AudioEngine._visemeHold = AudioEngine._VISEME_HOLD_FRAMES - 1;
        }
      }
      state.viseme = AudioEngine._visemeLatch;
    }

    AudioEngine._onState(state);
  }

  // True while a mic stream is actively being analysed — used for the scene
  // control tooltip's status readout ("Mic: active/inactive").
  static isActive() {
    return !!AudioEngine._analyser;
  }

  // Called every PIXI frame by the animator. Returns the signed peak waveform sample
  // in the current buffer window (-1 = trough, +1 = peak, 0 = silence / no mic).
  static getWaveformSample() {
    if (!AudioEngine._analyser || !AudioEngine._tdBuffer) return 0;
    AudioEngine._analyser.getByteTimeDomainData(AudioEngine._tdBuffer);
    let peak = 0;
    for (let i = 0; i < AudioEngine._tdBuffer.length; i++) {
      const v = (AudioEngine._tdBuffer[i] - 128) / 128;
      if (Math.abs(v) > Math.abs(peak)) peak = v;
    }
    return peak;
  }

  // Bin ranges for the three viseme energy bands, computed from the ANALYSER's
  // real sample rate/fftSize instead of an assumed 44100 Hz (most Windows mics
  // run at 48000 Hz — ~9% off every boundary, e.g. the ee band drifting up past
  // 3.7 kHz). Target frequencies (Hz), same bands the old hardcoded bins covered:
  //   oo: ≲ 689     — uu/oo: tight rounded low energy
  //   ah: 689–2239  — ah/eh/open vowels: broad mid energy
  //   ee: 2239–3617 — ee/i: strong high F2 peak
  static _computeVisemeBins(sampleRate, fftSize) {
    const binHz = sampleRate / fftSize;
    const toBin = hz => Math.max(1, Math.round(hz / binHz));
    const lowEnd  = toBin(689);
    const midEnd  = toBin(2239);
    const highEnd = toBin(3617);
    return {
      lowStart: 1,      lowEnd,
      midStart: lowEnd,  midEnd,
      highStart: midEnd, highEnd,
    };
  }

  static _classifyViseme(buffer) {
    const bins = AudioEngine._visemeBins ?? AudioEngine._computeVisemeBins(44100, 256);
    let low = 0, mid = 0, high = 0;
    for (let i = bins.lowStart;  i < bins.lowEnd;  i++) low  += buffer[i];
    for (let i = bins.midStart;  i < bins.midEnd;  i++) mid  += buffer[i];
    for (let i = bins.highStart; i < bins.highEnd; i++) high += buffer[i];

    low  /= Math.max(1, bins.lowEnd  - bins.lowStart);
    mid  /= Math.max(1, bins.midEnd  - bins.midStart);
    high /= Math.max(1, bins.highEnd - bins.highStart);

    // EE/IH: F2 peak in high range — F1 lives in "low" so we only compare to mid
    if (high * 1.4 >= mid) return "ee";
    // OO: requires low to clearly dominate — a tie goes to AH
    if (low > mid * 1.3) return "oo";
    return "ah";
  }

  static destroy() {
    if (AudioEngine._intervalId !== null) {
      clearInterval(AudioEngine._intervalId);
      AudioEngine._intervalId = null;
    }
    // Only stop tracks we captured ourselves — never Foundry's A/V stream (the
    // fallback path), which would kill its broadcast too. Clear onended first
    // so stopping doesn't re-enter destroy() via the "mic disconnected" handler.
    if (AudioEngine._ownStream) {
      AudioEngine._stream?.getTracks().forEach(t => { t.onended = null; t.stop(); });
    }
    AudioEngine._stream = null;
    AudioEngine._ownStream = false;
    AudioEngine._context?.close();
    AudioEngine._context = null;
    AudioEngine._analyser = null;
    AudioEngine._buffer = null;
    AudioEngine._tdBuffer = null;
    AudioEngine._speaking = false;
    AudioEngine._silenceFrames = 0;
  }
}
