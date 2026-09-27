'use strict';
// ═══════════════════════════════════════════════════════════════════════
// Smoke test: the REAL extension/ folder loaded into headless Chromium.
//
//   • the MV3 service worker starts and importScripts('safety-gate.js') ran
//   • panel.html opens with NO console errors and NO page errors
//   • the 🛡 Safety Gate section renders with its defaults
//   • the two seeded prompts appear exactly once (after two reloads), never
//     become the run prompt unless nothing else exists, and fact-check
//     prompts never appear in the run-prompt dropdown
//   • Safety Gate settings persist across reloads
//   • a failed attempt with a SAFETY GATE BLOCKED / FACT CHECK message renders
//     gate badges in the Failed box
//
// Run:  cd extension-tests && npm run smoke   (or: node --test smoke.test.js)
// Uses a throw-away browser profile in the OS temp dir; nothing is installed.
// ═══════════════════════════════════════════════════════════════════════
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { REPO_ROOT, EXT_DIR } = require('./load-background');
const { loadPlaywright, CHROMIUM_PATH } = require('./browser');

const AUTOMATION = require(path.join(REPO_ROOT, 'automation', 'validate-article.js'));
const FIXTURES = path.join(REPO_ROOT, 'automation', 'test', 'fixtures');
const EDITOR_PROMPT = fs.readFileSync(path.join(EXT_DIR, 'prompts', 'informational-editor.txt'), 'utf8');
const FACT_PROMPT = fs.readFileSync(path.join(EXT_DIR, 'prompts', 'fact-check.txt'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
const GATE_KEYS = ['gateEnabled', 'gateLinkCheck', 'gateNewFaq', 'gateSiteDomains', 'factCheck', 'factCheckAiId', 'factCheckPromptId', 'factCheckOnError'];
const SEEDED = { editor: 'p_sg_editor', factcheck: 'p_sg_factcheck' };

const PW = loadPlaywright();

describe('extension smoke (headless Chromium, real extension/ folder)', { skip: PW.chromium ? false : PW.error }, () => {
  let context = null;
  let profileDir = '';
  let sw = null;
  let panelUrl = '';
  const problems = [];     // console errors + uncaught page errors from every panel page

  before(async () => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apu-smoke-'));
    context = await PW.chromium.launchPersistentContext(profileDir, {
      headless: true,
      executablePath: CHROMIUM_PATH,
      args: ['--headless=new', '--disable-extensions-except=' + EXT_DIR, '--load-extension=' + EXT_DIR, '--no-sandbox']
    });
    sw = context.serviceWorkers().find((w) => /\/background\.js$/.test(w.url())) ||
      await context.waitForEvent('serviceworker', { timeout: 30000 });
    panelUrl = 'chrome-extension://' + new URL(sw.url()).host + '/panel.html';
    // The worker object can be reported before background.js has run: wait for
    // one of its own globals (a script runs to completion before any evaluate).
    const until = Date.now() + 20000;
    while (!(await sw.evaluate(() => typeof log === 'function' && typeof runtime === 'object'))) {
      if (Date.now() > until) throw new Error('background.js never ran in the service worker');
      await new Promise((r) => setTimeout(r, 100));
    }
    // On install the extension opens its own panel tab, before any listener
    // could be attached. Close it and start again from EMPTY storage, so the
    // first-run panel load happens under observation (and nothing races us).
    const installTabUntil = Date.now() + 5000;
    while (!context.pages().some(isPanel) && Date.now() < installTabUntil) await new Promise((r) => setTimeout(r, 100));
    await closePanels();
    await sw.evaluate(() => chrome.storage.local.clear());
    context.on('page', watch);
  });

  after(async () => {
    if (context) await context.close();
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
  });

  const isPanel = (p) => /^chrome-extension:\/\/[^/]+\/panel\.html/.test(p.url());
  const watched = new WeakSet();
  function watch(page) {
    if (watched.has(page)) return;
    watched.add(page);
    page.on('console', (m) => { if (m.type() === 'error') problems.push('console error: ' + m.text() + ' @ ' + JSON.stringify(m.location())); });
    page.on('pageerror', (e) => problems.push('page error: ' + (e && e.stack || e)));
  }
  // Only one panel at a time: two open panels both save their state.
  async function closePanels() {
    for (const p of context.pages()) if (isPanel(p)) await p.close();
  }
  // Opens the panel and waits until loadState has finished (the very first
  // load reloads itself once to install the defaults).
  async function openPanel() {
    await closePanels();
    const page = await context.newPage();
    watch(page);
    await page.goto(panelUrl);
    await page.waitForFunction(() => {
      try {
        const sel = document.getElementById('runPromptSelect');
        return typeof state === 'object' && Array.isArray(state.prompts) && sel && sel.options.length > 0 &&
          document.getElementById('factCheckPromptId').options.length > 0;
      } catch (e) { return false; }
    }, null, { timeout: 20000 });
    await page.waitForLoadState('load');
    await page.waitForTimeout(800);   // let the first status poll and late async work run
    return page;
  }
  const storage = (keys) => sw.evaluate((k) => chrome.storage.local.get(k), keys === undefined ? null : keys);
  const setStorage = (items) => sw.evaluate((i) => chrome.storage.local.set(i), items);
  async function waitForStorage(key, expected, timeoutMs) {
    const end = Date.now() + (timeoutMs || 5000);
    let last;
    while (Date.now() < end) {
      last = (await storage(key))[key];
      if (JSON.stringify(last) === JSON.stringify(expected)) return last;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail('storage "' + key + '" is ' + JSON.stringify(last) + ', expected ' + JSON.stringify(expected));
  }
  const uiValues = (page) => page.evaluate((ids) => ids.reduce((o, id) => { o[id] = document.getElementById(id).value; return o; }, {}), GATE_KEYS);
  const optionValues = (page, id) => page.$$eval('#' + id + ' option', (os) => os.map((o) => o.value));

  test('the service worker starts with safety-gate.js loaded', async () => {
    const info = await sw.evaluate(() => ({
      runSafetyGate: typeof SafetyGate.runSafetyGate,
      version: SafetyGate.VERSION,
      api: safetyGateApi() === SafetyGate,
      missing: ['applySafetyPipeline', 'runFactCheck', 'readAIJsonSnapshot', 'waitForFactCheckJson', 'substitutePromptTokens', 'sessionOriginalFor',
        'buildFactCheckPayload', 'parseFactCheckReply', 'decideFactCheck', 'buildFactCheckFixNote', 'safetyGateOn', 'factCheckOn']
        .filter((n) => typeof self[n] !== 'function'),
      manifestVersion: chrome.runtime.getManifest().version
    }));
    assert.deepEqual(info, { runSafetyGate: 'function', version: AUTOMATION.VERSION, api: true, missing: [], manifestVersion: MANIFEST.version });
    assert.equal(MANIFEST.version, '3.46.0');
  });

  test('the worker gate gives the same result as the Node validator', async () => {
    const orig = fs.readFileSync(path.join(FIXTURES, 'original-block.html'), 'utf8');
    const good = AUTOMATION.parseEditorOutput(fs.readFileSync(path.join(FIXTURES, 'edited-good.txt'), 'utf8')).html.trim() + '\n<!-- APU-END -->\n';
    const opts = { siteDomains: ['tubetyre.com'], allowNewFaq: true, webSearchAllowed: true, checkLinks: false, endMarker: 'APU-END', requireEndMarker: true };
    const inWorker = await sw.evaluate(async ({ o, g, opt }) => {
      const r = await SafetyGate.runSafetyGate(o, g, opt);
      return { ok: r.ok, html: r.html, errors: r.errors, stripped: SafetyGate.stripEndMarkers(g) };
    }, { o: orig, g: good, opt: opts });
    const inNode = await AUTOMATION.runSafetyGate(orig, good, opts);
    assert.equal(inWorker.ok, true, JSON.stringify(inWorker.errors));
    assert.equal(inWorker.html, inNode.html);
    assert.equal(inWorker.html.includes('APU-END'), false);
    assert.equal(inWorker.stripped, AUTOMATION.stripEndMarkers(good));
  });

  test('panel.html opens, answers BATCH_STATUS and renders the Safety Gate section', async () => {
    const page = await openPanel();
    const status = await page.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: 'BATCH_STATUS' }, r)));
    assert.equal(status.running, false);
    const summary = await page.$eval('#sec-gate > summary', (e) => e.textContent);
    assert.match(summary, /Safety Gate/);
    // the shortcut bar link opens the section
    assert.equal(await page.$eval('#sec-gate', (e) => e.open), false);
    await page.click('#shortcutBar a[data-sc="sec-gate"]');
    await page.waitForFunction(() => document.getElementById('sec-gate').open === true, null, { timeout: 3000 });
    assert.ok(await page.isVisible('#gateEnabled'));
    assert.deepEqual(await uiValues(page), {
      gateEnabled: 'on', gateLinkCheck: 'on', gateNewFaq: 'auto', gateSiteDomains: '', factCheck: 'on',
      factCheckAiId: '', factCheckPromptId: SEEDED.factcheck, factCheckOnError: 'keep'
    });
    assert.equal(await page.$eval('#gateOffNote', (e) => getComputedStyle(e).display), 'none');
    // the prompt editor offers the web-search flag and the fact-check type
    assert.ok(await page.$('#promptWebSearch'));
    assert.ok((await optionValues(page, 'promptType')).includes('factcheck'));
    await page.close();
  });

  test('the two seeded prompts appear exactly once after two reloads and are not auto-selected', async () => {
    let page = await openPanel();
    await page.reload();
    await page.close();
    page = await openPanel();
    const st = await storage();
    assert.equal(st.safetyGatePromptsInstalled_v1, true);
    const editor = st.prompts.filter((p) => p.id === SEEDED.editor);
    const fact = st.prompts.filter((p) => p.id === SEEDED.factcheck);
    assert.equal(editor.length, 1);
    assert.equal(fact.length, 1);
    assert.equal(st.prompts.filter((p) => /\(Safety Gate\)$/.test(p.name || '')).length, 2);
    assert.deepEqual({ type: editor[0].type, webSearch: editor[0].webSearch, name: editor[0].name, text: editor[0].text },
      { type: 'audit', webSearch: true, name: 'Informational Editor (Safety Gate)', text: EDITOR_PROMPT.trim() });
    assert.deepEqual({ type: fact[0].type, webSearch: fact[0].webSearch, name: fact[0].name, text: fact[0].text },
      { type: 'factcheck', webSearch: false, name: 'Fact Check (Safety Gate)', text: FACT_PROMPT.trim() });
    // the user's run prompt is untouched (the first built-in prompt)
    assert.ok(st.prompts.length > 2);
    assert.notEqual(st.defaultPromptId, SEEDED.editor);
    assert.notEqual(st.selectedPromptId, SEEDED.editor);
    assert.equal(st.selectedPromptId, st.prompts[0].id);
    assert.equal(await page.$eval('#runPromptSelect', (e) => e.value), st.prompts[0].id);
    // fact-check prompts: only in the fact-check dropdown
    const runOpts = await optionValues(page, 'runPromptSelect');
    assert.ok(runOpts.includes(SEEDED.editor));
    assert.ok(!runOpts.includes(SEEDED.factcheck));
    assert.deepEqual(await optionValues(page, 'factCheckPromptId'), [SEEDED.factcheck]);
    await page.close();
  });

  test('Safety Gate settings persist across reload; factcheck prompts stay out of the run dropdown', async () => {
    // a user fact-check prompt, added while no panel is open
    await closePanels();
    const st0 = await storage('prompts');
    await setStorage({ prompts: st0.prompts.concat([{ id: 'p_test_fc', type: 'factcheck', webSearch: false, name: 'My fact check', text: 'Check the edit. Reply in JSON.' }]) });
    let page = await openPanel();
    assert.ok(!(await optionValues(page, 'runPromptSelect')).includes('p_test_fc'));
    assert.deepEqual((await optionValues(page, 'factCheckPromptId')).sort(), ['p_test_fc', SEEDED.factcheck].sort());
    await page.click('#shortcutBar a[data-sc="sec-gate"]');
    await page.waitForFunction(() => document.getElementById('sec-gate').open === true, null, { timeout: 3000 });
    const aiOpts = (await optionValues(page, 'factCheckAiId')).filter(Boolean);
    assert.ok(aiOpts.length > 0, 'no AI to choose for the fact check');
    await page.selectOption('#gateEnabled', 'off');
    await page.selectOption('#gateLinkCheck', 'off');
    await page.selectOption('#gateNewFaq', 'no');
    await page.fill('#gateSiteDomains', 'https://www.Shop.com/x  other.net');
    await page.$eval('#gateSiteDomains', (e) => e.dispatchEvent(new Event('change', { bubbles: true })));
    await page.selectOption('#factCheck', 'off');
    await page.selectOption('#factCheckAiId', aiOpts[0]);
    await page.selectOption('#factCheckPromptId', 'p_test_fc');
    await page.selectOption('#factCheckOnError', 'save');
    const expectedStored = {
      gateEnabled: 'off', gateLinkCheck: 'off', gateNewFaq: 'no', gateSiteDomains: 'shop.com, other.net', factCheck: 'off',
      factCheckAiId: aiOpts[0], factCheckPromptId: 'p_test_fc', factCheckOnError: 'save'
    };
    for (const k of GATE_KEYS) await waitForStorage(k, expectedStored[k]);
    assert.notEqual(await page.$eval('#gateOffNote', (e) => getComputedStyle(e).display), 'none');
    await page.close();
    // two fresh loads
    for (let i = 0; i < 2; i++) {
      page = await openPanel();
      assert.deepEqual(await uiValues(page), expectedStored);
      const st = await storage(GATE_KEYS);
      assert.deepEqual(GATE_KEYS.reduce((o, k) => { o[k] = st[k]; return o; }, {}), expectedStored);
      await page.close();
    }
  });

  test('with no other prompt, the seeded editor prompt becomes the run prompt', async () => {
    await closePanels();
    await setStorage({ prompts: [], safetyGatePromptsInstalled_v1: false, selectedPromptId: null, defaultPromptId: null });
    const page = await openPanel();
    const st = await storage();
    assert.deepEqual(st.prompts.map((p) => p.id), [SEEDED.editor, SEEDED.factcheck]);
    assert.equal(st.safetyGatePromptsInstalled_v1, true);
    assert.deepEqual(await optionValues(page, 'runPromptSelect'), [SEEDED.editor]);
    assert.equal(await page.$eval('#runPromptSelect', (e) => e.value), SEEDED.editor);
    assert.equal(await page.$eval('#factCheckPromptId', (e) => e.value), SEEDED.factcheck);
    await page.close();
  });

  test('failed attempts blocked by the Safety Gate / fact check render gate badges', async () => {
    await closePanels();
    await setStorage({ gateEnabled: 'on', gateLinkCheck: 'on', gateNewFaq: 'auto', gateSiteDomains: '', factCheck: 'on', factCheckAiId: '', factCheckPromptId: '', factCheckOnError: 'keep' });
    // Real worker helpers build the rows exactly as processSlug would.
    const messages = await sw.evaluate(() => {
      runtime.attempts = [];
      const gateLinks = { aiName: 'ChatGPT', aiProviderUrl: 'https://chatgpt.com/' };
      const gateErr = safetyGateBlockedError(gateLinks, ['IMG_COUNT', 'TABLE_LOSS'], ['2 images are missing', 'a table lost 3 rows'],
        ['LIST_LOSS: 40% fewer list items'], [{ url: 'https://dead.example.com/x', reason: 'dead' }]);
      rememberAttempt('https://example.org/gate-post/', 'gate-post', 'failed', gateErr.message, gateLinks);
      const issues = [{ severity: 'high', category: 'fact_wrong', quote: 'Tickets cost 29 euros for adults', problem: 'The price was not confirmed.', fix: 'Keep the original price.' }];
      const fcLinks = { aiName: 'ChatGPT', factCheck: { verdict: 'fix', issues, dropped: [], aiSessionUrl: '', fixRound: true } };
      const fcErr = factCheckBlockedError({ verdict: 'fix', issues }, true);
      rememberAttempt('fact-post', 'fact-post', 'failed', fcErr.message, fcLinks);
      const errLinks = { aiName: 'ChatGPT', factCheck: { verdict: 'error', error: 'no JSON verdict in the reply', issues: [], dropped: [], aiSessionUrl: '', fixRound: false } };
      rememberAttempt('fact-error-post', 'fact-error-post', 'failed', factCheckError('no JSON verdict in the reply', '').message, errLinks);
      return { gate: gateErr.message, gateCode: gateErr.code, fc: fcErr.message, fcCode: fcErr.code };
    });
    assert.equal(messages.gateCode, 'SAFETY_GATE');
    assert.equal(messages.fcCode, 'FACT_CHECK');
    assert.match(messages.gate, /^SAFETY GATE BLOCKED: IMG_COUNT, TABLE_LOSS — 2 images are missing; a table lost 3 rows\. The post was NOT changed\.$/);
    assert.match(messages.fc, /^FACT CHECK BLOCKED: verdict "fix", 1 issue\(s\) after the fix round — /);
    // An older row that only has the message text (no structured gate data).
    const old = await storage(['processedLinks']);
    await setStorage({ processedLinks: [{ rawInput: 'old-gate-post', slug: 'old-gate-post', result: 'failed',
      message: 'SAFETY GATE BLOCKED: END_MARKER_MISSING. The post was NOT changed.', time: '09:00:00', isoTime: '2026-09-01T09:00:00.000Z' }]
      .concat(old.processedLinks || []) });

    const page = await openPanel();
    await page.waitForFunction(() => {
      const t = document.getElementById('failedList').textContent;
      return ['gate-post', 'fact-post', 'fact-error-post', 'old-gate-post'].every((s) => t.includes(s));
    }, null, { timeout: 10000 });
    const rows = await page.$$eval('#failedList .processed-item', (els) => els.map((el) => ({
      slug: el.querySelector('.pi-slug').textContent,
      badges: [...el.querySelectorAll('.pi-badge')].map((b) => b.className + ' | ' + b.textContent),
      body: el.querySelector('.pi-body').innerHTML
    })));
    const row = (slug) => rows.find((r) => r.slug === slug || r.slug.endsWith('/' + slug + '/'));
    assert.deepEqual(row('gate-post').badges, ['pi-badge gate | 🛡 Gate: IMG_COUNT, TABLE_LOSS']);
    assert.deepEqual(row('fact-post').badges, ['pi-badge fact | 🔎 Fact check: 1 issue']);
    assert.deepEqual(row('fact-error-post').badges, ['pi-badge fact | 🔎 Fact check error']);
    assert.deepEqual(row('old-gate-post').badges, ['pi-badge gate | 🛡 Gate: END_MARKER_MISSING']);
    // the message is red from the prefix on, and the details list the reasons
    assert.ok(row('gate-post').body.includes('<span style="color:#ff5566;font-weight:700;">SAFETY GATE BLOCKED: IMG_COUNT, TABLE_LOSS'), row('gate-post').body);
    assert.ok(row('gate-post').body.includes('• 2 images are missing'));
    assert.ok(row('gate-post').body.includes('• (warning) LIST_LOSS: 40% fewer list items'));
    assert.ok(row('fact-post').body.includes('[high] The price was not confirmed.'));
    assert.ok(row('fact-error-post').body.includes('The fact check itself failed: no JSON verdict in the reply'));
    // gate rows are Failed rows only — never Audit Issues or Successful
    for (const id of ['auditIssuesList', 'processedList']) {
      const text = await page.$eval('#' + id, (e) => e.textContent);
      for (const s of ['gate-post', 'fact-post', 'fact-error-post']) assert.ok(!text.includes(s), s + ' also listed in #' + id);
    }
    await page.close();
  });

  test('no console errors and no page errors on any panel load', () => {
    assert.deepEqual(problems, []);
  });
});
