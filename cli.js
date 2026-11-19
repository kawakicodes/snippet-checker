#!/usr/bin/env node
// Command-line Snippet Checker.
//   node cli.js titles.csv [--brand "Acme"] [--title-max 60] [--desc-max 160] [--out report.csv] [--json]
// The file can be CSV, semicolon- or tab-separated, with a header row naming the columns
// (URL, Keyword, Title, Description; "new", "after" and SEO columns are preferred when several exist).
// Exit codes: 0 no page failed, 1 at least one page failed, 2 the file or options could not be used.
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('./checker.js');

const VALUE_FLAGS = ['brand', 'title-max', 'title-min', 'desc-max', 'desc-min', 'title-col', 'desc-col', 'url-col', 'keyword-col', 'out'];

function usage(msg) {
  if (msg) console.error(msg + '\n');
  console.error('Usage: node cli.js <file.csv> [--brand NAME] [--title-max N] [--title-min N] [--desc-max N] [--desc-min N]\n' +
                '                   [--title-col NAME] [--desc-col NAME] [--url-col NAME] [--keyword-col NAME] [--out report.csv] [--json]');
  process.exit(2);
}
// Piping into a command that stops reading early (e.g. `| head`) is not an error.
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(process.exitCode || 0); throw e; });

const args = process.argv.slice(2);
if (!args.length || args.includes('-h') || args.includes('--help')) usage();
const flags = {};
let file = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--json') { flags.json = true; continue; }
  if (a.startsWith('--')) {
    const name = a.slice(2);
    if (!VALUE_FLAGS.includes(name)) usage(`Unknown option ${a}.`);
    const v = args[++i];
    if (v === undefined || v.startsWith('--')) usage(`${a} needs a value.`);
    flags[name] = v;
  } else if (!file) file = a;
  else usage('Unexpected argument: ' + a);
}
if (!file) usage('Give a CSV file to check.');
const num = (k) => {
  if (flags[k] === undefined) return undefined;
  const n = Number(flags[k]);
  if (!Number.isFinite(n) || n <= 0) usage(`--${k} must be a positive number.`);
  return n;
};
const opts = {
  brand: flags.brand, titleMaxChars: num('title-max'), titleMinChars: num('title-min'),
  descMaxChars: num('desc-max'), descMinChars: num('desc-min')
};

// Read the file as UTF-8, UTF-16 (BOM) or, if it is not valid UTF-8, as Windows-1252 (older Excel "CSV").
let buf;
try { buf = fs.readFileSync(file); } catch (e) { usage(`Could not read ${file}: ${e.code === 'ENOENT' ? 'file not found' : e.code || e.message}.`); }
if (buf.subarray(0, 2).toString('latin1') === 'PK' || /\.xlsx?$/i.test(file)) {
  usage('This is an Excel file. Save it as "CSV UTF-8" first, or use the web page, which reads Excel files.');
}
let text, encodingNote = '';
if (buf[0] === 0xFF && buf[1] === 0xFE) text = new TextDecoder('utf-16le').decode(buf);
else if (buf[0] === 0xFE && buf[1] === 0xFF) text = new TextDecoder('utf-16be').decode(buf);
else {
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (e) { text = new TextDecoder('windows-1252').decode(buf); encodingNote = 'The file is not UTF-8, so it was read as Windows-1252. If letters look wrong, save it as "CSV UTF-8".'; }
}

const table = C.parseDelimited(text);
if (!table.length) usage('The file is empty.');
const header = table[0];
const pickCol = (flag, guessed) => {
  if (!flags[flag]) return guessed;
  const i = header.findIndex((h) => h.trim().toLowerCase() === flags[flag].trim().toLowerCase());
  if (i < 0) usage(`No column named "${flags[flag]}". Columns are: ${header.join(', ')}`);
  return i;
};
if (!C.looksLikeHeader(header) && !flags['title-col'] && !flags['desc-col']) {
  usage('The first row should name the columns (for example: URL, Keyword, Title, Description).\n' +
        'If it does, name them with --title-col and --desc-col.');
}
const guess = C.guessColumns(header).columns;
const cols = {
  url: pickCol('url-col', guess.url), keyword: pickCol('keyword-col', guess.keyword),
  title: pickCol('title-col', guess.title), description: pickCol('desc-col', guess.description)
};
if (cols.title < 0 && cols.description < 0) usage('Could not find a Title or Description column. Columns are: ' + header.join(', '));

const rows = C.toRows(table.slice(1), cols, 2 + (table.skipped || 0));
if (!rows.length) usage('The file has a header row but no pages under it.');
const result = C.check(rows, opts);
const s = result.summary;

if (flags.json) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} else {
  const colName = (i) => (i >= 0 ? `"${header[i]}"` : 'none');
  if (encodingNote) console.log(encodingNote + '\n');
  console.log(`Checked ${s.rows} ${s.rows === 1 ? 'page' : 'pages'} from ${path.basename(file)} (title column ${colName(cols.title)}, description column ${colName(cols.description)})`);
  console.log(`Fine ${s.pass} · To improve ${s.warn} · Failing ${s.fail} · Average score ${s.averageScore}/100`);
  console.log(`Titles likely cut off: ${s.titlesCut} · Descriptions over target: ${s.descsOver} · Missing titles: ${s.missingTitles} · ` +
              `Missing descriptions: ${s.missingDescs} · Duplicate titles: ${s.duplicateTitles} · Duplicate descriptions: ${s.duplicateDescs}`);
  result.notes.forEach((n) => console.log('Note: ' + n));
  const worst = result.rows.filter((r) => r.status !== 'pass').sort((a, b) => a.score - b.score || a.row - b.row).slice(0, 10);
  if (worst.length) {
    console.log('\nLowest scores:');
    worst.forEach((r) => {
      console.log(`  row ${r.row} ${r.url || '(no URL)'} - ${r.score}/100`);
      r.issues.filter((x) => x.level !== 'info').slice(0, 3)
        .forEach((x) => console.log(`     ${x.level === 'fail' ? 'Fail' : 'Fix'}: ${x.field === 'title' ? 'Title' : 'Description'}: ${x.msg}`));
    });
  }
}
if (flags.out) {
  try {
    fs.writeFileSync(flags.out, C.toCsv(result), 'utf8');
    if (!flags.json) console.log(`\nFull report saved to ${flags.out}`);
  } catch (e) {
    console.error(`Could not save the report to ${flags.out}: ${e.code === 'ENOENT' ? 'that folder does not exist' : e.code || e.message}.`);
    process.exitCode = 2;
  }
}
if (process.exitCode === undefined) process.exitCode = s.fail ? 1 : 0;   // not process.exit(): that can cut off piped output
