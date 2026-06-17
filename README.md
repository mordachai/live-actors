# Live Actors

[![GitHub Release](https://img.shields.io/github/v/release/mordachai/live-actors?style=flat-square)](https://github.com/mordachai/live-actors/releases/latest)
[![Foundry VTT](https://img.shields.io/badge/Foundry%20VTT-v14%2B-orange?style=flat-square)](https://foundryvtt.com)

Live Actors listens to your microphone and animates the speaking player in real time. It can animate three places at once, each on its own:

- **Token** — the actual token on the canvas.
- **Video** — the A/V camera tile, while your camera is off.
- **Avatar** — a floating "Talking Head" portrait on screen.

Everything runs peer-to-peer over Foundry's socket — no database writes, no server round-trip.

---

## Contents

- [Animation Modes & Places](#animation-modes--places)
- [Speaker Indicators](#speaker-indicators)
- [Viseme Images (lip-sync)](#viseme-images-lip-sync)
- [Settings](#settings)
- [Installation](#installation)
- [License](#license)

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

The effective mode is decided per token: no viseme images in a Lip-Sync/Hybrid/Both world just falls back to bounce or static.

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
- **Prefer Avatar Image** — use a `-avatar` file instead of token art.

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

So if your token art is `Katrina_token.webp`, every extra file is `Katrina_token-<suffix>.webp`, in the **same folder**.

Two ways to supply the four shapes:

**A — Flipbook (recommended):** one image, a 2×2 grid, `-sheet` suffix.

```text
┌──────────┬──────────┐
│  CLOSED  │    AH    │   ← top row
├──────────┼──────────┤
│    EE    │    OO    │   ← bottom row
└──────────┴──────────┘

Katrina_token.webp           ← token art (the discovery name)
Katrina_token-sheet.webp     ← 2×2 flipbook   ← add this
```

**B — Individual files:** four separate images — a dedicated `-closed` resting frame plus the three open shapes.

```text
Katrina_token.webp           ← token art (untouched)
Katrina_token-closed.webp    ← resting mouth (closed)
Katrina_token-AH.webp        ← open A / O
Katrina_token-EE.webp        ← E / I / EE
Katrina_token-OO.webp        ← OO / W / U
```

> Use uppercase suffixes (`-AH`, `-EE`, `-OO`, `-closed`). Lowercase works but players probe files directly and throw harmless 404s. Always include `-closed` — it's the resting mouth between words; without a matching closed frame the mouth pops when speech starts.

**Optional `-mask`** (`Katrina_token-mask.webp`) — a greyscale image; white = visible, black = transparent, grey = partial. Clips the token to any shape. One mask per token (not a sheet of masks); it's applied after a frame is sliced from the sheet.

**Optional `-avatar`** (`Katrina_token-avatar.webp`) — a single full-body / alternate portrait for Talking Heads. Same naming rule: matches the **token** filename. It's one image, so it can't lip-sync (follows None/Simple). Used when *Prefer Avatar Image* is on.

### Making sheets

**Without AI:** four mouth images at the same size, paste into the quadrants (Closed = top-left, AH = top-right, EE = bottom-left, OO = bottom-right), export at double width × height.

**With AI — two prompts.** First locks the style, then builds the sheet:

```
Portrait of [subject and style] for a tabletop rpg. Square image. Transparent background. No token frame.

```

```
From this image create 4 visemes for the mouth in a 2 by 2 spritesheet: Closed (top left), AH (top-right), EE (bottom left), OO (bottom right). Keep same position and same POV, animate only the mouth and do subtle eye animation. No text.

```

> ChatGPT handles transparency best. After the first character, *"do the same, but a Dwarven Shopkeeper"* gives fast matching results.

<!-- TODO: AI viseme example images -->

---



<img width="553" height="282" alt="image" src="https://github.com/user-attachments/assets/3518ca46-255b-4d5a-88b2-d3ceffa4629f" />

---

## Settings

<img width="794" height="694" alt="image" src="https://github.com/user-attachments/assets/49eab535-a286-4aa4-832a-633fa61d8694" />

**Module Settings → Live Actors** (top-level), in panel order:

| Setting | What it does |
| --- | --- |
| **Token Animation Config** | Token mode, indicator, bounce preset, mask. |
| **Talking Heads Config** | Avatar visibility, size, mask, mirror, outline, avatar image, mode, bounce preset. |
| **Video Window Config** | Video tile mode, clean mode, bounce preset. |
| **Mic Sensitivity** | Raise for quiet mics, lower to cut background noise. |
| **Speaker Widget** | GM toolbar button to speak through NPC tokens. Surpass selection. |
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
