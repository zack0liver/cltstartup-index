# Pulse Script Evaluation — Fix or Replace?

**Date:** 2026-07-06
**Question:** The Pulse fetcher (`gas-pulse.gs`) is failing on two levels — it isn't running on schedule, and it pulls false positives for generic company names (Path, Polymer). Can it be fixed, or should we move to a different free news source?

**Verdict: Fix it. Do not switch sources.** Both failures are diagnosable defects in our own code/deployment, not limitations of Google News RSS. No free alternative has the quota to handle ~700 companies, and none of them would fix the false-positive problem anyway — name ambiguity lives in our query/filter logic, not in the data source.

---

## Failure 1 — Not running on schedule

### Root cause (high confidence)

This is a deployment failure with a specific mechanism, visible in the git history:

1. **`setupTrigger()` deletes before it creates.** The function first deletes every existing `runPulseFetch` trigger, *then* creates the new one (`gas-pulse.gs:548-557`).
2. **The old version then crashed between those two steps.** Until commit `1d365c8` (2026-06-01) it called `.everyMinutes(20)` — an invalid interval. GAS only accepts 1/5/10/15/30 and **throws** on anything else. So running that version of `setupTrigger()` deleted the working daily trigger and crashed before installing a replacement, leaving **zero triggers installed**.
3. **The fix never reached production.** The repo copy now says `everyMinutes(15)`, but the repo is not the deployment — the script runs from the GAS editor attached to the Google Sheet. SESSION-LOG.md (Session 2) explicitly notes: *"The updated gas-pulse.gs is in the repo but NOT yet pasted into GAS editor."* Unless the current file was re-pasted and `setupTrigger()` re-run since June 1, there is still no trigger.

### Contributing problems (make failures invisible)

- **The top-level `try/catch` in `runPulseFetch()` swallows every error** (`gas-pulse.gs:222-224`). It only writes to `Logger.log`, which is discarded unless you're watching the Executions panel. Worse, because the run "succeeds" from GAS's point of view, **Google's built-in trigger-failure notification emails never fire.** The script can fail every 15 minutes for a month in total silence.
- **No heartbeat.** Nothing records "last successful run" anywhere a human looks, so the only symptom is the feed going stale.
- **Account ambiguity.** The session log notes GAS must be run from incognito due to multi-account "unknown error" issues. Time triggers run as the account that created them — if the trigger was ever installed under the wrong account, runs can fail authorization silently.
- Minor: `CONFIG.SPREADSHEET_ID` is still `'YOUR_SPREADSHEET_ID_HERE'` and unused — the script relies on `getActiveSpreadsheet()`, so it only works container-bound. Pasted into a standalone project, it dies silently inside the same try/catch.

### Fixes

1. **Redeploy:** paste current `gas-pulse.gs` into the sheet-bound GAS editor (incognito), run `setupTrigger()` once, and confirm the trigger exists in the Triggers panel. Also fix the stale log line that still says "every 20 minutes".
2. **Harden `setupTrigger()`:** create the new trigger first, then delete old ones — a failure can never again leave zero triggers.
3. **Stop swallowing errors:** in the catch block, write the error + timestamp to a `pulse_status` cell (or script property) and re-throw so GAS's failure emails fire. Optionally `MailApp.sendEmail` on fatal error.
4. **Add a heartbeat:** write `lastRun` / `lastBatch` / `articlesAdded` to a status cell every run; surface it in `pulse.html` so staleness is visible on the site itself.

---

## Failure 2 — False positives for generic names (Path, Polymer)

### Root causes

The filters added in the redesign (`6e09aa3`) look strict but have a structural hole:

1. **The "hard" gate is an OR that generic business news always passes.** `hasLocationOrBusinessSignal()` (`gas-pulse.gs:95-115`) accepts *Charlotte signal OR business signal*, and `BUSINESS_SIGNALS` includes `launches`, `ceo`, `expands`, `hiring`, `capital`, `partnership`… — words present in a huge share of all business journalism. The check confirms an article is *business news*, not that it's about *our* company. Example that sails through today:
   - *"Ohio polymer manufacturer launches new recycling plant"* → name-in-title (+50) + snippet echo (+25) + recency (+10) = **85 ≥ 50**, word-boundary regex matches `polymer`, business signal `launches` present → **stored, displayed** (85 ≥ 60).
2. **Word-boundary regex can't disambiguate dictionary words.** `\bpath\b` matches "path to profitability" and "career path" exactly as well as it matches the company. The boundary check only fixed substring noise ("Arc" in "Monarch"), not common-noun noise.
3. **Google News RSS descriptions are usually just the title wrapped in a link.** Two consequences: (a) `NAME_IN_SNIPPET` (+25) almost always co-fires with `NAME_IN_TITLE`, inflating every score by 25; (b) the context-keyword filter is matching against ~no text beyond the title, so it filters far less than intended.
4. **Auto-extracted context keywords match the false positives.** For a company categorized "Manufacturing", keywords like `manufacturing`/`materials` are exactly the words that appear in articles about the *material* polymer — the keyword filter passes the very articles it exists to block.
5. **The escape hatch was built but never loaded.** `pulse_query` per-company overrides are implemented in code, but the session log confirms the sheet column was never populated for Path, Polymer, or FastBreak.

### Fixes (in impact order)

1. **Close the OR-gate for ambiguous names.** Add a per-company strictness tier — either a `pulse_strict` sheet column or auto-detection (name is a single dictionary word). For strict companies, `hasLocationOrBusinessSignal` must require *Charlotte signal OR company-domain match* — a generic business keyword alone is **not** enough. This one change eliminates the Path/Polymer class of false positive.
2. **Populate `pulse_query` overrides** for the known offenders (already spec'd in SESSION-LOG: `"Path" Charlotte startup software`, `"FastBreak.ai" OR "FastBreak" fintech`, Polymer TBD). Zero code required.
3. **Stop double-counting the snippet echo:** skip `NAME_IN_SNIPPET` when the snippet contains the title. This deflates scores by 25 across the board and makes `MIN_SCORE` meaningful again.
4. **Per-company exclusion keywords** (`pulse_exclude_keywords` column — already designed as ENH-007) for recurring off-topic themes.
5. Optionally: require a business signal in the *title* (not snippet) for non-CLT sources.

---

## Free alternatives considered — and why none of them win

| Option | Free quota | Fit for ~700 companies × 3 queries/cycle | Fixes false positives? |
|---|---|---|---|
| **Google News RSS** (current) | Unmetered (unofficial) | ✅ Yes — only free option at this volume | N/A — filtering is our job |
| NewsAPI.org | 100 req/day, 24h delay, dev-license only | ❌ ~7% of one cycle per day | ❌ Same keyword ambiguity |
| NewsData.io | 200 credits/day | ❌ Too small | ❌ Same |
| Google Custom Search JSON API | 100 queries/day | ❌ Too small | ❌ Same |
| GDELT | Free, generous | ⚠️ Volume OK | ❌ *Worse* — full-text matching is noisier than Google News |
| Bing News RSS | Was free | ❌ Bing Search APIs retired Aug 2025; RSS endpoint unreliable (we already tried it — added `9b5b8ae`, removed in `6e09aa3`) | ❌ Same |
| Google Alerts RSS | Free, per-alert feed | ❌ Manual setup per query — impractical at 700, fine as a supplement for 2-3 problem companies | ⚠️ Slightly, via curated queries |

The false-positive problem is source-independent: any keyword-queried news source returns polymer-the-material articles for "Polymer". The scheduling problem is a GAS deployment issue that no source swap touches. Meanwhile Google News RSS's effectively unmetered quota is the only thing that makes a 700-company sweep free at all.

## Recommendation

Keep the Google News RSS + GAS + Sheets architecture. Estimated effort:

1. **Today (no code):** re-paste script into GAS, run `setupTrigger()`, verify trigger; populate `pulse_query` for Path/Polymer/FastBreak.
2. **~Half day (code):** strict-tier gate for generic names, error re-throw + status heartbeat, create-before-delete in `setupTrigger()`, snippet-echo scoring fix.
3. **Later:** ENH-007 exclusion keywords, Google Alerts RSS supplement for any company that still can't be disambiguated.

Revisit alternatives only if Google ever blocks/deprecates the RSS endpoint — GDELT would be the fallback, paired with the same (fixed) filtering layer.

---

## Appendix: Implemented filter logic + test results

**Status: implemented in `gas-pulse.gs`** (`passesRelevanceGates`) and validated by
`pulse-logic-test.js`, which evals the *actual* script functions and pushes 17 checks
through both the old and new pipelines. Snippets are modeled as title echoes, matching
what Google News RSS actually returns.

**The headline Polymer example previously scored 85** — name-in-title (+50) +
snippet-echo (+25) + recency (+10). The snippet-echo fix (don't count `NAME_IN_SNIPPET`
when the snippet contains the title) brings it to 60; the strict gates now block it
regardless of score.

### The tier model (as implemented)

**Does national press require a Charlotte signal? No — only strict-named companies ever
needed one, and they now have two escape hatches.**

- **Non-strict companies** (distinctive names — LucidBots, Finzly, the default): strong
  signal (Charlotte mention / CLT publication / own domain in URL) **or** business signal.
  National coverage passes on business words alone. The context-keyword filter is
  **removed** for these companies — it was blocking legitimate articles (`'drones'`
  doesn't substring-match "drone manufacturing") and unique names don't need it.
- **Strict companies** (dictionary-word names — Path, Polymer, Passport, FastBreak;
  flagged via new `pulse_strict` sheet column, falling back to `CONFIG.GENERIC_NAMES`):
  pass if **any** of:
  1. **strong + business** — Charlotte/CLT-source/domain signal AND a business word;
     a *bare* Charlotte word-mention additionally needs a context-keyword match when
     keywords exist (blocks "Charlotte launches greenway path expansion");
  2. **alias hatch** — a `pulse_aliases` entry (new sheet column, e.g. `FastBreak.ai`)
     word-boundary-matches the text: the alias is unambiguous, so national press passes
     with just a business signal (`\bfastbreak\.ai\b` matches "FastBreak.ai raises $20M…"
     but not "Lakers fastbreak…");
  3. **phrase-keyword hatch** — a multi-word `pulse_keywords` entry (e.g. `data loss
     prevention`) matches AND a business signal is present. Single-word keywords never
     unlock national coverage — FP-2 proved they collide with generic vocabulary.

### Results — 16/16 scored checks correct (`node pulse-logic-test.js`)

| ID | Article (new score) | Old logic | New logic |
|---|---|---|---|
| FP-1 | "Ohio polymer manufacturer launches new recycling plant" (60) | blocked by luck¹ | ✅ blocked |
| FP-2 | "Polymer producers expand data-driven manufacturing…" (60) | ❌ displayed | ✅ blocked |
| FP-3 | "Startup founders chart a new path to venture funding" (60) | ❌ displayed | ✅ blocked |
| FP-4 | "City launches new greenway path connecting suburbs" (60) | ❌ displayed | ✅ blocked |
| FP-5 | "State Department expands online passport renewal" (60) | blocked by luck¹ | ✅ blocked |
| FP-6 | "Charlotte transit plan charts path for new rail line" (103) | ❌ displayed | ✅ blocked |
| FP-7 | "Charlotte launches greenway path expansion", keywords set (83) | blocked by luck¹ | ✅ blocked |
| FP-8 | same as FP-7, NO keywords (83) | ❌ displayed | ⚠️ residual² |
| FP-9 | "Lakers fastbreak launches new era for league offense" (60) | ❌ displayed | ✅ blocked |
| TP-1 | "Charlotte startup Polymer raises $5M…" (103) | ✅ | ✅ |
| TP-2 | "Polymer lands new funding round" via Biz Journal (80) | ❌ wrongly blocked | ✅ displayed |
| TP-3 | "Path raises $12M Series A", Charlotte in real snippet (93) | ✅ | ✅ |
| TP-4 | "LucidBots raises $9M to scale drone manufacturing" (60) | ❌ wrongly blocked | ✅ displayed |
| TP-5 | "Finzly named a top workplace as it expands…" (60) | ❌ wrongly blocked | ✅ displayed |
| TP-6 | **national**: "FastBreak.ai raises $20M…" via alias (70) | ✅ | ✅ displayed |
| TP-7 | **national**: "Polymer raises $20M Series B for data loss prevention" via phrase kw (60) | ✅ | ✅ displayed |

Plus a scoring assertion: the FP-1 article scores 60 (was 85) after the snippet-echo fix.

¹ "Blocked by luck": the old context-keyword filter happened to catch it only because the
title lacked a keyword — FP-2 shows the same article class passing the moment a keyword
coincidentally appears.

² **FP-8 residual risk:** a Charlotte civic story containing a strict company's name plus
a business word passes when that company has no `pulse_keywords`/`pulse_aliases`. The
script now logs a WARNING for every strict company with neither populated — the fix is
operational: fill in the columns (FP-7 proves the layer works once keywords exist).

**Net effect: 5 false positives eliminated, 3 false negatives fixed, national coverage
preserved for both distinctive and strict names, 0 regressions.**

Side effect worth knowing: with the echo fix, national articles score exactly 60 when
recent (≤6 months) — right at the display threshold. National articles older than 6
months score 55: stored but not displayed. Arguably correct for a "pulse" feed; raise
`WITHIN_1_YEAR` if year-old national coverage should display.

### Deployment checklist (GAS is the runtime, not this repo)

1. Add sheet columns to Live Startups: `pulse_strict`, `pulse_aliases` (and populate
   `pulse_keywords` — phrases preferred — for Path, Polymer, Passport, FastBreak).
2. Paste updated `gas-pulse.gs` into the sheet-bound Apps Script editor (incognito).
3. Run `setupTrigger()` once; confirm the 15-minute trigger in the Triggers panel.
4. Run `runPulseFetch()` once manually; check Executions + the new
   `pulseLastRun`/`pulseLastError` script properties.
