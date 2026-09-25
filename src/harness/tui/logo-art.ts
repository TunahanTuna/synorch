/**
 * The Synorch mark (assets/brand/synorch-logo.svg) as a 14 × 14 pixel grid, hand-hinted from the
 * SVG's 14-unit geometry: the conductor diamond (rows 0-2), the lens-shaped core (rows 4-9) between
 * the two worker arcs (rows 3-10), and the result diamond (rows 11-13). One empty pixel separates
 * the shapes so they stay apart at this size. `#` is filled, `.` empty; the renderer tints it with
 * the theme's logo1 → logo2 → logo3 gradient from top to bottom.
 */
export const LOGO_PIXELS: readonly string[] = [
  "......##......",
  ".....####.....",
  "......##......",
  "...##....##...",
  "..##..##..##..",
  ".##..####..##.",
  ".##..####..##.",
  ".##..####..##.",
  ".##..####..##.",
  "..##..##..##..",
  "...##....##...",
  "......##......",
  ".....####.....",
  "......##......",
];
