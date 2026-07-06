// Test harness: runs articles through the ACTUAL gas-pulse.gs scoring + filter
// functions (loaded via eval), comparing the OLD pipeline (pre-strict-gate,
// reconstructed here) against the CURRENT tiered logic in passesRelevanceGates.
// Run with: node pulse-logic-test.js   (no dependencies)
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/gas-pulse.gs', 'utf8');
eval(src); // defines CONFIG, CLT_SOURCES, BUSINESS_SIGNALS, scoreArticle, passesRelevanceGates, hasLocationOrBusinessSignal, escapeRegex

const DAY = 86400000;
const recent = new Date(Date.now() - 30 * DAY); // 1 month old -> +10 recency

// ── OLD pipeline (pre-change gates: business-signal OR-gate + context-keyword filter)
function oldPipeline(article, company) {
  // reconstruct the old snippet-echo double count
  let score = scoreArticle(article, company.name, company.domain);
  const nameRe = new RegExp('\\b' + escapeRegex(company.name.toLowerCase()) + '\\b');
  if (article.title.toLowerCase() && article.snippet.toLowerCase().includes(article.title.toLowerCase())
      && nameRe.test(article.snippet.toLowerCase())) {
    score += CONFIG.WEIGHTS.NAME_IN_SNIPPET; // old code counted the echo
  }
  const gates = { score };
  if (score < CONFIG.MIN_SCORE) return { pass: false, why: 'score < 50', ...gates };
  if (!nameRe.test(article.title.toLowerCase()) && !nameRe.test(article.snippet.toLowerCase()))
    return { pass: false, why: 'name not in title/snippet', ...gates };
  if (!hasLocationOrBusinessSignal(article, company.domain))
    return { pass: false, why: 'no CLT/business signal', ...gates };
  const kws = company.phraseKeywords.concat(company.wordKeywords);
  if (kws.length > 0) {
    const hay = article.title.toLowerCase() + ' ' + article.snippet.toLowerCase();
    if (!kws.some(kw => hay.includes(kw)))
      return { pass: false, why: 'no context keyword', ...gates };
  }
  return { pass: true, why: score >= 60 ? 'stored + DISPLAYED (≥60)' : 'stored only (50-59)', ...gates };
}

// ── NEW pipeline — exactly what runPulseFetch now does, calling the real functions
function newPipeline(article, company) {
  const score = scoreArticle(article, company.name, company.domain);
  const gates = { score };
  if (score < CONFIG.MIN_SCORE) return { pass: false, why: 'score < 50', ...gates };
  const nameRe = new RegExp('\\b' + escapeRegex(company.name.toLowerCase()) + '\\b');
  if (!nameRe.test(article.title.toLowerCase()) && !nameRe.test(article.snippet.toLowerCase()))
    return { pass: false, why: 'name not in title/snippet', ...gates };
  if (!passesRelevanceGates(article, company))
    return { pass: false, why: company.strict ? 'strict gates failed' : 'no CLT/business signal', ...gates };
  return { pass: true, why: score >= 60 ? 'stored + DISPLAYED (≥60)' : 'stored only (50-59)', ...gates };
}

// ── Companies — shaped like getApprovedCompanies() output
function co(name, domain, strict, keywords = [], aliases = []) {
  return {
    name, domain, strict, aliases,
    phraseKeywords: keywords.filter(k => k.includes(' ')),
    wordKeywords:   keywords.filter(k => !k.includes(' ')),
  };
}
const companies = {
  polymer:   co('Polymer',   'polymerhq.io',    true,  ['data loss prevention', 'data', 'security', 'privacy', 'compliance', 'saas']),
  path:      co('Path',      'path.com',        true,  []), // strict, nothing populated — worst case
  pathKw:    co('Path',      'path.com',        true,  ['mental', 'health', 'therapy', 'insurance']),
  passport:  co('Passport',  'passportinc.com', true,  ['parking', 'mobility', 'payments', 'transportation']),
  fastbreak: co('FastBreak', 'fastbreak.ai',    true,  ['sports scheduling', 'scheduling', 'league'], ['fastbreak.ai']),
  lucidbots: co('LucidBots', 'lucidbots.com',   false, ['drones', 'cleaning', 'robotics', 'exterior']),
  finzly:    co('Finzly',    'finzly.com',      false, ['banking', 'payments', 'fintech', 'fedwire']),
};

// Google News RSS reality: snippet == title (echoed back). Model that unless stated.
function art(title, url, sourceUrl, opts = {}) {
  return { title, snippet: opts.snippet !== undefined ? opts.snippet : title,
           url, sourceUrl, source: sourceUrl, published: opts.published || recent };
}

const cases = [
  // ── FALSE POSITIVES that must be blocked ──
  { id: 'FP-1', label: 'THE polymer example — material article w/ business word',
    company: 'polymer', want: 'block',
    a: art('Ohio polymer manufacturer launches new recycling plant',
           'https://plasticsnews.com/ohio-polymer-plant', 'https://plasticsnews.com') },
  { id: 'FP-2', label: 'polymer material article whose title hits a single-word context keyword',
    company: 'polymer', want: 'block',
    a: art('Polymer producers expand data-driven manufacturing to boost revenue',
           'https://industryweek.com/polymer-data', 'https://industryweek.com') },
  { id: 'FP-3', label: '"path" as common noun + funding language',
    company: 'path', want: 'block',
    a: art('Startup founders chart a new path to venture funding in 2026',
           'https://techcrunch.com/path-to-funding', 'https://techcrunch.com') },
  { id: 'FP-4', label: '"path" infrastructure story with "launches"',
    company: 'path', want: 'block',
    a: art('City launches new greenway path connecting suburbs',
           'https://ajc.com/greenway-path', 'https://ajc.com') },
  { id: 'FP-5', label: 'passport travel story with "expands"',
    company: 'passport', want: 'block',
    a: art('State Department expands online passport renewal program',
           'https://cnn.com/passport-renewal', 'https://cnn.com') },
  { id: 'FP-6', label: 'unrelated Charlotte story that merely contains the word "path"',
    company: 'path', want: 'block',
    a: art('Charlotte transit plan charts path for new rail line',
           'https://wsoctv.com/transit-path', 'https://wsoctv.com') },
  { id: 'FP-7', label: 'Charlotte civic story w/ business word "launch" — keywords populated',
    company: 'pathKw', want: 'block',
    a: art('Charlotte launches greenway path expansion in south end',
           'https://qcnews.com/greenway-path', 'https://qcnews.com') },
  { id: 'FP-8', label: 'same as FP-7 but company has NO pulse_keywords (residual risk, warned in logs)',
    company: 'path', want: 'residual',
    a: art('Charlotte launches greenway path expansion in south end',
           'https://qcnews.com/greenway-path', 'https://qcnews.com') },
  { id: 'FP-9', label: 'basketball fast break story hitting business word + single-word keyword',
    company: 'fastbreak', want: 'block',
    a: art('Lakers fastbreak launches new era for league offense',
           'https://espn.com/lakers-fastbreak', 'https://espn.com') },

  // ── TRUE POSITIVES that must pass ──
  { id: 'TP-1', label: 'Charlotte in title — strict company, keyword corroborates',
    company: 'polymer', want: 'pass',
    a: art('Charlotte startup Polymer raises $5M to expand data security platform',
           'https://axios.com/charlotte/polymer-raise', 'https://axios.com') },
  { id: 'TP-2', label: 'CLT publication, title lacks context keywords — strict company',
    company: 'polymer', want: 'pass',
    a: art('Polymer lands new funding round to fuel growth',
           'https://bizjournals.com/charlotte/polymer-funding', 'https://bizjournals.com') },
  { id: 'TP-3', label: 'Charlotte in snippet only (real snippet available)',
    company: 'path', want: 'pass',
    a: art('Path raises $12M Series A',
           'https://prnewswire.com/path-series-a', 'https://prnewswire.com',
           { snippet: 'Charlotte-based Path announced a $12M Series A round led by...' }) },
  { id: 'TP-4', label: 'national coverage, unique name, business signal — non-strict',
    company: 'lucidbots', want: 'pass',
    a: art('LucidBots raises $9M to scale drone manufacturing',
           'https://techcrunch.com/lucidbots-raise', 'https://techcrunch.com') },
  { id: 'TP-5', label: 'national coverage, unique name, title lacks context keyword — non-strict',
    company: 'finzly', want: 'pass',
    a: art('Finzly named a top workplace as it expands headcount',
           'https://americanbanker.com/finzly-workplace', 'https://americanbanker.com') },
  { id: 'TP-6', label: 'NATIONAL press for strict company via distinctive alias (FastBreak.ai)',
    company: 'fastbreak', want: 'pass',
    a: art('FastBreak.ai raises $20M to expand sports scheduling platform',
           'https://techcrunch.com/fastbreak-raise', 'https://techcrunch.com') },
  { id: 'TP-7', label: 'NATIONAL press for strict company via phrase keyword (was blocked trade-off TO-1)',
    company: 'polymer', want: 'pass',
    a: art('Polymer raises $20M Series B for data loss prevention',
           'https://techcrunch.com/polymer-series-b', 'https://techcrunch.com') },
];

// ── Score assertion: snippet-echo no longer double-counts ──
const echoArt = art('Ohio polymer manufacturer launches new recycling plant',
                    'https://plasticsnews.com/x', 'https://plasticsnews.com');
const echoScore = scoreArticle(echoArt, 'Polymer', 'polymerhq.io');
const echoOk = echoScore === 60; // 50 name-in-title + 10 recency (no +25 echo)
console.log(`Snippet-echo scoring: ${echoScore} (want 60, was 85) ${echoOk ? '✓' : '✗'}\n`);

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('ID', 6) + pad('score', 7) + pad('OLD LOGIC', 34) + pad('NEW LOGIC', 34) + 'verdict');
console.log('-'.repeat(120));
let ok = echoOk ? 1 : 0, total = 1;
for (const c of cases) {
  const comp = companies[c.company];
  const old_ = oldPipeline(c.a, comp);
  const new_ = newPipeline(c.a, comp);
  let verdict;
  if (c.want === 'block')      verdict = !new_.pass ? (old_.pass ? 'FIXED ✓ (was FP)' : 'OK ✓ (both block)') : 'STILL LEAKS ✗';
  else if (c.want === 'pass')  verdict = new_.pass ? (old_.pass ? 'OK ✓ (both pass)' : 'FIXED ✓ (was FN)') : 'REGRESSION ✗';
  else                         verdict = `residual: ${new_.pass ? 'passes (warned in logs)' : 'blocked'}`;
  if (c.want !== 'residual') { total++; if (!verdict.includes('✗')) ok++; }
  console.log(pad(c.id, 6) + pad(new_.score, 7)
    + pad((old_.pass ? 'PASS  ' : 'block ') + old_.why, 34)
    + pad((new_.pass ? 'PASS  ' : 'block ') + new_.why, 34)
    + verdict);
  console.log('       ' + c.label + '  —  "' + c.a.title + '"');
}
console.log('-'.repeat(120));
console.log(`Scored checks: ${ok}/${total} correct under new logic`);
process.exit(ok === total ? 0 : 1);
