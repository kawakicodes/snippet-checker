// Snippet Checker: checks page titles and meta descriptions the way they are likely to appear in Google.
// Works in the browser (window.SnippetChecker) and in Node (require('./checker.js')).
(function (root, factory) {
  var widths = (typeof module === 'object' && module.exports) ? require('./widths.js') : root.SNIPPET_WIDTHS;
  var api = factory(widths);
  if (typeof module === 'object' && module.exports) module.exports = api; else root.SnippetChecker = api;
})(this, function (W) {
  'use strict';

  var BOM = String.fromCharCode(0xFEFF);

  // Google publishes no length limit; it shortens titles and descriptions "as needed, typically to fit
  // the device width". About 600px of a desktop title (20px Arial) is the widely used estimate.
  // The common 920px description estimate equals only ~146 characters in today's 14px font, so
  // descriptions are judged on the character target and their width is shown for information only.
  var DEFAULTS = {
    titleMinChars: 30, titleMaxChars: 60, titleMaxPx: 600,
    descMinChars: 70, descMaxChars: 160, descMaxPx: 920,
    brand: '', nearDuplicate: 0.8, nearDuplicateLimit: 5000,
    firstRow: 2   // row number of the first data row, as shown in a spreadsheet with a header in row 1
  };
  var HYPE = /(^|[^\p{L}\p{N}])(best(?!\s+practi[cs]e)|no\.?\s?1|number one|#1|top[- ]rated|top[- ]ranked|cheapest|guaranteed|world[- ]class|unbeatable)(?![\p{L}\p{N}])/iu;
  var GENERIC = /^(home|homepage|home page|index|untitled|page|services|our services|about|about us|contact|contact us|blog|products?|new page|welcome)$/i;
  var STOP = { a: 1, an: 1, the: 1, and: 1, or: 1, of: 1, in: 1, for: 1, to: 1, on: 1, at: 1, with: 1, by: 1, from: 1,
               is: 1, are: 1, your: 1, our: 1, you: 1, we: 1, it: 1, this: 1, that: 1, '&': 1 };
  var DELIMS = [' | ', ' – ', ' — ', ' - ', ' : ', ' · ', ' • '];
  var CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;
  var WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;

  function chars(s) { return Array.from(s); }               // counts emoji and other symbols once
  function count(s) { return chars(s).length; }

  function charWidth(ch, kind) {
    var table = kind === 'desc' ? W.desc : W.title;
    var size = kind === 'desc' ? 14 : 20;
    if (table[ch] !== undefined) return table[ch];
    if (WIDE.test(ch)) return size;                         // CJK and full-width forms are one em wide
    if (/\p{Extended_Pictographic}/u.test(ch)) return size * 1.15;
    if (/[\u0900-\u0dff]/.test(ch)) return size * 0.44;      // Indic scripts (not in Arial; browser fallback)
    if (/[\u0300-\u036f\u200b-\u200f\ufe0f]/.test(ch)) return 0;   // combining marks, zero-width characters
    return kind === 'desc' ? W.descDefault : W.titleDefault;
  }
  function pixels(text, kind) {
    var total = 0;
    chars(text).forEach(function (ch) { total += charWidth(ch, kind); });
    return Math.round(total);
  }

  // The visible part of a text cut at maxPx with " ...", breaking between words where possible.
  function truncate(text, maxPx, kind) {
    if (pixels(text, kind) <= maxPx) return { text: text, cut: false };
    var ell = pixels(' ...', kind), used = 0, out = [];
    var list = chars(text);
    for (var i = 0; i < list.length; i++) {
      var w = charWidth(list[i], kind);
      if (used + w + ell > maxPx) break;
      used += w;
      out.push(list[i]);
    }
    var s = out.join('');
    var lastSpace = s.lastIndexOf(' ');
    if (lastSpace > s.length * 0.6) s = s.slice(0, lastSpace);
    return { text: s.replace(/[\s,;:|–—-]+$/, '') + ' ...', cut: true };
  }

  function clean(s) { return (s === null || s === undefined) ? '' : String(s); }
  function words(s) { return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []); }
  // Simple singular/plural matching: "services" ~ "service", "courses" ~ "course", "boxes" ~ "box".
  function forms(w) {
    var out = [w];
    if (w.length > 3) {
      if (/ies$/.test(w)) out.push(w.slice(0, -3) + 'y');
      if (/es$/.test(w)) out.push(w.slice(0, -2));
      if (/s$/.test(w) && !/ss$/.test(w)) out.push(w.slice(0, -1));
    }
    return out;
  }
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function wholeWord(phrase, flags) {
    return new RegExp('(?<![\\p{L}\\p{N}])' + escapeRe(phrase) + '(?![\\p{L}\\p{N}])', flags || 'giu');
  }

  function coverage(keyword, text) {
    var kw = keyword.trim();
    if (!kw) return { terms: 0 };
    if (CJK.test(kw)) {                                      // no spaces between words: match the phrase itself
      var flat = text.replace(/\s+/g, ''), k = kw.replace(/\s+/g, '');
      var at = flat.indexOf(k);
      return { terms: 1, found: at >= 0 ? 1 : 0, early: at >= 0 && at <= flat.length / 2 };
    }
    var terms = words(kw).filter(function (w) { return !STOP[w]; });
    if (!terms.length) return { terms: 0 };
    var tw = words(text), have = {}, firstAt = -1;
    tw.forEach(function (w, i) { forms(w).forEach(function (f) { if (have[f] === undefined) have[f] = i; }); });
    var found = 0;
    terms.forEach(function (t) {
      var pos = forms(t).map(function (f) { return have[f]; }).filter(function (p) { return p !== undefined; });
      if (pos.length) { found++; var p = Math.min.apply(null, pos); if (firstAt < 0 || p < firstAt) firstAt = p; }
    });
    return { terms: terms.length, found: found, early: firstAt >= 0 && firstAt <= Math.max(3, tw.length / 2) };
  }

  function tokenSet(text) {
    var set = new Set();
    words(text).forEach(function (w) { if (!STOP[w]) set.add(w); });
    return set;
  }
  function brandDelimiter(title, brand) {
    if (!brand) return null;
    var low = title.toLowerCase(), b = brand.toLowerCase();
    for (var i = 0; i < DELIMS.length; i++) {
      var d = DELIMS[i];
      if (low.indexOf(d + b) >= 0 || low.indexOf(b + d) >= 0) return d.trim();
    }
    return null;
  }
  function issue(list, field, level, code, msg) { list.push({ field: field, level: level, code: code, msg: msg }); }

  function checkRow(row, o, rowNumber) {
    var title = clean(row.title), desc = clean(row.description), kw = clean(row.keyword).trim();
    var t = title.trim().replace(/\s+/g, ' '), d = desc.trim().replace(/\s+/g, ' '), list = [];
    var tPx = pixels(t, 'title'), dPx = pixels(d, 'desc'), tLen = count(t), dLen = count(d);
    var brandRe = o.brand ? wholeWord(o.brand) : null;
    var brandCount = brandRe ? (t.match(brandRe) || []).length : 0;
    var noBrand = brandRe ? t.replace(brandRe, ' ') : t;        // title without the brand, for wording checks
    var plain = kw ? noBrand.replace(wholeWord(kw), ' ') : noBrand;

    // ----- title
    if (!t) {
      issue(list, 'title', 'fail', 'title-missing', 'No title. Google will write one from the page.');
    } else {
      if (tPx > o.titleMaxPx) issue(list, 'title', 'fail', 'title-cut', 'Likely to be cut off in Google: ' + tPx + 'px wide, and about ' + o.titleMaxPx + 'px is usually shown.');
      else if (tLen > o.titleMaxChars) issue(list, 'title', 'warn', 'title-long', tLen + ' characters, over your ' + o.titleMaxChars + ' target (it still fits: ' + tPx + 'px).');
      if (tLen < o.titleMinChars) issue(list, 'title', 'warn', 'title-short', 'Only ' + tLen + ' characters. A short title says little about the page.');
      var parts = noBrand.split(/\s[|–—\-:·•]\s/).map(function (p) { return p.trim(); }).filter(Boolean);
      if (parts.length && parts.every(function (p) { return GENERIC.test(p); })) issue(list, 'title', 'warn', 'title-generic', '"' + t + '" is too generic to tell searchers what the page is.');
      if (o.brand && brandCount === 0) issue(list, 'title', 'warn', 'title-brand', 'Brand "' + o.brand + '" is missing.');
      if (brandCount > 1) issue(list, 'title', 'warn', 'title-brand-twice', 'The brand "' + o.brand + '" appears ' + brandCount + ' times; once is enough.');
      if (o.brand && brandCount && !noBrand.replace(/[\s|–—\-:·•]+/g, '')) issue(list, 'title', 'fail', 'title-brand-only', 'The title is only the brand name.');
      if (/[\[\]{}]/.test(t)) issue(list, 'title', 'info', 'title-brackets', 'Contains brackets; check they read naturally.');
      if (/\b[A-Z]{2,}\b(?:\s+\b[A-Z]{2,}\b){2,}/.test(plain)) issue(list, 'title', 'warn', 'title-caps', 'Several words in CAPITALS read as shouting.');
      if (/(?<!(?:over|than|since|\d)\s)(?<![\d:/.-])\b(19[5-9]\d|20[0-4]\d)\b(?![\d:/.-])/i.test(t)) issue(list, 'title', 'info', 'title-year', 'Contains a year: remember to update it.');
      var ws = words(noBrand), rep = null;
      for (var i = 0; i < ws.length && !rep; i++) {
        if (ws[i].length < 3 || STOP[ws[i]] || /^\d+$/.test(ws[i])) continue;
        for (var j = i + 1; j <= i + 4 && j < ws.length; j++) if (ws[j] === ws[i]) { rep = ws[i]; break; }
      }
      if (rep) issue(list, 'title', 'info', 'title-repeat', 'The word "' + rep + '" appears twice close together.');
    }
    // ----- description
    if (!d) {
      issue(list, 'desc', 'fail', 'desc-missing', 'No description. Google will pick text from the page instead.');
    } else {
      if (dLen > o.descMaxChars) issue(list, 'desc', 'warn', 'desc-long', dLen + ' characters, over your ' + o.descMaxChars + ' target, so the end is likely to be cut off.');
      if (dLen < o.descMinChars) issue(list, 'desc', 'warn', 'desc-short', 'Only ' + dLen + ' characters. Give searchers a reason to click.');
      if (t && d.toLowerCase() === t.toLowerCase()) issue(list, 'desc', 'warn', 'desc-same-as-title', 'The description just repeats the title.');
    }
    // ----- wording, in both (brand and keyword are removed first so they are never reported as hype)
    var descPlain = o.brand ? desc.replace(wholeWord(o.brand), ' ') : desc;
    if (kw) descPlain = descPlain.replace(wholeWord(kw), ' ');
    [['title', title, plain], ['desc', desc, descPlain]].forEach(function (p) {
      if (!p[1].trim()) return;
      if (/ {2,}/.test(p[1].trim()) || p[1] !== p[1].trim()) issue(list, p[0], 'info', p[0] + '-spaces', 'Extra or double spaces.');
      var h = HYPE.exec(p[2]);
      if (h) issue(list, p[0], 'warn', p[0] + '-hype', '"' + h[2] + '" is a claim that needs proof; avoid it unless you can back it up.');
      if (/&(amp|quot|nbsp|#\d+);|<\/?[a-z][^>]*>/i.test(p[1])) issue(list, p[0], 'warn', p[0] + '-markup', 'Contains HTML code or an encoded character such as &amp;amp;.');
    });
    // ----- keyword
    if (kw) {
      var ct = coverage(kw, t), cd = coverage(kw, d);
      if (ct.terms && t) {
        if (ct.found < Math.ceil(ct.terms / 2)) issue(list, 'title', 'warn', 'kw-title', 'Main keyword "' + kw + '" is missing from the title.');
        else if (!ct.early) issue(list, 'title', 'info', 'kw-late', 'Main keyword appears late in the title; consider moving it nearer the start.');
      }
      if (cd.terms && d && cd.found < Math.ceil(cd.terms / 2)) issue(list, 'desc', 'info', 'kw-desc', 'Main keyword is not in the description.');
    }
    return {
      row: rowNumber, url: clean(row.url).trim(), keyword: kw, title: title, description: desc,
      titleChars: tLen, descChars: dLen, titlePx: tPx, descPx: dPx,
      titlePreview: truncate(t, o.titleMaxPx, 'title'),
      descPreview: dLen > o.descMaxChars ? { text: chars(d).slice(0, o.descMaxChars).join('').replace(/\s+\S*$/, '') + ' ...', cut: true } : { text: d, cut: false },
      issues: list
    };
  }

  function rowList(nums) {
    return 'row' + (nums.length > 1 ? 's ' : ' ') + nums.slice(0, 5).join(', ') + (nums.length > 5 ? ' and ' + (nums.length - 5) + ' more' : '');
  }

  // Check every row, then the checks that compare rows with each other.
  function check(rows, options) {
    var o = {};
    for (var k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in (options || {})) if (options[k] !== undefined && options[k] !== null && options[k] !== '') o[k] = options[k];
    o.brand = clean(o.brand).trim();
    var results = rows.map(function (r, i) {
      return checkRow(r, o, typeof r.row === 'number' ? r.row : i + o.firstRow);
    });
    var notes = [];

    [['title', 'title'], ['desc', 'description']].forEach(function (f) {
      var map = new Map();
      results.forEach(function (r, i) {
        var v = r[f[1]].trim().toLowerCase().replace(/\s+/g, ' ');
        if (v) { if (!map.has(v)) map.set(v, []); map.get(v).push(i); }
      });
      map.forEach(function (idx) {
        if (idx.length < 2) return;
        idx.forEach(function (i) {
          var others = idx.filter(function (j) { return j !== i; }).map(function (j) { return results[j].row; });
          issue(results[i].issues, f[0], 'fail', f[0] + '-duplicate', 'Same ' + (f[0] === 'title' ? 'title' : 'description') + ' as ' + rowList(others) + '. Every page needs its own.');
        });
      });
    });

    // Near-duplicate descriptions: word sets are built once, and each pair stops early once it cannot reach the threshold.
    var withDesc = results.map(function (r, i) { return { i: i, d: r.description.trim() }; }).filter(function (x) { return x.d; });
    if (withDesc.length > o.nearDuplicateLimit) {
      notes.push('The "almost the same description" check was skipped because there are more than ' + o.nearDuplicateLimit + ' descriptions.');
    } else {
      var sets = withDesc.map(function (x) { return tokenSet(x.d); });
      var lower = withDesc.map(function (x) { return x.d.toLowerCase(); });
      var near = withDesc.map(function () { return []; });
      for (var a = 0; a < withDesc.length; a++) {
        var sa = sets[a];
        if (!sa.size) continue;
        for (var b = a + 1; b < withDesc.length; b++) {
          var sb = sets[b];
          if (!sb.size || lower[a] === lower[b]) continue;
          var big = Math.max(sa.size, sb.size), small = Math.min(sa.size, sb.size);
          if (small < big * o.nearDuplicate) continue;          // cannot reach the threshold
          var need = Math.ceil(big * o.nearDuplicate), x = sa.size <= sb.size ? sa : sb, y = x === sa ? sb : sa;
          var shared = 0, left = x.size;
          for (var w of x) { if (y.has(w)) shared++; left--; if (shared + left < need) break; }
          if (shared >= need) { near[a].push(results[withDesc[b].i].row); near[b].push(results[withDesc[a].i].row); }
        }
      }
      near.forEach(function (list, n) {
        if (list.length) issue(results[withDesc[n].i].issues, 'desc', 'warn', 'desc-near-duplicate', 'Almost the same description as ' + rowList(list) + '. Make each one specific to its page.');
      });
    }

    if (o.brand) {
      var seen = {};
      results.forEach(function (r) { var d = brandDelimiter(r.title, o.brand); if (d) seen[d] = (seen[d] || 0) + 1; });
      var kinds = Object.keys(seen).sort(function (x, y) { return seen[y] - seen[x]; });
      if (kinds.length > 1 && seen[kinds[0]] > seen[kinds[1]]) {
        results.forEach(function (r) {
          var d = brandDelimiter(r.title, o.brand);
          if (d && d !== kinds[0]) issue(r.issues, 'title', 'info', 'brand-separator', 'Uses "' + d + '" next to the brand; most titles use "' + kinds[0] + '". Pick one and use it everywhere.');
        });
      }
    }
    results.forEach(function (r) {
      var penalty = r.issues.reduce(function (s, i) { return s + (i.level === 'fail' ? 25 : i.level === 'warn' ? 10 : 2); }, 0);
      r.score = Math.max(0, 100 - penalty);
      r.status = r.issues.some(function (i) { return i.level === 'fail'; }) ? 'fail'
        : r.issues.some(function (i) { return i.level === 'warn'; }) ? 'warn' : 'pass';
    });
    return { options: o, rows: results, summary: summarise(results), notes: notes };
  }

  function summarise(results) {
    var s = { rows: results.length, pass: 0, warn: 0, fail: 0, issues: 0, byCode: {} };
    results.forEach(function (r) {
      s[r.status]++;
      s.issues += r.issues.length;
      r.issues.forEach(function (i) { s.byCode[i.code] = (s.byCode[i.code] || 0) + 1; });
    });
    var c = function (k) { return s.byCode[k] || 0; };
    s.titlesCut = c('title-cut'); s.descsOver = c('desc-long'); s.missingTitles = c('title-missing');
    s.missingDescs = c('desc-missing'); s.duplicateTitles = c('title-duplicate'); s.duplicateDescs = c('desc-duplicate');
    s.averageScore = results.length ? Math.round(results.reduce(function (t, r) { return t + r.score; }, 0) / results.length) : 0;
    return s;
  }

  // ----- reading spreadsheets (CSV, or text pasted from Excel / Google Sheets)
  // Returns rows of cells. Blank rows inside the data are kept (as empty arrays) so row numbers
  // match the spreadsheet; blank rows at the very start are counted in table.skipped.
  function parseDelimited(text) {
    text = clean(text);
    if (text.charAt(0) === BOM) text = text.slice(1);
    var firstLine = (text.match(/^[^\r\n]*/) || [''])[0];
    var counts = { '\t': firstLine.split('\t').length - 1, ';': firstLine.split(';').length - 1, ',': firstLine.split(',').length - 1 };
    var delim = counts['\t'] && counts['\t'] >= counts[','] ? '\t' : (counts[';'] > counts[','] ? ';' : (counts[','] ? ',' : null));
    var rows = [], row = [], field = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
        else field += c;
      } else if (c === '"' && field === '') q = true;
      else if (delim && c === delim) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    var blank = function (r) { return !r.some(function (v) { return v.trim() !== ''; }); };
    var skipped = 0;
    while (rows.length && blank(rows[0])) { rows.shift(); skipped++; }
    while (rows.length && blank(rows[rows.length - 1])) rows.pop();
    rows = rows.map(function (r) { return blank(r) ? [] : r; });
    rows.skipped = skipped;
    return rows;
  }

  var HEADER_WORDS = /\b(url|uri|address|adresse|page|pagina|página|seite|link|slug|path|keyword|keyphrase|keywords?|query|title|titel|titre|titolo|título|description|desc|metadesc|beschreibung|descripción|descrizione|snippet)\b|タイトル|説明|ページ|标题|描述|页面|शीर्षक|विवरण/i;
  function headerText(v) { return clean(v).trim().replace(/[_.]+/g, ' '); }
  // A header row names columns ("URL", "Meta_Title"...); a data row holds addresses and sentences.
  function looksLikeHeader(row) {
    var cells = row.map(headerText);
    if (cells.some(function (v) { return /^(\/|https?:\/\/|www\.)/i.test(v); })) return false;
    return cells.some(function (v) { return v.length <= 50 && v.split(/\s+/).length <= 6 && HEADER_WORDS.test(v); });
  }

  // Guess which columns hold what. Prefers optimised/new/SEO columns over old or product-name columns.
  function guessColumns(header) {
    var names = header.map(headerText);
    var cols = { url: -1, keyword: -1, title: -1, description: -1 };
    function rank(i, field) {
      var n = names[i].toLowerCase(), s = 0;
      if (/(length|count|chars?|characters|width|px|pixels?)\b/.test(n)) return -1;
      if (field === 'url') return /^(url|uri|address|adresse|page url|landing page|link|permalink|slug|path|page|seite|página|pagina|ページ|页面)$/.test(n) ? 10 : (/\burl\b|address|permalink/.test(n) ? 5 : -1);
      if (field === 'keyword') {
        if (/meta keywords?/.test(n)) return -1;
        if (/focus|primary|main|target|keyphrase/.test(n)) s += 5;
        return /keyword|keyphrase|focuskw|focus kw|query|\bterm\b/.test(n) ? 5 + s : -1;
      }
      var hit = field === 'title' ? /title|titel|titre|titolo|título|タイトル|标题|शीर्षक/.test(n) && !/\bh1\b|og |twitter/.test(n)
        : /description|desc\b|metadesc|snippet|beschreibung|descripción|descrizione|説明|描述|विवरण/.test(n);
      if (!hit) return -1;
      if (field === 'description' && /short description|long description|product description|^description$/.test(n) && !/meta|seo/.test(n)) s -= 3;
      if (field === 'title' && /^(title|product|name|post title)$/.test(n)) s -= 1;
      if (/seo|meta|yoast|rank ?math/.test(n)) s += 3;
      if (/\bnew\b|final|updated|proposed|after|optimi[sz]ed|suggested|recommended/.test(n)) s += 4;
      if (/\bold\b|current|existing|before|original/.test(n)) s -= 4;
      if (/\b1$/.test(n)) s += 1;               // "Title 1" in crawler exports
      return 10 + s;
    }
    var options = { title: [], description: [] };
    ['url', 'keyword', 'title', 'description'].forEach(function (f) {
      var best = -1, bestScore = -1;
      names.forEach(function (n, i) {
        var r = rank(i, f);
        if (r > bestScore && Object.keys(cols).every(function (g) { return cols[g] !== i; })) { best = i; bestScore = r; }
        if ((f === 'title' || f === 'description') && r >= 0) options[f].push(i);
      });
      cols[f] = best;
    });
    return { columns: cols, titleOptions: options.title, descriptionOptions: options.description };
  }

  // Turn table rows into {row, url, keyword, title, description}, keeping the spreadsheet row number.
  function toRows(dataRows, columns, firstRow) {
    var start = typeof firstRow === 'number' ? firstRow : 2;
    return dataRows.map(function (r, n) {
      function get(i) { return i >= 0 && i < r.length ? r[i] : ''; }
      return { row: start + n, url: get(columns.url), keyword: get(columns.keyword), title: get(columns.title), description: get(columns.description) };
    }).filter(function (r) { return [r.url, r.title, r.description].some(function (v) { return clean(v).trim(); }); });
  }

  function toCsv(result) {
    var q = function (v) {
      var s = clean(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // stop spreadsheets running the cell as a formula
      return '"' + s.replace(/"/g, '""') + '"';
    };
    var head = ['Row', 'URL', 'Keyword', 'Title', 'Title characters', 'Title width (px)', 'Description', 'Description characters',
                'Description width (px)', 'Score', 'Status', 'Issues'];
    var label = { pass: 'Fine', warn: 'To improve', fail: 'Fail' };
    var lines = [head.map(q).join(',')];
    result.rows.forEach(function (r) {
      lines.push([r.row, r.url, r.keyword, r.title, r.titleChars, r.titlePx, r.description, r.descChars, r.descPx, r.score, label[r.status],
        r.issues.map(function (i) { return '[' + ({ fail: 'Fail', warn: 'Fix', info: 'Note' })[i.level] + '] ' + i.msg; }).join(' | ')].map(q).join(','));
    });
    return BOM + lines.join('\r\n');
  }

  return { DEFAULTS: DEFAULTS, pixels: pixels, truncate: truncate, check: check, parseDelimited: parseDelimited,
           guessColumns: guessColumns, looksLikeHeader: looksLikeHeader, toRows: toRows, toCsv: toCsv, count: count };
});
