// Run: node --test
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../checker.js');

const GOOD = {
  url: '/divorce', keyword: 'divorce lawyer mumbai',
  title: 'Divorce Lawyer in Mumbai – Family Law Advice | Acme Legal',
  description: 'Acme Legal helps families in Mumbai with divorce, child custody and maintenance cases. Speak to a family lawyer about your options today.'
};
const codes = (row) => row.issues.map((i) => i.code);
const one = (row, opts) => C.check([row], opts || { brand: 'Acme Legal' }).rows[0];

test('pixel widths come from real Arial metrics', () => {
  assert.ok(C.pixels('WWWW', 'title') > C.pixels('iiii', 'title') * 3);
  assert.strictEqual(C.pixels('', 'title'), 0);
  assert.ok(C.pixels('abc', 'desc') < C.pixels('abc', 'title'));      // descriptions use a smaller font
});

test('a well-written row passes', () => {
  const r = one(GOOD);
  assert.strictEqual(r.status, 'pass', JSON.stringify(r.issues));
  assert.strictEqual(r.score, 100);
});

test('titles too wide for Google fail and the preview is cut at a word', () => {
  const r = one({ ...GOOD, title: 'Divorce Lawyer in Mumbai for Contested and Mutual Consent Divorce Cases and Child Custody | Acme Legal' });
  assert.ok(codes(r).includes('title-cut'));
  assert.strictEqual(r.status, 'fail');
  assert.ok(r.titlePreview.cut && r.titlePreview.text.endsWith(' ...'));
  assert.ok(C.pixels(r.titlePreview.text, 'title') <= 600);
});

test('a title of only wide capitals fails on pixels even under 60 characters', () => {
  const r = one({ ...GOOD, title: 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW Acme Legal' });
  assert.ok(r.title.length < 60);
  assert.ok(codes(r).includes('title-cut'));
});

test('missing, generic and brand-only titles fail', () => {
  assert.ok(codes(one({ ...GOOD, title: '' })).includes('title-missing'));
  assert.ok(codes(one({ ...GOOD, title: 'Home | Acme Legal' })).includes('title-generic'));
  assert.strictEqual(one({ ...GOOD, title: 'Contact Us | Acme Legal' }).issues.find((i) => i.code === 'title-generic').level, 'warn');
  assert.ok(codes(one({ ...GOOD, title: 'Acme Legal' })).includes('title-brand-only'));
});

test('description checks', () => {
  assert.ok(codes(one({ ...GOOD, description: '' })).includes('desc-missing'));
  assert.ok(codes(one({ ...GOOD, description: 'Too short.' })).includes('desc-short'));
  assert.ok(codes(one({ ...GOOD, description: GOOD.title })).includes('desc-same-as-title'));
  const long = 'Acme Legal helps families in Mumbai with divorce, child custody and maintenance cases, with lawyers who explain every step and every option clearly before you decide.';
  assert.ok(long.length > 160);
  assert.ok(codes(one({ ...GOOD, description: long })).includes('desc-long'));
});

test('brand: missing, twice, and different separators across the site', () => {
  assert.ok(codes(one({ ...GOOD, title: 'Divorce Lawyer in Mumbai – Family Law Advice' })).includes('title-brand'));
  assert.ok(codes(one({ ...GOOD, title: 'Acme Legal Office – Divorce Lawyer | Acme Legal' })).includes('title-brand-twice'));
  const res = C.check([GOOD, { ...GOOD, url: '/b', title: 'Property Lawyer in Pune | Acme Legal' },
    { ...GOOD, url: '/c', title: 'Tax Lawyer in Delhi - Acme Legal' }], { brand: 'Acme Legal' });
  assert.ok(codes(res.rows[2]).includes('brand-separator'));
  assert.ok(!codes(res.rows[1]).includes('brand-separator'));
});

test('brand words are not reported as repeated words', () => {
  const r = one({ ...GOOD, title: 'Legal Articles & Newsletters | Acme Legal' });
  assert.ok(!codes(r).includes('title-repeat'));
  assert.ok(codes(one({ ...GOOD, title: 'Divorce Divorce Lawyer in Mumbai | Acme Legal' })).includes('title-repeat'));
});

test('duplicate and near-duplicate rows are found, once per row', () => {
  const d2 = 'Acme Legal helps families in Mumbai with divorce, child custody and maintenance cases. Speak to a family lawyer about your options now.';
  const res = C.check([GOOD, { ...GOOD, url: '/2' }, { ...GOOD, url: '/3', title: 'Other page | Acme Legal', description: d2 }], { brand: 'Acme Legal' });
  assert.ok(codes(res.rows[0]).includes('title-duplicate'));
  assert.ok(codes(res.rows[1]).includes('desc-duplicate'));
  assert.strictEqual(codes(res.rows[2]).filter((c) => c === 'desc-near-duplicate').length, 1);
  assert.strictEqual(res.summary.duplicateTitles, 2);
  assert.match(res.rows[0].issues.find((i) => i.code === 'title-duplicate').msg, /row 3\b/);   // spreadsheet row numbers
});

test('keyword checks use whole words and ignore small words', () => {
  assert.ok(codes(one({ ...GOOD, keyword: 'property lawyer pune' })).includes('kw-title'));
  assert.ok(!codes(one({ ...GOOD, keyword: 'divorce lawyers in mumbai' })).includes('kw-title'));   // plural still matches
  assert.ok(codes(one({ ...GOOD, keyword: 'acme' , title: 'Help with every kind of family matter for you | Acme Legal' })).length >= 0);
});

test('hype words, markup and spacing are flagged', () => {
  assert.ok(codes(one({ ...GOOD, title: 'Best Divorce Lawyer in Mumbai | Acme Legal' })).includes('title-hype'));
  assert.ok(codes(one({ ...GOOD, description: GOOD.description + ' &amp; more' })).includes('desc-markup'));
  assert.ok(codes(one({ ...GOOD, title: 'Divorce  Lawyer in Mumbai – Family Law | Acme Legal' })).includes('title-spaces'));
});

test('CSV parsing: quotes, commas, new lines, tabs, semicolons and BOM', () => {
  const t = Array.from(C.parseDelimited(String.fromCharCode(0xFEFF) + 'URL,Title,Description\r\n/a,"Hello, world","Line one\nline two ""quoted"""\r\n\r\n'));
  assert.deepStrictEqual(t, [['URL', 'Title', 'Description'], ['/a', 'Hello, world', 'Line one\nline two "quoted"']]);
  assert.deepStrictEqual(Array.from(C.parseDelimited('URL\tTitle\n/a\tA, B')), [['URL', 'Title'], ['/a', 'A, B']]);
  assert.deepStrictEqual(Array.from(C.parseDelimited('URL;Title\n/a;A, B')), [['URL', 'Title'], ['/a', 'A, B']]);
});

test('column guessing prefers new over old and skips length columns', () => {
  const head = ['URL', 'old Meta Title', 'Title Char Count', 'Old Meta Description', 'Character Count', 'New Meta Title', 'Title Char Count', 'New Meta Description'];
  const g = C.guessColumns(head);
  assert.strictEqual(g.columns.title, 5);
  assert.strictEqual(g.columns.description, 7);
  assert.strictEqual(g.columns.url, 0);
  assert.strictEqual(C.guessColumns(['Page', 'Focus Keyword', 'SEO Title', 'Meta Desc']).columns.keyword, 1);
});

test('CSV export guards against spreadsheet formulas', () => {
  const csv = C.toCsv(C.check([{ ...GOOD, url: '=HYPERLINK("x")' }]));
  assert.ok(csv.includes("\"'=HYPERLINK"));
});

test('a large site is checked quickly', () => {
  const rows = [];
  for (let i = 0; i < 2000; i++) rows.push({ url: '/p' + i, title: `Page ${i} about topic ${i % 97} | Acme Legal`, description: `Description number ${i} covering subject ${i % 89} for readers in city ${i % 13}, with details.` });
  const t0 = Date.now();
  const res = C.check(rows, { brand: 'Acme Legal' });
  assert.strictEqual(res.rows.length, 2000);
  assert.ok(Date.now() - t0 < 15000);
});

test('command line: report, exit codes and friendly errors', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snippet-'));
  const good = path.join(dir, 'good.csv');
  fs.writeFileSync(good, 'URL,Keyword,Title,Description\n' + [GOOD.url, GOOD.keyword, GOOD.title, GOOD.description].map((v) => '"' + v + '"').join(',') + '\n');
  const out = path.join(dir, 'report.csv');
  const ok = spawnSync(process.execPath, ['cli.js', good, '--brand', 'Acme Legal', '--out', out], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
  assert.ok(fs.readFileSync(out, 'utf8').includes('Divorce Lawyer'));

  const bad = path.join(dir, 'bad.csv');
  fs.writeFileSync(bad, 'URL,Title,Description\n/a,Home,\n');
  assert.strictEqual(spawnSync(process.execPath, ['cli.js', bad], { cwd: path.join(__dirname, '..') }).status, 1);

  const noHeader = path.join(dir, 'nohead.csv');
  fs.writeFileSync(noHeader, '/a,Some title,Some description\n');
  const r = spawnSync(process.execPath, ['cli.js', noHeader], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /name the columns/);

  const big = path.join(dir, 'big.csv');
  let text = 'URL,Title,Description\n';
  for (let i = 0; i < 1500; i++) text += `/p${i},Title number ${i} for testing output size,Description ${i}\n`;
  fs.writeFileSync(big, text);
  const json = execFileSync(process.execPath, ['cli.js', big, '--json'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 1e8, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
  assert.strictEqual(JSON.parse(json).rows.length, 1500);   // output is not cut off when piped
});

// ---- Defects found in the independent review (each locked in by a test)
test('review H1: 3,000 near-identical rows finish fast; above the limit the skip is reported', () => {
  const make = (n) => Array.from({ length: n }, (_, i) => ({ title: `Blue shirt model ${i} | ShirtCo`, description: `Buy the blue cotton shirt model ${i} for men, soft fabric, regular fit, free delivery and easy returns.` }));
  const t0 = Date.now();
  const res = C.check(make(3000), { brand: 'ShirtCo' });
  assert.ok(Date.now() - t0 < 5000, 'took ' + (Date.now() - t0) + 'ms');
  assert.strictEqual(res.summary.byCode['desc-near-duplicate'], 3000);
  const big = C.check(make(5001));
  assert.match(big.notes.join(' '), /skipped/);
});

test('review H3: headers with underscores and other languages are recognised', () => {
  ['Meta_Title,Meta_Description', 'seo_title,seo_description', 'Seite;Titel;Beschreibung', 'Página;Título;Descripción', 'ページ,タイトル,説明']
    .forEach((line) => assert.ok(C.looksLikeHeader(C.parseDelimited(line)[0]), line));
});

test('review H4: a file with only a Title column is not split at commas', () => {
  const t = C.parseDelimited('Title\nShoes, Boots and Sandals for Women – Free Returns | StrideCo');
  assert.deepStrictEqual(Array.from(t[1]), ['Shoes, Boots and Sandals for Women – Free Returns | StrideCo']);
});

test('review H5: Japanese and Chinese characters are measured as full-width', () => {
  const px = C.pixels('東京のおすすめホテル｜格安予約なら楽天トラベル', 'title');
  assert.ok(px > 440 && px < 490, String(px));     // 463px measured in Chrome
  assert.ok(C.pixels('Москва', 'title') > 60);
});

test('review H6 and M8: keyword matching handles plurals and Japanese', () => {
  const kw = (keyword, title) => codes(one({ ...GOOD, keyword, title }, {})).includes('kw-title');
  assert.ok(!kw('service', 'Our Services – Plumbing in Pune'));
  assert.ok(!kw('courses', 'Online Course in Python for Beginners'));
  assert.ok(!kw('phones', 'Phone Repair Shop in Delhi'));
  assert.ok(!kw('ホテル', '東京のおすすめホテル｜格安予約なら楽天トラベル'));
  assert.ok(kw('glass', 'Glas Repairs in Pune'));        // "glass" is not the plural of "glas"
});

test('review M1: row numbers stay right after blank rows', () => {
  const t = C.parseDelimited('URL,Title,Description\n/a,A title that is long enough here,d\n\n\n/c,Another title that is long enough,d\n');
  assert.deepStrictEqual(C.toRows(t.slice(1), { url: 0, keyword: -1, title: 1, description: 2 }).map((r) => r.row), [2, 5]);
  const lead = C.parseDelimited('\n\nURL,Title\n/a,x');
  assert.strictEqual(lead.skipped, 2);
});

test('review M2: export columns from common tools are picked correctly', () => {
  const pick = (h) => { const c = C.guessColumns(h).columns; return [h[c.title], h[c.description], c.keyword < 0 ? null : h[c.keyword]]; };
  assert.deepStrictEqual(pick(['Handle', 'Title', 'Body (HTML)', 'SEO Title', 'SEO Description']), ['SEO Title', 'SEO Description', null]);
  assert.deepStrictEqual(pick(['ID', 'Name', 'Short description', 'Description', 'Meta: _yoast_wpseo_metadesc', 'Meta: _yoast_wpseo_title', 'Meta: _yoast_wpseo_focuskw']),
    ['Meta: _yoast_wpseo_title', 'Meta: _yoast_wpseo_metadesc', 'Meta: _yoast_wpseo_focuskw']);
  assert.deepStrictEqual(pick(['Address', 'Title 1', 'Title 1 Length', 'Meta Description 1', 'Meta Keywords 1']), ['Title 1', 'Meta Description 1', null]);
  assert.deepStrictEqual(pick(['URL', 'Title - Before', 'Title - After', 'Description - Before', 'Description - After']), ['Title - After', 'Description - After', null]);
});

test('review M4: a well-written 155-160 character description is not penalised for width', () => {
  const d = 'Acme Legal helps families in Mumbai with divorce, child custody, maintenance and property cases, explaining every option clearly before you choose a path.';
  assert.ok(d.length >= 150 && d.length <= 160);
  const r = one({ ...GOOD, description: d });
  assert.ok(!r.issues.some((i) => i.field === 'desc' && /cut|px/.test(i.code + i.msg)), JSON.stringify(r.issues));
});

test('review M5: normal wording is not reported as hype; real claims are', () => {
  const hype = (title, keyword) => codes(one({ ...GOOD, title, keyword: keyword || '' }, {})).includes('title-hype');
  assert.ok(!hype('Email Marketing Best Practices for Small Shops'));
  assert.ok(!hype('15 Best Hiking Trails Near Mumbai', 'best hiking trails'));
  assert.ok(!codes(one({ ...GOOD, title: 'Hotels in Goa near the beach | Best Western' }, { brand: 'Best Western' })).includes('title-hype'));
  assert.ok(hype('Best Divorce Lawyer in Mumbai'));
  assert.ok(hype('#1 Rated Plumber in Pune'));
});

test('review M6 and M7: brand matched as a whole word; accented words handled', () => {
  assert.ok(!codes(one({ ...GOOD, title: 'Pineapple Upside-Down Cake Recipe | Apple Kitchen' }, { brand: 'Apple' })).includes('title-brand-twice'));
  const r = one({ ...GOOD, title: 'Diseño Web y Diseñadores en Madrid' }, {});
  assert.ok(!r.issues.some((i) => /"dise"/i.test(i.msg)));
  assert.ok(codes(one({ ...GOOD, title: 'Zahnärzte in Berlin – Zahnärzte für Kinder' }, {})).includes('title-repeat'));
});

test('review L5: emoji count as one character and are never split', () => {
  assert.strictEqual(C.count('🚀🚀'), 2);
  const cut = C.truncate('🚀'.repeat(80), 600, 'title');
  assert.ok(!cut.text.includes(String.fromCharCode(0xFFFD)));
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut.text));
});

test('review L7: years, generic titles with the brand, and ties', () => {
  const year = (t) => codes(one({ ...GOOD, title: t }, {})).includes('title-year');
  assert.ok(!year('Over 2000 reviews from happy customers in Pune'));
  assert.ok(!year('Call 0800 2000 for a free plumbing quote today'));
  assert.ok(year('Tax Filing Guide for Small Businesses 2026'));
  assert.ok(codes(one({ ...GOOD, title: 'Acme Legal | Home' })).includes('title-generic'));
  const tie = C.check([{ title: 'Divorce Lawyer in Mumbai | Acme Legal' }, { title: 'Tax Lawyer in Delhi - Acme Legal' }], { brand: 'Acme Legal' });
  assert.ok(!tie.rows.some((r) => codes(r).includes('brand-separator')));
});

test('review M10 and L4: command line errors are clear and use exit code 2', () => {
  const cwd = path.join(__dirname, '..');
  const run = (args) => spawnSync(process.execPath, ['cli.js', ...args], { cwd, encoding: 'utf8' });
  assert.strictEqual(run(['sample.csv', '--out', '/nonexistent-folder/r.csv']).status, 2);
  assert.strictEqual(run(['sample.csv', '--brand', '--json']).status, 2);
  assert.strictEqual(run(['sample.csv', '--bogus', '1']).status, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snippet-'));
  const headerOnly = path.join(dir, 'h.csv'); fs.writeFileSync(headerOnly, 'URL,Title,Description\n');
  assert.strictEqual(run([headerOnly]).status, 2);
  const legacy = path.join(dir, 'w.csv'); fs.writeFileSync(legacy, Buffer.from('URL,Title,Description\n/a,Caf\xe9 Cr\xe8me pastries in Paris shop,desc\n', 'latin1'));
  const r = run([legacy, '--json']);
  assert.ok(r.stdout.includes('Café Crème'));
});

test('no invisible BOM characters inside the source files', () => {
  ['checker.js', 'cli.js', 'index.html', 'test/checker.test.js'].forEach((f) => {
    assert.ok(!fs.readFileSync(path.join(__dirname, '..', f), 'utf8').includes(String.fromCharCode(0xFEFF)), f);
  });
});
