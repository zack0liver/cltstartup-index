// Test harness: runs articles through gas-pulse.gs scoring + filter pipeline,
// comparing CURRENT logic vs PROPOSED strict-gate logic.
// Run with: node pulse-logic-test.js   (no dependencies — evals gas-pulse.gs directly)
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/gas-pulse.gs', 'utf8');
eval(src); // defines CONFIG, CLT_SOURCES, BUSINESS_SIGNALS, scoreArticle, hasLocationOrBusinessSignal, escapeRegex, etc.

const DAY = 86400000;
const recent = new Date(Date.now() - 30 * DAY); // 1 month old -> +10 recency

// ── Strong signal = Charlotte mention OR CLT publication OR company's own domain in URL
function hasStrongSignal(article, companyDomain) {
  const t = article.title.toLowerCase(), s = article.snippet.toLowerCase();
  const u = article.url.toLowerCase(), src = (article.sourceUrl || '').toLowerCase();
  if (/\bcharlotte\b/.test(t) || /\bclt\b/.test(t)) return true;
  if (/\bcharlotte\b/.test(s) || /\bclt\b/.test(s)) return true;
  if (CLT_SOURCES.some(d => src.includes(d) || u.includes(d))) return true;
  if (companyDomain && u.includes(companyDomain)) return true;
  return false;
}

// ── CURRENT pipeline (mirrors runPulseFetch gates, gas-pulse.gs:170-186)
function currentPipeline(article, company) {
  const score = scoreArticle(article, company.name, company.domain);
  const gates = { score };
  if (score < CONFIG.MIN_SCORE) return { pass: false, why: 'score < 50', ...gates };
  const nameRe = new RegExp('\\b' + escapeRegex(company.name.toLowerCase()) + '\\b');
  if (!nameRe.test(article.title.toLowerCase()) && !nameRe.test(article.snippet.toLowerCase()))
    return { pass: false, why: 'name not in title/snippet', ...gates };
  if (!hasLocationOrBusinessSignal(article, company.domain))
    return { pass: false, why: 'no CLT/business signal', ...gates };
  if (company.contextKeywords.length > 0) {
    const hay = article.title.toLowerCase() + ' ' + article.snippet.toLowerCase();
    if (!company.contextKeywords.some(kw => hay.includes(kw)))
      return { pass: false, why: 'no context keyword', ...gates };
  }
  return { pass: true, why: score >= 60 ? 'stored + DISPLAYED (≥60)' : 'stored only (50-59)', ...gates };
}

// ── PROPOSED v2 pipeline
//  Strict companies (generic dictionary-word names):
//    1. require strong signal (Charlotte mention / CLT publication / own domain)
//    2. AND require a business signal (kills "Charlotte transit plan charts path...")
//    3. if the ONLY strong signal is a bare Charlotte word-mention (not a CLT
//       publication or the company's own domain) and the company has context
//       keywords, one must match (kills "Charlotte launches greenway path expansion")
//  Non-strict companies (unique names):
//    keep current strong-OR-business gate, DROP the context-keyword filter —
//    it's causing false negatives today ('drones' vs "drone manufacturing")
//    and unique names don't need disambiguation.
function proposedPipeline(article, company) {
  const score = scoreArticle(article, company.name, company.domain);
  const gates = { score };
  if (score < CONFIG.MIN_SCORE) return { pass: false, why: 'score < 50', ...gates };
  const nameRe = new RegExp('\\b' + escapeRegex(company.name.toLowerCase()) + '\\b');
  if (!nameRe.test(article.title.toLowerCase()) && !nameRe.test(article.snippet.toLowerCase()))
    return { pass: false, why: 'name not in title/snippet', ...gates };

  const t = article.title.toLowerCase(), s = article.snippet.toLowerCase();
  const u = article.url.toLowerCase(), srcU = (article.sourceUrl || '').toLowerCase();
  const cltMention = /\bcharlotte\b|\bclt\b/.test(t) || /\bcharlotte\b|\bclt\b/.test(s);
  const cltSource  = CLT_SOURCES.some(d => srcU.includes(d) || u.includes(d));
  const domainHit  = !!(company.domain && u.includes(company.domain));
  const strong     = cltMention || cltSource || domainHit;
  const business   = BUSINESS_SIGNALS.some(kw => (t + ' ' + s).includes(kw));

  if (company.strict) {
    if (!strong)   return { pass: false, why: 'STRICT: no Charlotte/CLT-source/domain', ...gates };
    if (!business) return { pass: false, why: 'STRICT: no business signal', ...gates };
    if (cltMention && !cltSource && !domainHit && company.contextKeywords.length > 0) {
      const hay = t + ' ' + s;
      if (!company.contextKeywords.some(kw => hay.includes(kw)))
        return { pass: false, why: 'STRICT: bare CLT mention, no context kw', ...gates };
    }
  } else {
    if (!strong && !business)
      return { pass: false, why: 'no CLT/business signal', ...gates };
  }
  return { pass: true, why: score >= 60 ? 'stored + DISPLAYED (≥60)' : 'stored only (50-59)', ...gates };
}

// ── Companies (context keywords as extractContextKeywords would yield from category+description)
const companies = {
  polymer:   { name: 'Polymer',   domain: 'polymerhq.io',   strict: true,  contextKeywords: ['data','security','privacy','compliance','saas'] },
  path:      { name: 'Path',      domain: 'path.com',       strict: true,  contextKeywords: [] }, // no description -> no keywords (common case)
  pathKw:    { name: 'Path',      domain: 'path.com',       strict: true,  contextKeywords: ['mental','health','therapy','insurance'] }, // pulse_keywords populated
  passport:  { name: 'Passport',  domain: 'passportinc.com',strict: true,  contextKeywords: ['parking','mobility','payments','transportation'] },
  lucidbots: { name: 'LucidBots', domain: 'lucidbots.com',  strict: false, contextKeywords: ['drones','cleaning','robotics','exterior'] },
  finzly:    { name: 'Finzly',    domain: 'finzly.com',     strict: false, contextKeywords: ['banking','payments','fintech','fedwire'] },
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
  { id: 'FP-2', label: 'polymer material article whose title happens to hit a context keyword',
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
  { id: 'FP-8', label: 'same as FP-7 but company has NO pulse_keywords (residual risk)',
    company: 'path', want: 'block',
    a: art('Charlotte launches greenway path expansion in south end',
           'https://qcnews.com/greenway-path', 'https://qcnews.com') },

  // ── TRUE POSITIVES that must keep passing ──
  { id: 'TP-1', label: 'Charlotte in title — strict company',
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

  // ── KNOWN TRADE-OFF: documented, decide policy ──
  { id: 'TO-1', label: 'TRADE-OFF: real national coverage of strict company, no CLT mention',
    company: 'polymer', want: 'trade-off',
    a: art('Polymer raises $20M Series B for data loss prevention',
           'https://techcrunch.com/polymer-series-b', 'https://techcrunch.com') },
];

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('ID', 6) + pad('score', 7) + pad('CURRENT', 34) + pad('PROPOSED', 44) + 'verdict');
console.log('-'.repeat(130));
let ok = 0, total = 0;
for (const c of cases) {
  const co = companies[c.company];
  const cur = currentPipeline(c.a, co);
  const pro = proposedPipeline(c.a, co);
  let verdict;
  if (c.want === 'block')      verdict = !pro.pass ? (cur.pass ? 'FIXED ✓ (was FP)' : 'OK ✓ (both block)') : 'STILL LEAKS ✗';
  else if (c.want === 'pass')  verdict = pro.pass ? (cur.pass ? 'OK ✓ (both pass)' : 'FIXED ✓ (was FN)') : 'REGRESSION ✗';
  else                         verdict = `trade-off: ${pro.pass ? 'passes' : 'blocked'}`;
  if (c.want !== 'trade-off') { total++; if (!verdict.includes('✗')) ok++; }
  console.log(pad(c.id, 6) + pad(cur.score, 7)
    + pad((cur.pass ? 'PASS  ' : 'block ') + cur.why, 34)
    + pad((pro.pass ? 'PASS  ' : 'block ') + pro.why, 44)
    + verdict);
  console.log('       ' + c.label + '  —  "' + c.a.title + '"');
}
console.log('-'.repeat(130));
console.log(`Scored checks: ${ok}/${total} correct under proposed logic`);
