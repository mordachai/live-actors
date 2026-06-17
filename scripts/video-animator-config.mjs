// ─────────────────────────────────────────────────────────────────────────────
// VideoAnimatorConfig — GM-only config sub-app for the Video Window animator.
//
// WHAT IT MANAGES
//   All "video*" world-scoped settings registered in live-actors.mjs:
//     videoMode         — animation mode (none/simple/advanced/hybrid/both)
//     videoBounceMax    — upward offset % of tile height
//     videoAngleMax     — max rotation degrees
//     videoScaleAxis    — which axis scales (xy/x/y)
//     videoScaleLow     — min scale (squish, < 1.0)
//     videoScaleHigh    — max scale (stretch, > 1.0)
//     videoIntensity    — mic volume gain
//     videoScaleDamping — smoothing (0 = jittery, 0.9+ = very smooth)
//   And five client-scoped "clean mode" booleans:
//     videoCleanName / videoCleanStatus / videoCleanControls / videoCleanVolume / videoCleanBorder
//
// UI GATING (CSS class pattern — same as TalkingHeadsConfig)
//   .lva-bounce-on   → show/hide the Bounce Config fieldset
//
// HOW TO OPEN IT
//   Registered as a settings menu under "videoAnimConfig" in live-actors.mjs.
//   A toolbar button in the scene controls also opens it directly (see
//   getSceneControlButtons in live-actors.mjs).
//
// ─────────────────────────────────────────────────────────────────────────────

import { VIDEO_BOUNCE_PRESETS, BOUNCE_PRESET_OPTIONS } from "./animation-presets.mjs";
import { VideoAnimator } from "./video-animator.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class VideoAnimatorConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "live-actors-video-config",
    window: { title: "Video Window Config (GM)", resizable: true },
    position: { width: 440, height: "auto" },
    actions: {
      save: VideoAnimatorConfig._onSave,
    },
  };

  static PARTS = {
    form: { template: "modules/live-actors/templates/video-animator-config.hbs" },
  };

  async _prepareContext(_options) {
    const get       = k => game.settings.get("live-actors", k);
    const videoMode = get("videoMode");
    const preset    = get("videoBouncePreset");

    return {
      showBounce: ["simple", "hybrid", "both"].includes(videoMode),
      modeOptions: [
        { value: "none",     label: "None (Disabled)",            selected: videoMode === "none"     },
        { value: "simple",   label: "Simple (Bounce)",            selected: videoMode === "simple"   },
        { value: "advanced", label: "Advanced (Visemes)",         selected: videoMode === "advanced" },
        { value: "hybrid",   label: "Hybrid (Visemes or Bounce)", selected: videoMode === "hybrid"   },
        { value: "both",     label: "Both (Visemes + Bounce)",    selected: videoMode === "both"     },
      ],
      presetOptions: BOUNCE_PRESET_OPTIONS.map(o => ({ ...o, selected: preset === o.value })),
      // Clean mode — client-scoped, so each GM client stores their own preference.
      cleanName:     get("videoCleanName"),
      cleanStatus:   get("videoCleanStatus"),
      cleanControls: get("videoCleanControls"),
      cleanVolume:   get("videoCleanVolume"),
      cleanBorder:   get("videoCleanBorder"),
    };
  }

  _onRender(_context, _options) {
    const form    = this.element.querySelector("form");
    const modeSel = this.element.querySelector("select[name='videoMode']");
    modeSel?.addEventListener("change", () => {
      form.classList.toggle("lva-bounce-on", ["simple", "hybrid", "both"].includes(modeSel.value));
    });
  }

  static async _onSave(_event, target) {
    const form = target.closest("form");
    const fd   = Object.fromEntries(new FormData(form));
    const set  = (k, v) => game.settings.set("live-actors", k, v);

    await set("videoMode",        fd.videoMode);
    await set("videoBouncePreset", fd.videoBouncePreset);

    const p = VIDEO_BOUNCE_PRESETS[fd.videoBouncePreset] ?? VIDEO_BOUNCE_PRESETS.bouncy;
    await set("videoBounceMax",    p.bounceMax);
    await set("videoAngleMax",     p.angleMax);
    await set("videoScaleAxis",    p.scaleAxis);
    await set("videoScaleLow",     p.scaleLow);
    await set("videoScaleHigh",    p.scaleHigh);
    await set("videoIntensity",    p.intensity);
    await set("videoScaleDamping", p.scaleDamping);

    // Clean mode is client-scoped — read directly from the form checkboxes.
    await set("videoCleanName",     form.querySelector("input[name='cleanName']")?.checked     ?? false);
    await set("videoCleanStatus",   form.querySelector("input[name='cleanStatus']")?.checked   ?? false);
    await set("videoCleanControls", form.querySelector("input[name='cleanControls']")?.checked ?? false);
    await set("videoCleanVolume",   form.querySelector("input[name='cleanVolume']")?.checked   ?? false);
    await set("videoCleanBorder",   form.querySelector("input[name='cleanBorder']")?.checked   ?? false);

    // Re-scan all tiles immediately so changes are reflected without reload.
    VideoAnimator._scanAll();

    this.close();
  }
}
