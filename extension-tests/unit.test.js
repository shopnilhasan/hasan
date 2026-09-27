'use strict';
// ═══════════════════════════════════════════════════════════════════════
// Unit tests for extension/background.js (v3.46.0 Safety Gate round).
//
// background.js runs in a Node vm with a stub chrome (load-background.js);
// importScripts('safety-gate.js') evaluates the REAL extension/safety-gate.js
// in the same context, exactly like the MV3 service worker. The injected page
// functions (prepareAIProviderPage, readAIJsonSnapshot) run in headless
// Chromium on data: URL pages, the way chrome.scripting.executeScript runs
// them (serialised source, no closures).
//
// Run:  cd extension-tests && npm test      (or: node --test unit.test.js)
// ═══════════════════════════════════════════════════════════════════════
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { loadBackground, REPO_ROOT, EXT_DIR, BACKGROUND_FILE, SAFETY_GATE_FILE } = require('./load-background');
const { loadPlaywright, CHROMIUM_PATH } = require('./browser');

const AUTOMATION = require(path.join(REPO_ROOT, 'automation', 'validate-article.js'));
const FIXTURES = path.join(REPO_ROOT, 'automation', 'test', 'fixtures');
const PROMPTS_DIR = path.join(EXT_DIR, 'prompts');
const EDITOR_PROMPT = fs.readFileSync(path.join(PROMPTS_DIR, 'informational-editor.txt'), 'utf8');
const FACT_PROMPT = fs.readFileSync(path.join(PROMPTS_DIR, 'fact-check.txt'), 'utf8');
const END = '<!-- APU-END -->';
const BASELINE_COMMIT = 'd5605ef'; // "Add Auto Post Updater Pro v3.45.0 as the unmodified baseline"

// Values created inside the vm have that realm's prototypes; compare plain copies.
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const ORIG_BLOCK = read('original-block.html');
const GOOD_BLOCK = AUTOMATION.parseEditorOutput(read('edited-good.txt')).html.trim();
const ORIG_CLASSIC = read('original-classic.html');
const GOOD_CLASSIC = AUTOMATION.parseEditorOutput(read('edited-classic-good.txt')).html.trim();

function localYmd(d) {
  const t = d || new Date();
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
}

// The v3.45.0 background.js from git (null when git / the commit is unavailable).
let baselineSourceCache;
function baselineSource() {
  if (baselineSourceCache !== undefined) return baselineSourceCache;
  try {
    baselineSourceCache = execFileSync('git', ['-C', REPO_ROOT, 'show', BASELINE_COMMIT + ':extension/background.js'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    baselineSourceCache = null;
  }
  return baselineSourceCache;
}
const BASELINE_SKIP = baselineSource() ? false : 'v3.45.0 baseline (git ' + BASELINE_COMMIT + ') is not available';
let baselineCtx = null;
function baseline() {
  if (!baselineCtx) baselineCtx = loadBackground({ source: baselineSource(), gate: false });
  return baselineCtx;
}

// The built-in prompts of panel.js (DEFAULT_PROMPTS + PRESERVE_PROMPT_TEXT), none of which has tokens.
function panelDefaultPrompts() {
  const src = fs.readFileSync(path.join(EXT_DIR, 'panel.js'), 'utf8');
  const start = src.indexOf('const PRESERVE_PROMPT_TEXT');
  const listStart = src.indexOf('const DEFAULT_PROMPTS', start);
  const end = listStart >= 0 ? src.indexOf('\n];', listStart) : -1;
  if (start < 0 || listStart < 0 || end < 0) throw new Error('panel.js layout changed: DEFAULT_PROMPTS / PRESERVE_PROMPT_TEXT not found');
  return vm.runInNewContext(src.slice(start, end + 3) + '\n({ PRESERVE_PROMPT_TEXT, DEFAULT_PROMPTS });');
}

// A job like the one startBatch builds (normalised).
function gateJob(c, extra) {
  const job = Object.assign({
    slugs: ['how-to-check-tyre-pressure'],
    site: { url: 'https://tubetyre.com/', name: 'Tube Tyre' },
    prompt: EDITOR_PROMPT,
    aiName: 'ChatGPT', aiUrl: 'https://chatgpt.com/', aiMode: 'web', aiTimeout: 60,
    completeness: 'balanced', factCheck: false
  }, extra || {});
  c.__setJob(job);
  c.normalizeSafetyGateSettings(job);
  return job;
}

// ──────────────────────────────────────────────────────────────────────
describe('static checks', () => {
  test('node --check passes on every extension and test script', () => {
    const files = fs.readdirSync(EXT_DIR).filter((f) => f.endsWith('.js')).map((f) => path.join(EXT_DIR, f))
      .concat(['load-background.js', 'browser.js', 'unit.test.js', 'smoke.test.js'].map((f) => path.join(__dirname, f)));
    assert.ok(files.length >= 8);
    for (const f of files) execFileSync(process.execPath, ['--check', f], { stdio: ['ignore', 'ignore', 'pipe'] });
  });

  test('manifest is v3.46.0 and still loads background.js as a classic service worker', () => {
    const m = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
    assert.equal(m.manifest_version, 3);
    assert.equal(m.version, '3.46.0');
    assert.deepEqual(m.background, { service_worker: 'background.js' });
    assert.match(m.description, /Safety Gate/);
    assert.match(fs.readFileSync(BACKGROUND_FILE, 'utf8'), /^\s*importScripts\('safety-gate\.js'\);/m);
  });

  test('shipped prompts: mirrored byte-identical to automation/browser/, and the editor prompt asks for the end marker', () => {
    for (const f of ['informational-editor.txt', 'fact-check.txt']) {
      assert.ok(fs.readFileSync(path.join(PROMPTS_DIR, f)).equals(fs.readFileSync(path.join(REPO_ROOT, 'automation', 'browser', f))), f);
    }
    assert.ok(EDITOR_PROMPT.includes(END));
    assert.ok(EDITOR_PROMPT.includes('## FINAL HTML'));
    for (const t of ['[[TODAY]]', '[[SITE_DOMAIN]]', '[[WEB_SEARCH]]', '[[NEW_FAQ]]', '[[POST_TITLE]]']) assert.ok(EDITOR_PROMPT.includes(t), t);
    for (const t of ['[[TODAY]]', '[[WEB_SEARCH]]']) assert.ok(FACT_PROMPT.includes(t), t);
    // the fact-check reply contract: ONE ```json block with verdict + issues
    assert.ok(FACT_PROMPT.includes('```json') && FACT_PROMPT.includes('"verdict"') && FACT_PROMPT.includes('"issues"'));
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('service worker load (vm)', () => {
  test('importScripts loads the real safety-gate.js and exposes self.SafetyGate', () => {
    const c = loadBackground();
    assert.equal(typeof c.SafetyGate, 'object');
    assert.equal(c.SafetyGate.VERSION, AUTOMATION.VERSION);
    assert.equal(c.safetyGateApi(), c.SafetyGate);
    for (const k of ['runSafetyGate', 'stripEndMarkers', 'filterAuditIssues', 'validateArticle', 'sanitizeLinks', 'checkLinks', 'findNewLinks']) {
      assert.equal(typeof c.SafetyGate[k], 'function', 'SafetyGate.' + k);
    }
    assert.deepEqual(c.__console.filter((l) => l.level === 'error'), []);
  });

  test('extension/safety-gate.js is byte-identical to automation/validate-article.js', () => {
    assert.ok(fs.readFileSync(SAFETY_GATE_FILE).equals(fs.readFileSync(path.join(REPO_ROOT, 'automation', 'validate-article.js'))));
  });

  test('no top-level name in safety-gate.js clashes with background.js', () => {
    // Worker globals are shared: a clash would silently replace a background function.
    const names = (file) => {
      const src = fs.readFileSync(file, 'utf8');
      const out = new Set();
      for (const m of src.matchAll(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|^(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1] || m[2]);
      return out;
    };
    const gate = names(SAFETY_GATE_FILE);
    const bg = names(BACKGROUND_FILE);
    assert.ok(gate.size > 20 && bg.size > 200, 'name scan found too little (' + gate.size + ' / ' + bg.size + ')');
    assert.deepEqual([...gate].filter((n) => bg.has(n)), []);
  });

  test('the pinned v3.46.0 functions are top-level declarations', () => {
    const c = loadBackground();
    for (const k of ['substitutePromptTokens', 'promptTokenValues', 'buildFactCheckPayload', 'parseFactCheckReply', 'decideFactCheck',
      'buildFactCheckFixNote', 'readAIJsonSnapshot', 'waitForFactCheckJson', 'runFactCheck', 'applySafetyPipeline', 'sessionOriginalFor',
      'safetyGateOn', 'factCheckOn', 'prepareAIProviderPage', 'buildAIPayload', 'buildChunkPayload', 'normalizeSafetyGateSettings']) {
      assert.equal(typeof c[k], 'function', k);
    }
  });

  test('safety-gate.js missing: the worker still starts and every gated save fails closed', async () => {
    const c = loadBackground({ gate: false });
    assert.equal(c.safetyGateApi(), null);
    assert.ok(c.__console.some((l) => l.level === 'error' && /safety-gate\.js could not be loaded/.test(l.line)), JSON.stringify(c.__console));
    gateJob(c);
    const links = { rawInput: 'p' };
    await assert.rejects(c.runSafetyGateStep({ tag: '[1/1]', attemptLinks: links }, ORIG_BLOCK, GOOD_BLOCK + '\n' + END), (e) => {
      assert.equal(e.code, 'SAFETY_GATE');
      assert.match(e.message, /^SAFETY GATE BLOCKED: GATE_NOT_LOADED — safety-gate\.js not loaded\. The post was NOT changed\.$/);
      return true;
    });
    assert.deepEqual(plain(links.gate.codes), ['GATE_NOT_LOADED']);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('extraction fixes (findFinalHtmlOutputCut / cleanExtractedArticle)', () => {
  const c = loadBackground();
  const clean = (t) => c.cleanExtractedArticle(t);
  const cut = (t) => c.findFinalHtmlOutputCut(t);

  test('"a fixed article of clothing" inside the article is not a divider', () => {
    const art = '<p>Intro paragraph.</p>\n<h2>Clothes</h2>\n<p>A scarf is a fixed article of clothing in winter.</p>\n<p>End.</p>';
    assert.equal(cut(art), -1);
    assert.equal(clean(art), art);
    // same with the phrase at the start of a sentence and in capitals, inside a tag
    const art2 = '<p>Intro.</p>\n<p>FIXED ARTICLE numbers are shown on the label.</p>\n<p>End.</p>';
    assert.equal(cut(art2), -1);
    assert.equal(clean(art2), art2);
    // a ChatGPT reply with the phrase in the article keeps the whole article
    const reply = 'Tightened the intro.\n\n## FINAL HTML\n```html\n' + art + '\n' + END + '\n```';
    assert.equal(c.extractHtmlFromAIText(reply), art + '\n' + END);
  });

  test('regression guard: v3.45.0 cut the article at "fixed article"', { skip: BASELINE_SKIP }, () => {
    const art = '<p>Intro paragraph.</p>\n<h2>Clothes</h2>\n<p>A scarf is a fixed article of clothing in winter.</p>\n<p>End.</p>';
    assert.notEqual(baseline().findFinalHtmlOutputCut(art), -1);
    assert.notEqual(baseline().cleanExtractedArticle(art), art);
  });

  test('a leading shortcode ([toc]) is kept', () => {
    const art = '[toc]\n<p>Intro.</p>\n<h2>A</h2>\n<p>Body.</p>';
    assert.equal(clean(art), art);
    assert.equal(clean('Here you go:\n' + art), art);
    assert.equal(c.cleanExtractedArticle(c.normalizeCodeText('```html\n' + art + '\n' + END + '\n```')), art + '\n' + END);
  });

  test('a trailing shortcode ([related_posts]) is kept', () => {
    const art = '<p>Intro.</p>\n<h2>A</h2>\n<p>Body.</p>\n[related_posts]';
    assert.equal(clean(art), art);
    assert.equal(clean('<p>Intro.</p>[related_posts limit="3"]\n'), '<p>Intro.</p>[related_posts limit="3"]');
    assert.equal(clean('<p>Intro</p>\n[embed]https://www.youtube.com/watch?v=abc[/embed]'), '<p>Intro</p>\n[embed]https://www.youtube.com/watch?v=abc[/embed]');
    // chat text after a code fence is still dropped
    assert.equal(clean('<p>x</p>\n```\nLet me know [anything] else'), '<p>x</p>');
  });

  test('page-builder shortcodes at both ends are kept', () => {
    const art = '[et_pb_section fb_built="1"][et_pb_row][et_pb_column type="4_4"][et_pb_text]\n<p>Hello</p>\n[/et_pb_text][/et_pb_column][/et_pb_row][/et_pb_section]';
    assert.equal(clean(art), art);
  });

  test('markdown links, [x] boxes and chat notes outside the fence are not shortcodes', () => {
    assert.equal(clean('[Read more](https://a.com)\n<p>x</p>'), '<p>x</p>');
    assert.equal(clean('[x] done\n<p>x</p>'), '<p>x</p>');
    assert.equal(clean('## FINAL HTML\n[Note] see below\n```html\n<p>Intro.</p>\n```'), '<p>Intro.</p>');
  });

  test('divider style 1: "## FINAL HTML" (browser-edition prompt)', () => {
    const reply = 'Summary: fixed 2 typos.\nNo pages opened.\n\n## FINAL HTML\n```html\n<p>Intro.</p>\n<h2>A</h2>\n<p>Body.</p>\n' + END + '\n```';
    const expected = '<p>Intro.</p>\n<h2>A</h2>\n<p>Body.</p>\n' + END;
    assert.equal(cut(reply), reply.indexOf('## FINAL HTML') + '## FINAL HTML'.length);
    assert.equal(clean(c.normalizeCodeText(reply)), expected);
    assert.equal(c.extractHtmlFromAIText(reply), expected);
    assert.equal(cut('x\n2. Updated Article HTML\n<p>a</p>'), 'x\n2. Updated Article HTML'.length);
  });

  test('divider style 2: "── FIXED ARTICLE ──" (audit prompts)', () => {
    const reply = 'AUDIT REPORT\n- <h2> was weak\n<p>report paragraph</p>\n────────── FIXED ARTICLE ──────────\n```html\n<p>Intro.</p>\n<h2>A</h2>\n```';
    assert.equal(clean(c.normalizeCodeText(reply)), '<p>Intro.</p>\n<h2>A</h2>');
    assert.equal(clean('**FIXED ARTICLE**\n<p>x</p>'), '<p>x</p>');
    assert.equal(clean('<p>report</p>\nPART 2 — FIXED ARTICLE\n<p>x</p>'), '<p>x</p>');
    assert.equal(clean('<p>report</p>\n3. Fixed Article:\n<p>x</p>'), '<p>x</p>');
    // the LAST divider wins
    assert.equal(clean('## FINAL HTML\n<p>draft</p>\n── FIXED ARTICLE ──\n<p>final</p>'), '<p>final</p>');
  });

  test('<!-- APU-END --> survives extraction', () => {
    const art = '<p>Intro.</p>\n<h2>A</h2>\n<p>Body.</p>\n' + END;
    assert.equal(clean(art), art);
    assert.equal(clean(art + '\n'), art);
    assert.equal(clean(art + '\n```\nAnything else?'), art);
    // ChatGPT code-box DOM text: language label + "Copy code" line, no fences
    assert.equal(clean(c.normalizeCodeText('html\nCopy code\n' + art)), art);
    assert.equal(clean(c.normalizeCodeText('html\n' + art)), art);
    assert.equal(clean('[toc]\n<p>Intro.</p>\n[related_posts]\n' + END), '[toc]\n<p>Intro.</p>\n[related_posts]\n' + END);
    // whole ChatGPT reply (API path and code-box path) with shortcodes at both ends
    const body = '[toc]\n<p>Intro.</p>\n<h2>A</h2>\n<p>Body.</p>\n[related_posts]\n' + END;
    const reply = 'Tightened the intro.\n[Note] kept all images.\n\n## FINAL HTML\n```html\n' + body + '\n```';
    assert.equal(c.extractHtmlFromAIText(reply), body);
    assert.equal(clean(c.normalizeCodeText(reply)), body);
  });

  test('inputs without shortcodes or dividers extract exactly as in v3.45.0', { skip: BASELINE_SKIP }, () => {
    const old = baseline();
    const inputs = [
      'Sure! Here it is:\n<p>Intro</p><h2>x</h2>\nHope this helps!',
      '<!doctype html><html><body><p>x</p></body></html>\n[after]',
      '<p>Intro.</p>\n<h2>A</h2>\n<p>Body.</p>\n' + END,
      'x\n2. Updated Article HTML\n<p>a</p>',
      'AUDIT REPORT\n────────── FIXED ARTICLE ──────────\n<p>Intro.</p>',
      'html\n<!-- wp:paragraph -->\n<p>Intro.</p>\n<!-- /wp:paragraph -->',
      'no html at all',
      '',
      GOOD_BLOCK,
      GOOD_CLASSIC
    ];
    for (const s of inputs) {
      assert.equal(c.cleanExtractedArticle(c.normalizeCodeText(s)), old.cleanExtractedArticle(old.normalizeCodeText(s)), JSON.stringify(s.slice(0, 60)));
      assert.equal(c.extractHtmlFromAIText(s), old.extractHtmlFromAIText(s), JSON.stringify(s.slice(0, 60)));
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('prompt tokens (substitutePromptTokens / promptTokenValues)', () => {
  const c = loadBackground();
  const values = { today: '2026-09-27', siteDomain: 'example.org, shop.example.org', webSearch: 'yes', newFaq: 'no', postTitle: 'Best Pans' };

  test('replaces exactly the five tokens, every occurrence', () => {
    const s = 'D=[[TODAY]] S=[[SITE_DOMAIN]] W=[[WEB_SEARCH]] F=[[NEW_FAQ]] T=[[POST_TITLE]] again [[TODAY]]';
    assert.equal(c.substitutePromptTokens(s, values),
      'D=2026-09-27 S=example.org, shop.example.org W=yes F=no T=Best Pans again 2026-09-27');
  });

  test('leaves anything else untouched', () => {
    const s = '[[today]] [[ TODAY ]] [[TODAY] [TODAY] [[OTHER]] {{TODAY}} [[POST_TITLE]]';
    assert.equal(c.substitutePromptTokens(s, values), '[[today]] [[ TODAY ]] [[TODAY] [TODAY] [[OTHER]] {{TODAY}} Best Pans');
  });

  test('missing values become empty, booleans become yes/no, no second pass, $-patterns are literal', () => {
    assert.equal(c.substitutePromptTokens('a[[TODAY]]b[[POST_TITLE]]c', {}), 'abc');
    assert.equal(c.substitutePromptTokens('[[WEB_SEARCH]]/[[NEW_FAQ]]', { webSearch: true, newFaq: false }), 'yes/no');
    assert.equal(c.substitutePromptTokens('T: [[POST_TITLE]]', { postTitle: 'A [[TODAY]] $& $1 $$ B', today: 'X' }), 'T: A [[TODAY]] $& $1 $$ B');
    assert.equal(c.substitutePromptTokens('[[TODAY]]', null), '');
  });

  test('a prompt without tokens comes back unchanged', () => {
    for (const s of ['', 'plain prompt', '  spaced \n', 'Use [brackets] and [[OTHER]] freely', EDITOR_PROMPT.replace(/\[\[/g, '[ [')]) {
      assert.equal(c.substitutePromptTokens(s, values), s);
    }
    assert.equal(c.substitutePromptTokens(undefined, values), '');
  });

  test('promptTokenValues reads the running job', () => {
    c.__setJob({ site: { url: 'https://www.Example.org/blog/' }, gateSiteDomains: ['shop.example.org', 'example.org'], promptWebSearch: true, gateNewFaq: 'no' });
    assert.deepEqual(plain(c.promptTokenValues({ postTitle: 'Best Pans' })),
      { today: localYmd(), siteDomain: 'example.org, shop.example.org', webSearch: 'yes', newFaq: 'no', postTitle: 'Best Pans' });
    c.__setJob({ site: { url: 'https://example.org' } });
    assert.deepEqual(plain(c.promptTokenValues()), { today: localYmd(), siteDomain: 'example.org', webSearch: 'no', newFaq: 'auto', postTitle: '' });
    c.__setJob(null);
    assert.deepEqual(plain(c.promptTokenValues()), { today: localYmd(), siteDomain: '', webSearch: 'no', newFaq: 'auto', postTitle: '' });
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('AI payloads (buildAIPayload / buildChunkPayload)', () => {
  const c = loadBackground();
  const bar = (label) => '══════════════════════  ' + label + '  ══════════════════════';

  test('buildAIPayload substitutes the tokens of the shipped editor prompt, never inside the article', () => {
    c.__setJob({ site: { url: 'https://www.example.org/' }, gateSiteDomains: ['shop.example.org'], promptWebSearch: true, gateNewFaq: 'no' });
    const article = '<p>Keep [[TODAY]] and [[POST_TITLE]] in the article.</p>';
    const out = c.buildAIPayload(EDITOR_PROMPT, '\n' + article + '\n', { postTitle: 'Best Pans' });
    assert.ok(out.startsWith(bar('ARTICLE HTML START') + '\n\n' + article + '\n\n' + bar('ARTICLE HTML END') + '\n\n\n' + bar('INSTRUCTIONS') + '\n\n'));
    const instructions = out.slice(out.indexOf(bar('INSTRUCTIONS')));
    assert.ok(!instructions.includes('[['), 'a token was left in the instructions');
    assert.ok(instructions.includes('Post title (H1, set in WordPress): Best Pans\n'));
    assert.ok(instructions.includes('Site domain(s) (comma-separated): example.org, shop.example.org\n'));
    assert.ok(instructions.includes("Today's date (YYYY-MM-DD): " + localYmd() + '\n'));
    assert.ok(instructions.includes('Web search available (yes / no; default: no): yes\n'));
    assert.ok(instructions.includes('Add new FAQ (auto / no; default: auto): no\n'));
    assert.equal(instructions, bar('INSTRUCTIONS') + '\n\n' + c.substitutePromptTokens(EDITOR_PROMPT.trim(), c.promptTokenValues({ postTitle: 'Best Pans' })));
    // web search off / no title
    c.__setJob({ site: { url: 'https://example.org' } });
    const off = c.buildAIPayload(EDITOR_PROMPT, article);
    assert.ok(off.includes('Web search available (yes / no; default: no): no\n'));
    assert.ok(off.includes('Post title (H1, set in WordPress): \n'));
    assert.ok(off.includes('Add new FAQ (auto / no; default: auto): auto\n'));
  });

  test('buildChunkPayload substitutes tokens in the instructions only', () => {
    c.__setJob({ site: { url: 'https://example.org' }, promptWebSearch: false });
    const out = c.buildChunkPayload('Date: [[TODAY]]. Web: [[WEB_SEARCH]].', '<h2>[[TODAY]]</h2>', 2, 3, { postTitle: 'x' });
    assert.equal(out, 'You are editing PART 2 of 3 of one larger WordPress article. ' +
      'Edit ONLY this part and reply with ONLY this part as raw HTML. Do NOT add <html>, <head> or <body> wrappers, do NOT repeat any other part, and do NOT add a whole-article intro or conclusion here.\n\n' +
      'Here is PART 2 HTML:\n```html\n<h2>[[TODAY]]</h2>\n```\n\n' +
      'Editing instructions:\nDate: ' + localYmd() + '. Web: no.\n\n' +
      'Reply with the edited HTML of this part inside one fenced code block that starts with ```html and ends with ```.');
  });

  test('prompts without tokens produce byte-identical payloads to v3.45.0', { skip: BASELINE_SKIP }, () => {
    const old = baseline();
    const { PRESERVE_PROMPT_TEXT, DEFAULT_PROMPTS } = panelDefaultPrompts();
    const prompts = DEFAULT_PROMPTS.map((p) => p.text).concat([
      PRESERVE_PROMPT_TEXT,
      fs.readFileSync(path.join(REPO_ROOT, 'automation', 'article-editor-prompt.txt'), 'utf8'),
      fs.readFileSync(path.join(REPO_ROOT, 'automation', 'fact-audit-prompt.txt'), 'utf8'),
      '', '   padded prompt  \n\n', 'Use [[NOT_A_TOKEN]], [[today]] and [[ TODAY ]] as they are.', 'Dollars: $& $1 $$ $` done'
    ]);
    assert.ok(DEFAULT_PROMPTS.length >= 4);
    c.__setJob({ site: { url: 'https://example.org' }, promptWebSearch: true, gateNewFaq: 'no', gateSiteDomains: ['a.com'] });
    for (const p of prompts) {
      assert.ok(!/\[\[(TODAY|SITE_DOMAIN|WEB_SEARCH|NEW_FAQ|POST_TITLE)\]\]/.test(p));
      for (const html of [ORIG_BLOCK, '  <p>x</p>  ', '']) {
        const expected = old.buildAIPayload(p, html);
        assert.equal(c.buildAIPayload(p, html), expected);
        assert.equal(c.buildAIPayload(p, html, { postTitle: 'Some Title' }), expected);
        const expectedChunk = old.buildChunkPayload(p, html, 1, 4);
        assert.equal(c.buildChunkPayload(p, html, 1, 4), expectedChunk);
        assert.equal(c.buildChunkPayload(p, html, 1, 4, { postTitle: 'Some Title' }), expectedChunk);
      }
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('fact-check helpers', () => {
  const c = loadBackground();
  const bar = (label) => '══════════════════════  ' + label + '  ══════════════════════';

  test('buildFactCheckPayload layout: original, edited, then the instructions', () => {
    c.__setJob({ site: { url: 'https://example.org' }, promptWebSearch: false });
    const out = c.buildFactCheckPayload('Check it. Date: [[TODAY]]. Web: [[WEB_SEARCH]].', '\n<p>orig [[TODAY]]</p>\n', '  <p>edit</p>  ');
    assert.equal(out,
      bar('ORIGINAL ARTICLE HTML START') + '\n\n<p>orig [[TODAY]]</p>\n\n' + bar('ORIGINAL ARTICLE HTML END') + '\n\n\n' +
      bar('EDITED ARTICLE HTML START') + '\n\n<p>edit</p>\n\n' + bar('EDITED ARTICLE HTML END') + '\n\n\n' +
      bar('INSTRUCTIONS') + '\n\nCheck it. Date: ' + localYmd() + '. Web: no.');
  });

  test('buildFactCheckPayload with the shipped fact-check prompt leaves no token', () => {
    c.__setJob({ site: { url: 'https://example.org' }, promptWebSearch: true });
    const out = c.buildFactCheckPayload(FACT_PROMPT, ORIG_BLOCK, GOOD_BLOCK);
    const instructions = out.slice(out.indexOf(bar('INSTRUCTIONS')));
    assert.ok(!instructions.includes('[['));
    assert.ok(instructions.includes("Today's date (YYYY-MM-DD): " + localYmd() + '\n'));
    assert.ok(instructions.includes('Web search available (yes / no; default: no): yes\n'));
    const order = ['ORIGINAL ARTICLE HTML START', 'ORIGINAL ARTICLE HTML END', 'EDITED ARTICLE HTML START', 'EDITED ARTICLE HTML END', 'INSTRUCTIONS'].map((l) => out.indexOf(bar(l)));
    assert.deepEqual(order.slice().sort((a, b) => a - b), order);
    assert.ok(order[0] === 0 && order.every((i) => i >= 0));
  });

  const JSON_OK = '{"verdict": "fix", "issues": [{"severity": "high", "category": "fact_wrong", "quote": "use {curly} braces } here", "problem": "Wrong.", "fix": "Keep the original."}]}';

  test('parseFactCheckReply: fenced ```json block', () => {
    const r = c.parseFactCheckReply('```json\n' + JSON_OK + '\n```');
    assert.equal(r.ok, true);
    assert.equal(r.audit.verdict, 'fix');
    assert.equal(r.audit.issues.length, 1);
    assert.equal(r.audit.issues[0].quote, 'use {curly} braces } here');
    assert.equal(c.parseFactCheckReply('Result:\n```\n{"verdict":"pass","issues":[]}\n```\nDone.').audit.verdict, 'pass');
    // the first block is not a verdict → the next one is used
    const two = c.parseFactCheckReply('```json\n{"note": 1}\n```\n```json\n{"verdict":"reject","issues":[]}\n```');
    assert.equal(two.ok, true);
    assert.equal(two.audit.verdict, 'reject');
  });

  test('parseFactCheckReply: unfenced JSON (code-block text read from the page, or JSON in prose)', () => {
    assert.equal(c.parseFactCheckReply(JSON_OK).audit.verdict, 'fix');
    assert.equal(c.parseFactCheckReply('json\n{"verdict":"pass","issues":[]}').audit.verdict, 'pass');
    const prose = c.parseFactCheckReply('Here you go {not json} and then ' + JSON_OK + ' thanks!');
    assert.equal(prose.ok, true);
    assert.equal(prose.audit.issues[0].problem, 'Wrong.');
    assert.equal(c.parseFactCheckReply('{"verdict":" PASS ","issues":[]}').audit.verdict, 'pass');
  });

  test('parseFactCheckReply: junk, empty, broken JSON and smart quotes are errors', () => {
    const junk = c.parseFactCheckReply('I could not check this article, sorry.');
    assert.equal(junk.ok, false);
    assert.match(junk.error, /no JSON object with a "verdict"/);
    assert.deepEqual(plain(c.parseFactCheckReply('')), { ok: false, error: 'empty reply' });
    assert.deepEqual(plain(c.parseFactCheckReply(null)), { ok: false, error: 'empty reply' });
    const broken = c.parseFactCheckReply('```json\n{"verdict": "pass", "issues": [}\n```');
    assert.equal(broken.ok, false);
    assert.match(broken.error, /invalid JSON/);
    assert.equal(c.parseFactCheckReply('{“verdict”: “pass”, “issues”: []}').ok, false);
  });

  test('parseFactCheckReply: missing issues = [], bad issues / bad verdict = error', () => {
    const missing = c.parseFactCheckReply('```json\n{"verdict":"pass"}\n```');
    assert.equal(missing.ok, true);
    assert.deepEqual(plain(missing.audit.issues), []);
    assert.deepEqual(plain(c.parseFactCheckReply('{"verdict":"pass","issues":null}').audit.issues), []);
    const notArray = c.parseFactCheckReply('{"verdict":"fix","issues":"none"}');
    assert.equal(notArray.ok, false);
    assert.match(notArray.error, /"issues" is not an array/);
    const badVerdict = c.parseFactCheckReply('```json\n{"verdict":"approve","issues":[]}\n```');
    assert.equal(badVerdict.ok, false);
    assert.match(badVerdict.error, /verdict must be pass, fix or reject \(got "approve"\)/);
    assert.equal(c.parseFactCheckReply('{"issues":[]}').ok, false);
  });

  // decideFactCheck uses the real SafetyGate.filterAuditIssues.
  const edited = '<p>The tower is 330 metres tall and was finished in 1889.</p><h2>Visiting</h2><p>Tickets cost 29 euros for adults at the top.</p>';
  const HIGH_OK = { severity: 'high', category: 'fact_wrong', quote: 'The tower is 330 metres tall', problem: 'Wrong height', fix: 'Keep the original height' };
  const HIGH_BAD = { severity: 'high', category: 'fact_wrong', quote: 'this text is not in the article at all', problem: 'Invented claim', fix: 'Remove it' };
  const MED_OK = { severity: 'medium', category: 'info_lost', quote: 'Tickets cost 29 euros for adults', problem: 'Minor', fix: 'f' };
  const decide = (audit, orig) => c.decideFactCheck(audit, edited, orig === undefined ? '<p>orig</p>' : orig);

  test('decideFactCheck: pass', () => {
    let r = decide({ verdict: 'pass', issues: [] });
    assert.equal(r.action, 'pass');
    assert.deepEqual(plain(r.filtered.retryIssues), []);
    r = decide({ verdict: 'pass', issues: [MED_OK] });
    assert.equal(r.action, 'pass');
    assert.equal(r.filtered.issues.length, 1);
    // a "fix" whose only issue was invented (quote not in the edit) is dropped → pass
    assert.equal(decide({ verdict: 'fix', issues: [Object.assign({}, MED_OK, { quote: 'this text is not in the article at all' })] }).action, 'pass');
  });

  test('decideFactCheck: an explicit "fix" verdict is never a pass (EXT-SPEC §4)', () => {
    // medium / low issues left → the fix round, with those issues
    let r = decide({ verdict: 'fix', issues: [MED_OK] });
    assert.equal(r.action, 'fix');
    assert.deepEqual(plain(r.filtered.retryIssues).map((i) => i.quote), [MED_OK.quote]);
    assert.equal(decide({ verdict: 'fix', issues: [MED_OK, Object.assign({}, MED_OK, { severity: 'low' })] }).action, 'fix');
    // a "fix" with no usable issue (none listed, or not issue objects) fails closed
    r = decide({ verdict: 'fix', issues: [] });
    assert.equal(r.action, 'fail');
    assert.match(r.filtered.failReason, /listed no usable issue/);
    assert.equal(decide({ verdict: 'fix' }).action, 'fail');
    assert.equal(decide({ verdict: 'fix', issues: ['The price of twelve euros is wrong'] }).action, 'fail');
    assert.equal(decide({ verdict: 'fix', issues: [MED_OK, 'also this'] }).action, 'fix');
    // "pass" is unaffected
    assert.equal(decide({ verdict: 'pass', issues: ['a note'] }).action, 'pass');
  });

  test('decideFactCheck: fix', () => {
    const r = decide({ verdict: 'fix', issues: [HIGH_OK, MED_OK] });
    assert.equal(r.action, 'fix');
    assert.equal(r.filtered.retryIssues.length, 2);
    assert.equal(r.filtered.retryIssues[0].severity, 'high');
    // "pass" that still lists a real HIGH issue → fix
    assert.equal(decide({ verdict: 'pass', issues: [HIGH_OK] }).action, 'fix');
    // unknown severity counts as high
    assert.equal(decide({ verdict: 'pass', issues: [Object.assign({}, MED_OK, { severity: 'critical' })] }).action, 'fix');
    // info_lost may quote the original
    const lost = c.decideFactCheck({ verdict: 'fix', issues: [{ severity: 'high', category: 'info_lost', quote: 'The spire was added in 1957 by the city', problem: 'lost' }] },
      edited, '<p>The spire was added in 1957 by the city.</p>');
    assert.equal(lost.action, 'fix');
    assert.equal(lost.filtered.issues.length, 1);
  });

  test('decideFactCheck: reject / invalid verdict → fail', () => {
    assert.equal(decide({ verdict: 'reject', issues: [] }).action, 'fail');
    assert.equal(decide({ verdict: 'reject', issues: [HIGH_BAD] }).action, 'fail');
    assert.equal(decide({ verdict: 'maybe', issues: [] }).action, 'fail');
    assert.equal(decide(null).action, 'fail');
  });

  test('decideFactCheck: unmatched quote', () => {
    // a "fix" whose HIGH quote is not in the edit is never downgraded to pass
    let r = decide({ verdict: 'fix', issues: [HIGH_BAD] });
    assert.equal(r.action, 'fix');
    assert.equal(r.filtered.issues.length, 0);
    assert.equal(r.filtered.dropped.length, 1);
    assert.equal(r.filtered.retryIssues.length, 1);
    assert.equal(r.filtered.retryIssues[0].quoteNotFound, true);
    // a "pass" with an invented HIGH quote stays a pass (the issue is dropped)
    r = decide({ verdict: 'pass', issues: [HIGH_BAD] });
    assert.equal(r.action, 'pass');
    assert.equal(r.filtered.dropped.length, 1);
  });

  test('decideFactCheck without the shared filter is conservative', () => {
    const g = loadBackground({ gate: false });
    let r = g.decideFactCheck({ verdict: 'fix', issues: [MED_OK] }, edited);
    assert.equal(r.action, 'fix');
    assert.equal(r.filtered.retryIssues.length, 1);
    assert.equal(g.decideFactCheck({ verdict: 'pass', issues: [HIGH_BAD] }, edited).action, 'fix');
    assert.equal(g.decideFactCheck({ verdict: 'pass', issues: [] }, edited).action, 'pass');
    assert.equal(g.decideFactCheck({ verdict: 'reject', issues: [] }, edited).action, 'fail');
    r = g.decideFactCheck({ verdict: 'pass', issues: [Object.assign({}, MED_OK, { severity: '' })] }, edited);
    assert.equal(r.action, 'fix');
  });

  test('buildFactCheckFixNote', () => {
    const r = decide({ verdict: 'fix', issues: [HIGH_BAD, MED_OK] });
    const fromArray = c.buildFactCheckFixNote(r.filtered.retryIssues);
    assert.equal(c.buildFactCheckFixNote(r.filtered), fromArray);
    assert.match(fromArray, /^A fact-check of your previous edit of this exact article found the problems listed below\. Start again from the ORIGINAL article HTML above/);
    assert.ok(fromArray.includes('\n1. [HIGH / fact_wrong] Problem: Invented claim. Fix: Remove it. Text the fact-checker quoted (not found word for word in your edit): "this text is not in the article at all".'), fromArray);
    assert.ok(fromArray.includes('\n2. [MEDIUM / info_lost] Problem: Minor. Fix: f. Text in your previous edit: "Tickets cost 29 euros for adults".'), fromArray);
    assert.ok(!fromArray.includes('AUDIT ISSUES'));
    assert.ok(c.buildFactCheckFixNote([HIGH_OK]).includes('1. [HIGH / fact_wrong] Problem: Wrong height. Fix: Keep the original height.'));
    assert.ok(c.buildFactCheckFixNote({ issues: [HIGH_OK] }).includes('Keep the original height'));
    assert.equal(c.buildFactCheckFixNote(null).split('\n').length, 2);
    const many = Array.from({ length: 20 }, (_, i) => Object.assign({}, HIGH_OK, { problem: 'P' + i }));
    const capped = c.buildFactCheckFixNote(many);
    assert.ok(capped.includes('\n15. ') && !capped.includes('\n16. '));
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('sessionOriginalFor (reference = earliest backup of THIS run)', () => {
  const orig = (label) => '<p>' + label + ' — the original article text, long enough.</p>';
  const backups = [
    // newest first, like the real __originalsBackup list
    { slug: 'post-a', sessionId: 222, time: '2026-09-27T12:00:00.000Z', html: orig('A later this run') },
    { slug: 'post-b', sessionId: 222, time: '2026-09-27T08:00:00.000Z', html: orig('B this run') },
    { slug: 'post-a', sessionId: 222, time: '2026-09-27T10:00:00.000Z', html: '  ' + orig('A first this run') + '\n' },
    { slug: 'post-a', sessionId: 222, time: '2026-09-27T09:00:00.000Z', html: '<p>too short</p>' },
    { slug: 'post-a', sessionId: 111, time: '2026-09-20T10:00:00.000Z', html: orig('A older run') },
    { slug: 'post-a', sessionId: 333, time: '2026-09-01T10:00:00.000Z', html: orig('A other run') },
    { slug: 'post-c', sessionId: '222', time: '2026-09-27T07:00:00.000Z', html: orig('C this run (string id)') },
    null
  ];
  const ctxWith = (sessionId, storage) => {
    const c = loadBackground({ storage: storage === undefined ? { __originalsBackup: backups } : storage });
    c.__set('runtime.sessionId', sessionId);
    return c;
  };

  test('earliest backup of this session wins over later ones, other runs and short backups', async () => {
    const c = ctxWith(222);
    assert.equal(await c.sessionOriginalFor('post-a', 'post-a', '<p>live</p>'), orig('A first this run'));
    assert.equal(await c.sessionOriginalFor('post-b', '', '<p>live</p>'), orig('B this run'));
    assert.equal(await c.sessionOriginalFor('post-c', '', '<p>live</p>'), orig('C this run (string id)'));
  });

  test('matches the raw input (URL form) as well as the slug', async () => {
    const c = ctxWith(222);
    assert.equal(await c.sessionOriginalFor('renamed-slug', 'https://example.org/blog/post-a/?utm_source=x', 'fb'), orig('A first this run'));
    assert.equal(await c.sessionOriginalFor('https://example.org/post-a/', '', 'fb'), orig('A first this run'));
  });

  test('falls back to the given HTML (trimmed) when this run has no backup', async () => {
    assert.equal(await ctxWith(222).sessionOriginalFor('post-z', 'post-z', '  <p>live</p>\n'), '<p>live</p>');
    assert.equal(await ctxWith(444).sessionOriginalFor('post-a', 'post-a', '<p>live</p>'), '<p>live</p>');
    assert.equal(await ctxWith(0).sessionOriginalFor('post-a', 'post-a', '<p>live</p>'), '<p>live</p>');
    assert.equal(await ctxWith(222, {}).sessionOriginalFor('post-a', 'post-a', '<p>live</p>'), '<p>live</p>');
    assert.equal(await ctxWith(222, { __originalsBackup: 'corrupt' }).sessionOriginalFor('post-a', 'post-a', null), '');
  });

  test('a storage error falls back instead of throwing', async () => {
    const c = ctxWith(222);
    c.__chrome.storage.local.get = async () => { throw new Error('storage broken'); };
    assert.equal(await c.sessionOriginalFor('post-a', 'post-a', '<p>live</p>'), '<p>live</p>');
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('Safety Gate settings (startBatch / applyLiveJobSettings)', () => {
  const GATE_FIELDS = ['gateEnabled', 'gateLinkCheck', 'gateNewFaq', 'gateSiteDomains', 'factCheck', 'factCheckAi', 'factCheckPrompt', 'factCheckOnError', 'promptWebSearch'];
  const pick = (job) => plain(GATE_FIELDS.reduce((o, k) => { o[k] = job[k]; return o; }, {}));
  const baseJob = (extra) => Object.assign({ slugs: ['a'], site: { url: 'https://www.example.org/', name: 'Ex' }, aiName: 'ChatGPT', aiUrl: 'https://chatgpt.com/', aiTimeout: 180, prompt: 'Edit it.' }, extra || {});
  const start = async (extra) => {
    const c = loadBackground();
    await c.startBatch(baseJob(extra), { deferProcess: true });
    return c;
  };
  const settingsLine = (c) => c.__logs().find((l) => /^info Settings:/.test(l)) || '';
  const FC_AI = { aiUrl: 'https://claude.ai/new', aiName: 'Claude', aiKind: 'builtin', aiMode: 'web', aiProvider: 'web', aiApiBaseUrl: '', aiApiModel: '', aiApiKey: '' };

  test('defaults: everything ON, safest choices', async () => {
    const c = await start();
    assert.deepEqual(pick(c.__run('runtime.job')), {
      gateEnabled: true, gateLinkCheck: true, gateNewFaq: 'auto', gateSiteDomains: [], factCheck: true,
      factCheckAi: '', factCheckPrompt: '', factCheckOnError: 'keep', promptWebSearch: false
    });
    assert.equal(c.safetyGateOn(), true);
    assert.equal(c.factCheckOn(), true);
    assert.match(settingsLine(c), /, Safety Gate ON, fact check ON$/);
    assert.deepEqual(plain(c.gateSiteDomainsOf()), ['example.org']);
  });

  test('panel strings and loose values are normalised', async () => {
    const c = await start({
      gateEnabled: 'off', gateLinkCheck: 'off', gateNewFaq: 'no', gateSiteDomains: 'https://www.Shop.Example.org/x, other.net; shop.example.org  bad/host:80 ',
      factCheck: 'off', factCheckAi: FC_AI, factCheckPrompt: 'FC TEXT', factCheckOnError: 'save', promptWebSearch: 'on'
    });
    assert.deepEqual(pick(c.__run('runtime.job')), {
      gateEnabled: false, gateLinkCheck: false, gateNewFaq: 'no', gateSiteDomains: ['shop.example.org', 'other.net', 'bad'], factCheck: false,
      factCheckAi: FC_AI, factCheckPrompt: 'FC TEXT', factCheckOnError: 'save', promptWebSearch: true
    });
    assert.equal(c.safetyGateOn(), false);
    assert.equal(c.factCheckOn(), false);
    assert.match(settingsLine(c), /, Safety Gate OFF, fact check OFF, web search allowed$/);
  });

  test('invalid values fall back to the safe defaults', async () => {
    const c = await start({
      gateEnabled: 0, gateLinkCheck: 'no', gateNewFaq: 'maybe', gateSiteDomains: 42, factCheck: null,
      factCheckAi: 'chatgpt', factCheckPrompt: 42, factCheckOnError: 'ignore', promptWebSearch: 'yes'
    });
    assert.deepEqual(pick(c.__run('runtime.job')), {
      gateEnabled: true, gateLinkCheck: true, gateNewFaq: 'auto', gateSiteDomains: ['42'], factCheck: true,
      factCheckAi: '', factCheckPrompt: '', factCheckOnError: 'keep', promptWebSearch: false
    });
    for (const bad of [{}, { aiName: 'x' }, { aiMode: 'web' }, []]) {
      assert.equal((await start({ factCheckAi: bad })).__run('runtime.job.factCheckAi'), '', JSON.stringify(bad));
    }
    const api = { aiMode: 'api', aiProvider: 'openai', aiApiModel: 'm', aiApiKey: 'k', aiUrl: '' };
    assert.deepEqual(plain((await start({ factCheckAi: api })).__run('runtime.job.factCheckAi')), api);
  });

  test('fact check is OFF whenever the gate is OFF', async () => {
    const c = await start({ gateEnabled: false, factCheck: true });
    assert.equal(c.__run('runtime.job.factCheck'), true);
    assert.equal(c.factCheckOn(), false);
    assert.match(settingsLine(c), /Safety Gate OFF, fact check OFF$/);
    const d = await start({ gateEnabled: true, factCheck: false });
    assert.equal(d.safetyGateOn(), true);
    assert.equal(d.factCheckOn(), false);
  });

  test('the fields the panel sends survive normalisation unchanged (idempotent)', async () => {
    const panelFields = {
      gateEnabled: true, gateLinkCheck: false, gateNewFaq: 'no', gateSiteDomains: ['shop.example.org', 'other.net'], factCheck: true,
      factCheckAi: FC_AI, factCheckPrompt: FACT_PROMPT.trim(), factCheckOnError: 'save', promptWebSearch: true
    };
    const c = await start(panelFields);
    assert.deepEqual(pick(c.__run('runtime.job')), plain(panelFields));
    c.__run('runtime.log.length = 0');
    c.applyLiveJobSettings(plain(panelFields));
    assert.deepEqual(pick(c.__run('runtime.job')), plain(panelFields));
    assert.deepEqual(plain(c.__logs().filter((l) => /Applied updated settings/.test(l))), []);
  });

  test('applyLiveJobSettings accepts and normalises all 9 fields', async () => {
    const c = await start();
    c.__run('runtime.log.length = 0');
    c.applyLiveJobSettings({
      gateEnabled: 'off', gateLinkCheck: 'off', gateNewFaq: 'no', gateSiteDomains: 'WWW.Other.net, https://shop.example.org/', factCheck: 'off',
      factCheckAi: FC_AI, factCheckPrompt: 'FC', factCheckOnError: 'save', promptWebSearch: true, notAllowed: 'x'
    });
    const job = c.__run('runtime.job');
    assert.deepEqual(pick(job), {
      gateEnabled: false, gateLinkCheck: false, gateNewFaq: 'no', gateSiteDomains: ['other.net', 'shop.example.org'], factCheck: false,
      factCheckAi: FC_AI, factCheckPrompt: 'FC', factCheckOnError: 'save', promptWebSearch: true
    });
    assert.equal(job.notAllowed, undefined);
    const applied = c.__logs().filter((l) => /Applied updated settings/.test(l));
    assert.equal(applied.length, 1);
    for (const k of GATE_FIELDS) assert.ok(applied[0].includes(k), k + ' missing from: ' + applied[0]);
    // switching back on live
    c.applyLiveJobSettings({ gateEnabled: 'on', factCheck: true, promptWebSearch: false });
    assert.equal(c.safetyGateOn(), true);
    assert.equal(c.factCheckOn(), true);
    assert.equal(job.promptWebSearch, false);
  });
});

// ──────────────────────────────────────────────────────────────────────
describe('full extraction chain with the shipped prompts', () => {
  const fetchLog = [];
  const fakeFetch = async (url, init) => { fetchLog.push({ url, method: init && init.method, credentials: init && init.credentials }); return { status: 200, ok: true, url }; };
  const newCtx = () => {
    const c = loadBackground({ fetch: fakeFetch });
    gateJob(c, { promptWebSearch: true });
    return c;
  };
  const chatgptReply = (html) => 'I tightened the intro and added a Quick Answer box.\nI opened two official pages to check the pressures.\n\n## FINAL HTML\n```html\n' + html + '\n' + END + '\n```';
  // What ChatGPT's code box holds in the DOM: a language label line, then the code (no fences).
  const codeBoxText = (html) => 'html\n' + html + '\n' + END;
  const pipelineCtx = (aiHtml, originalHtml) => ({
    slug: 'how-to-check-tyre-pressure', tag: '[1/1]', num: 1, total: 1, originalHtml, aiHtml,
    attemptLinks: { rawInput: 'how-to-check-tyre-pressure' }, attemptTabs: { edit: null, ai: null }, wpItem: { title: 'How to Check Tyre Pressure at Home' }
  });

  const CHAIN = [
    { label: 'block editor', ORIG: ORIG_BLOCK, GOOD: GOOD_BLOCK },
    // The classic edit turns the original's H3 FAQ questions into the
    // prompt's <details> accordion (8 → 5 headings) and has no conclusion:
    // the reply's closing <!-- APU-END --> is what proves it is complete.
    { label: 'classic editor', ORIG: ORIG_CLASSIC, GOOD: GOOD_CLASSIC }
  ];
  for (const { label, ORIG, GOOD } of CHAIN) {
    test('completeness check accepts the good ' + label + ' reply', () => {
      const c = newCtx();
      const extracted = c.cleanExtractedArticle(c.normalizeCodeText(codeBoxText(GOOD)));
      for (const level of ['balanced', 'strict']) {
        c.__run('runtime.job.completeness = ' + JSON.stringify(level));
        const comp = c.assessHtmlCompleteness(extracted, ORIG, c.completenessOptions());
        assert.equal(comp.complete, true, level + ': ' + plain(comp.reasons).join('; '));
      }
    });

    test('good ChatGPT-style reply (' + label + ') passes extraction, verifyHtml, prompt-leak check and the gate; saves marker-free HTML', async () => {
      const c = newCtx();
      const prompt = c.__run('runtime.job.prompt');
      // 1) extraction, browser (code box) and API (whole reply) paths agree
      const extracted = c.cleanExtractedArticle(c.normalizeCodeText(codeBoxText(GOOD)));
      assert.equal(extracted, GOOD + '\n' + END);
      assert.equal(c.extractHtmlFromAIText(chatgptReply(GOOD)), extracted);
      const picked = c.pickBestVerifiedCandidate([{ source: 'pre', text: codeBoxText(GOOD), fromAssistantMessage: true, languageHtml: true }], ORIG, prompt, 'loose', false);
      assert.ok(picked, 'the code box candidate was rejected');
      assert.equal(picked.text, extracted);
      // 2) v3.45.0 checks (completeness: see the test above)
      assert.deepEqual(plain(c.verifyHtml(extracted, ORIG, prompt, 'loose')), { ok: true });
      assert.equal(c.detectPromptLeak(extracted, prompt), null);
      const payloadPrompt = c.substitutePromptTokens(prompt, c.promptTokenValues({ postTitle: 'How to Check Tyre Pressure at Home' }));
      assert.equal(c.detectPromptLeak(extracted, payloadPrompt), null);
      assert.equal(c.detectPromptLeak(extracted, FACT_PROMPT), null);
      // 3) the shared gate directly
      const gate = await c.SafetyGate.runSafetyGate(ORIG, extracted, {
        siteDomains: c.gateSiteDomainsOf(), allowNewFaq: true, webSearchAllowed: true, checkLinks: true,
        endMarker: 'APU-END', requireEndMarker: true, fetchFn: fakeFetch
      });
      assert.equal(gate.ok, true, JSON.stringify(plain(gate.errors)));
      assert.equal(gate.html.includes('APU-END'), false);
      assert.equal(gate.html.trim(), GOOD);
      // 4) the processSlug hook (fact check off): the HTML that would be saved
      fetchLog.length = 0;
      const ctx = pipelineCtx(extracted, ORIG);
      const saved = await c.applySafetyPipeline(ctx);
      assert.equal(saved, GOOD);
      assert.equal(saved.includes('APU-END'), false);
      assert.ok(!ctx.attemptLinks.gate, 'a passing edit must not record gate reasons');
      assert.ok(c.__logs().some((l) => /^ok \[1\/1\] 🛡 Safety Gate PASSED/.test(l)), c.__logs().join('\n'));
      for (const f of fetchLog) assert.equal(f.credentials, 'omit');
    });
  }

  test('the link check only fetches NEW external links', async () => {
    const c = newCtx();
    fetchLog.length = 0;
    await c.applySafetyPipeline(pipelineCtx(GOOD_BLOCK + '\n' + END, ORIG_BLOCK));
    const newLinks = plain(c.SafetyGate.findNewLinks(ORIG_BLOCK, GOOD_BLOCK, { siteDomains: ['tubetyre.com'] }));
    assert.ok(newLinks.length > 0);
    assert.deepEqual([...new Set(fetchLog.map((f) => f.url))].sort(), newLinks.slice().sort());
  });

  test('a reply cut off before <!-- APU-END --> is blocked (post not changed)', async () => {
    const c = newCtx();
    const cutOff = GOOD_BLOCK.slice(0, Math.floor(GOOD_BLOCK.length * 0.97));
    const extracted = c.cleanExtractedArticle(c.normalizeCodeText(codeBoxText(cutOff).replace('\n' + END, '')));
    const ctx = pipelineCtx(extracted, ORIG_BLOCK);
    await assert.rejects(c.applySafetyPipeline(ctx), (e) => {
      assert.equal(e.code, 'SAFETY_GATE');
      assert.match(e.message, /^SAFETY GATE BLOCKED: (?:[A-Z_]+, )*END_MARKER_MISSING[,. —]/);
      assert.match(e.message, /The post was NOT changed\.$/);
      assert.ok(!e.message.includes('AUDIT ISSUES'));
      return true;
    });
    assert.ok(plain(ctx.attemptLinks.gate.codes).includes('END_MARKER_MISSING'));
  });

  test('fails closed when the gate itself misbehaves', async () => {
    const cases = [
      [async () => { throw new Error('boom'); }, 'INTERNAL_ERROR', /the Safety Gate crashed: boom/],
      [async () => null, 'INTERNAL_ERROR', /returned no result/],
      [async () => ({ ok: false, errors: [], warnings: [], removedLinks: [] }), 'GATE_FAILED', /did not approve/],
      [async () => ({ ok: 'yes', html: '<p>x</p>', errors: [], warnings: [] }), 'GATE_FAILED', /did not approve/],
      [async () => ({ ok: true, html: '<p>x</p>', errors: [{ code: 'IMG_COUNT', message: 'AUDIT ISSUES: 1 image missing' }], warnings: [] }), 'IMG_COUNT', /audit problems: 1 image missing/],
      [async () => ({ ok: true, html: '   ', errors: [], warnings: [] }), 'INTERNAL_ERROR', /returned empty HTML/]
    ];
    for (const [fn, code, re] of cases) {
      const c = newCtx();
      c.SafetyGate = Object.assign({}, c.SafetyGate, { runSafetyGate: fn });
      const ctx = pipelineCtx(GOOD_BLOCK + '\n' + END, ORIG_BLOCK);
      await assert.rejects(c.applySafetyPipeline(ctx), (e) => {
        assert.equal(e.code, 'SAFETY_GATE');
        assert.ok(e.message.startsWith('SAFETY GATE BLOCKED: ' + code), e.message);
        assert.match(e.message, re);
        assert.ok(!e.message.includes('AUDIT ISSUES'), e.message);
        return true;
      });
      assert.deepEqual(plain(ctx.attemptLinks.gate.codes), [code]);
    }
  });

  test('"AUDIT ISSUES" split by a line break never reaches a failure message', () => {
    const c = newCtx();
    // The whitespace is collapsed BEFORE the rewrite, so one pass is enough.
    assert.equal(c.safetyMessageText('AUDIT\nISSUES:  2 images'), 'audit problems: 2 images');
    const e = c.factCheckError('the AI replied with an AUDIT\n  ISSUES list');
    assert.equal(e.code, 'FACT_CHECK_ERROR');
    assert.ok(!/AUDIT\s+ISSUES/i.test(e.message), e.message);
  });

  test('with the gate OFF the edit is returned as generated (v3.45.0 behaviour), minus the end marker', async () => {
    const c = newCtx();
    c.__run('runtime.job.gateEnabled = false');
    // no marker: byte-identical, as in v3.45.0
    assert.equal(await c.applySafetyPipeline(pipelineCtx(GOOD_BLOCK, ORIG_BLOCK)), GOOD_BLOCK);
    // the seeded prompt's <!-- APU-END --> is never written into the post
    assert.equal(await c.applySafetyPipeline(pipelineCtx(GOOD_BLOCK + '\n' + END, ORIG_BLOCK)), GOOD_BLOCK);
    assert.equal(await c.applySafetyPipeline(pipelineCtx(GOOD_BLOCK + '\n<!--apu-end-->\n', ORIG_BLOCK)), GOOD_BLOCK);
    // also without safety-gate.js
    const g = loadBackground({ gate: false });
    gateJob(g, { gateEnabled: false });
    assert.equal(await g.applySafetyPipeline(pipelineCtx(GOOD_BLOCK + '\n' + END, ORIG_BLOCK)), GOOD_BLOCK);
    assert.ok(!c.__logs().some((l) => /Safety Gate/.test(l)));
  });

  // With the gate on, verifyHtml's report-leak check only counts report
  // heading / divider lines the original does not have.
  test('a good edit that says "a fixed article of clothing" near the top is saved', () => {
    const c = newCtx();
    const good = GOOD_BLOCK.replace('</p>', ' A tyre gauge is as much a fixed article of kit as a spare wheel.</p>');
    assert.notEqual(good, GOOD_BLOCK);
    const extracted = c.cleanExtractedArticle(c.normalizeCodeText(codeBoxText(good)));
    assert.equal(extracted, good + '\n' + END);
    assert.deepEqual(plain(c.verifyHtml(extracted, ORIG_BLOCK, c.__run('runtime.job.prompt'), 'loose')), { ok: true });
  });
});

// ──────────────────────────────────────────────────────────────────────
// Review fixes (v3.46.0 hardening round)
// ──────────────────────────────────────────────────────────────────────
// A fake clock for the wait loops: sleep() advances time instead of waiting.
function fakeClock(c) {
  let now = 1000000;
  const RealDate = Date;
  function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(now); }
  FakeDate.now = () => now;
  c.Date = FakeDate;
  const clock = { now: () => now, onSleep: null };
  c.sleep = async (ms) => { now += ms; if (clock.onSleep) clock.onSleep(); };
  c.pumpFrozenTab = async () => null;
  c.limitErrorIfLimited = async () => null;
  return clock;
}

describe('fact-check wait (waitForFactCheckJson)', () => {
  const PASS = '{"verdict":"pass","issues":[]}';
  const REJECT = '{"verdict":"reject","issues":[{"severity":"high","category":"fact_wrong","quote":"x","problem":"p","fix":"f"}]}';
  // snapshotAt(elapsedMs) → the readAIJsonSnapshot result at that moment
  const setup = (snapshotAt, job) => {
    const c = loadBackground();
    const clock = fakeClock(c);
    c.__setJob(Object.assign({ limitGuard: true, aiTimeout: 1800 }, job || {}));
    const t0 = clock.now();
    c.runInTab = async (tabId, fn) => (fn.name === 'readAIJsonSnapshot' ? { result: snapshotAt(clock.now() - t0) } : { result: {} });
    return { c, clock, elapsed: () => clock.now() - t0 };
  };
  const run = (c, limitMs) => c.waitForFactCheckJson(1, limitMs || 1800000, 'chatgpt', { tag: '[t]' });

  test('a static "Thinking" line while the stop button shows is not a finished reply', async () => {
    const { c, elapsed } = setup((t) => t < 300000
      ? { isGenerating: true, texts: [], messageText: 'Thinking' }
      : { isGenerating: false, texts: [PASS], messageText: PASS });
    const r = await run(c);
    assert.equal(r.audit.verdict, 'pass');
    assert.ok(elapsed() >= 300000);
  });

  test('a static "Searching the web…" status line (no stop button) is not a reply without JSON either', async () => {
    const { c, elapsed } = setup((t) => t < 240000
      ? { isGenerating: false, texts: [], messageText: 'Searching the web…' }
      : { isGenerating: false, texts: [PASS], messageText: PASS });
    assert.equal((await run(c)).audit.verdict, 'pass');
    assert.ok(elapsed() >= 240000);
  });

  test('a stuck stop button with a valid verdict on screen is accepted', async () => {
    const { c, elapsed } = setup(() => ({ isGenerating: true, texts: [PASS], messageText: PASS }));
    assert.equal((await run(c)).audit.verdict, 'pass');
    assert.ok(elapsed() >= 75000 && elapsed() < 120000, String(elapsed()));
  });

  test('a finished prose reply without JSON still fails after ~30 s (FACT_CHECK_ERROR)', async () => {
    const prose = 'I checked both versions of the article carefully and everything in the edited version looks accurate to me overall.';
    const { c, elapsed } = setup(() => ({ isGenerating: false, texts: [], messageText: prose }));
    await assert.rejects(run(c), (e) => {
      assert.equal(e.code, 'FACT_CHECK_ERROR');
      assert.match(e.message, /no valid JSON verdict/);
      return true;
    });
    assert.ok(elapsed() < 60000, String(elapsed()));
  });

  test('the overall timeout still caps a reply that never finishes', async () => {
    const { c, elapsed } = setup(() => ({ isGenerating: true, texts: [], messageText: 'Thinking' }));
    await assert.rejects(run(c, 600000), (e) => e.code === 'FACT_CHECK_ERROR' && /within 600s/.test(e.message));
    assert.ok(elapsed() >= 600000 && elapsed() < 610000, String(elapsed()));
  });

  test('time spent paused does not count against the wait', async () => {
    const { c, clock, elapsed } = setup((t) => t < 60000
      ? { isGenerating: true, texts: [], messageText: '' }
      : { isGenerating: false, texts: [PASS], messageText: PASS });
    let polls = 0;
    const origRunInTab = c.runInTab;
    c.runInTab = async (tabId, fn, args) => { if (fn.name === 'readAIJsonSnapshot') polls++; return origRunInTab(tabId, fn, args); };
    let pausedOnce = false;
    clock.onSleep = () => {
      if (polls === 3 && !pausedOnce) { pausedOnce = true; c.__set('runtime.paused', true); }
      else if (c.__run('runtime.paused') === true && elapsed() > 35 * 60000) c.__set('runtime.paused', false);
    };
    const r = await c.waitForFactCheckJson(1, 30 * 60000, 'chatgpt', { tag: '[t]' });
    assert.equal(r.audit.verdict, 'pass');
    assert.ok(pausedOnce && elapsed() > 35 * 60000);
  });

  test('several verdicts in one reply: the most severe wins (draft "pass", then "reject")', async () => {
    const { c } = setup(() => ({ isGenerating: false, texts: [PASS, REJECT], messageText: 'Draft: ' + PASS + ' Corrected: ' + REJECT }));
    assert.equal((await run(c)).audit.verdict, 'reject');
    const r2 = setup(() => ({ isGenerating: false, texts: [REJECT, PASS], messageText: '' }));
    assert.equal((await run(r2.c)).audit.verdict, 'reject');
  });

  test('our own prompt echoed back is never read as the reply', async () => {
    const own = 'ORIGINAL ARTICLE HTML START ' + PASS;
    const { c } = setup(() => ({ isGenerating: false, texts: [own], messageText: own }));
    await assert.rejects(run(c, 200000), (e) => e.code === 'FACT_CHECK_ERROR');
  });
});

describe('parseFactCheckReply: several verdicts', () => {
  const c = loadBackground();
  const V = (verdict, n) => JSON.stringify({ verdict, issues: Array.from({ length: n || 0 }, (_, i) => ({ severity: 'high', quote: 'q' + i, problem: 'p' })) });
  test('the most severe verdict wins; ties go to the later one', () => {
    assert.equal(c.parseFactCheckReply('```json\n' + V('pass') + '\n```\nWait, I missed something.\n```json\n' + V('reject', 1) + '\n```').audit.verdict, 'reject');
    assert.equal(c.parseFactCheckReply('```json\n' + V('reject', 1) + '\n```\n```json\n' + V('pass') + '\n```').audit.verdict, 'reject');
    assert.equal(c.parseFactCheckReply('First ' + V('fix', 1) + ' then ' + V('pass') + ' done').audit.verdict, 'fix');
    const tie = c.parseFactCheckReply('```json\n' + V('fix', 1) + '\n```\nCorrected:\n```json\n' + V('fix', 2) + '\n```');
    assert.equal(tie.audit.issues.length, 2);
    // one verdict, found both as a fenced block and by the brace scan: counted once
    assert.equal(c.parseFactCheckReply('```json\n' + V('fix', 1) + '\n```').audit.issues.length, 1);
  });
});

describe('Safety Gate options, backups, tabs, links (review fixes)', () => {
  test('the gate gets today and the post title (TITLE_IN_BODY, today-without-research)', async () => {
    const c = loadBackground();
    gateJob(c, { promptWebSearch: false, gateLinkCheck: false, prompt: 'Edit it.' });
    const para = (i) => '<p>Paragraph ' + i + ' explains how the old ferry route works for visitors who arrive early and want to reach the island before noon.</p>';
    let body = '';
    for (let i = 1; i <= 8; i++) body += para(i) + '\n';
    const original = '<p>Getting to the island is easy if you plan the crossing a little in advance.</p>\n<h2>Route</h2>\n' + body;
    const withTitle = '<p>How to Reach Blue Island by Ferry</p>\n' + original;
    const ctx = { tag: '[t]', attemptLinks: {}, wpItem: { title: 'How to Reach Blue Island by Ferry' } };
    await assert.rejects(c.runSafetyGateStep(ctx, original, withTitle, 'AI'), (e) => e.code === 'SAFETY_GATE' && /TITLE_IN_BODY/.test(e.message));
    // the options the gate receives: the local date of [[TODAY]] and the plain title
    const seen = [];
    const realGate = c.SafetyGate.runSafetyGate;
    c.SafetyGate = Object.assign({}, c.SafetyGate, { runSafetyGate: (r, h, o) => { seen.push(o); return realGate(r, h, o); } });
    await c.runSafetyGateStep({ tag: '[t]', attemptLinks: {}, wpItem: { title: 'Best &#8216;Pro&#8217; Ferries' } }, original, original.replace('Getting', 'Reaching'), 'AI');
    await c.runSafetyGateStep({ tag: '[t]', attemptLinks: { postTitle: 'From the attempt' }, wpItem: { title: 'x' } }, original, original.replace('Getting', 'Reaching'), 'AI');
    assert.equal(seen[0].today, c.localDateYmd());
    assert.equal(seen[0].postTitle, 'Best \u2018Pro\u2019 Ferries');
    assert.equal(seen[1].postTitle, 'From the attempt');
    const dated = original.replace('in advance.</p>', 'in advance. The new timetable starts ' + c.localDateYmd() + '.</p>');
    // today's date without research is a research rule: it applies to Safety Gate prompts (they ask for <!-- APU-END -->) ...
    c.__run('runtime.job.prompt = "Edit it. End with <!-- APU-END -->."');
    await assert.rejects(c.runSafetyGateStep({ tag: '[t]', attemptLinks: { postTitle: 'Other title' } }, original, dated + '\n' + END, 'AI'),
      (e) => e.code === 'SAFETY_GATE' && /LAST_CHECKED_WITHOUT_RESEARCH/.test(e.message));
    // ... not to other prompts (structure rules only)
    c.__run('runtime.job.prompt = "Edit it."');
    assert.equal(await c.runSafetyGateStep({ tag: '[t]', attemptLinks: { postTitle: 'Other title' } }, original, dated, 'AI'), dated.trim());
  });

  const siteBackups = [
    { slug: 'best-boots', sessionId: 7, site: 'Site A', link: 'https://a.example/best-boots/', time: '2026-09-01T10:00:00.000Z', html: '<p>SITE A article about boots, the original text.</p>' },
    { slug: 'best-boots', sessionId: 7, site: 'Site B', link: 'https://www.b.example/best-boots/', time: '2026-09-02T10:00:00.000Z', html: '<p>SITE B article about boots, the original text.</p>' }
  ];
  test('Fresh Recovery and the gate reference only use backups of the running site', async () => {
    const c = loadBackground({ storage: { __originalsBackup: siteBackups } });
    c.__set('runtime.sessionId', 7);
    c.__setJob({ site: { url: 'https://b.example/', name: 'Site B' } });
    assert.match((await c.findOriginalBackup('best-boots', 'best-boots')).html, /SITE B/);
    assert.match(await c.sessionOriginalFor('best-boots', 'best-boots', '<p>live</p>'), /SITE B/);
    // renamed site: the link host still matches
    c.__setJob({ site: { url: 'https://a.example', name: 'My renamed site' } });
    assert.match((await c.findOriginalBackup('best-boots', '')).html, /SITE A/);
    // another site with the same slug: no backup (Fresh Recovery refuses), the gate uses the live HTML
    c.__setJob({ site: { url: 'https://c.example', name: 'Site C' } });
    assert.equal(await c.findOriginalBackup('best-boots', 'best-boots'), null);
    assert.equal(await c.sessionOriginalFor('best-boots', 'best-boots', '<p>live C</p>'), '<p>live C</p>');
  });

  test('parallel backups are all kept (writes are serialised)', async () => {
    const c = loadBackground();
    c.__set('runtime.sessionId', 9);
    c.__setJob({ site: { url: 'https://a.example', name: 'A' } });
    const orig = (s) => '<p>ORIGINAL article of ' + s + ' with enough characters to count.</p>';
    await Promise.all(['s1', 's2', 's3', 's4', 's5'].map((s) => c.saveOriginalBackup(s, s, 'https://a.example/' + s + '/', orig(s), '')));
    assert.deepEqual(plain(c.__storage.__originalsBackup.map((b) => b.slug)), ['s1', 's2', 's3', 's4', 's5']);
    assert.equal(c.__storage.__originalsBackupCount, 5);
    assert.equal(await c.sessionOriginalFor('s3', 's3', '<p>AI-edited live</p>'), orig('s3'));
  });

  test('after a worker restart the fact-check AI tab is closed too', async () => {
    const c = loadBackground();
    const tabs = { 11: 'https://site.example/wp-admin/post.php?post=5&action=edit', 12: 'https://chatgpt.com/c/abc', 13: 'https://claude.ai/chat/1b2c3d4e', 14: 'https://news.example/' };
    const removed = [];
    c.__chrome.tabs.get = async (id) => { if (!tabs[id]) throw new Error('No tab'); return { id, url: tabs[id] }; };
    c.__chrome.tabs.remove = async (id) => { removed.push(id); delete tabs[id]; };
    c.safeCloseTab = async (id) => { removed.push(id); delete tabs[id]; return true; };
    c.__set('runtime.trackedTabs', [11, 12, 13, 14]);
    c.__setJob({ site: { url: 'https://site.example' }, aiUrl: 'https://chatgpt.com/', factCheckAi: { aiUrl: 'https://claude.ai/new', aiName: 'Claude' } });
    await c.closeOrphanedWorkTabs();
    assert.deepEqual(removed.slice().sort(), [11, 12, 13]);
    assert.ok(tabs[14], 'an unrelated tab is never closed');
  });

  test('the link check never requests loopback / private-network addresses', async () => {
    const fetched = [];
    const c = loadBackground({ fetch: async (url) => { fetched.push(url); return { status: 200, ok: true, url }; } });
    for (const u of ['http://localhost:8080/x', 'http://127.0.0.1/', 'http://2130706433/admin', 'http://192.168.1.1/cgi-bin/reboot', 'http://10.0.0.5/', 'http://172.20.1.1/',
      'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://[fd00::1]/', 'http://router/', 'http://nas.local/', 'http://0.0.0.0/']) {
      await assert.rejects(c.gateFetch(u), (e) => e.name === 'TypeError' && /private network/.test(e.message), u);
    }
    assert.deepEqual(fetched, []);
    await c.gateFetch('https://www.example.com/page');
    await c.gateFetch('http://172.32.0.1/');
    assert.deepEqual(fetched, ['https://www.example.com/page', 'http://172.32.0.1/']);
    // the gate unwraps such a new link (it is classified like an unknown host)
    const r = await c.SafetyGate.checkLinks(['http://192.168.0.1/'], { fetchFn: c.gateFetch });
    assert.equal(plain(r)[0].verdict, 'dead');
  });

  test('attempt rows keep only a summary of the gate / fact-check details', () => {
    const c = loadBackground();
    c.__setJob({ aiName: 'ChatGPT', aiUrl: 'https://chatgpt.com/' });
    c.__set('runtime.attempts', []);
    const big = (n) => 'x'.repeat(n);
    const issue = { severity: 'high', category: big(40), quote: big(200), problem: big(300), fix: big(300) };
    const links = {
      gate: { codes: Array(20).fill('SOME_CODE'), messages: Array(20).fill(big(300)), warnings: Array(20).fill(big(300)), removedLinks: Array(20).fill(big(300)) },
      factCheck: { verdict: 'fix', issues: c.compactFactIssues(Array(12).fill(issue)), dropped: c.compactFactIssues(Array(12).fill(issue)), aiSessionUrl: 'https://chatgpt.com/c/x', fixRound: true, error: '' }
    };
    c.rememberAttempt('p', 'p', 'failed', 'FACT CHECK BLOCKED: x', links);
    const row = plain(c.__run('runtime.attempts'))[0];
    assert.ok(JSON.stringify(row).length < 9000, String(JSON.stringify(row).length));
    assert.equal(row.factCheck.issues.length, 5);
    assert.equal(row.factCheck.issueCount, 12);
    assert.equal(row.factCheck.dropped, 12);
    assert.equal(row.factCheck.verdict, 'fix');
    assert.equal(row.factCheck.aiSessionUrl, 'https://chatgpt.com/c/x');
    assert.equal(row.gate.codes.length, 20);
    assert.equal(row.gate.messages.length, 5);
    assert.equal(row.gate.removedLinks, 20);
    c.rememberAttempt('q', 'q', 'updated', 'Updated on WordPress', {});
    assert.equal(plain(c.__run('runtime.attempts'))[1].gate, null);
    assert.equal(plain(c.__run('runtime.attempts'))[1].factCheck, null);
  });
});

describe('extraction / completeness / leak check (review fixes)', () => {
  const c = loadBackground();
  gateJob(c);
  test('chat labels in brackets before the article are not shortcodes', () => {
    const art = '<p>Intro paragraph about ferries.</p>\n<h2>Route</h2>\n<p>Body.</p>';
    for (const label of ['[Final HTML]', '[Updated article]', '[Summary] I kept every image and link.', '[note] I kept every image.']) {
      assert.equal(c.cleanExtractedArticle(label + '\n' + art), art, label);
    }
    assert.equal(c.cleanExtractedArticle(art + '\n[Note] no changes to images]'), art);
    // real shortcodes are kept
    for (const sc of ['[toc]', '[caption id="attachment_7" width="800"]<img src="a.jpg"> A caption[/caption]', '[su_note]Check the tide times first.[/su_note]', '[et_pb_section][et_pb_row]']) {
      assert.equal(c.cleanExtractedArticle(sc + '\n' + art), sc + '\n' + art, sc);
    }
  });

  test('a reply ending with <!-- APU-END --> is not "truncated" by the heading count alone', () => {
    const sec = (i) => '<h2>Section ' + i + '</h2>\n<p>' + 'Body text of the section with enough words to matter. '.repeat(3) + '</p>\n';
    let orig = '<p>Intro.</p>\n';
    for (let i = 1; i <= 6; i++) orig += sec(i);
    orig += '<h2>FAQ</h2>\n';
    for (let i = 1; i <= 6; i++) orig += '<h3>Question ' + i + '?</h3>\n<p>Answer ' + i + ' with a few words of explanation.</p>\n';
    let edit = '<p>Intro.</p>\n';
    for (let i = 1; i <= 6; i++) edit += sec(i);
    edit += '<h2>FAQ</h2>\n';
    for (let i = 1; i <= 6; i++) edit += '<details><summary>Question ' + i + '?</summary><p>Answer ' + i + ' with a few words of explanation.</p></details>\n';
    edit += '<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[' + '{"@type":"Question","name":"Q","acceptedAnswer":{"@type":"Answer","text":"A long enough answer text here."}},'.repeat(6).slice(0, -1) + ']}</script>';
    const opts = c.completenessOptions();
    const without = c.assessHtmlCompleteness(edit, orig, opts);
    assert.equal(without.complete, false);
    assert.match(plain(without.reasons).join(' '), /section headings present/);
    assert.equal(c.assessHtmlCompleteness(edit + '\n' + END, orig, opts).complete, true);
    // a marker does not hide a real cut (other reasons still count)
    const cut = edit.slice(0, Math.floor(edit.length * 0.5)) + '\n' + END;
    assert.equal(c.assessHtmlCompleteness(cut, orig, opts).complete, false);
  });

  test('report-leak check: gate ON flags only new report heading / divider lines; gate OFF is v3.45.0', () => {
    const g = loadBackground();
    gateJob(g);
    const orig = '<p>Intro.</p>\n<h2>Clothes</h2>\n<p>Body text.</p>'.repeat(3);
    const prompt = 'Edit it.';
    const ok = (html, o) => plain(g.verifyHtml(html, o || orig, prompt, 'loose')).ok;
    const edit = (x) => '<p>Intro, now clearer.</p>\n' + x + '\n<h2>Clothes</h2>\n<p>Body text, edited.</p>'.repeat(3);
    assert.equal(ok(edit('<p>A scarf is a fixed article of clothing.</p>')), true);
    assert.equal(ok(edit('<p>Common <a href="/x">audit issues</a> include slow pages.</p>')), true);
    assert.equal(ok(edit('<h2>AUDIT ISSUES</h2><ul><li>weak intro</li></ul>')), false);
    assert.equal(ok(edit('<p><strong>── FIXED ARTICLE ──</strong></p>')), false);
    assert.equal(ok(edit('## Full Audit Report')), false);
    // the original has the heading itself → keeping it is not a leak
    const seoOrig = '<p>Intro.</p>\n<h2>Audit issues checklist</h2>\n<p>Body text.</p>'.repeat(2);
    assert.equal(ok('<p>Intro, now clearer.</p>\n<h2>Audit issues checklist</h2>\n<p>Body text, edited.</p>'.repeat(2), seoOrig), true);
    assert.equal(plain(g.verifyRecoverableHtml(edit('<h2>FIXED ARTICLE</h2>'), prompt)).ok, false);
    assert.equal(plain(g.verifyRecoverableHtml(edit('<p>A fixed article of clothing.</p>'), prompt)).ok, true);
    // gate OFF: the v3.45.0 check, unchanged
    g.__run('runtime.job.gateEnabled = false');
    assert.equal(ok(edit('<p>A scarf is a fixed article of clothing.</p>')), false);
  });
});

describe('Stop, limits and copy capture (review fixes)', () => {
  const pipelineCtx = (aiHtml) => ({ slug: 's', tag: '[1/1]', num: 1, total: 1, originalHtml: ORIG_BLOCK, aiHtml,
    attemptLinks: { rawInput: 's' }, attemptTabs: { edit: null, ai: null }, wpItem: { title: 'T' } });

  test('Stop pressed during the gate / fact check: nothing is returned for saving', async () => {
    const c = loadBackground();
    gateJob(c);
    c.SafetyGate = Object.assign({}, c.SafetyGate, { runSafetyGate: async (ref, html) => { c.__set('runtime.stopRequested', true); return { ok: true, html: '<p>edited</p>', errors: [], warnings: [], removedLinks: [] }; } });
    await assert.rejects(c.applySafetyPipeline(pipelineCtx('<p>edited</p>')), (e) => e.code === 'USER_STOPPED');
    // with the fact check on: a passing verdict that arrives after Stop is not saved either
    const f = loadBackground();
    gateJob(f, { factCheck: true });
    f.SafetyGate = Object.assign({}, f.SafetyGate, { runSafetyGate: async () => ({ ok: true, html: '<p>edited</p>', errors: [], warnings: [], removedLinks: [] }) });
    f.runFactCheck = async () => { f.__set('runtime.stopRequested', true); return { verdict: 'pass', issues: [], dropped: [], retryIssues: [], action: 'pass', aiSessionUrl: '' }; };
    await assert.rejects(f.applySafetyPipeline(pipelineCtx('<p>edited</p>')), (e) => e.code === 'USER_STOPPED');
  });

  test('a limit hit by the fact-check AI carries that AI\'s name', async () => {
    const c = loadBackground();
    gateJob(c, { aiName: 'ChatGPT', factCheck: true, factCheckAi: { aiUrl: 'https://claude.ai/new', aiName: 'Claude', aiMode: 'web' } });
    c.checkAIModelLimit = async () => ({ limited: true, kind: 'limit', evidence: 'usage limit' });
    const e1 = await c.limitErrorIfLimited(1, 'claude', '[t]', 'x', 'Claude');
    assert.equal(e1.code, 'MODEL_LIMIT');
    assert.equal(e1.aiName, 'Claude');
    assert.match(e1.message, /MODEL LIMIT — Claude is limited/);
    assert.equal((await c.limitErrorIfLimited(1, 'chatgpt', '[t]', 'x')).aiName, 'ChatGPT');
    c.factCheckPromptText = async () => 'Check it.';
    c.runFactCheckInTab = async () => { const e = new Error('AI usage limit reached'); e.code = 'AI_LIMIT'; throw e; };
    await assert.rejects(c.runFactCheck({ tag: '[t]', referenceHtml: '<p>a</p>', editedHtml: '<p>b</p>', attemptLinks: {} }),
      (e) => e.code === 'AI_LIMIT' && e.aiName === 'Claude');
  });

  test('parallel batch: a limit pauses the batch and is not retried', async () => {
    const c = loadBackground();
    const job = gateJob(c, { slugs: ['a', 'b'], parallel: 2, maxRetries: 2, retryMode: 'inline', aiName: 'ChatGPT' });
    job.limitGuard = true;
    const calls = [];
    c.processSlug = async (slug) => { calls.push(slug); const e = new Error('AI usage limit reached — weekly limit'); e.code = 'AI_LIMIT'; e.limitText = 'weekly limit'; throw e; };
    c.tryHtmlRecovery = async () => false;
    c.persistRuntime = async () => {};
    c.swPing = async () => {};
    // the first slot starts at once; slot 2 waits (its 5 s stagger), then sees the pause and holds until Stop
    c.sleep = async (ms) => {
      if (ms >= 5000 && !c.__run('runtime.paused')) await new Promise((r) => setTimeout(r, 50));
      if (c.__run('runtime.paused')) c.__set('runtime.stopRequested', true);
    };
    c.__set('runtime.paused', false);
    c.__set('runtime.stopRequested', false);
    await c.runParallelBatch();
    assert.deepEqual(calls, ['a']);
    assert.equal(c.__run('runtime.paused'), true);
    assert.match(c.__run('runtime.autoPauseReason'), /usage limit/);
  });

  test('a copy capture that never answers gives up instead of hanging the post', async () => {
    const c = loadBackground();
    c.__setJob({ site: { url: 'https://a.example' } });
    c.runInTabMain = () => new Promise(() => {});      // the page never resolves (clipboard prompt)
    const realSetTimeout = setTimeout;
    c.setTimeout = (fn, ms) => realSetTimeout(fn, ms === 20000 ? 20 : ms);
    const t0 = Date.now();
    assert.equal(await c.tryCopyRaw(1, 'chatgpt'), '');
    assert.equal(await c.tryCopyButtonExtract(1, '<p>o</p>', 'p', 'loose', 'chatgpt', false), '');
    assert.ok(Date.now() - t0 < 5000);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Rule set per prompt type, automatic retry notes, end-marker completeness
// ──────────────────────────────────────────────────────────────────────
describe('rule sets per prompt type (Safety Gate prompt vs legacy prompt)', () => {
  const AMAZON = panelDefaultPrompts().DEFAULT_PROMPTS.find((p) => p.id === 'p_single_amazon');

  test('runSafetyGateStep: full rules for a Safety Gate prompt, structure rules (and 60% retention) for any other prompt', async () => {
    assert.ok(AMAZON && AMAZON.text.indexOf('APU-END') < 0, 'the built-in Amazon prompt has no end marker');
    const c = loadBackground();
    gateJob(c, { promptWebSearch: false, gateLinkCheck: false });
    const seen = [];
    const real = c.SafetyGate.runSafetyGate;
    c.SafetyGate = Object.assign({}, c.SafetyGate, { runSafetyGate: (r, h, o) => { seen.push(o); return real(r, h, o); } });
    assert.equal(c.promptRequiresEndMarker(), true);
    await c.runSafetyGateStep({ tag: '[t]', attemptLinks: {} }, ORIG_BLOCK, GOOD_BLOCK + '\n' + END, 'AI');
    assert.equal(seen[0].researchRules, true);
    assert.equal(seen[0].requireEndMarker, true);
    assert.equal(seen[0].webSearchAllowed, false);
    assert.equal('minRetention' in seen[0], false, 'Safety Gate prompts keep the validator default (75%)');
    assert.ok(c.__logs().some((l) => l === 'info [t] 🛡 Gate rules: full rules — Safety Gate prompt.'), c.__logs().join('\n'));
    c.__run('runtime.job.prompt = ' + JSON.stringify(AMAZON.text));
    assert.equal(c.promptRequiresEndMarker(), false);
    await c.runSafetyGateStep({ tag: '[t]', attemptLinks: {} }, ORIG_BLOCK, GOOD_BLOCK, 'AI');
    assert.equal(seen[1].researchRules, false);
    assert.equal(seen[1].requireEndMarker, false);
    assert.equal(seen[1].minRetention, 0.6);
    assert.equal(c.LEGACY_PROMPT_MIN_RETENTION, undefined, 'a top-level const, not a context property');
    assert.ok(c.__logs().some((l) => /^info \[t\] 🛡 Gate rules: structure rules — this prompt is not a Safety Gate prompt \(no <!-- APU-END --> end marker\).*word-retention minimum 60%\.$/.test(l)), c.__logs().join('\n'));
  });

  test('a legacy affiliate edit (price removed, "Last updated" line, new live deep link) is saved; the same edit is blocked for a Safety Gate prompt; images stay protected', async () => {
    const fetched = [];
    const c = loadBackground({ fetch: async (url, init) => { fetched.push(url); return { status: 200, ok: true, url }; } });
    gateJob(c, { site: { url: 'https://getcostidea.com/', name: 'Get Cost Idea' }, prompt: AMAZON.text, promptWebSearch: false });
    const DEEP = 'https://www.sherwin-williams.com/en-us/color/paint-calculator';
    const edit = GOOD_CLASSIC.split('before 1978').join('long ago').replace('<h2>Should You Paint',
      '<p><em>Last updated: ' + c.localDateYmd() + '</em></p>\n<p>Use a <a href="' + DEEP + '">paint calculator</a> before you buy.</p>\n<h2>Should You Paint');
    assert.notEqual(edit, GOOD_CLASSIC);
    const ctx = (html) => ({ slug: 'paint-cost', tag: '[1/1]', num: 1, total: 1, originalHtml: ORIG_CLASSIC, aiHtml: html,
      attemptLinks: { rawInput: 'paint-cost' }, attemptTabs: { edit: null, ai: null }, wpItem: { title: 'How Much Does It Cost to Paint a Room?' } });
    const saved = await c.applySafetyPipeline(ctx(edit));
    assert.equal(saved, edit);
    assert.ok(saved.includes('<a href="' + DEEP + '">paint calculator</a>'), 'the live deep link is kept');
    assert.ok(fetched.includes(DEEP), 'the new deep link was link-checked');
    // a dead deep link is still unwrapped (the words stay)
    const d = loadBackground({ fetch: async (url) => ({ status: url === DEEP ? 404 : 200, ok: url !== DEEP, url }) });
    gateJob(d, { site: { url: 'https://getcostidea.com/', name: 'Get Cost Idea' }, prompt: AMAZON.text, promptWebSearch: false });
    const savedDead = await d.applySafetyPipeline(ctx(edit));
    assert.ok(!savedDead.includes(DEEP) && savedDead.includes('Use a paint calculator before you buy.'));
    // the same edit under a Safety Gate prompt (end marker added): research rules block it
    c.__run('runtime.job.prompt = ' + JSON.stringify(EDITOR_PROMPT));
    const gateCtx = ctx(edit + '\n' + END);
    await assert.rejects(c.applySafetyPipeline(gateCtx), (e) => e.code === 'SAFETY_GATE');
    const codes = plain(gateCtx.attemptLinks.gate.codes);
    for (const code of ['LAST_CHECKED_WITHOUT_RESEARCH', 'NUMBER_MISSING']) assert.ok(codes.includes(code), codes.join(','));
    // structure rules still protect the images
    c.__run('runtime.job.prompt = ' + JSON.stringify(AMAZON.text));
    const noImg = ctx(edit.replace('<img', '<span'));
    await assert.rejects(c.applySafetyPipeline(noImg), (e) => e.code === 'SAFETY_GATE' && /IMG_COUNT/.test(e.message));
    assert.ok(!plain(noImg.attemptLinks.gate.codes).some((x) => /RESEARCH|NUMBER_MISSING/.test(x)));
  });
});

describe('automatic retries carry the gate / fact-check reasons (PRIORITY FIX note)', () => {
  const gateErr = (c, codes, messages) => c.safetyGateBlockedError({}, codes, messages, [], []);

  test('buildGateRetryNote: Safety Gate codes + messages in plain language, grouped per code', () => {
    const c = loadBackground();
    gateJob(c);
    const err = gateErr(c, ['IMG_COUNT', 'LINK_MISSING', 'LINK_MISSING', 'MEDIA_BLOCK_CHANGED'],
      ['Image count changed: original 2, edited 1.', 'Original link removed or changed: https://a.example/x', 'Original link removed or changed: https://a.example/y', 'AUDIT ISSUES in an image block']);
    const note = c.buildGateRetryNote(err);
    assert.ok(note.startsWith('Your previous edit of this exact article was REJECTED by the automatic Safety Gate, so nothing was saved. It was rejected because:\n' +
      '1. IMG_COUNT — Image count changed: original 2, edited 1. Keep every image of the original exactly as it is'), note);
    assert.match(note, /\n2\. LINK_MISSING — Original link removed or changed: https:\/\/a\.example\/x; Original link removed or changed: https:\/\/a\.example\/y\. Keep every link of the original/);
    assert.match(note, /\n3\. MEDIA_BLOCK_CHANGED — audit problems in an image block\. Keep every image and video block/);
    assert.ok(note.endsWith('\nEdit the ORIGINAL article again from the start and make sure none of these problems happens this time, while still following all other instructions exactly.'));
    assert.ok(!/AUDIT\s+ISSUES/i.test(note));
    // every code the validator can report gets a hint of its own (no generic fallback)
    const technical = ['GATE_NOT_LOADED', 'INTERNAL_ERROR', 'GATE_FAILED', 'CONFIG_MISSING', 'PARSE_MISSING_MARKER', 'PARSE_META_JSON'];
    for (const code of plain(c.SafetyGate.ERROR_CODES).filter((x) => technical.indexOf(x) < 0)) {
      assert.notEqual(c.gateRetryHint(code), 'Fix this problem.', code);
    }
  });

  test('buildGateRetryNote: at most 3000 chars, whole lines only; nothing for failures the AI cannot fix', () => {
    const c = loadBackground();
    gateJob(c);
    const codes = plain(c.SafetyGate.ERROR_CODES);
    const big = c.buildGateRetryNote(gateErr(c, codes, codes.map((x) => x + ' ' + 'long message '.repeat(40))));
    assert.ok(big.length <= 3000 && big.length > 2000, String(big.length));
    assert.ok(big.endsWith('while still following all other instructions exactly.'));
    big.split('\n').slice(1, -1).forEach((line) => assert.match(line, /^\d+\. [A-Z_]+ — .*\.$/));
    // technical codes only, other errors: no note
    assert.equal(c.buildGateRetryNote(gateErr(c, ['GATE_NOT_LOADED'], ['safety-gate.js not loaded'])), '');
    assert.equal(c.buildGateRetryNote(gateErr(c, ['INTERNAL_ERROR'], ['the Safety Gate crashed: boom'])), '');
    assert.equal(c.buildGateRetryNote(new Error('AI timed out')), '');
    const limit = new Error('AI usage limit'); limit.code = 'AI_LIMIT';
    assert.equal(c.buildGateRetryNote(limit), '');
    assert.equal(c.buildGateRetryNote(c.factCheckError('the fact-check AI never replied')), '');
    assert.equal(c.buildGateRetryNote(null), '');
  });

  test('buildGateRetryNote: fact-check issues (FACT_CHECK, also after the fix round)', () => {
    const c = loadBackground();
    gateJob(c);
    const fc = { verdict: 'fix', issues: [], retryIssues: [
      { severity: 'high', category: 'fact_wrong', quote: 'Soak the pan overnight', problem: 'Dangerous advice.', fix: 'Remove it.' },
      { severity: 'medium', category: 'info_lost', quote: '', problem: 'The drying step is gone', fix: '' }
    ] };
    const err = c.factCheckBlockedError(fc, true, '');
    assert.equal(err.code, 'FACT_CHECK');
    const note = c.buildGateRetryNote(err);
    assert.ok(note.startsWith('Your previous edit of this exact article was REJECTED by an AI fact check, so nothing was saved. The fact check found these problems:\n'), note);
    assert.match(note, /\n1\. \[HIGH \/ fact_wrong\] Problem: Dangerous advice\. Fix: Remove it\. Text in your previous edit: "Soak the pan overnight"\.\n/);
    assert.match(note, /\n2\. \[MEDIUM \/ info_lost\] Problem: The drying step is gone\.\n/);
    assert.ok(note.length <= 3000);
    assert.equal(c.retryNoteLabel(err), 'fact check: 2 issue(s)');
  });

  test('applyRetryFixNote: the note is replaced on every retry (never added up); an audit-fix note stays in front; recovery reads get none', () => {
    const c = loadBackground();
    gateJob(c);
    const links = {};
    c.applyRetryFixNote(links, '', gateErr(c, ['IMG_COUNT'], ['Image count changed: original 2, edited 1.']), '[1/1]');
    assert.match(links.auditFixNote, /IMG_COUNT/);
    c.applyRetryFixNote(links, '', gateErr(c, ['TABLE_LOSS'], ['Table content lost.']), '[1/1]');
    assert.match(links.auditFixNote, /TABLE_LOSS/);
    assert.doesNotMatch(links.auditFixNote, /IMG_COUNT/);
    assert.equal((links.auditFixNote.match(/Your previous edit/g) || []).length, 1);
    c.applyRetryFixNote(links, '', new Error('AI timed out'), '[1/1]');
    assert.equal('auditFixNote' in links, false, 'a non-gate failure clears the note');
    const base = c.buildAuditFixNote('FAQ missing');
    c.applyRetryFixNote(links, base, gateErr(c, ['IMG_COUNT'], ['x']), '');
    assert.ok(links.auditFixNote.startsWith(base + '\n\nYour previous edit'));
    c.applyRetryFixNote(links, base, gateErr(c, ['IMG_COUNT'], ['x']), '');
    assert.equal(links.auditFixNote.split(base).length, 2, 'the audit-fix note appears once');
    c.applyRetryFixNote(links, base, new Error('timeout'), '');
    assert.equal(links.auditFixNote, base);
    const rec = { recoverFromUrl: 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000000' };
    assert.equal(c.applyRetryFixNote(rec, '', gateErr(c, ['IMG_COUNT'], ['x']), ''), '');
    assert.equal(rec.auditFixNote, undefined);
    assert.ok(c.__logs().some((l) => l === 'info [1/1] ↻ The retry tells the AI why the previous edit was rejected (Safety Gate: IMG_COUNT) — PRIORITY FIX note attached.'), c.__logs().join('\n'));
  });

  test('the note reaches the AI as the PRIORITY FIX block after the prompt (generateHtmlForArticle)', async () => {
    const c = loadBackground();
    gateJob(c, { aiMode: 'openai', aiProvider: 'openai', aiName: 'API' });
    let payload = '';
    c.callAIProviderAPI = async (p) => { payload = p; return { text: '```html\n' + GOOD_BLOCK + '\n' + END + '\n```' }; };
    const links = { rawInput: 's' };
    c.applyRetryFixNote(links, '', gateErr(c, ['IMG_COUNT'], ['Image count changed: original 2, edited 1.']), '');
    const html = await c.generateHtmlForArticle('[1/1]', 1, 1, ORIG_BLOCK, links, { edit: null, ai: null }, 4);
    assert.equal(html, GOOD_BLOCK + '\n' + END);
    const at = payload.search(/═{3,}[ \t]+PRIORITY FIX\b/);
    assert.ok(at > payload.lastIndexOf('REMINDER:'), 'the PRIORITY FIX block comes after the prompt');
    assert.ok(payload.slice(at).includes('1. IMG_COUNT — Image count changed: original 2, edited 1. Keep every image'));
  });

  // processLoop / runParallelBatch with processSlug stubbed: what each attempt receives.
  const loopCtx = (extra) => {
    const c = loadBackground();
    gateJob(c, Object.assign({ slugs: ['post-a'], delayBetween: 0 }, extra || {}));
    c.__set('runtime.running', true);
    c.__set('runtime.cursor', 0);
    c.sleep = async () => {};
    c.tryHtmlRecovery = async () => false;
    return c;
  };
  const failThenPass = (c, errors) => {
    const notes = [];
    c.processSlug = async (slug, num, total, links) => {
      notes.push(links.auditFixNote || '');
      const e = errors[notes.length - 1];
      if (e) throw e(links);
    };
    return notes;
  };

  test('processLoop, inline retries: each retry carries the reasons of the attempt before it; a non-gate failure sends none', async () => {
    const c = loopCtx({ retryMode: 'inline', maxRetries: 3 });
    const notes = failThenPass(c, [
      (l) => c.safetyGateBlockedError(l, ['IMG_COUNT'], ['Image count changed: original 2, edited 1.'], [], []),
      () => new Error('AI finished without returning the article'),
      (l) => c.safetyGateBlockedError(l, ['TABLE_LOSS'], ['Table content lost.'], [], [])
    ]);
    await c.processLoop();
    assert.equal(notes.length, 4);
    assert.equal(notes[0], '');
    assert.match(notes[1], /^Your previous edit .*\n1\. IMG_COUNT — /s);
    assert.equal(notes[2], '', 'after a non-gate failure the next try has no note');
    assert.match(notes[3], /TABLE_LOSS/);
    assert.doesNotMatch(notes[3], /IMG_COUNT/);
    assert.equal(c.__run('runtime.successes'), 1);
  });

  test('processLoop, end-of-batch retry pass: the note is kept per post (persisted) and sent with the retry', async () => {
    const c = loopCtx({ retryMode: 'end', maxRetries: 1 });
    const notes = failThenPass(c, [(l) => c.safetyGateBlockedError(l, ['IMG_COUNT'], ['Image count changed: original 2, edited 1.'], [], [])]);
    const persisted = [];
    const realPersist = c.persistRuntime;
    c.persistRuntime = async () => { await realPersist(); persisted.push(plain(c.__storage.__runtime.retryNotes)); };
    await c.processLoop();
    assert.equal(notes.length, 2);
    assert.equal(notes[0], '');
    assert.match(notes[1], /REJECTED by the automatic Safety Gate[\s\S]*1\. IMG_COUNT — Image count changed/);
    assert.ok(persisted.some((m) => m && m['post-a'] && /IMG_COUNT/.test(m['post-a'].note)), 'runtime.retryNotes is persisted');
    assert.ok(c.__logs().some((l) => /Queued "post-a" for the end-of-batch retry pass/.test(l)));
    assert.ok(c.__logs().some((l) => /↻ The retry tells the AI why the previous edit was rejected \(Safety Gate: IMG_COUNT\)/.test(l)));
    // a new batch starts without notes
    await c.startBatch({ slugs: ['x'], site: { url: 'https://tubetyre.com/' }, prompt: 'p', aiUrl: 'https://chatgpt.com/', aiName: 'ChatGPT', aiMode: 'web' }).catch(() => {});
    assert.deepEqual(plain(c.__run('runtime.retryNotes')), {});
  });

  test('processLoop, end-of-batch retry after a fact-check block and after a non-gate failure', async () => {
    const c = loopCtx({ slugs: ['post-a', 'post-b'], retryMode: 'end', maxRetries: 0 });
    const seen = {};
    let calls = 0;
    c.processSlug = async (slug, num, total, links) => {
      (seen[slug] = seen[slug] || []).push(links.auditFixNote || '');
      calls++;
      if (calls === 1) throw c.factCheckBlockedError({ verdict: 'reject', issues: [{ severity: 'high', category: 'fact_wrong', quote: 'Soak it', problem: 'Wrong.', fix: 'Remove it.' }] }, false, '');
      if (calls === 2) throw new Error('AI timed out');
    };
    await c.processLoop();
    assert.deepEqual(Object.keys(seen).sort(), ['post-a', 'post-b']);
    assert.equal(seen['post-a'].length, 2);
    assert.match(seen['post-a'][1], /REJECTED by an AI fact check[\s\S]*Problem: Wrong\. Fix: Remove it\./);
    assert.deepEqual(seen['post-b'], ['', ''], 'no note after a non-gate failure');
  });

  test('processLoop: the fallback AI attempt carries the reasons too', async () => {
    const c = loopCtx({ retryMode: 'off', maxRetries: 0, fallbackAi: { aiName: 'Claude API', aiMode: 'anthropic', aiProvider: 'anthropic', aiUrl: '', aiApiModel: 'm', aiApiKey: 'k' } });
    const ais = [];
    const notes = failThenPass(c, [(l) => c.safetyGateBlockedError(l, ['LINK_MISSING'], ['Original link removed or changed: https://a.example/x'], [], [])]);
    const inner = c.processSlug;
    c.processSlug = async (...a) => { ais.push(c.__run('runtime.job.aiName')); return inner(...a); };
    await c.processLoop();
    assert.deepEqual(ais, ['ChatGPT', 'Claude API']);
    assert.equal(notes[0], '');
    assert.match(notes[1], /1\. LINK_MISSING — Original link removed or changed: https:\/\/a\.example\/x\. Keep every link/);
  });

  test('parallel batch: inline retries carry the reasons', async () => {
    const c = loopCtx({ slugs: ['a', 'b'], parallel: 2, retryMode: 'inline', maxRetries: 1 });
    c.swPing = async () => {};
    const seen = {};
    c.processSlug = async (slug, num, total, links) => {
      (seen[slug] = seen[slug] || []).push(links.auditFixNote || '');
      if (seen[slug].length === 1) throw c.safetyGateBlockedError(links, ['IMG_COUNT'], ['Image count changed: original 2, edited 1.'], [], []);
    };
    await c.runParallelBatch();
    for (const slug of ['a', 'b']) {
      assert.equal(seen[slug].length, 2, slug);
      assert.equal(seen[slug][0], '');
      assert.match(seen[slug][1], /1\. IMG_COUNT — /);
    }
  });
});

describe('end-marker-aware completeness (assessReplyCompleteness)', () => {
  const STYLE = 'font-weight: 400;';
  const text = (i) => 'Paragraph ' + i + ' explains how the old ferry timetable works for visitors who arrive early and want to reach the island before noon.';
  let orig = '';
  let edit = '';
  for (let i = 1; i <= 12; i++) {
    if (i % 3 === 2) { orig += '<h2>Part ' + i + '</h2>\n'; edit += '<h2>Part ' + i + '</h2>\n'; }
    orig += '<p><span style="' + STYLE + '">' + text(i) + '</span></p>\n';
    // the edit removes the span clutter and trims a few words
    edit += '<p>' + (i % 2 ? text(i).replace(' old', '').replace(' early', '') : text(i)) + '</p>\n';
  }
  const words = (h) => h.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;

  test('a marker-bearing reply at ~75% of the characters but ~95% of the words passes; without the marker it still fails', async () => {
    const c = loadBackground();
    gateJob(c);   // gate ON, the Safety Gate editor prompt (asks for APU-END)
    const withMarker = edit + END;
    const cov = withMarker.length / orig.length;
    const wordRatio = words(edit) / words(orig);
    assert.ok(cov > 0.7 && cov < 0.8, 'coverage ' + cov);
    assert.ok(wordRatio >= 0.94 && wordRatio < 1, 'word ratio ' + wordRatio);
    for (const level of ['balanced', 'strict']) {
      c.__run('runtime.job.completeness = ' + JSON.stringify(level));
      const opts = c.completenessOptions();
      const ok = c.assessReplyCompleteness(withMarker, orig, opts);
      assert.equal(ok.complete, true, level + ': ' + plain(ok.reasons).join('; '));
      assert.equal(ok.coverageWaived, true);
      assert.ok(Math.abs(ok.coverage - cov) < 1e-9, 'the real coverage is still reported');
      const noMarker = c.assessReplyCompleteness(edit, orig, opts);
      assert.equal(noMarker.complete, false);
      assert.match(plain(noMarker.reasons).join(' '), /% of the source length/);
      // the older check itself is unchanged
      assert.equal(c.assessHtmlCompleteness(withMarker, orig, opts).complete, false);
    }
    // the Safety Gate agrees the words are all there
    const gate = await c.SafetyGate.runSafetyGate(orig, withMarker, { siteDomains: ['tubetyre.com'], checkLinks: false, endMarker: 'APU-END', requireEndMarker: true });
    assert.equal(gate.ok, true, JSON.stringify(plain(gate.errors)));
  });

  test('the exception needs the gate ON, a Safety Gate prompt and the marker; other signals still count', () => {
    const c = loadBackground();
    gateJob(c);
    const opts = c.completenessOptions();
    const withMarker = edit + END;
    // gate OFF → v3.45.0 behaviour
    c.__run('runtime.job.gateEnabled = false');
    assert.equal(c.assessReplyCompleteness(withMarker, orig, opts).complete, false);
    c.__run('runtime.job.gateEnabled = true');
    // a prompt without the end marker → no exception
    c.__run('runtime.job.prompt = "Edit this article."');
    assert.equal(c.assessReplyCompleteness(withMarker, orig, opts).complete, false);
    c.__run('runtime.job.prompt = ' + JSON.stringify(EDITOR_PROMPT));
    assert.equal(c.assessReplyCompleteness(withMarker, orig, opts).complete, true);
    // unclosed containers are still a reason, marker or not
    const unclosed = c.assessReplyCompleteness('<div><section><ul>' + edit + END, orig, opts);
    assert.equal(unclosed.complete, false);
    assert.match(plain(unclosed.reasons).join(' '), /unclosed container/);
    assert.ok(!/% of the source length/.test(plain(unclosed.reasons).join(' ')));
    // a full-length reply is not "waived"
    assert.equal(c.assessReplyCompleteness(orig + END, orig, opts).coverageWaived, false);
  });

  test('every final-reply completeness decision goes through the one helper (auto-split joined check excepted)', () => {
    const src = fs.readFileSync(BACKGROUND_FILE, 'utf8');
    const direct = src.split('\n').filter((l) => /assessHtmlCompleteness\(/.test(l) && !/^function assessHtmlCompleteness\(/.test(l));
    // two inside assessReplyCompleteness itself, one for the re-joined auto-split article
    assert.equal(direct.length, 3, direct.join('\n'));
    assert.equal(direct.filter((l) => /joinedAssess/.test(l)).length, 1);
    const helper = src.split('\n').filter((l) => /assessReplyCompleteness\(/.test(l) && !/^function /.test(l));
    assert.equal(helper.length, 8, 'waitForAIResponse (2), copy button, continuation (2), recovery, API, final web check');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Injected page functions in real Chromium (data: URL pages)
// ──────────────────────────────────────────────────────────────────────
const PW = loadPlaywright();
describe('injected page functions (Chromium, data: URL pages)', { skip: PW.chromium ? false : PW.error }, () => {
  const c = loadBackground();
  let browser = null;
  let page = null;
  before(async () => {
    browser = await PW.chromium.launch({ executablePath: CHROMIUM_PATH, headless: true, args: ['--no-sandbox'] });
    page = await browser.newPage();
  });
  after(async () => { if (browser) await browser.close(); });

  // Runs fn the way chrome.scripting.executeScript does: from its source text only.
  async function inject(html, fn, args) {
    await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><body>' + html + '</body></html>'));
    return page.evaluate(({ src, args: a }) => {
      const f = (0, eval)('(' + src + ')');
      const out = f.apply(null, a);
      const clicked = [...document.querySelectorAll('[data-clicked]')].map((el) => el.id).sort();
      return { out, clicked };
    }, { src: fn.toString(), args: args || [] });
  }

  const TOGGLES =
    '<button id="search" aria-pressed="true">Search</button>' +
    '<button id="websearch" aria-label="Web search" class="active">🌐</button>' +
    '<button id="browse" aria-checked="true">Browse</button>' +
    '<input id="webbox" type="checkbox" aria-label="Web" checked>' +
    '<button id="deepresearch" aria-pressed="true">Deep research</button>' +
    '<button id="research" class="selected">Research</button>' +
    '<button id="grokdeep" aria-pressed="true">DeepSearch</button>' +
    '<div id="agent" role="button" aria-pressed="true">Agent mode</div>' +
    '<button id="search-off" aria-pressed="false">Search</button>' +
    '<button id="deep-disabled" aria-pressed="true" disabled>Deep research</button>' +
    '<button id="deep-hidden" aria-pressed="true" style="display:none">Deep research</button>' +
    '<button id="reason" aria-pressed="true">Reason</button>' +
    '<script>document.querySelectorAll("button,[role=button],input").forEach(function (el) {' +
    ' el.addEventListener("click", function () { el.setAttribute("data-clicked", "1"); el.setAttribute("aria-pressed", "false"); }); });</script>';
  const WEB_TOGGLES = ['browse', 'search', 'webbox', 'websearch'];
  const RESEARCH_TOGGLES = ['deepresearch', 'grokdeep', 'research'];

  test('prepareAIProviderPage(kind, false): switches off every search / research / browse / web toggle (v3.45.0) and agent mode', async () => {
    for (const kind of ['chatgpt', 'claude', 'gemini', 'grok']) {
      const r = await inject(TOGGLES, c.prepareAIProviderPage, [kind, false]);
      assert.deepEqual(r.clicked, WEB_TOGGLES.concat(RESEARCH_TOGGLES, ['agent']).sort(), kind);
      assert.equal(r.out.changed, 8);
    }
    const undef = await inject(TOGGLES, c.prepareAIProviderPage, ['chatgpt']);
    assert.deepEqual(undef.clicked, WEB_TOGGLES.concat(RESEARCH_TOGGLES, ['agent']).sort());
  });

  test('prepareAIProviderPage(kind, true): keeps web search, still switches off deep research / agent', async () => {
    for (const kind of ['chatgpt', 'claude', 'gemini', 'grok']) {
      const r = await inject(TOGGLES, c.prepareAIProviderPage, [kind, true]);
      assert.deepEqual(r.clicked, RESEARCH_TOGGLES.concat(['agent']).sort(), kind);
      assert.equal(r.out.changed, 4);
    }
    // only exactly true opts in
    const truthy = await inject(TOGGLES, c.prepareAIProviderPage, ['chatgpt', 'yes']);
    assert.deepEqual(truthy.clicked, WEB_TOGGLES.concat(RESEARCH_TOGGLES, ['agent']).sort());
  });

  test('prepareAIProviderPage(kind, false) clicks exactly what v3.45.0 clicked, plus an active agent mode', { skip: BASELINE_SKIP }, async () => {
    const oldFn = baseline().prepareAIProviderPage;
    const extra = '<button id="deep2" aria-pressed="true" title="DeepSearch mode">x</button><button id="web2" class="selected">web</button>';
    const noAgent = TOGGLES.replace('<div id="agent" role="button" aria-pressed="true">Agent mode</div>', '');
    assert.notEqual(noAgent, TOGGLES);
    for (const html of [noAgent, noAgent + extra, '<p>no controls</p>']) {
      const now = await inject(html, c.prepareAIProviderPage, ['chatgpt', false]);
      const then = await inject(html, oldFn, ['chatgpt']);
      assert.deepEqual(now, then);
    }
    // v3.45.0 left an active agent mode on; now it is switched off as well
    const then = await inject(TOGGLES, oldFn, ['chatgpt']);
    const now = await inject(TOGGLES, c.prepareAIProviderPage, ['chatgpt', false]);
    assert.ok(!then.clicked.includes('agent'));
    assert.deepEqual(now.clicked, then.clicked.concat(['agent']).sort());
  });

  const VERDICT = '{"verdict": "fix", "issues": [{"severity": "high", "category": "fact_wrong", "quote": "Tickets cost 29 euros", "problem": "Price not confirmed.", "fix": "Keep the original price."}]}';
  const chatgptPage = (extra) =>
    '<main>' +
    '<div data-message-author-role="user"><div class="whitespace-pre-wrap">ORIGINAL ARTICLE HTML START {"verdict":"pass","issues":[]} please check</div></div>' +
    '<div data-message-author-role="assistant"><div class="markdown prose"><p>Old reply</p><pre><code>{"verdict":"reject","issues":[]}</code></pre></div></div>' +
    '<div data-message-author-role="user"><div>Second message</div></div>' +
    '<div data-message-author-role="assistant"><div class="markdown prose"><p>Verdict below.</p>' +
    '<pre class="overflow-visible"><div class="contain-inline-size"><div class="flex">json</div><div class="sticky"><button aria-label="Copy">Copy code</button></div>' +
    '<div class="overflow-y-auto p-4"><code class="whitespace-pre! language-json">' + VERDICT.replace(/</g, '&lt;') + '</code></div></div></pre>' +
    '<p>See the <code>verdict</code> field.</p></div></div>' +
    (extra || '') + '</main>';

  test('readAIJsonSnapshot(chatgpt): code blocks of the LAST assistant message only', async () => {
    const { out } = await inject(chatgptPage(), c.readAIJsonSnapshot, ['chatgpt']);
    assert.deepEqual(out.texts, [VERDICT, 'verdict']);
    assert.equal(out.isGenerating, false);
    assert.equal(out.hadAssistantMsg, true);
    assert.equal(out.usageLimit, '');
    assert.match(out.messageText, /Verdict below\./);
    assert.ok(!out.messageText.includes('Old reply'));
    // the snapshot text parses as the verdict
    const parsed = c.parseFactCheckReply(out.texts[0]);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.audit.verdict, 'fix');
    assert.equal(c.parseFactCheckReply(out.messageText).audit.verdict, 'fix');
  });

  test('readAIJsonSnapshot(chatgpt): still-generating signals and usage limit', async () => {
    const gen = [
      '<button data-testid="stop-button" aria-label="Stop streaming">■</button>',
      '<div class="result-streaming">…</div>',
      '<div data-is-streaming="true">…</div>',
      '<button>Stop generating</button>'
    ];
    for (const g of gen) {
      const { out } = await inject(chatgptPage(g), c.readAIJsonSnapshot, ['chatgpt']);
      assert.equal(out.isGenerating, true, g);
    }
    const disabledStop = await inject(chatgptPage('<button data-testid="stop-button" disabled>■</button>'), c.readAIJsonSnapshot, ['chatgpt']);
    assert.equal(disabledStop.out.isGenerating, false);
    const limit = await inject(chatgptPage('<div role="alert">You\'ve reached your GPT-5 limit. Try again later.</div>'), c.readAIJsonSnapshot, ['chatgpt']);
    assert.match(limit.out.usageLimit, /reached your gpt-5 limit/);
  });

  test('readAIJsonSnapshot: no assistant message yet', async () => {
    const { out } = await inject('<main><div data-message-author-role="user">{"verdict":"pass"} hello</div></main>', c.readAIJsonSnapshot, ['chatgpt']);
    assert.deepEqual(out, { isGenerating: false, texts: [], messageText: '', hadAssistantMsg: false, usageLimit: '' });
  });

  test('readAIJsonSnapshot: Claude, Gemini and Grok layouts', async () => {
    const code = '<pre><code class="language-json">' + VERDICT + '</code></pre>';
    const pages = {
      claude: '<div data-testid="user-message">Please check these two articles for me carefully.</div>' +
        '<div data-is-streaming="false" class="font-claude-message"><p>Here is my check:</p>' + code + '</div>',
      gemini: '<style>model-response, message-content { display: block; }</style>' +
        '<model-response><message-content class="model-response-text"><div class="markdown"><p>Result:</p>' + code + '</div></message-content></model-response>',
      grok: '<div class="message-bubble"><p>Checking…</p></div><div class="message-bubble"><p>Done:</p>' + code + '</div>'
    };
    for (const kind of Object.keys(pages)) {
      const { out } = await inject(pages[kind], c.readAIJsonSnapshot, [kind]);
      assert.deepEqual(out.texts, [VERDICT], kind);
      assert.equal(out.hadAssistantMsg, true, kind);
      assert.equal(out.isGenerating, false, kind);
      assert.equal(c.parseFactCheckReply(out.texts[0]).audit.verdict, 'fix', kind);
    }
    const streaming = await inject(pages.claude.replace('data-is-streaming="false"', 'data-is-streaming="true"'), c.readAIJsonSnapshot, ['claude']);
    assert.equal(streaming.out.isGenerating, true);
  });

  test('readAIJsonSnapshot: other chat websites (generic / perplexity) are read too', async () => {
    const code = '<pre><code class="language-json">' + VERDICT + '</code></pre>';
    for (const kind of ['generic', 'perplexity']) {
      // a ChatGPT-like DOM on a custom address
      const a = await inject(chatgptPage(), c.readAIJsonSnapshot, [kind]);
      assert.deepEqual(a.out.texts, [VERDICT, 'verdict'], kind);
      assert.equal(a.out.hadAssistantMsg, true, kind);
      assert.match(a.out.messageText, /Verdict below\./);
      // a site with its own class names
      const b = await inject('<div class="user-bubble">Please check this.</div><div class="answer-card"><p>Result:</p>' + code + '</div>' +
        '<form><textarea></textarea></form>', c.readAIJsonSnapshot, [kind]);
      assert.deepEqual(b.out.texts, [VERDICT], kind);
      // a wrapper that also holds our own message is skipped for the reply itself
      const w = await inject('<div class="assistant-chat"><div class="me">ORIGINAL ARTICLE HTML START … EDITED ARTICLE HTML END</div>' +
        '<div class="answer-card"><p>Result:</p>' + code + '</div></div>', c.readAIJsonSnapshot, [kind]);
      assert.deepEqual(w.out.texts, [VERDICT], kind);
      assert.ok(!/ARTICLE HTML START/.test(w.out.messageText), kind);
      // no recognisable message container at all: the code blocks on the page
      const d = await inject('<div id="x"><div><p>Result:</p>' + code + '</div></div>', c.readAIJsonSnapshot, [kind]);
      assert.deepEqual(d.out.texts, [VERDICT], kind);
      assert.equal(c.parseFactCheckReply(d.out.texts[0]).audit.verdict, 'fix');
    }
    // a known provider whose message has no code block falls back to the page's code blocks too
    const e = await inject('<div data-message-author-role="assistant"><p>Here it is</p></div><div class="canvas">' + code + '</div>', c.readAIJsonSnapshot, ['chatgpt']);
    assert.deepEqual(e.out.texts, [VERDICT]);
  });

  test('captureCopyButtonText: a clipboard read that never answers does not hang the capture', { timeout: 30000 }, async () => {
    await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><body>' +
      '<div data-message-author-role="assistant"><pre><div><button aria-label="Copy">Copy code</button></div><code>&lt;p&gt;' + 'full article text '.repeat(40) + '&lt;/p&gt;</code></pre></div></body></html>'));
    const r = await page.evaluate(async (src) => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        readText: () => new Promise(() => {}),                  // a permission prompt nobody answers
        writeText: () => Promise.resolve(), write: () => Promise.resolve()
      } });
      const f = (0, eval)('(' + src + ')');
      const t0 = Date.now();
      const out = await f('chatgpt', true, true);
      return { ms: Date.now() - t0, len: String(out || '').length };
    }, c.captureCopyButtonText.toString());
    assert.ok(r.ms < 8000, String(r.ms));
    assert.ok(r.len > 500, String(r.len));
  });
});
