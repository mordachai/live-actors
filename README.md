[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/W7W01A1ZN1)

# Live Actors

![Foundry v14](https://img.shields.io/badge/foundry-v14-blue?style=for-the-badge) ![Github All Releases](https://img.shields.io/github/downloads/mordachai/live-actors/total.svg?style=for-the-badge) ![GitHub Release](https://img.shields.io/github/v/release/mordachai/live-actors?display_name=tag&style=for-the-badge&label=Current%20version) 

Live Actors listens to your microphone and animates the speaking player in real time. It can animate three places at once, each on its own:

- **Token** — Animates your actual token on the canvas with lip-sync or just some speech indicators.
- **Video** — Display the lip-sync and/or animation on the Audio/Video camera of Foundry when the camera is off. No need to run audio through Foundry, just let it pick the mic in the browser.
- **Avatar** — a floating "Talking Head" portrait on screen, use this if you don't want to use the camera area.

## Contents

- **[Quickstart](#quickstart)**
- [Animation Modes & Places](#animation-modes--places)
- [Speaker Indicators](#speaker-indicators)
- [Viseme Images (lip-sync)](#viseme-images-lip-sync)
- **[Making the visemes](#making-the-visemes)**
- [Masks & Cartoon Outline](#masks--cartoon-outline)
- [Settings](#settings)
- [Installation](#installation)

---

Everything runs peer-to-peer over Foundry's socket — no database writes, no server round-trip.

## Quickstart

1. **Install & enable** the module, reload the world.
2. **Allow microphone access** when the browser asks — required even if you don't run audio through Foundry. Without it nothing animates.

   <img width="208" alt="mic permission prompt" src="https://github.com/user-attachments/assets/b4ac9eb7-bcd9-4c0f-a9d2-abceddd97b1c" />

3. **On Discord (or any external voice) but running Foundry Audio/Video?** Turn on **Echo Guard** in *Module Settings → Live Actors* (GM, whole table). Mutes everyone's Foundry mic so no one is heard twice. Animation still runs — Live Actors captures the mic itself. GM gets a one-click prompt when Foundry's A/V audio is live.
4. **Pick where to animate** — Token, Video tile, Avatar (Talking Head). Each independent, GM sets the mode per place in *Module Settings → Live Actors*.
5. **Tune Mic Sensitivity** (per client): raise for quiet mics, lower to cut background noise.

### Want lip-sync?

Lip-sync needs viseme images **and** a lip-sync mode:

1. Make the mouth shapes — see [Viseme Images](#viseme-images-lip-sync) and [Making the visemes](#making-the-visemes).
2. Name them off the **token art** filename (`MyToken-sheet.webp` or `-closed/-AH/-EE/-OO`), same folder.
3. Set the place's **Mode** to **Lip-Sync**, **Hybrid**, or **Both** in its config menu.

No viseme images + a lip-sync mode = falls back to bounce or static. **Simple** and **None** never need viseme art.

### Talking Head vs Avatar

Same floating portrait, two image sources:

- **Talking Head (default)** — uses the **token art / viseme images**. Can lip-sync.
- **Avatar** — turn on **Prefer Avatar Image**; uses a single `-avatar` file (full-body or alternate portrait). One image, so **no lip-sync** — follows None/Simple bounce only. Chars without an `-avatar` file fall back to visemes/token art.

---

## Animation Modes & Places

Each place has the same five modes. Pick a mode per place; they are independent.

| Mode | What it does | Needs viseme images? |
| --- | --- | --- |
| **None** | No animation. | No |
| **Simple** | Bounce, wobble, stretch. | No |
| **Lip-Sync** | Voice maps to mouth shapes, swaps the image live. | Yes |
| **Hybrid** | Lip-sync where viseme images exist, bounce otherwise. | Optional |
| **Both** | Visemes **and** bounce together. | Yes |

The effective mode is decided per token: no viseme images in a Lip-Sync/Hybrid/Both setting just falls back to bounce or static.

---

## Speaker Indicators

Set independently per place. You can have the avatar fully animate while the token only flashes a ring.

<img width="525" height="273" alt="image" src="https://github.com/user-attachments/assets/48fce629-fa0f-426f-bd42-9f92d952e7e0" />

- **Ring** — coloured border in the speaking user's colour (set in *User Configuration*).
- **Bubble** — small animated speech bubble above the token/portrait.

Each place has its own config menu and its own bounce preset. Tune them separately.

<table>
<tr>
<th width="33%">Token</th>
<th width="33%">Video</th>
<th width="33%">Avatar (Talking Head)</th>
</tr>
<tr>
<td valign="top">
<img width="310" height="219" alt="image" src="https://github.com/user-attachments/assets/d6702009-d026-4ab8-9530-02777cc61ff0" />
</td>
<td valign="top">
<img width="310" height="219" alt="image" src="https://github.com/user-attachments/assets/14265841-0fbf-44bd-a7b9-d9fdc2bf23dc" />
</td>
<td valign="top">
<img width="310" height="219" alt="image" src="https://github.com/user-attachments/assets/499b07ef-2744-47ae-8988-5dac604ba949" />
</td>
</tr>
<tr>
<td valign="top">

The token on the canvas.

- **Mode** — None / Simple / Lip-Sync / Hybrid / Both.
- **Indicator** — Ring / Bubble (see below).
- **Bounce Preset** — ready-made simple-animation feel.
- **Luminance Mask** — clips the token to a shape (`-mask`).

*Config: Token Animation Config.*

</td>
<td valign="top">

The A/V camera tile, only while the camera feed is off.

- **Mode** — None / Simple / Lip-Sync / Hybrid / Both.
- **Bounce Preset** — separate from the token's.
- **Clean Mode** — hide Foundry's A/V chrome: name, status, controls, volume, border (each toggle, per client).

*Config: Video Window Config. Needs A/V enabled.*

</td>
<td valign="top">

A floating portrait on screen, placed by the GM.

- **Mode** — None / Simple / Lip-Sync / Hybrid / Both.
- **Always Visible** — stay up vs. fade in only while talking.
- **Size**, **Keep Aspect Ratio**, **Show Name** / size.
- **Mirror** (per player) — face inward.
- **Portrait Mask**, **Cartoon Outline** + speaking glow.
- **Prefer Avatar Image** — use a `-avatar` file instead of visemes/token art. Chars without avatar fallback to visemes or just token images if they don't have any.

*Config: Talking Heads Config. GM drags each head; positions save per scene.*

</td>
</tr>
</table>

> The GM owns all world-level animation settings, so everyone animates the same. Only **Mic Sensitivity** and **Disable Live Actors** are per-client.
>
> **GM through NPCs:** select any on-canvas token not owned by a player — it becomes the GM's talking head / video token. One at a time.

---

## Viseme Images (lip-sync)

Watch any cartoon character talk and you'll notice the mouth never draws every letter — it snaps between a handful of poses. Those poses are **visemes** (*visual phonemes*): the few mouth shapes that cover all the sounds of speech. Animators have used this trick for decades, because many sounds look identical on the lips — *p*, *b* and *m* are the same closed mouth — so a whole sentence collapses into just a few drawings, swapped in time with the voice. Your brain fills in the rest.

Live Actors does this automatically. In **Lip-Sync / Hybrid / Both** it listens to your mic and picks the matching shape, frame by frame, while you talk. You supply four drawings; it plays them like a flipbook:

| Shape | Sounds | Example |
| --- | --- | --- |
| **Closed** | M, B, P, silence | *hm*, *bump* |
| **OO** | OO, W, U | *you*, *moon* |
| **AH** | A, O open | *father*, *hot* |
| **EE** | E, I, EE | *see*, *green* |

It's approximate, not a phoneme-perfect transcription — the goal is a believable moving mouth, not subtitles.

### How to name the images

This is the key rule: **the suffixed files must match the filename of the token image** (the image set as the token's art), because the module finds them by looking next to that file. The actor's *portrait* in the sheet can be any image you like — it's not used for discovery.

> So if your token art is **_Katrina_token.webp_** , every extra file is **_Katrina_token-<suffix>.webp_**, in the _same folder_.

Two ways to supply the four shapes. Choose just one per character, but you can use them together in the same game without issues:

**A — Flipbook:** one image, a 2×2 grid, **-sheet** suffix.

Position of the images matters:


```text
┌──────────┬──────────┐
│  CLOSED  │    AH    │   ← top row
├──────────┼──────────┤
│    EE    │    OO    │   ← bottom row
└──────────┴──────────┘

Goblin_token.webp           ← token art (the discovery name)
Goblin_token-sheet.webp     ← 2×2 flipbook   ← add this
```

**B — Individual files:** four separate images — one for each viseme.

**Suffixes**: `-AH`, `-EE`, `-OO`, `-CLOSED`

```text
Katrina_token.webp           ← token art (untouched)
Katrina_token-closed.webp    ← resting mouth (closed)
Katrina_token-AH.webp        ← open A / O
Katrina_token-EE.webp        ← E / I / EE
Katrina_token-OO.webp        ← OO / W / U
```

> **Optional `-mask`** (`Katrina_token-mask.webp`) — a greyscale image; white = visible, black = transparent, grey = partial. Clips the token to any shape. One single mask per token (not a sheet of masks); it's applied after a frame is sliced from the sheet.

> **Optional `-avatar`** (`Katrina_token-avatar.webp`) — a single full-body / alternate portrait for Talking Heads. Same naming rule: matches the **token** filename. It's one image, so it can't lip-sync (follows None/Simple). Used when *Prefer Avatar Image* is on.

---

## Making the visemes

#### Without AI

Four mouth images at the same size, aligned by the eyes and top of the head. If you export as separate images from your preferred application it will be easy to keep them aligned. Software like Character Animator and Unreal Metahuman can give you awesome results using 3D. Or just go crazy and do _Robot Chicken_ / _South Park_ mouths — it's a lot of fun!


---

#### With AI: Use two prompts

Build the **base portrait first**, then feed it back as the input image for the sheet. This two-step flow is what keeps the frames registered: the model edits one fixed face instead of inventing four from scratch, so the eyes, head, and lens don't drift between cells. Examples:

###### CREATION PROMPT: 

_Portrait of **[subject, pose, and style]** for a tabletop rpg. Square image. Fully transparent background (alpha channel, PNG) — no background fill, no shadow on the background. No token frame. No text._

###### SHEET PROMPT:

_From this image, create 4 mouth visemes as a 2×2 sprite sheet on a fully transparent background (alpha PNG): Closed (top-left), AH (top-right), EE (bottom-left), OO (bottom-right). These frames are swapped rapidly in a replacement animation, so they must register pixel-perfectly: keep head size and position, top-of-head line, eye line, nose, camera lens, POV, framing, and lighting IDENTICAL in all four quadrants. Each quadrant exactly equal size, subject centered identically in each cell. Animate only the mouth and chin; eyes near-still (very subtle motion only). No background fill, no shadow on background, no text, no borders, no grid lines._

> **If frames still jitter,** drop the 2×2 sheet and generate each viseme as a separate edit of the same base portrait (`-closed`, `-AH`, `-EE`, `-OO`), changing only the mouth each time. Editing one fixed image locks the geometry far harder than any one-shot grid. The module reads either layout.

After the first character you can keep producing images easily:

###### FOLLOW-UP PROMPT:

_do the same spritesheet, transparent background, same registration, for a **Dwarven Fighter with a warhammer**_

Fast matching results. Try it!

---

## Masks & Cartoon Outline

### Mask: clip the art to a shape

- Luminance stencil (black & white): **white = opaque, black = transparent, grey = partial.**
- **For token usage:** a `-mask` file (`Katrina_token-mask.webp`).
- **For talking heads (same for all):** Talking Heads Config → *Portrait Mask*.
- Two ready-made masks ship in `assets/masks/` (`grunge-1`, `grunge-2`).

### Cartoon Outline (Talking Heads / Avatar only)

- Outline around the silhouette,
- Two independent outlines: **Portrait / Viseme** and **Avatar**.
- You can set the thickness (width) of both independently.
- Player Colour: it will assume the user color defined in Foundry User Configuration for each player. NPCs will pick GM Colour.
- Using a Ring speak indicator will make it glow with the user color when speaking.

---

## Settings

<img width="794" height="694" alt="image" src="https://github.com/user-attachments/assets/49eab535-a286-4aa4-832a-633fa61d8694" />

**Module Settings → Live Actors** (top-level), in panel order:

| Setting | What it does |
| --- | --- |
| **Token Animation Config** | Token mode, indicator, bounce preset, mask. |
| **Talking Heads Config** | Avatar visibility, size, mask, mirror, outline, avatar image, mode, bounce preset. |
| **Video Window Config** | Video tile mode, clean mode, bounce preset. |
| **Echo Guard (External Voice Mode)** | On Discord/another app while running Foundry Audio/Video? Mutes everyone's Foundry mic so no one is heard twice. GM-controlled, table-wide. Animation keeps working. |
| **Mic Sensitivity** | Raise for quiet mics, lower to cut background noise. |
| **Speaker Widget** | GM toolbar button to speak through NPC tokens. Overrides the current token selection. |
| **Pause During Encounters** | Auto-disable while a combat encounter is active on the scene. |
| **Disable Live Actors** | Kills all mic/animation on this client. Per user setting. |

Each config menu has a **Bounce Preset** dropdown — pick a ready-made simple-animation feel. Presets are tuned per place (token / head / video tile).

---

## Installation

**Via Foundry** — paste in *Add-on Modules → Install Module*:

```text
https://github.com/mordachai/live-actors/releases/latest/download/module.json
```

**Manual** — download `module.zip` from the [latest release](https://github.com/mordachai/live-actors/releases/latest) and extract into `Data/modules/`.

---

## License

[MIT](LICENSE)
