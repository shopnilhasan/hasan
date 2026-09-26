'use strict';
/*
 * Tests for automation/validate-article.js
 * Run from the repo root:  node --test automation/test/
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const V = require('../validate-article.js');

const FIX = path.join(__dirname, 'fixtures');
const SCRIPT = path.join(__dirname, '..', 'validate-article.js');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');

const ORIG = read('original-block.html');
const GOOD_TEXT = read('edited-good.txt');
const GOOD = V.parseEditorOutput(GOOD_TEXT).html;
const GOOD_META = V.parseEditorOutput(GOOD_TEXT).meta;
const ORIG_C = read('original-classic.html');
const GOOD_C_TEXT = read('edited-classic-good.txt');
const GOOD_C = V.parseEditorOutput(GOOD_C_TEXT).html;

const OPTS = { siteDomains: ['tubetyre.com'] };
const OPTS_C = { siteDomains: ['getcostidea.com'], webSearchCount: 0 };

const RSQUO = String.fromCodePoint(0x2019);
const LDQUO = String.fromCodePoint(0x201c);
const RDQUO = String.fromCodePoint(0x201d);
const MDASH = String.fromCodePoint(0x2014);
const HELLIP = String.fromCodePoint(0x2026);
const CAR_EMOJI = String.fromCodePoint(0x1f697);

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
const covered = new Set();

function codes(list) {
  return list.map((e) => e.code);
}

function expectError(result, code) {
  assert.ok(codes(result.errors).includes(code),
    'expected error ' + code + ', got: ' + JSON.stringify(result.errors, null, 1));
  assert.equal(result.pass === undefined ? result.ok : result.pass, false);
  covered.add(code);
}

function expectWarning(result, code) {
  assert.ok(codes(result.warnings).includes(code),
    'expected warning ' + code + ', got: ' + JSON.stringify(result.warnings, null, 1));
  covered.add('warn:' + code);
}

function replaceOnce(s, a, b) {
  const i = s.indexOf(a);
  assert.ok(i >= 0, 'mutation anchor not found: ' + a.slice(0, 80));
  return s.slice(0, i) + b + s.slice(i + a.length);
}

function replaceAll(s, a, b) {
  assert.ok(s.includes(a), 'mutation anchor not found: ' + a.slice(0, 80));
  return s.split(a).join(b);
}

function wrapOutput(html, meta) {
  const m = Object.assign({}, GOOD_META, meta || {});
  return '<<<ARTICLE_HTML>>>\n' + html + '\n<<<META_JSON>>>\n' + JSON.stringify(m) + '\n<<<END>>>\n';
}

function validate(edited, extra) {
  return V.validateArticle(ORIG, edited, Object.assign({}, OPTS, extra || {}));
}

function uniqueWords(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) out.push((prefix || 'w') + i.toString(36));
  return out.join(' ');
}

const P_SPARE = '<!-- wp:paragraph -->\n<p>Don' + "'" + 't forget the spare wheel. A flat spare is no help when you get a puncture at the side of the road, so check it every time you check the others.</p>\n<!-- /wp:paragraph -->';
const QA_BOX_START = '<!-- wp:html -->\n<div style="background:#eef3fe;';
const INSERT_POINT = '<!-- wp:rank-math/rich-snippet {"id":"s-1a2b3c4d"} /-->';

function insertBeforeSnippet(html, add) {
  return replaceOnce(html, INSERT_POINT, add + '\n\n' + INSERT_POINT);
}

function para(text) {
  return '<!-- wp:paragraph -->\n<p>' + text + '</p>\n<!-- /wp:paragraph -->';
}

// fake fetch builder: routes = { url: (method, init) => ({status}) | throws | never-resolving promise }
function makeFetch(routes, calls) {
  return async function (url, init) {
    calls && calls.push([init && init.method, url]);
    const h = routes[url];
    if (!h) return { status: 200, url: url };
    return h(init && init.method, init);
  };
}

// ---------------------------------------------------------------------------------------------
// good fixtures
// ---------------------------------------------------------------------------------------------
test('good block fixture parses and passes with no errors or warnings', () => {
  const p = V.parseEditorOutput(GOOD_TEXT);
  assert.equal(p.ok, true);
  assert.equal(p.status, 'edited');
  assert.equal(p.meta.editor, 'block');
  const r = V.validateArticle(ORIG, p.html, Object.assign({}, OPTS, { meta: p.meta }));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.pass, true);
  assert.equal(r.stats.images, 2);
  assert.equal(r.stats.newExternalLinks, 1);
  assert.equal(r.stats.boxes.quickAnswer, 1);
  assert.equal(r.stats.headings.h1, 0);
  assert.ok(r.stats.wordRatio > 1 && r.stats.wordRatio < 2);
});

test('good block fixture also passes with webSearchCount 0 (homepage link) and allowNewFaq false', () => {
  const r = validate(GOOD, { webSearchCount: 0, allowNewFaq: false });
  assert.deepEqual(r.errors, []);
});

test('good classic fixture: fenced META and text around markers are handled, and it passes', () => {
  const p = V.parseEditorOutput(GOOD_C_TEXT);
  assert.equal(p.ok, true);
  assert.equal(p.meta.editor, 'classic');
  assert.ok(!p.html.includes('trailing text'));
  assert.ok(!p.html.includes('Here is the edited article'));
  const r = V.validateArticle(ORIG_C, p.html, Object.assign({}, OPTS_C, { meta: p.meta, allowNewFaq: false }));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.pass, true);
});

// ---------------------------------------------------------------------------------------------
// parseEditorOutput
// ---------------------------------------------------------------------------------------------
test('PARSE_MISSING_MARKER: missing END (truncated), missing META, missing start, empty reply', () => {
  const noEnd = GOOD_TEXT.replace('<<<END>>>', '');
  let p = V.parseEditorOutput(noEnd);
  expectError(p, 'PARSE_MISSING_MARKER');
  assert.match(p.errors[0].message, /truncated/);
  expectError(V.parseEditorOutput(GOOD_TEXT.replace('<<<META_JSON>>>', '')), 'PARSE_MISSING_MARKER');
  expectError(V.parseEditorOutput(GOOD_TEXT.replace('<<<ARTICLE_HTML>>>', '')), 'PARSE_MISSING_MARKER');
  expectError(V.parseEditorOutput(''), 'PARSE_MISSING_MARKER');
  expectError(V.parseEditorOutput(null), 'PARSE_MISSING_MARKER');
});

test('PARSE_META_JSON: invalid JSON, missing status, wrong status, JSON array', () => {
  expectError(V.parseEditorOutput('<<<ARTICLE_HTML>>>\n<p>x</p>\n<<<META_JSON>>>\n{"status": "edited",, }\n<<<END>>>'), 'PARSE_META_JSON');
  expectError(V.parseEditorOutput('<<<ARTICLE_HTML>>>\n<p>x</p>\n<<<META_JSON>>>\n{"language": "en"}\n<<<END>>>'), 'PARSE_META_JSON');
  expectError(V.parseEditorOutput('<<<ARTICLE_HTML>>>\n<p>x</p>\n<<<META_JSON>>>\n{"status": "done"}\n<<<END>>>'), 'PARSE_META_JSON');
  expectError(V.parseEditorOutput('<<<ARTICLE_HTML>>>\n<p>x</p>\n<<<META_JSON>>>\n[1,2]\n<<<END>>>'), 'PARSE_META_JSON');
});

test('PARSE_EMPTY_HTML: status edited with empty HTML', () => {
  expectError(V.parseEditorOutput('<<<ARTICLE_HTML>>>\n\n<<<META_JSON>>>\n{"status": "edited"}\n<<<END>>>'), 'PARSE_EMPTY_HTML');
});

test('parse: skipped status with empty HTML is ok; missing META keys get defaults', () => {
  const p = V.parseEditorOutput('<<<ARTICLE_HTML>>>\n<<<META_JSON>>>\n{"status": "skipped", "skip_reason": "empty"}\n<<<END>>>');
  assert.equal(p.ok, true);
  assert.equal(p.status, 'skipped');
  assert.deepEqual(p.meta.notes, []);
  assert.deepEqual(p.meta.external_links_added, []);
});

test('parse: strips one outer ```html fence around the HTML and ```json around META', () => {
  const t = '<<<ARTICLE_HTML>>>\n```html\n<p>Hello there.</p>\n```\n<<<META_JSON>>>\n```json\n{"status":"edited"}\n```\n<<<END>>>';
  const p = V.parseEditorOutput(t);
  assert.equal(p.ok, true);
  assert.equal(p.html, '<p>Hello there.</p>');
});

test('parse: marker mentioned in a preamble is ignored (last start marker before META is used)', () => {
  const t = 'I will reply with <<<ARTICLE_HTML>>> as asked.\n' + GOOD_TEXT;
  const p = V.parseEditorOutput(t);
  assert.equal(p.ok, true);
  assert.equal(p.html, GOOD);
});

// ---------------------------------------------------------------------------------------------
// validateArticle: one mutation per hard error code
// ---------------------------------------------------------------------------------------------
test('IMG_COUNT: an image removed', () => {
  const start = GOOD.indexOf('<!-- wp:image {"id":101');
  const end = GOOD.indexOf('<!-- /wp:image -->', start) + '<!-- /wp:image -->'.length;
  expectError(validate(GOOD.slice(0, start) + GOOD.slice(end)), 'IMG_COUNT');
});

test('IMG_CHANGED: height changed; alt-only change is allowed; lazy class change caught', () => {
  expectError(validate(replaceOnce(GOOD, 'width="1024" height="683"', 'width="1024" height="600"')), 'IMG_CHANGED');
  expectError(validate(replaceOnce(GOOD, 'class="wp-image-102"', 'class="wp-image-102 aligncenter"')), 'IMG_CHANGED');
  const altOnly = replaceOnce(GOOD, 'alt="Digital tyre pressure gauge pressed onto a car tyre valve"', 'alt="Another alt text"');
  assert.equal(validate(altOnly).pass, true);
  // attribute order and quote style do not matter
  const reordered = replaceOnce(GOOD, '<img decoding="async" loading="lazy" width="800"', "<img loading='lazy' decoding=\"async\" width=\"800\"");
  assert.equal(validate(reordered).pass, true);
});

test('IMG_CHANGED: two images swapped (order matters)', () => {
  const imgRe = /<img [^>]*\/>/g;
  const imgs = GOOD.match(imgRe);
  assert.equal(imgs.length, 2);
  const swapped = GOOD.replace(imgs[0], '@@A@@').replace(imgs[1], imgs[0]).replace('@@A@@', imgs[1]);
  expectError(validate(swapped), 'IMG_CHANGED');
});

test('MEDIA_COUNT: figcaption removed or figure added', () => {
  expectError(validate(replaceOnce(GOOD, '<figcaption class="wp-element-caption">A digital gauge gives a clear, easy-to-read number</figcaption>', '')), 'MEDIA_COUNT');
  expectError(validate(insertBeforeSnippet(GOOD, '<!-- wp:table --><figure class="wp-block-table"><table><tbody><tr><td>a</td></tr></tbody></table></figure><!-- /wp:table -->')), 'MEDIA_COUNT');
  expectError(validate(insertBeforeSnippet(GOOD, '<!-- wp:html --><iframe src="https://www.youtube.com/embed/abc"></iframe><!-- /wp:html -->')), 'MEDIA_COUNT');
});

test('ELEMENT_COUNT: a button added, an ad <ins> removed', () => {
  expectError(validate(insertBeforeSnippet(GOOD, '<!-- wp:html --><button>Buy now</button><!-- /wp:html -->')), 'ELEMENT_COUNT');
  expectError(validate(replaceOnce(GOOD, '<ins class="adsbygoogle" style="display:block; text-align:center;" data-ad-layout="in-article" data-ad-format="fluid" data-ad-client="ca-pub-0000000000000000" data-ad-slot="1234567890"></ins>', '')), 'ELEMENT_COUNT');
});

test('SHORTCODE_MISSING: gallery shortcode removed or its attributes changed', () => {
  expectError(validate(replaceOnce(GOOD, '[gallery ids="201,202,203" columns="3" size="medium"]', '')), 'SHORTCODE_MISSING');
  expectError(validate(replaceOnce(GOOD, '[gallery ids="201,202,203" columns="3" size="medium"]', '[gallery ids="201,202,203" columns="2" size="medium"]')), 'SHORTCODE_MISSING');
  // classic: [caption] opener changed
  expectError(V.validateArticle(ORIG_C, replaceOnce(GOOD_C, 'align="aligncenter"', 'align="alignleft"'), OPTS_C), 'SHORTCODE_MISSING');
});

test('LINK_MISSING: an original link removed or its URL changed', () => {
  expectError(validate(replaceOnce(GOOD, '<a href="https://tubetyre.com/tyre-sidewall-markings/">reading tyre sidewall markings</a>', 'reading tyre sidewall markings')), 'LINK_MISSING');
  const changed = replaceAll(GOOD, 'https://www.nhtsa.gov/equipment/tires', 'https://www.nhtsa.gov/tires');
  expectError(validate(changed), 'LINK_MISSING');
});

test('ID_MISSING: a heading id removed; the removed H1 title may take its own id with it', () => {
  expectError(validate(replaceOnce(GOOD, ' id="what-you-need"', '')), 'ID_MISSING');
  const origWithTitleId = replaceOnce(ORIG, '<h1 class="wp-block-heading">', '<h1 class="wp-block-heading" id="post-title">');
  assert.equal(V.validateArticle(origWithTitleId, GOOD, OPTS).pass, true);
});

test('PLUGIN_BLOCK_CHANGED: TOC text edited, self-closing plugin block removed', () => {
  expectError(validate(replaceOnce(GOOD, '<h2>Table of Contents</h2>', '<h2>Contents</h2>')), 'PLUGIN_BLOCK_CHANGED');
  expectError(validate(replaceOnce(GOOD, INSERT_POINT, '')), 'PLUGIN_BLOCK_CHANGED');
  expectError(validate(replaceOnce(GOOD, '{"id":"s-1a2b3c4d"}', '{"id":"s-9"}')), 'PLUGIN_BLOCK_CHANGED');
});

test('MEDIA_BLOCK_CHANGED: wp:image opening comment changed', () => {
  expectError(validate(replaceOnce(GOOD, '<!-- wp:image {"id":101,"sizeSlug":"large","linkDestination":"none"} -->', '<!-- wp:image {"id":101,"sizeSlug":"full","linkDestination":"none"} -->')), 'MEDIA_BLOCK_CHANGED');
});

test('SCRIPT_CHANGED: ad script edited or removed', () => {
  expectError(validate(replaceOnce(GOOD, '.push({});', '.push({ });')), 'SCRIPT_CHANGED');
  expectError(validate(replaceOnce(GOOD, '<script>\n     (adsbygoogle = window.adsbygoogle || []).push({});\n</script>', '')), 'SCRIPT_CHANGED');
});

test('SCRIPT_CHANGED: a non-FAQ JSON-LD from the original must stay verbatim; FAQPage may change', () => {
  const ld = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"HowTo","name":"x"}</script>';
  const faq = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>';
  const o = ORIG + '\n' + ld + '\n' + faq;
  expectError(V.validateArticle(o, GOOD + '\n' + faq, OPTS), 'SCRIPT_CHANGED');
  const r = V.validateArticle(o, GOOD + '\n' + ld, OPTS);
  assert.ok(!codes(r.errors).includes('SCRIPT_CHANGED'));
});

test('SPECIAL_COMMENT_MISSING: <!--more--> removed', () => {
  expectError(validate(replaceOnce(GOOD, '<!--more-->', '')), 'SPECIAL_COMMENT_MISSING');
  const o = ORIG + '\n<!--nextpage-->\n';
  expectError(V.validateArticle(o, GOOD, OPTS), 'SPECIAL_COMMENT_MISSING');
  assert.equal(V.validateArticle(o, GOOD + '\n<!-- nextpage -->', OPTS).pass, true);
});

test('FORBIDDEN_TAG: new h1, style, meta, script, inline event handler', () => {
  expectError(validate(insertBeforeSnippet(GOOD, '<h1>Extra title</h1>')), 'FORBIDDEN_TAG');
  expectError(validate(insertBeforeSnippet(GOOD, '<style>p{color:red}</style>')), 'FORBIDDEN_TAG');
  expectError(validate(insertBeforeSnippet(GOOD, '<meta name="x" content="y">')), 'FORBIDDEN_TAG');
  expectError(validate(insertBeforeSnippet(GOOD, '<!-- wp:html --><script>alert(1)</script><!-- /wp:html -->')), 'FORBIDDEN_TAG');
  expectError(validate(replaceOnce(GOOD, '<p>Correct tyre pressure', '<p onclick="steal()">Correct tyre pressure')), 'FORBIDDEN_TAG');
});

test('FIRST_ELEMENT_NOT_P: starts with a heading, a box, or keeps the H1 title', () => {
  expectError(validate('<!-- wp:heading -->\n<h2 class="wp-block-heading">Intro</h2>\n<!-- /wp:heading -->\n' + GOOD), 'FIRST_ELEMENT_NOT_P');
  const boxFirst = GOOD.slice(GOOD.indexOf(QA_BOX_START));
  expectError(validate(boxFirst), 'FIRST_ELEMENT_NOT_P');
  const titleKept = '<!-- wp:heading {"level":1} -->\n<h1 class="wp-block-heading">How to Check Tyre Pressure at Home</h1>\n<!-- /wp:heading -->\n' + GOOD;
  expectError(validate(titleKept), 'FIRST_ELEMENT_NOT_P');
});

test('FIRST_ELEMENT_NOT_P: exception when the original starts with the same image', () => {
  const img = '<!-- wp:image {"id":7} -->\n<figure class="wp-block-image"><img src="https://tubetyre.com/a.jpg" alt="" width="10" height="10"/></figure>\n<!-- /wp:image -->\n';
  const img2 = img.replace('alt=""', 'alt="Car tyre close-up"');
  const o = img + ORIG.slice(ORIG.indexOf('<!-- wp:paragraph -->'));
  assert.equal(V.validateArticle(o, img2 + GOOD, OPTS).pass, true);
  const other = img2.replace('a.jpg', 'b.jpg');
  expectError(V.validateArticle(o, other + GOOD, OPTS), 'FIRST_ELEMENT_NOT_P');
});

test('FIRST_ELEMENT: leading comments, scripts, empty paragraphs and plugin blocks are skipped', () => {
  const lead = '<!-- a note -->\n<!-- wp:rank-math/toc-block {"x":1} --><div><h2>TOC</h2></div><!-- /wp:rank-math/toc-block -->\n<p>&nbsp;</p>\n';
  const o = lead + ORIG;
  assert.equal(V._internal.leadingItem(lead + GOOD).kind, 'p');
  assert.equal(V.validateArticle(o, lead + GOOD, OPTS).pass, true);
});

test('TITLE_IN_BODY (optional postTitle): a bold/plain title line at the top', () => {
  const t = '<!-- wp:paragraph -->\n<p><strong>How to Check Tyre Pressure at Home</strong></p>\n<!-- /wp:paragraph -->\n' + GOOD;
  expectError(validate(t, { postTitle: 'How to Check Tyre Pressure at Home' }), 'TITLE_IN_BODY');
  assert.equal(validate(t).pass, true);
});

test('HEADING_ORDER: h2 -> h4 jump, first heading h3', () => {
  const h = '<h2 class="wp-block-heading">How Often Should You Check Tyre Pressure?</h2>';
  expectError(validate(replaceOnce(GOOD, h, '<h4 class="wp-block-heading">How Often Should You Check Tyre Pressure?</h4>')), 'HEADING_ORDER');
  const first = '<h2 class="wp-block-heading" id="why-tyre-pressure-matters">Why Does Tyre Pressure Matter?</h2>';
  expectError(validate(replaceOnce(GOOD, first, '<h3 class="wp-block-heading" id="why-tyre-pressure-matters">Why Does Tyre Pressure Matter?</h3>')), 'HEADING_ORDER');
  // h2 -> h3 -> h2 is fine; headings inside plugin blocks (TOC h2) are ignored
  assert.equal(validate(replaceOnce(GOOD, h, '<h3 class="wp-block-heading">How Often Should You Check Tyre Pressure?</h3>')).pass, true);
});

test('PLACEHOLDER: [VERIFY], {{...}}, TODO, href="#", example.com', () => {
  const r = validate(insertBeforeSnippet(GOOD, para('Prices start at [VERIFY: price] and {{ANSWER}} TODO see <a href="#">here</a> or example.com.')));
  expectError(r, 'PLACEHOLDER');
  const msg = r.errors.find((e) => e.code === 'PLACEHOLDER').message;
  for (const k of ['[VERIFY', '{{', 'TODO', 'href="#"', 'example.com']) assert.ok(msg.includes(k), msg);
  // existing occurrences in the original are not counted
  const o = ORIG + '\n' + para('Our old TODO list.');
  assert.ok(!codes(V.validateArticle(o, GOOD + '\n' + para('Our old TODO list.'), OPTS).errors).includes('PLACEHOLDER'));
});

test('CODE_FENCE: ``` inside the HTML', () => {
  expectError(validate(insertBeforeSnippet(GOOD, '```html')), 'CODE_FENCE');
  // an HTML section with only an opening fence is not stripped and fails
  const t = '<<<ARTICLE_HTML>>>\n```html\n' + GOOD + '\n<<<META_JSON>>>\n' + JSON.stringify(GOOD_META) + '\n<<<END>>>';
  const p = V.parseEditorOutput(t);
  expectError(validate(p.html), 'CODE_FENCE');
});

test('JSONLD_INVALID: broken JSON-LD', () => {
  expectError(validate(GOOD + '\n<script type="application/ld+json">{"@type": "FAQPage", "mainEntity": [}</script>'), 'JSONLD_INVALID');
});

test('JSONLD_TYPE: new Article schema, two FAQPage blocks', () => {
  expectError(validate(GOOD + '\n<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"x"}</script>'), 'JSONLD_TYPE');
  const faq = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>';
  expectError(validate(GOOD + '\n' + faq + '\n' + faq), 'JSONLD_TYPE');
});

test('TAG_UNBALANCED: a closing </p> or </strong> dropped', () => {
  expectError(validate(replaceOnce(GOOD, 'grip the road the way its maker intended. It also cuts fuel use and makes your tyres last longer. Both too little and too much air cause problems.</p>', 'grip the road the way its maker intended. It also cuts fuel use and makes your tyres last longer. Both too little and too much air cause problems.')), 'TAG_UNBALANCED');
  expectError(validate(replaceOnce(GOOD, '<strong>Checking hot tyres.</strong>', '<strong>Checking hot tyres.')), 'TAG_UNBALANCED');
});

test('BLOCK_UNBALANCED: a block closer comment removed', () => {
  const i = GOOD.indexOf('<!-- /wp:paragraph -->');
  expectError(validate(GOOD.slice(0, i) + GOOD.slice(i + '<!-- /wp:paragraph -->'.length)), 'BLOCK_UNBALANCED');
});

test('CONTENT_LOSS: most paragraph text cut', () => {
  const cut = GOOD.replace(/<p>([^<]{80,})<\/p>/g, '<p>Short text here.</p>');
  expectError(validate(cut), 'CONTENT_LOSS');
});

test('WORD_RATIO_EXTREME (hard) and WORD_RATIO_HIGH (warning)', () => {
  const words = V.validateArticle(ORIG, ORIG, OPTS).stats.wordsOriginal;
  const extreme = insertBeforeSnippet(GOOD, para(uniqueWords(words * 5, 'x')));
  expectError(validate(extreme), 'WORD_RATIO_EXTREME');
  const high = insertBeforeSnippet(GOOD, para(uniqueWords(Math.round(words * 2.6), 'y')));
  const r = validate(high);
  assert.equal(r.pass, true, JSON.stringify(r.errors));
  expectWarning(r, 'WORD_RATIO_HIGH');
});

test('DUPLICATE_CONTENT: a paragraph of 12+ words repeated', () => {
  expectError(validate(insertBeforeSnippet(GOOD, P_SPARE)), 'DUPLICATE_CONTENT');
});

test('LAST_CHECKED_WITHOUT_RESEARCH: only when webSearchCount is 0 and the line is new or changed', () => {
  const line = para('<em>Last checked: 2026-09-26. Dates and figures were verified against official sources.</em>');
  const edited = replaceOnce(GOOD, QA_BOX_START, line + '\n\n' + QA_BOX_START);
  expectError(validate(edited, { webSearchCount: 0 }), 'LAST_CHECKED_WITHOUT_RESEARCH');
  assert.equal(validate(edited, { webSearchCount: 12 }).pass, true);
  assert.equal(validate(edited).pass, true); // unknown search count
  // the same line already in the original, kept unchanged: allowed
  const o = replaceOnce(ORIG, '<!-- wp:rank-math/toc-block', line + '\n\n<!-- wp:rank-math/toc-block');
  assert.equal(V.validateArticle(o, edited, Object.assign({}, OPTS, { webSearchCount: 0 })).pass, true);
  // date bumped without research: blocked
  const bumped = replaceOnce(edited, '2026-09-26', '2026-09-27');
  expectError(V.validateArticle(o, bumped, Object.assign({}, OPTS, { webSearchCount: 0 })), 'LAST_CHECKED_WITHOUT_RESEARCH');
});

test('NEW_INTERNAL_LINK: new link to the own site (www and subdomains count)', () => {
  expectError(validate(insertBeforeSnippet(GOOD, para('See <a href="https://www.tubetyre.com/new-page/">this page</a>.'))), 'NEW_INTERNAL_LINK');
  expectError(validate(insertBeforeSnippet(GOOD, para('See <a href="https://shop.tubetyre.com/x">the shop</a>.'))), 'NEW_INTERNAL_LINK');
});

test('BAD_NEW_LINK: forbidden domain, relative, javascript:, mailto, deep link without research, dead', () => {
  expectError(validate(insertBeforeSnippet(GOOD, para('A <a href="https://www.reddit.com/r/cars/">forum thread</a>.'))), 'BAD_NEW_LINK');
  expectError(validate(insertBeforeSnippet(GOOD, para('A <a href="/about/">relative</a> link.'))), 'BAD_NEW_LINK');
  expectError(validate(insertBeforeSnippet(GOOD, para('A <a href="javascript:void(0)">script</a> link.'))), 'BAD_NEW_LINK');
  expectError(validate(insertBeforeSnippet(GOOD, para('A <a href="mailto:a@b.co">mail</a> link.'))), 'BAD_NEW_LINK');
  const deep = replaceAll(GOOD, 'https://www.tyresafe.org/', 'https://www.tyresafe.org/check-your-tyres/');
  expectError(validate(deep, { webSearchCount: 0 }), 'BAD_NEW_LINK');
  assert.equal(validate(deep, { webSearchCount: 3 }).pass, true);
  expectError(validate(GOOD, { deadUrls: ['https://www.tyresafe.org/'] }), 'BAD_NEW_LINK');
});

test('BOX_DUPLICATED: a second Quick Answer box; BOX_LIMIT warning for a third Pro Tip', () => {
  const qa = GOOD.slice(GOOD.indexOf(QA_BOX_START), GOOD.indexOf('<!-- /wp:html -->', GOOD.indexOf(QA_BOX_START)) + '<!-- /wp:html -->'.length);
  expectError(validate(insertBeforeSnippet(GOOD, qa)), 'BOX_DUPLICATED');
  const tip = (t) => '<!-- wp:html -->\n<div style="background:#eafaf1;border-left:5px solid #2e9e5b;border-radius:6px;padding:14px 18px;margin:24px 0;color:#1f2937;"><p style="margin:0;line-height:1.6;"><strong>Pro Tip:</strong> ' + t + '</p></div>\n<!-- /wp:html -->';
  const r = validate(insertBeforeSnippet(GOOD, tip('Check the valve caps as well.') + '\n' + para('Some text between boxes here.') + '\n' + tip('Write the pressures down.')));
  assert.equal(r.pass, true, JSON.stringify(r.errors));
  expectWarning(r, 'BOX_LIMIT');
  // limit follows the original's own count
  const o = ORIG + '\n' + qa + '\n' + qa;
  assert.ok(!codes(V.validateArticle(o, GOOD + '\n' + qa + '\n' + qa.replace('Check your tyres when', 'Check tyres when'), OPTS).errors).includes('BOX_DUPLICATED'));
});

const NEW_FAQ = '<!-- wp:heading -->\n<h2 class="wp-block-heading">Frequently Asked Questions</h2>\n<!-- /wp:heading -->\n' +
  '<!-- wp:html -->\n<details><summary>What pressure should my tyres be?</summary><p>Use the pressure on your door sticker.</p></details>\n' +
  '<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"What pressure should my tyres be?","acceptedAnswer":{"@type":"Answer","text":"Use the pressure on your door sticker."}}]}</script>\n<!-- /wp:html -->';

test('NEW_FAQ_NOT_ALLOWED: new FAQ when allowNewFaq is false; allowed when the original has one', () => {
  const edited = insertBeforeSnippet(GOOD, NEW_FAQ);
  expectError(validate(edited, { allowNewFaq: false }), 'NEW_FAQ_NOT_ALLOWED');
  expectError(validate(edited, { allowNewFaq: 'no' }), 'NEW_FAQ_NOT_ALLOWED');
  assert.equal(validate(edited).pass, true);
  assert.equal(validate(edited, { allowNewFaq: true }).pass, true);
});

test('INTERNAL_ERROR: anything that throws inside processEditorOutput keeps the original', async () => {
  const bad = {};
  Object.defineProperty(bad, 'siteDomains', { get() { throw new Error('boom'); } });
  const r = await V.processEditorOutput(ORIG, GOOD_TEXT, bad);
  assert.equal(r.action, 'keep_original');
  assert.equal(r.html, ORIG);
  expectError({ errors: r.errors, pass: false }, 'INTERNAL_ERROR');
});

// ---------------------------------------------------------------------------------------------
// warnings
// ---------------------------------------------------------------------------------------------
test('warnings: AI_PHRASE, NEW_CONCLUSION, EMOJI_ADDED, LINK_IN_HEADING', () => {
  let r = validate(insertBeforeSnippet(GOOD, para('When it comes to tyres, let us delve into a seamless routine.')));
  assert.equal(r.pass, true);
  expectWarning(r, 'AI_PHRASE');
  assert.match(r.warnings.find((w) => w.code === 'AI_PHRASE').message, /when it comes to.*delve.*seamless/);

  r = validate(insertBeforeSnippet(GOOD, '<!-- wp:heading -->\n<h2 class="wp-block-heading">Conclusion</h2>\n<!-- /wp:heading -->\n' + para('Check monthly and stay safe on every road trip.')));
  expectWarning(r, 'NEW_CONCLUSION');

  r = validate(insertBeforeSnippet(GOOD, para('Drive safe ' + CAR_EMOJI)));
  expectWarning(r, 'EMOJI_ADDED');

  r = validate(replaceOnce(GOOD, '<h2 class="wp-block-heading">Where Do You Find the Right Tyre Pressure?</h2>',
    '<h2 class="wp-block-heading">Where Do You Find the <a href="https://www.gov.uk/">Right Tyre Pressure</a>?</h2>'));
  expectWarning(r, 'LINK_IN_HEADING');
});

test('warnings: FAQ_SCHEMA_MISMATCH (count and unknown question)', () => {
  const mismatch = NEW_FAQ.replace('"mainEntity":[', '"mainEntity":[{"@type":"Question","name":"Is nitrogen better than air?","acceptedAnswer":{"@type":"Answer","text":"x"}},');
  const r = validate(insertBeforeSnippet(GOOD, mismatch));
  expectWarning(r, 'FAQ_SCHEMA_MISMATCH');
  assert.equal(r.warnings.filter((w) => w.code === 'FAQ_SCHEMA_MISMATCH').length, 2);
  assert.ok(!codes(validate(insertBeforeSnippet(GOOD, NEW_FAQ)).warnings).includes('FAQ_SCHEMA_MISMATCH'));
});

test('warnings: META_LENGTH', () => {
  const r = validate(GOOD, { meta: { seo_titles: ['Tyres'], meta_description: 'Too short.' } });
  expectWarning(r, 'META_LENGTH');
  assert.equal(r.warnings.filter((w) => w.code === 'META_LENGTH').length, 2);
  assert.ok(!codes(validate(GOOD, { meta: GOOD_META }).warnings).includes('META_LENGTH'));
});

test('warnings: DUPLICATE_NEW_LINK and SOURCES_MISMATCH', () => {
  let r = validate(insertBeforeSnippet(GOOD, para('Again: <a href="https://www.tyresafe.org/" target="_blank" rel="noopener">TyreSafe advice</a>.')));
  expectWarning(r, 'DUPLICATE_NEW_LINK');
  r = validate(replaceOnce(GOOD, '</ol>\n<!-- /wp:html -->', '<li><a href="https://www.gov.uk/" target="_blank" rel="noopener">GOV.UK</a>: not linked in the body</li></ol>\n<!-- /wp:html -->'));
  expectWarning(r, 'SOURCES_MISMATCH');
});

// ---------------------------------------------------------------------------------------------
// findNewLinks / sanitizeLinks
// ---------------------------------------------------------------------------------------------
const S_ORIG = [
  '<!-- wp:paragraph -->',
  '<p>Old links: <a href="https://www.reddit.com/r/old/">old forum</a>, <a href="https://tubetyre.com/old/">old internal</a>, ' +
    '<a href="https://www.michelin.com/en/deep/page?x=1&amp;y=2">old deep</a> and <a href="https://gone.example.org/404">old dead</a>.</p>',
  '<!-- /wp:paragraph -->'
].join('\n');

function sEdited(extraBody, sources) {
  return S_ORIG + '\n' + para(extraBody) + (sources || '');
}

const SRC_HEAD = '\n<!-- wp:heading -->\n<h2 class="wp-block-heading">Sources</h2>\n<!-- /wp:heading -->\n<!-- wp:html -->\n<ol style="line-height:1.8;padding-left:20px;">';
const SRC_TAIL = '</ol>\n<!-- /wp:html -->\n';
const li = (url, name) => '<li><a href="' + url + '" target="_blank" rel="noopener">' + name + '</a>: supports a claim</li>';

test('findNewLinks returns only hrefs not in the original (decoded, unique)', () => {
  const e = sEdited('New <a href="https://www.who.int/">WHO</a> and <a href="https://www.who.int/">again</a> and <a href="https://www.michelin.com/en/deep/page?x=1&y=2">same as old</a>.');
  assert.deepEqual(V.findNewLinks(S_ORIG, e, {}), ['https://www.who.int/']);
  assert.deepEqual(V.findNewLinks(ORIG, GOOD, OPTS), ['https://www.tyresafe.org/']);
});

test('sanitizeLinks: internal links (www, subdomain) are unwrapped and the text kept', () => {
  const e = sEdited('See <a href="https://www.tubetyre.com/new/">our new guide</a> and <a href="https://shop.tubetyre.com/x">the shop</a>.');
  const r = V.sanitizeLinks(S_ORIG, e, { siteDomains: ['tubetyre.com'] });
  assert.ok(r.html.includes('See our new guide and the shop.'));
  assert.deepEqual(r.removed.map((x) => x.reason), ['internal', 'internal']);
});

test('sanitizeLinks: forbidden domains, relative, fragment, javascript and mailto links are unwrapped', () => {
  const e = sEdited('A <a href="https://old.reddit.com/r/cars/">thread</a>, <a href="https://amzn.to/abc">deal</a>, ' +
    '<a href="/about/">about</a>, <a href="#top">top</a>, <a href="javascript:alert(1)">js</a>, <a href="mailto:x@y.co">mail</a>.');
  const r = V.sanitizeLinks(S_ORIG, e, { siteDomains: ['tubetyre.com'] });
  assert.ok(r.html.includes('A thread, deal, about, top, js, mail.'));
  assert.deepEqual(r.removed.map((x) => x.reason), ['forbidden_domain', 'forbidden_domain', 'relative', 'fragment', 'javascript', 'not_web_link']);
});

test('sanitizeLinks: dead link unwrapped and its Sources <li> removed; other items stay', () => {
  const dead = 'https://www.dead-site.org/page';
  const e = sEdited('Data from <a href="' + dead + '">the dead site</a> and <a href="https://www.who.int/">WHO</a>.',
    SRC_HEAD + li(dead, 'Dead Site') + li('https://www.who.int/', 'WHO') + SRC_TAIL);
  const r = V.sanitizeLinks(S_ORIG, e, {}, [dead]);
  assert.ok(r.html.includes('Data from the dead site and <a href="https://www.who.int/">WHO</a>.'));
  assert.ok(!r.html.includes(dead));
  assert.ok(!r.html.includes('Dead Site'));
  assert.ok(r.html.includes('<h2 class="wp-block-heading">Sources</h2>'));
  assert.ok(r.html.includes(li('https://www.who.int/', 'WHO')));
  assert.deepEqual(r.removed, [{ url: dead, reason: 'dead', where: 'sources' }]);
});

test('sanitizeLinks: Sources section removed with its block comments when it becomes empty', () => {
  const dead = 'https://www.dead-site.org/page';
  const e = sEdited('Data from <a href="' + dead + '">the dead site</a>.', SRC_HEAD + li(dead, 'Dead Site') + SRC_TAIL);
  const r = V.sanitizeLinks(S_ORIG, e, {}, [{ url: dead, verdict: 'dead' }]);
  assert.ok(!/Sources/.test(r.html), r.html);
  assert.ok(!r.html.includes('<ol'));
  assert.ok(!r.html.includes('wp:html'));
  assert.ok(!r.html.includes('wp:heading'));
  assert.ok(r.html.includes('Data from the dead site.'));
  // the result is still a valid edit of the original structure
  const v = V.validateArticle(S_ORIG, r.html, {});
  assert.ok(!codes(v.errors).includes('BLOCK_UNBALANCED'), JSON.stringify(v.errors));
});

test('sanitizeLinks: wp:list Sources with list-item comments; emptied list removed cleanly', () => {
  const dead = 'https://www.dead-site.org/page';
  const src = '\n<!-- wp:heading -->\n<h2 class="wp-block-heading">Sources</h2>\n<!-- /wp:heading -->\n\n<!-- wp:list {"ordered":true} -->\n<ol class="wp-block-list"><!-- wp:list-item -->\n' +
    li(dead, 'Dead') + '\n<!-- /wp:list-item --></ol>\n<!-- /wp:list -->\n\n' + para('Final words after the list.');
  const r = V.sanitizeLinks(S_ORIG, sEdited('Body text only.', src), {}, [dead]);
  assert.ok(!r.html.includes('Sources'));
  assert.ok(!r.html.includes('wp:list'));
  assert.ok(r.html.includes('Final words after the list.'));
  const toks = V._internal.blockTokens(r.html);
  const bal = {};
  for (const t of toks) if (!t.selfClosing) bal[t.name] = (bal[t.name] || 0) + (t.closing ? -1 : 1);
  assert.ok(Object.values(bal).every((x) => x === 0), JSON.stringify(bal));
});

test('sanitizeLinks: webSearchCount 0 unwraps deep links but keeps bare homepages', () => {
  const e = sEdited('<a href="https://www.who.int/news/item/1">deep</a>, <a href="https://www.who.int/">home</a>, ' +
    '<a href="https://www.cdc.gov">bare</a>, <a href="https://www.nhs.uk/?q=tyres">query</a>.');
  const r = V.sanitizeLinks(S_ORIG, e, { webSearchCount: 0 });
  assert.ok(r.html.includes('deep, <a href="https://www.who.int/">home</a>, <a href="https://www.cdc.gov">bare</a>, query.'));
  assert.deepEqual(r.removed.map((x) => x.reason), ['deep_link_without_research', 'deep_link_without_research']);
  // with research (or unknown), deep links stay
  assert.equal(V.sanitizeLinks(S_ORIG, e, { webSearchCount: 4 }).removed.length, 0);
  assert.equal(V.sanitizeLinks(S_ORIG, e, {}).removed.length, 0);
});

test('sanitizeLinks: links present in the original are never touched', () => {
  const r = V.sanitizeLinks(S_ORIG, S_ORIG, { siteDomains: ['tubetyre.com'], webSearchCount: 0 },
    ['https://gone.example.org/404', 'https://www.reddit.com/r/old/']);
  assert.equal(r.html, S_ORIG);
  assert.deepEqual(r.removed, []);
  // a Sources item that only holds an original link is kept even if "dead"
  const e = sEdited('Body.', SRC_HEAD + li('https://gone.example.org/404', 'Old source') + SRC_TAIL);
  const r2 = V.sanitizeLinks(S_ORIG, e, {}, ['https://gone.example.org/404']);
  assert.equal(r2.html, e);
});

test('sanitizeLinks: custom forbiddenLinkDomains replace the default list', () => {
  const e = sEdited('<a href="https://www.pinterest.com/x">pin</a> and <a href="https://spam.biz/">spam</a>.');
  const r = V.sanitizeLinks(S_ORIG, e, { forbiddenLinkDomains: ['spam.biz'] });
  assert.deepEqual(r.removed.map((x) => x.url), ['https://spam.biz/']);
});

// ---------------------------------------------------------------------------------------------
// checkLinks
// ---------------------------------------------------------------------------------------------
test('checkLinks: 404 dead, 403 unknown, 405 HEAD then GET 200 ok, ENOTFOUND dead, timeout unknown', async () => {
  const calls = [];
  const notFound = new TypeError('fetch failed');
  notFound.cause = Object.assign(new Error('getaddrinfo ENOTFOUND nope.invalid'), { code: 'ENOTFOUND' });
  const routes = {
    'https://a.test/404': () => ({ status: 404 }),
    'https://a.test/403': () => ({ status: 403 }),
    'https://a.test/405': (m) => ({ status: m === 'HEAD' ? 405 : 200 }),
    'https://nope.invalid/': () => { throw notFound; },
    'https://a.test/slow': (m, init) => new Promise((resolve, reject) => {
      if (init && init.signal) init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
    'https://a.test/ok': () => ({ status: 200 })
  };
  const urls = Object.keys(routes);
  const res = await V.checkLinks(urls, { fetchFn: makeFetch(routes, calls), timeoutMs: 60, concurrency: 3 });
  const by = Object.fromEntries(res.map((r) => [r.url, r]));
  assert.equal(by['https://a.test/404'].verdict, 'dead');
  assert.equal(by['https://a.test/404'].status, 404);
  assert.equal(by['https://a.test/403'].verdict, 'unknown');
  assert.equal(by['https://a.test/405'].verdict, 'ok');
  assert.equal(by['https://a.test/405'].status, 200);
  assert.deepEqual(calls.filter((c) => c[1] === 'https://a.test/405').map((c) => c[0]), ['HEAD', 'GET']);
  assert.equal(by['https://nope.invalid/'].verdict, 'dead');
  assert.match(by['https://nope.invalid/'].error, /ENOTFOUND/);
  assert.equal(by['https://a.test/slow'].verdict, 'unknown');
  assert.equal(by['https://a.test/slow'].error, 'timeout');
  assert.equal(by['https://a.test/ok'].verdict, 'ok');
  assert.deepEqual(res.map((r) => r.url), urls, 'results keep input order');
  // ok on HEAD needs no GET
  assert.deepEqual(calls.filter((c) => c[1] === 'https://a.test/ok').map((c) => c[0]), ['HEAD']);
});

test('checkLinks: timeout also works when fetchFn ignores the abort signal', async () => {
  const res = await V.checkLinks(['https://a.test/hang'], { fetchFn: () => new Promise(() => {}), timeoutMs: 40 });
  assert.equal(res[0].verdict, 'unknown');
  assert.equal(res[0].error, 'timeout');
});

test('checkLinks: 410 and 5xx dead, 401/429 unknown, ECONNREFUSED and certificate errors dead, invalid URL dead', async () => {
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const cert = Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED', message: 'certificate has expired' } });
  const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
  const routes = {
    'https://a.test/410': () => ({ status: 410 }),
    'https://a.test/503': () => ({ status: 503 }),
    'https://a.test/401': () => ({ status: 401 }),
    'https://a.test/429': () => ({ status: 429 }),
    'https://refused.test/': () => { throw refused; },
    'https://cert.test/': () => { throw cert; },
    'https://reset.test/': () => { throw reset; },
    'https://a.test/head-500-get-200': (m) => ({ status: m === 'HEAD' ? 500 : 200 })
  };
  const res = await V.checkLinks(Object.keys(routes).concat(['not a url']), { fetchFn: makeFetch(routes), timeoutMs: 200 });
  const v = Object.fromEntries(res.map((r) => [r.url, r.verdict]));
  assert.deepEqual(v, {
    'https://a.test/410': 'dead', 'https://a.test/503': 'dead', 'https://a.test/401': 'unknown', 'https://a.test/429': 'unknown',
    'https://refused.test/': 'dead', 'https://cert.test/': 'dead', 'https://reset.test/': 'unknown',
    'https://a.test/head-500-get-200': 'ok', 'not a url': 'dead'
  });
});

test('checkLinks: concurrency limit, duplicate URLs fetched once, no fetch => unknown', async () => {
  let inFlight = 0;
  let max = 0;
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push(url);
    inFlight++;
    max = Math.max(max, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return { status: 200 };
  };
  const urls = ['https://a.test/1', 'https://a.test/2', 'https://a.test/3', 'https://a.test/4', 'https://a.test/5', 'https://a.test/1'];
  const res = await V.checkLinks(urls, { fetchFn, concurrency: 2 });
  assert.ok(max <= 2, 'max in flight ' + max);
  assert.equal(res.length, 6);
  assert.equal(calls.filter((u) => u === 'https://a.test/1').length, 1);

  const saved = globalThis.fetch;
  try {
    globalThis.fetch = undefined;
    const r2 = await V.checkLinks(['https://a.test/x'], {});
    assert.equal(r2[0].verdict, 'unknown');
  } finally {
    globalThis.fetch = saved;
  }
});

// ---------------------------------------------------------------------------------------------
// filterAuditIssues
// ---------------------------------------------------------------------------------------------
const AUDIT_HTML = '<p>It&rsquo;s best to check <strong>cold</strong> tyres &mdash; before you drive.</p>' +
  '<p>Most cars need between 30 and 35 psi, as ' + LDQUO + 'the door sticker' + RDQUO + ' shows.</p>' +
  '<figure><img src="a.jpg" alt="Gauge on a valve"></figure>';

test('filterAuditIssues: keeps real quotes (entities, tags, curly quotes, dashes, case, ellipsis), drops invented ones', () => {
  const audit = {
    verdict: 'fix',
    issues: [
      { severity: 'high', category: 'fact_wrong', quote: "It's best to check cold tyres - before you drive", problem: 'p', fix: 'f' },
      { severity: 'medium', category: 'x', quote: 'MOST CARS NEED BETWEEN 30 AND 35 PSI, AS "THE DOOR STICKER" SHOWS', problem: 'p', fix: 'f' },
      { severity: 'low', category: 'x', quote: 'It' + RSQUO + 's best to check ' + HELLIP + ' before you drive.', problem: 'p', fix: 'f' },
      { severity: 'high', category: 'invented_experience', quote: 'In my experience nitrogen is always better', problem: 'p', fix: 'f' },
      { severity: 'low', category: 'x', quote: 'gauge on a valve', problem: 'alt text', fix: 'f' }
    ]
  };
  const r = V.filterAuditIssues(AUDIT_HTML, audit);
  assert.equal(r.issues.length, 4);
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0].quote, 'In my experience nitrogen is always better');
  assert.equal(r.blocking, true);
  assert.equal(r.effectiveVerdict, 'fix');
  assert.equal(r.valid, true);
});

test('filterAuditIssues: blocking recomputed after dropping invented high issues; string input with fence', () => {
  const text = '```json\n' + JSON.stringify({ verdict: 'fix', issues: [
    { severity: 'high', category: 'fact_wrong', quote: 'The tyres must be inflated to 50 psi at all times', problem: 'p', fix: 'f' },
    { severity: 'low', category: 'x', quote: 'before you drive', problem: 'p', fix: 'f' }
  ] }) + '\n```';
  const r = V.filterAuditIssues(AUDIT_HTML, text);
  assert.equal(r.blocking, false);
  assert.equal(r.effectiveVerdict, 'pass');
  assert.equal(r.verdict, 'fix');
  assert.equal(r.issues.length, 1);
});

test('filterAuditIssues: reject stays reject; invalid audit fails closed; unknown severity counts as high', () => {
  let r = V.filterAuditIssues(AUDIT_HTML, { verdict: 'reject', issues: [] });
  assert.equal(r.effectiveVerdict, 'reject');
  r = V.filterAuditIssues(AUDIT_HTML, 'not json at all');
  assert.equal(r.valid, false);
  assert.equal(r.blocking, true);
  assert.equal(r.effectiveVerdict, 'reject');
  r = V.filterAuditIssues(AUDIT_HTML, { verdict: 'pass', issues: [{ severity: 'critical', quote: 'check cold tyres', problem: 'p' }] });
  assert.equal(r.issues[0].severity, 'high');
  assert.equal(r.blocking, true);
  assert.equal(r.effectiveVerdict, 'fix');
});

test('filterAuditIssues: info_lost quotes may come from the original when originalHtml is given', () => {
  const audit = { verdict: 'fix', issues: [{ severity: 'high', category: 'info_lost', quote: 'wait at least three hours before you check', problem: 'dropped' }] };
  assert.equal(V.filterAuditIssues(AUDIT_HTML, audit).issues.length, 0);
  assert.equal(V.filterAuditIssues(AUDIT_HTML, audit, { originalHtml: ORIG }).issues.length, 1);
});

// ---------------------------------------------------------------------------------------------
// processEditorOutput end to end
// ---------------------------------------------------------------------------------------------
test('processEditorOutput: good output + fake fetch 200 => publish', async () => {
  const calls = [];
  const r = await V.processEditorOutput(ORIG, GOOD_TEXT, Object.assign({}, OPTS, { fetchFn: makeFetch({}, calls) }));
  assert.equal(r.action, 'publish', JSON.stringify(r.errors));
  assert.equal(r.html, GOOD);
  assert.equal(r.changed, true);
  assert.deepEqual(r.linkResults.map((x) => [x.url, x.verdict]), [['https://www.tyresafe.org/', 'ok']]);
  assert.deepEqual(r.removedLinks, []);
  assert.deepEqual(calls, [['HEAD', 'https://www.tyresafe.org/']]);
});

test('processEditorOutput: dead new link => unwrapped, its Sources item removed, still publish', async () => {
  const fetchFn = makeFetch({ 'https://www.tyresafe.org/': () => ({ status: 404 }) });
  const r = await V.processEditorOutput(ORIG, GOOD_TEXT, Object.assign({}, OPTS, { fetchFn }));
  assert.equal(r.action, 'publish', JSON.stringify(r.errors));
  assert.ok(!r.html.includes('tyresafe.org'));
  assert.ok(r.html.includes('The UK tyre safety charity TyreSafe also recommends a monthly check.'));
  assert.ok(r.html.includes('<h2 class="wp-block-heading">Sources</h2>'));
  assert.ok(r.html.includes('NHTSA: Tires'));
  assert.deepEqual(r.removedLinks.map((x) => x.reason), ['dead', 'dead']);
  assert.deepEqual(r.linkResults.map((x) => x.verdict), ['dead']);
});

test('processEditorOutput: forbidden/internal new links are unwrapped without being fetched', async () => {
  const calls = [];
  const html = insertBeforeSnippet(GOOD, para('See <a href="https://www.reddit.com/r/cars/">a forum</a> and <a href="https://tubetyre.com/x/">our page</a>.'));
  const r = await V.processEditorOutput(ORIG, wrapOutput(html), Object.assign({}, OPTS, { fetchFn: makeFetch({}, calls) }));
  assert.equal(r.action, 'publish', JSON.stringify(r.errors));
  assert.ok(r.html.includes('See a forum and our page.'));
  assert.deepEqual(calls.map((c) => c[1]), ['https://www.tyresafe.org/']);
});

test('processEditorOutput: META web_research_used false + unknown search count => deep new links unwrapped', async () => {
  const html = replaceAll(GOOD, 'https://www.tyresafe.org/', 'https://www.tyresafe.org/tyre-pressure/');
  const r = await V.processEditorOutput(ORIG, wrapOutput(html, { web_research_used: false }), Object.assign({}, OPTS, { checkLinks: false }));
  assert.equal(r.action, 'publish', JSON.stringify(r.errors));
  assert.ok(!r.html.includes('tyresafe.org'));
  assert.ok(r.removedLinks.every((x) => x.reason === 'deep_link_without_research'));
});

test('processEditorOutput: skip, truncated reply, and validation failure keep the original html', async () => {
  let r = await V.processEditorOutput(ORIG, '<<<ARTICLE_HTML>>>\n<<<META_JSON>>>\n{"status":"skipped","skip_reason":"no article"}\n<<<END>>>', OPTS);
  assert.equal(r.action, 'skip');
  assert.equal(r.html, ORIG);

  r = await V.processEditorOutput(ORIG, GOOD_TEXT.slice(0, GOOD_TEXT.length - 200), Object.assign({}, OPTS, { checkLinks: false }));
  assert.equal(r.action, 'keep_original');
  assert.equal(r.html, ORIG);
  assert.ok(codes(r.errors).includes('PARSE_MISSING_MARKER'));

  const broken = replaceOnce(GOOD, '[gallery ids="201,202,203" columns="3" size="medium"]', '');
  r = await V.processEditorOutput(ORIG, wrapOutput(broken), Object.assign({}, OPTS, { checkLinks: false }));
  assert.equal(r.action, 'keep_original');
  assert.equal(r.html, ORIG);
  assert.ok(codes(r.errors).includes('SHORTCODE_MISSING'));
  assert.ok(typeof r.candidateHtml === 'string' && r.candidateHtml.length > 0);
});

test('processEditorOutput: classic fixture end to end with fake fetch => publish', async () => {
  const r = await V.processEditorOutput(ORIG_C, GOOD_C_TEXT, Object.assign({}, OPTS_C, { fetchFn: makeFetch({}), allowNewFaq: 'no' }));
  assert.equal(r.action, 'publish', JSON.stringify(r.errors));
  assert.ok(r.html.includes('https://www.paint.org/'));
  assert.equal(r.stats.images, 1);
});

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
function cli(args) {
  return spawnSync(process.execPath, [SCRIPT].concat(args), { encoding: 'utf8', timeout: 30000 });
}

test('CLI: exit 0 publish (writes html and report), 2 keep_original (removes stale html), 3 skip, 1 usage/IO error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-cli-'));
  try {
    const out = path.join(dir, 'out.html');
    const rep = path.join(dir, 'report.json');
    let r = cli(['--original', path.join(FIX, 'original-block.html'), '--output', path.join(FIX, 'edited-good.txt'),
      '--site', 'tubetyre.com', '--searches', '5', '--faq', 'no', '--no-link-check', '--write-html', out, '--report', rep]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const printed = JSON.parse(r.stdout);
    assert.equal(printed.action, 'publish');
    assert.equal(printed.html, undefined);
    assert.equal(fs.readFileSync(out, 'utf8'), GOOD);
    assert.equal(JSON.parse(fs.readFileSync(rep, 'utf8')).html, GOOD);

    const bad = path.join(dir, 'bad.txt');
    fs.writeFileSync(bad, GOOD_TEXT.replace('<<<END>>>', ''));
    r = cli(['--original', path.join(FIX, 'original-block.html'), '--output', bad, '--no-link-check', '--write-html', out]);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(JSON.parse(r.stdout).action, 'keep_original');
    assert.equal(fs.existsSync(out), false, 'stale output file must be removed');

    const skip = path.join(dir, 'skip.txt');
    fs.writeFileSync(skip, '<<<ARTICLE_HTML>>>\n<<<META_JSON>>>\n{"status":"skipped"}\n<<<END>>>');
    r = cli(['--original', path.join(FIX, 'original-block.html'), '--output', skip, '--no-link-check']);
    assert.equal(r.status, 3, r.stderr);

    r = cli(['--original', path.join(FIX, 'original-block.html')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usage/);
    r = cli(['--original', path.join(dir, 'missing.html'), '--output', skip]);
    assert.equal(r.status, 1);
    r = cli(['--original', path.join(FIX, 'original-block.html'), '--output', skip, '--searches', 'many']);
    assert.equal(r.status, 1);
    r = cli(['--bogus']);
    assert.equal(r.status, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: classic fixture publishes', () => {
  const r = cli(['--original', path.join(FIX, 'original-classic.html'), '--output', path.join(FIX, 'edited-classic-good.txt'),
    '--site', 'getcostidea.com', '--searches', '0', '--no-link-check']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// ---------------------------------------------------------------------------------------------
// performance and robustness
// ---------------------------------------------------------------------------------------------
function bigArticle(base, targetBytes) {
  const body = base.slice(base.indexOf('<!-- wp:heading -->\n<h2'));
  let out = base;
  let i = 0;
  while (out.length < targetBytes) {
    i++;
    out += '\n' + body.replace(/tyre/g, 'tyre' + i).replace(/id="([^"]+)"/g, 'id="$1-' + i + '"')
      .replace(/<!-- wp:rank-math\/[\s\S]*?<!-- \/wp:rank-math\/toc-block -->/, '');
  }
  return out;
}

test('performance: 300 KB article validated in well under a second', async () => {
  const o = bigArticle(ORIG, 300 * 1024);
  const e = bigArticle(GOOD, 300 * 1024);
  assert.ok(o.length >= 300 * 1024 && e.length >= 300 * 1024);
  const t0 = process.hrtime.bigint();
  const r = V.validateArticle(o, e, OPTS);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const t1 = process.hrtime.bigint();
  const p = await V.processEditorOutput(o, wrapOutput(e), Object.assign({}, OPTS, { checkLinks: false }));
  const ms2 = Number(process.hrtime.bigint() - t1) / 1e6;
  console.log('# validateArticle on ' + Math.round(e.length / 1024) + ' KB: ' + ms.toFixed(1) + ' ms; processEditorOutput: ' + ms2.toFixed(1) + ' ms');
  assert.ok(ms < 1000, 'took ' + ms + ' ms');
  assert.ok(ms2 < 1500, 'took ' + ms2 + ' ms');
  assert.ok(Array.isArray(r.errors) && p.action);
});

test('robustness: pathological 300 KB inputs finish fast (no catastrophic backtracking)', async () => {
  const N = 300 * 1024;
  const rep = (s) => s.repeat(Math.ceil(N / s.length)).slice(0, N);
  const cases = {
    unclosedAnchors: rep('<a href="https://x.test/'),
    anchorsNoClose: rep('<a href="https://x.test/">t '),
    ltLetters: rep('<a'),
    longName: '<' + 'a'.repeat(N),
    quotes: rep('<p class="x\'y" '),
    comments: rep('<!-- '),
    blockComments: rep('<!-- wp:paragraph '),
    blockOpeners: rep('<!-- wp:x/y --><p>'),
    scripts: rep('<script '),
    scriptOpen: rep('<script>'),
    shortcodes: rep('[caption id="a" '),
    brackets: rep('[a '),
    headings: rep('<h2>x '),
    entities: rep('&amp;&#x1F600;&bogus;'),
    lastChecked: rep('last checked '),
    markers: rep('<<<ARTICLE_HTML>>>'),
    nested: rep('<div><span><p>'),
    fences: rep('```')
  };
  for (const [name, s] of Object.entries(cases)) {
    const t0 = process.hrtime.bigint();
    V.validateArticle(s, s + '<p>x</p>', OPTS);
    V.sanitizeLinks(s, s + '<a href="https://reddit.com/">r</a>', OPTS, ['https://x.test/']);
    V.filterAuditIssues(s, { verdict: 'pass', issues: [{ severity: 'low', quote: 'some quote that is not there' }] });
    V.parseEditorOutput(s);
    await V.processEditorOutput(s, '<<<ARTICLE_HTML>>>\n' + s + '\n<<<META_JSON>>>\n{"status":"edited"}\n<<<END>>>', { checkLinks: false });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 2500, name + ' took ' + ms.toFixed(0) + ' ms');
  }
});

test('n8n paste: the whole file runs as a plain function body without module/require', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  // Simulate an n8n Code node: no module, no require; code must end with a return we add ourselves.
  const fn = new Function(src + '\nreturn { parseEditorOutput, validateArticle, sanitizeLinks, filterAuditIssues, processEditorOutput, checkLinks, findNewLinks };');
  const api = fn();
  const p = api.parseEditorOutput(GOOD_TEXT);
  assert.equal(api.validateArticle(ORIG, p.html, OPTS).pass, true);
});

// ---------------------------------------------------------------------------------------------
// coverage of every code (runs last)
// ---------------------------------------------------------------------------------------------
test('every hard error code and every warning code has at least one test', () => {
  const missingErrors = V.ERROR_CODES.filter((c) => !covered.has(c));
  const missingWarnings = V.WARNING_CODES.filter((c) => !covered.has('warn:' + c));
  assert.deepEqual(missingErrors, []);
  assert.deepEqual(missingWarnings, []);
});
