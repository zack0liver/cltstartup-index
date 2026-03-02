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
- **ENH-002**: More intelligent search for ambiguous company names (Polymer, Path) — per-company `pulse_query` column override implemented in gas-pulse.gs; user needs to populate for known problem companies

---

## Session 2 — 2026-02-28

### Changes Made

**Pulse feed — algorithm improvements (gas-pulse.gs):**
- Removed `site:{domain}` query — was pulling company's own blog/product pages as "news"
- Added hard requirement: company name must appear in article title or snippet (word-boundary regex) — blocks unrelated Charlotte stories from passing MIN_SCORE
- Raised `MIN_SCORE` from 40 → 50
- Added second query per company targeting CLT local publications: Charlotte Observer, Charlotte Business Journal, QCity Metro, WFAE, WCNC, WBTV, Charlotte Agenda
- Added `CLT_SOURCE` score bonus (+20) for articles from those CLT publications
- Added `pulse_query` column support in `getApprovedCompanies()` — per-company query overrides for ambiguous names (e.g. Path, Polymer)

**Pulse feed — filter bug fix (pulse.html):**
- Company filter chips were broken — `innerText` was returning uppercase text due to CSS `text-transform: uppercase`, making name comparison always fail
- Fixed by adding `data-company` attribute to each chip; `setCompanyFilter()` now compares `el.dataset.company` instead of `el.innerText`

**Pulse CSV URL:**
- `PULSE_SHEET_CSV_URL` in `pulse.html` set to live Google Sheets CSV

### Commits Pushed

| hash | description |
|---|---|
| `e2a40f5` | Connect Pulse feed to live Google Sheet CSV |
| `c887664` | Fix Pulse filters; tighten article scoring algorithm |

### Current State of Pulse Feed
- ~30 clean articles live after re-seed with improved algorithm
- Path company excluded via manual sheet cleanup — needs `pulse_query` override
- FastBreak underrepresented — suspected name mismatch (`FastBreak` vs `FastBreak.ai`) or national coverage without Charlotte mention — needs `pulse_query` override

### Pending — Next Session
1. **Drop Charlotte from primary query** — change default query from `"{name}" Charlotte` to just `"{name}"`. Charlotte was too restrictive; national press covering CLT companies rarely mentions the city. Let scoring handle relevance: CLT_IN_TITLE (+15), CLT_IN_SNIPPET (+8), CLT_SOURCE (+20) already favor local articles. Common-word companies (Path, Polymer) still need `pulse_query` overrides that include Charlotte to stay clean.
2. Add `pulse_query` column to "Live Startups" sheet
3. Set overrides for known problem companies:
   - **Path**: `"Path" Charlotte startup software`
   - **FastBreak**: `"FastBreak.ai" OR "FastBreak" fintech` (drop Charlotte here too — national coverage is the point)
   - **Polymer**: TBD
4. Consider raising `MIN_SCORE` to 55-60 to compensate for broader queries producing more noise
5. Clear Pulse tab data rows, re-run `runPulseFetch()` with updated script (CLT sources + pulse_query support)
6. The updated `gas-pulse.gs` is in the repo but NOT yet pasted into GAS editor — must do in incognito

### Bugs Found
- None new this session

### Enhancements Logged
- **ENH-002**: Per-company `pulse_query` override (partially implemented — code done, sheet column not yet added)

### Pulse — Setup Complete
- GAS script live and connected to Google Sheet (container-bound via Extensions → Apps Script)
- `SOURCE_SHEET_NAME`: `Live Startups`, `PULSE_SHEET_NAME`: `Pulse`
- Daily trigger installed via `setupTrigger()` — runs at 6 AM UTC
- Pulse tab published as CSV → URL pasted into `pulse.html` → live on GitHub Pages
- **Important**: Run GAS script from incognito window — multiple Chrome accounts cause "unknown error"

---

## Session 3 — 2026-03-01

### Changes Made

**Bug fix — mobile card width (index.html):**
- Cards were not fitting mobile viewport width — horizontal overflow caused layout to break on small screens
- Root cause: `<main class="flex-1">` was missing `min-w-0`. In flexbox, flex children default to `min-width: auto`, so the element expanded to fit its widest content (long location chip names like "Dilworth/Myers Park/Montford/Park Rd") rather than constraining to the viewport
- Fix: added `min-w-0` to `<main>` → `<main class="flex-1 min-w-0">`
- Side effect resolved: mobile location chips' `overflow-x-auto` now works correctly since `main` is properly constrained

### Commits Pushed

| hash | description |
|---|---|
| `98a9ed6` | Fix mobile card width: add min-w-0 to main flex child |

### Bugs Found
- None new

### Enhancements Logged
- None
