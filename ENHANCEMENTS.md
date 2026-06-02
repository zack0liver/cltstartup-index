# CLT Startup Index — Enhancements

## ENH-007: Smarter exclusion criteria

The current exclusion model is binary — a row is either flagged `exclude` or it isn't. Improvements to consider:

- **Per-company blocklist** — a `pulse_exclude_keywords` column in the Live Startups sheet; any article whose title contains one of those terms gets dropped at ingest. Useful for companies like "Passport" where specific false-positive topics (travel, immigration) recur.
- **Domain blocklist** — a global list of source domains known to produce junk (aggregator spam, SEO farms). Articles from these domains are rejected regardless of score.
- **Score floor by source type** — require a higher minimum score for non-CLT sources to reduce noise from national publications that loosely mention a company name.
- **UI-side exclusion** — add an "exclude" button on each Pulse card in `pulse.html` that writes back to the sheet via a lightweight GAS web app endpoint (`doPost`), so bad articles can be flagged without opening the sheet.

---

## ENH-006: Stronger deduplication

Current dedup catches identical URLs but misses near-duplicates. Improvements:

- **Title similarity dedup** — detect articles with near-identical titles (same story, different syndication URLs) using a simple token overlap check. Keep the highest-scoring version.
- **Cross-company dedup** — the same article can legitimately appear under multiple companies if it mentions both. Currently `pulse.html` deduplicates by URL client-side, keeping the highest score. A better model: keep one copy per article but tag all companies it covers, so it appears once in "All" but shows up when filtering by either company.
- **Canonical URL normalization** — strip tracking params (`?utm_source=...`) before URL comparison so the same article with different query strings doesn't slip through as two entries.

---

## ENH-005: Easy manual article intake

Streamline adding articles manually to the Pulse sheet so all required fields are filled correctly without looking up the data dictionary. Options:

**Option A — Google Form:** Create a Google Form (Company, Title, URL, Published Date) that writes to a dedicated intake range in the Pulse sheet. GAS auto-populates `score=100`, `source_type=manual`, `fetched=now`, and derives `source` + `source_url` from the URL domain. User fills 4 fields, GAS handles the rest.

**Option B — GAS helper function:** A `addManualArticle(company, title, url, published)` function in the script editor that auto-fills all columns correctly when run with parameters. Less convenient on mobile.

**Option C — Apps Script sidebar/dialog:** A simple HTML form injected into the Sheet UI via `SpreadsheetApp.getUi().showModalDialog()`. One-click from the Sheet without leaving Google Sheets.

**Recommended:** Option A (Google Form) for mobile convenience + Option C (sidebar) for desktop speed.

---

## ENH-004: Automated funding stage updates

Auto-detect and update the `lastfunding` column (values: Pre-seed, Seed, Series A, Series B, Series C, PE Growth, etc.) by scanning Pulse articles for funding-related keywords. A GAS function runs after each `runPulseFetch()` and checks new articles for signals like "raises", "secures", "closes", "funding round", "Series A", "seed round", etc. If a match is found, update the company's `lastfunding` cell in the Live Startups sheet.

**Approach:**
- Regex patterns to detect funding stage and round type from article title/snippet
- Only update if detected stage is newer/higher than current value (e.g. don't overwrite "Series B" with "Seed")
- Log all auto-updates with article URL as source for auditability
- Could also populate a `lastfunding_date` column and `lastfunding_source` URL column for transparency

**Notes:**
- Requires a funding stage ordering/hierarchy to prevent regressions
- Edge case: some articles mention a competitor's funding, not the company's own — context keyword check helps filter this

---

## ENH-003: Manual article submissions tab

Add a `Manual` tab to the Google Sheet (columns: company, title, url, published) as a permanent record for manually found articles. GAS reads this tab on every `runPulseFetch()` run and injects any unrecognized URLs into the Pulse tab with `score = 100`, ensuring they always pass the ≥60 display filter. Manual entries survive Pulse tab re-seeds since the Manual tab is the source of truth.

Implementation: ~20 lines of GAS — `injectManualArticles(pulseSheet, existingUrls)` called at the start of `runPulseFetch()`.

---

## ENH-002: More intelligent search for ambiguous company names

Some company names are common words that produce noisy results even with word-boundary matching (e.g. "Polymer" returns articles about the material, "Path" returns unrelated path/trail articles). Possible approaches:
- Allow per-company search query overrides in the sheet (e.g. a "pulse_query" column)
- Combine company name with a known keyword alias (e.g. `"Polymer" "Charlotte" software`)
- Detect low-signal companies and flag them for manual query tuning

## ENH-001: Reddit layer for Pulse feed

Add Reddit as a social signal source alongside Google News in the Pulse feed.

**Approach:**
- No API key required for basic Reddit search
- Query: `https://www.reddit.com/search.json?q="{CompanyName}"+Charlotte`
- Filter to relevant subreddits: r/Charlotte, r/startups, r/entrepreneur, r/smallbusiness
- Apply same relevance scoring as news articles
- Tag in the feed UI differently from news articles (Reddit icon/pill vs. source logo)

**Notes:**
- Reddit posts tend to be more conversational and community-driven vs. formal news
- Signal-to-noise may be low for smaller/newer companies
- Deferred until core news feed is stable
