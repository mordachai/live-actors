import { AudioEngine } from "./audio-engine.mjs";
import { CanvasAnimator } from "./canvas-animator.mjs";
import { EchoGuard } from "./echo-guard.mjs";
import { SocketHandler } from "./socket-handler.mjs";
import { SpeakerWidget } from "./speaker-widget.mjs";
import { TalkingHeads } from "./talking-heads.mjs";
import { VideoAnimator } from "./video-animator.mjs";
import { SimpleAnimationConfig } from "./simple-animation-config.mjs";
import { TalkingHeadsConfig } from "./talking-heads-config.mjs";
import { VideoAnimatorConfig } from "./video-animator-config.mjs";
import { MicMeterDialog } from "./mic-meter.mjs";

let _combatActive = false;

function _isEffectivelyEnabled() {
  return game.settings.get("live-actors", "enabled")
    && !(game.settings.get("live-actors", "disableDuringCombat") && _combatActive);
}

function _applyState() {
  const enabled = _isEffectivelyEnabled();
  CanvasAnimator._enabled = enabled;
  TalkingHeads._enabled   = enabled;
  VideoAnimator._enabled  = enabled;
  TalkingHeads.setHidden(!enabled);
  if (!enabled) {
    TalkingHeads.setAllIdle();
    VideoAnimator.setAllIdle();
    VideoAnimator._scanAll(); // removes frames + re-applies clean classes
  }
}

function _applyCombatState() {
  _combatActive = !!game.combat?.started
    && game.combat.scene?.id === canvas.scene?.id;
  _applyState();
}

function _audioStateCallback(state) {
  if (!_isEffectivelyEnabled()) return;
  // Always broadcast so remote clients can animate all three surfaces even
  // when there is no canvas token for this user (tokenId is null then;
  // receivers skip canvas animation but still update heads and video tiles).
  const token = CanvasAnimator.applyLocalState(state);
  SocketHandler.broadcast(state, token?.id ?? null);
  TalkingHeads.update(game.user.id, state);
  VideoAnimator.applyLocalState(state);
}

// Lazily starts mic capture — called on ready and whenever "enabled" flips back
// on. A no-op while already running, disabled, or for a user with no character/GM.
function _startAudioEngine() {
  if (game.settings.get("live-actors", "disableAnimations")) return;
  if (!game.settings.get("live-actors", "enabled")) return;
  if (!(game.user.character || game.user.isGM)) return;
  if (AudioEngine._context) return;
  AudioEngine.init(_audioStateCallback);
}

function registerSettings() {
  // ── Visible in main settings panel ────────────────────────────

  // ── Player-visible settings ───────────────────────────────────

  // Echo Guard — world-scoped (GM-enforced, table-wide) but shown in the main
  // panel so it is easy to find. When on, every client mutes its own outgoing
  // Foundry microphone so external-voice (Discord etc.) tables aren't heard twice.
  // See echo-guard.mjs. onChange fires on every client → table-wide fan-out.
  game.settings.register("live-actors", "externalVoice", {
    name: "Echo Guard (External Voice Mode)",
    hint: "Prevents echo when you talk over Discord (or similar). Mutes everyone's Foundry mic. Leave off if you use Foundry's own audio.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => EchoGuard.apply(),
  });

  // Hidden, client-scoped — snapshot of this client's mic-mute choice taken when
  // Echo Guard turns on, so turning it off restores the player's prior state.
  game.settings.register("live-actors", "echoGuardSnapshot", {
    scope: "client",
    config: false,
    type: Object,
    default: { captured: false, muted: false },
  });

  // Hidden — set from the Config Mic dialog (micMeter menu below), not a raw
  // slider in the main panel. The dialog's live meter IS the calibration UI.
  game.settings.register("live-actors", "sensitivity", {
    scope: "client",
    config: false,
    type: Number,
    default: 20,
    onChange: v => AudioEngine._cfg.sensitivity = v,
  });

  game.settings.registerMenu("live-actors", "micMeter", {
    name: "Config Mic",
    label: "Open Config Mic",
    hint: "Live microphone level meter with the current noise-gate threshold — set Mic Sensitivity here by watching the bar instead of guessing.",
    icon: "fas fa-microphone-lines",
    type: MicMeterDialog,
    restricted: false,
  });

  // ── GM-only menus ─────────────────────────────────────────────

  game.settings.registerMenu("live-actors", "simpleAnimConfig", {
    name: "Token Animation Config",
    label: "Configure",
    hint: "Adjust animation mode, intensity, bounce, wobble, and scale for canvas tokens. GM only.",
    icon: "fas fa-sliders",
    type: SimpleAnimationConfig,
    restricted: true,
  });

  game.settings.register("live-actors", "speakerWidget", {
    name: "Speaker Widget",
    hint: "Adds a token picker toolbar button for GMs to speak through NPC tokens.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    // reset:true forces SceneControls to re-run getSceneControlButtons so the
    // tool is added/removed immediately — a plain render() only refreshes the
    // active state of existing tools, so the button needed a world reload.
    onChange: () => ui.controls.render({ reset: true }),
  });

  // ── Talking Heads ──────────────────────────────────────────────

  // Visibility mode for talking heads ("always" | "speaking"). Managed inside the
  // Talking Heads Config as an "Always visible" boolean. Heads are disabled
  // entirely via headMode = "none".
  game.settings.register("live-actors", "talkingHeads", {
    scope: "world",
    config: false,
    type: String,
    default: "always",
    onChange: () => TalkingHeads.requestRebuild(),
  });

  game.settings.registerMenu("live-actors", "talkingHeadsConfig", {
    name: "Talking Heads Config",
    label: "Configure",
    hint: "Adjust portrait size, aspect ratio, name display, mask, animation mode, and per-player mirror. GM only.",
    icon: "fas fa-sliders",
    type: TalkingHeadsConfig,
    restricted: true,
  });

  game.settings.registerMenu("live-actors", "videoAnimConfig", {
    name: "Video Window Config",
    label: "Configure",
    hint: "Animate AV camera tiles when a player's camera is off. Requires Foundry A/V enabled (not Disabled mode). GM only.",
    icon: "fas fa-sliders",
    type: VideoAnimatorConfig,
    restricted: true,
  });

  // ── Hidden — bounce presets (managed by config submenus) ─

  game.settings.register("live-actors", "bouncePreset",     { scope: "world", config: false, type: String,  default: "bouncy" });
  game.settings.register("live-actors", "headBouncePreset", { scope: "world", config: false, type: String,  default: "toon" });
  game.settings.register("live-actors", "videoBouncePreset",{ scope: "world", config: false, type: String,  default: "pulse" });

  // ── Hidden — managed by Token Animation Config submenu (GM only) ─

  game.settings.register("live-actors", "indicatorStyle", { scope: "world", config: false, type: String, default: "bubble" });
  game.settings.register("live-actors", "mode",         { scope: "world",  config: false, type: String, default: "none", onChange: v => { AudioEngine._cfg.mode = v; CanvasAnimator.onModeChange(); } });
  game.settings.register("live-actors", "intensity",    { scope: "world",  config: false, type: Number, default: 2.0  });
  game.settings.register("live-actors", "bounceMax",    { scope: "world",  config: false, type: Number, default: 8    });
  game.settings.register("live-actors", "angleMax",     { scope: "world",  config: false, type: Number, default: 2    });
  game.settings.register("live-actors", "scaleAxis",    { scope: "world",  config: false, type: String, default: "xy" });
  game.settings.register("live-actors", "scaleLow",     { scope: "world",  config: false, type: Number, default: 1.0  });
  game.settings.register("live-actors", "scaleHigh",    { scope: "world",  config: false, type: Number, default: 1.10 });
  game.settings.register("live-actors", "scaleDamping", { scope: "world",  config: false, type: Number, default: 0.88 });

  // ── Hidden — managed by Talking Heads Config submenu (world = GM-controlled for all) ──

  game.settings.register("live-actors", "headIndicatorStyle", { scope: "world", config: false, type: String, default: "none", onChange: v => TalkingHeads._headIndicatorStyle = v });
  game.settings.register("live-actors", "headWidth",        { scope: "world",  config: false, type: Number, default: 260,      onChange: () => TalkingHeads.requestRebuild() });
  game.settings.register("live-actors", "headAspectRatio",  { scope: "world",  config: false, type: Boolean, default: false,  onChange: () => TalkingHeads.requestRebuild() });
  game.settings.register("live-actors", "showHeadName",     { scope: "world",  config: false, type: Boolean, default: true,   onChange: () => TalkingHeads.requestRebuild() });
  game.settings.register("live-actors", "headNameSize",     { scope: "world",  config: false, type: Number, default: 0.8,    onChange: () => TalkingHeads.requestRebuild() });
  game.settings.register("live-actors", "headMode",        { scope: "world",  config: false, type: String, default: "hybrid", onChange: v => { AudioEngine._cfg.headMode = v; TalkingHeads.requestRebuild(); } });
  game.settings.register("live-actors", "headMask",        { scope: "world",  config: false, type: String, default: "modules/live-actors/assets/masks/grunge-1.webp", onChange: () => TalkingHeads.requestRebuild() });
  // Avatar mode: show a separate "{tokenBase}-avatar.ext" image (full-body/portrait),
  // static aspect ratio, no visemes. Decoupled from headMode (forced simple bounce).
  game.settings.register("live-actors", "headUseAvatar",   { scope: "world",  config: false, type: Boolean, default: true,  onChange: () => TalkingHeads.requestRebuild() });
  game.settings.register("live-actors", "headAvatarWidth",  { scope: "world",  config: false, type: Number, default: 200,    onChange: () => TalkingHeads.requestRebuild() });
  // Cartoon silhouette outline (Talking Heads only). Follows the alpha from the mask,
  // or — with Cutout on — the portrait PNG's own transparency.
  game.settings.register("live-actors", "headOutline",      { scope: "world",  config: false, type: Boolean, default: false,  onChange: () => TalkingHeads.requestRebuild() });
  game.settings.register("live-actors", "headOutlineWidth", { scope: "world",  config: false, type: Number,  default: 3,      onChange: () => TalkingHeads.requestRebuild() });
  game.settings.register("live-actors", "headOutlineAuto",  { scope: "world",  config: false, type: Boolean, default: true,   onChange: () => TalkingHeads.requestRebuild() }); // true = each player's colour
  game.settings.register("live-actors", "headOutlineColor", { scope: "world",  config: false, type: String,  default: "#ffffff", onChange: () => TalkingHeads.requestRebuild() });
  game.settings.register("live-actors", "headCutout",       { scope: "world",  config: false, type: Boolean, default: false,  onChange: () => TalkingHeads.requestRebuild() });
  // Avatar mode has its own outline config (silhouette = avatar PNG alpha, so no Cutout toggle).
  game.settings.register("live-actors", "headAvatarOutline",      { scope: "world", config: false, type: Boolean, default: true,    onChange: () => TalkingHeads.requestRebuild() });
  game.settings.register("live-actors", "headAvatarOutlineWidth", { scope: "world", config: false, type: Number,  default: 4,        onChange: () => TalkingHeads.requestRebuild() });
  game.settings.register("live-actors", "headAvatarOutlineAuto",  { scope: "world", config: false, type: Boolean, default: false,     onChange: () => TalkingHeads.requestRebuild() });
  game.settings.register("live-actors", "headAvatarOutlineColor", { scope: "world", config: false, type: String,  default: "#ffffff", onChange: () => TalkingHeads.requestRebuild() });
  game.settings.register("live-actors", "headBounceMax",    { scope: "world",  config: false, type: Number, default: 5    });
  game.settings.register("live-actors", "headAngleMax",     { scope: "world",  config: false, type: Number, default: 12   });
  game.settings.register("live-actors", "headScaleAxis",    { scope: "world",  config: false, type: String, default: "y"  });
  game.settings.register("live-actors", "headScaleLow",     { scope: "world",  config: false, type: Number, default: 1.0  });
  game.settings.register("live-actors", "headScaleHigh",    { scope: "world",  config: false, type: Number, default: 1.4  });
  game.settings.register("live-actors", "headScaleDamping", { scope: "world",  config: false, type: Number, default: 0.88 });
  game.settings.register("live-actors", "headIntensity",    { scope: "world",  config: false, type: Number, default: 3.4  });
  game.settings.register("live-actors", "headMirrorMap",    { scope: "world",  config: false, type: Object, default: {}   });

  // ── Hidden — managed by Video Window Config submenu (world = all clients animate identically) ──
  // All video* settings hint: requires Foundry A/V enabled (not Disabled mode).

  game.settings.register("live-actors", "videoMode",        { scope: "world",  config: false, type: String,  default: "hybrid", onChange: v => { AudioEngine._cfg.videoMode = v; VideoAnimator._scanAll(); } });
  game.settings.register("live-actors", "videoBounceMax",   { scope: "world",  config: false, type: Number,  default: 1    });
  game.settings.register("live-actors", "videoAngleMax",    { scope: "world",  config: false, type: Number,  default: 0    });
  game.settings.register("live-actors", "videoScaleAxis",   { scope: "world",  config: false, type: String,  default: "xy" });
  game.settings.register("live-actors", "videoScaleLow",    { scope: "world",  config: false, type: Number,  default: 1.0  });
  game.settings.register("live-actors", "videoScaleHigh",   { scope: "world",  config: false, type: Number,  default: 1.05 });
  game.settings.register("live-actors", "videoIntensity",   { scope: "world",  config: false, type: Number,  default: 1.5  });
  game.settings.register("live-actors", "videoScaleDamping",{ scope: "world",  config: false, type: Number,  default: 0.92 });

  // Clean mode — client-scoped so each player controls their own AV chrome visibility.
  game.settings.register("live-actors", "videoCleanName",     { scope: "client", config: false, type: Boolean, default: false, onChange: () => VideoAnimator._scanAll() });
  game.settings.register("live-actors", "videoCleanControls", { scope: "client", config: false, type: Boolean, default: true, onChange: () => VideoAnimator._scanAll() });
  game.settings.register("live-actors", "videoCleanBorder",   { scope: "client", config: false, type: Boolean, default: true, onChange: () => VideoAnimator._scanAll() });

  // ── Hidden — managed by scene control toggle button ───────────

  game.settings.register("live-actors", "enabled", {
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
    onChange: (value) => {
      ui.controls.render();
      _applyState();
      // Toggling the module off should release the mic (browser's "mic in use"
      // indicator, privacy) — enabled:false only suppressed the callback before,
      // capture kept running for the whole session. Combat-pause deliberately
      // does NOT tear this down (see _isEffectivelyEnabled) — only the explicit toggle.
      if (value) _startAudioEngine();
      else AudioEngine.destroy();
    },
  });

  // ── Last in panel ─────────────────────────────────────────────

  game.settings.register("live-actors", "disableDuringCombat", {
    name: "Pause During Encounters",
    hint: "Automatically disables Live Actors when a combat encounter is active on the current scene.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => _applyCombatState(),
  });

  game.settings.register("live-actors", "disableAnimations", {
    name: "Disable Live Actors",
    hint: "Skip all animation processing on this client — no microphone access, no canvas animation, no talking heads. Use on low-end hardware.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    requiresReload: true,
  });

}

Hooks.on("init", () => {
  registerSettings();
});

// One-line diagnostic for the scene-control tooltip — when nothing animates a
// GM otherwise can't tell whether the cause is mic permission, module state,
// combat pause, or mode "none" without digging through settings.
function _statusTooltip() {
  const enabled = game.settings.get("live-actors", "enabled");
  const mode    = game.settings.get("live-actors", "mode");
  const mic     = game.settings.get("live-actors", "disableAnimations")
    ? "off (client)"
    : (AudioEngine.isActive() ? "active" : "inactive");
  const paused  = !enabled
    ? "module off"
    : (game.settings.get("live-actors", "disableDuringCombat") && _combatActive)
      ? "combat"
      : "no";
  return `Live Actors — Mic: ${mic} · Mode: ${mode} · Paused: ${paused}`;
}

Hooks.on("getSceneControlButtons", controls => {
  // v14: controls is a plain object keyed by layer name, tools is also an object
  if (!game.user.isGM) return;
  if (!controls.tokens) return;

  controls.tokens.tools["live-actors-toggle"] = {
    name:   "live-actors-toggle",
    title:  _statusTooltip(),
    icon:   "fas fa-head-side-speak",
    toggle: true,
    active: game.settings.get("live-actors", "enabled"),
    onChange: (event, active) => game.settings.set("live-actors", "enabled", active),
  };

  if (game.settings.get("live-actors", "speakerWidget")) {
    controls.tokens.tools["live-actors-widget"] = {
      name: "live-actors-widget",
      title: "Live Actors: Pin NPC",
      icon: "fas fa-microphone-lines",
      button: true,
      onChange: () => SpeakerWidget.toggle(),
    };
  }

  // Video Window config is reachable from the module Settings menu
  // (registerMenu "videoAnimConfig"); no scene-control button to avoid clutter.
});

Hooks.on("canvasReady", () => {
  CanvasAnimator.reset();
  SpeakerWidget.clearPin();
  SpeakerWidget._instance?.render({ force: true });
  TalkingHeads.syncScene();
  _applyCombatState();
});

Hooks.on("updateScene", (scene, diff) => {
  if (scene.id === canvas.scene?.id && diff.flags?.["live-actors"]?.headPositions) {
    TalkingHeads.syncScene();
  }
});

Hooks.on("controlToken", () => {
  if (!game.user.isGM) return;

  // Resolve which token (if any) is now the GM's talking head
  let gmTokenId = null;
  if (canvas.ready) {
    const controlled = canvas.tokens?.controlled ?? [];
    if (controlled.length === 1) {
      const t = controlled[0];
      const isPlayerChar = game.users.some(u => !u.isGM && u.active && u.character?.id === t.document.actorId);
      if (!isPlayerChar) gmTokenId = t.id;
    }
  }

  // Apply locally — GM filters own socket messages so we can't rely on echo
  TalkingHeads.setGMAutoToken(gmTokenId);
  VideoAnimator.setGMAutoToken(gmTokenId);

  // Broadcast to players
  game.socket.emit("module.live-actors", {
    type: "gmHead",
    userId: game.user.id,
    tokenId: gmTokenId,
  });
});

// Selecting a viseme token: immediately discover its assets and hold the -closed
// rest frame, instead of waiting for the next audio frame. CanvasAnimator keeps
// the token in its active set so the tick re-asserts the closed frame each frame,
// surviving Foundry's own post-selection mesh refresh.
Hooks.on("controlToken", (token, controlled) => {
  if (!controlled) return;
  if (game.settings.get("live-actors", "disableAnimations")) return;
  CanvasAnimator.prepareToken(token);
});

// If a GM changes a token's image mid-session, the viseme/mask/swap-fit caches
// (keyed by tokenId, discovered from the OLD texture.src) go stale and the
// module keeps swapping the old frames onto the new art. Capture the prior path
// in preUpdateToken (updateToken's document already reflects the new value).
const _tokenSrcBeforeUpdate = new Map(); // tokenId → texture.src just before an update that changes it

Hooks.on("preUpdateToken", (doc, changes) => {
  if (foundry.utils.hasProperty(changes, "texture.src")) {
    _tokenSrcBeforeUpdate.set(doc.id, doc.texture.src);
  }
});

Hooks.on("updateToken", (doc, changes) => {
  if (!foundry.utils.hasProperty(changes, "texture.src")) return;
  const oldSrc = _tokenSrcBeforeUpdate.get(doc.id);
  _tokenSrcBeforeUpdate.delete(doc.id);
  CanvasAnimator.invalidateTokenArt(doc.id, oldSrc);
});

Hooks.on("createCombat",  _applyCombatState);
Hooks.on("deleteCombat",  _applyCombatState);
Hooks.on("updateCombat",  _applyCombatState);

Hooks.on("createToken", () => {
  CanvasAnimator.invalidateLocalTokenCache();
  SpeakerWidget._instance?.render({ force: true });
});

Hooks.on("deleteToken", (doc) => {
  CanvasAnimator.cleanupToken(doc.id);
  CanvasAnimator.invalidateLocalTokenCache();
  if (SpeakerWidget.pinnedTokenId === doc.id) SpeakerWidget.clearPin();
  SpeakerWidget._instance?.render({ force: true });
});

Hooks.on("ready", () => {
  // One-time migration: advancedMode (Boolean) → mode (String)
  const store = game.settings.storage.get("client");
  if (store?.getItem("live-actors.advancedMode") !== null && store?.getItem("live-actors.mode") === null) {
    game.settings.set("live-actors", "mode", store.getItem("live-actors.advancedMode") === "true" ? "advanced" : "simple");
  }

  // Echo Guard runs regardless of disableAnimations — it governs Foundry mic
  // broadcast, not animation. A player on low-end hardware (animations off) must
  // still be muted so they don't double their voice over external chat. Reassert
  // on every A/V render so a player can't un-mute themselves in the dock while on.
  Hooks.on("renderCameraViews",  () => EchoGuard.reassert());
  Hooks.on("renderCameraPopout", () => EchoGuard.reassert());
  EchoGuard.apply();
  EchoGuard.maybePromptGM();

  if (game.settings.get("live-actors", "disableAnimations")) return;

  SocketHandler.init();
  CanvasAnimator.init();
  TalkingHeads.init();
  VideoAnimator.init();

  _startAudioEngine();

  _applyCombatState();
});
