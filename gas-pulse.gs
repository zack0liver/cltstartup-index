// ============================================================
// CLTStartups — Pulse News Fetcher
// Google Apps Script
// ============================================================

var CONFIG = {
  SPREADSHEET_ID:    'YOUR_SPREADSHEET_ID_HERE',
  SOURCE_SHEET_NAME: 'Live Startups',
  PULSE_SHEET_NAME:  'Pulse',
  SLEEP_MS:          1500,
  MIN_SCORE:         50,
  MAX_AGE_DAYS:      365,
  WEIGHTS: {
    NAME_IN_TITLE:     50,
    NAME_IN_SNIPPET:   25,
    DOMAIN_IN_URL:     20,
    DOMAIN_IN_SNIPPET: 10,
    CLT_IN_TITLE:      15,
    CLT_IN_SNIPPET:     8,
    WITHIN_6_MONTHS:   10,
    WITHIN_1_YEAR:      5
  }
};

var COLS = { COMPANY: 1, TITLE: 2, URL: 3, SOURCE: 4, SOURCE_URL: 5, PUBLISHED: 6, SCORE: 7, FETCHED: 8 };
var NUM_COLS = 8;

function runPulseFetch() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    var sourceSheet = ss.getSheetByName(CONFIG.SOURCE_SHEET_NAME);
    var pulseSheet  = ensurePulseSheet(ss);

    if (!sourceSheet) {
      Logger.log('ERROR: Source sheet "' + CONFIG.SOURCE_SHEET_NAME + '" not found.');
      return;
    }

    var companies    = getApprovedCompanies(sourceSheet);
    var existingUrls = getExistingUrls(pulseSheet);
    var newRows      = [];

    Logger.log('Processing ' + companies.length + ' approved companies...');

    companies.forEach(function(company) {
      var queries = ['"' + company.name + '" Charlotte'];
      var nameRegex = new RegExp('\\b' + escapeRegex(company.name.toLowerCase()) + '\\b');

      queries.forEach(function(query) {
        Utilities.sleep(CONFIG.SLEEP_MS);
        var articles = fetchGoogleNewsRSS(query);
        articles.forEach(function(article) {
          if (existingUrls[article.url]) return;
          var score = scoreArticle(article, company.name, company.domain);
          if (score < CONFIG.MIN_SCORE) return;
          if (!nameRegex.test(article.title.toLowerCase()) && !nameRegex.test(article.snippet.toLowerCase())) return;
          existingUrls[article.url] = true;
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
      Logger.log('No new articles found this run.');
    }

    purgeOldArticles(pulseSheet);

  } catch(e) {
    Logger.log('FATAL ERROR in runPulseFetch: ' + e);
  }
}

function getApprovedCompanies(sheet) {
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];

  var headers   = data[0].map(function(h) { return h.toString().toLowerCase().trim(); });
  var titleIdx  = headers.indexOf('title');
  var domainIdx = headers.indexOf('domain');
  var linkIdx   = headers.indexOf('link');
  var statusIdx = headers.indexOf('status');

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

    companies.push({ name: name, domain: domain });
  }

  return companies;
}

function fetchGoogleNewsRSS(query) {
  var url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(query) + '&hl=en-US&gl=US&ceid=US:en';
  try {
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) {
      Logger.log('Non-200 for query: ' + query);
      return [];
    }
    return parseRSSFeed(response.getContentText());
  } catch(e) {
    Logger.log('Fetch error for "' + query + '": ' + e);
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

  var nameRegex = new RegExp('\\b' + escapeRegex(nameLow) + '\\b');
  if (nameRegex.test(titleLow))   score += CONFIG.WEIGHTS.NAME_IN_TITLE;
  if (nameRegex.test(snippetLow)) score += CONFIG.WEIGHTS.NAME_IN_SNIPPET;

  if (domainLow) {
    if (urlLow.includes(domainLow))     score += CONFIG.WEIGHTS.DOMAIN_IN_URL;
    if (snippetLow.includes(domainLow)) score += CONFIG.WEIGHTS.DOMAIN_IN_SNIPPET;
  }

  if (/\bcharlotte\b/.test(titleLow)   || /\bclt\b/.test(titleLow))   score += CONFIG.WEIGHTS.CLT_IN_TITLE;
  if (/\bcharlotte\b/.test(snippetLow) || /\bclt\b/.test(snippetLow)) score += CONFIG.WEIGHTS.CLT_IN_SNIPPET;

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
  var cutoff   = new Date(Date.now() - CONFIG.MAX_AGE_DAYS * 86400000);
  var dates    = pulseSheet.getRange(2, COLS.PUBLISHED, lastRow - 1, 1).getValues();
  var toDelete = [];
  for (var i = dates.length - 1; i >= 0; i--) {
    var d = new Date(dates[i][0]);
    if (!isNaN(d.getTime()) && d < cutoff) toDelete.push(i + 2);
  }
  toDelete.forEach(function(rowNum) { pulseSheet.deleteRow(rowNum); });
  if (toDelete.length > 0) Logger.log('Purged ' + toDelete.length + ' old articles.');
}

function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'runPulseFetch') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runPulseFetch')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();
  Logger.log('Daily trigger installed — runPulseFetch will run at ~6 AM UTC each day.');
}
