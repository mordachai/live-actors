// ─────────────────────────────────────────────────────────────────────────────
// EchoGuard — "Echo Guard" / external-voice safety.
//
// PROBLEM
//   Tables that talk over Discord (or any external voice app) but enable Foundry
//   A/V for the Live Actors video tiles can leak audio: if a player's Foundry mic
//   is broadcasting, everyone hears that player TWICE — once on Discord, once
//   through Foundry. The module itself never plays audio (AudioEngine only reads
//   the mic for analysis); the duplication is Foundry's A/V transmitting the mic.
//
// FIX
//   A world setting "externalVoice" (Echo Guard). When ON, every client mutes its
//   OWN outgoing Foundry microphone. A client can only mute itself, but the world
//   setting's onChange fires on every client, so the fan-out reaches everyone —
//   GM-enforced, table-wide. Video tiles + animations keep working because the
//   AudioEngine captures the mic with its own getUserMedia stream, independent of
//   Foundry's broadcast track.
//
// WHEN IT MATTERS (audio-capable only)
//   Foundry refuses to broadcast audio in VIDEO-only and DISABLED world modes
//   (AVMaster.canUserShareAudio → false). So duplication is only possible in
//   AUDIO or AUDIO_VIDEO mode. Enforcement and the GM popup gate on that — no
//   muting, no popup, no screen noise in configs that can't leak audio.
//
// MUTE API (Foundry v14 — verified against client/av/{master,settings}.mjs)
//   read  : game.webrtc.settings.get("client", `users.${id}.muted`)   (raw choice)
//   set   : game.webrtc.settings.set("client", `users.${id}.muted`, v)
//           → fires AVMaster#onSettingsChanged → client.toggleAudio(canUserShareAudio)
//   mode  : game.webrtc.mode  vs  game.webrtc.settings.constructor.AV_MODES
//
// SNAPSHOT / RESTORE
//   Turning Echo Guard ON snapshots each client's prior mute choice ONCE (the
//   client-scoped "echoGuardSnapshot" setting). Turning it OFF restores that
//   snapshot — respecting whatever the player had before, NOT blindly un-muting.
//   The snapshot is read from the RAW persisted choice (connection-independent),
//   so a mid-session refresh still restores faithfully. If no snapshot was ever
//   captured (edge: Echo Guard was already on at first load and the ON transition
//   was never observed) we leave the mic as-is rather than surprise-broadcast.
// ─────────────────────────────────────────────────────────────────────────────

export class EchoGuard {

  static _enabled() {
    return game.settings.get("live-actors", "externalVoice");
  }

  static _avModes() {
    return game.webrtc?.settings?.constructor?.AV_MODES ?? null;
  }

  // Audio duplication is only possible when Foundry can actually broadcast audio:
  // world AV mode AUDIO or AUDIO_VIDEO. VIDEO-only / DISABLED can't (Foundry blocks
  // it), so there is nothing to guard and we stay silent there. Gated on world MODE
  // only (not on the A/V client being connected): the mute is a persisted setting
  // Foundry honours on connect, so we can mute correctly even before A/V finishes
  // connecting on `ready`.
  static _audioCapable() {
    const M = EchoGuard._avModes();
    if (!M) return false;
    const mode = game.webrtc.mode;
    return mode === M.AUDIO || mode === M.AUDIO_VIDEO;
  }

  static _selfMuteKey() {
    return `users.${game.user.id}.muted`;
  }

  // Raw persisted self-mute choice (independent of A/V connection state).
  static _isSelfMuted() {
    return !!game.webrtc?.settings?.get("client", EchoGuard._selfMuteKey());
  }

  static _setSelfMuted(v) {
    if (!game.webrtc?.settings) return;
    if (EchoGuard._isSelfMuted() === !!v) return; // skip redundant writes (avoids render churn)
    game.webrtc.settings.set("client", EchoGuard._selfMuteKey(), !!v);
  }

  // ── State persistence ───────────────────────────────────────────────────────

  static _snapshot() {
    return game.settings.get("live-actors", "echoGuardSnapshot") ?? { captured: false, muted: false };
  }

  static _saveSnapshot(v) {
    return game.settings.set("live-actors", "echoGuardSnapshot", v);
  }

  // ── Enforcement ─────────────────────────────────────────────────────────────

  // Apply the current setting state on THIS client. Called on ready and on the
  // world setting's onChange (fan-out to every client).
  static apply() {
    if (!game.webrtc?.settings) return; // A/V module not present at all
    if (EchoGuard._enabled()) EchoGuard._captureAndMute();
    else EchoGuard._restore();
  }

  static _captureAndMute() {
    if (!EchoGuard._audioCapable()) return; // nothing broadcastable to mute
    const snap = EchoGuard._snapshot();
    if (!snap.captured) {
      EchoGuard._saveSnapshot({ captured: true, muted: EchoGuard._isSelfMuted() });
    }
    EchoGuard._setSelfMuted(true);
  }

  static _restore() {
    const snap = EchoGuard._snapshot();
    if (!snap.captured) return;                 // never muted via Echo Guard → leave as-is
    EchoGuard._setSelfMuted(snap.muted);        // back to the player's prior choice
    EchoGuard._saveSnapshot({ captured: false, muted: false });
  }

  // Re-assert on every camera-view render. Keeps a player from un-muting in the
  // dock while Echo Guard is on (that is the point), and catches the case where
  // the world A/V mode became audio-capable without the setting itself changing.
  // Delegates to _captureAndMute, which is idempotent (snapshot captured once,
  // redundant mute writes skipped) — so it's cheap to call every render.
  static reassert() {
    if (!EchoGuard._enabled()) return;
    EchoGuard._captureAndMute();
  }

  // ── GM popup ────────────────────────────────────────────────────────────────

  // Shown on ready, GM only, when audio-capable A/V is active AND Echo Guard is
  // OFF — so the GM consciously opts in. No popup when audio can't leak (no risk →
  // no noise) or when Echo Guard is already on. Re-appears each refresh while it
  // stays off; enabling it (here or in settings) stops the prompt.
  static async maybePromptGM() {
    if (!game.user.isGM) return;
    if (EchoGuard._enabled()) return;
    if (!EchoGuard._audioCapable()) return;

    let choice;
    try {
      choice = await foundry.applications.api.DialogV2.wait({
        window: { title: "Live Actors — Echo Guard" },
        content: `
          <p>Foundry A/V is broadcasting microphones in this world.</p>
          <p>If your table talks over <strong>Discord or another external voice app</strong>,
          any player whose Foundry mic is on will be heard <strong>twice</strong> — once on
          Discord and once through Foundry.</p>
          <p><strong>Echo Guard</strong> mutes every player's Foundry microphone so no one is
          doubled. Video tiles and Live Actors animations keep working.</p>
          <p>Enable Echo Guard for this world?</p>`,
        buttons: [
          { action: "enable",  label: "Enable Echo Guard", icon: "fa-solid fa-microphone-slash", default: true },
          { action: "dismiss", label: "Not now",           icon: "fa-solid fa-xmark" },
        ],
        rejectClose: false,
      });
    } catch {
      return; // dismissed
    }
    if (choice === "enable") await game.settings.set("live-actors", "externalVoice", true);
  }
}
