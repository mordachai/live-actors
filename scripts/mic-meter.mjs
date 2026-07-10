// ─────────────────────────────────────────────────────────────────────────────
// MicMeterDialog — "Config Mic". The ONLY place Mic Sensitivity is set — no
// separate slider in the main settings panel (that was redundant with this).
//
// Users used to tune Sensitivity blind: talk, alt-tab to the canvas, watch
// whether a token wiggles, repeat. This dialog opens its OWN independent mic
// capture (mirrors AudioEngine._acquireStream — deliberately not shared with
// the main engine, so it works even with disableAnimations on, or before the
// main engine has started) and shows a live level bar with a marker at the
// current noise-gate threshold. Dragging the slider updates the gate marker
// live; Save writes the value to the (client-scoped, hidden) "sensitivity" setting.
// ─────────────────────────────────────────────────────────────────────────────

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class MicMeterDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "live-actors-mic-meter",
    window: { title: "Live Actors — Config Mic", resizable: false },
    position: { width: 360, height: "auto" },
    actions: {
      save: MicMeterDialog._onSave,
    },
  };

  static PARTS = {
    form: { template: "modules/live-actors/templates/mic-meter.hbs" },
  };

  _stream   = null;
  _ctx      = null;
  _analyser = null;
  _buffer   = null;
  _rafId    = null;
  _sensitivity = 20;

  async _prepareContext(_options) {
    return { sensitivity: game.settings.get("live-actors", "sensitivity") };
  }

  async _onRender(_context, _options) {
    const slider  = this.element.querySelector("input[name='sensitivity']");
    const display = slider?.nextElementSibling;
    this._sensitivity = Number(slider?.value ?? 20);
    slider?.addEventListener("input", () => {
      this._sensitivity = Number(slider.value);
      if (display) display.textContent = slider.value;
    });

    // Already capturing (e.g. a re-render) — don't request the mic twice.
    if (this._stream) return;
    await this._startCapture();
  }

  async _startCapture() {
    const status = this.element.querySelector(".lva-mic-meter-status");
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      if (status) status.textContent = "Microphone access denied — check browser permissions.";
      return;
    }

    this._ctx = new AudioContext();
    if (this._ctx.state === "suspended") await this._ctx.resume();
    const analyser = this._ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.4;
    this._ctx.createMediaStreamSource(this._stream).connect(analyser);
    this._analyser = analyser;
    this._buffer   = new Uint8Array(analyser.frequencyBinCount);

    if (status) status.textContent = "Talk normally — the bar should turn green past the white line.";
    this._tick();
  }

  _tick = () => {
    if (!this._analyser) return;

    this._analyser.getByteFrequencyData(this._buffer);
    let sumSq = 0;
    for (let i = 0; i < this._buffer.length; i++) sumSq += (this._buffer[i] / 255) ** 2;
    const rms = Math.sqrt(sumSq / this._buffer.length);

    // Same formula as AudioEngine._poll — keeps the meter honest to real behavior.
    const sensitivity = this._sensitivity / 100;
    const noiseGate    = (1 - sensitivity) * 0.15;
    const speaking      = rms > noiseGate;

    const fill = this.element.querySelector(".lva-mic-meter-fill");
    if (fill) {
      fill.style.width = `${Math.min(100, rms * 100)}%`;
      fill.classList.toggle("lva-mic-meter-fill--active", speaking);
    }
    const gate = this.element.querySelector(".lva-mic-meter-gate");
    if (gate) gate.style.left = `${Math.min(100, noiseGate * 100)}%`;

    this._rafId = requestAnimationFrame(this._tick);
  };

  _stopCapture() {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._stream?.getTracks().forEach(t => t.stop());
    this._ctx?.close();
    this._stream = null;
    this._ctx = null;
    this._analyser = null;
    this._buffer = null;
  }

  async close(options) {
    this._stopCapture();
    return super.close(options);
  }

  static async _onSave(_event, target) {
    const form  = target.closest("form");
    const value = Number(form.querySelector("input[name='sensitivity']").value);
    await game.settings.set("live-actors", "sensitivity", value);
    this.close();
  }
}
