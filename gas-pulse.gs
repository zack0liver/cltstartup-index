// ============================================================
// CLTStartups — Pulse News Fetcher
// Google Apps Script
// ============================================================

var CONFIG = {
  SPREADSHEET_ID:    'YOUR_SPREADSHEET_ID_HERE',
  SOURCE_SHEET_NAME: 'Live Startups',
  PULSE_SHEET_NAME:  'Pulse',
  SLEEP_MS:          1500,
  MIN_SCORE:         50,   // Articles 50-59 stored but not displayed (pulse.html filters to ≥60)
  MAX_AGE_DAYS:      365,
  BATCH_SIZE:        25,   // Companies processed per trigger run
  WEIGHTS: {
    NAME_IN_TITLE:     50,
    NAME_IN_SNIPPET:   25,
    DOMAIN_IN_URL:     20,
    DOMAIN_IN_SNIPPET: 10,
    CLT_IN_TITLE:      15,
    CLT_IN_SNIPPET:     8,
    CLT_SOURCE:        20,
    WITHIN_6_MONTHS:   10,
    WITHIN_1_YEAR:      5
  }
};

// CLT publications — articles from these sources get CLT_SOURCE score bonus
var CLT_SOURCES = [
  'charlotteobserver.com',
  'bizjournals.com',
  'qcitymetro.com',
  'wfae.org',
  'wcnc.com',
  'wbtv.com',
  'wsoctv.com',
  'axios.com',
  'charlottemagazine.com',
  'charlotteledger.substack.com',
  'tinymoney.com',
  'hypepotamus.com',
  'builtincharlotte.com'
];

// Hard requirement: article must have a Charlotte signal OR one of these business signals.
// Prevents generic company names (e.g. "Passport", "Path") from matching unrelated articles.
var BUSINESS_SIGNALS = [
  'startup', 'raises', 'raised', 'funding', 'funded', 'venture', 'investor', 'investors',
  'seed round', 'series a', 'series b', 'series c', 'pre-seed', 'preseed', 'ipo',
  'acquisition', 'acquires', 'acquired', 'merger', 'merges', 'partnership', 'launches',
  'launched', 'launch', 'founder', 'co-founder', 'ceo', 'revenue', 'expands', 'expansion',
  'hiring', 'valuation', 'capital', 'backed', 'accelerator', 'incubator', 'techstars',
  'y combinator', 'vc-backed', 'angel investor', 'bootstrapped', 'exit', 'acqui-hire'
];

var STOPWORDS = [
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by','from',
  'is','are','was','were','be','been','have','has','had','do','does','did','will',
  'would','could','should','may','might','that','this','these','those','we','you',
  'they','it','its','our','your','their','who','which','what','how','when','where',
  'why','all','any','each','every','both','few','more','most','other','some','such',
  'not','only','own','same','so','than','too','very','just','about','into','never',
  'sleep','always','across','built','driven','focused','based','led','powered',
  'help','helps','helping','platform','software','solution','solutions','company',
  'startup','tech','technology','inc','llc','corp','co','app','tool','tools',
  'service','services','product','products','team','teams','work','works','make',
  'makes','build','builds','building','use','uses','used','get','gets','new','big',
  'small','first','local','national','modern','simple','smart','fast','best','top',
  'one','two','three','leading','innovative','seamless','powerful','world','next'
];

var COLS = { COMPANY: 1, TITLE: 2, URL: 3, SOURCE: 4, SOURCE_URL: 5, PUBLISHED: 6, SCORE: 7, FETCHED: 8 };
var NUM_COLS = 8;

// ── Context keyword extraction ────────────────────────────────────────────────
function extractContextKeywords(category, description, companyName) {
  var text = (category + ' ' + description).toLowerCase();
  var companyTokens = companyName.toLowerCase().split(/\s+/);
  var words = text.split(/[\s,.\-\/|()"'!?]+/);
  var seen = {};
  var keywords = [];
  words.forEach(function(word) {
    word = word.replace(/[^a-z]/g, '');
    if (word.length < 3) return;
    if (STOPWORDS.indexOf(word) !== -1) return;
    if (companyTokens.indexOf(word) !== -1) return;
    if (seen[word]) return;
    seen[word] = true;
    keywords.push(word);
  });
  return keywords;
}

// ── Charlotte OR business signal check ───────────────────────────────────────
// Every article must pass this — prevents generic names from matching off-topic coverage.
function hasLocationOrBusinessSignal(article, companyDomain) {
  var titleLow   = article.title.toLowerCase();
  var snippetLow = article.snippet.toLowerCase();
  var urlLow     = article.url.toLowerCase();
  var sourceLow  = (article.sourceUrl || '').toLowerCase();
  var haystack   = titleLow + ' ' + snippetLow;

  // Charlotte signal: mention of Charlotte/CLT or article from a CLT publication
  if (/\bcharlotte\b/.test(titleLow)   || /\bclt\b/.test(titleLow))   return true;
  if (/\bcharlotte\b/.test(snippetLow) || /\bclt\b/.test(snippetLow)) return true;
  var isCltSource = CLT_SOURCES.some(function(d) {
    return sourceLow.includes(d) || urlLow.includes(d);
  });
  if (isCltSource) return true;

  // Domain match counts as strong signal the article is actually about the company
  if (companyDomain && urlLow.includes(companyDomain)) return true;

  // Business/startup signal
  return BUSINESS_SIGNALS.some(function(kw) { return haystack.includes(kw); });
}

// ── Main fetch — batched ──────────────────────────────────────────────────────
function runPulseFetch() {
  try {
    var ss          = SpreadsheetApp.getActiveSpreadsheet();
    var sourceSheet = ss.getSheetByName(CONFIG.SOURCE_SHEET_NAME);
    var pulseSheet  = ensurePulseSheet(ss);

    if (!sourceSheet) {
      Logger.log('ERROR: Source sheet "' + CONFIG.SOURCE_SHEET_NAME + '" not found.');
      return;
    }

    var companies    = getApprovedCompanies(sourceSheet);
    var props        = PropertiesService.getScriptProperties();
    var startIdx     = parseInt(props.getProperty('pulseLastIdx') || '0');

    // Guard against stale index if company list shrank
    if (startIdx >= companies.length) startIdx = 0;

    var endIdx   = Math.min(startIdx + CONFIG.BATCH_SIZE, companies.length);
    var batch    = companies.slice(startIdx, endIdx);
    var isLastBatch = endIdx >= companies.length;

    Logger.log('Batch ' + startIdx + '–' + (endIdx - 1) + ' of ' + companies.length + ' companies.');

    var existingUrls = getExistingUrls(pulseSheet);
    var newRows      = [];

    batch.forEach(function(company) {
      var query1 = company.pulseQuery || ('"' + company.name + '"');
      var query2 = '"' + company.name + '" Charlotte';

      var siteClause = CLT_SOURCES.map(function(d) { return 'site:' + d; }).join(' OR ');
      var query3 = '"' + company.name + '" (' + siteClause + ')';

      var nameRegex       = new RegExp('\\b' + escapeRegex(company.name.toLowerCase()) + '\\b');
      var companySeenUrls = {};

      Logger.log(company.name + ' — context keywords: [' + company.contextKeywords.join(', ') + ']');

      var sources = [
        { fn: fetchGoogleNewsRSS, query: query1 },
        { fn: fetchGoogleNewsRSS, query: query2 },
        { fn: fetchGoogleNewsRSS, query: query3 }
      ];

      sources.forEach(function(source) {
        Utilities.sleep(CONFIG.SLEEP_MS);
        var articles = source.fn(source.query);
        articles.forEach(function(article) {
          if (existingUrls[article.url])    return;
          if (companySeenUrls[article.url]) return;

          var score = scoreArticle(article, company.name, company.domain);
          if (score < CONFIG.MIN_SCORE) return;

          // Hard: company name must appear in title or snippet
          if (!nameRegex.test(article.title.toLowerCase()) && !nameRegex.test(article.snippet.toLowerCase())) return;

          // Hard: Charlotte signal OR business/startup signal
          if (!hasLocationOrBusinessSignal(article, company.domain)) return;

          // Context keyword filter — applied to all companies that have keywords
          if (company.contextKeywords.length > 0) {
            var haystack = article.title.toLowerCase() + ' ' + article.snippet.toLowerCase();
            var hasContext = company.contextKeywords.some(function(kw) {
              return haystack.includes(kw);
            });
            if (!hasContext) return;
          }

          existingUrls[article.url]    = true;
          companySeenUrls[article.url] = true;
          newRows.push([
            company.name,
            article.title,
            article.url,
            article.source,
            article.sourceUrl,
            Utilities.formatDate(article.published, 'UTC', 'yyyy-MM-dd'),
            score,
            new Date().toISOString()
          ]);
        });
      });
    });

    if (newRows.length > 0) {
      var lastRow = Math.max(pulseSheet.getLastRow(), 1);
      pulseSheet.getRange(lastRow + 1, 1, newRows.length, NUM_COLS).setValues(newRows);
      Logger.log('Stored ' + newRows.length + ' new articles.');
    } else {
      Logger.log('No new articles found this batch.');
    }

    // Advance or reset checkpoint
    if (isLastBatch) {
      props.setProperty('pulseLastIdx', '0');
      Logger.log('Full cycle complete — checkpoint reset.');
      purgeOldArticles(pulseSheet);
    } else {
      props.setProperty('pulseLastIdx', endIdx.toString());
      Logger.log('Checkpoint saved at index ' + endIdx + '.');
    }

  } catch(e) {
    Logger.log('FATAL ERROR in runPulseFetch: ' + e);
  }
}

function getApprovedCompanies(sheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  var headers          = data[0].map(function(h) { return h.toString().toLowerCase().trim(); });
  var titleIdx         = headers.indexOf('title');
  var domainIdx        = headers.indexOf('domain');
  var linkIdx          = headers.indexOf('link');
  var statusIdx        = headers.indexOf('status');
  var categoryIdx      = headers.indexOf('category');
  var descriptionIdx   = headers.indexOf('description');
  var pulseQueryIdx    = headers.indexOf('pulse_query');
  var pulseKeywordsIdx = headers.indexOf('pulse_keywords');

  if (titleIdx === -1 || statusIdx === -1) {
    Logger.log('ERROR: Required columns (title, status) not found in source sheet.');
    return [];
  }

  var companies = [];
  var seen = {};

  for (var i = 1; i < data.length; i++) {
    var row    = data[i];
    var status = row[statusIdx] ? row[statusIdx].toString().toUpperCase().trim() : '';
    if (status !== 'APPROVED') continue;

    var name = row[titleIdx] ? row[titleIdx].toString().trim() : '';
    if (!name || seen[name.toLowerCase()]) continue;
    seen[name.toLowerCase()] = true;

    var domain = '';
    if (domainIdx !== -1 && row[domainIdx]) {
      domain = row[domainIdx].toString().trim().replace(/^https?:\/\//, '').split('/')[0];
    } else if (linkIdx !== -1 && row[linkIdx]) {
      domain = row[linkIdx].toString().trim().replace(/^https?:\/\//, '').split('/')[0];
    }

    var pulseQuery = pulseQueryIdx !== -1 && row[pulseQueryIdx]
      ? row[pulseQueryIdx].toString().trim() : '';

    var contextKeywords = [];
    var pulseKeywordsRaw = pulseKeywordsIdx !== -1 && row[pulseKeywordsIdx]
      ? row[pulseKeywordsIdx].toString().trim() : '';

    if (pulseKeywordsRaw) {
      contextKeywords = pulseKeywordsRaw.toLowerCase().split(',')
        .map(function(k) { return k.trim(); }).filter(Boolean);
    } else {
      var category    = categoryIdx !== -1    ? (row[categoryIdx]    || '').toString().trim() : '';
      var description = descriptionIdx !== -1 ? (row[descriptionIdx] || '').toString().trim() : '';
      contextKeywords = extractContextKeywords(category, description, name);
    }

    companies.push({ name: name, domain: domain, pulseQuery: pulseQuery, contextKeywords: contextKeywords });
  }

  return companies;
}

function fetchGoogleNewsRSS(query) {
  var url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(query) + '&hl=en-US&gl=US&ceid=US:en';
  try {
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      Logger.log('Non-200 for Google query: ' + query);
      return [];
    }
    return parseRSSFeed(response.getContentText());
  } catch(e) {
    Logger.log('Fetch error (Google) for "' + query + '": ' + e);
    return [];
  }
}

function parseRSSFeed(xmlContent) {
  var articles = [];
  try {
    var doc     = XmlService.parse(xmlContent);
    var channel = doc.getRootElement().getChild('channel');
    if (!channel) return [];
    channel.getChildren('item').forEach(function(item) {
      var article = parseRSSItem(item);
      if (article) articles.push(article);
    });
  } catch(e) {
    Logger.log('XML parse error: ' + e);
  }
  return articles;
}

function parseRSSItem(item) {
  try {
    var rawTitle = item.getChildText('title') || '';
    if (!rawTitle) return null;

    var url = '';
    var children = item.getChildren();
    for (var i = 0; i < children.length; i++) {
      if (children[i].getName() === 'link') {
        url = children[i].getText() || '';
        break;
      }
    }
    if (!url) url = item.getChildText('guid') || '';
    if (!url) return null;

    var snippet = (item.getChildText('description') || '')
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .trim()
      .substring(0, 300);

    var sourceEl   = item.getChild('source');
    var sourceName = sourceEl ? sourceEl.getText().trim() : '';
    var sourceUrl  = '';
    if (sourceEl) {
      try { sourceUrl = sourceEl.getAttribute('url').getValue(); } catch(e) {}
    }

    var published;
    try {
      published = new Date(item.getChildText('pubDate') || '');
      if (isNaN(published.getTime())) published = new Date();
    } catch(e) { published = new Date(); }

    if ((Date.now() - published.getTime()) / 86400000 > CONFIG.MAX_AGE_DAYS) return null;

    return {
      title:     cleanTitle(rawTitle, sourceName),
      url:       url,
      snippet:   snippet,
      source:    sourceName,
      sourceUrl: sourceUrl,
      published: published
    };
  } catch(e) {
    Logger.log('Error parsing RSS item: ' + e);
    return null;
  }
}

function cleanTitle(rawTitle, sourceName) {
  var t = rawTitle.trim();
  if (sourceName && t.endsWith(' - ' + sourceName)) {
    return t.slice(0, t.length - (' - ' + sourceName).length).trim();
  }
  return t.replace(/\s+-\s+[^-]+$/, '').trim();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scoreArticle(article, companyName, companyDomain) {
  var score      = 0;
  var titleLow   = article.title.toLowerCase();
  var snippetLow = article.snippet.toLowerCase();
  var urlLow     = article.url.toLowerCase();
  var nameLow    = companyName.toLowerCase();
  var domainLow  = (companyDomain || '').toLowerCase();
  var sourceLow  = (article.sourceUrl || '').toLowerCase();

  var nameRegex = new RegExp('\\b' + escapeRegex(nameLow) + '\\b');
  if (nameRegex.test(titleLow))   score += CONFIG.WEIGHTS.NAME_IN_TITLE;
  if (nameRegex.test(snippetLow)) score += CONFIG.WEIGHTS.NAME_IN_SNIPPET;

  if (domainLow) {
    if (urlLow.includes(domainLow))     score += CONFIG.WEIGHTS.DOMAIN_IN_URL;
    if (snippetLow.includes(domainLow)) score += CONFIG.WEIGHTS.DOMAIN_IN_SNIPPET;
  }

  if (/\bcharlotte\b/.test(titleLow)   || /\bclt\b/.test(titleLow))   score += CONFIG.WEIGHTS.CLT_IN_TITLE;
  if (/\bcharlotte\b/.test(snippetLow) || /\bclt\b/.test(snippetLow)) score += CONFIG.WEIGHTS.CLT_IN_SNIPPET;

  var isCltSource = CLT_SOURCES.some(function(domain) {
    return sourceLow.includes(domain) || urlLow.includes(domain);
  });
  if (isCltSource) score += CONFIG.WEIGHTS.CLT_SOURCE;

  var ageDays = (Date.now() - article.published.getTime()) / 86400000;
  if (ageDays <= 180)      score += CONFIG.WEIGHTS.WITHIN_6_MONTHS;
  else if (ageDays <= 365) score += CONFIG.WEIGHTS.WITHIN_1_YEAR;

  return score;
}

function ensurePulseSheet(ss) {
  var sheet = ss.getSheetByName(CONFIG.PULSE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.PULSE_SHEET_NAME);
    Logger.log('Created new sheet: ' + CONFIG.PULSE_SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['company', 'title', 'url', 'source', 'source_url', 'published', 'score', 'fetched']);
    sheet.getRange(1, 1, 1, NUM_COLS).setFontWeight('bold');
  }
  return sheet;
}

function getExistingUrls(pulseSheet) {
  var existing = {};
  var lastRow  = pulseSheet.getLastRow();
  if (lastRow < 2) return existing;
  pulseSheet.getRange(2, COLS.URL, lastRow - 1, 1).getValues().forEach(function(row) {
    if (row[0]) existing[row[0].toString().trim()] = true;
  });
  return existing;
}

function purgeOldArticles(pulseSheet) {
  var lastRow = pulseSheet.getLastRow();
  if (lastRow < 2) return;

  var headers       = pulseSheet.getRange(1, 1, 1, pulseSheet.getLastColumn()).getValues()[0];
  var sourceTypeCol = -1;
  for (var h = 0; h < headers.length; h++) {
    if (headers[h].toString().toLowerCase().trim() === 'source_type') { sourceTypeCol = h + 1; break; }
  }

  var numDataRows  = lastRow - 1;
  var cutoff       = new Date(Date.now() - CONFIG.MAX_AGE_DAYS * 86400000);
  var dates        = pulseSheet.getRange(2, COLS.PUBLISHED, numDataRows, 1).getValues();
  var sourceTypes  = sourceTypeCol !== -1
    ? pulseSheet.getRange(2, sourceTypeCol, numDataRows, 1).getValues()
    : [];

  var toDelete = [];
  for (var i = dates.length - 1; i >= 0; i--) {
    if (sourceTypeCol !== -1 && (sourceTypes[i][0] || '').toString().toLowerCase().trim() === 'manual') continue;
    var d = new Date(dates[i][0]);
    if (!isNaN(d.getTime()) && d < cutoff) toDelete.push(i + 2);
  }
  toDelete.forEach(function(rowNum) { pulseSheet.deleteRow(rowNum); });
  if (toDelete.length > 0) Logger.log('Purged ' + toDelete.length + ' old articles.');
}

// ── One-time cleanup — run once against existing Pulse sheet data ─────────────
// Applies the Charlotte/business signal filter to every stored row and deletes
// anything that wouldn't pass today. Skips manual and already-excluded rows.
// Snippet is not stored in the sheet, so signal check runs on title + URL only.
function cleanExistingPulse() {
  var ss         = SpreadsheetApp.getActiveSpreadsheet();
  var pulseSheet = ss.getSheetByName(CONFIG.PULSE_SHEET_NAME);
  if (!pulseSheet) { Logger.log('Pulse sheet not found.'); return; }

  var lastRow = pulseSheet.getLastRow();
  if (lastRow < 2) { Logger.log('No data rows to clean.'); return; }

  var numCols = pulseSheet.getLastColumn();
  var headers = pulseSheet.getRange(1, 1, 1, numCols).getValues()[0]
    .map(function(h) { return h.toString().toLowerCase().trim(); });

  function colIdx(name) { var i = headers.indexOf(name); return i === -1 ? -1 : i; } // 0-based
  var titleCol      = colIdx('title');
  var urlCol        = colIdx('url');
  var sourceUrlCol  = colIdx('source_url');
  var excludeCol    = colIdx('exclude');
  var sourceTypeCol = colIdx('source_type');

  if (titleCol === -1 || urlCol === -1) {
    Logger.log('ERROR: Required columns (title, url) not found.');
    return;
  }

  var allData = pulseSheet.getRange(2, 1, lastRow - 1, numCols).getValues();
  var kept = [];

  allData.forEach(function(row) {
    // Never touch manual entries
    if (sourceTypeCol !== -1 && (row[sourceTypeCol] || '').toString().toLowerCase().trim() === 'manual') {
      kept.push(row); return;
    }
    // Keep already-excluded rows (invisible in UI but preserve the record)
    if (excludeCol !== -1 && (row[excludeCol] || '').toString().toLowerCase().trim() === 'exclude') {
      kept.push(row); return;
    }

    var article = {
      title:     (row[titleCol] || '').toString(),
      url:       (row[urlCol] || '').toString(),
      snippet:   '',
      sourceUrl: sourceUrlCol !== -1 ? (row[sourceUrlCol] || '').toString() : ''
    };

    if (hasLocationOrBusinessSignal(article, '')) kept.push(row);
  });

  // Clear all data rows, rewrite only the keepers in one batch call
  pulseSheet.getRange(2, 1, lastRow - 1, numCols).clearContent();
  if (kept.length > 0) {
    pulseSheet.getRange(2, 1, kept.length, numCols).setValues(kept);
  }

  Logger.log('cleanExistingPulse: kept ' + kept.length + ' of ' + allData.length + ' rows (' + (allData.length - kept.length) + ' deleted).');
}

// ── Trigger setup — run once to install ──────────────────────────────────────
// Runs every 20 minutes. At 25 companies/batch and ~3 queries each,
// a full 700-company cycle completes in roughly 9-10 hours.
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'runPulseFetch') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runPulseFetch')
    .timeBased()
    .everyMinutes(20)
    .create();
  Logger.log('Trigger installed — runPulseFetch will run every 20 minutes.');
}

// ── Manual reset — run to restart the batch cycle from company 0 ─────────────
function resetBatchCheckpoint() {
  PropertiesService.getScriptProperties().setProperty('pulseLastIdx', '0');
  Logger.log('Batch checkpoint reset to 0.');
}
