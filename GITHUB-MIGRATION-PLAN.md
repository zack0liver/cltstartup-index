# GitHub Migration Plan v2 — the self-sufficient Pulse + Directory loop

**Status:** Planned, awaiting greenlight — not yet implemented
**Date:** 2026-07-09 (v2 same day — simplified after self-critique; v1 in git history)
**Executor:** a future Claude session; read the model-recommendation section below, then §7
**Supersedes:** Piece 0 of `PULSE-SOURCES-PLAN.md` (multi-source pieces there remain valid, post-migration)

**v2 changes in one line:** port the already-Node-proven scoring as-is (redesign later), label
approval instead of draft PRs (avoids the GITHUB_TOKEN trigger trap), issues ARE the flag
store (no flags.json), 1 flag → AI review (no dead threshold), 7 workflows → 3, plain
validator instead of JSON Schema, AI fails open to human review, no parallel-run comparison
tooling, no canary/min-time theater.

## Which Claude model to execute this with

**Default to Sonnet 5 for nearly all of it.** This plan is a highly specified execution doc —
file names, acceptance criteria, known traps pre-flagged, and the scoring logic ships
*verbatim* (guarded by the existing 16-case regression suite) rather than being redesigned.
That profile — architectural judgment already made and encoded in the doc, executor mostly
needs to follow it faithfully and test as it goes — is exactly where Sonnet is reliable and
cheap. Since the whole point of this project is $0/month to run, the same frugality should
apply to the tokens spent building it: don't spend Opus-tier reasoning on label-triggered
workflow YAML.

**Switch to Opus 4.8 for two specific moments, not wholesale:**
1. **Phase 0 if the RSS spike fails.** Deciding between risk-1 mitigations vs. cutting to
   Plan B is an ambiguous judgment call that reshapes the plan — not execution of it.
2. **Phase 4's AI moderation integration** — writing the injection-resistant verdict prompt,
   and debugging GitHub Models inside CI if it misbehaves. Debugging an external integration
   through the slow CI iteration loop (see §7) is where a stronger model earns back its cost
   by getting it right in fewer round-trips.

**Practical rule of thumb:** greenlight with Sonnet 5; if it stalls twice on the same problem,
hand *that one problem* to Opus rather than switching models for the whole run. The plan is
written to be executor-agnostic so this handoff costs nothing.

The real expense in this project isn't model reasoning, it's the **CI iteration loop**:
GitHub Actions runs happen on a push→schedule-runner→boot→execute→write-logs cycle that costs
minutes per round-trip, versus sub-second local feedback. Every workflow debug cycle costs
that loop regardless of which model is doing the debugging — which is why §7 mandates testing
scripts locally with fixtures before their first CI run. A weaker model with a good local
harness beats a stronger model flying blind straight into CI.

### Local Claude Code vs. a remote/cloud session

Running Claude Code locally (clone the repo, work on your own machine) does **not** reduce
token consumption for equivalent work — tokens are billed per what enters/exits the model's
context, identically whether the CLI runs locally or in a remote sandbox, on the same
Anthropic account either way. Local Claude Code is not "cheaper per token."

What it plausibly *does* reduce is **CI round-trips**, which is the actual expensive resource
above. A locked-down remote sandbox may block outbound requests to hosts like
`docs.google.com` (this was true of the sandbox that authored this plan), forcing Phase 0–2
connectivity checks (Google News RSS, the Sheets CSV exports, EDGAR) through an actual GitHub
Actions run just to see if a fetch works. A local machine typically has open internet access,
so the executor can `curl`/test those endpoints directly while writing `pulse-fetch.js`,
catching bugs in seconds instead of via a push-wait-read-logs cycle. Net effect: same tokens
per fix, but likely fewer pushes needed to land Phase 0–2 — real time and iteration savings,
just not a "tokens are free locally" effect. (A bare local Claude Code setup also skips the
unrelated MCP integrations — Slack, Gmail, Canva, etc. — that a fully-loaded remote session
may carry, trimming some incidental context overhead, though this is minor next to the CI
round-trip difference.)

## 0. Mission and definition of done

Migrate `cltstartups.com` off Google Sheets/Apps Script onto a GitHub-native system that runs
THE LOOP unattended:

1. **Intake** — public visitors submit new companies from the site.
2. **Approval** — owner approves/rejects with one click; approved companies enter the index.
3. **Newsfeed** — approved companies are automatically swept into the news search.
4. **False-positive control** — relevance scoring keeps junk out of the feed.
5. **Dedup** — URL + ≥90% title-similarity dedup, server-side at write time.
6. **Community moderation** — visitors flag irrelevant articles; flags hide locally
   immediately, and globally only after AI sign-off (owner override always).

Constraints: **secure** (no secrets in the browser, least-privilege tokens, spam-resistant),
**fast** (static JSON on GitHub Pages CDN), **$0/month** (only cost: the already-owned domain).

## 1. Target architecture

```
                   ┌───────────────────────────────────────────────────────┐
                   │                     GitHub repo                        │
 visitor ─submit──►│ GAS relay ──issue──► intake.yml: validate + preview    │
 (index.html form) │ (existing            comment │                        │
                   │  web app)                    ▼                        │
                   │            OWNER adds `approved` label ──► same       │
                   │            workflow commits to data/companies.json    │
                   │                                              │        │
                   │            pulse-fetch.yml (cron) ◄──────────┘        │
                   │        Google News RSS → scoring (ported as-is) →     │
                   │        dedup → exclusions filter → data/pulse.json    │
                   │                                              │        │
 visitor ◄─reads───│ GitHub Pages (index.html / pulse.html) ◄─────┘        │
    │              │                                                       │
    └─flag article─► GAS relay ──per-URL issue (= the flag store)          │
                   │        moderate.yml (cron): AI verdict via GitHub     │
                   │        Models → data/exclusions.json (high conf)      │
                   │        OR needs_review issue (ambiguous / AI error)   │
                   └───────────────────────────────────────────────────────┘
```

Data files (all committed, all served by Pages):
- `data/companies.json` — canonical company DB (replaces Live Startups sheet)
- `data/pulse.json` — article feed (replaces Pulse sheet), includes `lastRun` heartbeat
- `data/exclusions.json` — excluded article URLs with reason + decider (ai|owner) + timestamp

(No `flags.json` — open `article-flag` issues are the queue. No `companies.schema.json` —
validation is a plain function, see §2.)

## 2. Key design decisions (rationale for the executor)

- **Port the existing scoring logic verbatim; do NOT redesign it during the migration.**
  `pulse-logic-test.js` already evals `gas-pulse.gs` in Node (16/16 green) — the port is
  nearly free. Coupling the unified-relevance redesign into the migration would (a) make feed
  changes unattributable (port vs. redesign?) and (b) burn a calibration loop. The unified
  model (`computeRelevanceScore`, `GENERIC_NAME_PENALTY`, `pulse_exclude_keywords`) is a
  **post-migration follow-up**, gated by the same regression suite.
- **Public-write proxy = the existing Google Apps Script web app, repurposed as a thin relay**
  (owner decision: no new accounts). The GAS `doPost` holds a **fine-grained PAT scoped to
  this one repo with `issues: write` ONLY** (Script Properties, never sent to the browser).
  It forwards validated submissions and flags to GitHub as labeled issues — it writes no
  sheet. Worst-case token leak = someone can open issues on a public repo. All real writes
  happen inside Actions via the ephemeral `GITHUB_TOKEN`.
  - Spam control: honeypot form field + global rate cap via `CacheService` + everything lands
    as issues, inert until owner/AI action. On GitHub API failure the relay emails the owner
    via `MailApp` (3 lines — replaces v1's canary workflow). No min-time check (client
    timestamps are forgeable — theater).
  - Upgrade path if spam ever appears: Cloudflare Worker + Turnstile, drop-in (issue side
    unchanged).
- **Approval = adding an `approved` label to the intake issue** — NOT a draft PR. Reason:
  PRs opened with the default `GITHUB_TOKEN` do not trigger other workflows (GitHub
  anti-recursion), so a validate-on-PR workflow would silently skip bot PRs; working around
  that needs a contents-scoped PAT, breaking least-privilege. Labels avoid the trap entirely:
  `intake.yml` validates + comments a preview on issue open, and on the `approved` label
  re-validates and commits straight to `main`. Reject = close the issue. One workflow, one
  token, still one click (labels work in the GitHub mobile app).
- **Per-URL `article-flag` issues ARE the flag store.** Flag count = comment count; audit
  trail = the issue thread; no intermediate `flags.json`, no folding workflow, no races.
  `moderate.yml` reads open flag issues, decides, closes them with the verdict.
- **1 flag triggers AI review (no ≥3 threshold).** At this site's traffic most junk would
  never reach 3 flags — the feature would look broken. The AI is the gate; the rate cap +
  client-side one-flag-per-URL dedupe handle abuse.
- **AI reviewer = GitHub Models** (free tier, callable in Actions, e.g. `gpt-4o-mini`) with
  **fail-open-to-human**: any AI error/unavailability → `needs_review` issue for the owner
  instead of a blocked pipeline. Verdict prompt treats article text as untrusted (delimited,
  injection-resistant, strict-JSON output parsed defensively). If Models turns out to be
  unavailable at build time, ship review-issue-only moderation and add the AI verdict as a
  fast-follow — the workflow shape is identical.
- **Plain imperative validation, not JSON Schema.** `validateCompany()` (~40 lines: required
  fields, URL shape, enum values, duplicate domain/title) gives identical protection without
  half-implementing the JSON-Schema spec in zero-dep Node.
- **Cross-workflow commit races are real**: `intake.yml` and `pulse-fetch.yml` both push to
  `main`, and concurrency groups don't serialize across workflows. EVERY commit step uses a
  shared pull-rebase-retry helper (`scripts/commit-with-retry.sh`, 3 attempts). This is a
  required pattern, not optional hardening.
- **JSON-in-repo scales fine**: measured ≈863 KB for 2,000 companies, ≈1.5 MB for 5,000
  articles — well within Pages norms; split/paginate later if ever needed.

## 3. Free-tier audit

| Component | Service | Free limit | Our usage |
|---|---|---|---|
| Hosting | GitHub Pages (public repo) | 100 GB/mo soft | site + ~2 MB JSON |
| Compute | GitHub Actions (public repo) | unlimited minutes | ~20–40 min/day |
| Intake/flag relay | Google Apps Script web app (existing) | 20k URL fetches/day | dozens/day |
| AI review | GitHub Models | free tier RPD | a few/day at most |
| News source | Google News RSS | unmetered (unofficial) | ~2k req/day |
| **Total** | | | **$0/month** |

## 4. Risks (executor: read before Phase 0)

1. **Google News RSS from shared Actions-runner IPs** may be rate-limited/captcha'd — the #1
   migration risk and why Phase 0 exists. Mitigations in order: keep per-request sleeps
   (existing `SLEEP_MS` pattern), stagger crons, batch like today; if blocked → Plan B: GAS
   remains the *fetch executor only* but commits `pulse.json` to the repo via GitHub API
   instead of writing a sheet (loop shape preserved, Google only in fetch path).
2. **Spam/abuse through the GAS relay** (no CAPTCHA, no client-IP visibility) — honeypot +
   rate cap + structural backstop (relay output is only issues, inert until owner/AI action).
   Upgrade path: Cloudflare Worker + Turnstile (§2).
3. **PAT expiry** (fine-grained PATs max 1 year) — relay `MailApp` alert fires on the first
   failed GitHub call; runbook: paste new PAT into Script Properties. Calendar reminder at
   creation.
4. **GitHub Models availability/limits** — fail-open design (§2) means worst case is
   owner-reviewed issues, never a stuck pipeline.
5. **Prompt-injection via flagged article text** — untrusted-data prompt hygiene + strict
   JSON parsing (§2); blast radius is one wrong exclusion, revertible via exclusions.json
   history.

## 5. Phases

### Phase 0 — Feasibility spike (go/no-go, ~30 min)
- `pulse-fetch.yml` ships first with a `workflow_dispatch` `spike` input: fetches Google News
  RSS for ~25 companies, logs status codes + counts, writes nothing. (No separate spike
  workflow to build and delete.)
- **Gate:** normal RSS responses → proceed. Blocked → risk-1 mitigations, retest; if still
  blocked, switch to Plan B before building more.

### Phase 1 — Data layer
- `scripts/import-from-sheet.js`, run once via the same `workflow_dispatch` (runners have
  open egress; the dev sandbox does not): fetch both published CSVs (gid=0 directory,
  gid=961610690 pulse) → `data/companies.json` + seed `data/pulse.json` + empty
  `data/exclusions.json`. Owner reviews the diff, merges.
- `scripts/validate-companies.js`: plain `validateCompany()` used by both the importer and
  intake (shared module, no schema file).
- Point `index.html` + `pulse.html` at the JSON files (replaces CSV parsing; keep the
  company→ecosystem join, now trivial).
- Acceptance: site renders identically from JSON; validator rejects a seeded bad record.

### Phase 2 — Fetch pipeline (replaces GAS runPulseFetch)
- `scripts/pulse-fetch.js`: Node port of gas-pulse.gs **reusing its pure functions as-is**
  (scoring, gates, RSS parsing patterns) — the test harness already proves they run in Node.
  Node-specific parts: `fetch()` instead of UrlFetchApp, JSON I/O instead of sheets. Reuse
  `dedupeByTitle` from `assets/filters.js` for write-time title dedup; URL dedup; 365-day
  purge; drops URLs in `data/exclusions.json`; writes `lastRun` + run stats into pulse.json.
- Sources pluggable (Google News now; blog RSS/EDGAR from PULSE-SOURCES-PLAN.md later).
- Tests: `pulse-logic-test.js` all 16 cases must stay green (same logic, so no recalibration),
  plus new cases: exclusions-file filtering, write-time title dedup. Tests run first in the
  workflow; fetch aborts on red.
- `.github/workflows/pulse-fetch.yml`: cron 3×/day at odd minutes (`23 5,13,21 * * *`),
  `workflow_dispatch` (with `spike`/`import` inputs from Phases 0–1), concurrency group,
  commit via `commit-with-retry.sh`, commit-if-changed.
- `pulse.html`: staleness banner when `lastRun` > 36 h.
- Acceptance: two consecutive scheduled runs commit sensible diffs; suite green; seeded
  duplicate + seeded excluded URL never appear. **No comparison tooling** — the regression
  suite is the correctness gate; GAS keeps running this week purely as fallback.

### Phase 3 — Intake (GAS doPost repurposed: sheet writer → GitHub relay)
- `gas-relay.gs` (versioned in repo; replaces sheet-append `doPost`): allowlisted fields,
  length/URL validation, honeypot check, CacheService global rate cap → create GitHub issue
  labeled `submission` (JSON payload in body) via GitHub API; `MailApp` alert to owner on
  API failure. Redeploy web app (same URL if possible; else update `APPS_SCRIPT_URL`).
- `.github/workflows/intake.yml`:
  - on issue **opened** with `submission` label: parse, `validateCompany()`, duplicate check
    → comment human-readable preview (+ validation verdict).
  - on issue **labeled `approved`** (owner action): re-validate → append to companies.json →
    commit via retry helper → close issue with confirmation comment.
  - Reject = owner closes the issue. That's the entire approval surface.
- `index.html`: submit modal + honeypot field only.
- Acceptance: test submission → issue → preview comment → `approved` label → company on site
  and in next fetch; honeypot-filled submission rejected; junk payload 400s; rate cap 429s.

### Phase 4 — Community moderation (hide button, per locked design)
- UI: hide (✕) on each pulse card → hides immediately + persists in
  `localStorage.pulseHidden` (that visitor only, incl. across reloads) → `POST action=flag`
  to relay (client-side dedupe: one flag per URL per browser).
- Relay `action=flag`: URL sanity check + rate cap → create (or comment on existing) per-URL
  issue labeled `article-flag`.
- `.github/workflows/moderate.yml` (daily cron + `workflow_dispatch`): for each open
  `article-flag` issue → look up article + company profile → GitHub Models verdict
  `{about_company, charlotte_relevant, confidence}` → `confidence ≥ 0.8` and irrelevant:
  append to `data/exclusions.json` (reason, decider:"ai", model, ts), close issue with
  verdict comment. Ambiguous OR any AI error: relabel `needs_review` for owner, leave open.
  Owner can always hand-edit exclusions.json (decider:"owner").
- `pulse-fetch.js` drops excluded URLs at write; `pulse.html` also filters exclusions +
  `pulseHidden` (defense in depth).
- Acceptance: flag → hidden locally instantly; flagged obvious-junk article auto-excluded on
  next moderate run; borderline case → `needs_review`; simulated AI failure → `needs_review`
  (fail-open verified); excluded article gone for everyone after next fetch.

### Phase 5 — Cutover + decommission Google Sheets
- Preconditions: Phases 1–4 green, ~1 week of scheduled runs look right to the owner.
- Delete the GAS `runPulseFetch` time trigger; keep the sheet as frozen read-only backup;
  remove all docs.google.com CSV URLs from both pages; update README + SESSION-LOG. The GAS
  **relay** (stateless issue-forwarder) intentionally remains — it touches no sheet and holds
  no data.
- Monitoring (all free): Actions failure emails, staleness banner, relay MailApp alert.
- **Rollback:** every step is a git revert; sheet + GAS script remain intact — restore CSV
  URLs in one commit + re-install the trigger.

## 6. Owner setup tasks (cannot be done by the agent)
1. Create fine-grained PAT: this repo only, **Issues: Read/Write** only, 1-year expiry;
   calendar reminder to rotate.
2. Paste `gas-relay.gs` into the Apps Script editor (incognito, per the known multi-account
   quirk), add the PAT to Script Properties, redeploy the web app; at Phase 5 delete the
   `runPulseFetch` trigger.
3. Enable GitHub Models for the account/repo (one click, free tier). If unavailable, Phase 4
   ships review-issue-only (fail-open path) — decide then whether to wait or proceed.
4. Review the import diff (Phase 1) and add `approved` labels to intake issues thereafter —
   that's the whole ongoing maintenance surface, by design.

## 7. Executor notes (for the session that implements this — see model recommendation above)
- Read first: `PULSE-EVALUATION.md` (scoring + tests context), `gas-pulse.gs` (reference
  implementation — its pure functions are reused, not rewritten), `pulse-logic-test.js`
  (regression harness; keep its eval-the-real-code pattern), `assets/filters.js` (reusable
  dedupe), `PULSE-SOURCES-PLAN.md` (post-migration multi-source future).
- The dev sandbox blocks docs.google.com — GitHub-hosted runners do NOT; anything needing
  Google egress runs in a workflow, not the sandbox.
- Only 3 workflows exist: `pulse-fetch.yml`, `intake.yml`, `moderate.yml`. Resist adding
  more — workflow debugging (push→wait→read logs) is the most expensive iteration loop here;
  test all scripts locally with fixtures before their first CI run.
- Every workflow that commits uses `scripts/commit-with-retry.sh` (pull --rebase, 3 retries).
- Work phase-by-phase, each phase its own commit set on the designated branch, tests green
  before moving on; Phase 3 requires Phase 1 merged (intake writes companies.json).
- gas-pulse.gs is FROZEN during migration (reference only) except the Phase 5 teardown.
- Explicitly post-migration: unified relevance redesign (see v1 in git history for the full
  design), multi-source expansion (blog RSS, news pages, SEC EDGAR), both plugging into
  `pulse-fetch.js` once the loop is stable.

## 8. Success criteria (maps 1:1 to the mission)
- A stranger can submit a company; owner one-label approves; the company appears in the
  directory and enters the next news sweep — no Google Sheets involved anywhere (Google
  persists only as the stateless form relay, by owner choice).
- Feed refreshes 3×/day unattended; failures email the owner; staleness is visible on-site.
- The 16-case FP/TP regression suite stays green through the port (identical logic).
- No duplicate stories (URL or ≥90% title) in the rendered feed.
- A flagged irrelevant article disappears immediately for the flagger, and for everyone only
  after AI or owner sign-off, with an audit trail (issue thread + exclusions.json).
- Monthly cost: $0. Ongoing owner effort: labeling intake issues, reading occasional
  needs_review issues.
