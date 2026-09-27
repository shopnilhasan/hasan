'use strict';
// ═══════════════════════════════════════════════════════════════════════
// run-e2e.js — END-TO-END test of Auto Post Updater Pro (v3.46.0 Safety Gate)
//
// Loads the REAL extension (/extension, unpacked) in Chromium and drives
// whole posts through it — without ChatGPT and without a real WordPress:
//
//   • server.js is a fake WordPress (REST API + Application Password) and a
//     fake AI chat website with a ChatGPT-like DOM that streams canned replies.
//   • Chromium maps chatgpt.com → the local HTTPS listener and *.e2e.test →
//     the local HTTP listener (--host-resolver-rules), so the extension runs
//     its real ChatGPT code paths (provider "chatgpt"). --provider=generic
//     serves the chat on https://chat.e2e.test instead (a custom, non-ChatGPT
//     AI website).
//   • Each scenario gets a fresh browser profile. The runner configures the
//     extension through chrome.storage (REST site with user + app password, a
//     custom web AI pointing at the fake chat, the seeded "Informational Editor
//     (Safety Gate)" prompt, Safety Gate settings, short waits), reloads the
//     REAL panel, clicks Save Configuration + Save All Settings, pastes the
//     slug and clicks Start (the panel builds and sends BATCH_START itself).
//   • It then waits for the batch to finish and checks the WordPress writes,
//     the attempt row (BATCH_STATUS), the panel's result boxes and the log.
//   • Chrome's clipboard permission is granted on the chat site (like a user
//     who once clicked "Allow"): the extension's copy-capture reads the
//     clipboard. S9 runs WITHOUT that grant on purpose.
//
// Scenarios (node run-e2e.js --list):
//   S1  good edit + fact-check pass → one write, marker stripped, links/images kept
//   S2  AI drops an image → no write, SAFETY GATE BLOCKED (IMG_COUNT)
//   S3  reply cut before <!-- APU-END --> → no write, END_MARKER_MISSING
//   S4  fact-check "fix" → fix round in a new chat (PRIORITY FIX) → pass → one write
//   S5  fact-check "reject" → no write, FACT CHECK BLOCKED
//   S6  fact-check reply has no JSON, on-error = keep → no write, FACT CHECK ERROR
//   S7  gate OFF + fact check OFF + old prompt → legacy save
//   S8  new dead external link (404) → saved with the link unwrapped
//   S9  = S2 without the clipboard grant: the post must still end (no hang)
//   S10 fact-check breaks, on-error = save → saved
//   S11 parallel batch of 3 posts: pass / gate block / dead link unwrapped
//   S12 gate block with end-of-batch retries + HTML recovery ON → 4 new chats, no recovery
//   S13 "Recover any code" from the Failed box → gate still blocks
//   S14 update mode "editor" (wp-admin Classic Editor): good edit → pasted,
//       re-read, Update clicked, one write through the editor form
//   S15 update mode "editor": AI drops an image → the editor is never touched
//   S16 legacy prompt (built-in "Single Amazon Product": no end marker, web
//       search off): the edit removes a price, adds "Last updated: <today>" and
//       a new deep link to a live page → saved (structure rules only, link kept)
//   S17 same legacy prompt, the edit drops an image → still blocked (IMG_COUNT)
//   S18 first reply drops an image → blocked; the end-of-batch retry's payload
//       carries a PRIORITY FIX note naming IMG_COUNT → good edit saved once
//   S19 the edit strips <span style> clutter (~75% of the source length) and
//       carries <!-- APU-END --> → accepted as complete and saved
//
// Usage:
//   node extension-tests/e2e/run-e2e.js [--only S1,S4] [--skip S9] [--jobs 3]
//        [--provider chatgpt|generic] [--background] [--set key=value] [--out DIR]
//        [--keep] [--verbose] [--list]
// Exit code 0 only when every selected scenario passes.
// Env: PLAYWRIGHT_PATH / CHROMIUM_PATH (see ../browser.js), E2E_OUT (= --out).
// ═══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('./server');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const EXT_DIR = path.join(REPO_ROOT, 'extension');

// ── Playwright / Chromium (shared locator with the unit tests when present) ──
function loadChromium() {
  try {
    const b = require('../browser.js');
    const r = b.loadPlaywright();
    if (r.chromium) return { chromium: r.chromium, executablePath: b.CHROMIUM_PATH };
    return { error: r.error };
  } catch (e) {}
  const pwPath = process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright';
  const exe = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  try { return { chromium: require(pwPath).chromium, executablePath: exe }; }
  catch (e) { return { error: 'Playwright not found at ' + pwPath }; }
}

// ── CLI ──
function argValue(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) {
    const eq = process.argv.find((a) => a.indexOf('--' + name + '=') === 0);
    return eq ? eq.slice(name.length + 3) : def;
  }
  const v = process.argv[i + 1];
  return (v === undefined || v.indexOf('--') === 0) ? true : v;
}
const OPTS = {
  only: String(argValue('only', '') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  skip: String(argValue('skip', '') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  list: !!argValue('list', false),
  jobs: Math.max(1, Math.min(4, Number(argValue('jobs', 3)) || 3)),
  provider: argValue('provider', 'chatgpt') === 'generic' ? 'generic' : 'chatgpt',
  background: !!argValue('background', false),
  out: argValue('out', process.env.E2E_OUT || path.join(os.tmpdir(), 'apu-e2e-' + new Date().toISOString().replace(/[:.]/g, '-'))),
  keep: !!argValue('keep', false),
  // --set key=value (repeatable): override a panel storage setting in every
  // selected scenario, e.g. --set factCheckOnError=save (exploratory runs).
  set: process.argv.reduce((acc, a, i, all) => {
    const v = a === '--set' ? all[i + 1] : (a.indexOf('--set=') === 0 ? a.slice(6) : null);
    const m = v ? /^([A-Za-z0-9_]+)=(.*)$/.exec(v) : null;
    if (m) acc[m[1]] = m[2];
    return acc;
  }, {}),
  verbose: !!argValue('verbose', false)
};

function localDateYmd(d) {
  const t = d || new Date();
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function vlog() { if (OPTS.verbose) console.log.apply(console, ['   ·'].concat([].slice.call(arguments))); }

// Text between the two banner lines "…  <LABEL> START  …" and "…  <LABEL> END  …".
function bannerSection(payload, label) {
  const s = String(payload || '');
  const a = s.indexOf(label + ' START');
  const z = s.indexOf(label + ' END');
  if (a < 0 || z < 0 || z < a) return null;
  const from = s.indexOf('\n', a);
  const to = s.lastIndexOf('\n', z);
  return s.slice(from + 1, to).trim();
}
// Where two strings first differ (for readable assertion messages).
function firstDiff(a, b) {
  const x = String(a);
  const y = String(b);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  if (i === x.length && i === y.length) return '';
  return 'first difference at char ' + i + ': got «' + x.slice(Math.max(0, i - 40), i + 60) + '» expected «' + y.slice(Math.max(0, i - 40), i + 60) + '»';
}

// ═══════════════════════════════════════════════════════════════════════
// Scenarios: setup + expectations
// ═══════════════════════════════════════════════════════════════════════
const EDIT_WITH_LIVE_LINK = S.article({ edited: true, whyExtra: ' The <a href="' + S.LIVE_LINK + '">care notes from the pan maker</a> give the same advice.' });
const EDIT_WITH_DEAD_LINK_UNWRAPPED = S.article({ edited: true, whyExtra: ' Many old myths about cast iron are collected in this myth-busting article.' });

const IMG_SRCS = [
  'http://' + S.WP_HOST + '/wp-content/uploads/2026/03/seasoned-cast-iron-pan.jpg',
  'http://' + S.WP_HOST + '/wp-content/uploads/2026/03/oiling-cast-iron-skillet.jpg'
];
const ORIGINAL_LINKS = [
  'http://' + S.WP_HOST + '/seasoning-basics/',
  'http://' + S.LINK_HOST + '/ok/lodge-seasoning-guide'
];

// Scenario list. setup: panel/storage settings; check(ctx, t): assertions.
const SCENARIOS = [
  {
    id: 'S1', title: S.SCENARIOS.S1.title, prompt: 'p_sg_editor',
    check(c, t) {
      t.eq(c.writes.length, 1, 'exactly one WordPress write');
      const saved = c.writes[0] ? c.writes[0].content : '';
      t.ok(saved.indexOf('APU-END') < 0, 'saved content has no <!-- APU-END -->');
      t.same(saved, EDIT_WITH_LIVE_LINK.trim(), 'saved content = the AI edit (marker stripped, nothing else changed)');
      IMG_SRCS.forEach((src) => t.ok(saved.indexOf('src="' + src + '"') >= 0, 'image kept: ' + src.split('/').pop()));
      ORIGINAL_LINKS.forEach((href) => t.ok(saved.indexOf('href="' + href + '"') >= 0, 'original link kept: ' + href));
      t.ok(saved.indexOf('href="' + S.LIVE_LINK + '"') >= 0, 'new LIVE external link kept');
      t.ok(c.linkRequests.some((r) => r.path === '/ok/cast-iron-care-notes'), 'the link check really fetched the new link');
      t.row(c, 'updated');
      t.ok(c.row && c.row.factCheck && c.row.factCheck.verdict === 'pass', 'row.factCheck.verdict = pass');
      t.ok(c.row && !c.row.gate, 'row.gate is empty on success');
      t.eq(c.editorChats.length, 1, 'one editor chat');
      t.eq(c.factChats.length, 1, 'one fact-check chat');
      const ep = c.editorChats[0] ? c.editorChats[0].payload : '';
      t.ok(ep.indexOf('[[') < 0, 'editor payload: every [[TOKEN]] substituted');
      t.ok(ep.indexOf("Today's date (YYYY-MM-DD): " + localDateYmd()) >= 0, 'editor payload: [[TODAY]] = today');
      t.ok(ep.indexOf('Site domain(s) (comma-separated): ' + S.WP_HOST) >= 0, 'editor payload: [[SITE_DOMAIN]] = site host');
      t.ok(ep.indexOf('Web search available (yes / no; default: no): yes') >= 0, 'editor payload: [[WEB_SEARCH]] = yes (seeded prompt allows search)');
      t.ok(ep.indexOf('Post title (H1, set in WordPress): ' + c.post.title) >= 0, 'editor payload: [[POST_TITLE]] = the post title');
      t.same(bannerSection(ep, 'ARTICLE HTML'), S.ORIGINAL_HTML.trim(), 'editor payload carries the original article');
      const fp = c.factChats[0] ? c.factChats[0].payload : '';
      t.same(bannerSection(fp, 'ORIGINAL ARTICLE HTML'), S.ORIGINAL_HTML.trim(), 'fact-check payload: ORIGINAL block = the original');
      t.same(bannerSection(fp, 'EDITED ARTICLE HTML'), EDIT_WITH_LIVE_LINK.trim(), 'fact-check payload: EDITED block = the gate-approved edit (no marker)');
      t.ok(c.factChats[0] && c.editorChats[0] && c.factChats[0].conversationId !== c.editorChats[0].conversationId, 'fact-check ran in a NEW chat');
      t.log(c, /Safety Gate PASSED/, 'log: Safety Gate PASSED');
      t.log(c, /Fact check PASSED/, 'log: Fact check PASSED');
      t.log(c, /POST UPDATED THROUGH REST API/, 'log: POST UPDATED THROUGH REST API');
      t.ok(/Safety Gate: ON/.test(c.confirmText), 'Start confirm dialog says "Safety Gate: ON"');
      t.panel(c, 'processedList', [c.slug], 'panel: row in the Successful box');
    }
  },
  {
    id: 'S2', title: S.SCENARIOS.S2.title, prompt: 'p_sg_editor',
    check(c, t) {
      t.eq(c.writes.length, 0, 'NO WordPress write');
      t.same(c.post.content, S.ORIGINAL_HTML, 'WordPress still holds the original');
      t.row(c, 'failed');
      t.ok(/^SAFETY GATE BLOCKED: /.test(c.row && c.row.message || ''), 'row message starts with SAFETY GATE BLOCKED');
      t.ok(/IMG_COUNT/.test(c.row && c.row.message || ''), 'row message names IMG_COUNT');
      t.ok(c.row && c.row.gate && c.row.gate.codes.indexOf('IMG_COUNT') >= 0, 'row.gate.codes contains IMG_COUNT');
      t.ok(/The post was NOT changed/.test(c.row && c.row.message || ''), 'row message says the post was NOT changed');
      t.eq(c.factChats.length, 0, 'no fact-check after a gate block');
      t.log(c, /Gate error — IMG_COUNT/, 'log: Gate error — IMG_COUNT');
      t.log(c, /SAFETY GATE BLOCKED the AI edit/, 'log: SAFETY GATE BLOCKED');
      t.panel(c, 'failedList', [c.slug, '🛡 Gate', 'IMG_COUNT'], 'panel: Failed box row with the gate badge');
    }
  },
  {
    id: 'S3', title: S.SCENARIOS.S3.title, prompt: 'p_sg_editor',
    check(c, t) {
      t.eq(c.writes.length, 0, 'NO WordPress write');
      t.same(c.post.content, S.ORIGINAL_HTML, 'WordPress still holds the original');
      t.row(c, 'failed');
      t.ok(/^SAFETY GATE BLOCKED: /.test(c.row && c.row.message || ''), 'row message starts with SAFETY GATE BLOCKED');
      t.ok(c.row && c.row.gate && c.row.gate.codes.indexOf('END_MARKER_MISSING') >= 0, 'row.gate.codes contains END_MARKER_MISSING');
      t.eq(c.factChats.length, 0, 'no fact-check after a gate block');
      t.log(c, /END_MARKER_MISSING/, 'log names END_MARKER_MISSING');
      t.panel(c, 'failedList', [c.slug, 'END_MARKER_MISSING'], 'panel: Failed box row names END_MARKER_MISSING');
    }
  },
  {
    id: 'S4', title: S.SCENARIOS.S4.title, prompt: 'p_sg_editor',
    check(c, t) {
      t.eq(c.writes.length, 1, 'exactly one WordPress write (after the fix round)');
      const saved = c.writes[0] ? c.writes[0].content : '';
      t.same(saved, S.GOOD_EDIT.trim(), 'saved content = the fix-round edit');
      t.ok(saved.indexOf(S.BAD_CLAIM) < 0, 'the claim the fact-check flagged is NOT saved');
      t.eq(c.editorChats.length, 2, 'two editor chats (first edit + fix round)');
      t.eq(c.factChats.length, 2, 'two fact-check chats');
      const [e1, e2] = c.editorChats;
      t.ok(e1 && e2 && e1.conversationId !== e2.conversationId, 'the fix round used a NEW chat');
      t.ok(e2 && S.hasPriorityFixBlock(e2.payload), 'fix-round payload carries a PRIORITY FIX block');
      t.ok(e2 && e2.payload.indexOf('Soaking the pan overnight in soapy water') >= 0, 'fix-round note quotes the flagged text');
      t.ok(e1 && !S.hasPriorityFixBlock(e1.payload), 'first editor payload has no PRIORITY FIX block');
      t.ok(e2 && e2.payload.indexOf('A fact-check of your previous edit') > e2.payload.lastIndexOf('REMINDER:'), 'the fix note comes after the prompt\'s REMINDER');
      t.same(e2 && bannerSection(e2.payload, 'ARTICLE HTML'), S.ORIGINAL_HTML.trim(), 'fix round regenerates from the ORIGINAL article');
      t.ok(c.factChats[0] && /"verdict": "fix"/.test(c.factChats[0].reply), 'first fact-check said fix');
      t.ok(c.factChats[1] && /"verdict": "pass"/.test(c.factChats[1].reply), 'second fact-check said pass');
      t.same(c.factChats[1] && bannerSection(c.factChats[1].payload, 'EDITED ARTICLE HTML'), S.GOOD_EDIT.trim(), 'second fact-check saw the fix-round edit');
      t.row(c, 'updated');
      t.ok(c.row && c.row.factCheck && c.row.factCheck.verdict === 'pass' && c.row.factCheck.fixRound === true, 'row.factCheck = pass after the fix round');
      t.log(c, /Fact-check fix round/, 'log: Fact-check fix round');
      t.log(c, /Fact check PASSED \(verdict "pass", after one fix round\)/, 'log: Fact check PASSED after one fix round');
      t.panel(c, 'processedList', [c.slug], 'panel: row in the Successful box');
    }
  },
  {
    id: 'S5', title: S.SCENARIOS.S5.title, prompt: 'p_sg_editor',
    check(c, t) {
      t.eq(c.writes.length, 0, 'NO WordPress write');
      t.same(c.post.content, S.ORIGINAL_HTML, 'WordPress still holds the original');
      t.row(c, 'failed');
      t.ok(/^FACT CHECK BLOCKED: /.test(c.row && c.row.message || ''), 'row message starts with FACT CHECK BLOCKED');
      t.ok(!/AUDIT ISSUES/.test(c.row && c.row.message || ''), 'row message never says AUDIT ISSUES');
      t.ok(c.row && c.row.factCheck && c.row.factCheck.verdict === 'reject', 'row.factCheck.verdict = reject');
      t.eq(c.editorChats.length, 1, 'no fix round after a reject');
      t.eq(c.factChats.length, 1, 'one fact-check chat');
      t.log(c, /FACT CHECK BLOCKED the edit/, 'log: FACT CHECK BLOCKED');
      t.panel(c, 'failedList', [c.slug, '🔎 Fact check'], 'panel: Failed box row with the fact-check badge');
    }
  },
  {
    id: 'S6', title: S.SCENARIOS.S6.title, prompt: 'p_sg_editor',
    check(c, t) {
      t.eq(c.writes.length, 0, 'NO WordPress write (factCheckOnError = keep)');
      t.same(c.post.content, S.ORIGINAL_HTML, 'WordPress still holds the original');
      t.row(c, 'failed');
      t.ok(/^FACT CHECK ERROR: /.test(c.row && c.row.message || ''), 'row message starts with FACT CHECK ERROR');
      t.ok(c.row && c.row.factCheck && c.row.factCheck.verdict === 'error', 'row.factCheck.verdict = error');
      t.eq(c.factChats.length, 1, 'one fact-check chat');
      t.log(c, /The fact check itself failed .*keeping the original/, 'log: fact check failed → keeping the original');
      t.panel(c, 'failedList', [c.slug, 'Fact check error'], 'panel: Failed box row with the fact-check-error badge');
    }
  },
  {
    id: 'S7', title: S.SCENARIOS.S7.title, prompt: 'p_info_table',
    storage: { gateEnabled: 'off', factCheck: 'off' },
    check(c, t) {
      t.eq(c.writes.length, 1, 'exactly one WordPress write');
      const saved = c.writes[0] ? c.writes[0].content : '';
      t.same(saved, S.GOOD_EDIT.trim(), 'saved content = the code block (legacy extraction)');
      t.eq(c.factChats.length, 0, 'no fact-check with the gate OFF');
      t.eq(c.editorChats.length, 1, 'one editor chat');
      const ep = c.editorChats[0] ? c.editorChats[0].payload : '';
      t.ok(ep.indexOf('APU-END') < 0, 'old prompt: no end-marker contract in the payload');
      t.row(c, 'updated');
      t.ok(c.row && !c.row.gate && !c.row.factCheck, 'row has no gate / fact-check data');
      t.log(c, /Safety Gate OFF, fact check OFF/, 'log: settings line says Safety Gate OFF, fact check OFF');
      t.notLog(c, /Safety Gate|🛡|🔎 Fact|Fact check|fact-check/i, 'log: no Safety Gate / fact-check step ran', /Settings:/);
      t.log(c, /POST UPDATED THROUGH REST API/, 'log: POST UPDATED THROUGH REST API');
      t.ok(/Safety Gate: OFF/.test(c.confirmText), 'Start confirm dialog says "Safety Gate: OFF"');
      t.panel(c, c.row && /AUDIT ISSUES/.test(c.row.message) ? 'auditIssuesList' : 'processedList', [c.slug], 'panel: row in the Successful/Audit box');
    }
  },
  {
    id: 'S8', title: S.SCENARIOS.S8.title, prompt: 'p_sg_editor',
    check(c, t) {
      t.eq(c.writes.length, 1, 'exactly one WordPress write');
      const saved = c.writes[0] ? c.writes[0].content : '';
      t.ok(saved.indexOf(S.DEAD_LINK) < 0, 'dead link is NOT saved');
      t.ok(saved.indexOf('collected in this myth-busting article.') >= 0, 'dead link unwrapped: its words are kept');
      t.same(saved, EDIT_WITH_DEAD_LINK_UNWRAPPED.trim(), 'saved content = the edit with only the dead link unwrapped');
      t.ok(c.linkRequests.some((r) => r.path === '/dead/cast-iron-myths' && r.status === 404), 'the link check really fetched the dead link (404)');
      t.row(c, 'updated');
      t.ok(c.row && c.row.factCheck && c.row.factCheck.verdict === 'pass', 'row.factCheck.verdict = pass');
      const fp = c.factChats[0] ? c.factChats[0].payload : '';
      t.ok(fp && (bannerSection(fp, 'EDITED ARTICLE HTML') || '').indexOf(S.DEAD_LINK) < 0, 'fact-check saw the edit WITHOUT the dead link');
      t.log(c, new RegExp('Removed link: ' + S.DEAD_LINK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\(dead\\)'), 'log: Removed link … (dead)');
      t.log(c, /Minor: \[LOW/, 'log: the low fact-check issue is logged as Minor');
      t.panel(c, 'processedList', [c.slug], 'panel: row in the Successful box');
    }
  },
  {
    id: 'S10', title: S.SCENARIOS.S10.title, prompt: 'p_sg_editor',
    storage: { factCheckOnError: 'save' },
    check(c, t) {
      t.eq(c.writes.length, 1, 'exactly one WordPress write (the fact check broke, setting = save)');
      t.same(c.writes[0] ? c.writes[0].content : '', S.GOOD_EDIT.trim(), 'saved content = the gate-approved edit');
      t.row(c, 'updated');
      t.ok(c.row && c.row.factCheck && c.row.factCheck.verdict === 'error' && !!c.row.factCheck.error, 'row.factCheck records the error');
      t.log(c, /The fact check itself failed .*saving the gate-approved edit anyway/, 'log: fact check failed → saving anyway');
      t.ok(/saves anyway if the check breaks/.test(c.confirmText), 'Start confirm dialog names the "save anyway" setting');
      t.panel(c, 'processedList', [c.slug], 'panel: row in the Successful box');
    }
  },
  {
    id: 'S11', title: S.SCENARIOS.S11.title, prompt: 'p_sg_editor', posts: ['A', 'B', 'C'],
    storage: { parallelCount: '3' },
    check(c, t) {
      const [a, b, cc] = c.items;
      t.log(c, /PARALLEL MODE: up to 3 posts/, 'log: parallel mode with 3 posts');
      t.eq(a.writes.length, 1, 'A: one write');
      t.same(a.writes[0] ? a.writes[0].content : '', EDIT_WITH_LIVE_LINK.trim(), 'A: saved its own edit (live link kept)');
      t.ok(a.row && a.row.result === 'updated' && a.row.factCheck && a.row.factCheck.verdict === 'pass', 'A: row updated, fact check pass');
      t.eq(b.writes.length, 0, 'B: NO write');
      t.same(b.post.content, S.ORIGINAL_HTML, 'B: WordPress still holds the original');
      t.ok(b.row && b.row.result === 'failed' && b.row.gate && b.row.gate.codes.indexOf('IMG_COUNT') >= 0, 'B: row failed with IMG_COUNT', JSON.stringify(b.row && [b.row.result, b.row.message]).slice(0, 300));
      t.eq(cc.writes.length, 1, 'C: one write');
      t.same(cc.writes[0] ? cc.writes[0].content : '', EDIT_WITH_DEAD_LINK_UNWRAPPED.trim(), 'C: saved its own edit with the dead link unwrapped');
      t.ok(cc.row && cc.row.result === 'updated', 'C: row updated');
      t.eq(c.editorChats.length, 3, 'three editor chats');
      t.eq(c.factChats.length, 2, 'two fact-check chats (A and C; B was blocked by the gate)');
      const edited = c.factChats.map((x) => bannerSection(x.payload, 'EDITED ARTICLE HTML') || '');
      t.ok(edited.some((e) => e === EDIT_WITH_LIVE_LINK.trim()) && edited.some((e) => e === EDIT_WITH_DEAD_LINK_UNWRAPPED.trim()),
        'each fact check saw its own post\'s gate-approved edit (no cross-post mix-up)');
      const sessions = c.items.map((it) => it.row && it.row.aiSessionUrl).filter(Boolean);
      t.ok(sessions.length === 3 && new Set(sessions).size === 3, 'three different AI session links', JSON.stringify(sessions));
      t.panel(c, 'failedList', [b.slug, 'IMG_COUNT'], 'panel: B in the Failed box');
      t.panel(c, 'processedList', [a.slug, cc.slug], 'panel: A and C in the Successful box');
    }
  },
  {
    // Spec 2.7: gate blocks go through the normal retry machinery (here: the
    // end-of-batch pass with 2 retries = 3 more attempts, each in a NEW chat),
    // but HTML recovery (re-reading the same chat) is skipped for them.
    id: 'S12', title: S.SCENARIOS.S12.title, prompt: 'p_sg_editor',
    storage: { retryMode: 'end', maxRetries: '2', htmlRecoveryFailed: 'on' },
    check(c, t) {
      t.eq(c.writes.length, 0, 'NO WordPress write after 4 blocked attempts');
      t.same(c.post.content, S.ORIGINAL_HTML, 'WordPress still holds the original');
      t.eq(c.editorChats.length, 4, 'four editor chats (1 + end-of-batch pass with 2 retries)');
      t.eq(new Set(c.editorChats.map((x) => x.conversationId)).size, c.editorChats.length, 'every attempt used a NEW chat');
      const reopened = c.chatPageLoads.filter((r) => /^\/c\//.test(r.path));
      t.eq(reopened.length, 0, 'no saved chat was reopened (HTML recovery skipped for gate blocks)');
      t.eq(c.factChats.length, 0, 'no fact-check after gate blocks');
      t.row(c, 'failed');
      t.ok(c.row && c.row.gate && c.row.gate.codes.indexOf('IMG_COUNT') >= 0, 'final row.gate.codes contains IMG_COUNT');
      t.log(c, /Queued "cast-iron-care-s12" for the end-of-batch retry pass/, 'log: queued for the end-of-batch retry pass');
      t.log(c, /Retry 2\/2 for "cast-iron-care-s12"/, 'log: Retry 2/2');
      t.notLog(c, /HTML recovery|reopening the AI session/i, 'log: no HTML recovery attempt');
      t.eq(c.logLines.filter((l) => /SAFETY GATE BLOCKED the AI edit/.test(l)).length, 4, 'log: the gate blocked all four attempts');
    }
  },
  {
    // Spec 2.5: the recovery branch (recoverFromUrl, any-code mode) still runs
    // the gate and is NOT relaxed by recoverAnyCode. First batch = S2 (blocked);
    // then the Failed box's own "Recover any code" button reopens that chat.
    id: 'S13', title: S.SCENARIOS.S13.title, prompt: 'p_sg_editor',
    async followUp(panel, c) {
      await panel.bringToFront();
      let clicked = false;
      for (let i = 0; i < 30 && !clicked; i++) {
        clicked = await panel.evaluate((slug) => {
          const card = Array.from(document.querySelectorAll('#failedList .processed-item')).find((el) => (el.textContent || '').indexOf(slug) >= 0);
          const btn = card && card.querySelector('[data-recover-any]');
          if (!btn) return false;
          btn.click();
          return true;
        }, c.slug);
        if (!clicked) await sleep(1000);
      }
      if (!clicked) throw new Error('no "Recover any code" button on the Failed row of ' + c.slug);
    },
    check(c, t) {
      const first = c.firstRows && c.firstRows[0];
      t.ok(first && first.result === 'failed' && first.gate && first.gate.codes.indexOf('IMG_COUNT') >= 0, 'first batch: blocked with IMG_COUNT');
      t.eq(c.writes.length, 0, 'NO WordPress write in either batch');
      t.same(c.post.content, S.ORIGINAL_HTML, 'WordPress still holds the original');
      t.eq(c.editorChats.length, 1, 'recovery sent no new prompt (one editor chat in total)');
      const conv = c.editorChats[0] && c.editorChats[0].conversationId;
      t.ok(!!conv && c.chatPageLoads.some((r) => r.path.indexOf('/c/' + conv) === 0), 'recovery reopened the saved chat /c/<id>');
      t.log(c, /HTML recovery -- reopening the AI session.*ANY CODE mode/, 'log: recovery in ANY CODE mode');
      t.log(c, /accepted it through the manual ANY CODE override/, 'log: any-code recovery accepted the code box');
      t.eq(c.logLines.filter((l) => /SAFETY GATE BLOCKED the AI edit/.test(l)).length, 2, 'log: the gate blocked the edit in both batches');
      t.row(c, 'failed');
      t.ok(c.row && c.row.gate && c.row.gate.codes.indexOf('IMG_COUNT') >= 0, 'recovery row.gate.codes contains IMG_COUNT');
      t.eq(c.factChats.length, 0, 'no fact-check after gate blocks');
      t.panel(c, 'failedList', [c.slug, 'IMG_COUNT'], 'panel: still in the Failed box');
    }
  },
  {
    // Update mode "editor": the post is read from and written back through the
    // wp-admin Classic Editor (paste, 95% re-read, Update click, ?message=1).
    id: 'S14', title: S.SCENARIOS.S14.title, prompt: 'p_sg_editor', updateMode: 'editor',
    check(c, t) {
      t.eq(c.writes.length, 1, 'exactly one WordPress write');
      const w = c.writes[0] || {};
      t.eq(w.via, 'editor', 'the write came from the Classic Editor form (not the REST API)');
      t.same(w.content, EDIT_WITH_LIVE_LINK.trim(), 'saved content = the AI edit (marker stripped, nothing else changed)');
      t.ok(String(w.content || '').indexOf('APU-END') < 0, 'saved content has no <!-- APU-END -->');
      t.ok(c.wpAdminRequests.some((r) => r.method === 'GET' && /action=edit/.test(r.path)), 'the wp-admin editor page was opened');
      t.row(c, 'updated');
      t.ok(c.row && c.row.factCheck && c.row.factCheck.verdict === 'pass', 'row.factCheck.verdict = pass');
      t.eq(c.factChats.length, 1, 'one fact-check chat');
      t.same(bannerSection(c.factChats[0] ? c.factChats[0].payload : '', 'ORIGINAL ARTICLE HTML'), S.ORIGINAL_HTML.trim(), 'fact-check payload: ORIGINAL block = the article read from the editor');
      t.log(c, /Safety Gate PASSED/, 'log: Safety Gate PASSED');
      t.log(c, /Fact check PASSED/, 'log: Fact check PASSED');
      t.log(c, /Paste verified/, 'log: Paste verified');
      t.log(c, /POST UPDATED ON WORDPRESS/, 'log: POST UPDATED ON WORDPRESS');
      t.ok(!c.leftoverEditorTabs.length, 'the WordPress editor tab was closed', c.leftoverEditorTabs.join(', '));
      t.panel(c, 'processedList', [c.slug], 'panel: row in the Successful box');
    }
  },
  {
    id: 'S15', title: S.SCENARIOS.S15.title, prompt: 'p_sg_editor', updateMode: 'editor',
    check(c, t) {
      t.eq(c.writes.length, 0, 'NO WordPress write');
      t.same(c.post.content, S.ORIGINAL_HTML, 'WordPress still holds the original');
      t.eq(c.wpAdminRequests.filter((r) => r.method === 'POST').length, 0, 'the editor form was never submitted');
      t.row(c, 'failed');
      t.ok(c.row && c.row.gate && c.row.gate.codes.indexOf('IMG_COUNT') >= 0, 'row.gate.codes contains IMG_COUNT');
      t.eq(c.factChats.length, 0, 'no fact-check after a gate block');
      t.notLog(c, /Step 10: Pasting new HTML|UPDATE clicked/, 'log: nothing was pasted into the editor, Update was never clicked');
      t.ok(!c.leftoverEditorTabs.length, 'the WordPress editor tab was closed', c.leftoverEditorTabs.join(', '));
      t.panel(c, 'failedList', [c.slug, 'IMG_COUNT'], 'panel: Failed box row names IMG_COUNT');
    }
  },
  {
    // A prompt that was NOT written for the Safety Gate (the built-in "Single
    // Amazon Product" prompt: no <!-- APU-END -->, web search off) gets the
    // gate's structure rules only: a removed price, a "Last updated" line with
    // today's date and a new deep link are not blocked, and the new link is
    // still link-checked (alive → kept).
    id: 'S16', title: S.SCENARIOS.S16.title, prompt: 'p_single_amazon', original: S.LEGACY_ORIGINAL,
    check(c, t) {
      const expected = S.legacyEdit();
      t.eq(c.writes.length, 1, 'exactly one WordPress write');
      const saved = c.writes[0] ? c.writes[0].content : '';
      t.same(saved, expected.trim(), 'saved content = the legacy edit (nothing unwrapped, nothing else changed)');
      t.ok(S.LEGACY_ORIGINAL.indexOf('$25') >= 0 && saved.indexOf('$25') < 0, 'the price the prompt removes on purpose stays removed');
      t.ok(saved.indexOf('Last updated: ' + localDateYmd()) >= 0, 'the "Last updated" line with today\'s date is saved');
      t.ok(saved.indexOf('href="' + S.LIVE_LINK + '"') >= 0, 'the new deep link to a live page is kept');
      IMG_SRCS.forEach((src) => t.ok(saved.indexOf('src="' + src + '"') >= 0, 'image kept: ' + src.split('/').pop()));
      ORIGINAL_LINKS.forEach((href) => t.ok(saved.indexOf('href="' + href + '"') >= 0, 'original link kept: ' + href));
      t.ok(c.linkRequests.some((r) => r.path === '/ok/cast-iron-care-notes'), 'the link check really fetched the new deep link');
      const ep = c.editorChats[0] ? c.editorChats[0].payload : '';
      t.ok(ep.indexOf('APU-END') < 0, 'legacy prompt: no end-marker contract in the payload');
      t.same(bannerSection(ep, 'ARTICLE HTML'), S.LEGACY_ORIGINAL.trim(), 'editor payload carries the original (with the price)');
      t.eq(c.editorChats.length, 1, 'one editor chat');
      t.row(c, 'updated');
      t.ok(c.row && c.row.factCheck && c.row.factCheck.verdict === 'pass', 'row.factCheck.verdict = pass');
      t.log(c, /Gate rules: structure rules — this prompt is not a Safety Gate prompt/, 'log: structure rules for a prompt that is not a Safety Gate prompt');
      t.notLog(c, /Gate rules: full rules/, 'log: never the full rule set');
      t.notLog(c, /Removed link/, 'log: no link was removed');
      t.log(c, /Safety Gate PASSED/, 'log: Safety Gate PASSED');
      t.ok(/structure rules/.test(c.confirmText), 'Start confirm dialog explains the structure rules', c.confirmText);
      t.panel(c, 'processedList', [c.slug], 'panel: row in the Successful box');
    }
  },
  {
    // The structure rules still protect images with the same legacy prompt.
    id: 'S17', title: S.SCENARIOS.S17.title, prompt: 'p_single_amazon', original: S.LEGACY_ORIGINAL,
    check(c, t) {
      t.eq(c.writes.length, 0, 'NO WordPress write');
      t.same(c.post.content, S.LEGACY_ORIGINAL, 'WordPress still holds the original');
      t.row(c, 'failed');
      t.ok(/^SAFETY GATE BLOCKED: /.test(c.row && c.row.message || ''), 'row message starts with SAFETY GATE BLOCKED');
      const codes = (c.row && c.row.gate && c.row.gate.codes) || [];
      t.ok(codes.indexOf('IMG_COUNT') >= 0, 'row.gate.codes contains IMG_COUNT', codes.join(','));
      t.ok(!codes.some((x) => /RESEARCH|NUMBER_MISSING/.test(x)), 'no research-rule code (structure rules only)', codes.join(','));
      t.eq(c.factChats.length, 0, 'no fact-check after a gate block');
      t.log(c, /Gate rules: structure rules/, 'log: structure rules');
      t.log(c, /Gate error — IMG_COUNT/, 'log: Gate error — IMG_COUNT');
      t.panel(c, 'failedList', [c.slug, 'IMG_COUNT'], 'panel: Failed box row names IMG_COUNT');
    }
  },
  {
    // Automatic retries tell the AI why: the end-of-batch retry pass (the
    // default retry mode) sends the gate reasons as a PRIORITY FIX note.
    id: 'S18', title: S.SCENARIOS.S18.title, prompt: 'p_sg_editor',
    storage: { retryMode: 'end', maxRetries: '1' },
    check(c, t) {
      const FIX_RE = /\u2550{3,}[ \t]+PRIORITY FIX\b/;
      t.eq(c.editorChats.length, 2, 'two editor chats (first attempt + one automatic retry)');
      const [e1, e2] = c.editorChats;
      t.ok(e1 && !S.hasPriorityFixBlock(e1.payload), 'first payload has no PRIORITY FIX block');
      t.ok(e2 && S.hasPriorityFixBlock(e2.payload), 'the retry payload carries a PRIORITY FIX block');
      const note = e2 ? e2.payload.slice(Math.max(0, e2.payload.search(FIX_RE))) : '';
      t.ok(/IMG_COUNT/.test(note), 'the PRIORITY FIX note names IMG_COUNT');
      t.ok(/REJECTED by the automatic Safety Gate/.test(note), 'the note says the Safety Gate rejected the previous edit');
      t.ok(/Keep every image of the original/.test(note), 'the note says what to do (keep every image)');
      t.ok(note.length < 3300, 'the note is short (' + note.length + ' chars)');
      t.eq(e2 ? (e2.payload.match(new RegExp(FIX_RE.source, 'g')) || []).length : 0, 1, 'exactly one PRIORITY FIX block');
      t.ok(e1 && e2 && e1.conversationId !== e2.conversationId, 'the retry used a NEW chat');
      t.same(e2 && bannerSection(e2.payload, 'ARTICLE HTML'), S.ORIGINAL_HTML.trim(), 'the retry edits the ORIGINAL article');
      t.eq(c.writes.length, 1, 'saved exactly once');
      t.same(c.writes[0] ? c.writes[0].content : '', S.GOOD_EDIT.trim(), 'saved content = the retry\'s good edit');
      t.row(c, 'updated');
      t.eq(c.factChats.length, 1, 'one fact check (only the good edit reached it)');
      t.log(c, /Queued "cast-iron-care-s18" for the end-of-batch retry pass/, 'log: queued for the end-of-batch retry pass');
      t.log(c, /The retry tells the AI why the previous edit was rejected \(Safety Gate: [A-Z_, ]*IMG_COUNT/, 'log: the retry attached the gate reasons');
      t.eq(c.logLines.filter((l) => /SAFETY GATE BLOCKED the AI edit/.test(l)).length, 1, 'log: the gate blocked only the first attempt');
      t.panel(c, 'processedList', [c.slug], 'panel: row in the Successful box');
    }
  },
  {
    // End-marker-aware completeness: cleaning up <span style> clutter shrinks
    // the HTML below the 85% length minimum; the reply carries <!-- APU-END -->
    // so it is not treated as cut off (the gate still checks the words).
    id: 'S19', title: S.SCENARIOS.S19.title, prompt: 'p_sg_editor', original: S.SPANS_ORIGINAL,
    check(c, t) {
      const cov = S.GOOD_EDIT.length / S.SPANS_ORIGINAL.length;
      t.ok(cov < 0.8, 'the edit is ' + Math.round(cov * 100) + '% of the source length (below the 85% completeness minimum)');
      t.eq(c.writes.length, 1, 'exactly one WordPress write');
      const saved = c.writes[0] ? c.writes[0].content : '';
      t.same(saved, S.GOOD_EDIT.trim(), 'saved content = the cleaned-up edit (marker stripped)');
      t.ok(saved.indexOf('<span style=') < 0, 'the span clutter is gone');
      IMG_SRCS.forEach((src) => t.ok(saved.indexOf('src="' + src + '"') >= 0, 'image kept: ' + src.split('/').pop()));
      t.eq(c.editorChats.length, 1, 'one editor chat (no continue prompt, no retry)');
      t.row(c, 'updated');
      t.log(c, /Code box COMPLETE at \d+ chars \(\d+% of source/, 'log: the code box was accepted as complete');
      t.log(c, /accepted because it carries the <!-- APU-END --> end marker/, 'log: the end-marker exception was used');
      t.notLog(c, /looks truncated|looked incomplete|asking the AI to continue|Output looks cut/i, 'log: no truncation handling');
      t.log(c, /Safety Gate PASSED/, 'log: Safety Gate PASSED');
      t.panel(c, 'processedList', [c.slug], 'panel: row in the Successful box');
    }
  },
  {
    // Same AI replies as S2, but the browser profile has NOT allowed clipboard
    // access on the chat site (a fresh Chrome profile). The edit is < 98% of
    // the source, so waitForAIResponse's preferCopyIfLonger clicks the code
    // card's Copy button and captureCopyButtonText calls clipboard.readText().
    // Unattended, the post must still end (blocked, nothing saved) — the
    // extension's own AI timeout is 120 s here, so 5 minutes is generous.
    id: 'S9', title: S.SCENARIOS.S9.title, prompt: 'p_sg_editor', noClipboardGrant: true, deadlineMin: 5,
    check(c, t) {
      t.eq(c.writes.length, 0, 'NO WordPress write');
      t.same(c.post.content, S.ORIGINAL_HTML, 'WordPress still holds the original');
      t.row(c, 'failed');
      t.ok(c.row && c.row.gate && c.row.gate.codes.indexOf('IMG_COUNT') >= 0, 'row.gate.codes contains IMG_COUNT');
    }
  }
];

// ═══════════════════════════════════════════════════════════════════════
// Assertion collector
// ═══════════════════════════════════════════════════════════════════════
function makeChecker() {
  const results = [];
  const add = (ok, name, detail) => { results.push({ ok: !!ok, name, detail: ok ? '' : (detail || '') }); };
  const t = {
    results,
    ok: (cond, name, detail) => add(cond, name, detail),
    eq: (got, want, name) => add(got === want, name, 'got ' + JSON.stringify(got) + ', expected ' + JSON.stringify(want)),
    same: (got, want, name) => {
      const g = got === null || got === undefined ? '' : String(got).trim();
      add(g === String(want).trim(), name, firstDiff(g, String(want).trim()) || ('got ' + g.length + ' chars'));
    },
    row: (c, result) => add(c.row && c.row.result === result, 'attempt row result = ' + result,
      c.row ? ('got ' + c.row.result + ': ' + String(c.row.message).slice(0, 300)) : 'no attempt row'),
    log: (c, re, name) => add(c.logLines.some((l) => re.test(l)), name, 'no log line matches ' + re),
    notLog: (c, re, name, except) => {
      const bad = c.logLines.filter((l) => re.test(l) && !(except && except.test(l)));
      add(!bad.length, name, bad.slice(0, 3).join(' | '));
    },
    panel: (c, listId, needles, name) => {
      const text = (c.panelLists && c.panelLists[listId]) || '';
      const missing = needles.filter((n) => text.indexOf(n) < 0);
      add(!missing.length, name, 'missing ' + JSON.stringify(missing) + ' in #' + listId + ': ' + text.slice(0, 300));
    }
  };
  return t;
}

// ═══════════════════════════════════════════════════════════════════════
// One scenario = one fresh browser
// ═══════════════════════════════════════════════════════════════════════
async function runScenario(sc, env) {
  const started = Date.now();
  // One or more posts (S11 runs a parallel batch of three).
  const base = 100 + Number(sc.id.slice(1)) * 10;
  const items = (sc.posts || ['']).map((key, i) => {
    const suffix = key ? '-' + key.toLowerCase() : '';
    const slug = 'cast-iron-care-' + sc.id.toLowerCase() + suffix;
    const item = { key, slug, postId: base + i, title: 'How to Care for Cast Iron (' + sc.id + (key ? '-' + key : '') + ')', writes: [], row: null };
    env.srv.state.posts.set(item.postId, { id: item.postId, slug, title: item.title, content: sc.original || S.ORIGINAL_HTML, link: 'http://' + S.WP_HOST + '/' + slug + '/' });
    return item;
  });
  const slugs = items.map((x) => x.slug);
  const aiUrl = (OPTS.provider === 'generic' ? 'https://chat.e2e.test/' : 'https://chatgpt.com/') + '?e2e=' + sc.id;
  const chatOrigin = OPTS.provider === 'generic' ? 'https://chat.e2e.test' : 'https://chatgpt.com';
  const outDir = path.join(OPTS.out, sc.id);
  fs.mkdirSync(outDir, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'apu-e2e-prof-' + sc.id + '-'));
  const c = { id: sc.id, items, slug: items[0].slug, post: null, writes: [], row: null, logLines: [], confirmText: '', panelLists: {}, errors: [], leftoverChatTabs: [], leftoverEditorTabs: [] };
  const pageErrors = [];
  let ctx = null;
  let panel = null;
  try {
    ctx = await env.chromium.launchPersistentContext(profile, {
      headless: true,
      executablePath: env.executablePath,
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 900 },
      args: [
        '--headless=new',
        '--disable-extensions-except=' + EXT_DIR,
        '--load-extension=' + EXT_DIR,
        '--no-sandbox',
        '--no-proxy-server',
        '--ignore-certificate-errors',
        '--host-resolver-rules=' + env.resolverRules,
        '--disable-backgrounding-occluded-windows',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding'
      ]
    });
    // The extension's copy-capture reads the clipboard on the chat site. Like a
    // user who once clicked "Allow" on Chrome's clipboard prompt, grant it —
    // except in S9, which checks the no-permission case.
    if (!sc.noClipboardGrant) {
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: chatOrigin });
    }
    // ── the service worker (background.js + importScripts('safety-gate.js')) ──
    let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 30000 });
    const extId = sw.url().split('/')[2];
    let swReady = false;
    for (let i = 0; i < 60 && !swReady; i++) {
      try { swReady = await sw.evaluate(() => typeof runtime === 'object' && !!self.SafetyGate); }
      catch (e) { sw = ctx.serviceWorkers()[0] || sw; }
      if (!swReady) await sleep(250);
    }
    if (!swReady) throw new Error('service worker did not load background.js + safety-gate.js');

    // ── first panel load: one-time setup + Safety Gate prompt seeding ──
    panel = await ctx.newPage();
    panel.on('pageerror', (e) => pageErrors.push('panel pageerror: ' + e.message));
    panel.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) pageErrors.push('panel console: ' + m.text()); });
    panel.on('dialog', async (d) => {
      if (d.type() === 'confirm' && /Start batch\?/.test(d.message())) c.confirmText = d.message();
      vlog(sc.id, 'dialog:', d.type(), d.message().split('\n')[0]);
      try { await d.accept(); } catch (e) {}
    });
    const panelUrl = 'chrome-extension://' + extId + '/panel.html';
    await panel.goto(panelUrl);
    let seeded = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      try {
        seeded = await panel.evaluate(() => chrome.storage.local.get(['safetyGatePromptsInstalled_v1', 'prompts']));
      } catch (e) { seeded = null; }   // the first load reloads itself
      if (seeded && seeded.safetyGatePromptsInstalled_v1 === true) break;
    }
    const prompts = (seeded && seeded.prompts) || [];
    if (!prompts.some((p) => p.id === 'p_sg_editor') || !prompts.some((p) => p.id === 'p_sg_factcheck')) {
      throw new Error('the panel did not seed the Safety Gate prompts (have: ' + prompts.map((p) => p.id).join(', ') + ')');
    }
    if (!prompts.some((p) => p.id === sc.prompt)) throw new Error('prompt ' + sc.prompt + ' not found');

    // ── configure through chrome.storage, exactly the keys the panel stores ──
    const settings = Object.assign({
      wpSites: [{ name: 'E2E Blog', url: 'http://' + S.WP_HOST, updateMode: sc.updateMode || 'rest', wpUsername: S.WP_USER, wpAppPassword: S.WP_APP_PASSWORD }],
      wpDefaultIndex: 0,
      selectedSiteIndex: 0,
      customAIs: [{ id: 'custom_e2e', name: 'E2E ChatGPT (fake)', url: aiUrl, mode: 'web' }],
      defaultAIId: 'custom_e2e',
      selectedAI: 'custom_e2e',
      defaultPromptId: sc.prompt,
      selectedPromptId: sc.prompt,
      savedSlugDraft: '',
      // short waits (the fastest values the panel offers)
      delayBetween: 0,
      aiTimeout: '120',
      settleTime: 2,
      pasteWait: '1',
      updateWait: '10',
      retryMode: 'off',
      maxRetries: '0',
      backgroundMode: OPTS.background ? 'on' : 'off',
      autoSessionZip: 'off',
      completeness: 'balanced',
      autoSplit: 'off',
      parallelCount: '1',
      // Safety Gate + fact check (panel defaults, written explicitly)
      gateEnabled: 'on',
      gateLinkCheck: 'on',
      gateNewFaq: 'auto',
      gateSiteDomains: '',
      factCheck: 'on',
      factCheckAiId: '',
      factCheckPromptId: 'p_sg_factcheck',
      factCheckOnError: 'keep'
    }, sc.storage || {}, OPTS.set);
    await panel.evaluate((s) => chrome.storage.local.set(s), settings);
    await panel.reload();
    await panel.waitForSelector('#startBtn', { timeout: 20000 });
    await sleep(1500);
    const ui = await panel.evaluate(() => ({
      prompt: document.getElementById('runPromptSelect') && document.getElementById('runPromptSelect').value,
      ai: document.getElementById('runAISelect') && document.getElementById('runAISelect').value,
      gate: document.getElementById('gateEnabled') && document.getElementById('gateEnabled').value,
      fc: document.getElementById('factCheck') && document.getElementById('factCheck').value,
      fcPrompt: document.getElementById('factCheckPromptId') && document.getElementById('factCheckPromptId').value,
      fcOnError: document.getElementById('factCheckOnError') && document.getElementById('factCheckOnError').value
    }));
    vlog(sc.id, 'panel UI:', JSON.stringify(ui));
    if (ui.prompt !== sc.prompt || ui.ai !== 'custom_e2e' || ui.gate !== settings.gateEnabled || ui.fc !== settings.factCheck ||
        ui.fcOnError !== settings.factCheckOnError) {
      throw new Error('panel did not pick up the configuration: ' + JSON.stringify(ui));
    }

    // ── drive the real panel: slugs, both Save buttons, Start (+ confirm) ──
    await panel.fill('#slugTextarea', slugs.join('\n'));
    await panel.click('#saveRunConfigBtn');
    await panel.click('#saveAllSettingsBtn');
    await sleep(500);
    const startEnabled = await panel.evaluate(() => !document.getElementById('startBtn').disabled);
    if (!startEnabled) throw new Error('Start stayed disabled after both Save buttons');
    const startClickedAt = Date.now() - 1000;
    await panel.click('#startBtn');

    // ── wait for the batch; collect the log as it scrolls (200-line window) ──
    const seen = new Set();
    let status = null;
    const deadlineMin = sc.deadlineMin || 9;
    const isFinal = (a) => a.result === 'updated' || a.result === 'failed';
    // Every slug needs a final attempt row stamped after `sinceMs` (a new batch
    // clears runtime.attempts, but the previous batch's rows may still be
    // showing when the first poll runs).
    async function waitForBatch(sinceMs, label) {
      let sawRunning = false;
      const deadline = Date.now() + deadlineMin * 60 * 1000;
      while (Date.now() < deadline) {
        await sleep(2000);
        try { status = await panel.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: 'BATCH_STATUS' }, r))); }
        catch (e) { continue; }
        if (!status) continue;
        (status.log || []).forEach((l) => {
          const line = l.time + ' [' + l.kind + '] ' + l.msg;
          if (!seen.has(line)) { seen.add(line); c.logLines.push(line); if (OPTS.verbose) vlog(sc.id, line.slice(0, 200)); }
        });
        if (status.running) sawRunning = true;
        const allFinal = slugs.every((s) => (status.attempts || []).some((a) => a.slug === s && isFinal(a) && Date.parse(a.isoTime || 0) >= sinceMs));
        if (!status.running && allFinal) break;
      }
      if (!status || status.running) c.errors.push(label + ' did not finish within ' + deadlineMin + ' minutes (last status: ' + (status && status.statusText) + ')');
      items.forEach((it) => {
        const rows = (status && status.attempts || []).filter((a) => a.slug === it.slug);
        it.row = rows[rows.length - 1] || null;
      });
      return sawRunning;
    }
    await waitForBatch(startClickedAt, 'the batch');

    // ── optional second batch started from the panel's result boxes ──
    if (sc.followUp && !c.errors.length) {
      c.firstRows = items.map((it) => it.row);
      await sleep(1500);
      const followUpAt = Date.now() - 1000;
      await sc.followUp(panel, c);
      await waitForBatch(followUpAt, 'the follow-up batch');
    }
    c.statusText = status && status.statusText;
    // Every AI tab (edit, fact-check, fix round) must be closed by now.
    await sleep(1000);
    c.leftoverChatTabs = ctx.pages().map((p) => p.url()).filter((u) => u.indexOf(chatOrigin) === 0);
    c.leftoverEditorTabs = ctx.pages().map((p) => p.url()).filter((u) => u.indexOf('/wp-admin/post.php') >= 0);

    // ── the panel's result boxes (bring it to the front so it re-renders) ──
    try {
      await panel.bringToFront();
      for (let i = 0; i < 20; i++) {
        await sleep(750);
        c.panelLists = await panel.evaluate(() => {
          const out = {};
          ['processedList', 'auditIssuesList', 'failedList'].forEach((id) => {
            const el = document.getElementById(id);
            out[id] = el ? (el.innerText || el.textContent || '') : '';
          });
          return out;
        });
        const all = Object.keys(c.panelLists).map((k) => c.panelLists[k]).join('\n');
        if (slugs.every((s) => all.indexOf(s) >= 0)) break;
      }
      await panel.screenshot({ path: path.join(outDir, 'panel.png'), fullPage: false }).catch(() => {});
    } catch (e) { c.errors.push('panel read failed: ' + e.message); }
  } catch (e) {
    c.errors.push(String(e && e.stack || e));
  } finally {
    if (ctx) { try { await ctx.close(); } catch (e) {} }
    if (!OPTS.keep) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {} }
  }

  // ── server-side evidence ──
  const st = env.srv.state;
  items.forEach((it) => {
    it.post = st.posts.get(it.postId);
    it.writes = st.writes.filter((w) => w.id === it.postId);
  });
  c.post = items[0].post;
  c.writes = items[0].writes;
  c.row = items[0].row;
  const chats = st.chats.filter((x) => x.scenario === sc.id);
  c.editorChats = chats.filter((x) => x.kind === 'editor');
  c.factChats = chats.filter((x) => x.kind === 'factcheck');
  c.otherChats = chats.filter((x) => x.kind === 'other');
  c.linkRequests = st.requests.filter((r) => r.path && (r.path.indexOf('/ok/') === 0 || r.path.indexOf('/dead/') === 0));
  c.wpAdminRequests = st.requests.filter((r) => r.wpAdmin && items.some((it) => r.postId === it.postId));
  c.chatPageLoads = st.requests.filter((r) => r.chatPage && (r.path.indexOf('e2e=' + sc.id) >= 0 || chats.some((x) => r.path.indexOf('/c/' + x.conversationId) === 0)));
  c.pageErrors = pageErrors;

  const t = makeChecker();
  c.errors.forEach((e) => t.ok(false, 'harness: scenario ran to completion', e));
  t.ok(!pageErrors.length, 'panel: no page errors', pageErrors.slice(0, 3).join(' | '));
  t.eq(c.otherChats.length, 0, 'the fake AI only received editor / fact-check payloads');
  if (!c.errors.length) t.ok(!c.leftoverChatTabs.length, 'every AI chat tab was closed', c.leftoverChatTabs.join(', '));
  items.forEach((it) => it.writes.forEach((w) => t.ok(w.keys.length === 1 && w.keys[0] === 'content', 'the REST write sends only {content} (' + it.slug + ')', 'keys: ' + w.keys.join(','))));
  try { sc.check(c, t); } catch (e) { t.ok(false, 'check() crashed', String(e && e.stack || e)); }

  // ── artefacts for triage ──
  try {
    fs.writeFileSync(path.join(outDir, 'log.txt'), c.logLines.join('\n') + '\n');
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({
      id: sc.id, rows: items.map((it) => it.row), statusText: c.statusText, confirmText: c.confirmText,
      writes: items.map((it) => it.writes),
      chats: chats.map((x) => ({ kind: x.kind, conversationId: x.conversationId, payloadLength: x.payloadLength, reply: x.reply.slice(0, 400) })),
      linkRequests: c.linkRequests, panelLists: c.panelLists, pageErrors, leftoverChatTabs: c.leftoverChatTabs, checks: t.results
    }, null, 2));
    chats.forEach((x, i) => fs.writeFileSync(path.join(outDir, 'chat-' + (i + 1) + '-' + x.kind + '.txt'), x.payload));
  } catch (e) {}
  const rowText = (row) => row ? (row.result + (row.result === 'failed' ? ': ' + String(row.message).split(/[.:]/)[0] + (row.gate ? ' ' + row.gate.codes.join(',') : '') : '')) : '(none)';
  return {
    id: sc.id, title: sc.title, ms: Date.now() - started, checks: t.results,
    pass: t.results.every((r) => r.ok),
    writes: items.map((it) => it.writes.length).join('+'),
    row: items.length > 1 ? items.map((it) => it.key + ' ' + rowText(it.row).split(':')[0]).join(', ') : rowText(items[0].row),
    logTail: c.logLines.slice(-25)
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════
function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

async function main() {
  const pw = loadChromium();
  if (!pw.chromium) { console.error('Cannot run: ' + pw.error); process.exit(2); }
  const list = SCENARIOS.filter((s) => (!OPTS.only.length || OPTS.only.indexOf(s.id) >= 0) && OPTS.skip.indexOf(s.id) < 0)
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  if (OPTS.list) { list.forEach((s) => console.log(pad(s.id, 5) + s.title)); return; }
  if (!list.length) { console.error('No scenario matches --only ' + OPTS.only.join(',')); process.exit(2); }
  fs.mkdirSync(OPTS.out, { recursive: true });
  const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apu-e2e-cert-'));
  const srv = await S.startServer({ https: true, certDir });
  srv.state.config.streamMs = 4000;
  srv.state.config.thinkMs = 1200;
  const resolverRules = [
    'MAP chatgpt.com 127.0.0.1:' + srv.httpsPort,
    'MAP chat.e2e.test 127.0.0.1:' + srv.httpsPort,
    'MAP *.e2e.test 127.0.0.1:' + srv.httpPort
  ].join(', ');
  const env = { chromium: pw.chromium, executablePath: pw.executablePath, srv, resolverRules };
  console.log('Auto Post Updater Pro e2e — extension ' + JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8')).version +
    ', provider ' + OPTS.provider + ', ' + list.length + ' scenario(s), ' + OPTS.jobs + ' at a time');
  console.log('fake WordPress http://' + S.WP_HOST + ' → 127.0.0.1:' + srv.httpPort + ', fake chat ' +
    (OPTS.provider === 'generic' ? 'https://chat.e2e.test' : 'https://chatgpt.com') + ' → 127.0.0.1:' + srv.httpsPort +
    ', artefacts in ' + OPTS.out);

  const results = [];
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const sc = list[next++];
      console.log('▶ ' + sc.id + ' ' + sc.title);
      const r = await runScenario(sc, env);
      results.push(r);
      console.log((r.pass ? '✔ ' : '✘ ') + sc.id + ' ' + (r.pass ? 'PASS' : 'FAIL') + ' in ' + Math.round(r.ms / 1000) + 's');
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(OPTS.jobs, list.length); i++) workers.push(worker());
  await Promise.all(workers);
  await srv.close();
  try { fs.rmSync(certDir, { recursive: true, force: true }); } catch (e) {}
  results.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));

  // ── table ──
  console.log('');
  const head = pad('ID', 4) + pad('Scenario', 40) + pad('Result', 8) + pad('Time', 7) + pad('Writes', 8) + pad('Checks', 9) + 'Attempt row';
  console.log(head);
  console.log('-'.repeat(head.length + 30));
  results.forEach((r) => {
    const okN = r.checks.filter((x) => x.ok).length;
    console.log(pad(r.id, 4) + pad(r.title, 40) + pad(r.pass ? 'PASS' : 'FAIL', 8) + pad(Math.round(r.ms / 1000) + 's', 7) +
      pad(r.writes, 8) + pad(okN + '/' + r.checks.length, 9) + r.row.slice(0, 90));
  });
  const failed = results.filter((r) => !r.pass);
  failed.forEach((r) => {
    console.log('\n✘ ' + r.id + ' ' + r.title + ' — failed checks:');
    r.checks.filter((x) => !x.ok).forEach((x) => console.log('   - ' + x.name + (x.detail ? ': ' + String(x.detail).slice(0, 600) : '')));
    console.log('   last log lines:');
    r.logTail.forEach((l) => console.log('     ' + l.slice(0, 220)));
  });
  console.log('\n' + (failed.length ? failed.length + ' of ' + results.length + ' scenario(s) FAILED' : 'All ' + results.length + ' scenario(s) passed') +
    '. Artefacts: ' + OPTS.out);
  fs.writeFileSync(path.join(OPTS.out, 'summary.json'), JSON.stringify(results, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(2); });
