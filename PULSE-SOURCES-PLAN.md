# Plan: Pulse multi-source pipeline on GitHub Actions

**Status:** Approved, not yet implemented
**Date:** 2026-07-07
**Prerequisite:** Deploy the current gas-pulse.gs update first (see PULSE-EVALUATION.md deployment checklist)

Migrates the company database from Google Sheets into the repo (Piece 0), then adds company
blog RSS, non-RSS news pages, and SEC EDGAR filings to the Pulse feed at zero out-of-pocket
cost. New sources run in this repo on GitHub Actions rather than Google Apps Script —
testable in Node, no copy-paste deploys, failures turn the workflow red and email the owner.
GAS keeps doing Google News → Pulse sheet, unchanged, until the fetcher is proven.

## Architecture

```
data/companies.json  (canonical company DB in the repo — see Piece 0)
        │  company records + fields: blog_rss, news_page, sec_cik, pulse_blog_mode, pulse_strict…
        ▼
GitHub Action (cron, free on public repos)
  scripts/pulse-sources.js  (Node 20, zero dependencies — same pattern as pulse-logic-test.js)
        │  fetches blog RSS / news pages / EDGAR
        ▼
  data/pulse-web.json  (committed to repo, served by GitHub Pages)
        ▼
pulse.html  merges Google News (via GAS/Pulse tab) + pulse-web.json → one feed
```

The Action commits `pulse-web.json` only when content changes; the JSON doubles as its own
state (dedup by URL, prune >365 days).

> **Migration note:** Piece 0 moves the company database from the Google Sheet into
> `data/companies.json`. Until that lands, the fetcher can read the Sheet's published CSV
> as before — but build it against `companies.json` from the start so the CSV dependency
> never gets baked in.

## Piece 0 — Git as the company database

Replaces the Google Sheet as source of truth for company data. The sheet does three jobs
today — intake inbox, canonical DB, and publish mechanism (CSV) — with no validation, no
history, and an unversioned CSV URL every consumer depends on. At ~700 records, the repo is
a better database.

- **Canonical store**: `data/companies.json` in the repo. `index.html` switches from CSV
  parsing to a JSON fetch (simpler than the current `parseCSV` path). The Actions fetcher
  (Pieces 2–5) reads `companies.json` natively — the published-CSV dependency disappears,
  and `pulse_strict` / `pulse_aliases` / `blog_rss` / `news_page` / `sec_cik` /
  `pulse_blog_mode` become real schema fields instead of loose sheet columns.
- **Change = commit**: full history, diffs, one-click revert; edit via the GitHub web or
  mobile UI. Approving a company = merging a change.
- **CI validation**: an Action validates every change against a JSON schema — required
  fields, URL formats, duplicate-domain detection, valid enum values — so bad data can't
  merge. The guardrail the sheet never had.
- **Submissions without a backend** — two options:
  - **(a, recommended first)** keep the existing GAS `doPost` submit modal as intake; a
    scheduled Action sweeps PENDING sheet rows into draft PRs against `companies.json`.
    Preserves the current submit UX exactly — no visible change for submitters.
  - **(b, later swap)** GitHub Issue Forms (structured YAML form → labeled issue); an Action
    turns an issue labeled `approved` into an auto-PR.
- **Optional later — free CMS UI**: Sveltia CMS or Decap CMS as a static `/admin` page for
  spreadsheet-like form editing on top of the JSON (needs a free OAuth worker, e.g.
  Cloudflare Worker). Deferred — premature on day one; add if hand-editing JSON gets old.
- **Rejected — hosted DB free tiers** (Supabase / Firebase / Airtable): each adds API keys,
  another dashboard, quota ceilings, and free-tier pause/expiry risk, and buys nothing git
  doesn't already give at 700 records.

### Migration path (incremental, nothing breaks)

1. One-time export: sheet → `data/companies.json` + a schema-validation Action.
2. Point `index.html` and the Pulse fetcher at the JSON; the sheet becomes a read-only backup.
3. Keep the GAS submit endpoint as intake, swept into PRs by an Action (or replace with
   Issue Forms).
4. The **Pulse tab** stays in the sheet for now (GAS still writes Google News there); it
   migrates later once the Actions fetcher is proven, at which point Google leaves the
   write path entirely.

## Piece 1 — Actions scaffold

`.github/workflows/pulse.yml`: cron twice daily at odd minutes (e.g. `17 11,23 * * *` —
GitHub delays top-of-hour crons), plus `workflow_dispatch` for manual runs. Steps:
checkout → run unit tests (fail fast) → run fetcher → commit if changed.
`permissions: contents: write`, no secrets needed.

## Piece 2 — Company blog RSS

- New `blog_rss` sheet column; fetcher parses RSS 2.0 and Atom with a small hand-rolled
  zero-dep parser (ported from `parseRSSFeed` in gas-pulse.gs).
- Auto-discovery when the column is empty: fetch the company's website, look for
  `<link rel="alternate" type="application/rss+xml">`, then try common paths
  (`/feed`, `/rss.xml`, `/blog/feed`, `/atom.xml`). Results — including "none found",
  with a 30-day recheck TTL — cached in `data/feed-cache.json` so we don't hammer
  700 sites every run.
- Entries tagged `source_type: blog`, source = "«Company» Blog". No relevance filtering
  (the source IS the company), but newsworthiness tuning applies (Piece 4).

## Piece 3 — News/blog pages without RSS

- New `news_page` column (the /news or /press URL).
- Fetch HTML, extract `<a>` links + anchor text; keep same-domain links with article-like
  slugs and anchor text ≥ ~25 chars (weeds out nav/footer).
- **First run is a silent baseline** — record everything as seen, emit nothing (prevents
  flooding the feed with dozens of old posts). Later runs emit only new links,
  `published` = first-seen date.
- Per-company failures are logged and skipped, never fail the run. This is the brittle
  tier and it's quarantined as such.

## Piece 4 — Newsworthiness tuning

Company blogs mix real news with SEO content. Tuning lives in a committed
`scripts/pulse-config.json`, editable in the GitHub web UI without touching code:

- `blogNewsworthy` title keywords (launch, raises, funding, partner, award, acquisition,
  milestone, opens, expands…) → score **100**, displayed.
- `blogExclude` patterns (how to, guide, tips, top-N listicles, webinar, "what is", "vs.")
  → dropped entirely.
- Neither → score **55**: kept in the JSON but below pulse.html's 60 display threshold,
  so flipping policy later is a one-line threshold change, no refetching.
- Per-company override via `pulse_blog_mode` column: `all` shows every post at 100;
  `newsworthy-only` (default) uses the tiers above.
- `excludeUrls` list in the config — manual kill switch for individual JSON articles
  (the sheet-based exclude column can't reach them).

## Piece 5 — SEC EDGAR filings

Per-company **Atom feeds keyed by CIK**, not name search (zero name-ambiguity — critical
for Path/Polymer):

- New `sec_cik` column. For companies with it set, poll EDGAR's free per-company Atom
  feed filtered to Form D / D/A (a raise, often before press coverage) — reuses the same
  feed parser.
- A one-off `--discover-ciks` helper mode uses EDGAR full-text search (free JSON API,
  needs a User-Agent header per SEC policy) to *suggest* CIKs for company names with an
  NC filter, printed as a report to paste into the sheet. Discovery suggests; the CIK
  column decides — same philosophy as `pulse_aliases`.
- Entries: title like "SEC Form D — «Company» reports new funding round", link to the
  filing index, `source_type: sec`, score 100.

## pulse.html changes

Fetch `data/pulse-web.json` alongside the CSV, merge before the existing URL-dedup, and
add a small source-type badge on cards (Blog / SEC / News). ~30 lines, reusing
`renderCard`/`escHtml` as-is.

## Verification

- `pulse-sources-test.js`: fixture-based unit tests (RSS, Atom, malformed XML, link
  extraction, newsworthiness scoring, EDGAR Atom) — runs in CI before every fetch.
- Live dry-run (`node scripts/pulse-sources.js --dry-run`) against a couple of real feeds
  + EDGAR before the cron ever fires.
- First real run reviewed via the committed JSON diff — a PR-style diff of what entered
  the feed.

## Company-data fields

Once Piece 0 lands, these live as fields on each `companies.json` record (optional per
company; absent means "Google News only" for that source): `blog_rss`, `news_page`,
`sec_cik`, `pulse_blog_mode`, plus the existing `pulse_strict` / `pulse_aliases` /
`pulse_keywords`. Before Piece 0, they're sheet columns flowing through the published CSV.

## Sequencing

0. **Git as the company database** (Piece 0) — export sheet → `data/companies.json`,
   schema-validation Action, repoint `index.html`. Do this first so the fetcher is built
   against JSON, not the CSV.
1. Scaffold + blog RSS (immediate value, safest)
2. Non-RSS news pages
3. SEC EDGAR
4. Parked: YouTube channel RSS (~20 lines, plugs into the same parser) and the Reddit
   layer (ENH-001) — both slot into this pipeline later.

> Piece 0 is a prerequisite for the cleanest build but not a hard blocker: if you'd rather
> ship blog RSS first, the fetcher can read the CSV in the interim and switch to
> `companies.json` when Piece 0 lands.
