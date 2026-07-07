# Plan: Pulse multi-source pipeline on GitHub Actions

**Status:** Approved, not yet implemented
**Date:** 2026-07-07
**Prerequisite:** Deploy the current gas-pulse.gs update first (see PULSE-EVALUATION.md deployment checklist)

Adds company blog RSS, non-RSS news pages, and SEC EDGAR filings to the Pulse feed at zero
out-of-pocket cost. New sources run in this repo on GitHub Actions rather than Google Apps
Script — testable in Node, no copy-paste deploys, failures turn the workflow red and email
the owner. GAS keeps doing Google News → Pulse sheet, unchanged.

## Architecture

```
Google Sheet (Live Startups tab, gid=0 CSV — already published)
        │  company list + new columns: blog_rss, news_page, sec_cik, pulse_blog_mode
        ▼
GitHub Action (cron, free on public repos)
  scripts/pulse-sources.js  (Node 20, zero dependencies — same pattern as pulse-logic-test.js)
        │  fetches blog RSS / news pages / EDGAR
        ▼
  data/pulse-web.json  (committed to repo, served by GitHub Pages)
        ▼
pulse.html  merges Sheet CSV (Google News via GAS) + pulse-web.json → one feed
```

The Action commits `pulse-web.json` only when content changes; the JSON doubles as its own
state (dedup by URL, prune >365 days).

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

## Sheet-side setup (one-time)

Add optional columns to Live Startups: `blog_rss`, `news_page`, `sec_cik`,
`pulse_blog_mode`. Empty columns mean "Google News only" for that company. They flow
through the already-published CSV automatically.

## Sequencing

1. Scaffold + blog RSS (immediate value, safest)
2. Non-RSS news pages
3. SEC EDGAR
4. Parked: YouTube channel RSS (~20 lines, plugs into the same parser) and the Reddit
   layer (ENH-001) — both slot into this pipeline later.
