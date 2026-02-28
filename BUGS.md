# CLT Startup Index — Bugs

## BUG-001: Logo accent color extraction produces wrong colors for many companies

**Status:** Open
**Reported:** 2026-02-28

### Description
The canvas-based logo color extraction algorithm (`getDominantColor`) frequently picks the wrong accent color for company cards. The left-side card accent strip should reflect the primary brand color of the company logo, but often lands on a secondary or incorrect hue.

### Known Bad Examples
- **TopBin** — should be `#030f59` (dark navy); shows a wrong color
- **Finzly** — shows orange; incorrect
- **Rent Ready** — shows orange; incorrect
- **Polymer** — shows orange; incorrect
- **Battery Exchange** — shows pink; incorrect
- **LucidBots** — shows pink; incorrect
- **Craftwork** — shows green; should be deep purple
- **Rolara** — shows purple; may be incorrect

### What's Been Tried
1. RGB quantization with 51-step buckets — too coarse, hues bleed across buckets
2. HSL hue-bucket approach (12 × 30° buckets), weighted by `s × (0.5 − |l − 0.5|)` — penalized dark brand colors
3. HSL hue-bucket approach weighted by saturation only (`w = s`) — did not fix it

### Likely Root Causes
- Clearbit logos may return a placeholder/default icon when the domain isn't found, skewing color toward that placeholder's hue
- Dark brand colors (e.g. `#030f59`, L≈0.18) are low-lightness and may be losing to brighter secondary elements even with saturation-only weighting
- Logo images may contain prominent non-brand UI chrome (drop shadows, gradients, background fills) that influences the pixel sample

### Notes
- The 48×48 canvas sample size may be too small for logos with fine detail
- CORS failures fall back to category color silently — hard to distinguish from a successful but wrong extraction
- A potential better approach: load the logo at its native size, sample only the center region or edges, or use a clustering algorithm rather than bucketing
