// ─────────────────────────────────────────────────────────────────────────────
// Bounce presets — tune these freely.
//
// Each preset is a full snapshot of the 7 "simple animation" params the
// renderers read. Selecting a preset in the config UI copies these values into
// the hidden world-scoped settings (bounceMax, angleMax, scaleAxis, scaleLow,
// scaleHigh, intensity, scaleDamping). Debug mode bypasses presets and lets you
// edit those raw values directly.
//
// Tokens, Talking Heads, and Video tiles have independent preset tables.
//   - Token bounceMax  = pixels of upward offset.
//   - Head  bounceMax  = % of portrait height.
//   - Video bounceMax  = % of tile height (tiles are small — keep values low).
//   - scaleAxis: "xy" (both), "x", or "y".
//   - scaleLow < 1.0 squishes; scaleHigh > 1.0 stretches.
//   - scaleDamping: 0 = raw waveform (jittery), higher = smoother.
//   - intensity: gain on mic volume.
// ─────────────────────────────────────────────────────────────────────────────

export const TOKEN_BOUNCE_PRESETS = {
  // Pulse — gentle heartbeat. Pure scale pulse, no bounce/rotation, very smooth.
  pulse:      { bounceMax: 2,  angleMax: 0,  scaleAxis: "xy", scaleLow: 1.0,  scaleHigh: 1.1, intensity: 2.0, scaleDamping: 0.92 },
  // Bouncy — happy, light wobble, still smooth.
  bouncy:     { bounceMax: 8, angleMax: 2,  scaleAxis: "xy", scaleLow: 1.0,  scaleHigh: 1.10, intensity: 2.0, scaleDamping: 0.88 },
  // Wobbly — more rotation, less bounce.
  wobbly:     { bounceMax: 3,  angleMax: 10, scaleAxis: "xy", scaleLow: 0.96, scaleHigh: 1.15, intensity: 3.0, scaleDamping: 0.85 },
  // Stretchy — elongates in Y.
  stretchy:   { bounceMax: 5,  angleMax: 0,  scaleAxis: "y",  scaleLow: 1.0,  scaleHigh: 1.80, intensity: 2.5, scaleDamping: 0.85 },
  // Toon — bounce + rotation + stretch, smoothed.
  toon:       { bounceMax: 5, angleMax: 12, scaleAxis: "y", scaleLow: 1.0, scaleHigh: 1.4, intensity: 3.4, scaleDamping: 0.88 },
  // Toon Wobble — like Toon but more rotation and a touch snappier.
  toonWobble: { bounceMax: 10, angleMax: 15, scaleAxis: "y", scaleLow: 1.0, scaleHigh: 1.3, intensity: 5.0, scaleDamping: 0.85 },
};

export const HEAD_BOUNCE_PRESETS = {
  // Pulse — gentle heartbeat. Pure scale pulse, no bounce/rotation, very smooth.
  pulse:      { bounceMax: 2,  angleMax: 0,  scaleAxis: "xy", scaleLow: 1.0,  scaleHigh: 1.1, intensity: 2.0, scaleDamping: 0.92 },
  // Bouncy — happy, light wobble, still smooth.
  bouncy:     { bounceMax: 8, angleMax: 2,  scaleAxis: "xy", scaleLow: 1.0,  scaleHigh: 1.10, intensity: 2.0, scaleDamping: 0.88 },
  // Wobbly — more rotation, less bounce.
  wobbly:     { bounceMax: 3,  angleMax: 10, scaleAxis: "xy", scaleLow: 0.96, scaleHigh: 1.15, intensity: 3.0, scaleDamping: 0.85 },
  // Stretchy — elongates in Y.
  stretchy:   { bounceMax: 5,  angleMax: 0,  scaleAxis: "y",  scaleLow: 1.0,  scaleHigh: 1.80, intensity: 2.5, scaleDamping: 0.85 },
  // Toon — bounce + rotation + stretch, smoothed.
  toon:       { bounceMax: 5, angleMax: 12, scaleAxis: "y", scaleLow: 1.0, scaleHigh: 1.4, intensity: 3.4, scaleDamping: 0.88 },
  // Toon Wobble — like Toon but more rotation and a touch snappier.
  toonWobble: { bounceMax: 10, angleMax: 15, scaleAxis: "y", scaleLow: 1.0, scaleHigh: 1.3, intensity: 5.0, scaleDamping: 0.85 },
};

// Video tile presets use the same names as head presets but smaller values —
// AV tiles are fixed-size (default ~300×225 px) so large scale factors and
// big offsets look clunky. Keep scaleHigh ≤ 1.25 and bounceMax ≤ 5 unless
// you deliberately want the portrait to pop well outside the tile bounds
// (which is allowed — overflow: hidden is removed on animated tiles).
export const VIDEO_BOUNCE_PRESETS = {
  // Pulse — gentle heartbeat. Pure scale, no bounce/rotation.
  pulse:      { bounceMax: 1,  angleMax: 0,  scaleAxis: "xy", scaleLow: 1.0,  scaleHigh: 1.05, intensity: 1.5, scaleDamping: 0.92 },
  // Bouncy — subtle bob, very smooth.
  bouncy:     { bounceMax: 3,  angleMax: 1,  scaleAxis: "xy", scaleLow: 1.0,  scaleHigh: 1.06, intensity: 1.5, scaleDamping: 0.88 },
  // Wobbly — more rotation, slight squish.
  wobbly:     { bounceMax: 1,  angleMax: 5,  scaleAxis: "xy", scaleLow: 0.97, scaleHigh: 1.08, intensity: 2.0, scaleDamping: 0.85 },
  // Stretchy — Y elongation, no rotation.
  stretchy:   { bounceMax: 2,  angleMax: 0,  scaleAxis: "y",  scaleLow: 1.0,  scaleHigh: 1.25, intensity: 2.0, scaleDamping: 0.85 },
  // Toon — bounce + gentle tilt + Y stretch.
  toon:       { bounceMax: 3,  angleMax: 5,  scaleAxis: "y",  scaleLow: 1.0,  scaleHigh: 1.18, intensity: 2.5, scaleDamping: 0.88 },
  // Toon Wobble — same shape, snappier and more rotation.
  toonWobble: { bounceMax: 4,  angleMax: 7,  scaleAxis: "y",  scaleLow: 1.0,  scaleHigh: 1.14, intensity: 3.0, scaleDamping: 0.84 },
};

export const BOUNCE_PRESET_OPTIONS = [
  { value: "pulse",    label: "Pulse" },
  { value: "bouncy",   label: "Bouncy" },
  { value: "wobbly",   label: "Wobbly" },
  { value: "stretchy", label: "Stretchy" },
  { value: "toon",     label: "Toon" },
  { value: "toonWobble", label: "Toon Wobble" },
];
