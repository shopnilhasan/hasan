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

test('PARSE_META_JSON: invalid JSON without a readable status, missing status, wrong status, JSON array', () => {
  expectError(V.parseEditorOutput('<<<ARTICLE_HTML>>>\n<p>x</p>\n<<<META_JSON>>>\n{"stat": "edited",, }\n<<<END>>>'), 'PARSE_META_JSON');
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

test('FIRST_ELEMENT: a plain wrapper div (Group block) is looked into; a box or heading inside still fails', () => {
  const wrap = (x) => '<!-- wp:group -->\n<div class="wp-block-group"><div class="wp-block-group__inner-container">\n' + x + '\n</div></div>\n<!-- /wp:group -->';
  const o = wrap(ORIG);
  assert.equal(V._internal.leadingItem(wrap(GOOD)).kind, 'p');
  assert.equal(V.validateArticle(o, wrap(GOOD), OPTS).pass, true);
  expectError(V.validateArticle(o, wrap(GOOD.slice(GOOD.indexOf(QA_BOX_START))), OPTS), 'FIRST_ELEMENT_NOT_P');
});

test('BAD_NEW_LINK / sanitize: a new link wrapped around an existing image is unwrapped', () => {
  const img = '<img decoding="async" loading="lazy" width="1024" height="683" src="https://tubetyre.com/wp-content/uploads/2024/05/tyre-pressure-gauge-1024x683.jpg"';
  const i = GOOD.indexOf(img);
  const j = GOOD.indexOf('/>', i) + 2;
  const linked = GOOD.slice(0, i) + '<a href="https://www.tyresafe.org/">' + GOOD.slice(i, j) + '</a>' + GOOD.slice(j);
  expectError(validate(linked), 'BAD_NEW_LINK');
  const s = V.sanitizeLinks(ORIG, linked, OPTS);
  assert.equal(s.html, GOOD);
  assert.deepEqual(s.removed, [{ url: 'https://www.tyresafe.org/', reason: 'image_link' }]);
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
  // h2 -> h3 -> h2 is fine (with the matching block comment); headings inside plugin blocks (TOC h2) are ignored
  const toH3 = replaceOnce(GOOD, '<!-- wp:heading -->\n' + h, '<!-- wp:heading {"level":3} -->\n<h3 class="wp-block-heading">How Often Should You Check Tyre Pressure?</h3>');
  const r3 = validate(toH3);
  assert.equal(r3.pass, true, JSON.stringify(r3.errors));
});

test('PLACEHOLDER: [VERIFY], {{...}}, TODO:, href="#", example.com', () => {
  const r = validate(insertBeforeSnippet(GOOD, para('Prices start at [VERIFY: price] and {{ANSWER}} TODO: see <a href="#">here</a> or example.com.')));
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
  assert.ok(!codes(V.validateArticle(o, GOOD + '\n' + qa.replace('Check your tyres when', 'Check tyres when'), OPTS).errors).includes('BOX_DUPLICATED'));
  expectError(V.validateArticle(o, GOOD + '\n' + qa + '\n' + qa, OPTS), 'BOX_DUPLICATED');
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
  assert.deepEqual(r.removed, [{ url: dead, reason: 'dead', where: 'sources' }, { url: dead, reason: 'dead' }]);
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

test('filterAuditIssues: a "fix" whose high quote is not found stays "fix" (never downgraded to pass); string input with fence', () => {
  const text = '```json\n' + JSON.stringify({ verdict: 'fix', issues: [
    { severity: 'high', category: 'fact_wrong', quote: 'The tyres must be inflated to 50 psi at all times', problem: 'p', fix: 'f' },
    { severity: 'low', category: 'x', quote: 'before you drive', problem: 'p', fix: 'f' }
  ] }) + '\n```';
  const r = V.filterAuditIssues(AUDIT_HTML, text);
  assert.equal(r.verdict, 'fix');
  assert.equal(r.effectiveVerdict, 'fix');
  assert.equal(r.blocking, true);
  assert.equal(r.issues.length, 1);
  assert.equal(r.dropped.length, 1);
  // the unmatched high issue goes into the retry's Extra instructions, first
  assert.deepEqual(r.retryIssues.map((i) => [i.severity, !!i.quoteNotFound]), [['high', true], ['low', false]]);
  // the same invented high issue with an auditor verdict "pass": dropped, pass
  const r2 = V.filterAuditIssues(AUDIT_HTML, { verdict: 'pass', issues: [{ severity: 'high', quote: 'The tyres must be inflated to 50 psi at all times' }] });
  assert.equal(r2.effectiveVerdict, 'pass');
  assert.equal(r2.blocking, false);
});

test('filterAuditIssues: reject stays reject; invalid audit fails closed; unknown severity counts as high', () => {
  let r = V.filterAuditIssues(AUDIT_HTML, { verdict: 'reject', issues: [] });
  assert.equal(r.effectiveVerdict, 'reject');
  assert.equal(r.blocking, true);
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
  assert.deepEqual(r.removedLinks, [
    { url: 'https://www.tyresafe.org/', reason: 'dead', where: 'sources' },
    { url: 'https://www.tyresafe.org/', reason: 'dead' }
  ]);
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
    r = cli(['--original', path.join(FIX, 'original-block.html'), '--output', bad, '--site', 'tubetyre.com', '--no-link-check', '--write-html', out]);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(JSON.parse(r.stdout).action, 'keep_original');
    assert.equal(fs.existsSync(out), false, 'stale output file must be removed');

    const skip = path.join(dir, 'skip.txt');
    fs.writeFileSync(skip, '<<<ARTICLE_HTML>>>\n<<<META_JSON>>>\n{"status":"skipped"}\n<<<END>>>');
    r = cli(['--original', path.join(FIX, 'original-block.html'), '--output', skip, '--site', 'tubetyre.com', '--no-link-check']);
    assert.equal(r.status, 3, r.stderr);

    r = cli(['--original', path.join(FIX, 'original-block.html')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Usage/);
    r = cli(['--original', path.join(dir, 'missing.html'), '--output', skip, '--site', 'tubetyre.com']);
    assert.equal(r.status, 1);
    r = cli(['--original', path.join(FIX, 'original-block.html'), '--output', skip, '--site', 'tubetyre.com', '--searches', 'many']);
    assert.equal(r.status, 1);
    r = cli(['--bogus']);
    assert.equal(r.status, 1);
    // --site is required (a missing own-domain setting would let new internal links through)
    r = cli(['--original', path.join(FIX, 'original-block.html'), '--output', path.join(FIX, 'edited-good.txt'), '--no-link-check']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--site is required/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: an old --write-html / --report file is deleted even when the run ends with exit 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-cli-'));
  try {
    const out = path.join(dir, 'final.html');
    const rep = path.join(dir, 'report.json');
    const stale = () => { fs.writeFileSync(out, 'STALE FROM FIRST ATTEMPT'); fs.writeFileSync(rep, '{"action":"publish"}'); };
    const cases = [
      ['--original', path.join(FIX, 'original-block.html'), '--output', path.join(dir, 'does-not-exist.txt'), '--site', 'tubetyre.com'],
      ['--original', path.join(FIX, 'original-block.html'), '--output', path.join(FIX, 'edited-good.txt'), '--site', 'tubetyre.com', '--searches', 'abc'],
      ['--original', path.join(FIX, 'original-block.html'), '--output', path.join(FIX, 'edited-good.txt')]
    ];
    for (const c of cases) {
      stale();
      const r = cli(c.concat(['--write-html', out, '--report', rep]));
      assert.equal(r.status, 1, r.stderr);
      assert.equal(fs.existsSync(out), false, 'stale html must be gone: ' + c.join(' '));
      assert.equal(fs.existsSync(rep), false, 'stale report must be gone: ' + c.join(' '));
    }
    // an output path equal to an input path is refused and the input is NOT deleted
    const orig = path.join(dir, 'original.html');
    fs.copyFileSync(path.join(FIX, 'original-block.html'), orig);
    const r = cli(['--original', orig, '--output', path.join(FIX, 'edited-good.txt'), '--site', 'tubetyre.com', '--write-html', orig]);
    assert.equal(r.status, 1);
    assert.equal(fs.readFileSync(orig, 'utf8'), ORIG);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: --title, --last-checked no and --today reach the checks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'va-cli-'));
  try {
    const base = ['--original', path.join(FIX, 'original-block.html'), '--site', 'tubetyre.com', '--no-link-check'];
    const titled = path.join(dir, 'titled.txt');
    fs.writeFileSync(titled, wrapOutput(para('How to Check Tyre Pressure at Home') + '\n' + GOOD));
    let r = cli(base.concat(['--output', titled, '--title', 'How to Check Tyre Pressure at Home']));
    assert.equal(r.status, 2, r.stdout);
    assert.ok(JSON.parse(r.stdout).errors.some((e) => e.code === 'TITLE_IN_BODY'));
    const checked = path.join(dir, 'checked.txt');
    fs.writeFileSync(checked, wrapOutput(replaceOnce(GOOD, QA_BOX_START, para('<em>Last checked: 2026-09-27. Dates and figures were verified against official sources.</em>') + '\n\n' + QA_BOX_START)));
    r = cli(base.concat(['--output', checked, '--searches', '6']));
    assert.equal(r.status, 0, r.stdout);
    r = cli(base.concat(['--output', checked, '--searches', '6', '--last-checked', 'no']));
    assert.equal(r.status, 2);
    assert.ok(JSON.parse(r.stdout).errors.some((e) => e.code === 'LAST_CHECKED_NOT_ALLOWED'));
    r = cli(base.concat(['--output', checked, '--searches', '0', '--today', '2026-09-27']));
    assert.equal(r.status, 2);
    r = cli(base.concat(['--output', checked, '--today', '27.09.2026']));
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
// review round 2: regression tests (each one failed or false-failed before the fix)
// ---------------------------------------------------------------------------------------------
function expectKeep(r, code) {
  assert.equal(r.action, 'keep_original', 'expected keep_original, got ' + r.action + ': ' + JSON.stringify(r.errors));
  expectError({ errors: r.errors, pass: false }, code);
}
const NOFETCH = { checkLinks: false };
const P = (t) => '<p>' + t + '</p>';

test('STRAY_TEXT: chat text around a block-editor article (before, after, between blocks) is not published', async () => {
  for (const lead of ['Here is the complete edited article:\n', 'FIXED ARTICLE HTML\n', 'html\n']) {
    const r = await V.processEditorOutput(ORIG, wrapOutput(lead + GOOD), Object.assign({}, OPTS, NOFETCH));
    expectKeep(r, 'STRAY_TEXT');
  }
  const tail = await V.processEditorOutput(ORIG, wrapOutput(GOOD + '\nI kept all images and links unchanged. Let me know if you need changes!'), Object.assign({}, OPTS, NOFETCH));
  expectKeep(tail, 'STRAY_TEXT');
  expectError(validate(insertBeforeSnippet(GOOD, 'Note: this section was rewritten for clarity.')), 'STRAY_TEXT');
  // chat inside a normal paragraph at the end
  expectError(validate(GOOD + '\n' + para('Hope this helps! Let me know if you would like any further changes.')), 'STRAY_TEXT');
});

test('STRAY_TEXT: classic articles with bare-text paragraphs flag only chat-like lines (no false fail on normal bare text)', () => {
  const opts = Object.assign({}, OPTS_C, { allowNewFaq: false });
  expectError(V.validateArticle(ORIG_C, 'Here is the edited article:\n\n' + GOOD_C, opts), 'STRAY_TEXT');
  expectError(V.validateArticle(ORIG_C, GOOD_C + '\n\nI kept all images, links and shortcodes unchanged.', opts), 'STRAY_TEXT');
  const normal = replaceOnce(GOOD_C, '<h2>Should You Paint', 'Most painters charge extra for high ceilings and detailed trim work.\n\n<h2>Should You Paint');
  const r = V.validateArticle(ORIG_C, normal, opts);
  assert.equal(r.pass, true, JSON.stringify(r.errors));
  // a normal intro that happens to start with "Here's the complete guide" is not chat
  const intro = replaceOnce(GOOD, '<p>Knowing how to check tyre pressure at home saves fuel', '<p>Here' + "'" + 's the complete guide to checking tyre pressure at home. It saves fuel');
  assert.equal(validate(intro).pass, true);
});

test('MARKDOWN: markdown and search-tool citation marks are not published; code samples are ignored', () => {
  const cases = ['**Tip:** check them cold.', 'See [NHTSA](https://www.nhtsa.gov/) first.',
    'The load index is 91 ([michelin.com](https://www.michelin.com/en/tyres?utm_source=openai)).',
    'Pressure drops in winter 【3†source】.', 'Pressure drops in winter [cite: 1].', 'Pressure drops in winter [1].'];
  for (const c of cases) expectError(validate(insertBeforeSnippet(GOOD, para(c))), 'MARKDOWN');
  expectError(validate(insertBeforeSnippet(GOOD, '\n## Extra heading\n')), 'MARKDOWN');
  assert.equal(validate(insertBeforeSnippet(GOOD, para('Type <code>**bold**</code> in a markdown editor to get bold text today.'))).pass, true);
});

test('MARKDOWN: ChatGPT web-search citation tokens (private-use delimiters or bare "citeturn0search3") are not published', () => {
  const PU = function (cp) { return String.fromCodePoint(cp); };
  const cases = ['Pressure drops in winter.' + PU(0xe200) + 'cite' + PU(0xe202) + 'turn0search3' + PU(0xe202) + 'turn1news12' + PU(0xe201),
    'Pressure drops in winter.citeturn0search3', 'Pressure drops in winter. citeturn0search3turn0news5',
    'Pressure drops in winter (turn2view0).', 'See the manual. fileciteturn0file1'];
  for (const c of cases) {
    const r = validate(insertBeforeSnippet(GOOD, para(c)));
    expectError(r, 'MARKDOWN');
    assert.ok(r.errors.some(function (e) { return /chat citation token/.test(e.message); }), c);
  }
  // normal words are not citation tokens
  assert.equal(validate(insertBeforeSnippet(GOOD, para('Turn the valve cap 3 times, then return to search results and turn 0 into 1 on the gauge.'))).pass, true);
  // a token already in the original is not counted again
  const withToken = insertBeforeSnippet(ORIG, para('Old note citeturn0search3 left by an earlier edit of this page.'));
  assert.equal(V.validateArticle(withToken, insertBeforeSnippet(GOOD, para('Old note citeturn0search3 left by an earlier edit of this page.')), OPTS).errors
    .some(function (e) { return e.code === 'MARKDOWN'; }), false);
});

test('sanitizeLinks: tracking parameters (utm_source=openai, gclid...) are removed from new links only', async () => {
  const e = sEdited('See <a href="https://www.who.int/news/item/1?utm_source=openai&amp;id=7">WHO</a> and <a href="https://www.cdc.gov/?gclid=x">CDC</a>.');
  const r = V.sanitizeLinks(S_ORIG, e, {});
  assert.ok(r.html.includes('<a href="https://www.who.int/news/item/1?id=7">WHO</a>'), r.html);
  assert.ok(r.html.includes('<a href="https://www.cdc.gov/">CDC</a>'), r.html);
  assert.deepEqual(r.changed.map((c) => c.to), ['https://www.who.int/news/item/1?id=7', 'https://www.cdc.gov/']);
  // an original link with a utm parameter is never touched
  const o = para('Old <a href="https://www.who.int/?utm_source=old">WHO</a> link text here.');
  assert.equal(V.sanitizeLinks(o, o, {}).html, o);
  // processEditorOutput checks the cleaned URL
  const calls = [];
  const html = replaceAll(GOOD, 'https://www.tyresafe.org/', 'https://www.tyresafe.org/?utm_source=openai');
  const p = await V.processEditorOutput(ORIG, wrapOutput(html), Object.assign({}, OPTS, { fetchFn: makeFetch({}, calls) }));
  assert.equal(p.action, 'publish', JSON.stringify(p.errors));
  assert.equal(p.html, GOOD);
  assert.deepEqual(calls, [['HEAD', 'https://www.tyresafe.org/']]);
});

test('redirect links: grounding/short/search redirects and cross-site redirects are unwrapped', async () => {
  const e = sEdited('<a href="https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbF9">guide</a>, <a href="https://bit.ly/x1">short</a>, ' +
    '<a href="https://www.google.com/url?q=https://www.who.int/">g</a>, <a href="https://t.co/abc">t</a>.');
  const r = V.sanitizeLinks(S_ORIG, e, { forbiddenLinkDomains: ['spam.biz'] });
  assert.ok(r.html.includes('guide, short, g, t.'), r.html);
  assert.deepEqual(r.removed.map((x) => x.reason), ['redirect', 'redirect', 'redirect', 'redirect']);
  // a new link whose fetch ends on another site is unwrapped; www/https redirects on the same site are fine
  const html = insertBeforeSnippet(GOOD, para('Data from <a href="https://www.brand-a.org/report">the report</a>.'));
  const fetchFn = makeFetch({
    'https://www.brand-a.org/report': () => ({ status: 200, url: 'https://final.example.net/page' }),
    'https://www.tyresafe.org/': () => ({ status: 200, url: 'https://tyresafe.org/' })
  });
  const p = await V.processEditorOutput(ORIG, wrapOutput(html), Object.assign({}, OPTS, { fetchFn }));
  assert.equal(p.action, 'publish', JSON.stringify(p.errors));
  assert.ok(!p.html.includes('brand-a.org') && p.html.includes('Data from the report.'));
  assert.ok(p.html.includes('https://www.tyresafe.org/'));
  assert.deepEqual(p.removedLinks, [{ url: 'https://www.brand-a.org/report', reason: 'redirect' }]);
});

test('checkLinks: soft 404 (deep URL redirected to the homepage) and parked domains are dead', async () => {
  let r = await V.checkLinks(['https://www.who.int/made-up-page'], { fetchFn: async () => ({ status: 200, url: 'https://www.who.int/' }) });
  assert.equal(r[0].verdict, 'dead');
  assert.match(r[0].error, /soft 404/);
  r = await V.checkLinks(['https://www.example-brand.com/p/x'], { fetchFn: async () => ({ status: 200, url: 'https://www.hugedomains.com/domain_profile.cfm?d=example-brand.com' }) });
  assert.equal(r[0].verdict, 'dead');
  // homepage to homepage and same-page redirects stay ok
  r = await V.checkLinks(['https://who.int/', 'https://www.who.int/a'], { fetchFn: async (u) => ({ status: 200, url: u === 'https://who.int/' ? 'https://www.who.int/' : 'https://www.who.int/a/' }) });
  assert.deepEqual(r.map((x) => x.verdict), ['ok', 'ok']);
});

test('checkLinks: n8n-style { statusCode } results and axios-style thrown errors are read', async () => {
  let r = await V.checkLinks(['https://www.who.int/x'], { fetchFn: async () => ({ statusCode: 404 }) });
  assert.equal(r[0].verdict, 'dead');
  r = await V.checkLinks(['https://www.who.int/x'], { fetchFn: async () => { const e = new Error('Request failed with status code 404'); e.response = { status: 404 }; throw e; } });
  assert.equal(r[0].verdict, 'dead');
  r = await V.checkLinks(['https://www.who.int/y'], { fetchFn: async () => ({ statusCode: 200 }) });
  assert.equal(r[0].verdict, 'ok');
});

test('link checks fail closed: no fetch => LINK_CHECK_UNAVAILABLE, deep links unwrapped, homepages kept', async () => {
  const html = insertBeforeSnippet(GOOD, para('See <a href="https://www.who.int/invented/page">WHO</a>.'));
  const saved = globalThis.fetch;
  let r;
  try {
    globalThis.fetch = undefined;
    r = await V.processEditorOutput(ORIG, wrapOutput(html), Object.assign({}, OPTS, { webSearchCount: 3 }));
  } finally {
    globalThis.fetch = saved;
  }
  assert.equal(r.action, 'publish', JSON.stringify(r.errors));
  expectWarning(r, 'LINK_CHECK_UNAVAILABLE');
  assert.ok(!r.html.includes('invented/page'));
  assert.ok(r.html.includes('https://www.tyresafe.org/'));
  assert.deepEqual(r.removedLinks.map((x) => x.reason), ['unverified']);
});

test('link checks fail closed: 403/401/429 deep links are unwrapped unless in verifiedUrls; all-unknown => LINK_CHECK_INCONCLUSIVE', async () => {
  const deep = 'https://www.tyresafe.org/tyre-pressure/';
  const html = replaceAll(GOOD, 'https://www.tyresafe.org/', deep);
  const fetchFn = async () => ({ status: 403 });
  let r = await V.processEditorOutput(ORIG, wrapOutput(html), Object.assign({}, OPTS, { fetchFn }));
  assert.equal(r.action, 'publish', JSON.stringify(r.errors));
  assert.ok(!r.html.includes(deep));
  expectWarning(r, 'LINK_CHECK_INCONCLUSIVE');
  r = await V.processEditorOutput(ORIG, wrapOutput(html), Object.assign({}, OPTS, { fetchFn, verifiedUrls: [deep] }));
  assert.ok(r.html.includes(deep));
  // a 403 homepage stays
  r = await V.processEditorOutput(ORIG, GOOD_TEXT, Object.assign({}, OPTS, { fetchFn }));
  assert.ok(r.html.includes('https://www.tyresafe.org/'));
});

test('CONFIG_MISSING / SITE_DOMAINS_INFERRED: no site domain => guessed from upload URLs, else keep original', async () => {
  const html = insertBeforeSnippet(GOOD, para('Read <a href="https://tubetyre.com/new-guide/">our new guide</a>.'));
  let r = await V.processEditorOutput(ORIG, wrapOutput(html), NOFETCH);
  assert.equal(r.action, 'publish', JSON.stringify(r.errors));
  expectWarning(r, 'SITE_DOMAINS_INFERRED');
  assert.ok(r.html.includes('Read our new guide.'));
  // validateArticle alone also infers it (defence in depth)
  expectError(V.validateArticle(ORIG, html, {}), 'NEW_INTERNAL_LINK');
  // nothing to infer from: fail closed
  r = await V.processEditorOutput(S_ORIG, wrapOutput(S_ORIG + '\n' + para('More text.')), NOFETCH);
  expectKeep(r, 'CONFIG_MISSING');
  assert.deepEqual(V._internal.inferSiteDomains('<img src="https://i0.wp.com/tubetyre.com/wp-content/uploads/a.jpg"><img src="https://cdn.getcostidea.com/wp-content/uploads/b.jpg">'), ['tubetyre.com', 'getcostidea.com']);
});

test('filterAuditIssues: lightly paraphrased quotes and quotes with citation marks are matched (the issue keeps blocking)', () => {
  const art = '<p>Most passenger car tyres should be replaced after six years, whatever the tread depth.</p>';
  let r = V.filterAuditIssues(art, { verdict: 'fix', issues: [{ severity: 'high', category: 'new_claim_unverified', quote: 'passenger tyres should be replaced after six years regardless of tread depth', problem: 'p', fix: 'f' }] });
  assert.equal(r.issues.length, 1);
  assert.equal(r.effectiveVerdict, 'fix');
  r = V.filterAuditIssues(art, { verdict: 'fix', issues: [{ severity: 'high', quote: 'Most passenger car tyres should be replaced after six years, whatever the tread depth. [1]' }] });
  assert.equal(r.issues.length, 1);
  r = V.filterAuditIssues(art, { verdict: 'fix', issues: [{ severity: 'high', quote: 'passenger car tyres should be replaced after six years 【1†source】' }] });
  assert.equal(r.issues.length, 1);
  // ChatGPT citation tokens in the quote (both forms)
  r = V.filterAuditIssues(art, { verdict: 'fix', issues: [{ severity: 'high', quote: 'replaced after six years, whatever citeturn0search3 turn0news1 turn1view2' }] });
  assert.equal(r.issues.length, 1);
  r = V.filterAuditIssues(art, { verdict: 'fix', issues: [{ severity: 'high', quote: 'replaced after six years, whatever' + String.fromCodePoint(0xe200) + 'cite' +
    String.fromCodePoint(0xe202) + 'turn0search3' + String.fromCodePoint(0xe202) + 'turn0news1' + String.fromCodePoint(0xe202) + 'turn1view2' + String.fromCodePoint(0xe201) }] });
  assert.equal(r.issues.length, 1);
  // one word off in a longer quote
  r = V.filterAuditIssues(AUDIT_HTML, { verdict: 'fix', issues: [{ severity: 'high', quote: 'Most cars need between 30 and 36 psi, as the door sticker shows' }] });
  assert.equal(r.issues.length, 1);
  // unrelated words are still dropped
  r = V.filterAuditIssues(AUDIT_HTML, { verdict: 'pass', issues: [{ severity: 'high', quote: 'nitrogen inflation always improves fuel economy by ten percent' }] });
  assert.equal(r.issues.length, 0);
});

test('ID_MISSING / FORBIDDEN_TAG: the title H1 (with an id) after a leading image may be deleted', () => {
  const body = para('Intro text about the best tyres for most drivers this year and why they matter.') +
    '\n<!-- wp:heading -->\n<h2 class="wp-block-heading">Section one</h2>\n<!-- /wp:heading -->\n' + para('Body text for section one with enough words to be counted.');
  const img = '<!-- wp:image {"id":7} -->\n<figure class="wp-block-image"><img src="https://tubetyre.com/wp-content/uploads/a.jpg" alt=""/></figure>\n<!-- /wp:image -->\n';
  const o = img + '<!-- wp:heading {"level":1} -->\n<h1 class="wp-block-heading" id="h-title">Best Tyres 2026</h1>\n<!-- /wp:heading -->\n' + body;
  const e = img.replace('alt=""', 'alt="A car tyre"') + body;
  const r = V.validateArticle(o, e, OPTS);
  assert.equal(r.pass, true, JSON.stringify(r.errors));
  // keeping the title H1 (or adding another) still fails
  expectError(V.validateArticle(o, o, OPTS), 'FORBIDDEN_TAG');
});

test('PLACEHOLDER: leftover {{...}} or an empty answer inside the FAQ JSON-LD', () => {
  expectError(validate(insertBeforeSnippet(GOOD, NEW_FAQ.replace('"text":"Use the pressure on your door sticker."', '"text":"{{ANSWER}}"'))), 'PLACEHOLDER');
  expectError(validate(insertBeforeSnippet(GOOD, NEW_FAQ.replace('"text":"Use the pressure on your door sticker."', '"text":""'))), 'PLACEHOLDER');
});

test('META_JSON_INVALID: an unescaped quote in META does not throw away a good article (status read, research treated as none)', async () => {
  const badMeta = '<<<ARTICLE_HTML>>>\n' + GOOD + '\n<<<META_JSON>>>\n{"status": "edited", "unverified_kept": ["fits 17" wheels"], "web_research_used": true}\n<<<END>>>';
  const p = V.parseEditorOutput(badMeta);
  assert.equal(p.ok, true);
  assert.equal(p.meta.web_research_used, false);
  expectWarning(p, 'META_JSON_INVALID');
  const r = await V.processEditorOutput(ORIG, badMeta, Object.assign({}, OPTS, NOFETCH));
  assert.equal(r.action, 'publish', JSON.stringify(r.errors));
  expectWarning(r, 'META_JSON_INVALID');
  // skipped with broken META is still a skip
  const s = await V.processEditorOutput(ORIG, '<<<ARTICLE_HTML>>>\n<<<META_JSON>>>\n{"status": "skipped", "skip_reason": "a "quoted" thing"}\n<<<END>>>', OPTS);
  assert.equal(s.action, 'skip');
});

function dropSection(html, headText) {
  const i = html.indexOf(headText);
  const s = html.lastIndexOf('<!-- wp:heading -->', i);
  const e = html.indexOf('<!-- wp:heading -->', i + 10);
  return html.slice(0, s) + html.slice(e);
}

test('OMISSION_MARKER: "rest of the article unchanged" notes (text or comment) instead of content', () => {
  const cut = GOOD.indexOf('<!-- wp:heading -->\n<h2 class="wp-block-heading">What Are the Most Common Mistakes?');
  const src = GOOD.indexOf('<!-- wp:heading -->\n<h2 class="wp-block-heading">Sources</h2>');
  expectError(validate(GOOD.slice(0, cut) + para('The rest of the article is unchanged.') + '\n\n' + GOOD.slice(src)), 'OMISSION_MARKER');
  expectError(validate(GOOD.slice(0, cut) + '<!-- rest of article unchanged -->\n\n' + GOOD.slice(src)), 'OMISSION_MARKER');
  expectError(validate(GOOD.slice(0, cut) + para('[...]') + '\n\n' + GOOD.slice(src)), 'OMISSION_MARKER');
  // a normal sentence about unchanged prices is fine
  assert.equal(validate(insertBeforeSnippet(GOOD, para('The recommended pressure for most cars has stayed the same for years.'))).pass, true);
});

test('NEW_HTML_COMMENT (warning): a new plain HTML comment is logged; block comments are not', () => {
  const r = V.validateArticle(ORIG_C, replaceOnce(GOOD_C, '<h2>Should You Paint', '<!-- note: prices unverified -->\n<h2>Should You Paint'), OPTS_C);
  assert.equal(r.pass, true, JSON.stringify(r.errors));
  expectWarning(r, 'NEW_HTML_COMMENT');
  assert.ok(!codes(validate(GOOD).warnings).includes('NEW_HTML_COMMENT'));
});

test('CONTENT_RETENTION: whole sections deleted and hidden by new text are caught', () => {
  let h = dropSection(GOOD, 'What Are the Most Common Mistakes?');
  h = dropSection(h, 'Where Do You Find the Right Tyre Pressure?');
  h = insertBeforeSnippet(h, para('Our guide on <a href="https://tubetyre.com/tyre-sidewall-markings/">sidewall markings</a> helps. ' + uniqueWords(160, 'pad')));
  const r = validate(h);
  expectError(r, 'CONTENT_RETENTION');
  assert.ok(!codes(r.errors).includes('CONTENT_LOSS'), 'the word count alone does not catch it');
  assert.ok(!codes(validate(GOOD).errors).includes('CONTENT_RETENTION'));
});

test('MALFORMED_COMMENT / FORBIDDEN_TAG: unclosed comment, unclosed script, raw-text and base tags', () => {
  const i = GOOD.indexOf('<!-- wp:heading -->\n<h2 class="wp-block-heading">Where Do You Find');
  expectError(validate(GOOD.slice(0, i) + '<!-- ' + GOOD.slice(i)), 'MALFORMED_COMMENT');
  const mid = GOOD_C.indexOf('<h2>Should You Paint');
  expectError(V.validateArticle(ORIG_C, GOOD_C.slice(0, mid) + '<!-- ' + GOOD_C.slice(mid), OPTS_C), 'MALFORMED_COMMENT');
  expectError(validate(GOOD + '\n<script src="https://evil.test/x.js">'), 'FORBIDDEN_TAG');
  expectError(validate(insertBeforeSnippet(GOOD, '<script src="https://evil.test/x.js">')), 'FORBIDDEN_TAG');
  expectError(V.validateArticle(ORIG_C, GOOD_C.slice(0, mid) + '<textarea>' + GOOD_C.slice(mid), OPTS_C), 'FORBIDDEN_TAG');
  expectError(validate(insertBeforeSnippet(GOOD, '<base href="https://evil.test/">')), 'FORBIDDEN_TAG');
  // a new FAQPage JSON-LD script is still allowed
  assert.equal(validate(insertBeforeSnippet(GOOD, NEW_FAQ)).pass, true);
});

const PIC_O = para('Intro text for the picture test that is long enough to count.') + '\n<!-- wp:html --><picture><source srcset="https://tubetyre.com/a.webp" type="image/webp"><img src="https://tubetyre.com/a.jpg" alt="a" width="10" height="10"></picture>' +
  '<iframe src="https://www.youtube.com/embed/REALID" width="560" height="315"></iframe><ins class="adsbygoogle" data-ad-client="ca-pub-1111" data-ad-slot="2222"></ins><!-- /wp:html -->\n' +
  para('More words here so that the ratio is fine and nothing else fails at all.');

test('MEDIA_CHANGED: <source srcset>, <iframe src> and ad <ins> attributes must stay exactly the same', () => {
  expectError(V.validateArticle(PIC_O, PIC_O.replace('https://tubetyre.com/a.webp', 'https://tubetyre.com/OTHER.webp'), OPTS), 'MEDIA_CHANGED');
  expectError(V.validateArticle(PIC_O, PIC_O.replace('REALID', 'HALLUCINATED'), OPTS), 'MEDIA_CHANGED');
  expectError(V.validateArticle(PIC_O, PIC_O.replace('data-ad-slot="2222"', 'data-ad-slot="9999"'), OPTS), 'MEDIA_CHANGED');
  assert.equal(V.validateArticle(PIC_O, PIC_O.replace('alt="a"', 'alt="A tyre"'), OPTS).pass, true);
});

test('EMBED_URL_MISSING: a classic auto-embed URL line must stay on its own line; wp:embed wrapper URL too', () => {
  const yt = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  const o = replaceOnce(ORIG_C, '<h2>DIY vs Hiring a Painter</h2>', yt + '\n\n<h2>DIY vs Hiring a Painter</h2>');
  const keep = replaceOnce(GOOD_C, '<h2>Should You Paint', yt + '\n\n<h2>Should You Paint');
  assert.equal(V.validateArticle(o, keep, OPTS_C).pass, true);
  assert.equal(V.validateArticle(o, replaceOnce(GOOD_C, '<h2>Should You Paint', '<p>' + yt + '</p>\n<h2>Should You Paint'), OPTS_C).pass, true);
  expectError(V.validateArticle(o, GOOD_C, OPTS_C), 'EMBED_URL_MISSING');
  expectError(V.validateArticle(o, replaceOnce(GOOD_C, '<p>Painting a room yourself is cheaper', '<p>Watch ' + yt + ' first. Painting a room yourself is cheaper'), OPTS_C), 'EMBED_URL_MISSING');
  const emb = '<!-- wp:embed {"url":"' + yt + '","type":"video","providerNameSlug":"youtube"} -->\n<figure class="wp-block-embed is-type-video is-provider-youtube wp-block-embed-youtube"><div class="wp-block-embed__wrapper">\n' + yt + '\n</div></figure>\n<!-- /wp:embed -->';
  expectError(V.validateArticle(insertBeforeSnippet(ORIG, emb), insertBeforeSnippet(GOOD, emb.replace('\n' + yt + '\n', '\nhttps://www.youtube.com/watch?v=OTHER\n')), OPTS), 'EMBED_URL_MISSING');
});

test('SHORTCODE_ADDED / PLACEHOLDER: new shortcodes and bracket or XX placeholders', () => {
  expectError(validate(insertBeforeSnippet(GOOD, para('[gallery]'))), 'SHORTCODE_ADDED');
  expectError(validate(insertBeforeSnippet(GOOD, para('[contact-form-7 id="12"]'))), 'SHORTCODE_ADDED');
  for (const t of ['Written by [Your Name], see [Source].', '[Image of a tyre gauge here]', 'A set costs about $XX per year.']) {
    expectError(validate(insertBeforeSnippet(GOOD, para(t))), 'PLACEHOLDER');
  }
});

test('LINK_ATTR_CHANGED: rel="nofollow sponsored" of an original (affiliate) link must stay', () => {
  const o = para('Buy the <a href="https://www.amazon.com/dp/B000TEST?tag=me-20" rel="nofollow sponsored noopener" target="_blank">gauge</a> today, it works well for most cars on the road.');
  expectError(V.validateArticle(o, o.replace(' rel="nofollow sponsored noopener"', ''), OPTS), 'LINK_ATTR_CHANGED');
  expectError(V.validateArticle(o, o.replace('nofollow sponsored noopener', 'noopener'), OPTS), 'LINK_ATTR_CHANGED');
  assert.equal(V.validateArticle(o, o.replace('nofollow sponsored noopener', 'sponsored nofollow noreferrer'), OPTS).pass, true);
  // the same URL linked once with and once without rel in the original: nothing required
  const o2 = o + '\n' + para('Or see <a href="https://www.amazon.com/dp/B000TEST?tag=me-20">the listing</a> for the current price today.');
  assert.equal(V.validateArticle(o2, o2.replace(' rel="nofollow sponsored noopener"', ''), OPTS).pass, true);
});

test('IMG_COUNT / IMG_CHANGED: data-URI images over 10 KB are seen (removed or corrupted)', () => {
  const b64 = 'iVBORw0KGgo'.repeat(1500);
  const img = '<!-- wp:html -->\n<p><img src="data:image/png;base64,' + b64 + '" alt="chart" width="600" height="300"></p>\n<!-- /wp:html -->';
  const o = replaceOnce(ORIG, '<!-- wp:more -->', img + '\n\n<!-- wp:more -->');
  const e = replaceOnce(GOOD, '<!-- wp:more -->', img + '\n\n<!-- wp:more -->');
  assert.equal(V.validateArticle(o, e, OPTS).pass, true);
  assert.equal(V.validateArticle(o, e, OPTS).stats.imagesOriginal, 3);
  expectError(V.validateArticle(o, GOOD, OPTS), 'IMG_COUNT');
  expectError(V.validateArticle(o, e.replace(b64, b64.slice(0, 12000) + 'XXXX'), OPTS), 'IMG_CHANGED');
  // an <img> tag broken by an unclosed quote (not parsed as a tag) still counts
  expectError(V.validateArticle(o, e + '\n<img src="https://evil.test/x.jpg', OPTS), 'IMG_COUNT');
});

test('IMG_CHANGED: an image moved into another section (order kept) is caught', () => {
  const s = GOOD.indexOf('<!-- wp:image {"id":101');
  const e = GOOD.indexOf('<!-- /wp:image -->', s) + '<!-- /wp:image -->'.length;
  const block = GOOD.slice(s, e);
  const moved = replaceOnce(GOOD.slice(0, s) + GOOD.slice(e), '<!-- wp:list -->', block + '\n\n<!-- wp:list -->');
  const r = validate(moved);
  expectError(r, 'IMG_CHANGED');
  assert.ok(r.errors.some((x) => /moved to another section/.test(x.message)));
});

test('CRLF originals: a Windows-saved original compares equal to the model\'s LF output', async () => {
  const o = replaceOnce(ORIG_C, '<h2>What Affects the Cost</h2>', '<script>\n  (adsbygoogle = window.adsbygoogle || []).push({});\n</script>\n<h2>What Affects the Cost</h2>').replace(/\n/g, '\r\n');
  const e = replaceOnce(GOOD_C, '<h2>What Affects the Cost of Painting a Room?</h2>', '<script>\n  (adsbygoogle = window.adsbygoogle || []).push({});\n</script>\n<h2>What Affects the Cost of Painting a Room?</h2>');
  const r = V.validateArticle(o, e, OPTS_C);
  assert.equal(r.pass, true, JSON.stringify(r.errors));
  const ob = replaceOnce(ORIG, 'class="wp-block-rank-math-toc-block" id="rank-math-toc"', 'class="wp-block-rank-math-toc-block"\nid="rank-math-toc"').replace(/\n/g, '\r\n');
  const eb = replaceOnce(GOOD, 'class="wp-block-rank-math-toc-block" id="rank-math-toc"', 'class="wp-block-rank-math-toc-block"\nid="rank-math-toc"');
  const p = await V.processEditorOutput(ob, wrapOutput(eb), Object.assign({}, OPTS, NOFETCH));
  assert.equal(p.action, 'publish', JSON.stringify(p.errors));
  assert.ok(!p.html.includes('\r'));
});

test('sanitizeLinks never edits links inside scripts or JSON-LD (no false SCRIPT_CHANGED)', () => {
  const sc = '<!-- wp:html --><script>document.write(\'<a href="https://tubetyre.com/deal/">deal</a>\');</script><!-- /wp:html -->';
  const ld = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"HowTo","name":"x","step":[{"@type":"HowToStep","text":"See <a href=\\"/guide/\\">guide</a>"}]}</script>';
  for (const add of [sc, ld]) {
    const s = V.sanitizeLinks(ORIG + '\n' + add, GOOD + '\n' + add, OPTS, []);
    assert.deepEqual(s.removed, []);
    const r = V.validateArticle(ORIG + '\n' + add, s.html, OPTS);
    assert.equal(r.pass, true, JSON.stringify(r.errors));
  }
});

test('FIRST_ELEMENT: a Google-Docs <span> intro kept and reworded is fine; TITLE_IN_BODY sees bare and <strong> title lines', () => {
  const g = '<span style="font-weight: 400;">Painting a room is cheap and easy for most people with a free weekend.</span>\n\n<h2>Cost</h2>\nBody text about the cost of painting a room in most places.';
  assert.equal(V.validateArticle(g, g.replace('cheap and easy', 'cheap and simple'), OPTS_C).pass, true);
  const title = 'How Much Does It Cost to Paint a Room?';
  const opts = Object.assign({}, OPTS_C, { postTitle: title });
  expectError(V.validateArticle(ORIG_C, title + '\n\n' + ORIG_C, opts), 'TITLE_IN_BODY');
  expectError(V.validateArticle(ORIG_C, '<strong>' + title + '</strong>\n' + ORIG_C, opts), 'TITLE_IN_BODY');
  assert.equal(V.validateArticle(ORIG_C, ORIG_C, opts).pass, true);
});

test('Rule 5: FAQ schema next to a plugin FAQ, a second Sources list or a second Last checked line', () => {
  const Y = '<!-- wp:yoast/faq-block {"questions":[]} -->\n<div class="schema-faq wp-block-yoast-faq-block"></div>\n<!-- /wp:yoast/faq-block -->';
  const ld = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[]}</script>';
  expectError(V.validateArticle(ORIG + '\n' + Y, GOOD + '\n' + Y + '\n' + ld, OPTS), 'JSONLD_TYPE');
  expectError(validate(GOOD + '\n<!-- wp:heading -->\n<h2 class="wp-block-heading">Sources</h2>\n<!-- /wp:heading -->\n<!-- wp:html -->\n<ol><li><a href="https://www.nhtsa.gov/equipment/tires">NHTSA</a>: again</li></ol>\n<!-- /wp:html -->'), 'SECTION_DUPLICATED');
  const lc = (t) => para('<em>Last checked: 2026-09-26. ' + t + '</em>');
  expectError(validate(insertBeforeSnippet(insertBeforeSnippet(GOOD, lc('Dates verified.')), lc('Figures verified.')), { webSearchCount: 5 }), 'SECTION_DUPLICATED');
  // a question heading that mentions FAQ is not a second FAQ section
  const q = '<!-- wp:heading {"level":3} -->\n<h3 class="wp-block-heading">What is a FAQ page?</h3>\n<!-- /wp:heading -->\n' + para('A page that answers common questions about one topic.');
  assert.ok(!codes(validate(insertBeforeSnippet(insertBeforeSnippet(GOOD, NEW_FAQ), q)).errors).includes('SECTION_DUPLICATED'));
});

test('NEW_FAQ_NOT_ALLOWED: FAQ headings in other languages; an existing plain FAQ (any language) may be rebuilt', () => {
  const de = '<!-- wp:heading -->\n<h2 class="wp-block-heading">Häufig gestellte Fragen</h2>\n<!-- /wp:heading -->\n<!-- wp:heading {"level":3} -->\n<h3 class="wp-block-heading">Wie oft?</h3>\n<!-- /wp:heading -->\n' + para('Einmal im Monat.');
  expectError(validate(insertBeforeSnippet(GOOD, de), { allowNewFaq: false }), 'NEW_FAQ_NOT_ALLOWED');
  const q = (n) => '<h3>Hur länge håller däck?</h3><p>' + uniqueWords(n, 'x') + '</p>';
  const o = '<p>' + uniqueWords(60, 'a') + '</p><h2>Vanliga frågor</h2>' + q(20);
  const e = '<p>' + uniqueWords(60, 'a') + '</p><h2>Vanliga frågor</h2><details><summary>Hur länge håller däck?</summary><p>' + uniqueWords(20, 'x') + '</p></details>';
  const r = V.validateArticle(o, e, { siteDomains: ['a.se'], allowNewFaq: false });
  assert.equal(r.pass, true, JSON.stringify(r.errors));
});

test('LAST_CHECKED_WITHOUT_RESEARCH: translated Last checked line (today\'s date), "Updated ... verified" claims', () => {
  const opts = { webSearchCount: 0, today: '2026-09-27' };
  expectError(validate(insertBeforeSnippet(GOOD, para('<em>Zuletzt geprüft: 27.09.2026.</em>')), opts), 'LAST_CHECKED_WITHOUT_RESEARCH');
  expectError(validate(insertBeforeSnippet(GOOD, para('<em>Last reviewed September 27, 2026.</em>')), opts), 'LAST_CHECKED_WITHOUT_RESEARCH');
  expectError(V.validateArticle(ORIG_C, replaceOnce(GOOD_C, '<h2>How Much', '<p><em>Updated: September 2026. Prices verified.</em></p>\n<h2>How Much'), OPTS_C), 'LAST_CHECKED_WITHOUT_RESEARCH');
  // with research, these are not blocked by this rule
  assert.equal(validate(insertBeforeSnippet(GOOD, para('<em>Zuletzt geprüft: 27.09.2026.</em>')), { webSearchCount: 4, today: '2026-09-27' }).pass, true);
});

test('LAST_CHECKED_NOT_ALLOWED: "Last checked line: no" blocks a new or changed line even with research', () => {
  const line = para('<em>Last checked: 2026-09-26. Dates and figures were verified against official sources.</em>');
  const edited = replaceOnce(GOOD, QA_BOX_START, line + '\n\n' + QA_BOX_START);
  expectError(validate(edited, { webSearchCount: 8, lastCheckedLine: 'no' }), 'LAST_CHECKED_NOT_ALLOWED');
  assert.equal(validate(edited, { webSearchCount: 8, lastCheckedLine: 'auto' }).pass, true);
  const o = replaceOnce(ORIG, '<!-- wp:rank-math/toc-block', line + '\n\n<!-- wp:rank-math/toc-block');
  assert.equal(V.validateArticle(o, edited, Object.assign({}, OPTS, { webSearchCount: 8, lastCheckedLine: 'no' })).pass, true);
});

test('NEW_NUMBER_WITHOUT_RESEARCH / NUMBER_MISSING: without research no price, percentage or year is invented or dropped', () => {
  expectError(V.validateArticle(ORIG_C, replaceOnce(GOOD_C, 'Buy good paint, because', 'Budget paint costs $2 to $5 per square foot. Buy good paint, because'), OPTS_C), 'NEW_NUMBER_WITHOUT_RESEARCH');
  const changed = V.validateArticle(ORIG_C, replaceAll(GOOD_C, '$800', '$950'), OPTS_C);
  expectError(changed, 'NEW_NUMBER_WITHOUT_RESEARCH');
  expectError(changed, 'NUMBER_MISSING');
  expectError(V.validateArticle(ORIG_C, replaceOnce(GOOD_C, 'Cost to Paint a Room?</h2>', 'Cost to Paint a Room in 2026?</h2>'), OPTS_C), 'NEW_NUMBER_WITHOUT_RESEARCH');
  expectError(V.validateArticle(ORIG_C, replaceAll(GOOD_C, 'before 1978', 'long ago'), OPTS_C), 'NUMBER_MISSING');
  expectError(V.validateArticle(ORIG_C, replaceOnce(GOOD_C, 'often covers better.', 'often covers about 20% better.'), OPTS_C), 'NEW_NUMBER_WITHOUT_RESEARCH');
  // reformatting the original's own figures is fine
  const reformatted = replaceOnce(GOOD_C, 'charges $300 to $800 for the walls', 'charges $300-800 for the walls');
  assert.equal(V.validateArticle(ORIG_C, reformatted, OPTS_C).pass, true, JSON.stringify(V.validateArticle(ORIG_C, reformatted, OPTS_C).errors));
  // with research (or unknown) figures may change
  assert.ok(!codes(V.validateArticle(ORIG_C, replaceAll(GOOD_C, '$800', '$950'), { siteDomains: ['getcostidea.com'], webSearchCount: 6 }).errors).includes('NUMBER_MISSING'));
});

test('BLOCK_COMMENTS_IN_CLASSIC and BLOCK_MARKUP_MISMATCH', () => {
  expectError(V.validateArticle(ORIG_C, '<!-- wp:paragraph -->\n' + GOOD_C.replace('</p>', '</p>\n<!-- /wp:paragraph -->'), OPTS_C), 'BLOCK_COMMENTS_IN_CLASSIC');
  const h = '<!-- wp:heading -->\n<h2 class="wp-block-heading">How Often Should You Check Tyre Pressure?</h2>';
  expectError(validate(replaceOnce(GOOD, h, '<!-- wp:heading -->\n<h3 class="wp-block-heading">How Often Should You Check Tyre Pressure?</h3>')), 'BLOCK_MARKUP_MISMATCH');
  expectError(validate(replaceOnce(GOOD, h, '<!-- wp:heading {"level":3} -->\n<h2 class="wp-block-heading">How Often Should You Check Tyre Pressure?</h2>')), 'BLOCK_MARKUP_MISMATCH');
  expectError(validate(replaceOnce(GOOD, '<!-- wp:list {"ordered":true} -->', '<!-- wp:list -->')), 'BLOCK_MARKUP_MISMATCH');
  // a mismatch the original already had is not the editor's fault
  const o = replaceOnce(ORIG, '<!-- wp:list {"ordered":true} -->', '<!-- wp:list -->');
  const e = replaceOnce(GOOD, '<!-- wp:list {"ordered":true} -->', '<!-- wp:list -->');
  assert.ok(!codes(V.validateArticle(o, e, OPTS).errors).includes('BLOCK_MARKUP_MISMATCH'));
});

test('HEADING_ORDER is relative: a skipped level the original already had (custom box heading) is not a failure', () => {
  const box = '<div class="tip-box" style="border:1px solid #ccc;padding:12px;"><h4 class="tip-title">Tip</h4>Measure twice before you buy paint.</div>';
  const o = replaceOnce(ORIG_C, '<h2>How to Save Money</h2>', '<h2>How to Save Money</h2>\n' + box);
  const e = replaceOnce(GOOD_C, '<h2>How Can You Save Money on Painting a Room?</h2>', '<h2>How Can You Save Money on Painting a Room?</h2>\n' + box);
  const r = V.validateArticle(o, e, OPTS_C);
  assert.equal(r.pass, true, JSON.stringify(r.errors));
  // a new jump is still caught
  expectError(V.validateArticle(o, e.replace('<h4 class="tip-title">Tip</h4>', '<h4 class="tip-title">Quick tip</h4>'), OPTS_C), 'HEADING_ORDER');
});

test('DUPLICATE_CONTENT: a repeated bare-text (wpautop) paragraph in a classic article', () => {
  const p = 'Painting a room yourself is cheaper, but it takes time and some skill to get clean lines and an even finish. ' +
    'A professional painter works faster, brings the right tools and usually gives a better result, especially on ceilings and trim.';
  expectError(V.validateArticle(ORIG_C, replaceOnce(ORIG_C, p, p + '\n\n' + p), OPTS_C), 'DUPLICATE_CONTENT');
  assert.ok(!codes(V.validateArticle(ORIG_C, ORIG_C, OPTS_C).errors).includes('DUPLICATE_CONTENT'));
});

test('false fails fixed: Spanish "TODO", thin original expanded, uppercase TODO: still caught', () => {
  assert.equal(V.validateArticle('<p>Guía para pintar una habitación con poco dinero y buen resultado.</p>', '<p>TODO lo que necesitas saber para pintar una habitación con poco dinero y buen resultado.</p>', { siteDomains: ['a.es'] }).pass, true);
  const o = '<p>' + uniqueWords(60, 'w') + '</p>';
  const e = o + '<h2>More</h2><p>' + uniqueWords(300, 'z') + '</p>';
  assert.equal(V.validateArticle(o, e, { siteDomains: ['a.com'] }).pass, true);
  expectError(V.validateArticle(o, e + '<p>' + uniqueWords(400, 'q') + '</p>', { siteDomains: ['a.com'] }), 'WORD_RATIO_EXTREME');
});

test('mutation-test gaps: src-only / srcset-only image changes, uppercase tags, host forms, box style spacing, mixed JSON-LD type', () => {
  expectError(validate(replaceOnce(GOOD, 'src="https://tubetyre.com/wp-content/uploads/2024/05/door-sticker-800x600.jpg"', 'src="https://tubetyre.com/wp-content/uploads/2024/05/door-sticker-800x601.jpg"')), 'IMG_CHANGED');
  expectError(validate(replaceOnce(GOOD, 'tyre-pressure-gauge-300x200.jpg 300w', 'tyre-pressure-gauge-300x201.jpg 300w')), 'IMG_CHANGED');
  expectError(validate(insertBeforeSnippet(GOOD, '<H1>Title again</H1>')), 'FORBIDDEN_TAG');
  expectError(validate(insertBeforeSnippet(GOOD, '<!-- wp:html --><IMG SRC="https://tubetyre.com/x.jpg"><!-- /wp:html -->')), 'IMG_COUNT');
  expectError(validate(insertBeforeSnippet(GOOD, para('See <a href="//www.tubetyre.com/x">x</a>.'))), 'NEW_INTERNAL_LINK');
  expectError(validate(insertBeforeSnippet(GOOD, para('See <a href=https://TubeTyre.com/x>x</a>.'))), 'NEW_INTERNAL_LINK');
  expectError(V.validateArticle(ORIG, insertBeforeSnippet(GOOD, para('See <a href="https://tubetyre.com/x">x</a>.')), { siteDomains: ['www.tubetyre.com'] }), 'NEW_INTERNAL_LINK');
  expectError(validate(insertBeforeSnippet(GOOD, '<!-- wp:html --><div style="background: #EEF3FE ;padding:1px"><p>Quick Answer again</p></div><!-- /wp:html -->')), 'BOX_DUPLICATED');
  expectError(validate(GOOD + '<script type="application/ld+json">{"@type":["FAQPage","HowTo"]}</script>'), 'JSONLD_TYPE');
});

test('no false fails from the new text rules: normal sentences that look a bit like notes or chat', () => {
  const ok = (html, extra) => {
    const r = validate(insertBeforeSnippet(GOOD, html), extra);
    assert.equal(r.pass, true, html + ' => ' + JSON.stringify(r.errors));
  };
  ok(para('In the rest of this article, you will learn how to read the numbers on the sidewall and when to ask a tyre shop for help.'));
  ok(para('ChatGPT works as an AI assistant here, but it cannot see your tyres or read the gauge for you.'));
  ok(para('If a month has passed since you last checked the pressure, check it again before a long trip.'), { webSearchCount: 0 });
  ok(para('The content of the door sticker stays unchanged when you fit new tyres of the same size and load rating.'));
  // a fact the original states, reworded without research, keeps its year
  const o = insertBeforeSnippet(ORIG, para('In 2023 the rules for spare wheels changed for new cars sold in some countries.'));
  const e = insertBeforeSnippet(GOOD, para('The rules for spare wheels were updated in 2023 for new cars sold in some countries.'));
  const r = V.validateArticle(o, e, Object.assign({}, OPTS, { webSearchCount: 0 }));
  assert.equal(r.pass, true, JSON.stringify(r.errors));
});

// ---------------------------------------------------------------------------------------------
// browser extension Safety Gate (v1.2.0): end marker, tables/lists, classic conversion,
// webSearchAllowed, researchRules (v1.3.0), runSafetyGate, self.SafetyGate
// ---------------------------------------------------------------------------------------------
const GATE = { siteDomains: ['tubetyre.com'], endMarker: 'APU-END', requireEndMarker: true };
const END = '<!-- APU-END -->';
const TABLE_BLOCK = '<!-- wp:table -->\n<figure class="wp-block-table"><table><thead><tr><th>Tyre type</th><th>Typical pressure</th></tr></thead>' +
  '<tbody><tr><td>Small car</td><td>30 to 32 psi</td></tr><tr><td>Family car</td><td>32 to 35 psi</td></tr></tbody></table></figure>\n<!-- /wp:table -->';
const T_ORIG = insertBeforeSnippet(ORIG, TABLE_BLOCK);
const T_GOOD = insertBeforeSnippet(GOOD, TABLE_BLOCK);
const stripBlockComments = (h) => h.replace(/<!--\s*\/?wp:[\s\S]*?-->\n?/g, '');
const withoutPluginBlocks = (h) => h.replace(/<!-- wp:rank-math\/toc-block[\s\S]*?<!-- \/wp:rank-math\/toc-block -->\n?/, '')
  .replace(/<!-- wp:rank-math\/rich-snippet[^>]*\/-->\n?/, '');

test('stripEndMarkers: every <!-- APU-END --> form is removed; own-line markers with their line, inline ones alone', () => {
  assert.equal(V.stripEndMarkers('<p>a</p>\n<!-- APU-END -->\n'), '<p>a</p>\n');
  assert.equal(V.stripEndMarkers('<p>a</p>\n  <!--apu-end-->  \r\n<p>b</p>'), '<p>a</p>\n<p>b</p>');
  assert.equal(V.stripEndMarkers('<p>a</p>\n<!--   APU-END   -->'), '<p>a</p>\n');
  assert.equal(V.stripEndMarkers('<p>a</p><!-- APU-END --><p>b</p>\n\n<p>c</p>'), '<p>a</p><p>b</p>\n\n<p>c</p>');
  assert.equal(V.stripEndMarkers('<p>a</p>\n' + END + '\n<p>b</p>\n' + END), '<p>a</p>\n<p>b</p>\n');
  assert.equal(V.stripEndMarkers('<p>a</p>\n<!-- END-X -->\n', 'END-X'), '<p>a</p>\n');
  // not a marker: other comments, escaped text, a similar name
  const keep = '<p>&lt;!-- APU-END --&gt;</p>\n<!-- APU-ENDING -->\n<!-- more -->';
  assert.equal(V.stripEndMarkers(keep), keep);
  assert.equal(V.stripEndMarkers(''), '');
  assert.equal(V.stripEndMarkers(null), '');
});

test('END_MARKER_MISSING: a required end marker must be there (truncated reply); the marker itself is not compared', () => {
  const r = validate(GOOD + '\n' + END + '\n', GATE);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []); // no NEW_HTML_COMMENT for the marker
  assert.equal(validate(GOOD + '\n<!--apu-end-->', GATE).pass, true);
  expectError(validate(GOOD, GATE), 'END_MARKER_MISSING');
  const cut = GOOD.slice(0, Math.floor(GOOD.length * 0.6));
  expectError(validate(cut, GATE), 'END_MARKER_MISSING');
  assert.equal(validate(GOOD, GATE).errors[0].code, 'END_MARKER_MISSING');
  // not required: no error; requireEndMarker without endMarker uses the default APU-END
  assert.equal(validate(GOOD, { endMarker: 'APU-END' }).pass, true);
  assert.equal(validate(GOOD + '\n' + END, { endMarker: 'APU-END' }).pass, true);
  expectError(validate(GOOD, { requireEndMarker: true }), 'END_MARKER_MISSING');
  assert.equal(validate(GOOD + '\n' + END, { requireEndMarker: true }).pass, true);
  // requireEndMarker must be exactly true
  assert.equal(validate(GOOD, { endMarker: 'APU-END', requireEndMarker: 'yes' }).pass, true);
  // without endMarker options the marker is just a new comment (old behaviour)
  expectWarning(validate(GOOD + '\n' + END), 'NEW_HTML_COMMENT');
});

test('TABLE_LOSS (hard): a table or a table row removed; LIST_LOSS (warning): more than 30% of list items gone', () => {
  assert.deepEqual(V.validateArticle(T_ORIG, T_GOOD, OPTS).errors, []);
  const oneRowLess = replaceOnce(T_GOOD, '<tr><td>Family car</td><td>32 to 35 psi</td></tr>', '');
  expectError(V.validateArticle(T_ORIG, oneRowLess, OPTS), 'TABLE_LOSS');
  expectError(V.validateArticle(T_ORIG, replaceOnce(T_GOOD, TABLE_BLOCK, ''), OPTS), 'TABLE_LOSS');
  // the table turned into a list: rows are gone
  const asList = replaceOnce(T_GOOD, TABLE_BLOCK, '<!-- wp:list -->\n<ul class="wp-block-list"><li>Small car: 30 to 32 psi</li><li>Family car: 32 to 35 psi</li></ul>\n<!-- /wp:list -->');
  expectError(V.validateArticle(T_ORIG, asList, OPTS), 'TABLE_LOSS');
  // an added row is fine
  const moreRows = replaceOnce(T_GOOD, '</tbody>', '<tr><td>SUV</td><td>35 to 38 psi</td></tr></tbody>');
  assert.equal(V.validateArticle(T_ORIG, moreRows, OPTS).pass, true);

  const listO = '<p>Here is what you need to check tyre pressure at home today.</p><ul><li>A gauge</li><li>A pump</li><li>The door sticker</li><li>Five minutes</li></ul>';
  const r = V.validateArticle(listO, replaceOnce(listO, '<li>The door sticker</li><li>Five minutes</li>', ''), OPTS);
  expectWarning(r, 'LIST_LOSS');
  assert.ok(!codes(r.errors).includes('LIST_LOSS'));
  // one of four gone (25%) is not reported
  const r2 = V.validateArticle(listO, replaceOnce(listO, '<li>Five minutes</li>', ''), OPTS);
  assert.ok(!codes(r2.warnings).includes('LIST_LOSS'));
});

test('CLASSIC_CONVERSION (warning): an edit with no block comments at all skips the media-block checks; plugin blocks stay hard', () => {
  // plugin-free pair: the stripped edit passes with only the warning
  const o = withoutPluginBlocks(ORIG);
  const e = withoutPluginBlocks(GOOD);
  assert.deepEqual(V.validateArticle(o, e, OPTS).errors, []);
  const r = V.validateArticle(o, stripBlockComments(e), OPTS);
  assert.deepEqual(r.errors, []);
  expectWarning(r, 'CLASSIC_CONVERSION');
  // with plugin blocks in the original: PLUGIN_BLOCK_CHANGED is still a hard error, no MEDIA_BLOCK_CHANGED / BLOCK_UNBALANCED
  const r2 = validate(stripBlockComments(GOOD));
  expectError(r2, 'PLUGIN_BLOCK_CHANGED');
  expectWarning(r2, 'CLASSIC_CONVERSION');
  assert.ok(!codes(r2.errors).includes('MEDIA_BLOCK_CHANGED'));
  assert.ok(!codes(r2.errors).includes('BLOCK_UNBALANCED'));
  // only SOME block comments removed: the media-block check still applies, no classic-conversion warning
  const partial = replaceOnce(e, '<!-- wp:image {"id":101,"sizeSlug":"large","linkDestination":"none"} -->\n', '');
  const r3 = V.validateArticle(o, partial, OPTS);
  expectError(r3, 'MEDIA_BLOCK_CHANGED');
  assert.ok(!codes(r3.warnings).includes('CLASSIC_CONVERSION'));
  // a classic original stays classic: no warning
  assert.ok(!codes(V.validateArticle(ORIG_C, GOOD_C, OPTS_C).warnings).includes('CLASSIC_CONVERSION'));
  // image checks are not relaxed by the conversion
  expectError(V.validateArticle(o, stripBlockComments(replaceOnce(e, 'height="', 'height="1')), OPTS), 'IMG_CHANGED');
});

test('webSearchAllowed: false = no research (like webSearchCount 0, and it wins); true = unknown or some research', () => {
  const n = V._internal.normalizeOptions;
  assert.equal(n({ webSearchAllowed: false }).webSearchCount, 0);
  assert.equal(n({ webSearchAllowed: 'no' }).webSearchCount, 0);
  assert.equal(n({ webSearchAllowed: false, webSearchCount: 4 }).webSearchCount, 0);
  assert.equal(n({ webSearchAllowed: true }).webSearchCount, null);
  assert.equal(n({ webSearchAllowed: true, webSearchCount: 3 }).webSearchCount, 3);
  assert.equal(n({ webSearchAllowed: true, webSearchCount: 0 }).webSearchCount, 0);
  assert.equal(n({}).webSearchCount, null);
  // Last checked line and new figures
  const line = para('<em>Last checked: 2026-09-26. Dates and figures were verified against official sources.</em>');
  const edited = replaceOnce(GOOD, QA_BOX_START, line + '\n\n' + QA_BOX_START);
  expectError(validate(edited, { webSearchAllowed: false }), 'LAST_CHECKED_WITHOUT_RESEARCH');
  assert.equal(validate(edited, { webSearchAllowed: true }).pass, true);
  const priced = insertBeforeSnippet(GOOD, para('A digital gauge costs about $25 in 2026 and lasts for years if you store it well.'));
  expectError(validate(priced, { webSearchAllowed: false }), 'NEW_NUMBER_WITHOUT_RESEARCH');
  assert.equal(validate(priced, { webSearchAllowed: true }).pass, true);
  // links: deep links unwrapped, homepages kept
  const e = sEdited('<a href="https://www.who.int/news/item/1">deep</a>, <a href="https://www.who.int/">home</a>.');
  const s = V.sanitizeLinks(S_ORIG, e, { webSearchAllowed: false });
  assert.ok(s.html.includes('deep, <a href="https://www.who.int/">home</a>.'));
  assert.deepEqual(s.removed.map((x) => x.reason), ['deep_link_without_research']);
  assert.equal(V.sanitizeLinks(S_ORIG, e, { webSearchAllowed: true }).removed.length, 0);
});

test('researchRules false (a prompt not written for the Safety Gate): the no-research rules are off, every other rule stays', async () => {
  const n = V._internal.normalizeOptions;
  assert.equal(n({}).researchRules, true);
  assert.equal(n({ researchRules: true }).researchRules, true);
  assert.equal(n({ researchRules: 'yes' }).researchRules, true);
  assert.equal(n({ researchRules: false }).researchRules, false);
  assert.equal(n({ researchRules: 'off' }).researchRules, false);
  // the web-search setting itself is unchanged by it
  assert.equal(n({ webSearchAllowed: false, researchRules: false }).webSearchCount, 0);
  const NO = { webSearchAllowed: false, today: '2026-09-27' };
  const LEGACY = Object.assign({}, NO, { researchRules: false });
  // "Last updated" line with today's date and an "updated"/"verified" claim
  const line = para('<em>Last updated: 2026-09-27. Prices were verified against the maker\'s shop.</em>');
  const dated = replaceOnce(GOOD, QA_BOX_START, line + '\n\n' + QA_BOX_START);
  expectError(validate(dated, NO), 'LAST_CHECKED_WITHOUT_RESEARCH');
  expectError(validate(dated, Object.assign({}, LEGACY, { researchRules: true })), 'LAST_CHECKED_WITHOUT_RESEARCH');
  assert.deepEqual(validate(dated, LEGACY).errors, []);
  // prices, percentages and years: added, changed and removed
  const OC = { siteDomains: ['getcostidea.com'], webSearchAllowed: false };
  const OC_LEGACY = Object.assign({}, OC, { researchRules: false });
  const changed = replaceAll(GOOD_C, '$800', '$950');
  const r0 = V.validateArticle(ORIG_C, changed, OC);
  expectError(r0, 'NEW_NUMBER_WITHOUT_RESEARCH');
  expectError(r0, 'NUMBER_MISSING');
  assert.deepEqual(V.validateArticle(ORIG_C, changed, OC_LEGACY).errors, []);
  const noPrice = replaceAll(GOOD_C, 'before 1978', 'long ago');
  expectError(V.validateArticle(ORIG_C, noPrice, OC), 'NUMBER_MISSING');
  assert.deepEqual(V.validateArticle(ORIG_C, noPrice, OC_LEGACY).errors, []);
  const priced = insertBeforeSnippet(GOOD, para('A digital gauge costs about $25 in 2026 and lasts 20% longer if you store it well.'));
  expectError(validate(priced, NO), 'NEW_NUMBER_WITHOUT_RESEARCH');
  assert.deepEqual(validate(priced, LEGACY).errors, []);
  // new links: a deep link is no longer unwrapped just for lack of research; bad links still are
  const e = sEdited('<a href="https://www.who.int/news/item/1">deep</a>, <a href="https://www.who.int/">home</a>, ' +
    '<a href="https://www.pinterest.com/pin/1/">pin</a>, <a href="https://tubetyre.com/new-page/">internal</a>, ' +
    '<a href="javascript:alert(1)">script</a>, <a href="https://bit.ly/abc">short</a>, <a href="https://www.who.int/gone">gone</a>.');
  const sOn = V.sanitizeLinks(S_ORIG, e, { siteDomains: ['tubetyre.com'], webSearchAllowed: false }, ['https://www.who.int/gone']);
  assert.deepEqual(sOn.removed.map((x) => x.reason).sort(),
    ['dead', 'deep_link_without_research', 'forbidden_domain', 'internal', 'javascript', 'redirect']);
  const sOff = V.sanitizeLinks(S_ORIG, e, { siteDomains: ['tubetyre.com'], webSearchAllowed: false, researchRules: false }, ['https://www.who.int/gone']);
  assert.deepEqual(sOff.removed.map((x) => x.reason).sort(), ['dead', 'forbidden_domain', 'internal', 'javascript', 'redirect']);
  assert.ok(sOff.html.includes('<a href="https://www.who.int/news/item/1">deep</a>, <a href="https://www.who.int/">home</a>, pin, internal, script, short, gone.'));
  // validateArticle (defence in depth) agrees: a new deep link is a BAD_NEW_LINK only with the rules on
  const withDeep = insertBeforeSnippet(GOOD, para('See <a href="https://www.who.int/news/item/1">the WHO note</a> for more.'));
  expectError(validate(withDeep, NO), 'BAD_NEW_LINK');
  assert.deepEqual(validate(withDeep, LEGACY).errors, []);
  expectError(validate(insertBeforeSnippet(GOOD, para('See <a href="https://tubetyre.com/new-page/">our page</a>.')), LEGACY), 'NEW_INTERNAL_LINK');
  expectError(validate(insertBeforeSnippet(GOOD, para('See <a href="https://www.reddit.com/r/cars/">the forum</a>.')), LEGACY), 'BAD_NEW_LINK');
  // structure rules are untouched
  expectError(validate(replaceOnce(dated, '<img', '<span'), LEGACY), 'IMG_COUNT');
  expectError(validate(replaceAll(dated, 'https://www.nhtsa.gov/equipment/tires', 'https://www.nhtsa.gov/equipment/tyres'), LEGACY), 'LINK_MISSING');
});

test('runSafetyGate with researchRules false: the new deep link is link-checked (alive = kept, dead / unverified = unwrapped); minRetention can be lowered', async () => {
  const LEG = { siteDomains: ['tubetyre.com'], allowNewFaq: true, webSearchAllowed: false, researchRules: false, checkLinks: true,
    endMarker: 'APU-END', requireEndMarker: false, today: '2026-09-27' };
  const DEEP = 'https://www.who.int/news/item/tyres';
  const edit = insertBeforeSnippet(replaceOnce(GOOD, QA_BOX_START, para('<em>Last updated: 2026-09-27</em>') + '\n\n' + QA_BOX_START),
    para('A digital gauge costs about $25. See <a href="' + DEEP + '">the WHO note</a> for more.'));
  const calls = [];
  let r = await V.runSafetyGate(ORIG, edit, Object.assign({}, LEG, { fetchFn: makeFetch({}, calls) }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.html.includes('<a href="' + DEEP + '">the WHO note</a>'));
  assert.deepEqual(r.removedLinks, []);
  assert.ok(calls.some((c) => c[1] === DEEP), 'the deep link was really checked');
  r = await V.runSafetyGate(ORIG, edit, Object.assign({}, LEG, { fetchFn: makeFetch({ [DEEP]: () => ({ status: 404 }) }) }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.removedLinks.map((x) => x.reason), ['dead']);
  assert.ok(r.html.includes('See the WHO note for more.'));
  r = await V.runSafetyGate(ORIG, edit, Object.assign({}, LEG, { fetchFn: makeFetch({ [DEEP]: () => ({ status: 403 }) }) }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.removedLinks.map((x) => x.reason), ['unverified']);
  // the default (full rules) blocks the same edit and unwraps the deep link without checking it
  const calls2 = [];
  r = await V.runSafetyGate(ORIG, edit, Object.assign({}, LEG, { researchRules: true, fetchFn: makeFetch({}, calls2) }));
  expectError(r, 'LAST_CHECKED_WITHOUT_RESEARCH');
  expectError(r, 'NEW_NUMBER_WITHOUT_RESEARCH');
  assert.deepEqual(r.removedLinks.map((x) => x.reason), ['deep_link_without_research']);
  assert.ok(!calls2.some((c) => c[1] === DEEP));
  // a lost image still blocks
  r = await V.runSafetyGate(ORIG, replaceOnce(edit, '<img', '<span'), Object.assign({}, LEG, NOFETCH));
  expectError(r, 'IMG_COUNT');
  // minRetention: the caller's value replaces the default 0.75 (lower = more rewriting allowed)
  let h = dropSection(GOOD, 'What Are the Most Common Mistakes?');
  h = dropSection(h, 'Where Do You Find the Right Tyre Pressure?');
  h = insertBeforeSnippet(h, para('Our guide on <a href="https://tubetyre.com/tyre-sidewall-markings/">sidewall markings</a> helps. ' + uniqueWords(160, 'pad')));
  const ret = validate(h).stats.wordRetention;
  assert.ok(ret < 0.75 && ret > 0.3, 'retention ' + ret);
  expectError(validate(h, { minRetention: 0.75 }), 'CONTENT_RETENTION');
  assert.ok(!codes(validate(h, { minRetention: Math.floor(ret * 100) / 100 - 0.01 }).errors).includes('CONTENT_RETENTION'));
  assert.equal(V._internal.normalizeOptions({}).minRetention, 0.75);
  assert.equal(V._internal.normalizeOptions({ minRetention: 0.6 }).minRetention, 0.6);
  assert.equal(V._internal.normalizeOptions({ minRetention: undefined }).minRetention, 0.75);
});

test('runSafetyGate: a good edit with the end marker => ok, marker-free sanitized html, link checked', async () => {
  const calls = [];
  const r = await V.runSafetyGate(ORIG, GOOD + '\n' + END + '\n', Object.assign({}, GATE, { fetchFn: makeFetch({}, calls) }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(Object.keys(r).filter((k) => ['ok', 'html', 'errors', 'warnings', 'removedLinks', 'linkResults', 'stats'].includes(k)).sort(),
    ['errors', 'html', 'linkResults', 'ok', 'removedLinks', 'stats', 'warnings']);
  assert.equal(r.html, GOOD + '\n');
  assert.ok(!/APU-END/i.test(r.html));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.removedLinks, []);
  assert.deepEqual(r.linkResults.map((x) => [x.url, x.verdict]), [['https://www.tyresafe.org/', 'ok']]);
  assert.deepEqual(calls, [['HEAD', 'https://www.tyresafe.org/']]);
  assert.equal(r.stats.endMarkerFound, true);
  assert.equal(r.stats.images, 2);
  assert.equal(r.changed, true);
  // CRLF reply and a marker left in the reference by an earlier run
  const r2 = await V.runSafetyGate(ORIG + '\n' + END + '\n', (GOOD + '\n' + END).replace(/\n/g, '\r\n'), Object.assign({}, GATE, NOFETCH));
  assert.equal(r2.ok, true, JSON.stringify(r2.errors));
  assert.equal(r2.html, GOOD + '\n');
  // the extension's real call shape (browser mode): webSearchAllowed false keeps the homepage link
  const r3 = await V.runSafetyGate(ORIG, GOOD + '\n' + END, { siteDomains: ['tubetyre.com'], allowNewFaq: true, webSearchAllowed: false,
    checkLinks: true, endMarker: 'APU-END', requireEndMarker: true, fetchFn: makeFetch({}) });
  assert.equal(r3.ok, true, JSON.stringify(r3.errors));
  assert.ok(r3.html.includes('https://www.tyresafe.org/'));
});

test('runSafetyGate: dead, unverified and no-research links are unwrapped; the result is still ok', async () => {
  let r = await V.runSafetyGate(ORIG, GOOD + '\n' + END, Object.assign({}, GATE, { fetchFn: makeFetch({ 'https://www.tyresafe.org/': () => ({ status: 404 }) }) }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(!r.html.includes('tyresafe.org'));
  assert.deepEqual(r.removedLinks.map((x) => [x.url, x.reason]), [['https://www.tyresafe.org/', 'dead'], ['https://www.tyresafe.org/', 'dead']]);
  const deep = insertBeforeSnippet(GOOD, para('See <a href="https://www.who.int/invented/page">the WHO page</a> for more.')) + '\n' + END;
  r = await V.runSafetyGate(ORIG, deep, Object.assign({}, GATE, { fetchFn: makeFetch({ 'https://www.who.int/invented/page': () => ({ status: 403 }) }) }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(r.html.includes('See the WHO page for more.'));
  assert.deepEqual(r.removedLinks.map((x) => x.reason), ['unverified']);
  const calls = [];
  r = await V.runSafetyGate(ORIG, deep, Object.assign({}, GATE, { webSearchAllowed: false, fetchFn: makeFetch({}, calls) }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.removedLinks.map((x) => x.reason), ['deep_link_without_research']);
  assert.deepEqual(calls, [['HEAD', 'https://www.tyresafe.org/']]); // the deep link is not even fetched
  // checkLinks false: nothing is fetched
  const none = [];
  r = await V.runSafetyGate(ORIG, deep, Object.assign({}, GATE, { checkLinks: false, fetchFn: makeFetch({}, none) }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(none, []);
  assert.deepEqual(r.linkResults, []);
  // tracking parameters are removed from new links
  r = await V.runSafetyGate(ORIG, replaceAll(GOOD, 'https://www.tyresafe.org/', 'https://www.tyresafe.org/?utm_source=chatgpt.com') + '\n' + END,
    Object.assign({}, GATE, { fetchFn: makeFetch({}) }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.ok(!r.html.includes('utm_source'));
  assert.equal(r.changedLinks.length, 2);
});

test('runSafetyGate: bad edits fail closed (html = reference, candidateHtml = the rejected edit); never throws', async () => {
  const noImg = replaceOnce(GOOD, '<img', '<span') + '\n' + END;
  let r = await V.runSafetyGate(ORIG, noImg, Object.assign({}, GATE, NOFETCH));
  expectError(r, 'IMG_COUNT');
  assert.equal(r.ok, false);
  assert.equal(r.html, ORIG);
  assert.ok(r.candidateHtml.includes('<span'));
  assert.ok(r.errors.every((e) => typeof e.code === 'string' && typeof e.message === 'string'));
  // truncated: no end marker (first error)
  r = await V.runSafetyGate(ORIG, GOOD.slice(0, Math.floor(GOOD.length * 0.6)), Object.assign({}, GATE, NOFETCH));
  expectError(r, 'END_MARKER_MISSING');
  assert.equal(r.errors[0].code, 'END_MARKER_MISSING');
  assert.equal(r.stats.endMarkerFound, false);
  // only the marker is missing: still blocked
  r = await V.runSafetyGate(ORIG, GOOD, Object.assign({}, GATE, NOFETCH));
  assert.deepEqual(codes(r.errors), ['END_MARKER_MISSING']);
  assert.equal(r.ok, false);
  assert.equal(r.html, ORIG);
  assert.equal(r.candidateHtml, GOOD);
  // a table row lost
  r = await V.runSafetyGate(T_ORIG, replaceOnce(T_GOOD, '<tr><td>Small car</td><td>30 to 32 psi</td></tr>', '') + '\n' + END, Object.assign({}, GATE, NOFETCH));
  expectError(r, 'TABLE_LOSS');
  // empty edit, or just the marker
  r = await V.runSafetyGate(ORIG, '  \n' + END + '\n', Object.assign({}, GATE, NOFETCH));
  expectError(r, 'PARSE_EMPTY_HTML');
  r = await V.runSafetyGate(ORIG, undefined, Object.assign({}, GATE, NOFETCH));
  expectError(r, 'PARSE_EMPTY_HTML');
  // no own-site domain and nothing to infer it from
  r = await V.runSafetyGate(S_ORIG, S_ORIG + '\n' + para('More text.'), NOFETCH);
  expectError(r, 'CONFIG_MISSING');
  // inferred from upload URLs: warning, still ok
  r = await V.runSafetyGate(ORIG, GOOD, NOFETCH);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  expectWarning(r, 'SITE_DOMAINS_INFERRED');
  // anything that throws inside => INTERNAL_ERROR, the reference is returned
  const boom = { get siteDomains() { throw new Error('boom'); } };
  r = await V.runSafetyGate(ORIG, GOOD, boom);
  expectError(r, 'INTERNAL_ERROR');
  assert.equal(r.html, ORIG);
  const bad = await V.runSafetyGate(ORIG, GOOD + '\n' + END, Object.assign({}, GATE, { fetchFn: () => { throw new Error('network down'); } }));
  assert.equal(bad.ok, true, JSON.stringify(bad.errors)); // a homepage link that could not be checked is kept
  expectWarning(bad, 'LINK_CHECK_INCONCLUSIVE');
});

test('filterAuditIssues accepts the extension fact-check reply contract (```json block, verdict + issues)', () => {
  const reply = 'Summary line.\n```json\n' + JSON.stringify({ verdict: 'fix', issues: [
    { severity: 'high', category: 'new_claim_unverified', quote: 'Most cars need between 30 and 35 psi', problem: 'Changed range.', fix: 'Keep the original range.' },
    { severity: 'medium', category: 'info_lost', quote: 'this sentence is not in the article at all anywhere', problem: 'p', fix: 'f' },
    { severity: 'low', category: 'off_topic', quote: 'before you drive', problem: 'p', fix: 'f' }
  ] }) + '\n```';
  const r = V.filterAuditIssues(AUDIT_HTML, reply);
  assert.equal(r.valid, true);
  assert.equal(r.verdict, 'fix');
  assert.equal(r.effectiveVerdict, 'fix');
  assert.deepEqual(r.issues.map((i) => i.severity), ['high', 'low']);
  assert.equal(r.dropped.length, 1);
  assert.deepEqual(r.retryIssues.map((i) => i.severity), ['high', 'low']);
  assert.equal(r.retryIssues[0].fix, 'Keep the original range.');
  // "fix" with only medium/low issues left is a pass (the contract: fix = at least one high issue)
  const r2 = V.filterAuditIssues(AUDIT_HTML, { verdict: 'fix', issues: [{ severity: 'medium', category: 'x', quote: 'before you drive', problem: 'p', fix: 'f' }] });
  assert.equal(r2.effectiveVerdict, 'pass');
  // "PASS" in capitals, missing issues
  assert.equal(V.filterAuditIssues(AUDIT_HTML, { verdict: 'PASS' }).effectiveVerdict, 'pass');
  assert.equal(V.filterAuditIssues(AUDIT_HTML, { verdict: 'maybe', issues: [] }).effectiveVerdict, 'reject');
});

test('browser build: the file loaded as a classic worker script exposes self.SafetyGate; require() adds no global', async () => {
  const vm = require('node:vm');
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const ctx = { console, setTimeout, clearTimeout, AbortController, Promise };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: 'safety-gate.js' });
  const G = ctx.SafetyGate;
  assert.ok(G && typeof G === 'object');
  assert.deepEqual(Object.keys(G).sort(), ['ERROR_CODES', 'VERSION', 'WARNING_CODES', 'checkLinks', 'filterAuditIssues', 'findNewLinks',
    'runSafetyGate', 'sanitizeLinks', 'stripEndMarkers', 'validateArticle'].sort());
  assert.equal(G.VERSION, V.VERSION);
  assert.ok(G.ERROR_CODES.includes('END_MARKER_MISSING') && G.ERROR_CODES.includes('TABLE_LOSS'));
  assert.ok(G.WARNING_CODES.includes('LIST_LOSS') && G.WARNING_CODES.includes('CLASSIC_CONVERSION'));
  const r = await G.runSafetyGate(ORIG, GOOD + '\n' + END, Object.assign({}, GATE, { fetchFn: makeFetch({}) }));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.html, GOOD + '\n');
  // Node: module.exports only
  const out = spawnSync(process.execPath, ['-e', 'const V=require(' + JSON.stringify(SCRIPT) + ');' +
    'console.log(typeof globalThis.SafetyGate, typeof V.runSafetyGate, typeof V.stripEndMarkers)'], { encoding: 'utf8' });
  assert.equal(out.stdout.trim(), 'undefined function function');
});

test('extension/safety-gate.js is a byte-identical copy of this file (when the extension is next to it)', (t) => {
  const copy = path.join(__dirname, '..', '..', 'extension', 'safety-gate.js');
  if (!fs.existsSync(copy)) { t.skip('no extension folder'); return; }
  assert.ok(fs.readFileSync(copy).equals(fs.readFileSync(SCRIPT)), 'extension/safety-gate.js differs from automation/validate-article.js');
});

test('n8n paste: runSafetyGate and stripEndMarkers also work as a plain function body', async () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const fn = new Function(src + '\nreturn { runSafetyGate, stripEndMarkers };');
  const api = fn();
  assert.equal(api.stripEndMarkers('<p>a</p>\n' + END), '<p>a</p>\n');
  const r = await api.runSafetyGate(ORIG, GOOD + '\n' + END, Object.assign({}, GATE, NOFETCH));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
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

test('performance: 1 MB article validated within 2 seconds', async () => {
  const o = bigArticle(ORIG, 1024 * 1024);
  const e = bigArticle(GOOD, 1024 * 1024);
  assert.ok(o.length >= 1024 * 1024 && e.length >= 1024 * 1024);
  const t0 = process.hrtime.bigint();
  const r = V.validateArticle(o, e, OPTS);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const t1 = process.hrtime.bigint();
  const p = await V.processEditorOutput(o, wrapOutput(e), Object.assign({}, OPTS, { checkLinks: false }));
  const ms2 = Number(process.hrtime.bigint() - t1) / 1e6;
  console.log('# validateArticle on ' + Math.round(e.length / 1024) + ' KB: ' + ms.toFixed(1) + ' ms; processEditorOutput: ' + ms2.toFixed(1) + ' ms');
  assert.ok(ms < 2000, 'took ' + ms + ' ms');
  assert.ok(ms2 < 2000, 'took ' + ms2 + ' ms');
  const t2 = process.hrtime.bigint();
  V.filterAuditIssues(e, { verdict: 'fix', issues: [{ severity: 'high', quote: 'the tyre pressure should always be checked when the tyres are warm after a drive' }] });
  const ms3 = Number(process.hrtime.bigint() - t2) / 1e6;
  assert.ok(ms3 < 2000, 'audit filter took ' + ms3 + ' ms');
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
    fences: rep('```'),
    sourcesHeads: rep('<h2>Sources</h2><ol><li><a href="https://d.test/">x</a></li>'),
    pluginPairs: rep('<!-- wp:x/y --><p>a</p><!-- /wp:x/y -->'),
    listItems: rep('<li>'),
    images: rep('<img src="a.jpg" alt="x">'),
    attrsNoClose: '<img ' + rep('a=b '),
    unclosedQuoteThenTags: '<img src="' + rep('<p>ab</p>'),
    quoteSoup: rep('<a b="c\' d=\'e" '),
    dataUri: '<img src="data:' + 'A'.repeat(N) + '">',
    closeWithoutOpen: rep('<div></p>'),
    stars: rep('**a '),
    citations: rep('[1] \u3010x\u3011 '),
    money: rep('$1,000 to $2,000 and 10-20% in 2024 '),
    hashLines: rep('\n## x '),
    bareChat: rep('Here is the article\n\n'),
    headingIds: rep('<h2 id="a">x</h2><img src="b">'),
    wpHeadings: rep('<!-- wp:heading {"level":3} --><h2>x</h2><!-- /wp:heading -->'),
    urlLines: rep('\nhttps://www.youtube.com/watch?v=x\n'),
    relLinks: rep('<a href="https://a.test/" rel="nofollow">a</a>')
  };
  for (const [name, s] of Object.entries(cases)) {
    const t0 = process.hrtime.bigint();
    V.validateArticle(s, s + '<p>x</p>', OPTS);
    V.sanitizeLinks(s, s + '<a href="https://reddit.com/">r</a>', OPTS, ['https://x.test/']);
    V.filterAuditIssues(s, { verdict: 'pass', issues: [{ severity: 'low', quote: 'some quote that is not there at all in this text' }] });
    V.parseEditorOutput(s);
    await V.processEditorOutput(s, '<<<ARTICLE_HTML>>>\n' + s + '\n<<<META_JSON>>>\n{"status":"edited"}\n<<<END>>>',
      { checkLinks: false, siteDomains: ['tubetyre.com'], webSearchCount: 0, today: '2026-09-27' });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 2000, name + ' took ' + ms.toFixed(0) + ' ms');
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
