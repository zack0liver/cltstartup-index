/* ============================================================
 * CLTStartups — shared filter helpers (index.html + pulse.html)
 * Loaded on both pages so the Startups/Ecosystem toggle, title
 * dedup, and escaping behave identically. Also exports for Node
 * so the dedup logic is unit-testable (pulse-logic-test.js style).
 * ============================================================ */
(function (global) {
  'use strict';

  // A record is an "ecosystem support org" when its category is Ecosystem.
  // Kept as a single constant so the definition can widen later without
  // hunting through both pages.
  var ECOSYSTEM_CATEGORY = 'ecosystem';

  function isEcosystem(category) {
    return String(category || '').trim().toLowerCase() === ECOSYSTEM_CATEGORY;
  }

  function escHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Title-similarity dedup ──────────────────────────────────
  // Same story syndicated under different URLs ⇒ near-identical titles.
  function normalizeTitle(t) {
    return String(t || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenSet(t) {
    var set = Object.create(null);
    normalizeTitle(t).split(' ').forEach(function (w) { if (w) set[w] = true; });
    return set;
  }

  // Jaccard token overlap, 0..1.
  function titleSimilarity(a, b) {
    var sa = tokenSet(a), sb = tokenSet(b);
    var ka = Object.keys(sa), kb = Object.keys(sb);
    if (!ka.length || !kb.length) return 0;
    var inter = 0;
    ka.forEach(function (w) { if (sb[w]) inter++; });
    var union = ka.length + kb.length - inter;
    return union ? inter / union : 0;
  }

  // Collapse near-duplicate titles, keeping the highest score.
  // Assumes the list is already URL-deduped. O(n²) but n is small (the
  // display set is at most a few hundred rows).
  function dedupeByTitle(items, opts) {
    opts = opts || {};
    var threshold = opts.threshold != null ? opts.threshold : 0.9;
    var titleKey = opts.titleKey || 'title';
    var scoreKey = opts.scoreKey || 'score';
    var kept = [];
    items.forEach(function (item) {
      for (var i = 0; i < kept.length; i++) {
        if (titleSimilarity(item[titleKey], kept[i][titleKey]) >= threshold) {
          if ((+item[scoreKey] || 0) > (+kept[i][scoreKey] || 0)) kept[i] = item;
          return; // duplicate — folded into an existing card
        }
      }
      kept.push(item);
    });
    return kept;
  }

  // ── Segmented Startups / Ecosystem toggle ───────────────────
  // buildToggle(el, { active, onChange, options }) → { get, set }.
  function buildToggle(container, opts) {
    opts = opts || {};
    if (typeof container === 'string') container = document.getElementById(container);
    if (!container) return { get: function () {}, set: function () {} };

    var options = opts.options || [
      { value: 'startups',  label: 'Startups' },
      { value: 'ecosystem', label: 'Ecosystem' }
    ];
    var active = opts.active || options[0].value;

    if (container.className.indexOf('pf-toggle') === -1) {
      container.className = (container.className ? container.className + ' ' : '') + 'pf-toggle';
    }
    container.setAttribute('role', 'tablist');

    function render() {
      container.innerHTML = options.map(function (o) {
        return '<button type="button" role="tab" data-value="' + escHtml(o.value) +
          '" class="pf-toggle-btn' + (o.value === active ? ' active' : '') + '">' +
          escHtml(o.label) + '</button>';
      }).join('');
      Array.prototype.forEach.call(container.querySelectorAll('.pf-toggle-btn'), function (btn) {
        btn.onclick = function () {
          if (active === btn.getAttribute('data-value')) return;
          active = btn.getAttribute('data-value');
          render();
          if (opts.onChange) opts.onChange(active);
        };
      });
    }
    render();

    return {
      get: function () { return active; },
      set: function (v) { active = v; render(); }
    };
  }

  var api = {
    ECOSYSTEM_CATEGORY: ECOSYSTEM_CATEGORY,
    isEcosystem: isEcosystem,
    escHtml: escHtml,
    normalizeTitle: normalizeTitle,
    titleSimilarity: titleSimilarity,
    dedupeByTitle: dedupeByTitle,
    buildToggle: buildToggle
  };

  global.PulseFilters = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
