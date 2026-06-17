import { AudioEngine } from "./audio-engine.mjs";
import { SpeakerWidget } from "./speaker-widget.mjs";

const LERP = 0.2;

export class CanvasAnimator {
  static _targets        = new Map(); // tokenId → { mode, volume, viseme }
  static _lerped         = new Map(); // tokenId → lerp state
  static _tokenTextures  = new Map(); // tokenId → { closed?, oo, ah, ee } (PIXI.Texture or null)
  static _texturePending = new Set(); // tokenIds currently being discovered
  static _originalTextures = new Map(); // tokenId → original PIXI.Texture before swap
  static _maskTextures   = new Map(); // tokenId → PIXI.Texture (pending application)
  static _maskSprites    = new Map(); // tokenId → PIXI.Sprite (applied mask)
  static _overlays       = new Map(); // tokenId → { ring, bubble, dotsText }
  static _localTokenId   = null;      // tokenId of the token we are currently driving locally
  static _enabled        = true;
  static _running        = false;     // ticker is attached only while something animates
  static _cfg            = null;      // settings snapshot, refreshed on wake / mode change
  static _waveSmooth     = 0;         // EMA of the mic waveform peak — smooths scale (shared, local mic)
  // Paths broadcast by a privileged client (GM/assistant) so players without
  // FILES_BROWSE can load viseme/mask assets without probing. Keyed by imgPath.
  static _sharedPaths    = new Map(); // imgPath → { sheet?, closed?, oo?, ah?, ee?, mask? }

  static init() {
    // Ticker is attached on demand by _wake() — nothing animates at rest.
  }

  // Read the world-scoped animation settings once. Re-read on wake and when the
  // mode changes; values don't change mid-utterance in practice.
  static _refreshCfg() {
    const get = k => game.settings.get("live-actors", k);
    const scaleDamping = get("scaleDamping");
    CanvasAnimator._cfg = {
      bounceMax:      get("bounceMax"),
      angleMax:       get("angleMax"),
      scaleAxis:      get("scaleAxis"),
      scaleLow:       get("scaleLow"),
      scaleHigh:      get("scaleHigh"),
      intensity:      get("intensity"),
      // Convert damping (0..1, higher = smoother) to a time constant so the lerp is
      // framerate-independent. tau chosen so 60 fps reproduces the old residual.
      scaleTau:       scaleDamping <= 0 ? 0 : -(1000 / 60) / Math.log(Math.min(scaleDamping, 0.999)),
      indicatorStyle: get("indicatorStyle"),
    };
  }

  // Receive asset paths broadcast by a privileged client (GM/assistant). Cache them
  // and re-trigger discovery for any canvas tokens using imgPath that still have no
  // visemes loaded (covers the race where animState arrives before tokenAssets).
  static async receiveSharedPaths(imgPath, data) {
    const { sheet, visemes, mask } = data;
    const entry = CanvasAnimator._sharedPaths.get(imgPath) ?? {};
    if (sheet)   entry.sheet = sheet;
    if (visemes) Object.assign(entry, visemes);
    if (mask)    entry.mask  = mask;
    CanvasAnimator._sharedPaths.set(imgPath, entry);

    if (!canvas?.ready) return;
    for (const token of canvas.tokens.placeables) {
      if (token.document.texture.src !== imgPath) continue;
      if ((sheet || visemes) && !CanvasAnimator._hasVisemes(token.id)
          && !CanvasAnimator._texturePending.has(token.id)) {
        CanvasAnimator._tokenTextures.delete(token.id);
        _ensureTokenTextures(token);
      }
      if (mask && !CanvasAnimator._maskSprites.has(token.id)
          && !CanvasAnimator._maskTextures.has(token.id)) {
        try {
          const maskTex = await CanvasAnimator._loadMask(mask);
          CanvasAnimator._maskTextures.set(token.id, maskTex);
        } catch { /* mask load failed */ }
      }
    }
  }

  static _wake() {
    if (CanvasAnimator._running) return;
    CanvasAnimator._refreshCfg();
    CanvasAnimator._waveSmooth = 0;
    PIXI.Ticker.shared.add(CanvasAnimator._tick, CanvasAnimator);
    CanvasAnimator._running = true;
  }

  static _sleep() {
    if (!CanvasAnimator._running) return;
    PIXI.Ticker.shared.remove(CanvasAnimator._tick, CanvasAnimator);
    CanvasAnimator._running = false;
  }

  // Mode changed (GM toggled token animation mode): restore any swapped meshes to
  // their original texture and drop viseme caches so the next speech re-discovers.
  static onModeChange() {
    for (const [tokenId, orig] of CanvasAnimator._originalTextures) {
      const token = canvas?.tokens?.placeables?.find(t => t.id === tokenId);
      if (token?.mesh) {
        if (orig?.valid) token.mesh.texture = orig;
        const s = CanvasAnimator._lerped.get(tokenId);
        if (s) token.mesh.scale.set(s.origScaleX ?? s.baseScaleX, s.origScaleY ?? s.baseScaleY);
      }
    }
    // Drop any masks (custom or default circular) — meshes leave viseme mode.
    for (const [tokenId, ms] of CanvasAnimator._maskSprites) {
      const token = canvas?.tokens?.placeables?.find(t => t.id === tokenId);
      if (token?.mesh) token.mesh.mask = null;
      ms.parent?.removeChild(ms);
      ms.destroy();
    }
    CanvasAnimator._maskSprites.clear();
    CanvasAnimator._maskTextures.clear();
    CanvasAnimator._originalTextures.clear();
    CanvasAnimator._tokenTextures.clear();
    CanvasAnimator._texturePending.clear();
    if (CanvasAnimator._running) CanvasAnimator._refreshCfg();
  }

  static _hasVisemes(tokenId) {
    const t = CanvasAnimator._tokenTextures.get(tokenId);
    return t != null && (t.oo?.valid || t.ah?.valid || t.ee?.valid);
  }

  // Set the rest ("base") scale for swapped frames (closed + visemes) so they
  // render at the on-screen footprint Foundry sized for the original art. The fit
  // is computed ONCE from a single reference texture (the closed frame) and reused
  // for EVERY viseme — so all frames share an identical scale. Per-viseme refitting
  // was the jump: textures of slightly different dims got different scales, and
  // any non-centered content/anchor then shifted the image on each swap.
  static _applySwapFit(s, tokenId) {
    if (!s) return false;
    if (s.swapFitX == null) {
      const t   = CanvasAnimator._tokenTextures.get(tokenId) ?? {};
      const ref = [t.closed, t.oo, t.ah, t.ee].find(x => x?.valid);
      if (!ref?.width || !ref?.height || !s.origTexW || !s.origTexH) return false;
      // Fit-to-footprint ratio, cached. The user shrink (visemeScale) is applied
      // live below so the slider takes effect without re-discovering assets.
      s.swapFitX = s.origScaleX * (s.origTexW / ref.width);
      s.swapFitY = s.origScaleY * (s.origTexH / ref.height);
    }
    s.baseScaleX = s.swapFitX;
    s.baseScaleY = s.swapFitY;
    return true;
  }

  // Fit a swapped (closed/viseme) texture, branching on whether the token uses a
  // Dynamic Token Ring. Ring tokens: the ring shader IS the circular frame and
  // owns subject sizing/anchoring — we only re-run Foundry's mesh resize when the
  // texture changes so the new subject dims are fitted into the ring (visemeScale
  // does not apply; the ring frames the art). Non-ring tokens: scale the bare mesh
  // to the original footprint via the shared swap-fit, pin it dead-centre, and rely
  // on the default circular PIXI mask for roundness.
  static _fitSwapped(token, s, tokenId) {
    if (token.hasDynamicRing) {
      // Ring owns subject sizing + circular framing. Re-fit (Foundry's own resize)
      // only when the texture changes so the new subject dims fit the ring.
      if (s._ringFitTex !== token.mesh.texture) {
        token._refreshMeshSizeAndScale();
        s.baseScaleX = token.mesh.scale.x;
        s.baseScaleY = token.mesh.scale.y;
        s._ringFitTex = token.mesh.texture;
      }
    } else {
      CanvasAnimator._applySwapFit(s, tokenId);
      token.mesh.anchor.set(0.5, 0.5);
      token.mesh.position.x = s.baseX;
    }
  }

  // Discover and cache viseme textures (and optional mask) for a token.
  static async _loadTokenTextures(tokenId, imgPath) {
    CanvasAnimator._texturePending.add(tokenId);

    const textures = await CanvasAnimator._discoverVisemes(imgPath);
    CanvasAnimator._tokenTextures.set(tokenId, textures);

    const maskPath = await CanvasAnimator._findMaskPath(imgPath);
    if (maskPath) {
      try {
        const maskTex = await CanvasAnimator._loadMask(maskPath);
        CanvasAnimator._maskTextures.set(tokenId, maskTex);
      } catch { /* mask load failed — skip silently */ }
    }

    CanvasAnimator._texturePending.delete(tokenId);

    // If shared paths arrived while we were loading (common when animState races
    // ahead of tokenAssets), the load above returned {} — retrigger once using them.
    if (!CanvasAnimator._hasVisemes(tokenId) && CanvasAnimator._sharedPaths.has(imgPath)) {
      CanvasAnimator._tokenTextures.delete(tokenId);
      const t = canvas?.tokens?.placeables?.find(t => t.id === tokenId);
      if (t) _ensureTokenTextures(t);
      return; // the retriggered load will call _applyRestFrame
    }

    // Show the dedicated -closed frame as the silent default the moment assets
    // finish loading — a viseme token must never sit on its base art.
    CanvasAnimator._applyRestFrame(tokenId);
  }

  // Cache the pristine original texture so the tick has a clean reference for the
  // refit ratio (see _applySwapFit). The tick owns actually showing/centering the
  // -closed rest frame — setting the texture here (before the lerp state captures
  // the pristine scale) is what dislocated swapped frames.
  static _applyRestFrame(tokenId) {
    const token = canvas?.tokens?.placeables?.find(t => t.id === tokenId);
    if (!token?.mesh) return;
    if (!CanvasAnimator._originalTextures.has(tokenId)) {
      CanvasAnimator._originalTextures.set(tokenId, token.mesh.texture);
    }
  }

  // Single entry for a SILENT token (selected, or just stopped speaking). Viseme
  // tokens hold the dedicated -closed rest frame (kept in the active set so the
  // tick re-asserts it across Foundry mesh refreshes); simple/none tokens only
  // keep easing back if they were already animating, then detach. `state` is the
  // current audio frame (optional — controlToken passes none).
  static prepareToken(token, state) {
    if (!token?.mesh) return;
    const mode = game.settings.get("live-actors", "mode");
    const visemeMode = mode === "advanced" || mode === "both" || mode === "hybrid";

    if (!visemeMode) {
      // Simple/none: no held closed frame. Only feed the silent state if the token
      // is still animating (easing back after speech) so it settles and detaches.
      if (state && CanvasAnimator._targets.has(token.id)) {
        CanvasAnimator._targets.set(token.id, state);
        CanvasAnimator._wake();
      }
      return;
    }

    if (!CanvasAnimator._tokenTextures.has(token.id) && !CanvasAnimator._texturePending.has(token.id)) {
      _ensureTokenTextures(token);            // discover viseme assets (async)
    } else {
      CanvasAnimator._applyRestFrame(token.id); // instant apply when already cached
    }
    // Hold a silent target so the tick keeps re-asserting the closed rest frame,
    // surviving Foundry's post-selection mesh refreshes. Always silent + hold, so
    // a stale speaking flag (transition out of speech) eases back then settles.
    CanvasAnimator._targets.set(token.id, {
      speaking: false,
      volume:   state?.volume ?? 0,
      viseme:   state?.viseme,
      mode,
      hold:     true,
    });
    CanvasAnimator._wake();
  }

  static async _discoverVisemes(imgPath) {
    // Use paths broadcast by a privileged client so players don't need FilePicker.
    const pre = CanvasAnimator._sharedPaths.get(imgPath);
    if (pre) {
      if (pre.sheet) return CanvasAnimator._loadFlipbook(pre.sheet);
      const textures = {};
      for (const viseme of ["closed", "oo", "ah", "ee"]) {
        if (pre[viseme]) {
          try { textures[viseme] = await foundry.canvas.loadTexture(pre[viseme]); }
          catch { textures[viseme] = null; }
        }
      }
      return textures;
    }

    const lastSlash = imgPath.lastIndexOf("/");
    const folder    = lastSlash >= 0 ? imgPath.slice(0, lastSlash) : "";
    const filename  = lastSlash >= 0 ? imgPath.slice(lastSlash + 1) : imgPath;
    const lastDot   = filename.lastIndexOf(".");
    const base      = lastDot >= 0 ? filename.slice(0, lastDot) : filename;
    const ext       = lastDot >= 0 ? filename.slice(lastDot) : "";

    // Preferred path: directory listing — finds files regardless of case/separator,
    // no failed HTTP probes. Requires FILES_BROWSE permission (GM/assistant).
    // Broadcast discovered paths so remote clients can load them without browsing.
    try {
      const result = await foundry.applications.apps.FilePicker.implementation.browse("data", folder || "/");
      const files = result.files ?? [];

      // Check for flipbook sheet first ({base}-sheet.ext or {base}_sheet.ext)
      const sheetRe = new RegExp(`^${_escapeRegex(base)}[-_]sheet\\.[^.]+$`, "i");
      const sheetFile = files.find(f => sheetRe.test(f.includes("/") ? f.slice(f.lastIndexOf("/") + 1) : f));
      if (sheetFile) {
        game.socket.emit("module.live-actors", { type: "tokenAssets", imgPath, sheet: sheetFile });
        return await CanvasAnimator._loadFlipbook(sheetFile);
      }

      // Individual viseme files — including a dedicated -closed frame so the base
      // token art is never repurposed as the mouth.
      const textures = {};
      const foundPaths = {};
      for (const viseme of ["closed", "oo", "ah", "ee"]) {
        const re = new RegExp(`^${_escapeRegex(base)}[ \\-_]${viseme}\\.[^.]+$`, "i");
        const match = files.find(f => re.test(f.includes("/") ? f.slice(f.lastIndexOf("/") + 1) : f));
        if (match) {
          foundPaths[viseme] = match;
          try { textures[viseme] = await foundry.canvas.loadTexture(match); }
          catch { textures[viseme] = null; }
        }
      }
      if (Object.keys(foundPaths).length > 0)
        game.socket.emit("module.live-actors", { type: "tokenAssets", imgPath, visemes: foundPaths });
      return textures;
    } catch { /* no FILES_BROWSE permission — return empty; paths will arrive via socket */ }

    return {};
  }

  // Build four cropped PIXI.Textures from a 2×2 sprite sheet.
  // Layout: closed=top-left, ah=top-right, ee=bottom-left, oo=bottom-right
  static async _loadFlipbook(sheetPath) {
    // Slice each quadrant onto its OWN canvas → its own PIXI texture, exactly like
    // the talking-head path (which works). Sharing one baseTexture with PIXI frame
    // rectangles tripped over texture resolution / atlas backing, cropping cells
    // off-size and shifting the framing per viseme.
    const url = _route(sheetPath);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url;
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
    const hw = img.naturalWidth  / 2;
    const hh = img.naturalHeight / 2;
    const layout = { closed: [0, 0], ah: [hw, 0], ee: [0, hh], oo: [hw, hh] };
    const out = {};
    for (const [key, [sx, sy]] of Object.entries(layout)) {
      const cv  = document.createElement("canvas");
      cv.width  = hw;
      cv.height = hh;
      cv.getContext("2d").drawImage(img, sx, sy, hw, hh, 0, 0, hw, hh);
      out[key] = PIXI.Texture.from(cv);
    }
    return out;
  }

  // Find the mask sibling file ({base}-mask.ext or {base}_mask.ext).
  // Returns the path string or null.
  static async _findMaskPath(imgPath) {
    const pre = CanvasAnimator._sharedPaths.get(imgPath);
    if (pre?.mask) return pre.mask;

    const lastSlash = imgPath.lastIndexOf("/");
    const folder    = lastSlash >= 0 ? imgPath.slice(0, lastSlash) : "";
    const filename  = lastSlash >= 0 ? imgPath.slice(lastSlash + 1) : imgPath;
    const lastDot   = filename.lastIndexOf(".");
    const base      = lastDot >= 0 ? filename.slice(0, lastDot) : filename;
    const ext       = lastDot >= 0 ? filename.slice(lastDot) : "";

    try {
      const result = await foundry.applications.apps.FilePicker.implementation.browse("data", folder || "/");
      const files = result.files ?? [];
      const re = new RegExp(`^${_escapeRegex(base)}[-_]mask\\.[^.]+$`, "i");
      const match = files.find(f => re.test(f.includes("/") ? f.slice(f.lastIndexOf("/") + 1) : f));
      if (match)
        game.socket.emit("module.live-actors", { type: "tokenAssets", imgPath, mask: match });
      return match ?? null;
    } catch { /* no FILES_BROWSE permission — mask path will arrive via socket */ }

    return null;
  }

  // Load a grayscale mask image and convert luminance → alpha, returning a PIXI.Texture.
  static async _loadMask(path) {
    const url = _route(path);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url;
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
    const cv  = document.createElement("canvas");
    cv.width  = img.naturalWidth;
    cv.height = img.naturalHeight;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, cv.width, cv.height);
    for (let i = 0; i < px.data.length; i += 4) {
      const luma = 0.299 * px.data[i] + 0.587 * px.data[i + 1] + 0.114 * px.data[i + 2];
      px.data[i] = px.data[i + 1] = px.data[i + 2] = 255;
      px.data[i + 3] = Math.round(luma);
    }
    ctx.putImageData(px, 0, 0);
    return PIXI.Texture.from(cv);
  }

  // Restore a token's mesh to neutral and remove it from all tracking maps.
  static cleanupToken(tokenId) {
    const s = CanvasAnimator._lerped.get(tokenId);
    if (s) {
      const token = canvas?.tokens?.placeables?.find(t => t.id === tokenId);
      if (token?.mesh) {
        // Restore the pristine (original-texture) scale — baseScaleX may have been
        // refit to a swapped viseme/closed frame.
        token.mesh.scale.x    = s.origScaleX ?? s.baseScaleX;
        token.mesh.scale.y    = s.origScaleY ?? s.baseScaleY;
        if (s.baseX != null) token.mesh.position.x = s.baseX;
        token.mesh.position.y = s.baseY;
        token.mesh.angle      = 0;
        token.mesh.mask       = null;
      }
      if (token) _restoreTexture(tokenId, token, CanvasAnimator._originalTextures);
      CanvasAnimator._lerped.delete(tokenId);
    }
    // Clean up mask sprite
    const ms = CanvasAnimator._maskSprites.get(tokenId);
    if (ms) {
      ms.parent?.removeChild(ms);
      ms.destroy();
      CanvasAnimator._maskSprites.delete(tokenId);
    }
    CanvasAnimator._maskTextures.delete(tokenId);

    const ov = CanvasAnimator._overlays.get(tokenId);
    if (ov) {
      ov.ring?.destroy();
      ov.bubble?.destroy();
      CanvasAnimator._overlays.delete(tokenId);
    }

    CanvasAnimator._targets.delete(tokenId);
    if (CanvasAnimator._localTokenId === tokenId) CanvasAnimator._localTokenId = null;
  }

  // Clear all animation state — call when the canvas is rebuilt (meshes are already gone).
  static reset() {
    CanvasAnimator._targets.clear();
    CanvasAnimator._lerped.clear();
    CanvasAnimator._originalTextures.clear();
    CanvasAnimator._tokenTextures.clear();
    CanvasAnimator._texturePending.clear();
    CanvasAnimator._maskTextures.clear();
    CanvasAnimator._maskSprites.forEach(ms => { ms.parent?.removeChild(ms); ms.destroy(); });
    CanvasAnimator._maskSprites.clear();
    CanvasAnimator._overlays.forEach(ov => { ov.ring?.destroy(); ov.bubble?.destroy(); });
    CanvasAnimator._overlays.clear();
    CanvasAnimator._localTokenId = null;
    CanvasAnimator._sleep();
  }

  // Returns the token that was targeted so the caller can include its id in the broadcast.
  static applyLocalState(state) {
    const token = _getLocalToken();

    if (!token) {
      if (CanvasAnimator._localTokenId) CanvasAnimator.cleanupToken(CanvasAnimator._localTokenId);
      return null;
    }

    if (CanvasAnimator._localTokenId && CanvasAnimator._localTokenId !== token.id) {
      CanvasAnimator.cleanupToken(CanvasAnimator._localTokenId);
    }

    CanvasAnimator._localTokenId = token.id;

    // Silent → route through prepareToken: viseme tokens hold the -closed rest
    // frame, simple/none ease back if still animating. Never overwrite with a
    // non-hold silent state here (that would wipe the hold and detach).
    if (!state.speaking) {
      CanvasAnimator.prepareToken(token, state);
      return token;
    }

    CanvasAnimator._targets.set(token.id, state);
    const s = CanvasAnimator._lerped.get(token.id);
    if (s) s.settled = false;
    _ensureTokenTextures(token);
    CanvasAnimator._wake();
    return token;
  }

  // tokenId is the canvas placeable id sent in the socket packet — no user→character lookup needed.
  static applyRemoteState(tokenId, state) {
    if (!canvas.ready) return;
    const token = canvas.tokens.placeables.find(t => t.id === tokenId);
    if (!token) return;

    if (!state.speaking) {
      CanvasAnimator.prepareToken(token, state);
      return;
    }

    CanvasAnimator._targets.set(token.id, state);
    const s = CanvasAnimator._lerped.get(token.id);
    if (s) s.settled = false;
    _ensureTokenTextures(token);
    CanvasAnimator._wake();
  }

  static _tick() {
    if (!canvas.ready) return;

    if (!CanvasAnimator._enabled) {
      // Restore every animated mesh to its neutral pose before tearing down,
      // so a token disabled mid-bounce doesn't freeze deformed.
      for (const id of [...CanvasAnimator._lerped.keys()]) CanvasAnimator.cleanupToken(id);
      CanvasAnimator.reset();
      CanvasAnimator._sleep();
      return;
    }

    if (!CanvasAnimator._cfg) CanvasAnimator._refreshCfg();
    const { bounceMax, angleMax, scaleAxis, scaleLow, scaleHigh,
            intensity, scaleTau, indicatorStyle } = CanvasAnimator._cfg;
    const now            = Date.now();
    const delta          = PIXI.Ticker.shared.deltaMS;
    // Framerate-independent smoothing factor for scale (damping → tau → alpha)
    const scaleAlpha     = scaleTau <= 0 ? 1 : 1 - Math.exp(-delta / scaleTau);
    let   waveFrame      = false;   // smooth the shared waveform at most once per frame

    for (const [tokenId, target] of CanvasAnimator._targets) {
      const token = canvas.tokens.placeables.find(t => t.id === tokenId);
      if (!token?.mesh) continue;

      // Resolve effective mode early — needed for the default circular mask below.
      let effectiveMode0 = target.mode;
      if (target.mode === "hybrid") {
        effectiveMode0 = CanvasAnimator._hasVisemes(tokenId) ? "advanced" : "simple";
      } else if (target.mode === "both") {
        effectiveMode0 = CanvasAnimator._hasVisemes(tokenId) ? "both" : "simple";
      }
      const wantsVisemes = effectiveMode0 === "advanced" || effectiveMode0 === "both";

      // Apply pending mask texture (created async, applied here on the render thread)
      if (CanvasAnimator._maskTextures.has(tokenId) && !CanvasAnimator._maskSprites.has(tokenId)) {
        const maskTex = CanvasAnimator._maskTextures.get(tokenId);
        const ms = new PIXI.Sprite(maskTex);
        ms.anchor.set(0.5, 0.5);
        token.mesh.parent?.addChild(ms);
        token.mesh.mask = ms;
        CanvasAnimator._maskSprites.set(tokenId, ms);
        CanvasAnimator._maskTextures.delete(tokenId);
      } else if (wantsVisemes && CanvasAnimator._hasVisemes(tokenId)
                 && !CanvasAnimator._maskSprites.has(tokenId)
                 && !CanvasAnimator._maskTextures.has(tokenId)) {
        // No custom luminance mask — give swapped (square) viseme art a default
        // circular mask so it reads as round. Needed for ring tokens too: the ring
        // shader frames/scales the subject but does NOT crop it to a circle, so an
        // opaque square viseme would show square corners over the ring.
        const g = new PIXI.Graphics();
        g._tsCircle = true;
        token.mesh.parent?.addChild(g);
        token.mesh.mask = g;
        CanvasAnimator._maskSprites.set(tokenId, g);
      }

      let s = CanvasAnimator._lerped.get(tokenId);
      if (!s) {
        const bsx = token.mesh.scale.x;
        const bsy = token.mesh.scale.y;
        // Pristine reference for refitting swapped textures. Read dims from the
        // stored original texture when present so a closed frame applied earlier
        // can't poison the ratio.
        const origTex = CanvasAnimator._originalTextures.get(tokenId);
        const baseTex = origTex?.valid ? origTex : token.mesh.texture;
        s = {
          scaleX: bsx, scaleY: bsy, baseScaleX: bsx, baseScaleY: bsy,
          origScaleX: bsx, origScaleY: bsy,
          origTexW: baseTex?.width || 1, origTexH: baseTex?.height || 1,
          offsetY: 0, angle: 0,
          // Captured once; only recalculated when the document position changes
          // to avoid the compounding-read-what-we-wrote drift.
          baseX: token.mesh.position.x,
          baseY: token.mesh.position.y,
          docX:  token.document.x,
          docY:  token.document.y,
          // Overlay animation state
          ringAlpha: 0, ringScale: 1.0, ringColorUsed: "",
          bubbleAlpha: 0, bubbleHoldMs: 0,
          settled: false,
        };
        CanvasAnimator._lerped.set(tokenId, s);
      } else if (s.docX !== token.document.x || s.docY !== token.document.y) {
        s.baseX = token.mesh.position.x;
        s.baseY = token.mesh.position.y - s.offsetY;
        s.docX  = token.document.x;
        s.docY  = token.document.y;
      }

      const speaking = target.speaking === true;
      // Held viseme tokens stay in the active set at rest only to re-assert the
      // closed texture — they must NOT keep writing scale/position/angle, or they
      // fight Foundry's own mirror/scale handling at idle. Only drive transforms
      // while actually animating (speaking, or easing back to rest).
      const animating = speaking || s.settled === false;
      const vol = target.volume;
      const effectiveVol = Math.min(vol * intensity, 1.0);

      // Effective mode resolved above (effectiveMode0):
      // hybrid → advanced if visemes ready, else simple.
      // both   → visemes + bounce if visemes ready, else simple.
      const effectiveMode = effectiveMode0;
      const doBounce  = effectiveMode === "simple" || effectiveMode === "both";
      const doVisemes = effectiveMode === "advanced" || effectiveMode === "both";

      // Bounce/stretch — only while speaking; otherwise ease back to the rest pose.
      if (doBounce && speaking) {
        // EMA the raw waveform peak once per frame — this is the scale jitter source
        if (!waveFrame) {
          const raw = Math.abs(AudioEngine.getWaveformSample());
          CanvasAnimator._waveSmooth += (raw - CanvasAnimator._waveSmooth) * scaleAlpha;
          waveFrame = true;
        }
        const s0 = Math.max(-1, Math.min(1, CanvasAnimator._waveSmooth * intensity));
        const sf = s0 >= 0
          ? 1.0 + s0 * (scaleHigh - 1.0)
          : 1.0 + s0 * (1.0 - scaleLow);
        const tSX = scaleAxis !== "y" ? s.baseScaleX * sf : s.baseScaleX;
        const tSY = scaleAxis !== "x" ? s.baseScaleY * sf : s.baseScaleY;
        s.scaleX += (tSX - s.scaleX) * scaleAlpha;
        s.scaleY += (tSY - s.scaleY) * scaleAlpha;
        const tOY  = -bounceMax * effectiveVol;
        const tAng = (angleMax > 0 && effectiveVol > 0.02)
          ? Math.sin(now * 0.01) * effectiveVol * angleMax
          : 0;
        s.offsetY += (tOY  - s.offsetY) * LERP;
        s.angle   += (tAng - s.angle)   * LERP;
      } else {
        s.scaleX  += (s.baseScaleX - s.scaleX)  * LERP;
        s.scaleY  += (s.baseScaleY - s.scaleY)  * LERP;
        s.offsetY += (0            - s.offsetY) * LERP;
        s.angle   += (0            - s.angle)   * LERP;
      }

      // Viseme swap — only while speaking. The rest frame (closed image) is set
      // once on settle, below. Guard the assignment so we never re-upload the
      // same texture every frame (the old "pulsing closed image").
      if (doVisemes && speaking) {
        const viseme   = target.viseme ?? "closed";
        const textures = CanvasAnimator._tokenTextures.get(tokenId) ?? {};
        const tex      = textures[viseme];
        if (tex?.valid) {
          if (!CanvasAnimator._originalTextures.has(tokenId)) {
            CanvasAnimator._originalTextures.set(tokenId, token.mesh.texture);
          }
          if (token.mesh.texture !== tex) token.mesh.texture = tex;
        }
      } else if (!doVisemes) {
        _restoreTexture(tokenId, token, CanvasAnimator._originalTextures);
      }

      // A swapped texture (closed/viseme) is sized to the original art's footprint
      // via a single shared fit (identical for every viseme → no jump) and pinned
      // dead-centre (anchor 0.5 + explicit position) so swaps never shift it.
      const swapped = CanvasAnimator._originalTextures.has(tokenId)
                   && token.mesh.texture !== CanvasAnimator._originalTextures.get(tokenId);
      if (swapped) CanvasAnimator._fitSwapped(token, s, tokenId);

      if (animating) {
        token.mesh.scale.x    = s.scaleX;
        token.mesh.scale.y    = s.scaleY;
        token.mesh.position.y = s.baseY + s.offsetY;
        token.mesh.angle      = s.angle;
      } else if (swapped) {
        // Held rest frame on a swapped texture: own the transform so it stays fit
        // & centred — Foundry sized the mesh for the original art.
        token.mesh.scale.set(s.baseScaleX, s.baseScaleY);
        token.mesh.position.y = s.baseY;
        token.mesh.angle      = 0;
      }

      // Keep mask aligned to the (now-updated) mesh. The default circular mask
      // covers the token footprint; a custom luminance mask matches the mesh box.
      const ms = CanvasAnimator._maskSprites.get(tokenId);
      if (ms) {
        ms.position.set(token.mesh.position.x, token.mesh.position.y);
        if (ms._tsCircle) {
          // Frame (mask circle) stays at full token footprint; only the image
          // (mesh) shrinks via visemeScale. Do NOT scale the radius by k.
          const r = Math.min(token.w, token.h) / 2;
          if (ms._tsR !== r) {
            ms.clear();
            ms.beginFill(0xffffff);
            ms.drawCircle(0, 0, r);
            ms.endFill();
            ms._tsR = r;
          }
        } else {
          ms.width  = token.mesh.width;
          ms.height = token.mesh.height;
        }
      }

      // ── Speaking Indicators ──────────────────────────────────────
      const isSpeaking = speaking;
      const cx = token.w / 2;
      const cy = token.h / 2;

      _ensureOverlays(token, tokenId);
      const ov = CanvasAnimator._overlays.get(tokenId);

      if (ov) {
        const showRing   = indicatorStyle === "ring"   || indicatorStyle === "both";
        const showBubble = indicatorStyle === "bubble" || indicatorStyle === "both";

        // Ring — use the player color of whoever owns this token as their character
        if (ov.ring) {
          ov.ring.visible = showRing;
          if (showRing) {
            const owner = game.users.find(u => u.character?.id === token.document.actorId) ?? game.user;
            const ringColorHex = owner.color?.css ?? "#ff6400";
            if (s.ringColorUsed !== ringColorHex) {
              const c = parseInt(ringColorHex.replace("#", ""), 16);
              ov.ring.clear();
              ov.ring.lineStyle(3, c, 1);
              ov.ring.drawCircle(cx, cy, cx + 6);
              s.ringColorUsed = ringColorHex;
            }
            const tA = isSpeaking ? Math.max(0.35, effectiveVol) * 0.85 : 0;
            const tS = isSpeaking ? 1.0 + 0.08 * effectiveVol : 1.0;
            s.ringAlpha += (tA - s.ringAlpha) * 0.15;
            s.ringScale += (tS - s.ringScale) * 0.15;
            ov.ring.alpha = s.ringAlpha;
            ov.ring.scale.set(s.ringScale);
          } else {
            s.ringAlpha = 0; // hidden → don't let it block settle
          }
        }

        // Bubble — fade in on speech, hold 0.8 s after silence, then fade out
        if (ov.bubble) {
          ov.bubble.visible = showBubble;
          if (showBubble) {
            if (isSpeaking) {
              s.bubbleHoldMs = 800;
              s.bubbleAlpha += (1.0 - s.bubbleAlpha) * 0.2;
              if (ov.dotsText) {
                const tick = Math.floor(Date.now() / 280) % 4;
                ov.dotsText.text = ".".repeat(tick);
              }
            } else if (s.bubbleHoldMs > 0) {
              s.bubbleHoldMs -= delta;
            } else {
              s.bubbleAlpha += (0 - s.bubbleAlpha) * 0.1;
            }
            ov.bubble.alpha = s.bubbleAlpha;
          } else {
            s.bubbleAlpha = 0; // hidden → don't let it block settle
          }
        }

      }

      // ── Settle: once silent and back at rest, snap exact, set the static rest
      // frame, and drop this token from the active set. Nothing animates at idle.
      if (!speaking
          && Math.abs(s.scaleX - s.baseScaleX) < 0.001
          && Math.abs(s.scaleY - s.baseScaleY) < 0.001
          && Math.abs(s.offsetY) < 0.05
          && Math.abs(s.angle)   < 0.05
          && s.ringAlpha   < 0.01
          && s.bubbleAlpha < 0.01) {
        // Rest frame FIRST (before snapping scale): dedicated closed image in
        // viseme modes, else original art. Re-asserted every held frame so a
        // Foundry mesh refresh can't strand the token on its base art.
        const closedTex = CanvasAnimator._tokenTextures.get(tokenId)?.closed;
        if (doVisemes && closedTex?.valid) {
          if (!CanvasAnimator._originalTextures.has(tokenId)) {
            CanvasAnimator._originalTextures.set(tokenId, token.mesh.texture);
          }
          if (token.mesh.texture !== closedTex) token.mesh.texture = closedTex;
          // Same shared fit as the speaking visemes so rest matches speech exactly.
          CanvasAnimator._fitSwapped(token, s, tokenId);
        } else {
          _restoreTexture(tokenId, token, CanvasAnimator._originalTextures);
        }

        // First time settling: snap our animation state + transforms exactly to
        // rest, once. A swapped (closed) frame keeps owning its transform every
        // held frame (see the `else if (swapped)` apply branch); the original art
        // path leaves the resting scale/mirror to Foundry.
        if (!s.settled) {
          s.scaleX = s.baseScaleX; s.scaleY = s.baseScaleY;
          s.offsetY = 0; s.angle = 0; s.ringAlpha = 0; s.bubbleAlpha = 0;
          token.mesh.scale.set(s.baseScaleX, s.baseScaleY);
          token.mesh.position.y = s.baseY;
          token.mesh.angle = 0;
          if (ov?.ring)   ov.ring.alpha   = 0;
          if (ov?.bubble) ov.bubble.alpha = 0;
          s.settled = true;
        }
        // Held viseme tokens (selected & silent) stay in the active set so the
        // tick keeps re-asserting the closed frame each frame, surviving Foundry's
        // mesh refreshes. Keep holding while assets are still discovering (first
        // select) so it doesn't sleep before the closed frame exists. Detach only
        // when not held, or when discovery finished with no closed frame to hold
        // (then the token just settles to its base art and sleeps).
        const stillLoading = CanvasAnimator._texturePending.has(tokenId);
        if (!(target.hold && (stillLoading || (doVisemes && closedTex?.valid)))) {
          CanvasAnimator._targets.delete(tokenId);
        }
      }
    }

    // Nothing left to animate → detach the ticker entirely (zero idle cost).
    if (!CanvasAnimator._targets.size) CanvasAnimator._sleep();
  }

}

function _ensureTokenTextures(token) {
  // Only discover/load viseme assets when the token mode actually swaps images.
  // Simple/none never touch the token texture — no file browsing, no 404 probes.
  const mode = game.settings.get("live-actors", "mode");
  if (mode === "simple" || mode === "none") return;

  const id = token.id;
  if (CanvasAnimator._tokenTextures.has(id) || CanvasAnimator._texturePending.has(id)) return;
  const imgPath = token.document.texture.src;
  if (imgPath) CanvasAnimator._loadTokenTextures(id, imgPath);
}

function _escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build a route-aware URL for a data path. Foundry can run behind a route prefix
// (or serve assets from a CDN), so a raw root-relative "/path" drops the prefix
// and 404s on hosted servers. Players take this fetch/Image path (no FILES_BROWSE
// → no route-aware texture loader), so it must mirror Foundry's own routing.
// getRoute() applies the prefix; already-absolute URLs (http/data/blob) pass through.
function _route(path) {
  if (!path) return path;
  if (/^(?:https?:|data:|blob:)/i.test(path) || path.includes("://")) return path;
  return foundry.utils.getRoute(path);
}

function _restoreTexture(tokenId, token, map) {
  if (!map.has(tokenId)) return;
  const orig = map.get(tokenId);
  if (orig?.valid) {
    token.mesh.texture = orig;
    // Dynamic-ring tokens need the ring re-fitted to the restored texture dims.
    if (token.hasDynamicRing) token._refreshMeshSizeAndScale?.();
  }
  map.delete(tokenId);
}

function _ensureOverlays(token, tokenId) {
  if (CanvasAnimator._overlays.has(tokenId)) return;

  const cx = token.w / 2;
  const cy = token.h / 2;

  // Ring — drawn on first tick when color is known; just create the container here
  const ring = new PIXI.Graphics();
  ring.alpha = 0;
  token.addChild(ring);

  // Speech bubble — body + tail traced as ONE silhouette path so the outline
  // wraps the combined shape (no seam line across the tail base).
  const bW = 36, bH = 18, bR = 4;
  const left = -bW / 2, right = bW / 2, top = -bH / 2, bottom = bH / 2;
  const tx = 4, apexY = bottom + 7; // tail half-width + apex depth
  const bubble = new PIXI.Graphics();
  bubble.lineStyle(1, 0x999999, 0.5);
  bubble.beginFill(0xffffff, 0.92);
  bubble.moveTo(left, top + bR);
  bubble.quadraticCurveTo(left, top, left + bR, top);        // top-left corner
  bubble.lineTo(right - bR, top);
  bubble.quadraticCurveTo(right, top, right, top + bR);      // top-right corner
  bubble.lineTo(right, bottom - bR);
  bubble.quadraticCurveTo(right, bottom, right - bR, bottom);// bottom-right corner
  bubble.lineTo(tx, bottom);                                 // into tail
  bubble.lineTo(0, apexY);                                   // tail apex
  bubble.lineTo(-tx, bottom);                                // out of tail
  bubble.lineTo(left + bR, bottom);
  bubble.quadraticCurveTo(left, bottom, left, bottom - bR);  // bottom-left corner
  bubble.closePath();
  bubble.endFill();
  bubble.position.set(cx, -20);
  bubble.alpha = 0;
  token.addChild(bubble);

  const dotsText = new PIXI.Text("···", {
    fontSize: 10,
    fill: 0x444444,
    fontFamily: "sans-serif",
    fontWeight: "bold",
  });
  dotsText.anchor.set(0.5, 0.5);
  dotsText.position.set(0, 1);
  bubble.addChild(dotsText);

  CanvasAnimator._overlays.set(tokenId, { ring, bubble, dotsText });
}

function _getLocalToken() {
  if (!canvas.ready) return null;

  const charId = game.user.character?.id;
  if (charId) return canvas.tokens.placeables.find(t => t.document.actorId === charId) ?? null;

  const pinned = SpeakerWidget.pinnedTokenId;
  if (pinned) {
    const token = canvas.tokens.placeables.find(t => t.id === pinned);
    if (token) return token;
  }

  const controlled = canvas.tokens.controlled;
  if (controlled.length === 1) return controlled[0];

  return null;
}
