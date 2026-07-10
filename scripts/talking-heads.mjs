import { AudioEngine } from "./audio-engine.mjs";
import { browseFolder } from "./asset-cache.mjs";

const SOCKET_EVENT = "module.live-actors";
const LERP = 0.2;

export class TalkingHeads {
  static _container       = null;
  static _heads           = new Map(); // userId → HTMLElement
  // userId → { frame, img } — set at _createHead() build time so _tick() (rAF,
  // per animated head per frame) never runs a querySelector for its two children.
  static _headParts       = new Map();
  static _speakingTimers  = new Map(); // userId → setTimeout id
  static _dragState       = null;
  static _gmPinnedTokenId = null;  // explicit SpeakerWidget pin (local GM only)
  static _gmAutoTokenId   = null;  // broadcast from controlToken (shown on all clients)
  static _headImages      = new Map(); // userId → { closed?, ah?, ee?, oo? } URL strings
  static _imagesPending   = new Set();
  // Images broadcast by a privileged client so players can show visemes without FilePicker.
  // Keyed by userId; values are the same URL-string format as _headImages.
  static _sharedHeadImages = new Map(); // userId → { closed?, oo?, ah?, ee? }
  // Avatar existence broadcast by a privileged client so players don't HEAD-probe
  // (no 404 noise). Keyed by userId → Boolean.
  static _sharedAvatar     = new Map();

  // Animation state
  static _targets         = new Map(); // userId → state { mode, volume, viseme? }
  static _lerped          = new Map(); // userId → { scaleX, scaleY, offsetYPct, angle }
  static _rafId           = null;
  static _enabled         = true;
  static _waveSmooth      = 0;      // EMA of mic waveform peak — smooths head scale
  static _lastTime        = 0;      // prev rAF timestamp, for framerate-independent lerp
  static _cfg             = {};     // settings snapshot taken at wake time (no per-frame gets)
  // Cached settings read on every socket message (update()/_setRestImage()) — refreshed
  // by rebuild() (headMode) and the headIndicatorStyle onChange, not read per-message.
  static _headMode           = "hybrid";
  static _headIndicatorStyle = "none";
  static _rebuildGen         = 0;   // generation counter — guards rebuild() against overlapping runs

  // ── Lifecycle ────────────────────────────────────────────────────

  static setAllIdle() {
    for (const [userId, head] of TalkingHeads._heads) {
      clearTimeout(TalkingHeads._speakingTimers.get(userId));
      TalkingHeads._speakingTimers.delete(userId);
      head.classList.remove("lva-speaking");
      const frame = head.querySelector(".lva-head-frame");
      if (frame) frame.style.transform = "";   // don't freeze mid-bounce
      const img = head.querySelector(".lva-head-img");
      if (img?.dataset.originalSrc) { img.src = img.dataset.originalSrc; img.dataset.curViseme = "__rest__"; }
    }
    TalkingHeads._targets.clear();
    TalkingHeads._lerped.clear();
  }

  // Show/hide every head at once (module enable toggle). Hidden = display:none on
  // the container; animation gating (_enabled) is separate and stops the rAF feed.
  static setHidden(hidden) {
    if (TalkingHeads._container) TalkingHeads._container.style.display = hidden ? "none" : "";
  }

  static init() {
    if (TalkingHeads._container) return;
    const el = document.createElement("div");
    el.id = "lva-talking-heads";
    document.body.appendChild(el);
    TalkingHeads._container = el;
    TalkingHeads.rebuild();
    // rAF starts on demand when a head begins speaking (see _ensureRunning).
  }

  static _ensureRunning() {
    if (TalkingHeads._rafId === null) {
      TalkingHeads._waveSmooth = 0;
      TalkingHeads._lastTime   = 0;
      TalkingHeads._wake();
      TalkingHeads._rafId = requestAnimationFrame(TalkingHeads._tick);
    }
  }

  // Snapshots all world-scoped animation settings once at wake time so the tick
  // never calls game.settings.get() — matches CanvasAnimator/VideoAnimator.
  static _wake() {
    const get = k => game.settings.get("live-actors", k);
    const scaleDamping = get("headScaleDamping");
    TalkingHeads._cfg = {
      headMode:     get("headMode"),
      bounceMax:    get("headBounceMax"),
      angleMax:     get("headAngleMax"),
      scaleAxis:    get("headScaleAxis"),
      scaleHigh:    get("headScaleHigh"),
      intensity:    get("headIntensity"),
      scaleDamping,
      scaleTau:     scaleDamping <= 0 ? 0 : -(1000 / 60) / Math.log(Math.min(scaleDamping, 0.999)),
      mirrorMap:    get("headMirrorMap"),
    };
  }

  static destroy() {
    if (TalkingHeads._rafId !== null) {
      cancelAnimationFrame(TalkingHeads._rafId);
      TalkingHeads._rafId = null;
    }
    TalkingHeads._container?.remove();
    TalkingHeads._container = null;
    TalkingHeads._heads.clear();
    TalkingHeads._headParts.clear();
    TalkingHeads._speakingTimers.forEach(t => clearTimeout(t));
    TalkingHeads._speakingTimers.clear();
    _revokeBlobImages(TalkingHeads._headImages);
    _revokeBlobImages(TalkingHeads._sharedHeadImages);
    TalkingHeads._headImages.clear();
    TalkingHeads._sharedHeadImages.clear();
    TalkingHeads._imagesPending.clear();
    TalkingHeads._targets.clear();
    TalkingHeads._lerped.clear();
  }

  // ── Rebuild ───────────────────────────────────────────────────────

  // Debounced entry point for settings onChange handlers — saving the Talking
  // Heads config fires ~15 onChange callbacks back-to-back; without this each
  // one triggers a full async rebuild, and overlapping runs can interleave
  // clear→await→append into duplicate/orphaned head elements (see rebuild()'s
  // generation guard for the second half of that fix).
  static requestRebuild = foundry.utils.debounce(() => TalkingHeads.rebuild(), 100);

  static async rebuild() {
    // Generation guard: bail after any await if a newer rebuild has since
    // started. Catches races the debounce above can't (e.g. a scene sync
    // landing mid-rebuild alongside a config save).
    const myGen = ++TalkingHeads._rebuildGen;

    const container = TalkingHeads._container;
    if (!container) return;

    TalkingHeads._speakingTimers.forEach(t => clearTimeout(t));
    TalkingHeads._speakingTimers.clear();
    container.innerHTML = "";
    TalkingHeads._heads.clear();
    TalkingHeads._headParts.clear();
    TalkingHeads._targets.clear();
    TalkingHeads._lerped.clear();
    // Revoke blob URLs this rebuild owns exclusively — skip any images object
    // still referenced by _sharedHeadImages (the broadcast cache other clients
    // reuse across rebuilds; see _discoverHeadImages) so it isn't left pointing
    // at revoked URLs.
    for (const [userId, images] of TalkingHeads._headImages) {
      if (images !== TalkingHeads._sharedHeadImages.get(userId)) _revokeImages(images);
    }
    TalkingHeads._headImages.clear();
    TalkingHeads._imagesPending.clear();

    const mode = game.settings.get("live-actors", "talkingHeads");
    container.className = `lva-mode-${mode}`;
    // Refresh the per-message caches used by update()/_setRestImage() so socket
    // handlers never call game.settings.get() 15x/sec per speaker.
    TalkingHeads._headMode           = game.settings.get("live-actors", "headMode");
    TalkingHeads._headIndicatorStyle = game.settings.get("live-actors", "headIndicatorStyle");
    if (TalkingHeads._headMode === "none") return;
    const useAvatar = game.settings.get("live-actors", "headUseAvatar");

    const speakers = TalkingHeads._collectSpeakers();
    const saved    = canvas.scene?.getFlag("live-actors", "headPositions") ?? {};

    // Per-head avatar detection (once, at build): which heads have a "-avatar"
    // sibling. Heads without one fall back to the portrait/viseme pipeline.
    // Socket-first (mirrors viseme discovery): only a privileged client browses the
    // directory, then broadcasts the result; players read the cache — no HEAD probes,
    // no 404 noise. A late-arriving broadcast triggers a rebuild (receiveSharedAvatar).
    if (useAvatar) {
      const canBrowse = game.user.isGM || game.user.role >= CONST.USER_ROLES.ASSISTANT;
      if (canBrowse) {
        await Promise.all(speakers.map(async info => {
          info.hasAvatar = await TalkingHeads._hasAvatarFile(info.img);
          TalkingHeads._sharedAvatar.set(info.userId, info.hasAvatar);
          game.socket.emit(SOCKET_EVENT, { type: "headAvatar", userId: info.userId, hasAvatar: info.hasAvatar });
        }));
      } else {
        speakers.forEach(info => {
          info.hasAvatar = TalkingHeads._sharedAvatar.get(info.userId) === true;
        });
      }
      if (myGen !== TalkingHeads._rebuildGen) return; // superseded during the await
    }

    speakers.forEach((info, idx) => {
      const head = TalkingHeads._createHead(info);
      container.appendChild(head);
      TalkingHeads._heads.set(info.userId, head);

      const pos = _posToPx(saved[info.userId]) ?? _clampToViewport(10, 60 + idx * 110);
      head.style.left = `${pos.x}px`;
      head.style.top  = `${pos.y}px`;
    });
  }

  // Does a "{base}-avatar" sibling exist for this image? Privileged-client only:
  // lists the directory (no 404 noise). Players never call this — they get the
  // result via the headAvatar socket broadcast (see rebuild / receiveSharedAvatar).
  static async _hasAvatarFile(imgPath) {
    const q         = imgPath.indexOf("?");
    const clean     = q >= 0 ? imgPath.slice(0, q) : imgPath;
    const lastSlash = clean.lastIndexOf("/");
    const folder    = lastSlash >= 0 ? clean.slice(0, lastSlash) : "";
    const filename  = lastSlash >= 0 ? clean.slice(lastSlash + 1) : clean;
    const lastDot   = filename.lastIndexOf(".");
    const base      = lastDot >= 0 ? filename.slice(0, lastDot) : filename;

    // Directory listing (shared cache) — matches "-avatar" regardless of extension/case.
    const files = await browseFolder(folder);
    const re = new RegExp(`^${_escRegex(base)}-avatar\\.[^.]+$`, "i");
    return files.some(f => re.test(f.includes("/") ? f.slice(f.lastIndexOf("/") + 1) : f));
  }

  // Receive avatar existence broadcast by a privileged client. Cache it so the next
  // rebuild reads it without probing; if a head already exists and its avatar state
  // changed, rebuild so it picks up the avatar image/outline/aspect pipeline.
  static receiveSharedAvatar(userId, hasAvatar) {
    TalkingHeads._sharedAvatar.set(userId, hasAvatar === true);
    if (!game.settings.get("live-actors", "headUseAvatar")) return;
    const head = TalkingHeads._heads.get(userId);
    if (!head) return;
    // Rebuild only if the head's current render disagrees with the new truth.
    const isAvatarNow = head.classList.contains("lva-head--avatar");
    if (isAvatarNow !== (hasAvatar === true)) TalkingHeads.requestRebuild();
  }

  // ── Speaker list ─────────────────────────────────────────────────

  static _collectSpeakers() {
    const list = [];

    for (const user of game.users) {
      if (!user.active || user.isGM) continue;
      if (!user.character) continue;

      // Prefer the on-canvas token texture so viseme files match
      const token = canvas.ready
        ? canvas.tokens?.placeables?.find(t => t.document.actorId === user.character.id)
        : null;
      const img = token?.document.texture.src ?? user.character.img;

      list.push({ userId: user.id, name: user.character.name, img });
    }

    // GM head: explicit SpeakerWidget pin first, then auto-detected controlled token
    // (auto token is set locally for the GM and broadcast via socket to players)
    const gm = game.users.find(u => u.active && u.isGM);
    if (gm && canvas.ready) {
      const gmTokenId = TalkingHeads._gmPinnedTokenId ?? TalkingHeads._gmAutoTokenId;
      if (gmTokenId) {
        const t = canvas.tokens?.get(gmTokenId);
        if (t) list.push({ userId: gm.id, name: t.document.name, img: t.document.texture.src });
      }
    }

    return list;
  }

  // ── GM token management ──────────────────────────────────────────

  static setGMPin(tokenId) {
    TalkingHeads._gmPinnedTokenId = tokenId;
    TalkingHeads.rebuild();
    // Broadcast so players can also show/hide the GM head
    game.socket.emit(SOCKET_EVENT, {
      type: "gmHead",
      userId: game.user.id,
      tokenId: tokenId ?? null,
    });
  }

  // Called on player clients via socket when GM controls/decontrols a token.
  // Debounced — the GM clicking through tokens fires controlToken rapidly, and
  // each click otherwise triggered a full async rebuild (browse spam + races).
  static setGMAutoToken(tokenId) {
    TalkingHeads._gmAutoTokenId = tokenId ?? null;
    TalkingHeads.requestRebuild();
  }

  // Receive head images broadcast by a privileged client (GM/assistant). Cache them
  // so _discoverHeadImages can use them without probing, and immediately apply to any
  // existing head element (covers the race where headAssets arrives after rebuild).
  static async receiveSharedHeadImages(userId, data) {
    let images;
    if (data.sheet) {
      images = await TalkingHeads._loadFlipbookURLs(data.sheet);
    } else if (data.paths) {
      images = {};
      for (const [viseme, path] of Object.entries(data.paths)) images[viseme] = _route(path);
    }
    if (!images) return;

    TalkingHeads._sharedHeadImages.set(userId, images);
    // If _headImages was already set (empty from a failed probe), overwrite it.
    TalkingHeads._headImages.set(userId, images);
    TalkingHeads._imagesPending.delete(userId);

    const head = TalkingHeads._heads.get(userId);
    if (head && (images.oo || images.ah || images.ee)) {
      head.classList.add("lva-head--has-visemes");
      if (!head.classList.contains("lva-speaking")) TalkingHeads._setRestImage(head, userId);
    }
  }

  // ── DOM creation ─────────────────────────────────────────────────

  // SVG feMorphology outline: dilate the alpha, flood it with `color`, then
  // paint the original portrait back on top → crisp uniform silhouette outline.
  static _outlineSVG(id, width, color) {
    return `<svg class="lva-head-filter" width="0" height="0" aria-hidden="true">`
      + `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">`
      + `<feMorphology in="SourceAlpha" operator="dilate" radius="${width}" result="d"/>`
      + `<feFlood flood-color="${color}" result="c"/>`
      + `<feComposite in="c" in2="d" operator="in" result="o"/>`
      + `<feMerge><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge>`
      + `</filter></svg>`;
  }

  // "{dir}/{base}.ext" → "{dir}/{base}-avatar.ext" (sibling avatar image).
  static _avatarPath(src) {
    const q     = src.indexOf("?");
    const clean = q >= 0 ? src.slice(0, q) : src;
    const slash = clean.lastIndexOf("/");
    const dot   = clean.lastIndexOf(".");
    return dot > slash
      ? `${clean.slice(0, dot)}-avatar${clean.slice(dot)}`
      : `${clean}-avatar`;
  }

  static _createHead(info) {
    // Avatar is per-head: only when the global toggle is on AND this head actually
    // has a "-avatar" sibling (probed in rebuild → info.hasAvatar). Heads without
    // one fall through to the normal portrait/viseme pipeline (the fallback).
    const useAvatar = game.settings.get("live-actors", "headUseAvatar") && info.hasAvatar === true;
    const width     = game.settings.get("live-actors", useAvatar ? "headAvatarWidth" : "headWidth");
    // Avatar always keeps natural aspect; mask is ignored (silhouette comes from
    // the avatar PNG's own alpha when Cutout is on).
    const ratio     = useAvatar ? true : game.settings.get("live-actors", "headAspectRatio");
    const showName  = game.settings.get("live-actors", "showHeadName");
    const nameSize  = game.settings.get("live-actors", "headNameSize");
    const headMask  = useAvatar ? "" : game.settings.get("live-actors", "headMask");
    const cutout    = game.settings.get("live-actors", "headCutout");
    // Avatar and portrait/fallback have independent outline configs.
    const gs = k => game.settings.get("live-actors", k);
    const outlineOn    = useAvatar ? gs("headAvatarOutline")      : gs("headOutline");
    const outlineWidth = useAvatar ? gs("headAvatarOutlineWidth") : gs("headOutlineWidth");
    const outlineAuto  = useAvatar ? gs("headAvatarOutlineAuto")  : gs("headOutlineAuto");
    const outlineColor = useAvatar ? gs("headAvatarOutlineColor") : gs("headOutlineColor");
    // Silhouette mode: outline + alpha-shaped ring need a real alpha source —
    // the mask, (Cutout) the portrait's transparency, or (Avatar) the avatar PNG's.
    const silhouette = outlineOn && (useAvatar || !!headMask || cutout);

    const head = document.createElement("div");
    head.className = "lva-head"
      + (silhouette ? " lva-head--silhouette" : "")
      + (useAvatar ? " lva-head--avatar" : "");
    head.dataset.userId = info.userId;
    head.style.width = `${width}px`;

    // Player colour (also the default outline/ring colour)
    const user = game.users.get(info.userId);
    const hex  = user?.color?.css ?? "#ff6400";
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    head.style.setProperty("--lva-player-color", hex);
    head.style.setProperty("--lva-player-color-glow", `rgba(${r}, ${g}, ${b}, 0.65)`);

    const frame = document.createElement("div");
    frame.className = "lva-head-frame" + (ratio ? " lva-head-frame--ratio" : "");
    frame.style.width = `${width}px`;
    if (!ratio) frame.style.height = `${width}px`;

    if (headMask) {
      const maskUrl = _route(headMask);
      // Remove circular clip so the CSS mask fully controls the portrait shape.
      // Without this, border-radius:50% + overflow:hidden clips to a circle first
      // and the mask can only further subtract from that circle — never reshape it.
      frame.style.borderRadius = "0";
      // Apply as CSS mask — luminance mode so greyscale masks work (white=visible, black=hidden)
      frame.style.maskImage = `url("${maskUrl}")`;
      frame.style.webkitMaskImage = `url("${maskUrl}")`;
      frame.style.maskSize = "cover";
      frame.style.webkitMaskSize = "cover";
      frame.style.maskRepeat = "no-repeat";
      frame.style.webkitMaskRepeat = "no-repeat";
      frame.style.maskPosition = "center";
      frame.style.webkitMaskPosition = "center";
      frame.style.maskMode = "luminance";
    }

    const img = document.createElement("img");
    img.className = "lva-head-img";
    const baseSrc = _route(useAvatar ? TalkingHeads._avatarPath(info.img) : info.img);
    if (useAvatar) {
      // Fall back to the original token/portrait art if no "-avatar" file exists.
      img.addEventListener("error", function onErr() {
        img.removeEventListener("error", onErr);
        img.src = _route(info.img);
        img.dataset.originalSrc = _route(info.img);
      });
    }
    img.src = baseSrc;
    img.dataset.originalSrc = baseSrc;
    img.alt = info.name.replace(/"/g, "&quot;");
    img.draggable = false;

    // Mirror at rest too — the tick only sets this while animating, so without it
    // the head shows unmirrored until first speech, then snaps. Flip from build.
    const mirrorMap = game.settings.get("live-actors", "headMirrorMap");
    if (mirrorMap?.[info.userId] === true) img.style.transform = "scaleX(-1)";

    frame.appendChild(img);

    // Speech bubble — floats above the portrait frame (positioned absolutely)
    const bubble = document.createElement("div");
    bubble.className = "lva-head-bubble";
    const dotsEl = document.createElement("span");
    dotsEl.className = "lva-head-dots";
    dotsEl.textContent = "·";
    bubble.appendChild(dotsEl);
    head.appendChild(bubble);

    if (silhouette) {
      if (!headMask) {
        // Cutout: silhouette comes from the PNG's own alpha — don't clip it to the
        // circular frame, and fit (not crop) so the whole shape stays outlined.
        frame.style.borderRadius = "0";
        frame.style.overflow     = "visible";
        img.style.objectFit      = "contain";
      }
      // Two wrappers above the masked frame so the outline isn't clipped by the
      // mask (filter runs before mask on the same element): glow > outline > frame.
      const glow    = document.createElement("div");
      glow.className = "lva-head-glow";
      const outline = document.createElement("div");
      outline.className = "lva-head-outline";

      const width2  = outlineWidth;
      const color   = outlineAuto ? hex : outlineColor;
      const filterId = `lva-outline-${info.userId}`;
      outline.insertAdjacentHTML("afterbegin", TalkingHeads._outlineSVG(filterId, width2, color));
      outline.style.filter = `url(#${filterId})`;

      outline.appendChild(frame);
      glow.appendChild(outline);
      head.appendChild(glow);
    } else {
      head.appendChild(frame);
    }

    if (showName) {
      const nameEl = document.createElement("div");
      nameEl.className = "lva-head-name";
      nameEl.style.maxWidth = `${width}px`;
      // Scale font proportionally with head width (baseline: 0.72em at 80px), then
      // apply the GM Name Size multiplier.
      nameEl.style.fontSize = `${(Math.max(0.55, (width / 100) * 0.72) * (nameSize || 1)).toFixed(2)}em`;
      nameEl.textContent = info.name;
      head.appendChild(nameEl);
    }

    if (game.user.isGM) {
      head.dataset.draggable = "true";
      head.addEventListener("mousedown", TalkingHeads._onDragStart);
    }

    head.addEventListener("dragstart", e => e.preventDefault());

    // Only discover viseme assets when the head mode actually swaps images.
    // Avatar mode is static-image + bounce only — never visemes.
    const headMode = game.settings.get("live-actors", "headMode");
    if (!useAvatar && (headMode === "advanced" || headMode === "both" || headMode === "hybrid")) {
      TalkingHeads._discoverHeadImages(info.userId, info.img);
    }

    TalkingHeads._headParts.set(info.userId, { frame, img });
    return head;
  }

  // ── Animation tick (rAF) ─────────────────────────────────────────

  static _tick(ts) {
    // All animation params are world-scoped → same values for every client.
    // Snapshotted at wake time (see _wake()) — no per-frame settings reads.
    const cfg = TalkingHeads._cfg;
    const { headMode, bounceMax, angleMax, scaleAxis, scaleHigh, intensity, scaleTau, mirrorMap } = cfg;
    const now          = Date.now();

    // Framerate-independent scale smoothing: tau (hoisted into cfg) → alpha
    const t            = ts ?? performance.now();
    const delta        = TalkingHeads._lastTime ? (t - TalkingHeads._lastTime) : (1000 / 60);
    TalkingHeads._lastTime = t;
    const scaleAlpha   = scaleTau <= 0 ? 1 : 1 - Math.exp(-delta / scaleTau);
    let   waveFrame    = false;

    for (const [userId, target] of TalkingHeads._targets) {
      const head  = TalkingHeads._heads.get(userId);
      const parts = TalkingHeads._headParts.get(userId);
      if (!head || !parts) continue;
      const { frame, img } = parts;

      let s = TalkingHeads._lerped.get(userId);
      if (!s) {
        s = { scaleX: 1, scaleY: 1, offsetYPct: 0, angle: 0 };
        TalkingHeads._lerped.set(userId, s);
      }

      const speaking         = target.speaking === true;
      const vol              = target.volume;
      const effectiveVol     = Math.min(vol * intensity, 1.0);
      const hasVisemes       = head.classList.contains("lva-head--has-visemes");
      const speakerSendsVis  = target.viseme !== undefined;
      const mirrored         = mirrorMap[userId] === true;

      // The asset caps the motion: only viseme heads can lip-sync. Avatar (solo
      // image) and plain token heads have no viseme class → they degrade through
      // the same branches below (simple/hybrid/both → bounce, advanced → static,
      // none → still). So one Motion mode (headMode) drives every head; capability
      // is clamped automatically by hasVisemes.
      let doBounce;
      if (headMode === "none") {
        doBounce = false;
      } else if (headMode === "simple") {
        doBounce = true;
      } else if (headMode === "advanced") {
        doBounce = false;                              // lip-sync where capable, else static
      } else if (headMode === "hybrid") {
        doBounce = !speakerSendsVis || !hasVisemes;    // bounce when no visemes to sync
      } else { // "both"
        doBounce = true;
      }

      // Bounce/stretch only while actively voiced. Gate on real gated volume,
      // not just the `speaking` hold flag — otherwise ambient noise during the
      // silence-hold window (and the ungated waveform scale) jitters the head.
      const voiced = effectiveVol > 0.06;

      if (doBounce && speaking && voiced) {
        // Scale amplitude tracks the sensitivity-gated volume envelope (× intensity)
        // so the Sensitivity slider and Intensity both control how easily you reach
        // peak stretch — no screaming, no dependence on raw mic input gain.
        const s0 = Math.min(1, effectiveVol);
        const sf = 1.0 + s0 * (scaleHigh - 1.0);
        const tSX = scaleAxis !== "y" ? sf : 1.0;
        const tSY = scaleAxis !== "x" ? sf : 1.0;
        s.scaleX += (tSX - s.scaleX) * scaleAlpha;
        s.scaleY += (tSY - s.scaleY) * scaleAlpha;

        const tOY  = bounceMax * effectiveVol;
        const tAng = (angleMax > 0 && effectiveVol > 0.02)
          ? Math.sin(now * 0.01) * effectiveVol * angleMax
          : 0;
        s.offsetYPct += (tOY  - s.offsetYPct) * LERP;
        s.angle      += (tAng - s.angle)       * LERP;
      } else {
        s.scaleX     += (1.0 - s.scaleX)     * LERP;
        s.scaleY     += (1.0 - s.scaleY)     * LERP;
        s.offsetYPct += (0   - s.offsetYPct) * LERP;
        s.angle      += (0   - s.angle)      * LERP;
      }

      // Settle: silent and back at rest → snap, set rest frame, drop from active.
      if (!speaking
          && Math.abs(s.scaleX - 1)     < 0.001
          && Math.abs(s.scaleY - 1)     < 0.001
          && Math.abs(s.offsetYPct)     < 0.05
          && Math.abs(s.angle)          < 0.05) {
        s.scaleX = 1; s.scaleY = 1; s.offsetYPct = 0; s.angle = 0;
        frame.style.transform = "";
        head.classList.remove("lva-speaking");
        TalkingHeads._setRestImage(head, userId);
        TalkingHeads._targets.delete(userId);
        continue;
      }

      frame.style.transform =
        `translateY(-${s.offsetYPct.toFixed(2)}%) ` +
        `scale(${s.scaleX.toFixed(4)}, ${s.scaleY.toFixed(4)}) ` +
        `rotate(${s.angle.toFixed(2)}deg)`;

      // Mirror flips only the image pixel content; frame border/glow stay unaffected
      img.style.transform = mirrored ? "scaleX(-1)" : "";

      // Animate bubble dots when speaking
      if (head.classList.contains("lva-speaking") && head.classList.contains("lva-head--show-bubble")) {
        const dotsEl = head.querySelector(".lva-head-dots");
        if (dotsEl) {
          const tick = Math.floor(now / 280) % 3;
          dotsEl.textContent = tick === 0 ? "·" : tick === 1 ? "··" : "···";
        }
      }
    }

    // Keep going only while heads are still animating; otherwise stop the loop.
    TalkingHeads._rafId = TalkingHeads._targets.size
      ? requestAnimationFrame(TalkingHeads._tick)
      : null;
  }

  // Rest frame: dedicated closed image in viseme modes, else the original portrait.
  static _setRestImage(head, userId) {
    const img = head.querySelector(".lva-head-img");
    if (!img) return;
    if (img.dataset.curViseme === "__rest__") return;
    const headMode     = TalkingHeads._headMode;
    const wantsVisemes = headMode === "advanced" || headMode === "hybrid" || headMode === "both";
    const hasVisemes   = head.classList.contains("lva-head--has-visemes");
    const images       = TalkingHeads._headImages.get(userId);
    const rest = (wantsVisemes && hasVisemes && images?.closed) ? images.closed : img.dataset.originalSrc;
    if (rest) img.src = rest;
    img.dataset.curViseme = "__rest__";
  }

  // ── Animation state update ────────────────────────────────────────

  static update(userId, state) {
    if (!TalkingHeads._enabled) return;
    const head = TalkingHeads._heads.get(userId);
    if (!head) return;

    const speaking = state.speaking === true;

    // Silent and already settled (not in the active set) → nothing to do, stay idle.
    if (!speaking && !TalkingHeads._targets.has(userId)) return;

    // Store for the rAF tick
    TalkingHeads._targets.set(userId, state);

    const headMode     = TalkingHeads._headMode;
    const wantsVisemes = headMode === "advanced" || headMode === "hybrid" || headMode === "both";
    const hasVisemes   = head.classList.contains("lva-head--has-visemes");
    const doVisemes    = wantsVisemes && state.viseme !== undefined && hasVisemes;

    const headIndicator = TalkingHeads._headIndicatorStyle;
    head.classList.toggle("lva-head--show-ring",   headIndicator === "ring"   || headIndicator === "both");
    head.classList.toggle("lva-head--show-bubble", headIndicator === "bubble" || headIndicator === "both");

    if (speaking) {
      head.classList.add("lva-speaking");
      // Viseme swap — guarded by the current frame key so we never reassign the
      // same image every poll.
      if (doVisemes) {
        const img = head.querySelector(".lva-head-img");
        if (img && img.dataset.curViseme !== state.viseme) {
          const images = TalkingHeads._headImages.get(userId);
          const src = images?.[state.viseme] ?? images?.closed ?? img.dataset.originalSrc;
          if (src) { img.src = src; img.dataset.curViseme = state.viseme; }
        }
      }
    } else {
      head.classList.remove("lva-speaking");
    }

    TalkingHeads._ensureRunning();
  }

  // ── Viseme image discovery (URL-based, no PIXI) ──────────────────

  static async _discoverHeadImages(userId, imgPath) {
    if (TalkingHeads._imagesPending.has(userId)) return;
    if (TalkingHeads._headImages.has(userId)) return;

    // Use images broadcast by a privileged client so players don't need FilePicker.
    const pre = TalkingHeads._sharedHeadImages.get(userId);
    if (pre) {
      TalkingHeads._headImages.set(userId, pre);
      const head = TalkingHeads._heads.get(userId);
      if (head && (pre.oo || pre.ah || pre.ee)) {
        head.classList.add("lva-head--has-visemes");
        if (!head.classList.contains("lva-speaking")) TalkingHeads._setRestImage(head, userId);
      }
      return;
    }

    TalkingHeads._imagesPending.add(userId);

    const lastSlash = imgPath.lastIndexOf("/");
    const folder    = lastSlash >= 0 ? imgPath.slice(0, lastSlash) : "";
    const filename  = lastSlash >= 0 ? imgPath.slice(lastSlash + 1) : imgPath;
    const lastDot   = filename.lastIndexOf(".");
    const base      = lastDot >= 0 ? filename.slice(0, lastDot) : filename;

    // GM path: directory listing (shared cache), avoids 404 noise. Players get []
    // (no FILES_BROWSE permission) and wait for the headAssets socket broadcast.
    // Broadcast discovered paths so remote clients can load without browsing.
    const files = await browseFolder(folder);
    let images;

    const sheetRe = new RegExp(`^${_escRegex(base)}[-_]sheet\\.[^.]+$`, "i");
    const sheetFile = files.find(f => sheetRe.test(f.includes("/") ? f.slice(f.lastIndexOf("/") + 1) : f));
    if (sheetFile) {
      game.socket.emit(SOCKET_EVENT, { type: "headAssets", userId, sheet: sheetFile });
      images = await TalkingHeads._loadFlipbookURLs(sheetFile);
    } else {
      images = {};
      const rawPaths = {};
      for (const viseme of ["closed", "oo", "ah", "ee"]) {
        const re = new RegExp(`^${_escRegex(base)}[ \\-_]${viseme}\\.[^.]+$`, "i");
        const match = files.find(f => re.test(f.includes("/") ? f.slice(f.lastIndexOf("/") + 1) : f));
        if (match) {
          images[viseme] = _route(match);
          rawPaths[viseme] = match;
        }
      }
      if (Object.keys(rawPaths).length > 0)
        game.socket.emit(SOCKET_EVENT, { type: "headAssets", userId, paths: rawPaths });
    }

    TalkingHeads._headImages.set(userId, images ?? {});
    TalkingHeads._imagesPending.delete(userId);

    const head = TalkingHeads._heads.get(userId);
    // A lone closed frame is not enough for lip-sync — require a real mouth shape.
    const hasVisemes = images && (images.oo || images.ah || images.ee);
    if (head && hasVisemes) {
      head.classList.add("lva-head--has-visemes");
      // Show the dedicated -closed frame as the silent default the moment assets
      // load — a viseme head must NEVER sit on the raw token art. (Priority:
      // closed > avatar > token; avatar heads skip discovery so keep their image.)
      // Skip while mid-speech so we don't stomp the live viseme swap.
      if (!head.classList.contains("lva-speaking")) TalkingHeads._setRestImage(head, userId);
    }
  }

  // Crop a 2×2 flipbook sheet into four blob-URL images using Canvas 2D. Blob
  // URLs (vs. data URLs) avoid the ~37% base64 memory overhead and are decoded
  // once instead of re-parsed on every img.src swap. Revoked in rebuild()/destroy().
  // Layout matches CanvasAnimator: closed=top-left, ah=top-right, ee=bottom-left, oo=bottom-right
  static async _loadFlipbookURLs(sheetPath) {
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
      const blob = await new Promise(res => cv.toBlob(res));
      result[key] = URL.createObjectURL(blob);
    }
    return result;
  }

  // ── Position management ──────────────────────────────────────────

  // xPct/yPct are fractions of the viewport (0..1) — see _toPct/_posToPx below.
  // Resolved against THIS client's viewport size, so a head is never off-screen
  // regardless of who last dragged it or what resolution they were on.
  static setPosition(userId, xPct, yPct) {
    const head = TalkingHeads._heads.get(userId);
    if (!head) return;
    const { x, y } = _clampToViewport(xPct * window.innerWidth, yPct * window.innerHeight);
    head.style.left = `${x}px`;
    head.style.top  = `${y}px`;
  }

  static syncScene() {
    TalkingHeads.rebuild();
  }

  // ── Drag (GM only) ───────────────────────────────────────────────

  static _onDragStart(e) {
    if (e.button !== 0) return;
    const head   = e.currentTarget;
    TalkingHeads._dragState = {
      el:       head,
      userId:   head.dataset.userId,
      startX:   e.clientX,
      startY:   e.clientY,
      origLeft: head.offsetLeft,
      origTop:  head.offsetTop,
    };
    document.addEventListener("mousemove", TalkingHeads._onDragMove);
    document.addEventListener("mouseup",   TalkingHeads._onDragEnd);
    e.preventDefault();
  }

  static _onDragMove(e) {
    const d = TalkingHeads._dragState;
    if (!d) return;
    const { x, y } = _clampToViewport(d.origLeft + e.clientX - d.startX, d.origTop + e.clientY - d.startY);
    d.el.style.left = `${x}px`;
    d.el.style.top  = `${y}px`;
  }

  static async _onDragEnd(e) {
    document.removeEventListener("mousemove", TalkingHeads._onDragMove);
    document.removeEventListener("mouseup",   TalkingHeads._onDragEnd);
    const d = TalkingHeads._dragState;
    TalkingHeads._dragState = null;
    if (!d) return;

    const clamped     = _clampToViewport(d.origLeft + e.clientX - d.startX, d.origTop + e.clientY - d.startY);
    const { xPct, yPct } = _toPct(clamped.x, clamped.y);

    // Store as viewport-relative percentages, not absolute pixels — a head
    // dragged on the GM's 4K monitor should still land on-screen for a player
    // on a laptop. Migrated from the old {x,y} px format on read (_posToPx).
    const positions = foundry.utils.deepClone(
      canvas.scene?.getFlag("live-actors", "headPositions") ?? {}
    );
    positions[d.userId] = { xPct, yPct };
    await canvas.scene?.setFlag("live-actors", "headPositions", positions);

    game.socket.emit(SOCKET_EVENT, {
      type: "headPosition",
      userId: game.user.id,
      targetUserId: d.userId,
      xPct, yPct,
    });
  }
}

function _escRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Revoke every blob: URL in a single {closed?, oo?, ah?, ee?} images object
// (non-blob entries — routed file paths — are left alone).
function _revokeImages(images) {
  if (!images) return;
  for (const v of Object.values(images)) {
    if (typeof v === "string" && v.startsWith("blob:")) URL.revokeObjectURL(v);
  }
}

function _revokeBlobImages(map) {
  for (const images of map.values()) _revokeImages(images);
}

// ── Head position storage (viewport-relative percentages) ─────────
//
// Positions used to be saved as absolute pixels from the GM's drag, so a head
// dragged on a large monitor could land half off-screen for a player on a
// smaller one. Stored/broadcast as {xPct, yPct} fractions of the viewport
// instead, resolved against each client's own window size.

const HEAD_EDGE_MARGIN = 40; // px of the head kept on-screen at every edge

function _clampToViewport(x, y) {
  const maxX = Math.max(0, window.innerWidth  - HEAD_EDGE_MARGIN);
  const maxY = Math.max(0, window.innerHeight - HEAD_EDGE_MARGIN);
  return {
    x: Math.min(Math.max(x, 0), maxX),
    y: Math.min(Math.max(y, 0), maxY),
  };
}

function _toPct(x, y) {
  return {
    xPct: window.innerWidth  > 0 ? x / window.innerWidth  : 0,
    yPct: window.innerHeight > 0 ? y / window.innerHeight : 0,
  };
}

// Resolves a saved position entry to on-screen px for the CURRENT viewport, or
// null if there's nothing saved. Handles both the new {xPct, yPct} format and
// the legacy {x, y} absolute-px format (migrated by re-clamping into the
// current viewport rather than trusting stale coordinates from an unknown
// screen size).
function _posToPx(pos) {
  if (pos == null) return null;
  if (pos.xPct != null && pos.yPct != null) {
    return _clampToViewport(pos.xPct * window.innerWidth, pos.yPct * window.innerHeight);
  }
  if (pos.x != null && pos.y != null) {
    return _clampToViewport(pos.x, pos.y);
  }
  return null;
}

// Build a route-aware URL for a data path. Foundry can run behind a route prefix
// (or serve assets from a CDN), so a raw root-relative "/path" drops the prefix
// and 404s on hosted servers — both for the player HEAD probes and for the
// <img>/CSS mask URLs. getRoute() applies the prefix; already-absolute URLs
// (http/data/blob) pass through unchanged.
function _route(path) {
  if (!path) return path;
  if (/^(?:https?:|data:|blob:)/i.test(path) || path.includes("://")) return path;
  return foundry.utils.getRoute(path);
}
