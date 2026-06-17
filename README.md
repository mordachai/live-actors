# Live Actors

[![GitHub Release](https://img.shields.io/github/v/release/mordachai/live-actors?style=flat-square)](https://github.com/mordachai/live-actors/releases/latest)
[![Foundry VTT](https://img.shields.io/badge/Foundry%20VTT-v14%2B-orange?style=flat-square)](https://foundryvtt.com)

Animate your token in real time as you speak. Live Actors listens to your microphone and animates the speaking player's canvas token and/or a floating "Talking Head" portrait. Everything runs peer-to-peer over Foundry's socket — no database writes, no server lag.

---

## Contents

- [Quick Start](#quick-start)
- [Animation Modes](#animation-modes)
- [Two Surfaces: Tokens & Talking Heads](#two-surfaces-tokens--talking-heads)
- [Lip-Sync: Viseme Images](#lip-sync-viseme-images)
  - [Option A — Flipbook Spritesheet](#option-a--flipbook-spritesheet-recommended)
  - [Option B — Individual Files](#option-b--individual-files)
  - [Making Sheets with AI](#making-sheets-with-ai)
- [Luminance Mask](#luminance-mask)
- [Talking Heads](#talking-heads)
- [Avatar Mode](#avatar-mode)
- [Cartoon Outlines (Heads only)](#cartoon-outlines-heads-only)
- [Speaking Indicators](#speaking-indicators)
- [Settings Reference](#settings-reference)
- [Installation](#installation)

---

## Quick Start

1. Enable **Live Actors** in *Module Management*.
2. Open **Module Settings → Live Actors**. Set **Mic Sensitivity** (raise for quiet mics, lower to cut background noise).
3. Open **Token Animation Config** and/or **Talking Heads Config** to pick a mode.
4. For lip-sync, drop viseme images next to your token art (see below). For bounce/wobble, nothing extra is needed.
5. Talk. Your token animates automatically.

> The GM controls all world-level animation settings, so everyone animates the same way. Only **Mic Sensitivity** and **Disable Live Actors** are per-client.

<img width="177" height="533" alt="image" src="https://github.com/user-attachments/assets/6ce63415-6dee-4009-8d06-105283494a8c" />

---

## Animation Modes

Both surfaces (tokens and heads) share the same set of modes:

| Mode | What it does | Needs images? |
| --- | --- | --- |
| **None** | No animation. | No |
| **Simple** | Bounce, wobble and stretch. Goofy or subtle — your call. | No |
| **Advanced** | Lip-sync. Voice → mouth shapes (OO / AH / EE / closed), swaps the image in real time. | Yes (visemes) |
| **Hybrid** | Lip-sync when viseme images exist for that token, bounce/wobble otherwise. Best for mixed worlds. | Optional |
| **Both** | Visemes **and** bounce at the same time. | Yes (visemes) |

The effective mode is decided **per token**: a token with no viseme images in an Advanced/Hybrid/Both world just falls back gracefully (bounce or static).

---

## Three Surfaces: Video, Tokens & Talking Heads

The same voice drives two independent layers. Enable either or both:

- **Tokens** — animates the actual token on the canvas (*Token Animation Config*).
- **Talking Heads** — a floating portrait on screen, dragged into place by the GM (*Talking Heads Config*).

The two have separate mode settings and separate bounce presets — tune them independently.

<img width="489" height="417" alt="image" src="https://github.com/user-attachments/assets/437d0f4a-f5bd-41b5-89d9-3dcabd08daaf" />

---

## Lip-Sync: Viseme Images

***Visemes** = "Visual Phonemes" — the lip/mouth shapes you make when vocalizing.*

Advanced / Hybrid / Both map your voice to four shapes:

| Shape | Sounds like | Example words |
| --- | --- | --- |
| **Closed** | M, B, P, silence | *hm*, *bump*, *lamp* |
| **OO** | OO, W, U | *you*, *moon*, *blue* |
| **AH** | A, O (open) | *father*, *hot*, *calm* |
| **EE** | E, I, EE | *see*, *feel*, *green* |

The module cycles through them live as it hears you — no manual input.

You supply the four shapes in one of two ways.

### Option A — Flipbook Spritesheet (recommended)

One image, sliced into a 2×2 grid automatically. Detected by the `-sheet` suffix.

```text
┌──────────┬──────────┐
│  CLOSED  │    AH    │  ← top row
├──────────┼──────────┤
│    EE    │    OO    │  ← bottom row
└──────────┴──────────┘
```

Place it next to the base token, add `-sheet` before the extension:

```text
Katrina_token.webp           ← base token art
Katrina_token-sheet.webp     ← 2×2 flipbook   ← add this
```

**Build it by hand:**

1. Make four mouth images at the same size, e.g. 256×256 each.
2. New canvas at **double width × double height** (512×512 here).
3. Paste into quadrants: Closed = top-left, AH = top-right, EE = bottom-left, OO = bottom-right.
4. Export `.webp` or `.png`.

> **Tip:** One master portrait? Duplicate the layer four times, edit only the mouth on each, composite into the grid.

### Option B — Individual Files

Base token art stays untouched. Add a dedicated `-closed` frame plus the three open shapes:

```text
Katrina_token.webp           ← token art (untouched)
Katrina_token-closed.webp    ← resting mouth
Katrina_token-OO.webp
Katrina_token-AH.webp
Katrina_token-EE.webp
```

> **Naming:** Use uppercase suffixes (`-OO`, `-AH`, `-EE`, `-closed`). GMs browse directories so any case works, but **players** probe files directly — lowercase suffixes still work but throw harmless 404s in the console.
>
> If no `-closed` file exists, the token's original art is used as the resting frame.

### Making Sheets with AI

Two prompts. First locks the character style, then generates the sheet.

**Prompt 1 — the portrait:**

```text
Portrait of [subject and style] for a tabletop rpg. Square image. Transparent background. No token frame.
```

> ChatGPT handles transparency well; Gemini, Midjourney and Grok often don't.

**Prompt 2 — the sheet:**

```text
From this image create 4 visemes for the mouth in a 2 by 2 spritesheet: Closed (top left), AH (top-right), EE (bottom left), OO (bottom right). Keep same position and same POV, animate only the mouth and do subtle eye animation. No text.
```

After the first character, a quick *"do the same, but now it's a Dwarven Shopkeeper"* gives fast matching results.

**Examples (free ChatGPT):**

Prompt: *Portrait of Elf Female Wizard with white hair, acrylic painting, for a tabletop rpg. Square image. Transparent background. No token frame*

<img width="512" height="512" alt="elf wizard portrait" src="https://github.com/user-attachments/assets/c42e07c4-fbe8-4a0f-936f-f04115be4345" />

Prompt: *From this image create 4 visemes...*

<img width="512" height="512" alt="elf wizard viseme sheet" src="https://github.com/user-attachments/assets/7e1f2858-470e-4444-a4c8-f2d3bd46dea0" />

Prompt: *Keeping the same style make a spritesheet for a Dwarf Fighter armed with a hammer*

<img width="512" height="512" alt="dwarf fighter viseme sheet" src="https://github.com/user-attachments/assets/b4c96bcf-4c6b-4b31-8583-d6db94916916" />

---

## Luminance Mask

A mask clips your token to any shape without pre-cropping every frame. Paint it once; every viseme uses it.

<img width="696" height="360" alt="image" src="https://github.com/user-attachments/assets/5deaec34-c413-4278-835a-1868228763fb" />

**Place it next to the base token, add `-mask`:**

```text
Katrina_token.webp           ← base token
Katrina_token-mask.webp      ← luminance mask   ← add this
```

How it reads brightness:

- **White** (255) → fully visible
- **Black** (0) → transparent
- **Grey** → partial, proportional to brightness

Any greyscale image works — no alpha channel needed.

> **One mask per token. Do NOT make a sheet of masks.** The mask is applied *after* a frame is cropped from the spritesheet.
>
> Uses: round portrait frames, hex silhouettes, vignette fades, any non-rectangular shape.

---

## Talking Heads

A floating speaking portrait on screen. Configure in **Talking Heads Config**.

- **Always Visible** (toggle) — On: portraits stay up always, animate when speaking. Off: a portrait fades in only while that player talks. To disable heads entirely, set **Animation Mode → None**.
- **Portrait Size** — width for viseme/token heads.
- **Keep Aspect Ratio** — preserve natural proportions (avatars always do). Off = square crop, on = tall images.
- **Show Name** / **Name Size** — character name plate below the portrait, with a size multiplier.
- **Portrait Mask** — optional mask image applied to all heads (white = visible).
- **Mirror (per player)** — flip a portrait horizontally so characters face inward. Applies to all viewers.

The **GM** drags each head anywhere on screen. Positions save **per scene** and sync to all players.

> **GM speaking through NPCs:** select any on-canvas token that isn't owned by a player and it becomes the GM's talking head. One at a time.

---

## Avatar Mode

Want a full-body or alternate portrait instead of the token art? Drop an `-avatar` image next to the base token:

```text
Katrina_token.webp           ← token art
Katrina_token-avatar.webp    ← full-body / portrait   ← add this
```

Turn on **Prefer Avatar Image** in *Talking Heads Config*. Each head that has an `-avatar` file uses it; heads without one keep their normal viseme/token pipeline.

<!-- TODO: add avatar example image here -->

Notes:

- An avatar is a **single image — it can't lip-sync.** It follows the world Animation Mode clamped to None/Simple (Simple/Hybrid/Both → bounce, Advanced/None → static).
- **Avatar Size** has its own slider (separate from Portrait Size); avatars always keep their aspect ratio.
- A token with both `-avatar` and visemes uses the avatar (no lip-sync) while Prefer Avatar is on.
- Avatars have their own outline settings (see below).

---

## Cartoon Outlines (Heads only)

Talking Heads can draw a cartoon **silhouette outline** plus a speaking glow in the player's colour. Canvas tokens don't have this.

An outline needs a real alpha shape to trace. Two sources:

- a **Portrait Mask**, or
- **Cutout Portraits** — treat the portrait PNG's own transparency as the shape (drops the circular clip).

Plain rectangular images keep the normal box ring instead.

The config has **two independent outline columns** — both always apply per head:

- **Portrait / Viseme Outline** — for viseme & token heads. Always active.
- **Avatar Outline** — for avatar heads, traced along the avatar PNG's alpha. Dimmed while *Prefer Avatar Image* is off.

Each column has:

- **Outline** (on/off) and **Width** (1–10 px).
- **Player Colour** — On: outline uses each player's colour. Off: use the fixed **Colour** picker below (hidden while Player Colour is on).

---

## Speaking Indicators

Independent indicators for tokens and heads — set each separately:

- **Ring** — coloured circle/border in the speaking user's colour (from *User Configuration*, bottom-left of the canvas).
- **Bubble** — small animated speech bubble above the token/portrait.

So you can have a head fully animate while the token only flashes a ring, etc.

---

## Settings Reference

**Module Settings → Live Actors** (top-level):

<img width="793" height="698" alt="image" src="https://github.com/user-attachments/assets/2caf1ad9-a3d1-4a7f-a422-a708ce0a56b3" />

| Setting | Scope | What it does |
| --- | --- | --- |
| **Mic Sensitivity** | Client | Raise for quiet mics, lower to cut background noise. |
| **Speaker Widget** | World | Adds a GM toolbar button to speak through NPC tokens. |
| **Pause During Encounters** | World | Auto-disable while a combat is active on the scene. |
| **Disable Live Actors** | Client | Kills all mic/animation on this client. For low-end hardware. |
| **Token Animation Config** | World (GM) | Mode, indicator, bounce preset + debug sliders for canvas tokens. |
| **Talking Heads Config** | World (GM) | Heads visibility, size, mask, mode, avatar, outlines, mirror, bounce. |

**Bounce presets vs Debug** (in both config menus): pick a **Preset** for a ready-made bounce feel. Turn on **Debug Mode** to reveal raw sliders (Intensity, Bounce, Wobble, Scale axis/limits/damping) — debug values override the preset. Higher **Damping** = smoother/slower; lower = snappier/wobblier.

---

## Installation

**Via Foundry** (recommended) — paste in *Add-on Modules → Install Module*:

```text
https://github.com/mordachai/live-actors/releases/latest/download/module.json
```

**Manual** — download `module.zip` from the [latest release](https://github.com/mordachai/live-actors/releases/latest) and extract into `Data/modules/`.

---

## License

[MIT](LICENSE)
