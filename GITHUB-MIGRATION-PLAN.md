# GitHub Migration Plan — the self-sufficient Pulse + Directory loop

**Status:** Planned, awaiting greenlight — not yet implemented
**Date:** 2026-07-09
**Executor:** a future Claude (Opus/Sonnet) session; read §7 first
**Supersedes:** Piece 0 of `PULSE-SOURCES-PLAN.md` (multi-source pieces there remain valid, post-migration)

## 0. Mission and definition of done

Migrate `cltstartups.com` off Google Sheets/Apps Script onto a fully GitHub-native system that
runs THE LOOP unattended:

1. **Intake** — public visitors submit new companies from the site.
2. **Approval** — owner approves/rejects with one click; approved companies enter the index.
3. **Newsfeed** — approved companies are automatically swept into the news search.
4. **False-positive control** — unified relevance scoring keeps junk out of the feed.
5. **Dedup** — URL + ≥90% title-similarity dedup, server-side at write time.
6. **Community moderation** — visitors flag irrelevant articles; flags hide locally
   immediately, and globally only after AI-over-threshold sign-off (owner override always).

Constraints: **secure** (no secrets in the browser, least-privilege tokens, spam-resistant),
**fast** (static JSON on GitHub Pages CDN), **$0/month** (only cost: the already-owned domain).

## 1. Target architecture

```
                    ┌──────────────────────────────────────────────────────┐
                    │                    GitHub repo                        │
 visitor ──submit──►│ GAS relay ─issue─► intake.yml ──draft PR──► OWNER MERGE
 (index.html form)  │ (existing                                    │       │
                    │  web app)                                    ▼       │
                    │                                   data/companies.json│
                    │                                              │       │
                    │            pulse-fetch.yml (cron) ◄──────────┘       │
                    │        Google News RSS → unified scoring →           │
                    │        dedup → exclusions filter → data/pulse.json   │
                    │                                              │       │
 visitor ◄──reads───│ GitHub Pages (index.html / pulse.html) ◄─────┘       │
    │               │                                                      │
    └──flag article─► GAS relay ─issue─► flags.yml → data/flags.json       │
                    │        moderate.yml: threshold + GitHub Models AI    │
                    │        → data/exclusions.json OR needs_review issue  │
                    └──────────────────────────────────────────────────────┘
```

Data files (all committed, all served by Pages):
- `data/companies.json` — canonical company DB (replaces Live Startups sheet)
- `data/companies.schema.json` — JSON schema; CI-enforced on every change
- `data/pulse.json` — article feed (replaces Pulse sheet), includes `lastRun` heartbeat
- `data/flags.json` — community flag queue (url → {count, firstFlagged, lastFlagged})
- `data/exclusions.json` — excluded article URLs with reason + decider (ai|owner) + timestamp

## 2. Key design decisions (rationale for the executor)

- **Public-write proxy = the existing Google Apps Script web app, repurposed as a thin relay**
  (owner decision 2026-07-09: no new accounts). Browsers can't hold GitHub tokens; the GAS
  `doPost` holds a **fine-grained PAT scoped to this one repo with `issues: write` ONLY**
  (stored in Script Properties, never sent to the browser). It forwards validated submissions
  and article flags to GitHub as labeled issues — it no longer writes to any sheet. Worst-case
  token leak = someone can open issues on a public repo (already possible with any GitHub
  account). All real writes happen inside Actions via the ephemeral `GITHUB_TOKEN`.
  - Spam control without a CAPTCHA (GAS can't run Turnstile and doesn't expose client IPs):
    honeypot form field + minimum-time-to-submit check + global rate cap via `CacheService`
    (e.g. max N submissions/hour, excess → 429) + everything lands as *issues*, which are
    inert until the owner merges. Flags additionally require multi-day thresholds (Phase 4).
  - **Documented upgrade path:** if spam ever becomes real, swap the relay for a Cloudflare
    Worker + Turnstile (free) — the GitHub side (issues → Actions) is identical, so it's a
    drop-in replacement with no pipeline changes.
- **GitHub Issues as the intake queue** — free, auditable, has a mobile-friendly UI, and
  labels drive Actions. Approval gate = merging an auto-generated draft PR; only the owner can
  merge. Reject = close the issue.
- **AI reviewer = GitHub Models** (free tier, callable in Actions with `GITHUB_TOKEN`, e.g.
  `gpt-4o-mini`) for flag adjudication and (later) relevance assist. Keeps AI inside GitHub,
  $0, rate limits fine at this volume (dozens of calls/day max).
- **Relevance redesign is folded into the Node port** (don't port the two-system GAS logic
  only to redesign later): single `computeRelevanceScore()` per the accepted proposal —
  weighted signals + `GENERIC_NAME_PENALTY` (replaces binary strict gates) +
  `ALIAS_MATCH`/`PHRASE_KEYWORD` bonuses + `NEGATIVE_KEYWORD` (per-company
  `pulse_exclude_keywords`). Calibrate weights so the full `pulse-logic-test.js` FP/TP suite
  (16 cases) still passes — that suite is the regression baseline for the migration.
- **JSON-in-repo scales fine**: measured ≈863 KB for 2,000 companies, ≈1.5 MB for 5,000
  articles — well within Pages norms; note future option to split/paginate if ever needed.
- **Commit-if-changed + `concurrency` groups** on all writer workflows so parallel runs never
  race; flags writer serialized in its own group.

## 3. Free-tier audit

| Component | Service | Free limit | Our usage |
|---|---|---|---|
| Hosting | GitHub Pages (public repo) | 100 GB/mo soft | site + ~2 MB JSON |
| Compute | GitHub Actions (public repo) | unlimited minutes | ~30–60 min/day |
| Intake/flag relay | Google Apps Script web app (existing) | 20k URL fetches/day | dozens/day |
| AI review | GitHub Models | free tier RPD | dozens/day |
| News source | Google News RSS | unmetered (unofficial) | ~2k req/day |
| **Total** | | | **$0/month** |

## 4. Risks (executor: read before Phase 0)

1. **Google News RSS from shared Actions-runner IPs** may be rate-limited/captcha'd — the #1
   migration risk and why Phase 0 exists. Mitigations in order: keep per-request sleeps
   (existing `SLEEP_MS` pattern), stagger crons, batch like today; if blocked → Plan B: GAS
   remains the *fetch executor only* but commits `pulse.json` to the repo via GitHub API
   instead of writing a sheet (loop shape preserved, Google only in fetch path).
2. **Spam/abuse through the GAS relay** (no CAPTCHA, no client-IP visibility) — mitigated by
   honeypot + min-time check + global CacheService rate cap, plus the structural backstop:
   relay output is only *issues*, inert until owner action; flags only matter past
   multi-day thresholds. If pressure appears, upgrade path = Cloudflare Worker + Turnstile
   (drop-in, §2).
3. **Flag abuse** — mitigated by design (flags are suggestions; localStorage dedupe; global
   rate cap; AI + threshold before global effect; audit trail in exclusions.json).
4. **PAT expiry** — fine-grained PATs max 1 year; document rotation in the runbook (paste new
   PAT into GAS Script Properties); add a monthly scheduled canary workflow that opens+closes
   a test issue via the relay and fails loudly if intake is broken.
5. **Prompt-injection via flagged article text** — AI moderation prompt must treat
   title/snippet as untrusted data (delimit, instruct model to ignore instructions inside),
   and output is constrained to strict JSON parsed defensively; low blast radius anyway
   (worst case: wrong exclude, owner can revert via exclusions.json history).

## 5. Phases

### Phase 0 — Feasibility spike (go/no-go, ~1 hr)
- Manual `workflow_dispatch` workflow that runs the Google News fetch for ~25 companies from
  a runner, logs status codes + article counts, compares to known-good output.
- **Gate:** normal RSS responses → proceed. Blocked → apply risk-1 mitigations, retest.
- Files: `.github/workflows/spike-rss.yml` (delete after Phase 2), `scripts/spike-rss.js`.

### Phase 1 — Data layer (companies.json + pulse.json)
- `data/companies.schema.json`: required title/category/status/link; enums for status and
  pulse_strict; URL formats; uniqueness of (lowercased) domain and title.
- `scripts/validate-companies.js` (zero-dep) + `.github/workflows/validate-data.yml` on any
  PR/push touching `data/` — bad data physically can't merge.
- `scripts/import-from-sheet.js`: one-time import run **in an Action** (runners have open
  egress; the dev sandbox does not) fetching both published CSVs (gid=0 directory,
  gid=961610690 pulse) → `data/companies.json` + seed `data/pulse.json`. Manual review of the
  diff, then merge.
- Point `index.html` + `pulse.html` at the JSON files (simpler than current CSV parsing;
  keep company→ecosystem join logic, now trivial since categories ride along).
- Acceptance: site renders identically from JSON; validation workflow red on a seeded bad
  record in a test PR.

### Phase 2 — Fetch pipeline (replaces GAS runPulseFetch)
- `scripts/pulse-fetch.js`: Node port of gas-pulse.gs with the **unified relevance model**
  (see §2). Sources pluggable (Google News now; blog RSS/EDGAR from PULSE-SOURCES-PLAN.md
  slot in later). Reuse `dedupeByTitle` from `assets/filters.js` (already Node-exportable)
  for write-time title dedup; URL dedup; 365-day purge; respects `data/exclusions.json`;
  writes `lastRun` + per-run stats into `pulse.json`.
- Tests: extend `pulse-logic-test.js` — all 16 existing FP/TP cases must pass under the
  unified score, plus new cases: exclude-keyword kill, generic-name penalty, exclusions-file
  filtering. Tests run first in the workflow; fetch aborts on red.
- `.github/workflows/pulse-fetch.yml`: cron 3×/day at odd minutes (e.g. `23 5,13,21 * * *`),
  `workflow_dispatch`, concurrency group, commit-if-changed.
- `pulse.html`: staleness banner when `lastRun` > 36 h old (heartbeat surfaced to users).
- Acceptance: two consecutive scheduled runs commit sensible diffs; suite green; a seeded
  duplicate + a seeded excluded URL never appear in pulse.json.
- **Parallel-run**: leave GAS trigger on during this phase; compare outputs for ~1 week.

### Phase 3 — Intake (GAS doPost repurposed: sheet writer → GitHub relay)
- Rewrite the GAS web app `doPost` (new file `gas-relay.gs`, versioned in the repo; replaces
  the sheet-append behavior): validate/sanitize fields (lengths, URL shape, allowlisted keys
  only) → honeypot + min-time + CacheService global rate cap → create GitHub issue labeled
  `submission` with JSON payload in body via GitHub API (fine-grained PAT in Script
  Properties: issues:write, this repo only). Redeploy the web app (same URL, so `index.html`
  needs no change — verify; otherwise update `APPS_SCRIPT_URL`).
- `.github/workflows/intake.yml` (on issues labeled `submission`): parse + schema-validate +
  duplicate-domain check → comment a human-readable preview → open **draft PR** adding the
  record (status APPROVED) to companies.json. Owner merges = live in index AND next fetch
  cycle (loop stages 1→3 connected). Close issue on merge via `closes #N`.
- `index.html`: submit modal unchanged except honeypot field + timing token.
- Monthly canary workflow (risk 4).
- Acceptance: end-to-end test submission → issue → draft PR → merge → appears on site and in
  next fetch run; honeypot-filled and instant submissions rejected; oversized/junk payload
  400s; rate cap returns 429 past the hourly limit.

### Phase 4 — Community moderation (the hide button, per locked design)
- UI: hide (✕) on each pulse card → immediately hides + persists URL in
  `localStorage.pulseHidden` (that visitor only) → `POST action=flag` to the GAS relay
  (url only; client-side dedupe — one flag per URL per browser).
- GAS relay `action=flag`: URL sanity check + CacheService rate cap → create or comment on a
  per-URL issue labeled `article-flag` (stays within the issues-only token model; per-URL
  issues self-organize the queue and give an audit trail).
- `.github/workflows/flags.yml` (on flag-issue events): fold into `data/flags.json`
  (count, first/last timestamps), close processed issues. Serialized concurrency group.
- `.github/workflows/moderate.yml` (daily cron + after flags change): for URLs with
  `count ≥ 3` (tunable), call GitHub Models with company profile + article title/source →
  strict-JSON verdict `{about_company, charlotte_relevant, confidence}`. `confidence ≥ 0.8`
  and not relevant → append to `data/exclusions.json` (reason, decider:"ai", model, ts);
  else open `needs_review` issue for the owner. Owner can always hand-edit exclusions.json
  (decider:"owner").
- `pulse-fetch.js` drops excluded URLs at write; `pulse.html` also filters (defense in depth)
  and filters `pulseHidden` locally.
- Acceptance: flag → hidden locally instantly; 3 test flags → AI verdict path exercised both
  ways (mock/borderline case → needs_review issue); excluded article gone for everyone after
  next fetch; flags can't exceed rate limit.

### Phase 5 — Cutover + decommission Google Sheets
- Preconditions: Phases 1–4 green, 1-week parallel-run comparison acceptable.
- Delete the GAS time trigger (`runPulseFetch` teardown), keep the sheet as a frozen
  read-only backup (do not delete), remove all docs.google.com CSV URLs from both pages,
  update README + SESSION-LOG. The GAS **relay** (stateless issue-forwarder) is the one piece
  of Google that intentionally remains — it touches no sheet and holds no data.
- Monitoring (all free): Actions failure emails (GitHub native), staleness banner on
  pulse.html, monthly intake canary.
- **Rollback:** every step is a git revert; the sheet + GAS script remain intact and can be
  re-pointed in one commit (restore CSV URLs) + one trigger re-install.

## 6. Owner setup tasks (cannot be done by the agent)
1. Create fine-grained PAT: this repo only, **Issues: Read/Write** only, 1-year expiry;
   calendar reminder to rotate.
2. Paste the new `gas-relay.gs` into the Apps Script editor (incognito, per the known
   multi-account quirk), add the PAT to Script Properties, redeploy the web app, and delete
   the old sheet-append code + (at Phase 5) the `runPulseFetch` time trigger.
3. Enable GitHub Models for the account/repo (one click, free tier).
4. Merge the import PR (Phase 1) and each intake PR thereafter — that's the whole ongoing
   maintenance surface, by design.

## 7. Executor notes (for the Opus/Sonnet session that implements this)
- Read first: `PULSE-EVALUATION.md` (relevance model + tests context), `PULSE-SOURCES-PLAN.md`
  (multi-source future; Piece 0 is superseded by this doc), `gas-pulse.gs` (reference
  implementation of fetching/scoring), `pulse-logic-test.js` (the regression harness — evals
  the real functions; keep this pattern), `assets/filters.js` (reusable dedupe).
- The dev sandbox blocks docs.google.com and some hosts — GitHub-hosted runners do NOT; put
  anything needing Google egress in a workflow, not the sandbox.
- Work phase-by-phase, each phase its own commit set on the designated branch with tests
  green before moving on; do not start Phase 3 before Phase 1 merges (intake PRs target
  companies.json).
- Bump nothing in gas-pulse.gs except the final teardown note — GAS is frozen during
  migration except the Phase 5 teardown.
- Multi-source expansion (blog RSS, news pages, SEC EDGAR from PULSE-SOURCES-PLAN.md) is
  explicitly POST-migration: plug into `pulse-fetch.js`'s source interface once the loop is
  stable.

## 8. Success criteria (maps 1:1 to the mission)
- A stranger can submit a company; owner one-click-merges; the company appears in the
  directory and enters the next news sweep — no Google Sheets involved anywhere (Google
  persists only as the stateless form relay, by owner choice).
- Feed refreshes 3×/day unattended; failures email the owner; staleness is visible on-site.
- FP/TP regression suite green under the unified score; per-company exclude keywords work.
- No duplicate stories (URL or ≥90% title) in the rendered feed.
- A flagged irrelevant article disappears immediately for the flagger, and for everyone only
  after AI-over-threshold or owner sign-off, with an audit trail.
- Monthly cost: $0. Ongoing owner effort: merging PRs and reading occasional needs_review
  issues.
