import { TOKEN_BOUNCE_PRESETS, BOUNCE_PRESET_OPTIONS } from "./animation-presets.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class SimpleAnimationConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "live-actors-simple-config",
    window: { title: "Token Animation Config (GM)", resizable: true },
    position: { width: 420, height: "auto" },
    actions: {
      save: SimpleAnimationConfig._onSave,
    },
  };

  static PARTS = {
    form: { template: "modules/live-actors/templates/simple-animation-config.hbs" },
  };

  async _prepareContext(_options) {
    const get       = k => game.settings.get("live-actors", k);
    const mode      = get("mode");
    const indicator = get("indicatorStyle");
    const preset    = get("bouncePreset");
    return {
      showBounce: ["simple", "hybrid", "both"].includes(mode),
      indicatorOptions: [
        { value: "none",   label: "None",         selected: indicator === "none"   },
        { value: "ring",   label: "Ring Only",     selected: indicator === "ring"   },
        { value: "bubble", label: "Bubble Only",   selected: indicator === "bubble" },
        { value: "both",   label: "Ring + Bubble", selected: indicator === "both"   },
      ],
      modeOptions: [
        { value: "none",     label: "None (Disabled)",            selected: mode === "none"     },
        { value: "simple",   label: "Simple (Bounce)",            selected: mode === "simple"   },
        { value: "advanced", label: "Advanced (Visemes)",         selected: mode === "advanced" },
        { value: "hybrid",   label: "Hybrid (Visemes or Bounce)", selected: mode === "hybrid"   },
        { value: "both",     label: "Both (Visemes + Bounce)",    selected: mode === "both"     },
      ],
      presetOptions: BOUNCE_PRESET_OPTIONS.map(o => ({ ...o, selected: preset === o.value })),
    };
  }

  _onRender(_context, _options) {
    // Bounce config only relevant for bounce-driven modes
    const form    = this.element.querySelector("form");
    const modeSel = this.element.querySelector("select[name='mode']");
    modeSel?.addEventListener("change", () => {
      form.classList.toggle("lva-bounce-on", ["simple", "hybrid", "both"].includes(modeSel.value));
    });
  }

  static async _onSave(_event, target) {
    const form = target.closest("form");
    const fd = Object.fromEntries(new FormData(form));
    const set = (k, v) => game.settings.set("live-actors", k, v);

    await set("indicatorStyle", fd.indicatorStyle ?? "ring");
    await set("mode",          fd.mode);
    await set("bouncePreset",  fd.bouncePreset);

    const p = TOKEN_BOUNCE_PRESETS[fd.bouncePreset] ?? TOKEN_BOUNCE_PRESETS.bouncy;
    for (const [k, v] of Object.entries(p)) await set(k, v);
    this.close();
  }
}
