'use strict';
/*
 * Small mutation check for automation/validate-article.js.
 * Each mutant weakens one safety rule; the test suite must fail on every one of them ("KILLED").
 * A "SURVIVED" mutant means a rule could break without any test noticing.
 *
 * Run from the repo root (takes a few minutes; not part of `node --test automation/test/`):
 *   node automation/test/mutation-check.js --run
 * Exit code 0 = every mutant killed, 1 = at least one survived or an anchor is missing.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MUTANTS = [
  ['IMG_CHANGED ignores src', "return k !== 'alt';", "return k !== 'alt' && k !== 'src';"],
  ['IMG_CHANGED ignores srcset', "return k !== 'alt';", "return k !== 'alt' && k !== 'srcset';"],
  ['tag names case-sensitive', "fn({ closing: m[1] === '/', name: m[2].toLowerCase()", "fn({ closing: m[1] === '/', name: m[2]"],
  ['JSON-LD isFaq uses some()', "types.every(function (t) { return t === 'FAQPage'; })", "types.some(function (t) { return t === 'FAQPage'; })"],
  ['protocol-relative URLs not parsed', "const pr = /^\\/\\/([^\\/?#\\s]*)([^?#\\s]*)(\\?[^#\\s]*)?(#\\S*)?$/.exec(u);", 'const pr = null;'],
  ['box regex needs no-space colon', "'background(?:-color)?\\\\s*:\\\\s*#'", "'background(?:-color)?:#'"],
  ['www not stripped in normalizeHost', ".replace(/^www\\d?\\./, '')", ''],
  ['unquoted attr values ignored', "|([^\\s\"'<>`]+)))?/g;", '))?/g;'],
  ['CONTENT_LOSS ratio 0.8 -> 0.5', 'minWordRatio: num(o.minWordRatio, 0.8)', 'minWordRatio: num(o.minWordRatio, 0.5)'],
  ['CONTENT_RETENTION off', 'minRetention: num(o.minRetention, 0.75)', 'minRetention: num(o.minRetention, 0)'],
  ['MEDIA_CHANGED off', "if (diff.length) error('MEDIA_CHANGED'", "if (false) error('MEDIA_CHANGED'"],
  ['STRAY_TEXT bare text off', "if (!bareO.length || CHATTER_START_RE.test(shown)) {", 'if (false) {'],
  ['MARKDOWN off', "if (md.length) error('MARKDOWN'", "if (false) error('MARKDOWN'"],
  ['OMISSION_MARKER off', "if (om.length) error('OMISSION_MARKER'", "if (false) error('OMISSION_MARKER'"],
  ['LINK_ATTR_CHANGED off', 'if (miss.length) {', 'if (false) {'],
  ['SHORTCODE_ADDED off', "error('SHORTCODE_ADDED'", "void ('SHORTCODE_ADDED'"],
  ['redirect domains ignored', "if (hostMatches(p.host, REDIRECT_LINK_DOMAINS) || SEARCH_REDIRECT_RE.test(h)) return 'redirect';", ''],
  ['soft 404 ignored', 'if (soft) { result.verdict = \'dead\'; result.error = soft; }', ''],
  ['unknown deep links kept', "removals.push({ url: r.url, reason: 'unverified' });", ''],
  ['audit fix downgraded to pass', "else if (verdict === 'fix' && droppedHigh.length) effectiveVerdict = 'fix';", ''],
  ['fuzzy quote match off', 'return ql ? fuzzyQuoteFound(ql.split(\' \'), corpus) : false;', 'return false;'],
  ['CRLF not normalised', "return s.indexOf('\\r') < 0 ? s : s.replace(/\\r\\n?/g, '\\n');", 'return s;'],
  ['sanitizer edits scripts', 'if (inRanges(prot, a.start)) continue;', ''],
  ['no-research figures unchecked', "if (added.length) error('NEW_NUMBER_WITHOUT_RESEARCH'", "if (false) error('NEW_NUMBER_WITHOUT_RESEARCH'"],
  ['classic block comments allowed', 'if (!O.tokens.length && E.tokens.length) {', 'if (false) {'],
  ['unclosed script allowed', 'if (E.nonJsonLdScriptOpeners > O.nonJsonLdScriptOpeners) {', 'if (false) {'],
  ['site domain never required', 'if (!opts.siteDomains.length) {\n      out.errors', 'if (false) {\n      out.errors'],
  ['stale CLI output kept', 'try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {', 'try { void f; } catch (e) {']
];

function main() {
  const root = path.join(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'validate-article.js'), 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-mut-'));
  const testDir = path.join(dir, 'test');
  fs.mkdirSync(path.join(testDir, 'fixtures'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'run-tests.test.js'), path.join(testDir, 'run-tests.test.js'));
  for (const f of fs.readdirSync(path.join(__dirname, 'fixtures'))) {
    fs.copyFileSync(path.join(__dirname, 'fixtures', f), path.join(testDir, 'fixtures', f));
  }
  let bad = 0;
  try {
    for (const [name, from, to] of MUTANTS) {
      if (!src.includes(from)) { console.log('ANCHOR MISSING  ' + name); bad++; continue; }
      fs.writeFileSync(path.join(dir, 'validate-article.js'), src.split(from).join(to));
      const r = spawnSync(process.execPath, ['--test', path.join(testDir, 'run-tests.test.js')], { encoding: 'utf8', timeout: 300000 });
      const fail = /# fail (\d+)/.exec(r.stdout || '');
      const killed = (fail && fail[1] !== '0') || r.status !== 0;
      if (!killed) bad++;
      console.log((killed ? 'KILLED    ' : 'SURVIVED  ') + name + (fail ? ' (failing tests: ' + fail[1] + ')' : ''));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(bad ? bad + ' mutant(s) survived or could not be applied.' : 'All mutants killed.');
  return bad ? 1 : 0;
}

// Only runs when asked explicitly: `node --test` on some Node versions also executes every .js file in test/.
if (require.main === module && process.argv.includes('--run')) process.exitCode = main();
