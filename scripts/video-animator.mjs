// ─────────────────────────────────────────────────────────────────────────────
// VideoAnimator — animates Foundry VTT's built-in A/V camera tiles.
//
// WHAT IT DOES
//   When a player's camera is OFF their AV tile shows a static portrait image.
//   This class replaces that portrait with a live animated frame driven by the
//   same mic state (volume, speaking, viseme) that drives the canvas tokens and
//   talking heads. When the camera is ON it does nothing — the live feed takes
//   priority and Foundry handles it.
//
// HOW IT HOOKS INTO FOUNDRY
//   Foundry v14 renders AV tiles via two ApplicationV2 classes:
//     • CameraViews  (id="camera-views")      — the docked panel, all users.
//     • CameraPopout (id="camera-view-{uid}") — individual floating windows.
//
//   Both fire an ApplicationV2 render hook after every DOM update:
//     Hooks.on("renderCameraViews",  handler)
//     Hooks.on("renderCameraPopout", handler)
//
//   Both produce tiles with the selector:
//     .camera-view[data-user="<userId>"]
//
//   Inside each tile:
//     .video-container > img.user-avatar   ← portrait shown when camera OFF
//     .video-container > video.user-camera ← live feed; has [hidden] attr when OFF
//
//   IF FOUNDRY CHANGES THE A/V IMPLEMENTATION, CHECK:
//     1. The tile selector: ".camera-view[data-user]"
//     2. The camera-off detection: video.user-camera[hidden] — if Foundry stops
//        using the [hidden] attribute, update _syncTile().
//     3. The inner container: ".video-container" — where we inject our frame.
//     4. The hook names: "renderCameraViews" and "renderCameraPopout" — if
//        Foundry renames the classes the hook names change too.
//     5. The pre-requisite: CameraViews._canRender() returns false when
//        game.webrtc.settings.world.mode === AVSettings.AV_MODES.DISABLED.
//        Our code never runs when A/V is disabled, which is correct.
//
// OVERFLOW / CLIPPING
//   .camera-view has overflow:hidden so Foundry's border-radius clips content.
//   We add class "lva-video-animated" to tiles we manage and override that in
//   CSS so the bounce scale can pop slightly outside the tile. See the CSS block
//   in live-actors.css for the override and the rationale.
//
// STATE FLOW
//   Local user speaking  → AudioEngine callback → VideoAnimator.applyLocalState()
//   Remote user speaking → SocketHandler        → VideoAnimator.update(userId, state)
//   GM token change      → controlToken hook    → VideoAnimator.setGMAutoToken()
//                        → SpeakerWidget pin    → VideoAnimator.setGMPinnedToken()
//
// GM TILES
//   GMs typically have no assigned character. Their tile is driven by:
//     1. Widget-pinned token (_gmPinnedTokenId) — explicit GM choice.
//     2. Auto-controlled token (_gmAutoTokenId) — broadcast from controlToken.
//   Priority: pinned > auto. If neither is set, the GM tile shows no frame.
//
// ─────────────────────────────────────────────────────────────────────────────

const LERP = 0.2; // lerp factor for bounce/offset (matches TalkingHeads)

export class VideoAnimator {

  // userId → { closed?, ah?, ee?, oo? } URL strings
  static _tileImages   = new Map();
  static _imagesPending = new Set();

  // Animation state — same shape as TalkingHeads
  static _targets  = new Map(); // userId → state { speaking, volume, viseme? }
  static _lerped   = new Map(); // userId → { scaleX, scaleY, offsetYPct, angle }
  static _rafId    = null;
  static _lastTime = 0;
  static _cfg      = {};        // settings snapshot taken at wake time (no per-frame gets)

  static _enabled = true;

  // GM token tracking (mirrors TalkingHeads pattern)
  static _gmPinnedTokenId = null; // explicit SpeakerWidget pin (local GM only)
  static _gmAutoTokenId   = null; // broadcast from controlToken hook (all clients)

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  static init() {
    // Hook both render events. Both fire AFTER the tile DOM is fully written,
    // so it is safe to query and inject into tile elements here.
    Hooks.on("renderCameraViews",  () => VideoAnimator._onRender());
    Hooks.on("renderCameraPopout", () => VideoAnimator._onRender());

    // Sync any tiles that are already in the DOM when the module loads
    // (happens when the user refreshes mid-session with A/V already running).
    VideoAnimator._scanAll();
  }

  static setAllIdle() {
    if (VideoAnimator._rafId !== null) {
      cancelAnimationFrame(VideoAnimator._rafId);
      VideoAnimator._rafId = null;
    }
    for (const [userId] of VideoAnimator._targets) {
      const frame = VideoAnimator._getFrame(userId);
      if (frame) {
        frame.style.transform = "";
        frame.closest(".camera-view")?.classList.remove("lva-video-speaking");
        VideoAnimator._setRestImage(frame, userId);
      }
    }
    VideoAnimator._targets.clear();
    VideoAnimator._lerped.clear();
  }

  // ── Render hook ───────────────────────────────────────────────────────────

  // Called after every CameraViews or CameraPopout render. The hook fires once
  // per render event regardless of how many tiles were updated, so we scan all
  // tiles every time. This is cheap (just DOM queries) and ensures tiles that
  // Foundry partially re-renders (e.g. a user muting) get re-synced correctly,
  // since Foundry replaces the tile's DOM which destroys our injected frame.
  static _onRender() {
    VideoAnimator._scanAll();
  }

  static _scanAll() {
    const videoMode = game.settings.get("live-actors", "videoMode");
    for (const tileEl of document.querySelectorAll(".camera-view[data-user]")) {
      VideoAnimator._syncTile(tileEl, videoMode);
    }
  }

  // ── Per-tile management ───────────────────────────────────────────────────

  // Decides whether to inject or remove our animated frame for a single tile.
  // Clean-mode CSS classes are applied regardless of animation mode.
  static _syncTile(tileEl, videoMode) {
    const userId = tileEl.dataset.user;
    if (!userId) return;

    // Clean-mode classes are independent of animation mode.
    VideoAnimator._applyCleanClasses(tileEl);

    if (!VideoAnimator._enabled || videoMode === "none") {
      VideoAnimator._removeFrame(tileEl);
      return;
    }

    // Check whether the live camera feed is active.
    // Foundry hides the <video> element with the [hidden] attribute when the
    // user has no camera feed. If that changes, update this detection.
    const videoEl  = tileEl.querySelector("video.user-camera");
    const cameraOn = videoEl && !videoEl.hidden;

    if (cameraOn) {
      VideoAnimator._removeFrame(tileEl);
    } else {
      VideoAnimator._injectFrame(tileEl, userId, videoMode);
    }
  }

  // Applies/removes the four clean-mode CSS classes based on current settings.
  // These classes target specific UI chrome elements via CSS rules in
  // live-actors.css, so the actual hiding is declarative CSS — no style
  // mutations here.
  static _applyCleanClasses(tileEl) {
    tileEl.classList.toggle("lva-clean-name",     game.settings.get("live-actors", "videoCleanName"));
    tileEl.classList.toggle("lva-clean-status",   game.settings.get("live-actors", "videoCleanStatus"));
    tileEl.classList.toggle("lva-clean-controls", game.settings.get("live-actors", "videoCleanControls"));
    tileEl.classList.toggle("lva-clean-volume",   game.settings.get("live-actors", "videoCleanVolume"));
    tileEl.classList.toggle("lva-clean-border",   game.settings.get("live-actors", "videoCleanBorder"));
  }

  // Injects a .lva-video-frame div into the tile's .video-container.
  // The frame covers the .user-avatar (hidden via CSS when we're present) and
  // hosts the animated <img>. Asset discovery is kicked off here for viseme modes.
  static _injectFrame(tileEl, userId, videoMode) {
    const container = tileEl.querySelector(".video-container");
    if (!container) return;

    // Guard: already injected in this DOM generation (e.g. _scanAll called twice).
    if (container.querySelector(".lva-video-frame")) return;

    // Resolve the token image source for this user.
    // Check whether the tile's user is a GM — not whether the current client is.
    // _gmAutoTokenId/_gmPinnedTokenId are populated on all clients via the gmHead socket.
    const isGM    = !!game.users.get(userId)?.isGM;
    const tokenSrc = isGM
      ? VideoAnimator._getGMTokenSrc()
      : VideoAnimator._getTokenSrcForUser(userId);

    // For players: no character means nothing to show.
    // For the GM:  no pinned/auto token means we wait until one is selected.
    if (!tokenSrc) return;

    // Mark the tile so CSS can override overflow:hidden (see live-actors.css).
    tileEl.classList.add("lva-video-animated");

    const frame = document.createElement("div");
    frame.className = "lva-video-frame";
    frame.dataset.userId = userId;

    const img = document.createElement("img");
    img.className = "lva-head-img";
    const routedSrc = _route(tokenSrc);
    img.src = routedSrc;
    img.dataset.originalSrc = routedSrc;
    img.dataset.curViseme   = "__rest__";
    img.alt      = "";
    img.draggable = false;
    frame.appendChild(img);
    container.appendChild(frame);

    // If videoAssets arrived before this frame was injected, apply them now.
    const earlyImages = VideoAnimator._tileImages.get(userId);
    if (earlyImages) {
      const hasVisemes = earlyImages.oo || earlyImages.ah || earlyImages.ee;
      if (hasVisemes) frame.classList.add("lva-video-has-visemes");
      img.dataset.curViseme = ""; // force _setRestImage to write
      VideoAnimator._setRestImage(frame, userId);
    }

    // Kick off viseme asset discovery when the mode can use them.
    // Non-GM/non-assistant clients skip discovery and wait for the videoAssets socket.
    const wantsVisemes = videoMode === "advanced" || videoMode === "hybrid" || videoMode === "both";
    if (wantsVisemes) {
      VideoAnimator._discoverTileImages(userId, tokenSrc);
    }
  }

  static _removeFrame(tileEl) {
    tileEl.classList.remove("lva-video-animated");
    tileEl.querySelector(".lva-video-frame")?.remove();
  }

  // Returns the .lva-video-frame for a userId, or null if not in the DOM.
  static _getFrame(userId) {
    return document.querySelector(`.camera-view[data-user="${userId}"] .lva-video-frame`) ?? null;
  }

  // ── Token resolution ──────────────────────────────────────────────────────

  // For players: walk user → character → on-canvas token → prototype fallback.
  static _getTokenSrcForUser(userId) {
    const user = game.users.get(userId);
    if (!user?.character) return null;
    if (canvas.ready) {
      const t = canvas.tokens?.placeables?.find(t => t.document.actorId === user.character.id);
      if (t) return t.document.texture.src;
    }
    return user.character.prototypeToken?.texture?.src ?? null;
  }

  // For the GM: widget pin takes priority over the auto-detected controlled token.
  static _getGMTokenSrc() {
    const tokenId = VideoAnimator._gmPinnedTokenId ?? VideoAnimator._gmAutoTokenId;
    if (!tokenId || !canvas.ready) return null;
    return canvas.tokens?.placeables?.find(t => t.id === tokenId)?.document.texture.src ?? null;
  }

  // ── GM token tracking ─────────────────────────────────────────────────────

  // Called from SpeakerWidget when the GM explicitly pins/unpins a token.
  static setGMPinnedToken(tokenId) {
    const prevSrc = VideoAnimator._getGMTokenSrc();
    VideoAnimator._gmPinnedTokenId = tokenId ?? null;
    if (VideoAnimator._getGMTokenSrc() !== prevSrc) VideoAnimator._refreshGMFrame();
  }

  // Called from the controlToken hook (GM client) and from the gmHead socket
  // message (player clients). The widget pin takes priority, so auto only wins
  // when no pin is set.
  static setGMAutoToken(tokenId) {
    const prevSrc = VideoAnimator._getGMTokenSrc();
    VideoAnimator._gmAutoTokenId = tokenId ?? null;
    if (VideoAnimator._getGMTokenSrc() !== prevSrc) VideoAnimator._refreshGMFrame();
  }

  // Clears the cached images for the GM userId and re-syncs the GM's tile so
  // the new token's portrait (and visemes) are picked up.
  static _refreshGMFrame() {
    const gm = game.users.find(u => u.isGM);
    if (!gm) return;
    VideoAnimator._tileImages.delete(gm.id);
    VideoAnimator._imagesPending.delete(gm.id);
    const tileEl = document.querySelector(`.camera-view[data-user="${gm.id}"]`);
    if (!tileEl) return;
    VideoAnimator._removeFrame(tileEl);
    const videoMode = game.settings.get("live-actors", "videoMode");
    if (VideoAnimator._enabled && videoMode !== "none") {
      VideoAnimator._syncTile(tileEl, videoMode);
    }
  }

  // ── State application ─────────────────────────────────────────────────────

  static applyLocalState(state) {
    VideoAnimator.update(game.user.id, state);
  }

  // Called for remote users via SocketHandler, and for the local user via
  // applyLocalState. Updates viseme image swap and starts the rAF loop.
  static update(userId, state) {
    if (!VideoAnimator._enabled) return;
    const frame = VideoAnimator._getFrame(userId);
    if (!frame) return;

    const speaking = state.speaking === true;

    // Already settled and not being asked to speak — nothing to do.
    if (!speaking && !VideoAnimator._targets.has(userId)) return;

    VideoAnimator._targets.set(userId, state);

    const videoMode    = game.settings.get("live-actors", "videoMode");
    const wantsVisemes = videoMode === "advanced" || videoMode === "hybrid" || videoMode === "both";
    const hasVisemes   = frame.classList.contains("lva-video-has-visemes");
    const doVisemes    = wantsVisemes && state.viseme !== undefined && hasVisemes;

    frame.closest(".camera-view")?.classList.toggle("lva-video-speaking", speaking);

    if (speaking && doVisemes) {
      const img = frame.querySelector(".lva-head-img");
      if (img && img.dataset.curViseme !== state.viseme) {
        const images = VideoAnimator._tileImages.get(userId);
        const src    = images?.[state.viseme] ?? images?.closed ?? img.dataset.originalSrc;
        if (src) { img.src = src; img.dataset.curViseme = state.viseme; }
      }
    } else if (!speaking) {
      VideoAnimator._setRestImage(frame, userId);
    }

    VideoAnimator._ensureRunning();
  }

  // ── rAF loop ──────────────────────────────────────────────────────────────

  static _ensureRunning() {
    if (VideoAnimator._rafId === null) {
      VideoAnimator._lastTime = 0;
      VideoAnimator._wake();
      VideoAnimator._rafId = requestAnimationFrame(VideoAnimator._tick);
    }
  }

  // Snapshots all world-scoped animation settings once at wake time so the tick
  // never calls game.settings.get() — per-frame settings reads are expensive.
  static _wake() {
    const get = k => game.settings.get("live-actors", k);
    VideoAnimator._cfg = {
      videoMode:    get("videoMode"),
      bounceMax:    get("videoBounceMax"),
      angleMax:     get("videoAngleMax"),
      scaleAxis:    get("videoScaleAxis"),
      scaleHigh:    get("videoScaleHigh"),
      intensity:    get("videoIntensity"),
      scaleDamping: get("videoScaleDamping"),
    };
  }

  static _tick(ts) {
    const cfg          = VideoAnimator._cfg;
    const { videoMode, bounceMax, angleMax, scaleAxis, scaleHigh, intensity, scaleDamping } = cfg;
    const now          = Date.now();

    const delta      = VideoAnimator._lastTime ? (ts - VideoAnimator._lastTime) : (1000 / 60);
    VideoAnimator._lastTime = ts;

    // Framerate-independent scale smoothing via exponential decay.
    const scaleTau   = scaleDamping <= 0 ? 0 : -(1000 / 60) / Math.log(Math.min(scaleDamping, 0.999));
    const scaleAlpha = scaleTau <= 0 ? 1 : 1 - Math.exp(-delta / scaleTau);

    for (const [userId, target] of VideoAnimator._targets) {
      const frame = VideoAnimator._getFrame(userId);
      if (!frame) {
        // Tile was removed (user left, popout closed, etc.) — drop state cleanly.
        VideoAnimator._targets.delete(userId);
        VideoAnimator._lerped.delete(userId);
        continue;
      }

      let s = VideoAnimator._lerped.get(userId);
      if (!s) {
        s = { scaleX: 1, scaleY: 1, offsetYPct: 0, angle: 0 };
        VideoAnimator._lerped.set(userId, s);
      }

      const speaking      = target.speaking === true;
      const vol           = target.volume ?? 0;
      const effectiveVol  = Math.min(vol * intensity, 1.0);
      const hasVisemes    = frame.classList.contains("lva-video-has-visemes");
      const speakerSendsVis = target.viseme !== undefined;

      // Capability-clamped bounce decision — same logic as TalkingHeads.
      let doBounce;
      if      (videoMode === "none")     doBounce = false;
      else if (videoMode === "simple")   doBounce = true;
      else if (videoMode === "advanced") doBounce = false;
      else if (videoMode === "hybrid")   doBounce = !speakerSendsVis || !hasVisemes;
      else                               doBounce = true; // "both"

      // Gate on real voiced level, not just the latched speaking flag, so ambient
      // noise during the silence-hold window can't jitter the portrait.
      const voiced = effectiveVol > 0.06;

      if (doBounce && speaking && voiced) {
        const s0  = Math.min(1, effectiveVol);
        const sf  = 1.0 + s0 * (scaleHigh - 1.0);
        const tSX = scaleAxis !== "y"  ? sf  : 1.0;
        const tSY = scaleAxis !== "x"  ? sf  : 1.0;
        s.scaleX += (tSX - s.scaleX) * scaleAlpha;
        s.scaleY += (tSY - s.scaleY) * scaleAlpha;

        const tOY  = bounceMax * effectiveVol;
        const tAng = (angleMax > 0 && effectiveVol > 0.02)
          ? Math.sin(now * 0.01) * effectiveVol * angleMax
          : 0;
        s.offsetYPct += (tOY  - s.offsetYPct) * LERP;
        s.angle      += (tAng - s.angle)       * LERP;
      } else {
        // Ease back to rest
        s.scaleX     += (1.0 - s.scaleX)     * LERP;
        s.scaleY     += (1.0 - s.scaleY)     * LERP;
        s.offsetYPct += (0   - s.offsetYPct) * LERP;
        s.angle      += (0   - s.angle)      * LERP;
      }

      // Fully settled and silent → snap to exact rest, stop tracking this user.
      if (!speaking
          && Math.abs(s.scaleX - 1)  < 0.001
          && Math.abs(s.scaleY - 1)  < 0.001
          && Math.abs(s.offsetYPct)  < 0.05
          && Math.abs(s.angle)       < 0.05) {
        s.scaleX = 1; s.scaleY = 1; s.offsetYPct = 0; s.angle = 0;
        frame.style.transform = "";
        frame.closest(".camera-view")?.classList.remove("lva-video-speaking");
        VideoAnimator._setRestImage(frame, userId);
        VideoAnimator._targets.delete(userId);
        VideoAnimator._lerped.delete(userId);
        continue;
      }

      frame.style.transform =
        `translateY(-${s.offsetYPct.toFixed(2)}%) ` +
        `scale(${s.scaleX.toFixed(4)}, ${s.scaleY.toFixed(4)}) ` +
        `rotate(${s.angle.toFixed(2)}deg)`;
    }

    // Keep the loop alive only while there are active targets.
    VideoAnimator._rafId = VideoAnimator._targets.size
      ? requestAnimationFrame(VideoAnimator._tick)
      : null;
  }

  // ── Image handling ────────────────────────────────────────────────────────

  // Sets the frame image to the appropriate rest state:
  //   – In viseme modes with a discovered -closed image: the closed frame.
  //   – Otherwise: the original token portrait.
  // Guards the curViseme tag to avoid unnecessary DOM writes.
  static _setRestImage(frame, userId) {
    const img = frame.querySelector(".lva-head-img");
    if (!img) return;
    if (img.dataset.curViseme === "__rest__") return;
    const videoMode    = game.settings.get("live-actors", "videoMode");
    const wantsVisemes = videoMode === "advanced" || videoMode === "hybrid" || videoMode === "both";
    const hasVisemes   = frame.classList.contains("lva-video-has-visemes");
    const images       = VideoAnimator._tileImages.get(userId);
    const rest = (wantsVisemes && hasVisemes && images?.closed) ? images.closed : img.dataset.originalSrc;
    if (rest) img.src = rest;
    img.dataset.curViseme = "__rest__";
  }

  // Discovers viseme images for a user's token, mirroring TalkingHeads._discoverHeadImages.
  //
  // Supported layouts (same as canvas tokens and talking heads — keep in sync):
  //   Sheet:  {base}-sheet.ext or {base}_sheet.ext  — 2×2 grid, closed=TL, ah=TR, ee=BL, oo=BR
  //   Files:  {base}-closed.ext, {base}-oo.ext, {base}-ah.ext, {base}-ee.ext
  //
  // Socket-first: only GM/assistant clients run discovery. After finding paths the GM
  // broadcasts a "videoAssets" socket message so player clients receive the URLs directly —
  // no HEAD probes, no FilePicker access required on non-GM clients.
  static async _discoverTileImages(userId, imgPath) {
    // Non-GM/non-assistant: skip — wait for the videoAssets socket broadcast from the GM.
    const canBrowse = game.user.isGM || game.user.role >= CONST.USER_ROLES.ASSISTANT;
    if (!canBrowse) return;

    if (VideoAnimator._imagesPending.has(userId)) return;
    if (VideoAnimator._tileImages.has(userId)) return;
    VideoAnimator._imagesPending.add(userId);

    const lastSlash = imgPath.lastIndexOf("/");
    const folder    = lastSlash >= 0 ? imgPath.slice(0, lastSlash) : "";
    const filename  = lastSlash >= 0 ? imgPath.slice(lastSlash + 1) : imgPath;
    const lastDot   = filename.lastIndexOf(".");
    const base      = lastDot >= 0 ? filename.slice(0, lastDot) : filename;

    let images = null;

    try {
      const result = await foundry.applications.apps.FilePicker.implementation.browse("data", folder || "/");
      const files  = result.files ?? [];

      const sheetRe  = new RegExp(`^${_escRegex(base)}[-_]sheet\\.[^.]+$`, "i");
      const sheetFile = files.find(f => sheetRe.test(f.includes("/") ? f.slice(f.lastIndexOf("/") + 1) : f));
      if (sheetFile) {
        images = await _loadFlipbookURLs(sheetFile);
      } else {
        images = {};
        for (const viseme of ["closed", "oo", "ah", "ee"]) {
          const re    = new RegExp(`^${_escRegex(base)}[ \\-_]${viseme}\\.[^.]+$`, "i");
          const match = files.find(f => re.test(f.includes("/") ? f.slice(f.lastIndexOf("/") + 1) : f));
          if (match) images[viseme] = _route(match);
        }
      }
    } catch {
      images = {};
    }

    VideoAnimator._tileImages.set(userId, images ?? {});
    VideoAnimator._imagesPending.delete(userId);

    // Broadcast discovered paths to all player clients (socket-first pattern).
    game.socket.emit("module.live-actors", { type: "videoAssets", userId, images: images ?? {} });

    // Apply locally — GM doesn't receive its own socket broadcast.
    VideoAnimator._applySharedImages(userId, images ?? {});
  }

  // Called when a "videoAssets" socket message arrives (all non-GM clients).
  // Stores the discovered image URLs and applies them to the tile frame if it exists.
  static receiveSharedTileImages(userId, data) {
    const images = data.images ?? {};
    VideoAnimator._tileImages.set(userId, images);
    VideoAnimator._applySharedImages(userId, images);
  }

  // Shared post-discovery logic: marks the frame as having visemes and shows the rest image.
  static _applySharedImages(userId, images) {
    const hasVisemes = !!(images.oo || images.ah || images.ee);
    const frame      = VideoAnimator._getFrame(userId);
    if (!frame) return;
    if (hasVisemes) frame.classList.add("lva-video-has-visemes");
    if (!frame.closest(".camera-view")?.classList.contains("lva-video-speaking")) {
      VideoAnimator._setRestImage(frame, userId);
    }
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function _escRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Route-aware URL helper — same as TalkingHeads._route. Applies the Foundry
// route prefix so assets load correctly on hosted servers.
function _route(path) {
  if (!path) return path;
  if (/^(?:https?:|data:|blob:)/i.test(path) || path.includes("://")) return path;
  return foundry.utils.getRoute(path);
}

// Crops a 2×2 flipbook sheet into four data-URL images using Canvas 2D.
// Layout: closed=top-left, ah=top-right, ee=bottom-left, oo=bottom-right.
// MUST match the layout in CanvasAnimator._loadFlipbook and TalkingHeads._loadFlipbookURLs.
async function _loadFlipbookURLs(sheetPath) {
  const url = _route(sheetPath);
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
  const hw = img.naturalWidth  / 2;
  const hh = img.naturalHeight / 2;
  const layout = { closed: [0, 0], ah: [hw, 0], ee: [0, hh], oo: [hw, hh] };
  const result = {};
  for (const [key, [sx, sy]] of Object.entries(layout)) {
    const cv  = document.createElement("canvas");
    cv.width  = hw;
    cv.height = hh;
    cv.getContext("2d").drawImage(img, sx, sy, hw, hh, 0, 0, hw, hh);
    result[key] = cv.toDataURL();
  }
  return result;
}
