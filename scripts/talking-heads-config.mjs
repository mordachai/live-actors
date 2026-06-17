import { HEAD_BOUNCE_PRESETS, BOUNCE_PRESET_OPTIONS } from "./animation-presets.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class TalkingHeadsConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "live-actors-heads-config",
    window: { title: "Talking Heads — Animation (GM)", resizable: true },
    position: { width: 460, height: 600 },
    actions: {
      save:       TalkingHeadsConfig._onSave,
      browseMask: TalkingHeadsConfig._onBrowseMask,
      clearMask:  TalkingHeadsConfig._onClearMask,
    },
  };

  static PARTS = {
    form: { template: "modules/live-actors/templates/talking-heads-config.hbs" },
  };

  async _prepareContext(_options) {
    const get = k => game.settings.get("live-actors", k);
    const headMode  = get("headMode");
    const mirrorMap = get("headMirrorMap");

    // Per-player mirror toggles — all active users
    const players = [];
    for (const user of game.users) {
      if (!user.active) continue;
      const name = user.isGM
        ? `${user.name} (GM)`
        : (user.character?.name ?? user.name);
      players.push({ userId: user.id, name, mirrored: mirrorMap[user.id] === true });
    }

    const headIndicator = get("headIndicatorStyle");
    const preset        = get("headBouncePreset");
    const useAvatar     = get("headUseAvatar");

    return {
      useAvatar,
      // Bounce config is relevant whenever the Motion mode produces a bounce.
      // Avatar/plain heads bounce in exactly these modes too (capability-clamped).
      showBounce: ["simple", "hybrid", "both"].includes(headMode),
      headsAlways: get("talkingHeads") === "always",
      presetOptions: BOUNCE_PRESET_OPTIONS.map(o => ({ ...o, selected: preset === o.value })),
      headWidth:      get("headWidth"),
      headAvatarWidth: get("headAvatarWidth"),
      headAspectRatio: get("headAspectRatio"),
      showHeadName:   get("showHeadName"),
      headNameSize:   get("headNameSize"),
      indicatorOptions: [
        { value: "none",   label: "None",              selected: headIndicator === "none"   },
        { value: "ring",   label: "Ring Only",          selected: headIndicator === "ring"   },
        { value: "bubble", label: "Bubble Only",        selected: headIndicator === "bubble" },
        { value: "both",   label: "Ring + Bubble",      selected: headIndicator === "both"   },
      ],
      headMask: get("headMask"),
      headOutline:      get("headOutline"),
      headOutlineWidth: get("headOutlineWidth"),
      headOutlineAuto:  get("headOutlineAuto"),
      headOutlineColor: get("headOutlineColor"),
      headCutout:       get("headCutout"),
      headAvatarOutline:      get("headAvatarOutline"),
      headAvatarOutlineWidth: get("headAvatarOutlineWidth"),
      headAvatarOutlineAuto:  get("headAvatarOutlineAuto"),
      headAvatarOutlineColor: get("headAvatarOutlineColor"),
      modeOptions: [
        { value: "none",     label: "None (Disabled)",           selected: headMode === "none"     },
        { value: "simple",   label: "Simple (Bounce)",           selected: headMode === "simple"   },
        { value: "advanced", label: "Advanced (Visemes)",        selected: headMode === "advanced" },
        { value: "hybrid",   label: "Hybrid (Visemes or Bounce)",selected: headMode === "hybrid"   },
        { value: "both",     label: "Both (Visemes + Bounce)",   selected: headMode === "both"     },
      ],
      players,
    };
  }

  _onRender(_context, _options) {
    for (const input of this.element.querySelectorAll("input[type='range']")) {
      const display = input.nextElementSibling;
      if (display?.classList.contains("range-value")) {
        input.addEventListener("input", () => {
          display.textContent = Number(input.value).toFixed(
            input.step.includes(".") ? input.step.split(".")[1].length : 0
          );
        });
      }
    }
    const form    = this.element.querySelector("form");
    const modeSel = this.element.querySelector("select[name='headMode']");
    modeSel?.addEventListener("change", () => {
      form.classList.toggle("lva-bounce-on", ["simple", "hybrid", "both"].includes(modeSel.value));
    });

    // Avatar mode hides mode/mask/aspect controls (kept ones stay visible).
    const avatarBox = this.element.querySelector("input[name='headUseAvatar']");
    avatarBox?.addEventListener("change", () => {
      form.classList.toggle("lva-avatar-on", avatarBox.checked);
    });

    // Outline sub-settings only show when the (matching) outline is enabled.
    const outlineBox = this.element.querySelector("input[name='headOutline']");
    outlineBox?.addEventListener("change", () => {
      form.classList.toggle("lva-outline-on", outlineBox.checked);
    });
    const avatarOutlineBox = this.element.querySelector("input[name='headAvatarOutline']");
    avatarOutlineBox?.addEventListener("change", () => {
      form.classList.toggle("lva-avatar-outline-on", avatarOutlineBox.checked);
    });

    // Each colour picker is hidden while its "use player colour" toggle is on
    // (the fixed colour does nothing then). Toggle the whole form-group so it
    // disappears; "" lets the lva-*-only CSS govern visibility when shown.
    for (const [autoName, colorName] of [
      ["headOutlineAuto",       "headOutlineColor"],
      ["headAvatarOutlineAuto", "headAvatarOutlineColor"],
    ]) {
      const autoBox  = this.element.querySelector(`input[name='${autoName}']`);
      const colorInp = this.element.querySelector(`input[name='${colorName}']`);
      const group    = colorInp?.closest(".form-group");
      const sync = () => {
        const on = autoBox?.checked ?? false;
        if (colorInp) colorInp.disabled = on;
        if (group) group.style.display = on ? "none" : "";
      };
      autoBox?.addEventListener("change", sync);
      sync();
    }
  }

  static _onClearMask(_event, target) {
    const input = target.closest(".form-fields").querySelector("input[name='headMask']");
    if (input) input.value = "";
  }

  static _onBrowseMask(_event, target) {
    const input = target.closest(".form-fields").querySelector("input[name='headMask']");
    new foundry.applications.apps.FilePicker.implementation({
      type: "image",
      current: input?.value ?? "",
      callback: path => { if (input) input.value = path; },
    }).render(true);
  }

  static async _onSave(_event, target) {
    const form = target.closest("form");
    const fd = Object.fromEntries(new FormData(form));
    const set = (k, v) => game.settings.set("live-actors", k, v);

    // Collect mirror state per player (unchecked checkboxes absent from FormData)
    const mirrorMap = {};
    for (const hidden of form.querySelectorAll('input[name="mirrorUserId"]')) {
      const userId = hidden.value;
      mirrorMap[userId] = form.querySelector(`input[name="mirror-${userId}"]`)?.checked ?? false;
    }

    await set("talkingHeads",    form.querySelector("input[name='headsAlways']")?.checked ? "always" : "speaking");
    await set("headIndicatorStyle", fd.headIndicatorStyle ?? "ring");
    await set("headWidth",       Number(fd.headWidth));
    await set("headAvatarWidth", Number(fd.headAvatarWidth));
    await set("headAspectRatio", form.querySelector("input[name='headAspectRatio']")?.checked ?? false);
    await set("showHeadName",    form.querySelector("input[name='showHeadName']")?.checked ?? false);
    await set("headNameSize",    Number(fd.headNameSize));
    await set("headMode",        fd.headMode);
    await set("headUseAvatar",   form.querySelector("input[name='headUseAvatar']")?.checked ?? false);
    await set("headMask",        fd.headMask ?? "");
    await set("headOutline",      form.querySelector("input[name='headOutline']")?.checked ?? false);
    await set("headOutlineWidth", Number(fd.headOutlineWidth));
    await set("headOutlineAuto",  form.querySelector("input[name='headOutlineAuto']")?.checked ?? false);
    await set("headOutlineColor", fd.headOutlineColor ?? "#ffffff");
    await set("headCutout",       form.querySelector("input[name='headCutout']")?.checked ?? false);
    await set("headAvatarOutline",      form.querySelector("input[name='headAvatarOutline']")?.checked ?? false);
    await set("headAvatarOutlineWidth", Number(fd.headAvatarOutlineWidth));
    await set("headAvatarOutlineAuto",  form.querySelector("input[name='headAvatarOutlineAuto']")?.checked ?? false);
    await set("headAvatarOutlineColor", fd.headAvatarOutlineColor ?? "#ffffff");
    await set("headBouncePreset", fd.headBouncePreset);

    const p = HEAD_BOUNCE_PRESETS[fd.headBouncePreset] ?? HEAD_BOUNCE_PRESETS.bouncy;
    await set("headBounceMax",    p.bounceMax);
    await set("headAngleMax",     p.angleMax);
    await set("headScaleAxis",    p.scaleAxis);
    await set("headScaleLow",     p.scaleLow);
    await set("headScaleHigh",    p.scaleHigh);
    await set("headIntensity",    p.intensity);
    await set("headScaleDamping", p.scaleDamping);
    await set("headMirrorMap",    mirrorMap);
    this.close();
  }
}
