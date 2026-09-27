'use strict';
// ═══════════════════════════════════════════════════════════════════════
// server.js — fake WordPress + fake AI chat website for the e2e harness
//
// One Node process, no dependencies. It serves (routing is by PATH, so any
// host name that the browser maps to it works):
//
//   Fake WordPress REST API (Application Password = HTTP Basic auth)
//     GET  /wp-json/wp/v2/posts?slug=…[&context=edit]   post lookup (content.raw)
//     GET  /wp-json/wp/v2/pages?slug=…                  always []
//     POST /wp-json/wp/v2/posts/<id>                     save {content}; every
//                                                        write is recorded
//     GET  /wp-json/wp/v2/users/me                       connection test
//
//   Fake wp-admin Classic Editor (update mode "editor")
//     GET  /wp-admin/post.php?post=<id>&action=edit       textarea#content,
//                                                        #content-html, input#publish
//     POST /wp-admin/post.php                            the Update form: the
//                                                        write is recorded (via
//                                                        'editor'), then a redirect
//                                                        to …&message=1 ("Post updated.")
//
//   Fake AI chat (ChatGPT-like DOM on any host)
//     GET  /  and  /?e2e=<scenario>                      new chat
//     GET  /c/<uuid>                                     durable conversation URL
//     POST /api/e2e/send                                 the page asks the server
//                                                        for its canned reply
//     The reply is chosen from the submitted text: a fact-check payload
//     (contains "ORIGINAL ARTICLE HTML START") or an editor payload (contains
//     "ARTICLE HTML START"), plus the scenario id (query param e2e=, else the
//     server-side default set with POST /__e2e/config).
//
//   Link targets for the Safety Gate's link check
//     /ok/…     200 text/html        /dead/…   404
//
//   Control API for the runner
//     GET  /__e2e/state         posts, writes, chats, requests
//     POST /__e2e/posts         add/replace posts  {posts:[{id,slug,title,content}]}
//     POST /__e2e/config        {defaultScenario, streamMs, thinkMs}
//     POST /__e2e/reset         forget everything
//
// Usage: const { startServer } = require('./server');
//        const srv = await startServer({ https: true });   // srv.httpPort, srv.httpsPort
//   or   node server.js [--port 8080]  (HTTP only, for poking at it by hand)
// ═══════════════════════════════════════════════════════════════════════
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ── The WordPress site the extension is pointed at ─────────────────────────
const WP_HOST = 'wp.e2e.test';
const LINK_HOST = 'links.e2e.test';
const WP_USER = 'e2e-editor';
const WP_APP_PASSWORD = 'abcd EFGH ijkl MNOP qrst UVWX';   // spaces are stripped by WordPress and the extension
const END = '<!-- APU-END -->';

// ═══════════════════════════════════════════════════════════════════════
// Fixture article (Gutenberg block markup: images, a table, lists, links,
// FAQ, conclusion) and the canned AI edits of it.
// ═══════════════════════════════════════════════════════════════════════
function b(name, inner, attrs) {
  return '<!-- wp:' + name + (attrs ? ' ' + attrs : '') + ' -->\n' + inner + '\n<!-- /wp:' + name + ' -->';
}
function li(text) { return b('list-item', '<li>' + text + '</li>'); }

// Paragraph texts that the edits reword. Everything else stays byte-identical.
const T = {
  intro: 'A cast iron pan can outlive its owner when it gets a little care after every use. This guide covers how to clean, dry and season cast iron, which oils work best, and the mistakes that cause rust or a sticky surface.',
  introEdited: 'With a little care after every use, a cast iron pan can easily outlive its owner. This guide covers how to clean, dry and season cast iron, which oils work best, and the mistakes that cause rust or a sticky surface.',
  why: 'Bare cast iron is porous metal that rusts quickly when it stays wet. The black coating on a good pan is called seasoning: thin layers of oil that were heated until they bonded to the metal. That coating protects the pan and makes food release easily. Our <a href="http://' + WP_HOST + '/seasoning-basics/">seasoning basics guide</a> explains the chemistry in more detail.',
  whyEdited: 'Bare cast iron is porous metal, and it rusts quickly when it stays wet. The black coating on a good pan is called seasoning: thin layers of oil that were heated until they bonded to the metal. That coating protects the pan and helps food release easily. Our <a href="http://' + WP_HOST + '/seasoning-basics/">seasoning basics guide</a> explains the chemistry in more detail.',
  clean: 'Clean the pan while it is still warm. Food comes off more easily and the pan dries faster. Follow these steps after every use:',
  cleanEdited: 'Clean the pan while it is still warm, because food lifts off more easily and the pan dries faster. Follow these steps after every use:',
  season: 'Seasoning is simply baking thin coats of oil onto the pan. Most makers recommend an oil with a high smoke point, and the <a href="http://' + LINK_HOST + '/ok/lodge-seasoning-guide" target="_blank" rel="noopener">cookware maker\'s seasoning guide</a> walks through the oven method step by step.',
  seasonEdited: 'Seasoning simply means baking thin coats of oil onto the pan. Most makers recommend an oil with a high smoke point, and the <a href="http://' + LINK_HOST + '/ok/lodge-seasoning-guide" target="_blank" rel="noopener">cookware maker\'s seasoning guide</a> walks through the oven method step by step.',
  faqSoap: 'Yes. A small amount of mild dish soap will not strip polymerised seasoning. What damages the pan is soaking it or leaving it to drip dry.',
  faqSoapEdited: 'Yes. A small amount of mild dish soap will not strip polymerised seasoning. What really damages the pan is soaking it or leaving it to drip dry.',
  conclusion: 'Cast iron is forgiving. Clean it warm, dry it completely, keep a thin coat of oil on it and cook with it often. If rust appears, scrub it off and season the pan again.',
  conclusionEdited: 'Cast iron is forgiving. Clean it while it is warm, dry it completely, keep a thin coat of oil on it and cook with it often. If rust appears, scrub it off and season the pan again.'
};
// A new external link (S1: live page, kept) and a dead one (S8: unwrapped).
const LIVE_LINK = 'http://' + LINK_HOST + '/ok/cast-iron-care-notes';
const DEAD_LINK = 'http://' + LINK_HOST + '/dead/cast-iron-myths';
const LIVE_LINK_SENTENCE = ' The <a href="' + LIVE_LINK + '">care notes from the pan maker</a> give the same advice.';
const DEAD_LINK_SENTENCE = ' Many old myths about cast iron are collected in <a href="' + DEAD_LINK + '">this myth-busting article</a>.';
// A wrong, harmful claim that the fake fact-checker quotes (S4, S5).
const BAD_CLAIM = 'Soaking the pan overnight in soapy water is the best way to protect its seasoning.';

const IMG1 = b('image', '<figure class="wp-block-image size-large"><img src="http://' + WP_HOST + '/wp-content/uploads/2026/03/seasoned-cast-iron-pan.jpg" alt="A seasoned cast iron pan on a gas hob" class="wp-image-201" width="1024" height="683"/><figcaption class="wp-element-caption">A well-seasoned pan has a smooth, dark finish.</figcaption></figure>', '{"id":201,"sizeSlug":"large","linkDestination":"none"}');
const IMG2 = b('image', '<figure class="wp-block-image size-large"><img src="http://' + WP_HOST + '/wp-content/uploads/2026/03/oiling-cast-iron-skillet.jpg" alt="Wiping a thin layer of oil onto a cast iron skillet" class="wp-image-202" width="1024" height="683"/></figure>', '{"id":202,"sizeSlug":"large","linkDestination":"none"}');

function heading(id, text, level) {
  const lv = level || 2;
  return b('heading', '<h' + lv + ' class="wp-block-heading" id="' + id + '">' + text + '</h' + lv + '>', lv === 2 ? '' : '{"level":' + lv + '}');
}
function para(text) { return b('paragraph', '<p>' + text + '</p>'); }

// opts: { edited, dropImage2, whyExtra, cleanExtra, seasonExtra, afterIntro, spans }
function article(opts) {
  const o = opts || {};
  const e = !!o.edited;
  const parts = [
    para(e ? T.introEdited : T.intro),
    o.afterIntro || null,
    heading('why-cast-iron-needs-care', 'Why Cast Iron Needs Care'),
    para((e ? T.whyEdited : T.why) + (o.whyExtra || '')),
    IMG1,
    heading('how-to-clean', 'How to Clean a Cast Iron Pan'),
    para((e ? T.cleanEdited : T.clean) + (o.cleanExtra || '')),
    b('list', '<ol class="wp-block-list">' + [
      li('Scrape out any food with a wooden spatula or a pan scraper.'),
      li('Rinse the pan under hot water and scrub it with a stiff brush.'),
      li('Dry it straight away with a towel, then warm it on the hob for two minutes.'),
      li('Rub in a few drops of oil with a paper towel while the pan is still warm.')
    ].join('\n') + '</ol>', '{"ordered":true}'),
    heading('seasoning-oils', 'Seasoning Oils Compared'),
    para((e ? T.seasonEdited : T.season) + (o.seasonExtra || '')),
    b('table', '<figure class="wp-block-table"><table><thead><tr><th>Oil</th><th>Smoke point</th><th>Best for</th></tr></thead><tbody>' +
      '<tr><td>Flaxseed oil</td><td>107°C</td><td>Thin oven coats</td></tr>' +
      '<tr><td>Vegetable shortening</td><td>182°C</td><td>Everyday re-seasoning</td></tr>' +
      '<tr><td>Canola oil</td><td>204°C</td><td>Stovetop touch-ups</td></tr>' +
      '</tbody></table><figcaption class="wp-element-caption">Common seasoning oils and their smoke points</figcaption></figure>'),
    o.dropImage2 ? null : IMG2,
    heading('common-mistakes', 'Common Mistakes'),
    b('list', '<ul class="wp-block-list">' + [
      li('Leaving the pan to soak in the sink.'),
      li('Putting it in the dishwasher.'),
      li('Storing it with the lid on, which traps moisture.'),
      li('Cooking very acidic sauces for hours in a new pan.')
    ].join('\n') + '</ul>'),
    heading('faq', 'Frequently Asked Questions'),
    heading('can-i-use-soap', 'Can I use soap on cast iron?', 3),
    para(e ? T.faqSoapEdited : T.faqSoap),
    heading('how-often-season', 'How often should I season my pan?', 3),
    para('Wipe on a thin coat of oil after each wash. A full oven seasoning is only needed when food starts to stick or the surface looks dull and grey.'),
    heading('conclusion', 'Conclusion'),
    para(e ? T.conclusionEdited : T.conclusion)
  ];
  const html = parts.filter(Boolean).join('\n\n');
  // Word / Google Docs clutter: every paragraph and list item wrapped in a
  // styled <span> (S19's original; the edit cleans it up).
  return o.spans ? html.replace(/<(p|li)>([\s\S]*?)<\/\1>/g, (m, tag, inner) => '<' + tag + '><span style="' + SPAN_STYLE + '">' + inner + '</span></' + tag + '>') : html;
}
const SPAN_STYLE = 'font-weight: 400; font-family: Arial, sans-serif; color: #000000; background-color: transparent;';

const ORIGINAL_HTML = article({ edited: false });
const GOOD_EDIT = article({ edited: true });

// S16 / S17: an affiliate-style LEGACY prompt (no <!-- APU-END -->, web search
// off). The original names a price; the edit removes it on purpose, adds a
// "Last updated" line with today's date and a new deep link to a live page.
const PRICE_SENTENCE = ' A pre-seasoned 10-inch skillet costs about $25 at most kitchen shops.';
const PRICE_SENTENCE_EDITED = ' A pre-seasoned 10-inch skillet is sold at most kitchen shops for little money.';
function todayYmd() {
  const t = new Date();
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
}
const LEGACY_ORIGINAL = article({ seasonExtra: PRICE_SENTENCE });
// S29: the legacy edit ALSO invents a price that is in neither the original
// nor the prompt (the prompt even says to remove price claims).
const INVENTED_PRICE_SENTENCE = ' A matching cast iron lid sells for $19.99 on Amazon.';
// opts: { dropImage2, inventedPrice }
function legacyEdit(opts) {
  return article({
    edited: true,
    seasonExtra: PRICE_SENTENCE_EDITED + ((opts && opts.inventedPrice) ? INVENTED_PRICE_SENTENCE : ''),
    afterIntro: para('<em>Last updated: ' + todayYmd() + '</em>'),
    whyExtra: LIVE_LINK_SENTENCE,
    dropImage2: !!(opts && opts.dropImage2)
  });
}
// S19: the original is full of <span style> clutter; the edit removes it.
const SPANS_ORIGINAL = article({ spans: true });

// ── Scenario catalogue: what the fake AI replies ───────────────────────────
// editor(ctx) / factCheck(ctx) return the reply as markdown text. ctx has
// { payload, round } (round = how many editor/fact-check chats of this
// scenario came before this one).
function editorReply(html, opts) {
  const o = opts || {};
  const lines = [
    'I tightened the wording in a few paragraphs and kept every image, link, table and block.',
    '## FINAL HTML',
    '```html',
    html
  ];
  if (!o.noMarker) lines.push(END);
  if (!o.unclosed) lines.push('```');
  return lines.join('\n');
}
function legacyReply(html) {
  // Old-style audit prompt: a report, a FIXED ARTICLE divider, then one code
  // block without any end marker.
  return [
    'AUDIT SUMMARY',
    'Readability: good. Structure: good. Three sentences were tightened.',
    'FIXED ARTICLE',
    '```html',
    html,
    '```'
  ].join('\n');
}
function amazonReply(html) {
  // The built-in "Single Amazon Product" prompt: an update log, then the
  // revised HTML in one code block, without any end marker.
  return [
    '[TITLE] Extracted: "How to Care for Cast Iron" from H1 | [PRODUCT] Extracted: "cast iron skillet"',
    '[CHANGE] Intro: tightened the hook.',
    '[CHANGE] Seasoning Oils: removed the specific price claim (prices change).',
    '[E-E-A-T] Last updated line added.',
    'PART 2 \u2014 REVISED HTML',
    '```html',
    html,
    '```'
  ].join('\n');
}
function jsonReply(obj) {
  return '```json\n' + JSON.stringify(obj, null, 2) + '\n```';
}
const PASS = { verdict: 'pass', issues: [] };
const BAD_CLAIM_ISSUE = {
  severity: 'high',
  category: 'fact_wrong',
  quote: 'Soaking the pan overnight in soapy water is the best way to protect its seasoning',
  problem: 'The edit adds dangerous advice: soaking cast iron makes it rust and strips the seasoning. The original says the opposite.',
  fix: 'Remove the sentence and keep the original advice.'
};

const SCENARIOS = {
  S1: {
    title: 'good edit + fact-check pass',
    editor: () => editorReply(article({ edited: true, whyExtra: LIVE_LINK_SENTENCE })),
    factCheck: () => jsonReply(PASS)
  },
  S2: {
    title: 'AI drops an image',
    editor: () => editorReply(article({ edited: true, dropImage2: true })),
    factCheck: () => jsonReply(PASS)
  },
  S3: {
    title: 'reply cut before the end marker',
    editor: () => editorReply(GOOD_EDIT, { noMarker: true, unclosed: true }),
    factCheck: () => jsonReply(PASS)
  },
  S4: {
    title: 'fact-check fix -> fix round -> pass',
    // The fix round's payload carries the PRIORITY FIX block (after the prompt's
    // REMINDER; the prompt itself also mentions "PRIORITY FIX", so match the
    // block's banner): answer with the clean edit.
    editor: (ctx) => hasPriorityFixBlock(ctx.payload)
      ? editorReply(GOOD_EDIT)
      : editorReply(article({ edited: true, cleanExtra: ' ' + BAD_CLAIM })),
    factCheck: (ctx) => ctx.payload.indexOf(BAD_CLAIM) >= 0
      ? jsonReply({ verdict: 'fix', issues: [BAD_CLAIM_ISSUE] })
      : jsonReply(PASS)
  },
  S5: {
    title: 'fact-check reject',
    editor: () => editorReply(article({ edited: true, cleanExtra: ' ' + BAD_CLAIM })),
    factCheck: () => jsonReply({ verdict: 'reject', issues: [BAD_CLAIM_ISSUE] })
  },
  S6: {
    title: 'fact-check never returns JSON',
    editor: () => editorReply(GOOD_EDIT),
    factCheck: () => 'I compared the two versions carefully. The edit reads well and I did not spot any factual problems, so it looks fine to publish.'
  },
  S7: {
    title: 'gate OFF + old prompt (legacy)',
    editor: () => legacyReply(GOOD_EDIT),
    factCheck: () => jsonReply({ verdict: 'reject', issues: [] })   // must never be asked
  },
  // S9 = S2's replies, run WITHOUT a clipboard permission grant (see run-e2e.js).
  S9: {
    title: 'image dropped, clipboard permission not granted',
    editor: () => editorReply(article({ edited: true, dropImage2: true })),
    factCheck: () => jsonReply(PASS)
  },
  S10: {
    title: 'fact-check breaks, on-error = save',
    editor: () => editorReply(GOOD_EDIT),
    factCheck: () => 'Both versions look fine to me. I have no concerns about the edit.'
  },
  // Parallel batch of three posts; each editor payload names its post title
  // ([[POST_TITLE]] = "… (S11-A)") and gets the reply of S1 / S2 / S8.
  S11: {
    title: 'parallel batch: pass + block + unwrap',
    editor: (ctx) => {
      const m = /Post title \(H1, set in WordPress\): [^\n]*\(S11-([ABC])\)/.exec(ctx.payload);
      const sub = { A: 'S1', B: 'S2', C: 'S8' }[m ? m[1] : 'A'];
      return SCENARIOS[sub].editor(ctx);
    },
    factCheck: () => jsonReply(PASS)
  },
  S12: {
    title: 'gate block + retries + HTML recovery ON',
    editor: () => editorReply(article({ edited: true, dropImage2: true })),
    factCheck: () => jsonReply(PASS)
  },
  S13: {
    title: 'Recover any code on a gate-blocked row',
    editor: () => editorReply(article({ edited: true, dropImage2: true })),
    factCheck: () => jsonReply(PASS)
  },
  S8: {
    title: 'new dead external link',
    editor: () => editorReply(article({ edited: true, whyExtra: DEAD_LINK_SENTENCE })),
    factCheck: () => jsonReply({ verdict: 'pass', issues: [{ severity: 'low', category: 'style', quote: 'Clean the pan while it is still warm, because food lifts off more easily', problem: 'Slightly long sentence.', fix: 'Optional: split it.' }] })
  }
};

// S16 / S17: legacy affiliate prompt (see legacyEdit).
// The fake fact check of S16 / S29 follows the shipped fact-check prompt's
// INTENDED CHANGES rule: the removed price is intended ONLY when the payload
// carries the EDITING INSTRUCTIONS block with the prompt that asks for it
// (the built-in Amazon prompt: "Remove specific price claims"). Without the
// block it reports the lost price (HIGH info_lost), as the real prompt would.
const EDIT_BLOCK_LABEL = 'EDITING INSTRUCTIONS THE EDITOR FOLLOWED';
function editingBlock(payload) {
  const s = String(payload || '');
  const a = s.indexOf(EDIT_BLOCK_LABEL + ' START');
  const z = s.indexOf(EDIT_BLOCK_LABEL + ' END');
  if (a < 0 || z < a) return null;
  return s.slice(s.indexOf('\n', a) + 1, s.lastIndexOf('\n', z)).trim();
}
// The EDITED block of a fact-check payload.
function editedBlock(payload) {
  const s = String(payload || '');
  const a = s.indexOf('EDITED ARTICLE HTML START');
  const z = s.indexOf('EDITED ARTICLE HTML END');
  return (a < 0 || z < a) ? '' : s.slice(a, z);
}
const PRICE_LOST_ISSUE = {
  severity: 'high',
  category: 'info_lost',
  quote: 'A pre-seasoned 10-inch skillet is sold at most kitchen shops for little money',
  problem: 'The original says a pre-seasoned 10-inch skillet costs about $25; the edit dropped the price.',
  fix: 'Keep the original wording: "costs about $25 at most kitchen shops".'
};
const INVENTED_PRICE_ISSUE = {
  severity: 'high',
  category: 'new_claim_unverified',
  quote: 'A matching cast iron lid sells for $19.99 on Amazon',
  problem: 'The edit adds a price that is not in the original and could not be verified (no web search).',
  fix: 'Remove the added claim about the lid price.'
};
function legacyFactCheck(ctx) {
  const block = editingBlock(ctx.payload);
  if (!block || block.indexOf('Remove specific price claims') < 0) return jsonReply({ verdict: 'fix', issues: [PRICE_LOST_ISSUE] });
  if (editedBlock(ctx.payload).indexOf('$19.99') >= 0) return jsonReply({ verdict: 'fix', issues: [INVENTED_PRICE_ISSUE] });
  return jsonReply(PASS);
}
SCENARIOS.S16 = {
  title: 'legacy prompt: price removed, Last updated, new link',
  editor: () => amazonReply(legacyEdit()),
  factCheck: legacyFactCheck
};
// S29: the same legacy edit, but it ALSO invents a new price → the fact check
// (which accepts the intended removal) reports the invented one → fix round →
// the second editor reply has no invented price → saved.
SCENARIOS.S29 = {
  title: 'legacy prompt: intended price removal + invented price -> fix round',
  editor: (ctx) => hasPriorityFixBlock(ctx.payload)
    ? amazonReply(legacyEdit())
    : amazonReply(legacyEdit({ inventedPrice: true })),
  factCheck: legacyFactCheck
};
// S30: a Safety Gate prompt: the fact-check payload must NOT carry the
// EDITING INSTRUCTIONS block (first check and after the fix round). With the
// block the fake fact check answers without JSON (FACT CHECK ERROR, nothing
// saved), so a leak cannot pass unnoticed.
SCENARIOS.S30 = {
  title: 'Safety Gate prompt: no editing instructions in the fact check',
  editor: (ctx) => hasPriorityFixBlock(ctx.payload)
    ? editorReply(GOOD_EDIT)
    : editorReply(article({ edited: true, cleanExtra: ' ' + BAD_CLAIM })),
  factCheck: (ctx) => {
    // (The fact-check prompt itself names the block; only its banner counts.)
    if (/EDITING INSTRUCTIONS THE EDITOR FOLLOWED (?:START|END)/.test(ctx.payload)) return 'This payload carries an editing-instructions block, which a Safety Gate prompt must never send.';
    return ctx.payload.indexOf(BAD_CLAIM) >= 0 ? jsonReply({ verdict: 'fix', issues: [BAD_CLAIM_ISSUE] }) : jsonReply(PASS);
  }
};
// S31 / S32: the stored "Fact Check (Safety Gate)" prompt is the text of an
// earlier 3.46.0 pre-release build (it does not describe the EDITING
// INSTRUCTIONS block). S31: never edited → the panel replaces it with the
// shipped text on load → S16's result. S32: edited → kept → the block is NOT
// sent → the fake fact check reports the removed price (as the real old
// prompt would) → fix round → same edit → FACT CHECK BLOCKED.
SCENARIOS.S31 = {
  title: 'pre-release fact-check prompt (unedited) is upgraded -> legacy edit saved',
  editor: () => amazonReply(legacyEdit()),
  factCheck: legacyFactCheck
};
SCENARIOS.S32 = {
  title: 'edited pre-release fact-check prompt: no editing instructions -> FACT CHECK BLOCKED',
  editor: () => amazonReply(legacyEdit()),
  factCheck: legacyFactCheck
};
SCENARIOS.S17 = {
  title: 'legacy prompt: AI drops an image',
  editor: () => amazonReply(legacyEdit({ dropImage2: true })),
  factCheck: () => jsonReply(PASS)
};
// S18: the first reply drops an image; the automatic retry must carry a
// PRIORITY FIX block that names IMG_COUNT — only then the good edit comes.
SCENARIOS.S18 = {
  title: 'automatic retry carries the gate reasons',
  editor: (ctx) => (hasPriorityFixBlock(ctx.payload) && /IMG_COUNT/.test(ctx.payload))
    ? editorReply(GOOD_EDIT)
    : editorReply(article({ edited: true, dropImage2: true })),
  factCheck: () => jsonReply(PASS)
};
// S19: the edit strips the <span style> clutter (about 75% of the source
// length) and ends with the marker.
SCENARIOS.S19 = {
  title: 'span clean-up shrinks HTML, marker present',
  editor: () => editorReply(GOOD_EDIT),
  factCheck: () => jsonReply(PASS)
};

// S20: the legacy prompt of S16 with the fact check OFF: no fail-closed fact
// check stands behind the gate, so the research rules block the same edit.
SCENARIOS.S20 = {
  title: 'legacy prompt, fact check OFF: research rules block',
  editor: () => amazonReply(legacyEdit()),
  factCheck: () => jsonReply(PASS)
};

// S21 / S22 (ported from the verifier's S90 / S92): a classic-style post whose
// headings have no id (so no ID_MISSING), full of <span style> clutter. The
// reply STOPS BEFORE THE CONCLUSION (a clean block boundary), about 70% of the
// source length. S21: the <!-- APU-END --> marker sits at the TOP of the code
// box. S22: the marker is the last line, but the Conclusion never came.
const NOID = (h) => h.replace(/ id="[^"]*"/g, '');
const CUT_ORIGINAL = NOID(SPANS_ORIGINAL);
const CUT_GOOD = NOID(GOOD_EDIT);
const CUT_REPLY = CUT_GOOD.slice(0, CUT_GOOD.lastIndexOf('<!-- wp:heading')).trim();
SCENARIOS.S21 = {
  title: 'reply cut before Conclusion, marker at the TOP',
  editor: () => editorReply(END + '\n' + CUT_REPLY, { noMarker: true }),
  factCheck: () => jsonReply(PASS)
};
SCENARIOS.S22 = {
  title: 'reply stops before Conclusion, marker at the end',
  editor: () => editorReply(CUT_REPLY),
  factCheck: () => jsonReply(PASS)
};

// S23: the first reply drops an image; the automatic retry gets the PRIORITY
// FIX note and pastes its first sentence into the article (PROMPT_ECHO).
const ECHO_SENTENCE = 'Your previous edit of this exact article was REJECTED by the automatic Safety Gate, so nothing was saved.';
SCENARIOS.S23 = {
  title: 'retry reply echoes the PRIORITY FIX note',
  editor: (ctx) => hasPriorityFixBlock(ctx.payload)
    ? editorReply(article({ edited: true, afterIntro: para(ECHO_SENTENCE) }))
    : editorReply(article({ edited: true, dropImage2: true })),
  factCheck: () => jsonReply(PASS)
};

// S24: fact check "fix" -> the fix round drops an image -> Safety Gate block;
// the end-of-batch retry's note names IMG_COUNT AND the fact-check issue that
// caused the fix round -> good edit -> saved once.
SCENARIOS.S24 = {
  title: 'blocked fix round: retry note carries gate + fact-check reasons',
  editor: (ctx) => {
    if (hasPriorityFixBlock(ctx.payload) && /REJECTED by the automatic Safety Gate/.test(ctx.payload)) return editorReply(GOOD_EDIT);
    if (hasPriorityFixBlock(ctx.payload)) return editorReply(article({ edited: true, dropImage2: true }));
    return editorReply(article({ edited: true, cleanExtra: ' ' + BAD_CLAIM }));
  },
  factCheck: (ctx) => ctx.payload.indexOf(BAD_CLAIM) >= 0
    ? jsonReply({ verdict: 'fix', issues: [BAD_CLAIM_ISSUE] })
    : jsonReply(PASS)
};

// S25: a Safety Gate prompt's reply is cut off before its end marker (blocked
// as incomplete). The user then selects an OLDER prompt and clicks "Recover
// any code": the saved chat must still be judged by the Safety Gate prompt's
// rules (END_MARKER_MISSING), not by the prompt selected now.
SCENARIOS.S25 = {
  title: 'Recover any code after switching to a legacy prompt',
  editor: () => editorReply(CUT_REPLY, { noMarker: true }),
  factCheck: () => jsonReply(PASS)
};

// S26 / S27 / S28 (ported from the verifier's S96 / S97 / S98): the
// end-marker length waiver must find the original's LAST section, not one
// shared word. S26: the last H2 is "Final Thoughts on Cast Iron Care" (its
// words are all over the article); the reply stops before it and ends with
// the marker. S27: a GOOD span clean-up that renames "Conclusion" to "Final
// Thoughts". S28: the FAQ is the last section; the reply drops the last
// question and answer and ends with the marker.
const renameLastHeading = (h, t) => h.replace('<h2 class="wp-block-heading">Conclusion</h2>', '<h2 class="wp-block-heading">' + t + '</h2>');
const cutBeforeLastHeading = (h) => h.slice(0, h.lastIndexOf('<!-- wp:heading')).trim();
const T_ORIGINAL = renameLastHeading(CUT_ORIGINAL, 'Final Thoughts on Cast Iron Care');
const T_CUT = cutBeforeLastHeading(renameLastHeading(CUT_GOOD, 'Final Thoughts on Cast Iron Care'));
const RENAMED_GOOD = renameLastHeading(CUT_GOOD, 'Final Thoughts');
const F_ORIGINAL = cutBeforeLastHeading(CUT_ORIGINAL);
const F_GOOD = cutBeforeLastHeading(CUT_GOOD);
const F_CUT = cutBeforeLastHeading(F_GOOD);
SCENARIOS.S26 = {
  title: 'stops before "Final Thoughts on Cast Iron Care", marker at end',
  editor: () => editorReply(T_CUT),
  factCheck: () => jsonReply(PASS)
};
SCENARIOS.S27 = {
  title: 'span clean-up + Conclusion renamed Final Thoughts',
  editor: () => editorReply(RENAMED_GOOD),
  factCheck: () => jsonReply(PASS)
};
SCENARIOS.S28 = {
  title: 'FAQ-last post, last Q&A dropped, marker at end',
  editor: () => editorReply(F_CUT),
  factCheck: () => jsonReply(PASS)
};

// Update mode "editor" (wp-admin Classic Editor instead of the REST API):
// the replies of S1 (good edit) and S2 (an image dropped).
SCENARIOS.S14 = Object.assign({}, SCENARIOS.S1, { title: 'editor mode: good edit + fact-check pass' });
SCENARIOS.S15 = Object.assign({}, SCENARIOS.S2, { title: 'editor mode: AI drops an image' });

// The PRIORITY FIX block that generateHtmlForArticle appends after the prompt:
// "\n\n══════════════  PRIORITY FIX (…)  ══════════════\n<note>".
function hasPriorityFixBlock(text) {
  return /\u2550{3,}[ \t]+PRIORITY FIX\b/.test(String(text || ''));
}

function classifyPayload(text) {
  const s = String(text || '');
  if (s.indexOf('ORIGINAL ARTICLE HTML START') >= 0) return 'factcheck';
  if (s.indexOf('ARTICLE HTML START') >= 0) return 'editor';
  return 'other';
}

// ═══════════════════════════════════════════════════════════════════════
// The chat page (ChatGPT-like DOM). Self-contained HTML + inline script.
// ═══════════════════════════════════════════════════════════════════════
const CHAT_PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ChatGPT</title>
<style>
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; background: #fff; color: #111; }
  header { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid #ddd; }
  #thread { padding: 16px; max-width: 900px; margin: 0 auto 180px; }
  [data-message-author-role="user"] { background: #f1f1f1; border-radius: 16px; padding: 10px 14px; margin: 12px 0 12px 20%;
    white-space: pre-wrap; max-height: 240px; overflow: auto; font-size: 12px; }
  [data-message-author-role="assistant"] { margin: 12px 0; }
  pre { background: #f7f7f8; border-radius: 12px; overflow: visible; }
  .code-head { display: flex; justify-content: space-between; padding: 6px 12px; font-size: 12px; color: #555; }
  .code-body { overflow-y: auto; padding: 12px; max-height: 400px; }
  code { white-space: pre; font-size: 12px; }
  #composer { position: fixed; bottom: 0; left: 0; right: 0; background: #fff; border-top: 1px solid #ddd; padding: 12px; }
  #composer form { display: flex; gap: 8px; max-width: 900px; margin: 0 auto; align-items: flex-end; }
  #prompt-textarea { flex: 1; min-height: 44px; max-height: 160px; overflow: auto; border: 1px solid #ccc; border-radius: 16px;
    padding: 10px 14px; white-space: pre-wrap; outline: none; }
  button { font: inherit; padding: 8px 14px; border-radius: 18px; border: 1px solid #aaa; background: #111; color: #fff; }
  button[disabled] { opacity: .4; }
</style></head>
<body>
<header><strong>ChatGPT</strong>
  <button type="button" data-testid="model-switcher-dropdown-button" aria-label="Model selector, current model is GPT-5 Thinking">ChatGPT 5 Thinking</button>
</header>
<main id="main"><div id="thread"></div></main>
<div id="composer">
  <form id="composer-form" onsubmit="return false;">
    <div id="prompt-textarea" class="ProseMirror" contenteditable="true" role="textbox" aria-label="Message ChatGPT" data-placeholder="Ask anything"></div>
    <button type="button" id="composer-submit-button" data-testid="send-button" aria-label="Send prompt" disabled>Send</button>
  </form>
</div>
<script>
(function () {
  var thread = document.getElementById('thread');
  var composer = document.getElementById('prompt-textarea');
  var form = document.getElementById('composer-form');
  var sendBtn = document.getElementById('composer-submit-button');
  var params = new URLSearchParams(location.search);
  var scenario = params.get('e2e') || '';
  var conversationId = '';
  var busy = false;
  var m = location.pathname.match(/^\/c\/([0-9a-f-]{36})\/?$/i);

  function composerText() { return composer.innerText || composer.textContent || ''; }
  function refreshSend() { sendBtn.disabled = busy || !composerText().trim(); }
  composer.addEventListener('input', refreshSend);
  // ProseMirror reads pasted text from the clipboard event itself.
  composer.addEventListener('paste', function (e) {
    var t = e.clipboardData && e.clipboardData.getData('text/plain');
    if (!t) return;
    e.preventDefault();
    composer.textContent = composerText() + t;
    composer.dispatchEvent(new Event('input', { bubbles: true }));
  });
  composer.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  sendBtn.addEventListener('click', function () { send(); });

  // Tiny markdown renderer: paragraphs, "## " headings and fenced code blocks
  // (an unclosed fence at the end still renders as a code block, like ChatGPT).
  function render(md, target) {
    target.innerHTML = '';
    var lines = String(md).split('\n');
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var f = line.match(/^\x60\x60\x60\s*([a-z0-9_-]*)\s*$/i);
      if (f) {
        var lang = f[1] || 'plaintext';
        var body = [];
        i++;
        while (i < lines.length && !/^\x60\x60\x60\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
        i++;
        var pre = document.createElement('pre');
        var card = document.createElement('div');
        var head = document.createElement('div');
        head.className = 'code-head';
        var label = document.createElement('span');
        label.textContent = lang;
        var copy = document.createElement('button');
        copy.type = 'button';
        copy.setAttribute('aria-label', 'Copy');
        copy.setAttribute('data-testid', 'copy-code-button');
        copy.textContent = 'Copy code';
        head.appendChild(label);
        head.appendChild(copy);
        var bodyDiv = document.createElement('div');
        bodyDiv.className = 'code-body';
        bodyDiv.setAttribute('dir', 'ltr');
        var code = document.createElement('code');
        code.className = 'whitespace-pre! language-' + lang;
        code.textContent = body.join('\n');
        copy.addEventListener('click', function (codeEl) {
          return function () {
            try { var p = navigator.clipboard && navigator.clipboard.writeText(codeEl.textContent); if (p && p.catch) p.catch(function () {}); } catch (e) {}
          };
        }(code));
        bodyDiv.appendChild(code);
        card.appendChild(head);
        card.appendChild(bodyDiv);
        pre.appendChild(card);
        target.appendChild(pre);
        continue;
      }
      if (!line.trim()) { i++; continue; }
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      var el = document.createElement(h ? 'h' + Math.min(6, h[1].length + 1) : 'p');
      el.textContent = h ? h[2] : line;
      target.appendChild(el);
      i++;
    }
  }

  function addUser(text) {
    var d = document.createElement('div');
    d.setAttribute('data-message-author-role', 'user');
    d.textContent = text;
    thread.appendChild(d);
    return d;
  }
  function addAssistant() {
    var d = document.createElement('div');
    d.setAttribute('data-message-author-role', 'assistant');
    d.setAttribute('data-message-id', 'msg-' + Math.random().toString(16).slice(2));
    var md = document.createElement('div');
    md.className = 'markdown prose';
    d.appendChild(md);
    thread.appendChild(d);
    return md;
  }
  function stopButton(on) {
    var s = document.getElementById('stop-button');
    if (on && !s) {
      s = document.createElement('button');
      s.type = 'button';
      s.id = 'stop-button';
      s.setAttribute('data-testid', 'stop-button');
      s.setAttribute('aria-label', 'Stop streaming');
      s.textContent = '■';
      form.appendChild(s);
      sendBtn.style.display = 'none';
    } else if (!on && s) {
      s.remove();
      sendBtn.style.display = '';
    }
  }

  function send() {
    var text = composerText();
    if (busy || !text.trim()) return;
    busy = true;
    composer.textContent = '';
    refreshSend();
    addUser(text);
    stopButton(true);
    var md = addAssistant();
    md.classList.add('result-streaming');
    fetch('/api/e2e/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: scenario, conversationId: conversationId, text: text, host: location.host })
    }).then(function (r) { return r.json(); }).then(function (res) {
      conversationId = res.conversationId;
      scenario = res.scenario || scenario;
      if (location.pathname.indexOf('/c/' + conversationId) !== 0) history.pushState({}, '', '/c/' + conversationId);
      var reply = String(res.reply || '');
      var streamMs = Math.max(200, res.streamMs || 4000);
      setTimeout(function () {
        var ticks = Math.max(1, Math.round(streamMs / 120));
        var step = Math.max(1, Math.ceil(reply.length / ticks));
        var shown = 0;
        var timer = setInterval(function () {
          shown = Math.min(reply.length, shown + step);
          render(reply.slice(0, shown), md);
          if (shown >= reply.length) {
            clearInterval(timer);
            md.classList.remove('result-streaming');
            stopButton(false);
            busy = false;
            refreshSend();
          }
        }, 120);
      }, Math.max(0, res.thinkMs || 0));
    }).catch(function (e) {
      render('Something went wrong: ' + e, md);
      stopButton(false);
      busy = false;
      refreshSend();
    });
  }

  // A durable conversation URL reopens the whole chat.
  if (m) {
    conversationId = m[1].toLowerCase();
    fetch('/api/e2e/conversation/' + conversationId).then(function (r) { return r.json(); }).then(function (c) {
      scenario = c.scenario || scenario;
      (c.messages || []).forEach(function (msg) {
        if (msg.role === 'user') addUser(msg.text);
        else render(msg.text, addAssistant());
      });
    }).catch(function () {});
  }
  refreshSend();
})();
</script>
</body></html>`;

const LINK_OK_PAGE = '<!doctype html><html><head><title>Cast iron care notes</title></head><body><h1>Cast iron care notes</h1><p>Dry the pan straight away and oil it lightly.</p></body></html>';

// The Classic Editor screen, as far as the extension touches it:
// switchToCodeMode (#content-html), grabHtmlFromEditor / clearAndPasteHtml
// (textarea#content), clickUpdateButton (input#publish, label "Update") and
// checkUpdateSuccess (?message=1 and #message "Post updated.").
function escapeHtmlText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function wpAdminEditorPage(post, updated) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Edit Post \u2039 E2E Blog \u2014 WordPress</title></head>' +
    '<body class="wp-admin post-php"><div id="wpbody-content">' +
    (updated ? '<div id="message" class="updated notice notice-success is-dismissible"><p>Post updated. <a href="' + escapeHtmlText(post.link) + '">View post</a></p></div>' : '') +
    '<h1 class="wp-heading-inline">Edit Post</h1>' +
    '<form name="post" action="/wp-admin/post.php" method="post" id="post">' +
    '<input type="hidden" name="post_ID" value="' + post.id + '"><input type="hidden" name="action" value="editpost">' +
    '<input type="text" name="post_title" id="title" value="' + escapeHtmlText(post.title).replace(/"/g, '&quot;') + '">' +
    '<div class="wp-editor-tabs"><button type="button" id="content-tmce" class="wp-switch-editor switch-tmce">Visual</button>' +
    '<button type="button" id="content-html" class="wp-switch-editor switch-html">Text</button></div>' +
    '<textarea class="wp-editor-area" rows="20" cols="80" name="content" id="content">' + escapeHtmlText(post.content) + '</textarea>' +
    '<div id="publishing-action"><input type="submit" name="save" id="publish" class="button button-primary button-large" value="Update"></div>' +
    '</form></div></body></html>';
}

// ═══════════════════════════════════════════════════════════════════════
// Server
// ═══════════════════════════════════════════════════════════════════════
function createState() {
  return {
    posts: new Map(),          // id -> { id, slug, title, content, link }
    writes: [],                // every POST to a post: { id, slug, content, at, authOk }
    chats: [],                 // every message sent to the fake AI
    conversations: new Map(),  // id -> { id, scenario, messages: [{role,text}] }
    requests: [],              // WordPress + link requests (method, path, status)
    config: { defaultScenario: 'S1', streamMs: 4000, thinkMs: 1200 }
  };
}

function expectedAuth() {
  return 'Basic ' + Buffer.from(WP_USER + ':' + WP_APP_PASSWORD.replace(/\s+/g, '')).toString('base64');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, body, type, extraHeaders) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign({
    'Content-Type': type || (typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8'),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  }, extraHeaders || {}));
  res.end(data);
}

function postJson(p, context) {
  const edit = context === 'edit';
  return {
    id: p.id,
    date: '2026-03-02T10:00:00',
    slug: p.slug,
    status: 'publish',
    type: 'post',
    link: p.link,
    title: edit ? { raw: p.title, rendered: p.title } : { rendered: p.title },
    content: edit
      ? { raw: p.content, rendered: p.content.replace(/<!--[\s\S]*?-->\n?/g, ''), protected: false, block_version: 1 }
      : { rendered: p.content.replace(/<!--[\s\S]*?-->\n?/g, ''), protected: false }
  };
}

function pickFields(obj, fields) {
  if (!fields) return obj;
  const out = {};
  String(fields).split(',').map((f) => f.trim()).filter(Boolean).forEach((f) => { if (obj[f] !== undefined) out[f] = obj[f]; });
  return out;
}

function makeHandler(state) {
  return async function handler(req, res) {
    let url;
    try { url = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
    catch (e) { return send(res, 400, { error: 'bad url' }); }
    const p = url.pathname;
    const method = req.method || 'GET';
    try {
      // ── Control API ──
      if (p === '/__e2e/state') {
        return send(res, 200, {
          posts: [...state.posts.values()],
          writes: state.writes,
          chats: state.chats,
          requests: state.requests.slice(-500),
          config: state.config
        });
      }
      if (p === '/__e2e/posts' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        (body.posts || []).forEach((post) => {
          state.posts.set(Number(post.id), {
            id: Number(post.id),
            slug: String(post.slug),
            title: String(post.title || post.slug),
            content: String(post.content || ''),
            link: post.link || ('http://' + WP_HOST + '/' + post.slug + '/')
          });
        });
        return send(res, 200, { ok: true, count: state.posts.size });
      }
      if (p === '/__e2e/config' && method === 'POST') {
        Object.assign(state.config, JSON.parse((await readBody(req)) || '{}'));
        return send(res, 200, { ok: true, config: state.config });
      }
      if (p === '/__e2e/reset' && method === 'POST') {
        const fresh = createState();
        Object.keys(fresh).forEach((k) => { state[k] = fresh[k]; });
        return send(res, 200, { ok: true });
      }

      // ── Fake WordPress REST API ──
      if (p.indexOf('/wp-json') === 0) {
        const authOk = req.headers.authorization === expectedAuth();
        const record = { method, path: p + url.search, authOk, host: req.headers.host, at: Date.now(), status: 200 };
        state.requests.push(record);
        const reply = (status, body) => { record.status = status; return send(res, status, body); };
        if (p === '/wp-json/wp/v2/users/me') {
          if (!authOk) return reply(401, { code: 'rest_not_logged_in', message: 'You are not currently logged in.', data: { status: 401 } });
          return reply(200, { id: 1, name: WP_USER, slug: WP_USER, roles: ['editor'], capabilities: { edit_posts: true } });
        }
        const list = p.match(/^\/wp-json\/wp\/v2\/(posts|pages)\/?$/);
        if (list && method === 'GET') {
          const context = url.searchParams.get('context') || 'view';
          if (context === 'edit' && !authOk) {
            return reply(401, { code: 'rest_forbidden_context', message: 'Sorry, you are not allowed to edit posts in this post type.', data: { status: 401 } });
          }
          if (list[1] === 'pages') return reply(200, []);
          const slug = url.searchParams.get('slug') || '';
          const rows = [...state.posts.values()].filter((x) => !slug || x.slug === slug)
            .map((x) => pickFields(postJson(x, context), url.searchParams.get('_fields')));
          return reply(200, rows);
        }
        const one = p.match(/^\/wp-json\/wp\/v2\/posts\/(\d+)\/?$/);
        if (one) {
          const post = state.posts.get(Number(one[1]));
          if (!post) return reply(404, { code: 'rest_post_invalid_id', message: 'Invalid post ID.', data: { status: 404 } });
          if (method === 'GET') return reply(200, postJson(post, authOk ? (url.searchParams.get('context') || 'view') : 'view'));
          if (method === 'POST' || method === 'PUT') {
            const raw = await readBody(req);
            if (!authOk) return reply(401, { code: 'rest_cannot_edit', message: 'Sorry, you are not allowed to edit this post.', data: { status: 401 } });
            let body = {};
            try { body = JSON.parse(raw || '{}'); } catch (e) { return reply(400, { code: 'rest_invalid_json', message: 'Invalid JSON body.' }); }
            state.writes.push({ id: post.id, slug: post.slug, keys: Object.keys(body), content: body.content, at: Date.now() });
            if (typeof body.content === 'string') post.content = body.content;
            if (typeof body.title === 'string') post.title = body.title;
            return reply(200, postJson(post, 'edit'));
          }
        }
        return reply(404, { code: 'rest_no_route', message: 'No route was found matching the URL and request method.', data: { status: 404 } });
      }

      // ── Fake wp-admin Classic Editor ──
      if (p === '/wp-admin/post.php') {
        const record = { method, path: p + url.search, host: req.headers.host, at: Date.now(), status: 200, wpAdmin: true };
        state.requests.push(record);
        if (method === 'POST') {
          const form = new URLSearchParams(await readBody(req));
          record.postId = Number(form.get('post_ID'));
          const post = state.posts.get(record.postId);
          if (!post) { record.status = 404; return send(res, 404, '<!doctype html><title>Error</title><p>Invalid post ID.</p>'); }
          // Form submission sends textarea line breaks as CRLF.
          const content = String(form.get('content') || '').replace(/\r\n/g, '\n');
          state.writes.push({ id: post.id, slug: post.slug, keys: ['content'], content, at: Date.now(), via: 'editor' });
          post.content = content;
          record.status = 302;
          return send(res, 302, '', 'text/html; charset=utf-8', { Location: '/wp-admin/post.php?post=' + post.id + '&action=edit&message=1' });
        }
        record.postId = Number(url.searchParams.get('post'));
        const post = state.posts.get(record.postId);
        if (!post) { record.status = 404; return send(res, 404, '<!doctype html><title>Error</title><p>Invalid post ID.</p>'); }
        return send(res, 200, wpAdminEditorPage(post, url.searchParams.get('message') === '1'));
      }

      // ── Link targets ──
      if (p.indexOf('/ok/') === 0 || p.indexOf('/dead/') === 0) {
        const dead = p.indexOf('/dead/') === 0;
        state.requests.push({ method, path: p, host: req.headers.host, at: Date.now(), status: dead ? 404 : 200 });
        if (dead) return send(res, 404, '<!doctype html><title>404 Not Found</title><h1>Not Found</h1>');
        return send(res, 200, method === 'HEAD' ? '' : LINK_OK_PAGE);
      }

      // ── Fake AI chat ──
      if (p === '/api/e2e/send' && method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        let conv = body.conversationId ? state.conversations.get(body.conversationId) : null;
        if (!conv) {
          conv = { id: crypto.randomUUID(), scenario: body.scenario || state.config.defaultScenario, messages: [], host: body.host || '' };
          state.conversations.set(conv.id, conv);
        }
        const text = String(body.text || '');
        const kind = classifyPayload(text);
        const sc = SCENARIOS[conv.scenario] || SCENARIOS.S1;
        const round = state.chats.filter((c) => c.scenario === conv.scenario && c.kind === kind).length;
        let reply;
        if (kind === 'factcheck') reply = sc.factCheck({ payload: text, round });
        else if (kind === 'editor') reply = sc.editor({ payload: text, round });
        else reply = 'Sorry, I did not find an article in your message.';
        state.chats.push({
          conversationId: conv.id, scenario: conv.scenario, kind, round, host: conv.host,
          payloadLength: text.length, payload: text, reply, at: Date.now()
        });
        conv.messages.push({ role: 'user', text }, { role: 'assistant', text: reply });
        return send(res, 200, {
          conversationId: conv.id, scenario: conv.scenario, reply,
          streamMs: state.config.streamMs, thinkMs: state.config.thinkMs
        });
      }
      const convGet = p.match(/^\/api\/e2e\/conversation\/([0-9a-f-]{36})$/i);
      if (convGet) {
        const conv = state.conversations.get(convGet[1].toLowerCase());
        return conv ? send(res, 200, conv) : send(res, 404, { error: 'no such conversation' });
      }
      if (p === '/' || /^\/c\/[0-9a-f-]{36}\/?$/i.test(p)) {
        state.requests.push({ method, path: p + url.search, host: req.headers.host, at: Date.now(), status: 200, chatPage: true });
        return send(res, 200, CHAT_PAGE);
      }
      if (p === '/favicon.ico') return send(res, 204, '');
      return send(res, 404, '<!doctype html><title>404</title><h1>Not Found</h1>');
    } catch (e) {
      return send(res, 500, { error: String(e && e.stack || e) });
    }
  };
}

// Self-signed certificate for the HTTPS listener (chatgpt.com is mapped to it
// with --host-resolver-rules; Chromium runs with --ignore-certificate-errors).
function makeCert(dir, hosts) {
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '2',
    '-subj', '/CN=' + hosts[0], '-addext', 'subjectAltName=' + hosts.map((h) => 'DNS:' + h).join(',')
  ], { stdio: 'ignore' });
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port || 0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// opts: { port, httpsPort, https (bool), certDir }
async function startServer(opts) {
  const o = opts || {};
  const state = createState();
  const handler = makeHandler(state);
  const httpServer = http.createServer(handler);
  const httpPort = await listen(httpServer, o.port);
  let httpsServer = null;
  let httpsPort = 0;
  if (o.https) {
    const dir = o.certDir || fs.mkdtempSync(path.join(os.tmpdir(), 'apu-e2e-cert-'));
    const tls = makeCert(dir, ['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com', 'chat.e2e.test']);
    httpsServer = https.createServer(tls, handler);
    httpsPort = await listen(httpsServer, o.httpsPort);
  }
  return {
    state,
    httpPort,
    httpsPort,
    close: () => Promise.all([httpServer, httpsServer].filter(Boolean).map((s) => new Promise((r) => {
      try { s.closeAllConnections && s.closeAllConnections(); } catch (e) {}
      s.close(() => r());
    })))
  };
}

module.exports = {
  startServer, SCENARIOS, classifyPayload, hasPriorityFixBlock, article, legacyEdit, todayYmd,
  ORIGINAL_HTML, GOOD_EDIT, BAD_CLAIM, LIVE_LINK, DEAD_LINK, END, LEGACY_ORIGINAL, SPANS_ORIGINAL, PRICE_SENTENCE,
  CUT_ORIGINAL, CUT_GOOD, CUT_REPLY, ECHO_SENTENCE, BAD_CLAIM_ISSUE,
  EDIT_BLOCK_LABEL, editingBlock, INVENTED_PRICE_SENTENCE, PRICE_LOST_ISSUE, INVENTED_PRICE_ISSUE,
  T_ORIGINAL, T_CUT, RENAMED_GOOD, F_ORIGINAL, F_GOOD, F_CUT, renameLastHeading, cutBeforeLastHeading,
  WP_HOST, LINK_HOST, WP_USER, WP_APP_PASSWORD
};

if (require.main === module) {
  const i = process.argv.indexOf('--port');
  startServer({ port: i > 0 ? Number(process.argv[i + 1]) : 8080 }).then((s) => {
    s.state.posts.set(101, { id: 101, slug: 'cast-iron-care', title: 'How to Care for Cast Iron', content: ORIGINAL_HTML, link: 'http://' + WP_HOST + '/cast-iron-care/' });
    console.log('fake WordPress + chat on http://127.0.0.1:' + s.httpPort + '/  (chat: /?e2e=S1, WP user ' + WP_USER + ')');
  });
}
