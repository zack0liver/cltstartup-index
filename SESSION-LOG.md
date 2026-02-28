# CLT Startup Index — Session Log

## Session 1 — 2026-02-28

### Changes Made

**UX & data fixes (index.html):**
- Replaced "View Profile" (coming soon stub) with LinkedIn button — renders only when `r.linkedin` is present, styled `#0A66C2`
- Added funding stage badge on cards between title row and description — renders only when `r.lastfunding` is present
- Hero neighborhood stat now computed dynamically from `buildLocationClusters()` instead of hardcoded "10+"
- Mobile location chip row added above `#activeFilterBanner` — scrollable, hidden on ≥1280px; mirrors sidebar filter behavior on mobile
- Submit modal: added optional Location + LinkedIn fields; both included in POST payload to Google Sheet
- Filter scroll behavior: all `window.scrollTo({ top: 0 })` calls replaced with `window.scrollTo({ top: el.offsetTop })` targeting `#explore` (sticky element — `scrollIntoView` was unreliable)
- `setLocationFilter()` also scrolls to `#explore` on click (sidebar + mobile chips)
- Card buttons renamed: "Visit →" → "Website →", "LinkedIn" → "LinkedIn →"
- "Add your startup" → "Add a startup" in hero
- Submit modal compacted for desktop: reduced padding, inputs tightened, Industry+Website and Location+LinkedIn paired in 2-col grid

**Logo accent color (index.html):**
- Canvas-based logo color extraction replacing static category-based colors
- Approach: load logo via `new Image()` with `crossOrigin='anonymous'`, draw to 48×48 canvas, extract dominant color via HSL hue-bucket algorithm (12 buckets × 30°)
- Weight by saturation only (`w = s`) — dark brand colors (e.g. `#030f59`) count equally to bright ones
- Fallback: `#0a0f1e` (dark) when no confident color found
- Industry label badge restyled to neutral (`var(--muted)` / `var(--bg)` / `var(--border)`) — no more category color coding

**Pulse feature (new page):**
- `pulse.html` — full feed UI: single-column article cards, company filter chips, hero stats (article count, source count, last updated), sticky chip bar, loading/empty states
- `gas-pulse.gs` — standalone GAS news engine:
  - Reads approved companies from directory sheet by header name (resilient to column reordering)
  - Two RSS queries per company: `"{name}" Charlotte` and `"{name}" site:{domain}`
  - Relevance scoring: name in title (+50), snippet (+25), domain in URL (+20), domain in snippet (+10), CLT in title (+15), CLT in snippet (+8), recency bonus (+10/+5)
  - Word-boundary regex for company name matching (prevents "Arc" matching "Monarch")
  - `<link>` element extracted by iterating children — GAS XmlService quirk
  - Deduplication by URL, 1-year article purge, daily trigger via `setupTrigger()`
  - ISO date output with `Utilities.formatDate` for consistent frontend parsing
- Nav: "Pulse" link with animated green dot added to `index.html`; `pulse.html` nav shows "Directory" link back + active Pulse state

**Tracking files created:**
- `BUGS.md` — BUG-001: logo accent color extraction (wrong colors for ~20% of companies)
- `ENHANCEMENTS.md` — ENH-001: Reddit social layer for Pulse feed (deferred)

### Commits Pushed

| hash | description |
|---|---|
| `e9d9610` | UX fixes: LinkedIn button, funding badge, dynamic neighborhood count, mobile location chips, submit form fields |
| `96b5c62` | Fix filter scroll: scroll to search bar instead of page top |
| `f316f51` | Rename card buttons: "Visit →" → "Website →", add arrow to LinkedIn |
| `c14fea8` | Fix filter scroll: use offsetTop instead of scrollIntoView |
| `ece192f` | Card accents from logo dominant color; neutral industry label styling |
| `417654c` | Improve logo color extraction: HSL hue-bucket approach, dark fallback |
| `dae8899` | Hero copy fix + submit modal fits one screen on desktop |
| `bbad0de` | Fix logo color extraction bias against dark brand colors |
| `bbc9841` | Add BUGS.md with BUG-001: logo accent color extraction |
| `357e625` | Add Pulse nav link + placeholder page + ENHANCEMENTS.md |
| `3d4db0b` | Build Pulse feed: full pulse.html UI + gas-pulse.gs news engine |

### Bugs Found
- **BUG-001** (open): Logo accent color extraction still incorrect for ~20% of companies. Known bad cases: Finzly, Rent Ready, Polymer (orange), Battery Exchange, LucidBots (pink), Craftwork (green, should be deep purple), TopBin (should be `#030f59`). Three algorithm iterations attempted — HSL hue-bucket + saturation-only weighting still not resolving all cases. Likely root cause: Clearbit returning placeholder icons for unresolved domains, and/or bright secondary elements outweighing dark brand colors.

### Enhancements Logged
- **ENH-001**: Reddit social layer for Pulse feed — deferred until core news feed is stable

### Pulse — Setup Still Required
The GAS script (`gas-pulse.gs`) is written and in the repo but NOT yet connected to a live Google Sheet. To activate:
1. Open Google Sheet → Extensions → Apps Script → create file `gas-pulse` → paste contents
2. Set `CONFIG.SPREADSHEET_ID` (from Sheet URL)
3. Confirm `CONFIG.SOURCE_SHEET_NAME` matches the startup data tab
4. Run `setupTrigger()` once, then `runPulseFetch()` once to seed
5. Publish Pulse tab as CSV → copy URL → paste into `PULSE_SHEET_CSV_URL` in `pulse.html` → push
