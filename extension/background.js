// ═══════════════════════════════════════════════════════════════════════
// background.js - Auto Post Updater Pro v3.46.0
//
// v3.46.0 "Safety Gate":
//   • Every AI edit passes a code Safety Gate (safety-gate.js) and, when on,
//     an AI Fact-Check round in a NEW chat BEFORE anything is written to
//     WordPress. Any failure leaves the original post live (Failed box).
//   • Per-prompt web search, prompt tokens ([[TODAY]], [[SITE_DOMAIN]], ...),
//     and extraction fixes (line-anchored "FIXED ARTICLE" divider, leading /
//     trailing shortcodes kept).
//
// Major changes vs v2.1:
//   • Provider-aware code block detection (ChatGPT/Claude/Gemini/Grok specific selectors)
//   • Permissive but verified extraction — won't reject valid HTML for missing copy button
//   • Smarter "still generating" detection (data-testid based, ChatGPT-aware)
//   • Per-slug retry loop (configurable, default 1 retry)
//   • Cleaner AI prompt payload (no scary preamble that triggers refusal)
//   • Looser stable-key (resists syntax-highlighter micro-redraws)
//   • Fixed Gutenberg UPDATE flow (toggle + confirm)
//   • settleTime is actually used now
//   • Returns to panel tab automatically between slugs
// ═══════════════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────────────
// Safety Gate validator (v3.46.0). A classic worker script that exposes
// self.SafetyGate. If it cannot load, nothing unchecked is ever saved: with
// the gate ON every post then fails with SAFETY_GATE "safety-gate.js not
// loaded" (see runSafetyGateStep).
// ──────────────────────────────────────────────────────────────────────
try {
  importScripts('safety-gate.js');
} catch (e) {
  console.error('[Batch] safety-gate.js could not be loaded: ' + (e && e.message ? e.message : e));
}

// ──────────────────────────────────────────────────────────────────────
// In-memory batch state (persisted to storage for SW restarts)
// ──────────────────────────────────────────────────────────────────────
let runtime = {
  running: false,
  paused: false,
  stopRequested: false,
  job: null,
  cursor: 0,
  successes: 0,
  log: [],
  failures: [],
  attempts: [],
  statusText: 'Ready.',
  statusKind: '',
  panelTabId: null,
  panelWindowId: null,
  workerWindowId: null,
  // Reusable tab on the WordPress site used to route REST requests through a
  // real browser context when the site firewall blocks direct extension calls.
  bridgeTabId: null,
  // IDs of automation tabs we opened; persisted so a service-worker restart
  // can close orphaned tabs instead of leaking them.
  trackedTabs: [],
  // Per-slug processing durations (ms) used for the ETA estimate.
  slugDurations: [],
  // End-of-batch retry pass: 0 = main pass, 1 = retrying queued failures.
  retryPass: 0,
  retryQueue: [],
  // v3.46.0: why a queued post was blocked by the Safety Gate / fact check
  // (rawSlug -> PRIORITY FIX note), so the end-of-batch retry tells the AI.
  retryNotes: {},
  // Audit Retry (separate, opt-in): posts whose post-save audit reported
  // issues are queued here for re-processing when timing = "end".
  auditRetryQueue: [],
  // Human-readable reason for an automatic pause. Persisted so a service-
  // worker restart does not replace the useful explanation with "Paused".
  autoPauseReason: '',
  // Fast Submit keeps one AI tab open when a sent prompt never receives a
  // durable conversation URL. Preserve that rescue tab across SW restarts.
  rescueTabId: null
};

const MAX_LOG = 200;
const MAX_ATTEMPTS = 2000; // matches the supported Fast Submit queue size

// Re-entrancy guard: prevents two processLoop() runs from racing the same batch
// (can happen when onStartup + top-level init + the keepalive alarm all try to
// resume after a service-worker restart). Without this, tabs get opened twice.
let processing = false;
let fastRecoveryStarting = false;
let batchStarting = false;

// MV3 service workers are killed after ~30s idle. A periodic alarm wakes the
// worker back up so a long batch (or a paused one) resumes even if the control
// panel tab is closed.
const KEEPALIVE_ALARM = 'app-keepalive';
// Fast Submit's scheduled recovery — fires even when the panel is closed.
const FAST_RECOVER_ALARM = 'fast-recover';
// Auto-retry after a repeated-failure pause (user-configurable interval).
const FAIL_RETRY_ALARM = 'fail-retry';
// Fast Submit "Start after N minutes" — the run begins by itself later.
const FAST_START_ALARM = 'fast-start';
// Model-limit pause — optional automatic retry after N hours.
const MODEL_LIMIT_ALARM = 'model-limit-retry';

function startKeepAlive() {
  try { chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 }); } catch (e) {}
  setKeepAwake(true);    // no display/system sleep while a batch is running
}
function stopKeepAlive() {
  try { chrome.alarms.clear(KEEPALIVE_ALARM); } catch (e) {}
  setKeepAwake(false);
}
// Cheap API call whose only purpose is to reset the SW idle timer during long
// pure-setTimeout waits (delay-between-posts, pause), which otherwise let the
// worker die mid-batch.
async function swPing() {
  try { await chrome.runtime.getPlatformInfo(); } catch (e) {}
}

if (chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === FAST_RECOVER_ALARM) {
      startFastRecovery('alarm').catch(e => log('err', 'Scheduled recovery failed: ' + (e?.message || e)));
      return;
    }
    if (alarm.name === FAIL_RETRY_ALARM) {
      autoResumeAfterFailPause().catch(e => log('err', 'Auto-retry resume failed: ' + (e?.message || e)));
      return;
    }
    if (alarm.name === FAST_START_ALARM) {
      startPendingFastSubmit().catch(e => log('err', 'Scheduled Fast Submit failed to start: ' + (e?.message || e)));
      return;
    }
    if (alarm.name === MODEL_LIMIT_ALARM) {
      autoResumeAfterModelLimit().catch(e => log('err', 'Model-limit retry failed: ' + (e?.message || e)));
      return;
    }
    if (alarm.name !== KEEPALIVE_ALARM) return;
    // Catch a browser minimized mid-run, whatever stage the run is at.
    if (runtime.running) keepWorkWindowUsable().catch(() => {});
    if (runtime.running && !processing) {
      processLoop().catch(e => log('err', 'Loop error: ' + e.message));
    } else if (!runtime.running) {
      stopKeepAlive();
    }
  });
}

// ──────────────────────────────────────────────────────────────────────
// Message handling
// ──────────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      // The service worker may have just been woken by THIS message, with
      // `runtime` still at its blank defaults. Every handler below reads or
      // mutates it, so wait for the persisted state first — otherwise Stop,
      // Pause and Resume act on an empty object and are silently lost.
      await loadRuntime();
      switch (msg.type) {
        case 'BATCH_START':
          if (runtime.running || batchStarting || fastRecoveryStarting) return sendResponse({ ok: false, error: 'Already running or starting' });
          runtime.panelTabId    = sender?.tab?.id || null;
          runtime.panelWindowId = sender?.tab?.windowId || null;
          await startBatch(msg.job);
          return sendResponse({ ok: true });
        case 'BATCH_PAUSE':
          runtime.paused = true;
          await persistRuntime();
          return sendResponse({ ok: true });
        case 'BATCH_RESUME':
          runtime.paused = false;
          runtime.autoPauseReason = '';   // clear the auto-pause banner on resume
          runtime.autoPauseKind = '';
          runtime.rescueTabId = null;      // the user has reviewed the kept-open tab
          runtime.consecFails = 0;        // give the batch a fresh failure budget
          runtime.failProbation = false;  // a manual resume is a clean slate
          try { await chrome.alarms.clear(FAIL_RETRY_ALARM); } catch (e) {}

          try { await chrome.alarms.clear(MODEL_LIMIT_ALARM); } catch (e) {}
          await persistRuntime();
          // A service-worker restart during a long pause can leave no live loop.
          if (runtime.running && !processing) {
            processLoop().catch(e => log('err', 'Loop error after resume: ' + e.message));
          }
          return sendResponse({ ok: true });
        case 'EMERGENCY_STOP': {
          // Order matters: raise the flag FIRST so every running loop and
          // interruptible sleep bails while the rest of the teardown runs.
          runtime.stopRequested = true;
          runtime.paused = false;
          runtime.autoPauseKind = '';
          runtime.autoPauseReason = '';
          try { await chrome.alarms.clear(FAIL_RETRY_ALARM); } catch (e) {}
          try { await chrome.alarms.clear(MODEL_LIMIT_ALARM); } catch (e) {}
          try { await chrome.alarms.clear(FAST_RECOVER_ALARM); } catch (e) {}
          try { await chrome.alarms.clear(FAST_START_ALARM); } catch (e) {}
          await cancelPendingFastSubmit('emergency stop');
          runtime.rescueTabId = null;
          await persistRuntime();
          setStatus('🛑 EMERGENCY STOP — everything halted. Nothing further will be sent.', 'error');
          log('err', '🛑 EMERGENCY STOP pressed: run halted, all timers and schedules cancelled, automation tabs closing.');
          // Close the AI/editor tabs we opened so nothing keeps working in the
          // background. Deliberately after the flag + persist, so a slow close
          // can never delay the stop itself.
          closeOrphanedWorkTabs().catch(() => {});
          try {
            chrome.notifications.create('emergency-stop-' + Date.now(), {
              type: 'basic',
              iconUrl: chrome.runtime.getURL('icons/icon128.png'),
              title: '🛑 Emergency stop',
              message: 'Everything was halted. No further posts will be processed.',
              priority: 2
            });
          } catch (e) {}
          return sendResponse({ ok: true });
        }
        case 'BATCH_STOP':
          // Stop must mean stop in EVERY state, including a Fast Submit that is
          // only waiting for its 'Start after' delay (nothing running yet).
          await cancelPendingFastSubmit('Stop was pressed');
          runtime.stopRequested = true;
          runtime.paused = false;
          runtime.autoPauseKind = '';
          try { await chrome.alarms.clear(FAIL_RETRY_ALARM); } catch (e) {}

          try { await chrome.alarms.clear(MODEL_LIMIT_ALARM); } catch (e) {}
          await persistRuntime();
          return sendResponse({ ok: true });
        case 'BATCH_UPDATE_JOB':
          if (!runtime.running || !runtime.job) return sendResponse({ ok: false, error: 'No active batch' });
          applyLiveJobSettings(msg.config || {});
          await persistRuntime();
          return sendResponse({ ok: true });
        case 'BATCH_CLEAR_ATTEMPTS':
          runtime.attempts = [];
          await persistRuntime();
          return sendResponse({ ok: true });
        case 'BATCH_RESET': {
          // Full "fresh run" reset: wipe the in-memory runtime (log, failures,
          // attempts, counters, queues) AND persisted state, so a poll right
          // after Clear All cannot repaint the finished run's results.
          if (runtime.running) return sendResponse({ ok: false, error: 'A batch is running.' });
          try { await chrome.alarms.clear(FAST_RECOVER_ALARM); } catch (e) {}
          runtime.job = null;
          runtime.cursor = 0;
          runtime.successes = 0;
          runtime.log = [];
          runtime.failures = [];
          runtime.attempts = [];
          runtime.retryQueue = [];
          runtime.retryNotes = {};
          runtime.auditRetryQueue = [];
          runtime.retryPass = 0;
          runtime.slugDurations = [];
          runtime.parallelDone = [];
          runtime.consecFails = 0;
          runtime.failProbation = false;
          runtime.failRetryCycles = 0;
          runtime.geminiDeadLinks = 0;
          runtime.limitAlert = null;
          runtime.autoPauseReason = '';
          runtime.autoPauseKind = '';
          try { await chrome.alarms.clear(FAIL_RETRY_ALARM); } catch (e) {}

          try { await chrome.alarms.clear(MODEL_LIMIT_ALARM); } catch (e) {}
          runtime.rescueTabId = null;
          runtime.paused = false;
          runtime.stopRequested = false;
          runtime.statusText = 'Ready.';
          runtime.statusKind = '';
          try { await chrome.storage.local.remove(['__runtime', '__fastQueue', '__fastCyclePlan']); } catch (e) {}
          await cancelPendingFastSubmit('Clear All');
          return sendResponse({ ok: true });
        }
        case 'FAST_SCHEDULE_START': {
          if (runtime.running || batchStarting) return sendResponse({ ok: false, error: 'A batch is already running.' });
          if (!msg.job) return sendResponse({ ok: false, error: 'No job to schedule.' });
          runtime.panelTabId    = sender?.tab?.id || null;
          runtime.panelWindowId = sender?.tab?.windowId || null;
          const r = await schedulePendingFastSubmit(msg.job, msg.minutes);
          return sendResponse(r);
        }
        case 'FAST_CANCEL_START': {
          const had = await cancelPendingFastSubmit('cancelled from the panel');
          return sendResponse({ ok: true, had });
        }
        case 'FAST_RECOVER_NOW': {
          const r = await startFastRecovery('manual');
          return sendResponse(r);
        }
        case 'FAST_CANCEL_SCHEDULE': {
          try { await chrome.alarms.clear(FAST_RECOVER_ALARM); } catch (e) {}
          const d = await chrome.storage.local.get('__fastQueue');
          if (d.__fastQueue) { d.__fastQueue.recoverAt = 0; await chrome.storage.local.set({ __fastQueue: d.__fastQueue }); }
          const cancelledStart = await cancelPendingFastSubmit('cancelled with the schedule');
          return sendResponse({ ok: true, cancelledStart });
        }
        case 'FAST_CLEAR_QUEUE': {
          try { await chrome.alarms.clear(FAST_RECOVER_ALARM); } catch (e) {}
          // Clear the current cycle queue AND the master plan so no future cycle
          // can start unexpectedly.
          await chrome.storage.local.remove(['__fastQueue', '__fastCyclePlan']);
          await cancelPendingFastSubmit('the queue was cleared');
          return sendResponse({ ok: true });
        }
        case 'FAST_QUEUE_STATUS': {
          const d = await chrome.storage.local.get(['__fastQueue', '__fastCyclePlan', '__fastPendingStart']);
          const q = d.__fastQueue;
          const plan = d.__fastCyclePlan || null;
          const queued = (q?.entries || []).filter(e => e.status === 'submitted');
          const pending = queued.filter(e => !!canonicalizeAISessionUrl(
            e.sessionUrl || '',
            detectProviderKind(e.sessionUrl || q?.config?.aiUrl || ''),
            q?.config?.aiUrl || ''
          )).length;
          const invalid = Math.max(0, queued.length - pending);
          const resp = { ok: true, pending, invalid, total: q?.entries?.length || 0, recoverAt: q?.recoverAt || 0 };
          // A Fast Submit that is waiting for its "Start after" delay.
          const ps = d.__fastPendingStart;
          if (ps && ps.when) {
            resp.pendingStartAt = ps.when;
            resp.pendingStartMinutes = ps.minutes || 0;
            resp.pendingStartCount = ps.job?.slugs?.length || 0;
          }
          if (plan) {
            resp.planActive = plan.status !== 'completed' && plan.status !== 'error';
            resp.planStatus = plan.status;
            resp.chunkSize = plan.chunkSize;
            resp.currentChunkNumber = plan.currentChunkNumber;
            resp.totalChunks = plan.totalChunks;
            resp.currentChunkCount = pending;
            resp.completedTotal = plan.completedTotal || 0;
            resp.failedTotal = plan.failedTotal || 0;
            resp.totalPosts = plan.totalPosts;
            resp.remaining = Math.max(0, (plan.totalPosts || 0) - (plan.completedTotal || 0) - (plan.failedTotal || 0));
            resp.planError = plan.lastError || '';
          }
          return sendResponse(resp);
        }
        case 'BATCH_STATUS':
          return sendResponse({
            running: runtime.running,
            paused: runtime.paused,
            total: runtime.job?.slugs?.length || 0,
            done: runtime.cursor,
            checked: runtime.cursor,
            updated: runtime.successes,
            failed: runtime.failures.length,
            statusText: runtime.statusText,
            statusKind: runtime.statusKind,
            log: runtime.log,
            failures: runtime.failures,
            attempts: runtime.attempts,
            retryPass: runtime.retryPass || 0,
            parallel: Number(runtime.job?.parallel) || 1,
            etaSeconds: estimateEtaSeconds(),
            progress: computeRunProgress(),
            limitAlert: runtime.limitAlert || null
          });
        default:
          return sendResponse({ ok: false, error: 'Unknown type' });
      }
    } catch (e) {
      console.error('[BG]', e);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

// ──────────────────────────────────────────────────────────────────────
// Runtime persistence (so a service-worker restart can resume)
// ──────────────────────────────────────────────────────────────────────
async function persistRuntime() {
  await chrome.storage.local.set({
    __runtime: {
      running: runtime.running,
      paused: runtime.paused,
      stopRequested: runtime.stopRequested,
      job: runtime.job,
      cursor: runtime.cursor,
      successes: runtime.successes,
      statusText: runtime.statusText,
      statusKind: runtime.statusKind,
      failures: runtime.failures,
      attempts: runtime.attempts,
      // Persist tab/window handles so a service-worker restart can reuse the
      // existing worker window instead of orphaning it and opening a new one.
      panelTabId: runtime.panelTabId,
      panelWindowId: runtime.panelWindowId,
      workerWindowId: runtime.workerWindowId,
      bridgeTabId: runtime.bridgeTabId,
      trackedTabs: runtime.trackedTabs,
      slugDurations: runtime.slugDurations,
      retryPass: runtime.retryPass,
      retryQueue: runtime.retryQueue,
      retryNotes: runtime.retryNotes,
      auditRetryQueue: runtime.auditRetryQueue,
      parallelDone: runtime.parallelDone,
      sessionId: runtime.sessionId,
      autoPauseReason: runtime.autoPauseReason,
      rescueTabId: runtime.rescueTabId,
      // Repeated-failure policy state — a timed auto-retry must survive a
      // service-worker restart during its (possibly hours-long) pause.
      consecFails: runtime.consecFails,
      autoPauseKind: runtime.autoPauseKind,
      failProbation: runtime.failProbation,
      failRetryCycles: runtime.failRetryCycles,

      modelLimitRetries: runtime.modelLimitRetries,
      geminiDeadLinks: runtime.geminiDeadLinks,
      geminiVerifiedLinks: runtime.geminiVerifiedLinks,
      limitAlert: runtime.limitAlert || null
    }
  });
}

// Sanitize URLs saved by older builds before any MV3 restart resumes work.
// Invalid recovery links are quarantined and the recovery is terminalized;
// otherwise Resume could silently send a brand-new prompt for the wrong row.
function sanitizePersistedRuntimeSessionUrls() {
  let changed = false;
  let blockedRecovery = false;
  const defaultHome = runtime.job?.recoverProviderUrl || runtime.job?.aiUrl || '';

  runtime.attempts = (Array.isArray(runtime.attempts) ? runtime.attempts : []).map((attempt) => {
    const raw = String(attempt?.aiSessionUrl || '').trim();
    if (!raw) return attempt;
    const home = attempt?.aiProviderUrl || defaultHome;
    const canonical = canonicalizeAISessionUrl(raw, detectProviderKind(raw || home), home);
    if (canonical) {
      if (canonical === raw) return attempt;
      changed = true;
      return Object.assign({}, attempt, { aiSessionUrl: canonical });
    }
    changed = true;
    return Object.assign({}, attempt, {
      aiSessionUrl: '',
      quarantinedAiSessionUrl: attempt?.quarantinedAiSessionUrl || raw
    });
  });

  if (!runtime.job || typeof runtime.job !== 'object') return { changed, blockedRecovery };
  const rawSingle = String(runtime.job.recoverFromUrl || '').trim();
  if (rawSingle) {
    const canonicalSingle = canonicalizeAISessionUrl(
      rawSingle,
      detectProviderKind(rawSingle || defaultHome),
      defaultHome
    );
    if (canonicalSingle) {
      if (canonicalSingle !== rawSingle) changed = true;
      runtime.job.recoverFromUrl = canonicalSingle;
    } else {
      runtime.job.quarantinedRecoverFromUrl = runtime.job.quarantinedRecoverFromUrl || rawSingle;
      runtime.job.recoverFromUrl = '';
      changed = true;
      blockedRecovery = true;
    }
  }

  if (runtime.job.recoverMap && typeof runtime.job.recoverMap === 'object') {
    const cleanMap = {};
    const quarantinedMap = Object.assign({}, runtime.job.quarantinedRecoverMap || {});
    for (const [slug, rawValue] of Object.entries(runtime.job.recoverMap)) {
      const raw = String(rawValue || '').trim();
      const home = runtime.job.recoverProviderMap?.[slug] || defaultHome;
      const canonical = canonicalizeAISessionUrl(raw, detectProviderKind(raw || home), home);
      if (canonical) cleanMap[slug] = canonical;
      else if (raw) {
        quarantinedMap[slug] = quarantinedMap[slug] || raw;
        blockedRecovery = true;
      }
      if (!raw || canonical !== raw) changed = true;
    }
    runtime.job.recoverMap = Object.keys(cleanMap).length ? cleanMap : null;
    runtime.job.quarantinedRecoverMap = Object.keys(quarantinedMap).length ? quarantinedMap : null;
  }

  if (blockedRecovery && runtime.running) {
    runtime.running = false;
    runtime.paused = false;
    runtime.stopRequested = false;
    runtime.autoPauseReason = '';
    runtime.statusKind = 'error';
    runtime.statusText = 'Saved recovery stopped — its AI conversation URL was transient or invalid. Use Retry new.';
    runtime.job.recoveryBlockedByInvalidSession = true;
    changed = true;
  }
  return { changed, blockedRecovery };
}

// BUG FIX: loadRuntime is triggered from BOTH the top-level init and the
// onStartup listener on browser launch. Running it twice re-read stale
// storage over live state and scheduled duplicate resume work.
// Callers MUST be able to await the REAL completion of this load, not just
// the fact that it started. A message handler that mutates `runtime` before
// storage has been read works on a blank default object and then persists it
// over the live batch — that is why Stop appeared to do nothing once the
// service worker had gone to sleep. One shared promise makes every caller
// wait for the same finished load.
let runtimeLoadPromise = null;
function loadRuntime() {
  if (!runtimeLoadPromise) runtimeLoadPromise = loadRuntimeOnce();
  return runtimeLoadPromise;
}
async function loadRuntimeOnce() {
  const data = await chrome.storage.local.get('__runtime');
  if (data.__runtime) {
    Object.assign(runtime, data.__runtime);
    runtime.successes = Number(runtime.successes) || 0;
    runtime.log = [];
    runtime.failures = Array.isArray(runtime.failures) ? runtime.failures : [];
    runtime.attempts = Array.isArray(runtime.attempts) ? runtime.attempts : [];
    runtime.trackedTabs = Array.isArray(runtime.trackedTabs) ? runtime.trackedTabs : [];
    runtime.slugDurations = Array.isArray(runtime.slugDurations) ? runtime.slugDurations : [];
    runtime.retryPass = Number(runtime.retryPass) || 0;
    runtime.retryQueue = Array.isArray(runtime.retryQueue) ? runtime.retryQueue : [];
    runtime.retryNotes = (runtime.retryNotes && typeof runtime.retryNotes === 'object' && !Array.isArray(runtime.retryNotes)) ? runtime.retryNotes : {};
    runtime.auditRetryQueue = Array.isArray(runtime.auditRetryQueue) ? runtime.auditRetryQueue : [];
    runtime.parallelDone = Array.isArray(runtime.parallelDone) ? runtime.parallelDone : [];
    runtime.sessionId = Number(runtime.sessionId) || 0;
    runtime.autoPauseReason = String(runtime.autoPauseReason || '');
    runtime.rescueTabId = Number(runtime.rescueTabId) || null;
    const sessionSanitize = sanitizePersistedRuntimeSessionUrls();
    if (sessionSanitize.blockedRecovery) {
      log('warn', 'A persisted recovery contained a transient or invalid AI session URL and was stopped safely. Use Retry new.');
      try { await closeOrphanedWorkTabs(); } catch (e) {}
    }
    if (sessionSanitize.changed) await persistRuntime();
    if (runtime.running) {
      log('info', 'Resumed after service-worker restart at slug ' + (runtime.cursor + 1));
      startKeepAlive();
      // Close automation tabs orphaned by the restart BEFORE reprocessing the
      // current slug, otherwise every restart leaks an extra WP/AI tab.
      closeOrphanedWorkTabs()
        .catch(() => {})
        .then(() => processLoop().catch(e => log('err', 'Loop error: ' + e.message)));
    } else {
      runtime.trackedTabs = [];
      runtime.rescueTabId = null;
    }
  }
  // Chunked Fast Submit: reconcile the master plan after a restart. No-ops when
  // a runtime batch is already resuming (that path owns the transition).
  try { await reconcileFastCyclePlan(); }
  catch (e) { log('err', 'Fast cycle reconcile failed: ' + (e?.message || e)); }
}

// Only closes tabs whose URL belongs to the batch (WP site, AI provider, or our
// worker page). The URL check protects against Chrome reusing tab IDs after a
// full browser restart — we never close an unrelated user tab.
async function closeOrphanedWorkTabs() {
  const rescueId = (runtime.paused && runtime.rescueTabId) ? Number(runtime.rescueTabId) : null;
  const ids = [...new Set((runtime.trackedTabs || []).filter(id => id && id !== runtime.panelTabId && id !== rescueId))];
  runtime.trackedTabs = rescueId ? [rescueId] : [];
  runtime.bridgeTabId = null;
  if (!ids.length) return;
  const okOrigins = new Set();
  // v3.46.0: the fact-check AI's tabs (a different AI than the job's) too.
  [runtime.job?.site?.url, runtime.job?.aiUrl, runtime.job?.fallbackAi?.aiUrl, runtime.job?.factCheckAi?.aiUrl].forEach((u) => {
    try { if (u) okOrigins.add(new URL(u).origin); } catch (e) {}
  });
  let closed = 0;
  for (const id of ids) {
    try {
      const tab = await chrome.tabs.get(id);
      const url = tab?.url || tab?.pendingUrl || '';
      let origin = '';
      try { origin = new URL(url).origin; } catch (e) {}
      const isExtensionPage = url.startsWith(chrome.runtime.getURL('')) && !url.includes('panel.html');
      if (isExtensionPage || (origin && okOrigins.has(origin))) {
        if (await safeCloseTab(id)) closed++;
      }
    } catch (e) { /* tab already gone */ }
  }
  if (closed) log('info', 'Closed ' + closed + ' leftover automation tab(s) from before the restart.');
}

// Focus the existing panel tab if one is open instead of stacking duplicates.
async function openPanel() {
  const url = chrome.runtime.getURL('panel.html');
  try {
    const tabs = await chrome.tabs.query({ url: url + '*' });
    if (tabs.length && tabs[0].id) {
      await chrome.windows.update(tabs[0].windowId, { focused: true });
      await chrome.tabs.update(tabs[0].id, { active: true });
      return;
    }
  } catch (e) {}
  try { await chrome.tabs.create({ url }); } catch (e) {}
}

function notifyBatchDone(title, message) {
  try {
    if (!chrome.notifications?.create) return;
    chrome.notifications.create('apu-' + Date.now(), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: title,
      message: String(message || '').slice(0, 300),
      priority: 2
    });
  } catch (e) {}
}

chrome.runtime.onStartup.addListener(loadRuntime);
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    openPanel();
  }
  // NOTE: do not call loadRuntime() here - the top-level loadRuntime() below
  // already runs on every service-worker start. Calling it twice could launch
  // two concurrent processLoop() runs for the same batch.
});
chrome.action.onClicked.addListener(() => { openPanel(); });
loadRuntime();

// ──────────────────────────────────────────────────────────────────────
// Logging
// ──────────────────────────────────────────────────────────────────────
function log(kind, msg) {
  const time = new Date().toLocaleTimeString();
  runtime.log.push({ time, kind, msg });
  if (runtime.log.length > MAX_LOG) runtime.log.shift();
  console.log('[Batch]', kind, msg);
}

function setStatus(text, kind) {
  runtime.statusText = text;
  runtime.statusKind = kind || '';
}

function estimateEtaSeconds() {
  if (!runtime.running || !runtime.job?.slugs?.length || !runtime.slugDurations?.length) return 0;
  const remaining = Math.max(0, runtime.job.slugs.length - runtime.cursor);
  if (!remaining) return 0;
  const avg = runtime.slugDurations.reduce((a, b) => a + b, 0) / runtime.slugDurations.length;
  const delayMs = (Number(runtime.job.delayBetween) || 0) * 1000;
  const par = Math.max(1, Math.min(5, Number(runtime.job.parallel) || 1));
  return Math.round((remaining * (avg + delayMs)) / par / 1000);
}

// ──────────────────────────────────────────────────────────────────────
// Live settings — merge changed options into a running/paused job. Slugs,
// cursor and progress are untouched; changes take effect from the next post.
// ──────────────────────────────────────────────────────────────────────
function applyLiveJobSettings(cfg) {
  const job = runtime.job;
  if (!job || !cfg) return;
  const allowed = ['site','aiUrl','aiName','aiKind','aiMode','aiProvider','aiApiBaseUrl','aiApiModel','aiApiKey','prompt','delayBetween','aiTimeout','updateWait','settleTime','onMissing','maxRetries','backgroundMode','completeness','apiMaxTokens','fallbackAi','autoSplit','pasteWait','continueRounds','retryMode','promptType','auditRetry','auditRetryCount','auditRetryTiming','htmlRecoveryAudit','htmlRecoveryFailed','htmlRecoveryAnyCode','limitGuard','failStopCount','failRetryAfter','fastPasteWait','fastPasteRetries','modelLimitGuard','geminiFlashGuard','modelLimitRetryHours','limitResumeMode','gateEnabled','gateLinkCheck','gateNewFaq','gateSiteDomains','factCheck','factCheckAi','factCheckPrompt','factCheckOnError','promptWebSearch'];
  const changed = [];
  allowed.forEach((k) => {
    if (cfg[k] === undefined) return;
    if (JSON.stringify(cfg[k]) !== JSON.stringify(job[k])) { job[k] = cfg[k]; changed.push(k); }
  });
  job.maxRetries = Number.isFinite(job.maxRetries) ? Math.max(0, Math.min(3, job.maxRetries)) : 1;
  job.settleTime = Number.isFinite(job.settleTime) ? Math.max(1, Math.min(20, job.settleTime)) : 3;
  job.delayBetween = Number(job.delayBetween) || 0;
  job.pasteWait = Number.isFinite(Number(job.pasteWait)) && Number(job.pasteWait) > 0 ? Math.max(1, Math.min(30, Number(job.pasteWait))) : 1;
  job.continueRounds = 0; // one-shot: continuation / fix-it / recovery prompts removed
  job.retryMode = ['end', 'inline', 'off'].includes(job.retryMode) ? job.retryMode : 'end';
  job.auditRetry = (job.auditRetry === true || job.auditRetry === 'on');
  job.auditRetryCount = Number.isFinite(Number(job.auditRetryCount)) ? Math.max(1, Math.min(3, Number(job.auditRetryCount))) : 1;
  job.auditRetryTiming = ['immediate', 'end'].includes(job.auditRetryTiming) ? job.auditRetryTiming : 'end';
  job.htmlRecoveryAudit = (job.htmlRecoveryAudit === true || job.htmlRecoveryAudit === 'on');
  job.htmlRecoveryFailed = (job.htmlRecoveryFailed === true || job.htmlRecoveryFailed === 'on');
  job.htmlRecoveryAnyCode = (job.htmlRecoveryAnyCode === true || job.htmlRecoveryAnyCode === 'on');
  job.limitGuard = (job.limitGuard === true || job.limitGuard === 'on');
  // Repeated-failure policy: 0 = never auto-pause; retry delay 0 = manual only.
  job.failStopCount = Number.isFinite(Number(job.failStopCount)) ? Math.max(0, Math.min(100, Number(job.failStopCount))) : 5;
  job.failRetryAfter = Number.isFinite(Number(job.failRetryAfter)) ? Math.max(0, Math.min(1440, Number(job.failRetryAfter))) : 60;
  // Fast Submit: seconds to wait after paste verification before pressing Send.
  job.fastPasteWait = Number.isFinite(Number(job.fastPasteWait)) ? Math.max(1, Math.min(600, Math.round(Number(job.fastPasteWait)))) : 10;
  job.fastPasteRetries = Number.isFinite(Number(job.fastPasteRetries)) ? Math.max(1, Math.min(3, Math.round(Number(job.fastPasteRetries)))) : 3;
  // Model Limit guard is ON unless the user explicitly turned it off.
  job.modelLimitGuard = !(job.modelLimitGuard === false || job.modelLimitGuard === 'off');
  // Gemini Flash guard is ON unless the user explicitly turned it off.
  job.geminiFlashGuard = !(job.geminiFlashGuard === false || job.geminiFlashGuard === 'off');

  // Model-limit retry delay in HOURS. 0 = stay paused until Resume.

  job.modelLimitRetryHours = Number.isFinite(Number(job.modelLimitRetryHours)) ? Math.max(0, Math.min(48, Math.round(Number(job.modelLimitRetryHours)))) : 0;
  // 'exact' = resume at the reset time the AI states; 'timer' = always use the
  // hours setting above.
  job.limitResumeMode = (job.limitResumeMode === 'timer') ? 'timer' : 'exact';
  // Safety Gate + Fact-Check (v3.46.0).
  normalizeSafetyGateSettings(job);
  if (changed.length) log('info', 'Applied updated settings to the running batch (' + changed.join(', ') + '). Effective from the next post.');
}

// Safety Gate + Fact-Check job fields (v3.46.0). Shared by startBatch and
// applyLiveJobSettings. Both switches are ON unless explicitly turned off.
function normalizeSafetyGateSettings(job) {
  if (!job) return;
  job.gateEnabled = !(job.gateEnabled === false || job.gateEnabled === 'off');
  job.gateLinkCheck = !(job.gateLinkCheck === false || job.gateLinkCheck === 'off');
  job.gateNewFaq = (job.gateNewFaq === 'no') ? 'no' : 'auto';
  // Extra internal domains from the panel. The site's own host is always
  // added at use time (gateSiteDomainsOf), so it never has to be typed.
  const rawDomains = Array.isArray(job.gateSiteDomains)
    ? job.gateSiteDomains
    : String(job.gateSiteDomains || '').split(/[\s,;]+/);
  const domains = [];
  rawDomains.forEach((d) => {
    const h = normalizeGateHost(d);
    if (h && domains.indexOf(h) === -1) domains.push(h);
  });
  job.gateSiteDomains = domains;
  job.factCheck = !(job.factCheck === false || job.factCheck === 'off');
  // '' = the job's own AI; otherwise a resolved AI config (like fallbackAi).
  const fa = job.factCheckAi;
  job.factCheckAi = (fa && typeof fa === 'object' && (fa.aiUrl || (fa.aiMode && fa.aiMode !== 'web'))) ? fa : '';
  job.factCheckPrompt = (typeof job.factCheckPrompt === 'string') ? job.factCheckPrompt : '';
  job.factCheckOnError = (job.factCheckOnError === 'save') ? 'save' : 'keep';
  job.promptWebSearch = (job.promptWebSearch === true || job.promptWebSearch === 'on');
}

function swapJobAi(fb) {
  const keys = ['aiUrl','aiName','aiKind','aiMode','aiProvider','aiApiBaseUrl','aiApiModel','aiApiKey'];
  const saved = {};
  keys.forEach((k) => { saved[k] = runtime.job[k]; if (fb && fb[k] !== undefined) runtime.job[k] = fb[k]; });
  return saved;
}
function restoreJobAi(saved) {
  if (!saved) return;
  Object.keys(saved).forEach((k) => { runtime.job[k] = saved[k]; });
}

// ──────────────────────────────────────────────────────────────────────
// Start a batch
// ──────────────────────────────────────────────────────────────────────
async function startBatch(job, options) {
  if (batchStarting) throw new Error('Another batch is already starting.');
  batchStarting = true;
  try {
  // Defensive validation - a malformed job would otherwise throw deep inside
  // processLoop and leave runtime.running stuck on.
  if (!job || typeof job !== 'object') throw new Error('Invalid job payload.');
  if (!Array.isArray(job.slugs) || job.slugs.length === 0) throw new Error('Job has no slugs to process.');
  if (!job.site || !job.site.url) throw new Error('Job is missing a WordPress site.');

  // Sanity defaults
  job.maxRetries  = Number.isFinite(job.maxRetries)  ? Math.max(0, Math.min(3, job.maxRetries))  : 1;
  job.settleTime  = Number.isFinite(job.settleTime)  ? Math.max(1, Math.min(20, job.settleTime)) : 3;
  job.delayBetween = Number(job.delayBetween) || 0;
  job.pasteWait = Number.isFinite(Number(job.pasteWait)) && Number(job.pasteWait) > 0 ? Math.max(1, Math.min(30, Number(job.pasteWait))) : 1;
  job.continueRounds = 0; // one-shot: continuation / fix-it / recovery prompts removed
  job.retryMode = ['end', 'inline', 'off'].includes(job.retryMode) ? job.retryMode : 'end';
  job.auditRetry = (job.auditRetry === true || job.auditRetry === 'on');
  job.auditRetryCount = Number.isFinite(Number(job.auditRetryCount)) ? Math.max(1, Math.min(3, Number(job.auditRetryCount))) : 1;
  job.auditRetryTiming = ['immediate', 'end'].includes(job.auditRetryTiming) ? job.auditRetryTiming : 'end';
  job.htmlRecoveryAudit = (job.htmlRecoveryAudit === true || job.htmlRecoveryAudit === 'on');
  job.htmlRecoveryFailed = (job.htmlRecoveryFailed === true || job.htmlRecoveryFailed === 'on');
  job.htmlRecoveryAnyCode = (job.htmlRecoveryAnyCode === true || job.htmlRecoveryAnyCode === 'on');
  // Auto-pause the batch when an AI usage/weekly limit is detected.
  job.limitGuard = (job.limitGuard === true || job.limitGuard === 'on');
  // Repeated-failure policy: 0 = never auto-pause; retry delay 0 = manual only.
  job.failStopCount = Number.isFinite(Number(job.failStopCount)) ? Math.max(0, Math.min(100, Number(job.failStopCount))) : 5;
  job.failRetryAfter = Number.isFinite(Number(job.failRetryAfter)) ? Math.max(0, Math.min(1440, Number(job.failRetryAfter))) : 60;
  // Fast Submit: seconds to wait after paste verification before pressing Send.
  job.fastPasteWait = Number.isFinite(Number(job.fastPasteWait)) ? Math.max(1, Math.min(600, Math.round(Number(job.fastPasteWait)))) : 10;
  job.fastPasteRetries = Number.isFinite(Number(job.fastPasteRetries)) ? Math.max(1, Math.min(3, Math.round(Number(job.fastPasteRetries)))) : 3;
  // Model Limit guard is ON unless the user explicitly turned it off.
  job.modelLimitGuard = !(job.modelLimitGuard === false || job.modelLimitGuard === 'off');
  // Gemini Flash guard is ON unless the user explicitly turned it off.
  job.geminiFlashGuard = !(job.geminiFlashGuard === false || job.geminiFlashGuard === 'off');

  // Model-limit retry delay in HOURS. 0 = stay paused until Resume.

  job.modelLimitRetryHours = Number.isFinite(Number(job.modelLimitRetryHours)) ? Math.max(0, Math.min(48, Math.round(Number(job.modelLimitRetryHours)))) : 0;
  // 'exact' = resume at the reset time the AI states; 'timer' = always use the
  // hours setting above.
  job.limitResumeMode = (job.limitResumeMode === 'timer') ? 'timer' : 'exact';
  // Safety Gate + Fact-Check (v3.46.0).
  normalizeSafetyGateSettings(job);
  const requestedRecoverHome = normalizeHttpUrl(
    (typeof job.recoverProviderUrl === 'string') ? job.recoverProviderUrl.trim() : ''
  );
  job.recoverProviderUrl = requestedRecoverHome;
  const cleanRecoverProviderMap = {};
  if (job.recoverProviderMap && typeof job.recoverProviderMap === 'object') {
    for (const [recoverSlug, providerUrlValue] of Object.entries(job.recoverProviderMap)) {
      const providerUrl = normalizeHttpUrl(providerUrlValue);
      if (providerUrl) cleanRecoverProviderMap[recoverSlug] = providerUrl;
    }
  }
  job.recoverProviderMap = Object.keys(cleanRecoverProviderMap).length ? cleanRecoverProviderMap : null;

  const requestedRecoverUrl = (typeof job.recoverFromUrl === 'string') ? job.recoverFromUrl.trim() : '';
  const canonicalRecoverUrl = canonicalizeAISessionUrl(
    requestedRecoverUrl,
    detectProviderKind(requestedRecoverUrl || requestedRecoverHome),
    requestedRecoverHome
  );
  if (requestedRecoverUrl && !canonicalRecoverUrl) {
    throw new Error('The saved AI link is not a verified, canonical conversation URL. Use “Retry new” for this post.');
  }
  job.recoverFromUrl = canonicalRecoverUrl;
  if (job.recoverMap && typeof job.recoverMap === 'object') {
    const cleanRecoverMap = {};
    for (const [recoverSlug, recoverUrlValue] of Object.entries(job.recoverMap)) {
      const recoverUrl = String(recoverUrlValue || '').trim();
      const providerHome = cleanRecoverProviderMap[recoverSlug] || requestedRecoverHome;
      const canonicalRecoverMapUrl = canonicalizeAISessionUrl(
        recoverUrl,
        detectProviderKind(recoverUrl || providerHome),
        providerHome
      );
      if (!canonicalRecoverMapUrl) {
        throw new Error('No recoverable AI conversation link was saved for “' + cleanSlug(recoverSlug) + '”. Use “Retry new” for that post.');
      }
      cleanRecoverMap[recoverSlug] = canonicalRecoverMapUrl;
    }
    job.recoverMap = Object.keys(cleanRecoverMap).length ? cleanRecoverMap : null;
  } else {
    job.recoverMap = null;
  }
  job.recoverAnyCode = job.recoverAnyCode === true && !!(job.recoverFromUrl || job.recoverMap);
  // Accept a saved chat's HTML when it has an intro, a FAQ and a conclusion.
  job.recoverSections = job.recoverSections === true && !!(job.recoverFromUrl || job.recoverMap);
  // Bulk audit re-run: per-post audit issues that ride along with the prompt.
  job.issueMap = (job.issueMap && typeof job.issueMap === 'object') ? job.issueMap : null;

  // Original HTML Fresh Recovery: rebuild from the pre-update backup only.

  job.freshFromBackup = (job.freshFromBackup === true);
  // Bulk parallel run: how many posts may process AT THE SAME TIME (1-5).
  job.parallel = Number.isFinite(Number(job.parallel)) ? Math.max(1, Math.min(5, Number(job.parallel))) : 1;
  // Fast Submit: paste + send every prompt WITHOUT waiting, recover later.
  job.fastSubmit = job.fastSubmit === true;
  job.recoverAfterMin = Math.max(0, Math.min(720, Number(job.recoverAfterMin) || 0));
  if (job.fastSubmit) {
    if (job.aiMode && job.aiMode !== 'web') throw new Error('Fast Submit works only with web AI providers — API mode returns the reply immediately, there is no chat session to recover later.');
    job.parallel = 1;
    job.autoSplit = 'off';   // chunks need each part finished first — impossible fire-and-forget
    job.fallbackAi = null;
  }
  // "Recover myself (manual)": submit every post in one pass with NO auto timer
  // and NO per-cycle chunking. Recovery happens only when the user presses
  // "Recover & Update Now".
  job.fastManual = (job.fastManual === true || job.fastManual === 'on');
  // Chunked Fast Submit: a brand-new fast submit (no cycle id yet) builds the
  // crash-safe master plan and is sliced down to its first cycle. Recovery jobs,
  // internally-launched later cycles (fastCycleId), and manual mode skip this.
  if (job.fastSubmit && !job.fastCycleId && !job.fastManual) {
    await createFastCyclePlanIfNeeded(job);
    // Single-cycle run (list ≤ one chunk): discard any stale plan from a prior
    // multi-cycle run so the panel never shows leftover cycle progress.
    if (!job.fastCycleId) await clearFastCyclePlan();
  } else if (job.fastSubmit && job.fastManual && !job.fastCycleId) {
    // Manual mode never chunks — clear any stale plan so no cycle UI lingers.
    await clearFastCyclePlan();
  }
  if (job.parallel > 1) {
    // Parallel tabs must live in the background worker window (they cannot all
    // hold focus), and the fallback AI is disabled because it temporarily
    // mutates the shared job config — unsafe with concurrent posts.
    if (job.backgroundMode !== 'on') job.backgroundMode = 'on';
    if (job.fallbackAi) job.fallbackAi = null;
  }
  job.strictMode = 'loose';

  runtime.running = true;
  runtime.paused = false;
  runtime.stopRequested = false;
  runtime.job = job;
  runtime.cursor = 0;
  runtime.successes = 0;
  runtime.log = [];
  runtime.failures = [];
  runtime.attempts = [];
  runtime.trackedTabs = [];
  runtime.slugDurations = [];
  runtime.retryPass = 0;
  runtime.retryQueue = [];
  runtime.retryNotes = {};
  runtime.auditRetryQueue = [];
  runtime.consecFails = 0;
  runtime.failProbation = false;
  runtime.failRetryCycles = 0;

  runtime.modelLimitRetries = 0;
  runtime.limitAlert = null;      // a new run clears the previous limit alert
  runtime.autoPauseReason = '';
  runtime.autoPauseKind = '';
  try { chrome.alarms.clear(FAIL_RETRY_ALARM); } catch (e) {}

  try { chrome.alarms.clear(MODEL_LIMIT_ALARM); } catch (e) {}
  runtime.rescueTabId = null;
  runtime.parallelDone = [];
  runtime.sessionId = Date.now();
  runtime.bridgeTabId = null;
  wpFetchMode = { origin: '', mode: 'direct' };
  setStatus('Starting batch — ' + job.slugs.length + ' posts on ' + job.site.name);
  log('step', 'Batch started: ' + job.slugs.length + ' slugs on ' + job.site.name + ' via ' + job.aiName);
  log('info', 'Settings: AI timeout ' + job.aiTimeout + 's, retries ' + job.maxRetries + ', settle ' + job.settleTime + 's, update wait ' + job.updateWait + 's, HTML safety loose size only' +
    ', Safety Gate ' + (safetyGateOn() ? 'ON' : 'OFF') + ', fact check ' + (factCheckOn() ? 'ON' : 'OFF') +
    (job.promptWebSearch ? ', web search allowed' : ''));
  if (job.parallel > 1) log('step', '⚡ PARALLEL MODE: up to ' + job.parallel + ' posts at the same time (worker window forced on; fallback AI disabled while parallel).');
  await persistRuntime();
  if (options?.deferProcess !== true) launchCurrentBatchLoop();
  } finally {
    batchStarting = false;
  }
}

function launchCurrentBatchLoop() {
  startKeepAlive();
  processLoop().catch(e => log('err', 'Loop error: ' + e.message));
}

// ──────────────────────────────────────────────────────────────────────
// Main processing loop
// ──────────────────────────────────────────────────────────────────────
async function processLoop() {
  if (processing) return;            // a loop is already running this batch
  processing = true;
  // Set when a chunked Fast Submit recovery cycle finishes and the plan should
  // advance. Run AFTER the re-entrancy guard is released (see end of function).
  let advanceCycleJob = null;
  try {
  if (!runtime.job || !Array.isArray(runtime.job.slugs)) {
    runtime.running = false;
    stopKeepAlive();
    return;
  }
  let stoppedForMissing = false;
  if (runtime.job.fastSubmit) {
    await runFastSubmitPass();
  } else if ((Number(runtime.job.parallel) || 1) > 1) {
    stoppedForMissing = await runParallelBatch();
  } else
  for (let batchPass = 0; batchPass < 2; batchPass++) {
  if (batchPass === 1) {
    // ── End-of-batch retry pass: failed posts are re-tried only AFTER every
    // other post has been processed (never immediately). ──
    if (runtime.stopRequested || stoppedForMissing) break;
    if ((runtime.job.retryMode || 'end') !== 'end') break;
    if (runtime.retryPass !== 0) break;
    const queue = [...new Set(runtime.retryQueue || [])];
    runtime.retryQueue = [];
    if (!queue.length) break;
    runtime.retryPass = 1;
    runtime.job.slugs = queue;
    runtime.cursor = 0;
    log('step', '↻ All posts processed — now retrying ' + queue.length + ' failed post(s).');
    setStatus('Retry pass — ' + queue.length + ' failed post(s)');
    await persistRuntime();
    await sleep(2000);
  }
  while (runtime.running && runtime.cursor < runtime.job.slugs.length) {
    while (runtime.paused && !runtime.stopRequested) {
      // Keep the auto-pause explanation visible instead of a bare "Paused."
      setStatus(runtime.autoPauseReason || 'Paused.', runtime.autoPauseReason ? 'error' : '');
      await swPing();              // keep the service worker alive while paused
      await sleep(2000);
    }
    if (runtime.stopRequested) break;

    const rawSlug = runtime.job.slugs[runtime.cursor];
    const slug = cleanSlug(rawSlug);
    const num = runtime.cursor + 1;
    const total = runtime.job.slugs.length;
    const slugStartedAt = Date.now();

    log('step', '──── [' + num + '/' + total + '] ' + slug + ' ────');
    setStatus('[' + num + '/' + total + '] Processing "' + slug + '"');
    await persistRuntime();

    const attemptLinks = { rawInput: rawSlug };
    // Manual "Retry via AI session": a single-slug job carries recoverFromUrl, so this
    // post is recovered from its saved session (read the existing code box) instead
    // of regenerated.
    if (runtime.job.recoverFromUrl) {
      attemptLinks.recoverFromUrl = runtime.job.recoverFromUrl;
      attemptLinks.recoverProviderUrl = runtime.job.recoverProviderUrl || '';
    } else if (runtime.job.recoverMap && runtime.job.recoverMap[rawSlug]) {
      attemptLinks.recoverFromUrl = runtime.job.recoverMap[rawSlug];
      attemptLinks.recoverProviderUrl = runtime.job.recoverProviderMap?.[rawSlug] || runtime.job.recoverProviderUrl || '';
    }
    // Audit-fix re-run: this post's own audit issues are attached to the prompt
    // so the AI is told exactly what was wrong with THIS article last time.
    if (runtime.job.issueMap && runtime.job.issueMap[rawSlug]) {
      attemptLinks.auditFixNote = buildAuditFixNote(runtime.job.issueMap[rawSlug]);
      log('info', '[' + num + '/' + total + '] Audit-fix mode: sending this post with its previous audit issues attached to the prompt.');
    }
    // v3.46.0: automatic retries carry the Safety Gate / fact-check reasons of
    // the previous attempt as a PRIORITY FIX note (replaced on every retry).
    const baseFixNote = attemptLinks.auditFixNote || '';
    if (runtime.retryPass === 1) applyCarriedRetryNote(rawSlug, attemptLinks, baseFixNote, '[' + num + '/' + total + ']');
    // Attempt budget: in "end" retry mode the main pass tries each post ONCE —
    // failed posts are queued and re-tried after all other posts are done
    // (using "Max retries per post" as the attempt budget for that pass).
    const retryMode = runtime.job.retryMode || 'end';
    const inlineRetries = retryMode === 'inline'
      ? runtime.job.maxRetries
      : (retryMode === 'end' && runtime.retryPass === 1 ? runtime.job.maxRetries : 0);
    let lastErr = null;
    let success = false;
    // Per-attempt tab tracking; closed between retries so we don't leak tabs.
    const attemptTabs = { edit: null, ai: null };

    for (let tryNum = 0; tryNum <= inlineRetries; tryNum++) {
      if (runtime.stopRequested) break;
      if (tryNum > 0) {
        log('warn', '↻ Retry ' + tryNum + '/' + inlineRetries + ' for "' + slug + '" (previous: ' + (lastErr?.message || 'unknown') + ')');
        setStatus('[' + num + '/' + total + '] Retry ' + tryNum + '/' + inlineRetries + ' "' + slug + '"');
        applyRetryFixNote(attemptLinks, baseFixNote, lastErr, '[' + num + '/' + total + ']');
        // Close leftover tabs from the previous attempt
        if (attemptTabs.ai)   { await safeCloseTab(attemptTabs.ai);   attemptTabs.ai = null; }
        if (attemptTabs.edit) { await safeCloseTab(attemptTabs.edit); attemptTabs.edit = null; }
        await sleep(3000);
      }
      try {
        await processSlug(slug, num, total, attemptLinks, tryNum, attemptTabs);
        success = true;
        break;
      } catch (e) {
        lastErr = e;
        // Don't retry "post not found" (it's deterministic)
        if (e.code === 'POST_NOT_FOUND') break;
        // Don't retry user-stopped
        if (e.code === 'USER_STOPPED') break;
        // Don't retry a usage-limit hit — it will just hit the limit again.
        if (e.code === 'AI_LIMIT') break;
        // Don't retry a model limit: every retry would run on the limited or
        // downgraded model, which is exactly what must not happen. One attempt
        // then pause is the rule.
        if (e.code === 'MODEL_LIMIT') break;
      }
    }

    // Optional fallback AI: if the primary AI failed (and it was not "post not
    // found" or a user stop), retry this one post once with a different AI -
    // typically an API service that will not truncate big articles.
    if (!success && runtime.job.fallbackAi && lastErr && lastErr.code !== 'POST_NOT_FOUND' && lastErr.code !== 'USER_STOPPED' && lastErr.code !== 'MODEL_LIMIT' && !runtime.stopRequested) {
      const fb = runtime.job.fallbackAi;
      log('warn', '[' + num + '/' + total + '] Primary AI failed (' + (lastErr.message || 'error') + '). Trying fallback AI: ' + (fb.aiName || 'fallback'));
      setStatus('[' + num + '/' + total + '] Trying fallback AI ' + (fb.aiName || ''));
      if (attemptTabs.ai)   { await safeCloseTab(attemptTabs.ai);   attemptTabs.ai = null; }
      if (attemptTabs.edit) { await safeCloseTab(attemptTabs.edit); attemptTabs.edit = null; }
      applyRetryFixNote(attemptLinks, baseFixNote, lastErr, '[' + num + '/' + total + ']');
      const savedAi = swapJobAi(fb);
      try {
        await processSlug(slug, num, total, attemptLinks, 0, attemptTabs);
        success = true;
        log('ok', '[' + num + '/' + total + '] Fallback AI succeeded.');
      } catch (e) {
        lastErr = e;
        log('err', '[' + num + '/' + total + '] Fallback AI also failed: ' + (e.message || e));
      }
      restoreJobAi(savedAi);
    }

    // Automatic HTML Code Recovery (opt-in): a failed post is first retried by
    // reopening its saved AI session and reading the existing code box, BEFORE
    // any fresh regeneration ("retry new").
    // Safety Gate / Fact-Check blocks are skipped: re-reading the same chat
    // reply can never pass the same checks.
    let recovered = false;
    if (!success && !runtime.stopRequested && htmlRecoveryFailedOn() &&
        attemptLinks.aiSessionUrl && !isApiAIJob() &&
        lastErr?.code !== 'POST_NOT_FOUND' && lastErr?.code !== 'USER_STOPPED' &&
        !isSafetyBlockCode(lastErr?.code)) {
      recovered = await tryHtmlRecovery(rawSlug, slug, num, total, attemptLinks.aiSessionUrl, attemptLinks.aiProviderUrl);
    }

    if (success) {
      runtime.successes++;
      noteRunSuccess();
      // A success wipes any earlier failure report for this post (e.g. when
      // the end-of-batch retry rescued it).
      runtime.failures = runtime.failures.filter(f => f.slug !== slug);
      rememberAttempt(rawSlug, slug, 'updated', attemptLinks.auditReport ? ('Updated on WordPress — ' + attemptLinks.auditReport) : 'Updated on WordPress', attemptLinks);
      log('ok', '✓ [' + num + '/' + total + '] ' + slug);
      // The post is saved: a later Audit Retry must not repeat the gate
      // reasons of an earlier try (v3.46.0) — only the job's own note stays.
      setRetryFixNote(attemptLinks, baseFixNote, '');
      // Audit Retry (opt-in): if this saved post's audit reported issues, retry
      // it now (timing=immediate) or queue it for the end pass (timing=end).
      await maybeAuditRetry(rawSlug, slug, num, total, attemptLinks, attemptTabs);
    } else if (recovered) {
      runtime.successes++;
      noteRunSuccess();
      runtime.failures = runtime.failures.filter(f => f.slug !== slug);
      log('ok', '✓ [' + num + '/' + total + '] ' + slug + ' (recovered from the saved AI session)');
    } else if (lastErr?.code === 'MODEL_LIMIT') {
      // Model limit: halt work at once, but keep this post's place. Nothing was
      // sent, so the cursor is NOT advanced — Resume (or the retry timer)
      // continues from this exact post, and it is never marked failed.
      log('err', '🚫 [' + num + '/' + total + '] ' + slug + ' — ' + lastErr.message);
      if (attemptTabs.ai)   { await safeCloseTab(attemptTabs.ai);   attemptTabs.ai = null; }
      if (attemptTabs.edit) { await safeCloseTab(attemptTabs.edit); attemptTabs.edit = null; }
      await pauseForModelLimit(lastErr.aiName || runtime.job.aiName, lastErr.message, lastErr.limitDetection);
      continue;   // the top-of-loop pause gate holds the batch here
    } else {
      const errMsg = lastErr?.message || 'Unknown error';
      log('err', '✗ [' + num + '/' + total + '] ' + slug + ': ' + errMsg);
      runtime.failures.push({
        slug,
        time: new Date().toLocaleTimeString(),
        message: errMsg,
        note: lastErr?.keepTabs ? 'Tabs were closed automatically — open the AI session link in Processed Links to review.' : ''
      });
      runtime.failures = runtime.failures.slice(-50);
      rememberAttempt(rawSlug, slug, 'failed', errMsg, attemptLinks);
      // AI usage/weekly limit reached: PAUSE the whole batch immediately (guarded
      // by the toggle). Re-queue this post so Resume retries it — the rest of the
      // list is preserved instead of failing one-by-one against the same wall.
      if (lastErr?.code === 'AI_LIMIT' && limitGuardOn() && !runtime.stopRequested) {
        // The cursor is NOT advanced (we `continue` below), so Resume retries
        // this exact post — no need to also queue it for the end pass.
        runtime.paused = true;
        runtime.autoPauseReason = '⛔ Paused — AI usage limit reached (' +
          String(lastErr.limitText || 'the provider is refusing new messages').slice(0, 140) +
          '). Wait for the limit to reset or switch AI, then press Resume.';
        log('warn', '⛔ ' + runtime.autoPauseReason);
        notifyBatchDone('Paused — AI usage limit', 'The AI reported a usage/weekly limit. The batch is paused; resume after the limit resets or switch to another AI.');
        // Close this slug's tabs, persist, and stop processing further posts now.
        if (attemptTabs.ai)   { await safeCloseTab(attemptTabs.ai);   attemptTabs.ai = null; }
        if (attemptTabs.edit) { await safeCloseTab(attemptTabs.edit); attemptTabs.edit = null; }
        await persistRuntime();
        continue;   // top-of-loop pause gate holds the batch until Resume
      }
      if (retryMode === 'end' && runtime.retryPass === 0 && lastErr?.code !== 'POST_NOT_FOUND' && lastErr?.code !== 'USER_STOPPED') {
        runtime.retryQueue.push(rawSlug);
        rememberRetryNote(rawSlug, lastErr, attemptLinks);
        log('info', '[' + num + '/' + total + '] Queued "' + slug + '" for the end-of-batch retry pass.');
      }
      // Repeated failures mean something systemic (site login, AI login, wrong
      // prompt, firewall). How many in a row are tolerated — and whether the
      // run retries itself later — is the user's "Stop after N failures" and
      // "Auto-retry after" choice. With "Never stop" the batch keeps going.
      runtime.consecFails = (Number(runtime.consecFails) || 0) + 1;
      if (shouldPauseForConsecutiveFailures() && runtime.retryPass === 0 &&
          !runtime.stopRequested && lastErr?.code !== 'USER_STOPPED' &&
          runtime.cursor + 1 < runtime.job.slugs.length) {
        await pauseForRepeatedFailures('Batch', errMsg);
      }
      if (lastErr?.code === 'POST_NOT_FOUND' && runtime.job.onMissing === 'stop') {
        runtime.cursor++;
        await persistRuntime();
        stoppedForMissing = true;
        break;
      }
    }

    // BUG FIX: failed posts used to leave their AI (and editor) tabs open.
    // Whatever happened above, close this slug's automation tabs now — the AI
    // session link is already saved in Processed Links for review.
    if (attemptTabs.ai)   { await safeCloseTab(attemptTabs.ai);   attemptTabs.ai = null; }
    if (attemptTabs.edit) { await safeCloseTab(attemptTabs.edit); attemptTabs.edit = null; }

    runtime.slugDurations.push(Date.now() - slugStartedAt);
    if (runtime.slugDurations.length > 100) runtime.slugDurations.shift();

    runtime.cursor++;
    await persistRuntime();

    // Delay before next
    if (runtime.cursor < runtime.job.slugs.length && runtime.job.delayBetween > 0) {
      const delay = runtime.job.delayBetween;
      for (let i = delay; i > 0; i--) {
        if (runtime.stopRequested) break;
        while (runtime.paused && !runtime.stopRequested) {
          setStatus(runtime.autoPauseReason || 'Paused.', runtime.autoPauseReason ? 'error' : '');
          await swPing(); await sleep(2000);
        }
        if (i % 15 === 0) await swPing();   // keep the SW alive through long delays
        setStatus('Waiting ' + i + 's before next post...');
        await sleep(1000);
      }
    }
  }

  }

  // End-of-batch Audit Retry pass (opt-in; runs only when audit retry is ON
  // and timing = "end"). Self-contained: re-processes queued audit-issue posts.
  if (!runtime.stopRequested) {
    try { await runAuditRetryEndPass(); }
    catch (e) { log('err', 'Audit-retry pass crashed: ' + (e && e.message ? e.message : e)); }
  }

  // Detect a completed chunked Fast Submit recovery cycle. Captured before the
  // batch state is torn down; advancement runs after the guard releases.
  const fcRecoveryJob = (runtime.job && runtime.job.fastCycleRecovery === true) ? runtime.job : null;
  if (fcRecoveryJob && !runtime.stopRequested) advanceCycleJob = fcRecoveryJob;

  if (!runtime.stopRequested && runtime.job.fastSubmit) {
    // runFastSubmitPass already set its own final status + notification
    // ("submitted" wording and the recovery schedule) — nothing extra here.
  } else if (fcRecoveryJob && !runtime.stopRequested) {
    // One cycle's recovery finished. The plan (finishRecoveryBatch) owns the
    // status/notification — keep this quiet so only the final cycle notifies.
    log('ok', '⏰ Cycle recovery finished: ' + runtime.successes + ' updated, ' + runtime.failures.length + ' failed this cycle. Advancing the plan…');
    setStatus('⏰ Cycle recovery finished — ' + runtime.successes + ' updated. Preparing the next cycle…');
  } else if (runtime.stopRequested) {
    log('warn', '⏹ Batch stopped by user at ' + runtime.cursor + '/' + runtime.job.slugs.length);
    setStatus('Stopped at ' + runtime.cursor + '/' + runtime.job.slugs.length, 'error');
  } else if (stoppedForMissing) {
    log('err', 'Batch stopped: a post was not found (on-missing = stop). ' + runtime.successes + ' updated, ' + runtime.failures.length + ' failed.');
    setStatus('Stopped: post not found — ' + runtime.successes + ' updated, ' + runtime.failures.length + ' failed.', 'error');
    notifyBatchDone('Batch stopped — post not found', runtime.successes + ' updated, ' + runtime.failures.length + ' failed.');
  } else if (runtime.failures.length > 0) {
    log('err', 'Batch finished with errors: ' + runtime.successes + ' updated, ' + runtime.failures.length + ' failed.');
    setStatus('Finished with errors — ' + runtime.successes + ' updated, ' + runtime.failures.length + ' failed.', 'error');
    notifyBatchDone('Batch finished with errors', runtime.successes + ' updated, ' + runtime.failures.length + ' failed. Open the panel to review.');
  } else {
    log('ok', '✅ Batch finished: ' + runtime.successes + ' posts updated.');
    setStatus('Done — ' + runtime.successes + ' posts updated.', 'success');
    notifyBatchDone('Batch finished ✓', runtime.successes + ' post' + (runtime.successes === 1 ? '' : 's') + ' updated successfully.');
  }
  runtime.running = false;
  runtime.paused = false;
  runtime.rescueTabId = null;
  stopKeepAlive();
  await persistRuntime();
  await closeWpBridgeTab();
  await closeWorkerWindow();
  await returnToPanel();
  } catch (fatalErr) {
    // A crash here previously left runtime.running stuck on true, blocking any
    // new batch until the browser restarted. Always release the batch state.
    const m = fatalErr?.message || String(fatalErr);
    log('err', 'Batch loop crashed: ' + m);
    setStatus('Batch error: ' + m, 'error');
    runtime.running = false;
    runtime.paused = false;
    runtime.rescueTabId = null;
    stopKeepAlive();
    try { await persistRuntime(); } catch (e) {}
    try { await closeWpBridgeTab(); } catch (e) {}
    try { await closeWorkerWindow(); } catch (e) {}
    // A fatal error during a cycle recovery must NOT auto-advance; pause the
    // plan with a visible error instead.
    if (runtime.job && runtime.job.fastCycleRecovery === true) {
      advanceCycleJob = null;
      try {
        const p = await loadFastCyclePlan();
        if (p && p.id === runtime.job.fastCycleId) { p.status = 'error'; p.lastError = m; await saveFastCyclePlan(p); }
      } catch (e) {}
    }
    notifyBatchDone('Batch error', m);
  } finally {
    processing = false;
  }

  // Chunked Fast Submit advancement — deliberately AFTER the finally released
  // the re-entrancy guard, so the next cycle's processLoop() is not blocked.
  if (advanceCycleJob) {
    try { await finishRecoveryBatch(advanceCycleJob); }
    catch (e) { log('err', 'Cycle advancement failed: ' + (e && e.message ? e.message : e)); }
  }
}

// Live progress for the panel's top summary bar. Derived from the run's
// attempt rows (the single source of truth) — deduped per post so a retry that
// later succeeds counts once, as its LATEST final state. A post is Done only
// when it reached a final state: Successful, Audit Issues, or Failed.
function computeRunProgress() {
  const total = runtime.job?.slugs?.length || 0;
  const latest = new Map();
  (runtime.attempts || []).forEach((a) => {
    if (a.result !== 'updated' && a.result !== 'failed') return;
    latest.set(String(a.rawInput || a.slug || ''), a);
  });
  let success = 0, audit = 0, failed = 0;
  latest.forEach((a) => {
    if (a.result === 'failed') failed++;
    else if (/AUDIT ISSUES/i.test(a.message || '')) audit++;
    else success++;
  });
  const done = success + audit + failed;
  return {
    total,
    phase: runtime.job ? (runtime.job.fastSubmit ? 'fast' : ((runtime.job.recoverMap || runtime.job.recoverFromUrl) ? 'recovery' : 'batch')) : '',
    submitted: runtime.successes || 0,
    success,
    audit,
    failed,
    done,
    left: Math.max(0, total - done)
  };
}

function rememberAttempt(rawInput, slug, result, message, links) {
  const proposedSessionUrl = links?.aiSessionUrl || '';
  const providerHomeUrl = links?.aiProviderUrl || links?.recoverProviderUrl || runtime.job?.recoverProviderUrl || runtime.job?.aiUrl || '';
  const durableSessionUrl = canonicalizeAISessionUrl(
    proposedSessionUrl,
    detectProviderKind(proposedSessionUrl || providerHomeUrl),
    providerHomeUrl
  );
  runtime.attempts.push({
    index: runtime.cursor,
    rawInput: String(rawInput || '').trim(),
    slug,
    result,
    message: message || '',
    postUrl: links?.postUrl || '',
    editorUrl: links?.editorUrl || '',
    aiProviderUrl: links?.aiProviderUrl || '',
    aiSessionUrl: durableSessionUrl,
    aiName: links?.aiName || runtime.job?.aiName || '',
    auditRetry: links?.auditRetry === true,
    // Safety Gate / Fact-Check details of this attempt (v3.46.0) — a small
    // summary only: runtime.attempts (up to 2,000 rows) goes to the panel
    // every second and is persisted often. The full detail is in the log.
    gate: attemptGateSummary(links?.gate),
    factCheck: attemptFactCheckSummary(links?.factCheck),
    time: new Date().toLocaleTimeString(),
    isoTime: new Date().toISOString()
  });
  runtime.attempts = runtime.attempts.slice(-MAX_ATTEMPTS);
}

function attemptGateSummary(g) {
  if (!g || typeof g !== 'object') return null;
  const clip = (list, n, max) => (Array.isArray(list) ? list : []).slice(0, n)
    .map((x) => String(x === undefined || x === null ? '' : x).slice(0, max));
  return {
    codes: clip(g.codes, 20, 60),
    messages: clip(g.messages, 5, 300),
    warnings: clip(g.warnings, 5, 200),
    removedLinks: Array.isArray(g.removedLinks) ? g.removedLinks.length : (Number(g.removedLinks) || 0)
  };
}

function attemptFactCheckSummary(f) {
  if (!f || typeof f !== 'object') return null;
  const issues = Array.isArray(f.issues) ? f.issues : [];
  const out = {
    verdict: String(f.verdict || '').slice(0, 20),
    issues: compactFactIssues(issues.slice(0, 5)),
    issueCount: issues.length,
    dropped: Array.isArray(f.dropped) ? f.dropped.length : (Number(f.dropped) || 0),
    aiSessionUrl: String(f.aiSessionUrl || ''),
    fixRound: f.fixRound === true
  };
  if (f.error) out.error = String(f.error).slice(0, 300);
  return out;
}

function buildAuditFixNote(issues) {
  return 'PRIORITY FIX: a previous update of this exact article was audited and these problems were found: ' +
    String(issues).slice(0, 900) +
    '. This time you MUST fix every one of these issues — restore any missing FAQ, Conclusion, sections or images from the source article — while still following all instructions below.';
}

// ── v3.46.0: automatic retries tell the AI WHY ─────────────────────────────
// When a post is blocked by the Safety Gate (SAFETY_GATE) or the fact check
// (FACT_CHECK) and the batch retries it by itself (inline retries, the
// end-of-batch retry pass, parallel retries, the fallback AI), the next
// attempt's prompt carries a PRIORITY FIX note built from the gate errors or
// the fact-check issues — through the same auditFixNote path as an audit-fix
// re-run (jobPrompt + PRIORITY FIX block). Every other failure gets no note.
// The note is REPLACED on each retry (never added up) and is at most
// RETRY_NOTE_MAX characters. Fast Submit phase 1 never uses it.
const RETRY_NOTE_MAX = 3000;
const RETRY_NOTES_MAX_POSTS = 500;
// Gate codes the editing AI cannot fix (the gate itself could not run).
const RETRY_NOTE_SKIP_CODES = ['GATE_NOT_LOADED', 'INTERNAL_ERROR', 'GATE_FAILED', 'CONFIG_MISSING', 'PARSE_MISSING_MARKER', 'PARSE_META_JSON'];
// What to do, in plain words, per Safety Gate code.
const GATE_RETRY_HINTS = {
  END_MARKER_MISSING: 'Your reply was cut off. Return the COMPLETE article in ONE code block and make <!-- APU-END --> its last line.',
  PARSE_EMPTY_HTML: 'Return the complete article HTML inside one code block.',
  IMG_COUNT: 'Keep every image of the original exactly as it is: the same <img> tags with the same src and attributes, in the same place. Never remove, add or move an image.',
  IMG_CHANGED: 'Keep every <img> tag of the original unchanged (same src, srcset, size and class, same section); only the alt text may be improved.',
  MEDIA_COUNT: 'Keep every video, iframe, embed, figure and media element of the original unchanged.',
  MEDIA_CHANGED: 'Keep every video, iframe, embed, figure and media element of the original unchanged.',
  MEDIA_BLOCK_CHANGED: 'Keep every image and video block (<!-- wp:image -->, <!-- wp:embed --> ...) of the original unchanged.',
  ELEMENT_COUNT: 'Keep every form, button and ad block of the original.',
  EMBED_URL_MISSING: 'Keep every embed / video link line of the original unchanged.',
  TABLE_LOSS: 'Keep every table and every table row of the original (you may reword cells, never drop rows).',
  LINK_MISSING: 'Keep every link of the original with exactly the same address (href).',
  LINK_ATTR_CHANGED: 'Keep the rel attributes (nofollow, sponsored, ugc) of every original link.',
  ID_MISSING: 'Keep every id attribute of the original (they are jump targets).',
  NEW_INTERNAL_LINK: 'Do not add new links to this website.',
  BAD_NEW_LINK: 'Do not add new links unless each one is a normal https link to a real page on another site.',
  SHORTCODE_MISSING: 'Keep every [shortcode] of the original exactly as it is.',
  SHORTCODE_ADDED: 'Do not add new [shortcodes].',
  PLUGIN_BLOCK_CHANGED: 'Keep every plugin block (<!-- wp:plugin/... -->) of the original byte for byte.',
  BLOCK_MARKUP_MISMATCH: 'Keep every block comment (<!-- wp:... -->) matching its HTML, as in the original.',
  BLOCK_UNBALANCED: 'Keep every block comment (<!-- wp:... --> and <!-- /wp:... -->) of the original, opened and closed.',
  BLOCK_COMMENTS_IN_CLASSIC: 'This is a classic post: do not add <!-- wp:... --> block comments.',
  MALFORMED_COMMENT: 'Close every HTML comment properly.',
  SPECIAL_COMMENT_MISSING: 'Keep <!--more--> and <!--nextpage--> where they are.',
  SCRIPT_CHANGED: 'Keep every <script> of the original unchanged.',
  JSONLD_INVALID: 'Any JSON-LD schema must be valid JSON.',
  JSONLD_TYPE: 'Keep the JSON-LD schema type of the original.',
  FORBIDDEN_TAG: 'Do not add <h1>, <style>, <script>, form fields or similar tags.',
  FIRST_ELEMENT_NOT_P: 'Start the article with its intro paragraph (<p>), not with a heading.',
  TITLE_IN_BODY: 'Do not repeat the post title at the top of the article.',
  HEADING_ORDER: 'Keep a clean heading order: h2 for sections, h3 inside them, no jumps.',
  TAG_UNBALANCED: 'Close every tag you open.',
  STRAY_TEXT: 'The code block must hold ONLY the article HTML: no chat text before or after it.',
  MARKDOWN: 'Use HTML only: no Markdown (** or ##) and no citation marks.',
  CODE_FENCE: 'Do not put ``` code fences inside the article.',
  PLACEHOLDER: 'Do not leave placeholders ({{...}}, [VERIFY], TODO, example.com) in the article.',
  OMISSION_MARKER: 'Write out the whole article; never replace parts with notes such as "rest unchanged".',
  CONTENT_LOSS: 'Keep all the content of the original; edit sentences, do not delete paragraphs or sections.',
  CONTENT_RETENTION: 'Keep the original text and edit it lightly; do not rewrite or drop whole sections.',
  WORD_RATIO_EXTREME: 'Do not repeat or pad the article; keep it close to the original length.',
  DUPLICATE_CONTENT: 'Do not repeat any paragraph.',
  BOX_DUPLICATED: 'Do not add a second Quick Answer, Key Takeaways or At a Glance box.',
  SECTION_DUPLICATED: 'Do not add a second FAQ, Sources list or Last checked line.',
  NEW_FAQ_NOT_ALLOWED: 'Do not add a new FAQ section.',
  LAST_CHECKED_NOT_ALLOWED: 'Do not add a "Last checked" line.',
  LAST_CHECKED_WITHOUT_RESEARCH: 'Do not add a "Last checked" / "updated" / "verified" line or today\'s date.',
  NEW_NUMBER_WITHOUT_RESEARCH: 'Do not add or change prices, percentages or years.',
  NUMBER_MISSING: 'Keep every price, percentage and year of the original.'
};

function gateRetryHint(code) {
  return GATE_RETRY_HINTS[code] || 'Fix this problem.';
}

// err = the failure of the previous attempt. Returns the PRIORITY FIX note
// ('' when the failure is not a Safety Gate / fact-check block, or when
// nothing in it can be fixed by the editing AI).
function buildGateRetryNote(err) {
  if (!err || typeof err !== 'object') return '';
  const clip = (v, max) => safetyMessageText(v).replace(/[.\s]+$/, '').slice(0, max);
  let head = '';
  let foot = '';
  const lines = [];
  if (err.code === 'SAFETY_GATE') {
    const byCode = [];
    const seen = {};
    (Array.isArray(err.gateReasons) ? err.gateReasons : []).forEach((r) => {
      const code = String((r && r.code) || '').trim();
      if (!code || RETRY_NOTE_SKIP_CODES.indexOf(code) >= 0) return;
      if (!seen[code]) { seen[code] = { code, messages: [] }; byCode.push(seen[code]); }
      const m = clip(r.message, 220);
      if (m && seen[code].messages.length < 3 && seen[code].messages.indexOf(m) < 0) seen[code].messages.push(m);
    });
    byCode.forEach((g, n) => {
      lines.push((n + 1) + '. ' + g.code + (g.messages.length ? ' — ' + g.messages.join('; ') : '') + '. ' + gateRetryHint(g.code));
    });
    head = 'Your previous edit of this exact article was REJECTED by the automatic Safety Gate, so nothing was saved. It was rejected because:';
    foot = 'Edit the ORIGINAL article again from the start and make sure none of these problems happens this time, while still following all other instructions exactly.';
  } else if (err.code === 'FACT_CHECK') {
    (Array.isArray(err.factIssues) ? err.factIssues : []).slice(0, 8).forEach((i, n) => {
      const it = (i && typeof i === 'object') ? i : { problem: i };
      lines.push((n + 1) + '. [' + (clip(it.severity, 10) || 'high').toUpperCase() + (it.category ? ' / ' + clip(it.category, 40) : '') + '] ' +
        'Problem: ' + (clip(it.problem, 300) || 'not described') + '.' +
        (it.fix ? ' Fix: ' + clip(it.fix, 300) + '.' : '') +
        (it.quote ? ' Text in your previous edit: "' + clip(it.quote, 200) + '".' : ''));
    });
    head = 'Your previous edit of this exact article was REJECTED by an AI fact check, so nothing was saved. The fact check found these problems:';
    foot = 'Edit the ORIGINAL article again from the start, fix every one of these problems (when unsure, keep the original wording), and keep following all other instructions exactly.';
  } else {
    return '';
  }
  if (!lines.length) return '';
  // Whole lines only, within RETRY_NOTE_MAX.
  let body = '';
  const room = RETRY_NOTE_MAX - head.length - foot.length - 2;
  for (const line of lines) {
    if ((body + '\n' + line).length > room) break;
    body += '\n' + line;
  }
  if (!body) body = '\n' + lines[0].slice(0, Math.max(0, room - 1));
  return (head + body + '\n' + foot).slice(0, RETRY_NOTE_MAX);
}

// Short label for the log line ("Safety Gate: IMG_COUNT, LINK_MISSING" / "fact check: 2 issue(s)").
function retryNoteLabel(err) {
  if (err && err.code === 'SAFETY_GATE') {
    const codes = [];
    (Array.isArray(err.gateReasons) ? err.gateReasons : []).forEach((r) => {
      const c = String((r && r.code) || '');
      if (c && codes.indexOf(c) < 0 && RETRY_NOTE_SKIP_CODES.indexOf(c) < 0) codes.push(c);
    });
    return 'Safety Gate: ' + codes.slice(0, 6).join(', ');
  }
  if (err && err.code === 'FACT_CHECK') return 'fact check: ' + (Array.isArray(err.factIssues) ? err.factIssues.length : 0) + ' issue(s)';
  return '';
}

// Sets this attempt's PRIORITY FIX note for the NEXT try from the previous
// failure `err`: baseNote (an audit-fix note from the job, if any) + the
// gate / fact-check reasons. The previous retry's note is always replaced.
// A recovery read (recoverFromUrl) sends no prompt, so it gets no note.
function applyRetryFixNote(attemptLinks, baseNote, err, tag) {
  if (!attemptLinks) return '';
  const note = attemptLinks.recoverFromUrl ? '' : buildGateRetryNote(err);
  setRetryFixNote(attemptLinks, baseNote, note);
  if (note) log('info', (tag ? tag + ' ' : '') + '↻ The retry tells the AI why the previous edit was rejected (' + retryNoteLabel(err) + ') — PRIORITY FIX note attached.');
  return note;
}

function setRetryFixNote(attemptLinks, baseNote, note) {
  const full = [String(baseNote || ''), String(note || '')].filter(Boolean).join('\n\n');
  if (full) attemptLinks.auditFixNote = full;
  else delete attemptLinks.auditFixNote;
}

// End-of-batch retry pass: the note is kept per post (runtime.retryNotes,
// persisted) from the main pass to the retry pass.
function rememberRetryNote(rawSlug, err, attemptLinks) {
  if (!runtime.retryNotes || typeof runtime.retryNotes !== 'object' || Array.isArray(runtime.retryNotes)) runtime.retryNotes = {};
  const note = (attemptLinks && attemptLinks.recoverFromUrl) ? '' : buildGateRetryNote(err);
  delete runtime.retryNotes[rawSlug];
  if (!note) return;
  runtime.retryNotes[rawSlug] = { note, label: retryNoteLabel(err) };
  // Bounded (runtime is persisted after every post): the oldest notes go first.
  const keys = Object.keys(runtime.retryNotes);
  for (let i = 0; i < keys.length - RETRY_NOTES_MAX_POSTS; i++) delete runtime.retryNotes[keys[i]];
}

function applyCarriedRetryNote(rawSlug, attemptLinks, baseNote, tag) {
  const entry = runtime.retryNotes && runtime.retryNotes[rawSlug];
  const note = (entry && typeof entry === 'object') ? String(entry.note || '').slice(0, RETRY_NOTE_MAX) : '';
  if (!note || attemptLinks.recoverFromUrl) return '';
  setRetryFixNote(attemptLinks, baseNote, note);
  log('info', (tag ? tag + ' ' : '') + '↻ The retry tells the AI why the previous edit was rejected (' + (entry.label || 'Safety Gate') + ') — PRIORITY FIX note attached.');
  return note;
}

// ══════════════════════════════════════════════════════════════════════
// BULK PARALLEL RUN — processes up to 5 posts AT THE SAME TIME.
// Each slot runs the same self-contained processSlug pipeline with its own
// tabs and links; every save still passes the full verify + completeness
// gates. runtime.parallelDone records finished posts so a service-worker
// restart resumes without re-processing (and without double-updating) any.
// Returns true when the batch stopped because a post was missing and
// on-missing = stop.
// ══════════════════════════════════════════════════════════════════════
async function runParallelBatch() {
  const job = runtime.job;
  const N = Math.max(2, Math.min(5, Number(job.parallel) || 2));
  let missingStop = false;

  const runPass = async (passLabel) => {
    if (!Array.isArray(runtime.parallelDone)) runtime.parallelDone = [];
    const doneSet = new Set(runtime.parallelDone);
    const queue = job.slugs.map((raw, i) => ({ raw, i })).filter(e => !doneSet.has(e.raw));
    const total = job.slugs.length;
    let completed = total - queue.length;
    runtime.cursor = completed;
    let nextIdx = 0;
    const activeNow = new Set();

    const refreshStatus = () => {
      const names = [...activeNow].join(', ');
      setStatus('⚡ ' + passLabel + activeNow.size + ' post(s) running in parallel — ' + completed + '/' + total + ' done' + (names ? ' — now: ' + names : ''));
    };

    const runOne = async (entry) => {
      const rawSlug = entry.raw;
      const slug = cleanSlug(rawSlug);
      const num = entry.i + 1;
      const slugStartedAt = Date.now();
      activeNow.add(slug);
      refreshStatus();
      log('step', '──── ⚡ [' + num + '/' + total + '] ' + slug + ' (parallel) ────');

      const attemptLinks = { rawInput: rawSlug };
      if (job.recoverFromUrl) {
        attemptLinks.recoverFromUrl = job.recoverFromUrl;
        attemptLinks.recoverProviderUrl = job.recoverProviderUrl || '';
      } else if (job.recoverMap && job.recoverMap[rawSlug]) {
        attemptLinks.recoverFromUrl = job.recoverMap[rawSlug];
        attemptLinks.recoverProviderUrl = job.recoverProviderMap?.[rawSlug] || job.recoverProviderUrl || '';
      }
      if (job.issueMap && job.issueMap[rawSlug]) {
        attemptLinks.auditFixNote = buildAuditFixNote(job.issueMap[rawSlug]);
        log('info', '[' + num + '/' + total + '] Audit-fix mode: sending this post with its previous audit issues attached to the prompt.');
      }
      // v3.46.0: retries carry the previous attempt's gate / fact-check reasons.
      const baseFixNote = attemptLinks.auditFixNote || '';
      if (runtime.retryPass === 1) applyCarriedRetryNote(rawSlug, attemptLinks, baseFixNote, '[' + num + '/' + total + ']');
      const attemptTabs = { edit: null, ai: null };
      const inlineRetries = (job.retryMode || 'end') === 'inline'
        ? job.maxRetries
        : (runtime.retryPass === 1 ? job.maxRetries : 0);
      let lastErr = null;
      let success = false;
      for (let tryNum = 0; tryNum <= inlineRetries; tryNum++) {
        if (runtime.stopRequested || missingStop) break;
        if (tryNum > 0) {
          log('warn', '↻ Retry ' + tryNum + '/' + inlineRetries + ' for "' + slug + '" (previous: ' + (lastErr?.message || 'unknown') + ')');
          applyRetryFixNote(attemptLinks, baseFixNote, lastErr, '[' + num + '/' + total + ']');
          if (attemptTabs.ai)   { await safeCloseTab(attemptTabs.ai);   attemptTabs.ai = null; }
          if (attemptTabs.edit) { await safeCloseTab(attemptTabs.edit); attemptTabs.edit = null; }
          await sleep(3000);
        }
        try {
          await processSlug(slug, num, total, attemptLinks, tryNum, attemptTabs);
          success = true;
          break;
        } catch (e) {
          lastErr = e;
          if (e.code === 'POST_NOT_FOUND' || e.code === 'USER_STOPPED') break;
          // v3.46.0: a usage / model limit is not retried (every retry would
          // hit the same wall) — the batch pauses below, as in processLoop.
          if (e.code === 'AI_LIMIT' || e.code === 'MODEL_LIMIT') break;
        }
      }

      let recovered = false;
      if (!success && !runtime.stopRequested && !missingStop && htmlRecoveryFailedOn() &&
          attemptLinks.aiSessionUrl && !isApiAIJob() &&
          lastErr?.code !== 'POST_NOT_FOUND' && lastErr?.code !== 'USER_STOPPED' &&
          !isSafetyBlockCode(lastErr?.code)) {
        recovered = await tryHtmlRecovery(rawSlug, slug, num, total, attemptLinks.aiSessionUrl, attemptLinks.aiProviderUrl);
      }

      if (success) {
        runtime.successes++;
        noteRunSuccess();
        runtime.failures = runtime.failures.filter(f => f.slug !== slug);
        rememberAttempt(rawSlug, slug, 'updated', attemptLinks.auditReport ? ('Updated on WordPress — ' + attemptLinks.auditReport) : 'Updated on WordPress', attemptLinks);
        log('ok', '✓ [' + num + '/' + total + '] ' + slug);
        setRetryFixNote(attemptLinks, baseFixNote, '');
        await maybeAuditRetry(rawSlug, slug, num, total, attemptLinks, attemptTabs);
      } else if (recovered) {
        runtime.successes++;
        noteRunSuccess();
        runtime.failures = runtime.failures.filter(f => f.slug !== slug);
        log('ok', '✓ [' + num + '/' + total + '] ' + slug + ' (recovered from the saved AI session)');
      } else {
        const errMsg = lastErr?.message || 'Unknown error';
        log('err', '✗ [' + num + '/' + total + '] ' + slug + ': ' + errMsg);
        runtime.failures.push({
          slug,
          time: new Date().toLocaleTimeString(),
          message: errMsg,
          note: lastErr?.keepTabs ? 'Tabs were closed automatically — open the AI session link in Processed Links to review.' : ''
        });
        runtime.failures = runtime.failures.slice(-50);
        rememberAttempt(rawSlug, slug, 'failed', errMsg, attemptLinks);
        if ((job.retryMode || 'end') === 'end' && runtime.retryPass === 0 && lastErr?.code !== 'POST_NOT_FOUND' && lastErr?.code !== 'USER_STOPPED') {
          runtime.retryQueue.push(rawSlug);
          rememberRetryNote(rawSlug, lastErr, attemptLinks);
          log('info', '[' + num + '/' + total + '] Queued "' + slug + '" for the end-of-batch retry pass.');
        }
        if (lastErr?.code === 'POST_NOT_FOUND' && job.onMissing === 'stop') missingStop = true;
        // v3.46.0: an AI usage / model limit (the edit AI's or the fact-check
        // AI's) PAUSES the whole parallel batch, as processLoop does, instead
        // of failing every remaining post against the same wall. The other
        // slots hold at their next pause check; Resume (or the model-limit
        // timer) continues. This post stays failed / queued for the retry pass.
        if (!runtime.stopRequested && !runtime.paused) {
          if (lastErr?.code === 'MODEL_LIMIT') {
            await pauseForModelLimit(lastErr.aiName || job.aiName, lastErr.message, lastErr.limitDetection);
          } else if (lastErr?.code === 'AI_LIMIT' && limitGuardOn()) {
            runtime.paused = true;
            runtime.autoPauseReason = '⛔ Paused — AI usage limit reached (' +
              String(lastErr.limitText || 'the provider is refusing new messages').slice(0, 140) +
              '). Wait for the limit to reset or switch AI, then press Resume.';
            log('warn', '⛔ ' + runtime.autoPauseReason);
            notifyBatchDone('Paused — AI usage limit', 'The AI reported a usage/weekly limit. The batch is paused; resume after the limit resets or switch to another AI.');
          }
        }
      }

      if (attemptTabs.ai)   { await safeCloseTab(attemptTabs.ai);   attemptTabs.ai = null; }
      if (attemptTabs.edit) { await safeCloseTab(attemptTabs.edit); attemptTabs.edit = null; }
      runtime.slugDurations.push(Date.now() - slugStartedAt);
      if (runtime.slugDurations.length > 100) runtime.slugDurations.shift();
      completed++;
      runtime.cursor = completed;
      runtime.parallelDone.push(rawSlug);
      activeNow.delete(slug);
      refreshStatus();
      await persistRuntime();
    };

    const slot = async (slotNo) => {
      // Stagger slot startups so several AI tabs never open in the same second
      // (avoids provider bot-detection and tab-creation races).
      await sleep(slotNo * 5000);
      while (!runtime.stopRequested && !missingStop) {
        while (runtime.paused && !runtime.stopRequested) {
          setStatus(runtime.autoPauseReason || 'Paused.', runtime.autoPauseReason ? 'error' : '');
          await swPing();
          await sleep(2000);
        }
        if (runtime.stopRequested || missingStop) return;
        const idx = nextIdx++;
        if (idx >= queue.length) return;
        try { await runOne(queue[idx]); }
        catch (e) { log('err', 'Parallel slot ' + (slotNo + 1) + ' error: ' + (e?.message || e)); }
        if (job.delayBetween > 0 && nextIdx < queue.length && !runtime.stopRequested) {
          await sleep(job.delayBetween * 1000);
        }
      }
    };

    const slots = Math.max(1, Math.min(N, queue.length));
    if (queue.length) {
      log('step', '⚡ ' + (passLabel || '') + 'running ' + queue.length + ' post(s) with ' + slots + ' parallel slot(s).');
      await Promise.all(Array.from({ length: slots }, (_, sx) => slot(sx)));
    }
  };

  // ── Main pass (or a resumed retry pass after a service-worker restart) ──
  await runPass(runtime.retryPass === 1 ? 'retry pass — ' : '');

  // ── End-of-batch retry pass, also parallel ──
  if (!runtime.stopRequested && !missingStop && (job.retryMode || 'end') === 'end' && runtime.retryPass === 0) {
    const q = [...new Set(runtime.retryQueue || [])];
    runtime.retryQueue = [];
    if (q.length) {
      runtime.retryPass = 1;
      job.slugs = q;
      runtime.cursor = 0;
      runtime.parallelDone = [];
      log('step', '↻ All posts processed — now retrying ' + q.length + ' failed post(s) in parallel.');
      setStatus('Retry pass — ' + q.length + ' failed post(s)');
      await persistRuntime();
      await sleep(2000);
      await runPass('retry pass — ');
    }
  }
  return missingStop;
}

// ══════════════════════════════════════════════════════════════════════
// 🚀 FAST SUBMIT + ⏰ TIMED RECOVERY
// Phase 1 (runFastSubmitPass): for every post — look it up, grab the
// original HTML, open the AI, paste + send the prompt, save the chat URL,
// close the tab. NO waiting for the reply (providers keep generating
// server-side after the tab closes).
// Phase 2 (startFastRecovery): at the scheduled time (chrome.alarms) or on
// demand, reopen each saved chat ONE BY ONE through the existing recovery
// pipeline (recoverMap), read the finished code box, and update the post.
// ══════════════════════════════════════════════════════════════════════
async function saveFastQueue(entries, job, when) {
  const cfg = Object.assign({}, job);
  delete cfg.slugs; delete cfg.fastSubmit; delete cfg.recoverAfterMin;
  delete cfg.recoverMap; delete cfg.recoverFromUrl;
  delete cfg.recoverProviderMap; delete cfg.recoverProviderUrl; delete cfg.issueMap; delete cfg.freshFromBackup; delete cfg.recoverSections;
  cfg.parallel = 1;
  const data = await chrome.storage.local.get('__fastQueue');
  const prev = data.__fastQueue || {};
  await chrome.storage.local.set({ __fastQueue: {
    // Cap generously: one Fast Submit cycle can hold up to the max chunk size
    // (2000). A smaller cap would silently drop earlier chats from recovery.
    entries: entries.slice(-2000),
    config: cfg,
    createdAt: prev.createdAt || Date.now(),
    recoverAt: (when !== undefined) ? when : (prev.recoverAt || 0)
  } });
}

async function fastSubmitSlug(rawSlug, slug, num, total, usedSessionUrls, geminiPool) {
  const site = runtime.job.site;
  const siteUrl = site.url.replace(/\/+$/, '');
  const tag = '[' + num + '/' + total + ']';
  const useDirectRest = siteUsesDirectRest(site);

  // 1) Find the post and get its original HTML
  setStatus(tag + ' Looking up "' + slug + '" on ' + site.name);
  let wpItem = null;
  try {
    wpItem = await findWordPressItem(site, siteUrl, slug, useDirectRest);
  } catch (e) {
    const blocked = /REST API (401|403|429|503)|could not reach the REST API/i.test(e?.message || '');
    if (!useDirectRest && blocked) wpItem = await findWordPressItemViaAdmin(siteUrl, slug, tag);
    else throw new Error('REST API error: ' + e.message);
  }
  if (!wpItem || !wpItem.id) {
    const err = new Error('Post not found for slug "' + slug + '"');
    err.code = 'POST_NOT_FOUND';
    throw err;
  }
  let originalHtml = String(wpItem.contentRaw || '').trim();
  if (!originalHtml || originalHtml.length < 30) {
    // Editor-mode site (or REST returned no raw content): grab it from the
    // editor code box, then close that tab right away.
    const editUrl = siteUrl + '/wp-admin/post.php?post=' + wpItem.id + '&action=edit&classic-editor';
    const editTab = await createWorkTab(editUrl);
    try {
      await waitForTabLoad(editTab.id, 45000);
      await sleep(2500);
      await runInTab(editTab.id, switchToCodeMode);
      await sleep(1500);
      const g = await runInTab(editTab.id, grabHtmlFromEditor);
      originalHtml = (g?.result?.html || '').trim();
    } finally {
      try { await safeCloseTab(editTab.id); } catch (e) {}
    }
    if (!originalHtml || originalHtml.length < 30) throw new Error('No HTML found in the editor for "' + slug + '".');
  }
  log('ok', tag + ' Got original HTML: ' + originalHtml.length + ' chars');
  await saveOriginalBackup(slug, wpItem.title, wpItem.link, originalHtml, '');

  // 2) Open the AI, paste, SEND — and do not wait for the reply.
  const payload = buildAIPayload(runtime.job.prompt, originalHtml, { postTitle: plainPostTitle(wpItem.title) });
  setStatus(tag + ' 🚀 Submitting to ' + runtime.job.aiName + ' (no waiting)');
  log('step', tag + ' Opening ' + runtime.job.aiName + ' — paste, send, close.');
  await ensureWorkerWindowUsable();
  const aiTab = await createWorkTab(runtime.job.aiUrl);
  let sessionUrl = '';
  let keepAiTabOpen = false;
  try {
    const providerKind = detectProviderKind(runtime.job.aiUrl);
    // Before the readiness wait, never after it: the page has to survive being
    // hidden while it is still booting, which is exactly when it is fragile.
    await installAITabKeepAlive(aiTab.id);
    await reviveHiddenWindowFor(aiTab.id, 'opening the AI tab');
    const ready = await waitForAIComposerReady(aiTab.id, providerKind === 'claude' ? 150000 : 90000, providerKind);
    if (!ready.ok) {
      // A limited provider disables its composer — check before blaming the page.
      const limitErr = await limitErrorIfLimited(aiTab.id, providerKind, tag, 'the chat box never became usable');
      if (limitErr) throw limitErr;
      throw new Error(runtime.job.aiName + ' is not ready: ' + ready.error);
    }
    await prepareProviderForEditing(aiTab.id, providerKind, !!runtime.job.promptWebSearch);
    // MODEL LIMIT — checked BEFORE the paste, while the composer is still
    // empty, so the pasted article can never be mistaken for a limit notice.
    // A confirmed limit stops the whole run: nothing may be edited by a
    // capped or silently downgraded model.
    {
      const limited = await checkAIModelLimit(aiTab.id, providerKind, tag);
      if (limited) throw modelLimitError(limited, runtime.job.aiName);
    }
    if (providerKind === 'gemini') {
      // Must be in place BEFORE send: the server-assigned conversation id
      // rides in on the very first streaming response chunk.
      try { await runInTabMain(aiTab.id, installGeminiConversationSniffer); }
      catch (e) { log('warn', tag + ' Could not install the Gemini network sniffer: ' + (e?.message || e)); }
      try {
        if ((await runInTab(aiTab.id, detectGeminiActivityOff))?.result === true) {
          log('warn', tag + ' ⚠ Gemini appears to have "Gemini Apps Activity" OFF — chats are not saved, so every Fast Submit link would die. Turn it on at myactivity.google.com/product/gemini.');
        }
      } catch (e) {}
      // GEMINI MODEL LIMIT — when Google runs the account out of quota it
      // hides the Flash model and leaves only Flash-Lite. Editing must never
      // continue on Flash-Lite, so this stops the whole run.
      {
        const flashLimited = await checkGeminiFlashLimit(aiTab.id, tag);
        if (flashLimited) throw modelLimitError({ kind: 'gemini-flash', evidence: flashLimited.reason + (flashLimited.offered ? ' (offered: ' + flashLimited.offered + ')' : '') }, runtime.job.aiName);
      }
      // STRICT: never paste into Gemini unless the model pill reads
      // "Flash Extended". On failure the prompt is NOT sent, this post fails,
      // and the batch moves on — the tab closes so failures cannot pile up
      // open windows. Three failures in a row still auto-pause (systemic).
      try {
        await enforceGeminiFlashThinking(aiTab.id, tag);
      } catch (e) {
        e.links = {
          postUrl: wpItem.link || '',
          editorUrl: siteUrl + '/wp-admin/post.php?post=' + wpItem.id + '&action=edit',
          aiProviderUrl: runtime.job.aiUrl || '',
          aiSessionUrl: '',
          aiName: runtime.job.aiName || ''
        };
        throw e;
      }
    }
    await sleep(1500);
    // Establish the actual composer URL immediately before sending. A custom
    // launch URL might already be an old /c/... chat or redirect to a landing
    // shell; neither may be reused as this post's new conversation.
    const preSendUrl = await getSettledAIPageUrl(aiTab.id, runtime.job.aiUrl);
    const sendResult = await sendPromptToAI(aiTab.id, payload, providerKind, {
      extraPasteWaitMs: fastPasteWaitMs(),
      maxAttempts: fastPasteRetriesOf(),
      tag
    });
    if (sendResult.stopped) {
      // Stopped mid-countdown: nothing was sent, so this post must stay
      // unfinished (not "submitted", not "failed") and keep its place.
      const stopped = new Error('Stopped by user before the prompt was sent.');
      stopped.code = 'USER_STOPPED';
      throw stopped;
    }
    if (!sendResult.ok) {
      // The sender already saw the limit — pause now, no further attempts.
      if (sendResult.limited) throw modelLimitError(sendResult.limitDetection, runtime.job.aiName);
      const limitErr = await limitErrorIfLimited(aiTab.id, providerKind, tag, 'the prompt could not be sent');
      if (limitErr) throw limitErr;
      throw new Error(runtime.job.aiName + ' prompt was not sent: ' + sendResult.error);
    }
    log('ok', tag + ' Prompt submitted (' + sendResult.method + ') — NOT waiting for the reply.');
    // Usage-limit guard: a limit banner appears right after sending. Catch it so
    // Fast Submit pauses instead of firing every remaining prompt at the wall.
    if (limitGuardOn()) {
      await sleep(1200);
      try {
        const chk = await runInTab(aiTab.id, readAICodeSnapshot, [providerKind]);
        const lim = chk?.result?.usageLimit;
        if (lim) {
          const e = new Error('AI usage limit reached — ' + String(lim).slice(0, 120));
          e.code = 'AI_LIMIT';
          e.limitText = String(lim).slice(0, 200);
          // Reuse the model-limit machinery so a stated reset time resumes the
          // run by itself, with the same alert.
          const det = await checkAIModelLimit(aiTab.id, providerKind, tag);
          if (det) throw modelLimitError(det, runtime.job.aiName);
          throw e;
        }
      } catch (e) { if (e.code === 'AI_LIMIT') throw e; }
    }
    // The cap / "responses will use … mini" banner usually appears in the
    // moment AFTER sending, so check once more here — including the "Model"
    // placeholder, which reads the picker button only and never the
    // transcript. Stops the run before any further post is submitted.
    {
      const limited = await checkAIModelLimit(aiTab.id, providerKind, tag);
      if (limited) throw modelLimitError(limited, runtime.job.aiName);
    }
    // 3) Capture a REAL conversation URL. A provider root, login redirect, model
    //    query, or Temporary Chat URL is not recoverable and must never enter
    //    the fast queue as a successful submission.
    setStatus(tag + ' Saving the chat link...');
    const excludedUrls = [preSendUrl, ...(Array.isArray(usedSessionUrls) ? usedSessionUrls : [])];
    // Gemini only assigns its conversation route once the reply starts
    // streaming — with article-sized prompts that can take far longer than the
    // 60s that is plenty for ChatGPT's immediate /c/<uuid> route.
    sessionUrl = await waitForAISessionUrl(
      aiTab.id,
      providerKind,
      runtime.job.aiUrl,
      providerKind === 'gemini' ? 150000 : 60000,
      excludedUrls
    );
    if (runtime.stopRequested) {
      const stopped = new Error('Stopped by user');
      stopped.code = 'USER_STOPPED';
      throw stopped;
    }
    if (!sessionUrl) {
      // This post fails and the batch continues — one bad post must never
      // freeze the queue. Three consecutive failures still auto-pause, which
      // catches the systemic cases (provider UI change, history-off mode).
      const fixHint = providerKind === 'gemini'
        ? 'For Gemini: make sure you are logged in to the right Google account and "Gemini Apps Activity" is ON (myactivity.google.com/product/gemini) — with it off, Gemini never creates a reopenable chat link. The link also only appears once the reply starts, so very large articles need patience. Use "Retry new" for this post.'
        : 'Turn off Temporary Chat/history-off mode, then use "Retry new" for this post.';
      const captureErr = new Error(
        'Prompt was sent, but no durable ' + runtime.job.aiName +
        ' conversation link appeared within ' + (providerKind === 'gemini' ? '150s' : '60s') +
        '. The provider home page was NOT saved. ' + fixHint
      );
      captureErr.code = 'AI_SESSION_URL_NOT_CAPTURED';
      captureErr.links = {
        postUrl: wpItem.link || '',
        editorUrl: siteUrl + '/wp-admin/post.php?post=' + wpItem.id + '&action=edit',
        aiProviderUrl: runtime.job.aiUrl || '',
        aiSessionUrl: '',
        aiName: runtime.job.aiName || ''
      };
      throw captureErr;
    }
    if (providerKind === 'gemini') {
      // Gemini's route can be re-keyed when the server commits the chat, and
      // the chat only becomes reopenable once the reply has started. Confirm
      // both, replacing the link if the conversation id settled elsewhere.
      sessionUrl = await confirmGeminiSessionUrl(aiTab.id, sessionUrl, runtime.job.aiUrl, excludedUrls, tag);
      // CRITICAL Gemini difference vs ChatGPT: Gemini streams the reply over a
      // connection owned by THIS tab. Closing the tab mid-reply aborts the
      // stream, and Google DISCARDS a conversation whose first reply never
      // finished — that is how "saved" links die. So the tab is NOT closed
      // here: it goes into the finishing pool (geminiPoolSweep) and closes
      // only after the reply completes and the link survives a cold reload.
      keepAiTabOpen = true;
    }
    log('ok', tag + ' Saved durable AI conversation link: ' + sessionUrl);
    await sleep(1500);   // small grace so the send fully registers server-side
  } finally {
    if (!keepAiTabOpen) {
      try { await safeCloseTab(aiTab.id); } catch (e) {}
    }
  }
  const entry = {
    rawSlug: String(rawSlug || ''),
    slug,
    sessionUrl: sessionUrl || '',
    postUrl: wpItem.link || '',
    title: wpItem.title || '',
    time: new Date().toLocaleTimeString(),
    iso: new Date().toISOString(),
    status: 'submitted'
  };
  if (detectProviderKind(runtime.job.aiUrl) === 'gemini' && Array.isArray(geminiPool)) {
    geminiPool.push({
      tabId: aiTab.id,
      entry,
      tag,
      addedAt: Date.now(),
      streak: 0,
      holdCapMs: Math.max(120, Number(runtime.job.aiTimeout) || 180) * 1000 + 60000
    });
    log('info', tag + ' Holding the Gemini tab open until its reply finishes — Gemini discards chats that are cut off mid-reply.');
  }
  return entry;
}

async function runFastSubmitPass() {
  const job = runtime.job;
  const total = job.slugs.length;
  let entries = [];
  let missingStop = false;   // on-missing = stop fired → halt the plan after this cycle recovers
  // Gemini finishing pool: submit tabs stay open (max 3 at once) until their
  // replies complete, because Gemini discards chats cut off mid-reply.
  const isGeminiJob = detectProviderKind(job.aiUrl) === 'gemini';
  const geminiPool = [];
  runtime.geminiDeadLinks = 0;      // per-run systemic dead-link counter
  runtime.geminiVerifiedLinks = 0;  // proven-durable links → probe less often

  // Fresh start clears any stale queue; a service-worker-restart resume keeps
  // the entries already submitted (cursor > 0).
  if (runtime.cursor === 0) {
    const d = await chrome.storage.local.get('__fastQueue');
    const stale = (d.__fastQueue?.entries || []).filter(e => e.status === 'submitted').length;
    if (stale) log('warn', 'Replacing a previous fast-submit queue that still had ' + stale + ' unrecovered prompt(s).');
    try { await chrome.alarms.clear(FAST_RECOVER_ALARM); } catch (e) {}
    await chrome.storage.local.remove('__fastQueue');
  } else {
    try {
      const d = await chrome.storage.local.get('__fastQueue');
      if (Array.isArray(d.__fastQueue?.entries)) entries = d.__fastQueue.entries;
    } catch (e) {}
  }

  log('step', isGeminiJob
    ? '🚀 FAST SUBMIT (Gemini pipeline): sending ' + total + ' prompt(s) — each Gemini tab stays open until its reply finishes (max 3 at once), because Gemini discards chats cut off mid-reply.'
    : '🚀 FAST SUBMIT: sending ' + total + ' prompt(s) — paste, send, close. No waiting for the AI.');
  for (let i = runtime.cursor; i < total; i++) {
    if (isGeminiJob && geminiPool.length) {
      await geminiPoolSweep(geminiPool, job, {});
      await geminiPoolWaitForSlot(geminiPool, job, 3);
      await saveFastQueue(entries, job);   // sweep may have re-keyed or failed entries
      await persistRuntime();
    }
    while (runtime.paused && !runtime.stopRequested) {
      setStatus(runtime.autoPauseReason || 'Paused.', runtime.autoPauseReason ? 'error' : '');
      await swPing();
      await sleep(2000);
    }
    if (runtime.stopRequested) break;
    const rawSlug = job.slugs[i];
    const slug = cleanSlug(rawSlug);
    const num = i + 1;
    log('step', '──── 🚀 [' + num + '/' + total + '] ' + slug + ' ────');
    const t0 = Date.now();
    try {
      const entry = await fastSubmitSlug(rawSlug, slug, num, total, entries.map(e => e.sessionUrl).filter(Boolean), geminiPool);
      entries.push(entry);
      runtime.successes++;
      noteRunSuccess();
      log('ok', '✓ [' + num + '/' + total + '] ' + slug + ' submitted — chat link saved.');
    } catch (e) {
      const msg = e?.message || String(e);
      const failureLinks = (e?.links && typeof e.links === 'object') ? e.links : {};
      // A user Stop is not a failure: nothing was sent, so the post keeps its
      // unfinished state and stays in "Posts to update" for the next run.
      if (e?.code === 'USER_STOPPED') {
        log('warn', '⏹ [' + num + '/' + total + '] ' + slug + ' — stopped before sending; the post is unchanged and stays queued.');
        break;
      }
      // MODEL LIMIT — halt at once but keep the queue position. This post was
      // never sent, so it is neither submitted nor failed: the retry timer (or
      // Resume) picks it up again from here.
      if (e?.code === 'MODEL_LIMIT') {
        log('err', '🚫 [' + num + '/' + total + '] ' + slug + ' — ' + msg);
        runtime.cursor = i;                     // resume re-runs THIS post
        await pauseForModelLimit(job.aiName, msg, e.limitDetection);
        await saveFastQueue(entries, job);
        while (runtime.paused && !runtime.stopRequested) {
          setStatus(runtime.autoPauseReason, 'error');
          await swPing();
          await sleep(2000);
        }
        if (runtime.stopRequested) break;
        i--;                                    // retry the same post on resume
        continue;
      }
      log('err', '✗ [' + num + '/' + total + '] ' + slug + ': ' + msg);
      runtime.failures.push({
        slug,
        time: new Date().toLocaleTimeString(),
        message: 'Fast submit failed — ' + msg,
        note: e?.keepTabs ? 'The AI tab was kept open for manual review.' : ''
      });
      runtime.failures = runtime.failures.slice(-50);
      rememberAttempt(rawSlug, slug, 'failed', 'Fast submit failed — ' + msg, failureLinks);
      // One bad post must never freeze the rest of the queue: no per-error
      // pause here — the post is in Failed with its exact reason, and the loop
      // moves on. A RUN of consecutive failures is different: that pattern
      // means something systemic (login, provider UI change, model menu,
      // history/activity off), so continuing would burn every remaining post.
      runtime.consecFails = (runtime.consecFails || 0) + 1;
      if (shouldPauseForConsecutiveFailures() && !runtime.stopRequested &&
          e?.code !== 'AI_LIMIT' && e?.code !== 'POST_NOT_FOUND') {
        runtime.cursor = i + 1;
        await pauseForRepeatedFailures('Fast Submit', msg);
        await saveFastQueue(entries, job);
        while (runtime.paused && !runtime.stopRequested) {
          setStatus(runtime.autoPauseReason, 'error');
          await swPing();
          await sleep(2000);
        }
        if (runtime.stopRequested) break;
        continue;
      }
      // AI usage/weekly limit hit mid-submit: pause and stop firing the rest.
      if (e?.code === 'AI_LIMIT' && limitGuardOn() && !runtime.stopRequested) {
        runtime.paused = true;
        runtime.autoPauseReason = '⛔ Paused — AI usage limit reached (' +
          String(e.limitText || 'the provider is refusing new messages').slice(0, 140) +
          '). Wait for the limit to reset or switch AI, then press Resume.';
        log('warn', '⛔ ' + runtime.autoPauseReason);
        notifyBatchDone('Paused — AI usage limit', 'The AI reported a usage/weekly limit during Fast Submit. Paused; resume after the limit resets or switch to another AI.');
        runtime.cursor = i + 1;                 // this one was sent; don't resend on resume
        await saveFastQueue(entries, job);
        await persistRuntime();
        while (runtime.paused && !runtime.stopRequested) {
          setStatus(runtime.autoPauseReason, 'error');
          await swPing();
          await sleep(2000);
        }
        if (runtime.stopRequested) break;
        continue;                                // hold at the top-of-loop pause gate
      }
      if (e?.code === 'POST_NOT_FOUND' && job.onMissing === 'stop') {
        missingStop = true;   // recover what was submitted, then halt the plan
        runtime.cursor = i + 1;
        await saveFastQueue(entries, job);
        await persistRuntime();
        break;
      }
    }
    runtime.slugDurations.push(Date.now() - t0);
    if (runtime.slugDurations.length > 100) runtime.slugDurations.shift();
    runtime.cursor = i + 1;
    await saveFastQueue(entries, job);   // crash-safe: queue grows as we go
    await persistRuntime();
    if (i + 1 < total && job.delayBetween > 0) {
      for (let sLeft = job.delayBetween; sLeft > 0; sLeft--) {
        if (runtime.stopRequested) break;
        while (runtime.paused && !runtime.stopRequested) { await swPing(); await sleep(2000); }
        if (sLeft % 15 === 0) await swPing();
        setStatus('Waiting ' + sLeft + 's before the next submission...');
        await sleep(1000);
      }
    }
  }

  // Gemini pipeline: every prompt is sent, but tabs still generating must
  // finish (and their links must survive a cold reload) before this pass ends.
  if (geminiPool.length) {
    await geminiPoolDrain(geminiPool, job);
    await saveFastQueue(entries, job);
    await persistRuntime();
  }

  // The loop can be skipped after an MV3 restart when the last submitted item
  // already advanced cursor to `total`. Honor the persisted pause here too, so
  // processLoop cannot tear down the worker window (and rescue tab) underneath
  // the user before Resume/Stop.
  while (runtime.paused && !runtime.stopRequested) {
    setStatus(runtime.autoPauseReason || 'Paused.', runtime.autoPauseReason ? 'error' : '');
    await swPing();
    await sleep(2000);
  }

  // Schedule (or hand over) the recovery phase. The Gemini pool sweep can flip
  // entries to 'failed', so only still-submitted entries count as recoverable.
  const submittedCount = entries.filter(e => e.status === 'submitted').length;
  const mins = Math.max(0, Number(job.recoverAfterMin) || 0);
  let schedText = '';
  if (submittedCount && !runtime.stopRequested && mins > 0) {
    const when = Date.now() + mins * 60000;
    await saveFastQueue(entries, job, when);
    try { chrome.alarms.create(FAST_RECOVER_ALARM, { when }); } catch (e) {}
    const at = new Date(when).toLocaleTimeString();
    schedText = ' ⏰ Recovery starts automatically at ' + at + ' — keep Chrome open.';
    log('ok', '⏰ Recovery scheduled at ' + at + ' (' + mins + ' min) for ' + submittedCount + ' post(s).');
  } else if (submittedCount) {
    schedText = ' Press "⏰ Recover & Update Now" when the AI has had time to finish.';
  }

  // Chunked Fast Submit: fold this cycle's submission into the master plan and
  // mark it waiting for recovery. The plan (not this pass) owns the single final
  // "all done" notification, so intermediate cycles do not fire OS notifications.
  let cyclePlan = null;
  if (job.fastCycleId && !runtime.stopRequested) {
    cyclePlan = await loadFastCyclePlan();
    if (cyclePlan && cyclePlan.id === job.fastCycleId) {
      cyclePlan.submittedTotal = (Number(cyclePlan.submittedTotal) || 0) + submittedCount;
      cyclePlan.failedTotal = (Number(cyclePlan.failedTotal) || 0) + runtime.failures.length;
      if (submittedCount) {
        cyclePlan.status = 'waiting_recovery';
        cyclePlan.lastError = '';
      } else {
        // Nothing can enter phase 2. Leaving this as waiting_recovery would
        // strand the chunk forever with an empty queue.
        cyclePlan.status = 'error';
        cyclePlan.lastError = 'This Fast Submit cycle produced no recoverable AI conversation links. Review Failed posts and use Retry new.';
      }
      if (missingStop) cyclePlan.haltAfterCurrent = true;   // on-missing=stop → no further cycles
      await saveFastCyclePlan(cyclePlan);
    } else {
      cyclePlan = null;   // stale/missing plan → fall back to single-cycle messaging
    }
  }

  if (!runtime.stopRequested) {
    const fails = runtime.failures.length;
    if (cyclePlan) {
      const cyc = 'Cycle ' + (job.fastCycleChunkNumber || cyclePlan.currentChunkNumber) + '/' +
        (job.fastCycleTotalChunks || cyclePlan.totalChunks);
      const tail = submittedCount + ' prompt(s)' + (fails ? ', ' + fails + ' failed' : '') + '.' + schedText;
      log(fails ? 'err' : 'ok', '🚀 ' + cyc + ' submitted: ' + tail);
      setStatus('🚀 ' + cyc + ' submitted — ' + tail, fails ? 'error' : 'success');
      // No OS notification here — the plan notifies once after the final cycle.
    } else if (fails > 0) {
      log('err', 'Fast submit finished: ' + submittedCount + ' submitted, ' + fails + ' failed.');
      setStatus('🚀 Fast submit done — ' + submittedCount + ' submitted, ' + fails + ' failed.' + schedText, 'error');
      notifyBatchDone('Fast submit finished with errors', submittedCount + ' submitted, ' + fails + ' failed.' + schedText);
    } else {
      log('ok', '✅ Fast submit done: ' + submittedCount + ' prompt(s) submitted.');
      setStatus('🚀 Fast submit done — ' + submittedCount + ' prompt(s) submitted.' + schedText, 'success');
      notifyBatchDone('Fast submit finished ✓', submittedCount + ' prompts submitted.' + schedText);
    }
  }
}

async function materializeInvalidFastEntries(invalidEntries, queue) {
  const invalid = Array.isArray(invalidEntries) ? invalidEntries : [];
  if (!invalid.length) return 0;
  invalid.forEach((entry) => {
    const raw = entry.rawSlug || entry.slug || '';
    const clean = cleanSlug(raw);
    const message = 'Fast Submit could not recover this post because its saved AI URL was transient or non-canonical, not a verified conversation link. Use “Retry new”.';
    runtime.failures.push({ slug: clean, time: new Date().toLocaleTimeString(), message, note: '' });
    rememberAttempt(raw, clean, 'failed', message, {
      postUrl: entry.postUrl || '',
      aiProviderUrl: queue?.config?.aiUrl || '',
      aiSessionUrl: '',
      aiName: queue?.config?.aiName || ''
    });
  });
  runtime.failures = runtime.failures.slice(-50);
  runtime.attempts = runtime.attempts.slice(-MAX_ATTEMPTS);
  log('warn', 'Moved ' + invalid.length + ' Fast Submit item(s) with invalid or transient AI URLs to Failed posts.');
  if (!runtime.running) {
    setStatus('Fast recovery could not use ' + invalid.length + ' invalid or transient link(s). Use Retry new.', 'error');
  }
  await persistRuntime();
  return invalid.length;
}

// ══════════════════════════════════════════════════════════════════════
// FAST SUBMIT — "Start after N minutes"
// The whole job is parked in storage and a chrome.alarm starts it later, so
// the delay survives closing the panel, a service-worker restart, and a Chrome
// restart. 0 minutes means "go now" and never reaches here.
// ══════════════════════════════════════════════════════════════════════
async function schedulePendingFastSubmit(job, minutes) {
  const mins = Math.max(1, Math.min(500, Math.round(Number(minutes) || 0)));
  const when = Date.now() + mins * 60000;
  await chrome.storage.local.set({ __fastPendingStart: { job, when, minutes: mins } });
  try { chrome.alarms.create(FAST_START_ALARM, { when }); } catch (e) {}
  const at = new Date(when).toLocaleTimeString();
  log('ok', '⏳ Fast Submit scheduled: ' + (job?.slugs?.length || 0) + ' post(s) will start automatically at ' + at + ' (in ' + mins + ' min). Keep Chrome open.');
  setStatus('⏳ Fast Submit starts at ' + at + ' (in ' + mins + ' min) — nothing is running yet.', '');
  return { ok: true, when, minutes: mins };
}

async function cancelPendingFastSubmit(reason) {
  try { await chrome.alarms.clear(FAST_START_ALARM); } catch (e) {}
  const data = await chrome.storage.local.get('__fastPendingStart');
  const had = !!data.__fastPendingStart;
  if (had) {
    await chrome.storage.local.remove('__fastPendingStart');
    log('warn', '⏳ Scheduled Fast Submit cancelled' + (reason ? ' — ' + reason : '') + '. Nothing was sent.');
    if (!runtime.running) setStatus('Scheduled Fast Submit cancelled — nothing was sent.', '');
  }
  return had;
}

async function startPendingFastSubmit() {
  const data = await chrome.storage.local.get('__fastPendingStart');
  const pending = data.__fastPendingStart;
  if (!pending || !pending.job) return;
  // Something else is running: try again shortly rather than dropping the job.
  if (runtime.running || batchStarting || fastRecoveryStarting) {
    try { chrome.alarms.create(FAST_START_ALARM, { when: Date.now() + 120000 }); } catch (e) {}
    log('warn', '⏳ Scheduled Fast Submit postponed 2 minutes — another run is still active.');
    return;
  }
  await chrome.storage.local.remove('__fastPendingStart');
  log('step', '⏳ Scheduled time reached — starting Fast Submit for ' + (pending.job.slugs?.length || 0) + ' post(s).');
  try {
    await startBatch(pending.job);
    notifyBatchDone('🚀 Fast Submit started', 'The scheduled Fast Submit run has begun.');
  } catch (e) {
    log('err', 'Scheduled Fast Submit could not start: ' + (e?.message || e));
    setStatus('Scheduled Fast Submit could not start: ' + (e?.message || e), 'error');
  }
}

// Phase 2 — collect & update. source: 'alarm' | 'manual'.
async function startFastRecovery(source) {
  if (fastRecoveryStarting || batchStarting) {
    if (source === 'alarm') {
      try { chrome.alarms.create(FAST_RECOVER_ALARM, { when: Date.now() + 120000 }); } catch (e) {}
    }
    return { ok: false, error: 'A batch or Fast recovery is already starting.' };
  }
  fastRecoveryStarting = true;
  try {
  if (runtime.running) {
    if (source === 'alarm') {
      try { chrome.alarms.create(FAST_RECOVER_ALARM, { when: Date.now() + 120000 }); } catch (e) {}
      log('warn', '⏰ Scheduled recovery postponed 2 minutes — another batch is still running.');
    }
    return { ok: false, error: 'A batch is already running.' };
  }
  const data = await chrome.storage.local.get('__fastQueue');
  const q = data.__fastQueue;
  const submitted = (q?.entries || []).filter(e => e.status === 'submitted');
  const pend = [];
  const invalid = [];
  submitted.forEach((entry) => {
    const canonicalSessionUrl = canonicalizeAISessionUrl(
      entry.sessionUrl || '',
      detectProviderKind(entry.sessionUrl || q?.config?.aiUrl || ''),
      q?.config?.aiUrl || ''
    );
    if (canonicalSessionUrl) pend.push(Object.assign({}, entry, { sessionUrl: canonicalSessionUrl }));
    else invalid.push(entry);
  });
  const plan = await loadFastCyclePlan();
  const matchingPlan = plan && q?.config?.fastCycleId && plan.id === q.config.fastCycleId ? plan : null;
  if (!pend.length) {
    if (invalid.length) {
      const terminalMessage = invalid.length + ' queued prompt(s) had invalid or transient AI URLs. They were moved to Failed posts; use “Retry new”.';
      await materializeInvalidFastEntries(invalid, q);
      if (matchingPlan) {
        matchingPlan.failedTotal = (Number(matchingPlan.failedTotal) || 0) + invalid.length;
        matchingPlan.status = 'error';
        matchingPlan.lastError = terminalMessage;
        await saveFastCyclePlan(matchingPlan);
      }
      await chrome.storage.local.remove('__fastQueue');
      try { await chrome.alarms.clear(FAST_RECOVER_ALARM); } catch (e) {}
      return { ok: false, convertedInvalid: true, invalidCount: invalid.length, error: terminalMessage };
    }
    return { ok: false, error: 'No submitted prompts are waiting for recovery.' };
  }
  if (!q?.config?.site) {
    return { ok: false, error: 'The saved Fast Submit queue is missing its WordPress site configuration.' };
  }
  const recoverMap = {};
  const slugs = [];
  pend.forEach((e) => {
    const key = e.rawSlug || e.slug;
    if (key && !recoverMap[key]) { recoverMap[key] = e.sessionUrl; slugs.push(key); }
  });
  // Any-code recovery: read the CURRENT panel setting at recovery time, so
  // flipping the toggle after submitting still counts.
  const anyCode = (await chrome.storage.local.get({ fastAnyCode: 'off' })).fastAnyCode === 'on';
  const job = Object.assign({}, q.config, {
    slugs,
    recoverMap,
    recoverProviderUrl: q.config.aiUrl || '',
    recoverAnyCode: anyCode,
    retryMode: 'off',
    maxRetries: 0,
    fallbackAi: null,
    auditRetry: false,
    htmlRecoveryAudit: false,
    htmlRecoveryFailed: false,
    fastSubmit: false,
    recoverAfterMin: 0,
    parallel: 1
  });
  // Chunked Fast Submit: if a master plan owns this queue, tag the recovery job
  // so processLoop can advance to the next cycle when it truly finishes, and
  // mark the plan "recovering" (the state finishRecoveryBatch requires).
  if (matchingPlan && ['submitting', 'waiting_recovery', 'ready_next', 'recovering', 'paused'].includes(matchingPlan.status)) {
    job.fastCycleId = matchingPlan.id;
    job.fastCycleRecovery = true;
  }
  // Initialize runtime without launching processLoop yet. This makes plan
  // state, legacy-row migration, and queue cleanup atomic with respect to a
  // very fast recovery completion/failure.
  let deferredBatchReady = false;
  const previousPlanState = (matchingPlan && job.fastCycleRecovery) ? {
    status: matchingPlan.status,
    lastError: matchingPlan.lastError || ''
  } : null;
  try {
    await startBatch(job, { deferProcess: true });
    deferredBatchReady = true;
    if (matchingPlan && job.fastCycleRecovery) {
      matchingPlan.status = 'recovering';
      matchingPlan.lastError = '';
      await saveFastCyclePlan(matchingPlan);
    }
    // Older queues may contain provider-home or transient WEB entries. Seed their
    // explicit Failed rows before the recovery loop can mutate shared runtime.
    if (invalid.length) await materializeInvalidFastEntries(invalid, q);
    await chrome.storage.local.remove('__fastQueue');
    try { await chrome.alarms.clear(FAST_RECOVER_ALARM); } catch (e) {}
    log('info', '⏰ RECOVERY MODE: reopening ' + slugs.length + ' saved AI chat(s) one by one — reading the finished HTML and updating each post. No new prompts are sent.' +
      (anyCode ? ' ⚠ ANY-CODE mode is ON: whatever HTML each chat contains will be accepted and saved, even if short or incomplete.' : ' Safety rules are ON: only complete, verified articles are saved.'));
    launchCurrentBatchLoop();
    return { ok: true, count: slugs.length, invalidCount: invalid.length };
  } catch (e) {
    if (deferredBatchReady && runtime.job === job) {
      runtime.running = false;
      runtime.paused = false;
      runtime.rescueTabId = null;
      try { await persistRuntime(); } catch (persistErr) {}
    }
    if (matchingPlan && previousPlanState) {
      matchingPlan.status = previousPlanState.status;
      matchingPlan.lastError = previousPlanState.lastError;
      try { await saveFastCyclePlan(matchingPlan); } catch (planErr) {}
    }
    throw e;
  }
  } finally {
    fastRecoveryStarting = false;
  }
}

// ══════════════════════════════════════════════════════════════════════
// Chunked Fast Submit — automatic recovery cycles
//
// Instead of submitting every post at once, submit only `chunkSize` posts,
// wait for that group to be fully recovered + updated, then automatically
// start the next group. Repeat until every post is done (final group may be
// smaller). A crash-safe master plan (__fastCyclePlan) survives service-worker
// restarts; __fastQueue still holds ONLY the current cycle's chat entries.
// ══════════════════════════════════════════════════════════════════════
function sanitizeChunkSize(v) {
  let n = parseInt(v, 10);
  if (!Number.isFinite(n)) n = 50;   // blank / NaN / non-numeric → default
  if (n < 1) n = 1;                  // zero / negative → 1
  if (n > 2000) n = 2000;            // above range → 2000
  return n;
}

async function loadFastCyclePlan() {
  try { const d = await chrome.storage.local.get('__fastCyclePlan'); return d.__fastCyclePlan || null; }
  catch (e) { return null; }
}
async function saveFastCyclePlan(plan) {
  plan.updatedAt = Date.now();
  await chrome.storage.local.set({ __fastCyclePlan: plan });
}
async function clearFastCyclePlan() {
  try { await chrome.storage.local.remove('__fastCyclePlan'); } catch (e) {}
}

// Called from startBatch for a NEW fast submit (no cycle id yet). When the list
// is larger than one chunk it creates the master plan and slices the job down to
// the first cycle; otherwise it does nothing (classic single-cycle Fast Submit).
async function createFastCyclePlanIfNeeded(job) {
  const chunkSize = sanitizeChunkSize(job.fastChunkSize);
  // Deduplicate the slug list (panel already does, but keep the plan canonical).
  const seen = new Set();
  const allSlugs = (job.slugs || []).filter((s) => {
    const k = String(s);
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  // One chunk or fewer → run the classic single-cycle Fast Submit flow unchanged.
  if (allSlugs.length <= chunkSize) return;

  const totalPosts = allSlugs.length;
  const totalChunks = Math.ceil(totalPosts / chunkSize);
  const baseConfig = Object.assign({}, job);
  ['slugs', 'fastSubmit', 'recoverAfterMin', 'fastChunkSize', 'fastCycleId',
   'fastCycleChunkNumber', 'fastCycleTotalChunks', 'fastCycleStartIndex',
   'fastCycleRecovery', 'recoverMap', 'recoverFromUrl', 'recoverProviderMap', 'recoverProviderUrl', 'issueMap', 'freshFromBackup', 'recoverSections',
   'recoverAnyCode'].forEach((k) => delete baseConfig[k]);

  const plan = {
    id: 'fcp_' + Date.now() + '_' + Math.floor(Math.random() * 1e6),
    status: 'submitting',
    allSlugs,
    totalPosts,
    chunkSize,
    nextIndex: Math.min(totalPosts, chunkSize),
    currentChunkStart: 0,
    currentChunkEnd: Math.min(totalPosts, chunkSize),
    currentChunkNumber: 1,
    totalChunks,
    recoverAfterMin: Math.max(0, Math.min(720, Number(job.recoverAfterMin) || 0)),
    baseConfig,
    submittedTotal: 0,
    completedTotal: 0,
    failedTotal: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastError: ''
  };
  await saveFastCyclePlan(plan);

  // Start ONLY the first slice; attach cycle metadata for restart-safe tracking.
  job.slugs = allSlugs.slice(0, chunkSize);
  job.fastCycleId = plan.id;
  job.fastCycleChunkNumber = 1;
  job.fastCycleTotalChunks = totalChunks;
  job.fastCycleStartIndex = 0;
  log('step', '🚀 Chunked Fast Submit: ' + totalPosts + ' posts in ' + totalChunks +
    ' cycle(s) of up to ' + chunkSize + '. Each cycle is fully recovered before the next begins.');
}

// Launch the CURRENT chunk of a plan as its own fast-submit batch.
async function launchFastCycle(plan) {
  const chunkSlugs = plan.allSlugs.slice(plan.currentChunkStart, plan.currentChunkEnd);
  if (!chunkSlugs.length) {
    plan.status = 'completed';
    await saveFastCyclePlan(plan);
    return;
  }
  plan.status = 'submitting';
  await saveFastCyclePlan(plan);
  const job = Object.assign({}, plan.baseConfig, {
    slugs: chunkSlugs,
    fastSubmit: true,
    recoverAfterMin: plan.recoverAfterMin,
    parallel: 1,
    fastChunkSize: plan.chunkSize,
    fastCycleId: plan.id,
    fastCycleChunkNumber: plan.currentChunkNumber,
    fastCycleTotalChunks: plan.totalChunks,
    fastCycleStartIndex: plan.currentChunkStart
  });
  log('step', '🚀 Cycle ' + plan.currentChunkNumber + '/' + plan.totalChunks +
    ': fast-submitting posts ' + (plan.currentChunkStart + 1) + '-' + plan.currentChunkEnd +
    ' of ' + plan.totalPosts + '.');
  await startBatch(job);
}

// Called at the TRUE end of a cycle-recovery batch (after processLoop has
// released its re-entrancy guard). Commits the finished cycle into the plan and
// either starts the next cycle or finalizes the whole plan. Idempotent via the
// plan id + "recovering" status guard, so a duplicate alarm/restart callback
// cannot advance the same cycle twice.
async function finishRecoveryBatch(job) {
  if (!job || job.fastCycleRecovery !== true) return;
  const plan = await loadFastCyclePlan();
  if (!plan) { log('warn', 'Cycle recovery finished but no master plan was found — not advancing.'); return; }
  if (plan.id !== job.fastCycleId) { log('warn', 'Cycle recovery callback is stale (plan id changed) — not advancing.'); return; }
  // A user Stop must prevent automatic advancement.
  if (runtime.stopRequested) {
    plan.status = 'paused';
    await saveFastCyclePlan(plan);
    log('warn', '⏹ Fast Submit plan paused after Stop — no next cycle started.');
    return;
  }
  // Only a cycle that is actually "recovering" may advance (idempotency guard).
  if (plan.status !== 'recovering') {
    log('warn', 'Cycle recovery callback ignored — plan state is "' + plan.status + '", not "recovering".');
    return;
  }
  // Commit this cycle's recovery results into the overall totals.
  plan.completedTotal = (Number(plan.completedTotal) || 0) + (Number(runtime.successes) || 0);
  plan.failedTotal = (Number(plan.failedTotal) || 0) + (runtime.failures ? runtime.failures.length : 0);

  if (plan.currentChunkEnd >= plan.totalPosts) {
    // Final cycle finished — finalize the plan and send ONE final notification.
    plan.status = 'completed';
    await saveFastCyclePlan(plan);
    try { await chrome.alarms.clear(FAST_RECOVER_ALARM); } catch (e) {}
    try { await chrome.storage.local.remove('__fastQueue'); } catch (e) {}
    const msg = 'All ' + plan.totalPosts + ' posts across ' + plan.totalChunks + ' cycle(s) have finished their update attempts. ' +
      plan.completedTotal + ' updated, ' + plan.failedTotal + ' failed.';
    log('ok', '✅ Fast Submit plan complete. ' + msg);
    setStatus('✅ Fast Submit complete — ' + plan.completedTotal + '/' + plan.totalPosts + ' updated across ' + plan.totalChunks + ' cycle(s).', 'success');
    notifyBatchDone('Fast Submit complete ✓', msg);
    return;
  }

  // on-missing = stop fired during this cycle's submission: recover what was
  // submitted (already done above), then halt — do NOT start further cycles.
  if (plan.haltAfterCurrent) {
    plan.status = 'paused';
    plan.lastError = 'Stopped after a missing post (on-missing = stop). ' +
      'No further cycles were started. Use "Clear queue" to discard the plan.';
    await saveFastCyclePlan(plan);
    log('warn', '⏹ Fast Submit plan halted after a missing post (on-missing = stop) — no next cycle started.');
    setStatus('⏹ Fast Submit halted (missing post, on-missing = stop) — ' + plan.completedTotal + '/' + plan.totalPosts + ' updated.', 'error');
    notifyBatchDone('Fast Submit halted', 'A post was not found and on-missing is set to stop. ' + plan.completedTotal + ' updated before halting.');
    return;
  }

  // Advance to the next cycle. Persist "ready_next" FIRST so a crash in the gap
  // cannot lose the transition (startup reconcile will resume it).
  plan.currentChunkStart = plan.currentChunkEnd;
  plan.currentChunkNumber = plan.currentChunkNumber + 1;
  plan.currentChunkEnd = Math.min(plan.totalPosts, plan.currentChunkStart + plan.chunkSize);
  plan.nextIndex = plan.currentChunkEnd;
  plan.status = 'ready_next';
  await saveFastCyclePlan(plan);
  log('step', '↻ Cycle ' + (plan.currentChunkNumber - 1) + ' recovered. Overall: ' +
    plan.completedTotal + '/' + plan.totalPosts + ' updated. Starting cycle ' +
    plan.currentChunkNumber + '/' + plan.totalChunks + '.');
  await launchFastCycle(plan);
}

// Startup reconcile: after a service-worker or browser restart, decide whether
// the master plan needs any action. Only acts when no runtime batch is active
// (an active runtime already owns the resume via loadRuntime).
async function reconcileFastCyclePlan() {
  const plan = await loadFastCyclePlan();
  if (!plan) return;
  if (plan.status === 'completed' || plan.status === 'error' || plan.status === 'paused') return;
  if (runtime.running) return;   // existing resume logic owns the transition

  if (plan.status === 'waiting_recovery') {
    // Restore the scheduled recovery alarm (auto mode) if it hasn't fired yet.
    const d = await chrome.storage.local.get('__fastQueue');
    const recoverAt = d.__fastQueue?.recoverAt || 0;
    if (recoverAt > 0) {
      if (recoverAt <= Date.now()) {
        log('info', '⏰ Recovery time passed during shutdown — recovering the current cycle now.');
        startFastRecovery('alarm').catch(e => log('err', 'Resume recovery failed: ' + (e?.message || e)));
      } else {
        try { chrome.alarms.create(FAST_RECOVER_ALARM, { when: recoverAt }); } catch (e) {}
        log('info', '⏰ Restored the recovery alarm for the current Fast Submit cycle.');
      }
    }
    return;   // recoverAt === 0 → manual mode: wait for the user
  }
  if (plan.status === 'ready_next') {
    // The cycle transition was committed but the next cycle never launched
    // (crash in the gap). Start it exactly once.
    log('info', '↻ Resuming Fast Submit plan after restart: starting cycle ' +
      plan.currentChunkNumber + '/' + plan.totalChunks + '.');
    startKeepAlive();
    await launchFastCycle(plan);
    return;
  }
  if (plan.status === 'submitting' || plan.status === 'recovering') {
    // A phase was in flight but no runtime survived — storage is inconsistent.
    // Pause with a visible message rather than guessing (never duplicate posts
    // or delete chat links).
    const phase = plan.status;
    plan.status = 'paused';
    plan.lastError = 'Interrupted during "' + phase + '" and could not be resumed automatically. ' +
      'Press "Recover & Update Now" to retry the current cycle, or "Clear queue" to discard the plan.';
    await saveFastCyclePlan(plan);
    log('warn', '⚠ Fast Submit plan paused after an interrupted "' + phase + '" phase. Use Recover Now or Clear queue.');
    return;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Audit Retry (opt-in) — re-process posts whose post-save audit reported
// issues. Fully gated by job.auditRetry; when OFF nothing here runs and the
// batch behaves exactly as before. Hard-capped at 3 retries and the queue is
// de-duplicated, so it can never loop endlessly or duplicate work.
// ──────────────────────────────────────────────────────────────────────
function auditRetryOn() {
  return !!(runtime.job && runtime.job.auditRetry === true && (Number(runtime.job.auditRetryCount) || 0) > 0);
}

// Automatic HTML Code Recovery (opt-in): reopen the saved AI session and read
// the code box that was already generated, instead of generating again. The two
// triggers (audit issues vs failed posts) are controlled independently.
function htmlRecoveryAuditOn() {
  return !!(runtime.job && runtime.job.htmlRecoveryAudit === true);
}
function htmlRecoveryFailedOn() {
  return !!(runtime.job && runtime.job.htmlRecoveryFailed === true);
}
// Auto-pause the whole batch the moment an AI usage/weekly limit is detected.
function limitGuardOn() {
  return !!(runtime.job && runtime.job.limitGuard === true);
}
// Safety Gate (v3.46.0): code checks before every save. ON unless the job
// explicitly switched it off.
function safetyGateOn() {
  return !!(runtime.job && runtime.job.gateEnabled !== false);
}
// AI Fact-Check round (v3.46.0). Part of the Safety Gate, so it never runs
// while the gate itself is off.
function factCheckOn() {
  return !!(safetyGateOn() && runtime.job.factCheck !== false);
}

// ══════════════════════════════════════════════════════════════════════
// REPEATED-FAILURE POLICY (user configurable)
//
//   failStopCount   0 = never stop, keep trying every post to the end.
//                   N = pause after N failures in a row.
//   failRetryAfter  0 = stay paused until the user presses Resume.
//                   N = auto-resume N minutes later, by itself.
//
// After a timed auto-resume the batch is on probation: ONE more failure
// re-pauses and re-arms the same timer, so a broken provider is retried every
// N minutes forever instead of burning the queue. A single success ends
// probation and restores the full failStopCount budget.
// ══════════════════════════════════════════════════════════════════════
// Fast Submit's "Prompt paste wait" in ms. 0 for every other run type — a
// Start Batch run keeps its original timing exactly as before.
function fastPasteWaitMs() {
  if (!runtime.job?.fastSubmit) return 0;
  const secs = Number(runtime.job?.fastPasteWait);
  if (!Number.isFinite(secs) || secs <= 0) return 10000;      // documented default
  return Math.max(1, Math.min(600, Math.round(secs))) * 1000;
}

// Fast Submit: how many paste → verify → send attempts one post may use.
function fastPasteRetriesOf() {
  const n = Number(runtime.job?.fastPasteRetries);
  if (!Number.isFinite(n) || n < 1) return 3;
  return Math.max(1, Math.min(3, Math.round(n)));
}

function failStopCountOf() {
  const raw = Number(runtime.job?.failStopCount);
  if (!Number.isFinite(raw) || raw <= 0) return 0;      // 0 → never auto-pause
  return Math.max(1, Math.min(100, Math.round(raw)));
}

function failRetryMinutesOf() {
  const raw = Number(runtime.job?.failRetryAfter);
  if (!Number.isFinite(raw) || raw <= 0) return 0;      // 0 → manual resume
  return Math.max(1, Math.min(1440, Math.round(raw)));
}

// How many consecutive failures may pass before pausing right now.
function effectiveFailThreshold() {
  const configured = failStopCountOf();
  if (!configured) return 0;
  return runtime.failProbation ? 1 : configured;
}

function shouldPauseForConsecutiveFailures() {
  const threshold = effectiveFailThreshold();
  if (!threshold) return false;                          // "never stop" mode
  return (Number(runtime.consecFails) || 0) >= threshold;
}

// Pause the run and (optionally) schedule its own resume.
async function pauseForRepeatedFailures(context, lastErrorMessage) {
  const mins = failRetryMinutesOf();
  const fails = Number(runtime.consecFails) || 0;
  runtime.paused = true;
  runtime.autoPauseKind = 'consec-fail';
  const when = mins ? Date.now() + mins * 60000 : 0;
  if (when) {
    try { chrome.alarms.create(FAIL_RETRY_ALARM, { when }); } catch (e) {}
  }
  const retryText = when
    ? ' Retrying automatically at ' + new Date(when).toLocaleTimeString() + ' (in ' + mins + ' min) — keep Chrome open.'
    : ' Press Resume when the cause is fixed.';
  runtime.autoPauseReason = '⏸ ' + context + ' paused — ' + fails + ' post(s) in a row failed (last: ' +
    String(lastErrorMessage || '').slice(0, 140) + ').' + retryText;
  log('warn', runtime.autoPauseReason);
  notifyBatchDone(context + ' paused — repeated failures',
    fails + ' posts in a row failed.' + (when ? ' Auto-retry in ' + mins + ' min.' : ' Open the panel to Resume.'));
  await persistRuntime();
}

// Fired by FAIL_RETRY_ALARM: lift the pause by ourselves and let the running
// loop continue. The loop is still parked in its pause gate (or is restarted
// by the keep-alive alarm after a service-worker restart).
async function autoResumeAfterFailPause() {
  await loadRuntime();
  if (!runtime.running || !runtime.paused || runtime.autoPauseKind !== 'consec-fail') return;
  if (runtime.stopRequested) return;
  runtime.paused = false;
  runtime.autoPauseReason = '';
  runtime.autoPauseKind = '';
  runtime.consecFails = 0;
  runtime.failProbation = true;      // one more failure re-pauses and re-arms
  runtime.failRetryCycles = (Number(runtime.failRetryCycles) || 0) + 1;
  runtime.rescueTabId = null;
  log('step', '⏰ Auto-retry #' + runtime.failRetryCycles + ': resuming the run after the failure pause. If the next post fails too, it pauses again and retries after the same interval.');
  setStatus('⏰ Auto-retry #' + runtime.failRetryCycles + ' — resuming.', '');
  await persistRuntime();
  if (!processing) processLoop().catch(e => log('err', 'Loop error after auto-retry: ' + e.message));
}

// A success ends probation and restores the full failure budget.
function noteRunSuccess() {
  runtime.consecFails = 0;
  runtime.failProbation = false;
}

function auditReportHasIssues(report) {
  return /AUDIT ISSUES/i.test(String(report || ''));
}

// Called right after a post saves successfully. If audit retry is on and this
// post's audit found issues, either retry now (immediate) or queue it (end).
async function maybeAuditRetry(rawSlug, slug, num, total, attemptLinks, attemptTabs) {
  if (runtime.stopRequested) return;
  if (!auditReportHasIssues(attemptLinks && attemptLinks.auditReport)) return;
  if (!auditRetryOn() && !htmlRecoveryAuditOn()) return;
  // 1) HTML recovery first (if on): re-read the existing code box from the saved
  //    session. This rescues audit issues caused by a truncated/partial copy.
  if (htmlRecoveryAuditOn() && attemptLinks && attemptLinks.aiSessionUrl && !isApiAIJob()) {
    const recovered = await tryHtmlRecovery(rawSlug, slug, num, total, attemptLinks.aiSessionUrl, attemptLinks.aiProviderUrl);
    if (recovered || runtime.stopRequested) return;
  }
  // 2) Regenerate retry ("retry new"), if enabled, honoring the timing setting.
  if (!auditRetryOn()) return;
  const timing = runtime.job.auditRetryTiming === 'immediate' ? 'immediate' : 'end';
  if (timing === 'immediate') {
    await runAuditRetriesForSlug(rawSlug, slug, num, total, attemptLinks, attemptTabs);
  } else {
    if (!Array.isArray(runtime.auditRetryQueue)) runtime.auditRetryQueue = [];
    if (!runtime.auditRetryQueue.includes(rawSlug)) {
      runtime.auditRetryQueue.push(rawSlug);
      log('info', '[' + num + '/' + total + '] Audit issue — queued "' + slug + '" for the end-of-batch audit-retry pass.');
    }
  }
}

// Re-process ONE post up to auditRetryCount times, stopping as soon as the
// post-save audit comes back clean. Each re-process is recorded as its own
// attempt (flagged auditRetry:true) so the panel supersedes the prior row.
async function runAuditRetriesForSlug(rawSlug, slug, num, total, attemptLinks, attemptTabs) {
  const max = Math.max(1, Math.min(3, Number(runtime.job.auditRetryCount) || 1));
  attemptTabs = attemptTabs || { edit: null, ai: null };
  for (let r = 1; r <= max; r++) {
    if (runtime.stopRequested) break;
    log('warn', '↻ Audit retry ' + r + '/' + max + ' for "' + slug + '" (re-running the AI to clear the audit issue).');
    setStatus('[' + num + '/' + total + '] Audit retry ' + r + '/' + max + ' "' + slug + '"');
    if (attemptTabs.ai)   { await safeCloseTab(attemptTabs.ai);   attemptTabs.ai = null; }
    if (attemptTabs.edit) { await safeCloseTab(attemptTabs.edit); attemptTabs.edit = null; }
    await sleep(3000);
    attemptLinks.auditRetry = true;   // mark every retry attempt for the panel
    try {
      await processSlug(slug, num, total, attemptLinks, 0, attemptTabs);
    } catch (e) {
      log('err', 'Audit retry ' + r + '/' + max + ' for "' + slug + '" errored: ' + (e && e.message ? e.message : e));
      rememberAttempt(rawSlug, slug, 'failed', 'Audit retry ' + r + '/' + max + ' failed — ' + (e && e.message ? e.message : e), attemptLinks);
      break;
    }
    const stillIssues = auditReportHasIssues(attemptLinks.auditReport);
    const baseMsg = attemptLinks.auditReport ? ('Updated on WordPress — ' + attemptLinks.auditReport) : 'Updated on WordPress';
    rememberAttempt(rawSlug, slug, 'updated', baseMsg + ' [audit retry ' + r + '/' + max + ']', attemptLinks);
    if (!stillIssues) {
      log('ok', '✓ Audit retry solved "' + slug + '" on attempt ' + r + '/' + max + '.');
      break;
    }
    if (r === max) log('warn', 'Audit issue still present for "' + slug + '" after ' + max + ' retr' + (max === 1 ? 'y' : 'ies') + '.');
  }
}

// End-of-batch audit-retry pass: re-process every queued audit-issue post.
async function runAuditRetryEndPass() {
  if (!auditRetryOn()) return;
  const timing = runtime.job.auditRetryTiming === 'immediate' ? 'immediate' : 'end';
  if (timing !== 'end') return;
  const queue = [...new Set(runtime.auditRetryQueue || [])];
  runtime.auditRetryQueue = [];
  if (!queue.length || runtime.stopRequested) return;
  const total = queue.length;
  log('step', '↻ All posts processed — now audit-retrying ' + total + ' post(s) with audit issues.');
  setStatus('Audit-retry pass — ' + total + ' post(s)');
  await persistRuntime();
  await sleep(2000);
  for (let i = 0; i < queue.length; i++) {
    if (runtime.stopRequested) break;
    const rawSlug = queue[i];
    const slug = cleanSlug(rawSlug);
    const attemptLinks = {};
    const attemptTabs = { edit: null, ai: null };
    log('step', '──── audit-retry [' + (i + 1) + '/' + total + '] ' + slug + ' ────');
    try {
      await runAuditRetriesForSlug(rawSlug, slug, i + 1, total, attemptLinks, attemptTabs);
    } catch (e) {
      log('err', 'Audit-retry pass error for "' + slug + '": ' + (e && e.message ? e.message : e));
    }
    if (attemptTabs.ai)   { await safeCloseTab(attemptTabs.ai);   attemptTabs.ai = null; }
    if (attemptTabs.edit) { await safeCloseTab(attemptTabs.edit); attemptTabs.edit = null; }
    await persistRuntime();
  }
  log('ok', '✓ Audit-retry pass complete.');
}

// Try to recover a failed / audit-flagged post by reopening its saved AI session
// and re-reading the existing code box. Reuses the full processSlug save+audit
// path (recovery mode via attemptLinks.recoverFromUrl). Returns true only when it
// saved a clean article whose audit is OK. Never throws. processSlug does not call
// the retry/recovery triggers, so there is no recursion.
async function tryHtmlRecovery(rawSlug, slug, num, total, sessionUrl, providerHomeUrl) {
  if (runtime.stopRequested) return false;
  if (isApiAIJob()) return false;                       // no web session to recover from
  const canonicalSessionUrl = canonicalizeAISessionUrl(
    sessionUrl,
    detectProviderKind(sessionUrl || providerHomeUrl),
    providerHomeUrl || ''
  );
  if (!canonicalSessionUrl) return false;
  log('step', '↻ HTML recovery for "' + slug + '" -- reading the existing AI code box.');
  setStatus('[' + num + '/' + total + '] HTML recovery for "' + slug + '"');
  const links = {
    recoverFromUrl: canonicalSessionUrl,
    recoverProviderUrl: providerHomeUrl || '',
    aiProviderUrl: providerHomeUrl || '',
    auditRetry: true
  };
  const tabs = { edit: null, ai: null };
  let ok = false;
  // Auto "Recover any code": accept shorter/partial HTML from the saved session
  // for this recovery save only (temporarily bypass the completeness gate).
  const _savedAnyCode = runtime.job.recoverAnyCode;
  if (runtime.job.htmlRecoveryAnyCode === true) runtime.job.recoverAnyCode = true;
  try {
    await processSlug(slug, num, total, links, 0, tabs);
    const stillIssue = auditReportHasIssues(links.auditReport);
    rememberAttempt(rawSlug, slug, 'updated',
      (links.auditReport ? ('Updated on WordPress — ' + links.auditReport) : 'Updated on WordPress') + ' [recovered from AI session]',
      links);
    if (stillIssue) {
      log('warn', 'HTML recovery saved "' + slug + '" but the audit still reports issues -- will retry fresh.');
    } else {
      log('ok', '✓ HTML recovery succeeded for "' + slug + '" (saved the existing code box).');
      ok = true;
    }
  } catch (e) {
    log('warn', 'HTML recovery could not recover "' + slug + '": ' + (e && e.message ? e.message : e));
  } finally {
    runtime.job.recoverAnyCode = _savedAnyCode;   // restore the any-code gate
    if (tabs.ai)   { await safeCloseTab(tabs.ai);   tabs.ai = null; }
    if (tabs.edit) { await safeCloseTab(tabs.edit); tabs.edit = null; }
  }
  return ok;
}

// ──────────────────────────────────────────────────────────────────────
// Tab helpers
// ──────────────────────────────────────────────────────────────────────
// Background mode: when ON, all automation tabs live in a dedicated
// worker window that NEVER takes focus, so the user can keep working
// in their own window/tabs while the batch runs.
function isBackgroundMode() {
  return runtime.job?.backgroundMode === 'on';
}

// Hand focus back to the panel — but only if the panel is on screen. Focusing
// a minimized window un-minimizes it, so doing this unconditionally popped the
// user's window back open every time they minimized the browser.
async function focusPanelIfVisible() {
  const id = runtime.panelWindowId;
  if (!id) return false;
  try {
    const win = await chrome.windows.get(id);
    if (!win || win.state === 'minimized') return false;
    await chrome.windows.update(id, { focused: true });
    return true;
  } catch (e) {
    return false;
  }
}

async function windowExists(windowId) {
  if (!windowId) return false;
  try { await chrome.windows.get(windowId); return true; } catch (e) { return false; }
}

// Create (or reuse) the unfocused worker window. It keeps a single
// placeholder tab (worker.html) so the window stays alive even when an
// automation tab is closed between posts.
async function ensureWorkerWindow() {
  if (await windowExists(runtime.workerWindowId)) return runtime.workerWindowId;
  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL('worker.html'),
      focused: false,            // <-- the whole point: never steal focus
      type: 'normal',
      width: 1000,
      height: 760,
      top: 60,
      left: 60
    });
    runtime.workerWindowId = win.id;
    // Make sure it really is unfocused (some platforms focus on create).
    try { await focusPanelIfVisible(); } catch (e) {}
    log('info', 'Background mode: opened worker window (keep it open while the batch runs)');
    return win.id;
  } catch (e) {
    log('warn', 'Could not open worker window, falling back to normal tabs: ' + (e?.message || e));
    runtime.workerWindowId = null;
    return null;
  }
}

async function closeWorkerWindow() {
  if (!runtime.workerWindowId) return;
  const id = runtime.workerWindowId;
  runtime.workerWindowId = null;
  try { await chrome.windows.remove(id); } catch (e) {}
}

// Open an automation tab. In background mode it goes into the worker
// window as that window's active tab (so the page reports
// document.visibilityState === 'visible' and the AI keeps streaming),
// but the worker window itself is never focused.
// Called before opening AI tabs: if the worker window is sitting minimized,
// nothing inside it will render. Fix it up front.
async function ensureWorkerWindowUsable() {
  try { return await reviveCollapsedWorkerWindow('before opening the AI tab'); }
  catch (e) { return false; }
}

async function createWorkTab(url) {
  const tab = await createWorkTabInner(url);
  if (tab?.id) {
    runtime.trackedTabs.push(tab.id);
    if (runtime.trackedTabs.length > 20) runtime.trackedTabs = runtime.trackedTabs.slice(-20);
    try { await persistRuntime(); } catch (e) {}
  }
  return tab;
}

async function createWorkTabInner(url) {
  if (isBackgroundMode()) {
    const winId = await ensureWorkerWindow();
    if (winId) {
      const tab = await chrome.tabs.create({ url, active: true, windowId: winId });
      // Never bring the worker window forward.
      try { if (runtime.panelWindowId !== winId) await focusPanelIfVisible(); } catch (e) {}
      return tab;
    }
  }
  return chrome.tabs.create({ url, active: true });
}

async function focusTab(tabId) {
  if (!tabId) return;
  try {
    if (isBackgroundMode()) {
      // Activate within its own (worker) window only — do NOT focus the
      // window, so the user keeps working wherever they are.
      await chrome.tabs.update(tabId, { active: true });
      return;
    }
    const t = await chrome.tabs.get(tabId);
    await chrome.windows.update(t.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch (e) {}
}

async function returnToPanel() {
  // In background mode we deliberately never jump back to the panel —
  // that jump is exactly what was interrupting the user between posts.
  if (isBackgroundMode()) return;
  if (runtime.panelTabId) {
    try { await focusTab(runtime.panelTabId); } catch (e) {}
  }
}

async function tabExists(tabId) {
  if (!tabId) return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch (e) {
    return false;
  }
}

async function safeCloseTab(tabId) {
  const closed = await safeCloseTabInner(tabId);
  if (closed && tabId) {
    runtime.trackedTabs = (runtime.trackedTabs || []).filter(id => id !== tabId);
  }
  return closed;
}

async function safeCloseTabInner(tabId) {
  if (!tabId) return true;
  let lastError = '';

  for (let attempt = 1; attempt <= 5; attempt++) {
    if (!(await tabExists(tabId))) return true;
    try { await runInTab(tabId, prepareTabForClose); } catch (e) {}
    try {
      await chrome.tabs.remove(tabId);
    } catch (e) {
      lastError = e?.message || String(e);
    }
    await sleep(300 + attempt * 250);
  }

  if (!(await tabExists(tabId))) return true;

  // Last resort: move the page away from WordPress, then remove it again.
  try {
    await runInTab(tabId, prepareTabForClose);
    await chrome.tabs.update(tabId, { url: 'about:blank' });
    await sleep(700);
    await chrome.tabs.remove(tabId);
  } catch (e) {
    lastError = e?.message || String(e) || lastError;
  }
  await sleep(700);

  const closed = !(await tabExists(tabId));
  if (!closed) log('warn', 'Close verification failed for tab ' + tabId + (lastError ? ': ' + lastError : ''));
  return closed;
}

async function closeWordPressEditorTabsStrict(primaryTabId, siteUrl, postId, tag) {
  const tabIds = new Set();
  if (primaryTabId) tabIds.add(primaryTabId);

  const origin = safeOrigin(siteUrl);
  try {
    const tabs = await chrome.tabs.query({});
    tabs.forEach(tab => {
      if (!tab?.id || !tab.url || tab.id === runtime.panelTabId) return;
      if (isSameWordPressEditorTab(tab.url, origin, postId)) tabIds.add(tab.id);
    });
  } catch (e) {}

  let closedCount = 0;
  let leftOpen = 0;
  for (const tabId of tabIds) {
    if (await safeCloseTab(tabId)) closedCount++;
    else leftOpen++;
  }

  if (leftOpen > 0) {
    log('warn', tag + ' WordPress close check left ' + leftOpen + ' editor tab(s) open for post ID ' + postId);
    return false;
  }
  log('ok', tag + ' Closed ' + closedCount + ' WordPress editor tab(s)');
  return true;
}

function safeOrigin(url) {
  try { return new URL(url).origin; } catch (e) { return ''; }
}

function isSameWordPressEditorTab(url, origin, postId) {
  try {
    const u = new URL(url);
    if (origin && u.origin !== origin) return false;
    if (!u.pathname.includes('/wp-admin/post.php')) return false;
    if (u.searchParams.get('post') !== String(postId)) return false;
    const action = u.searchParams.get('action');
    return !action || action === 'edit';
  } catch (e) {
    return false;
  }
}

async function getTabUrl(tabId, fallbackUrl) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.url || fallbackUrl || '';
  } catch (e) { return fallbackUrl || ''; }
}

// A provider landing page is navigable, but it is NOT a durable chat session.
// Keep that distinction in one place so Fast Submit, recovery, and failed-link
// reporting cannot accidentally turn https://chatgpt.com/ into an "AI session".
function normalizeHttpUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.href;
  } catch (e) {
    return '';
  }
}

function aiUrlKey(value, includeSearch, includeHash) {
  try {
    const u = new URL(String(value || '').trim());
    const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
    return u.origin.toLowerCase() + path + (includeSearch ? u.search : '') + (includeHash ? u.hash : '');
  } catch (e) {
    return '';
  }
}

// ChatGPT exposes a transient /c/WEB:<uuid> route while a new chat is being
// created. It is not durable. Only the final HTTPS UUID route is recoverable.
const CHATGPT_CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseChatGPTConversationUrl(value) {
  const raw = String(value || '').trim();
  const allowedHosts = new Set(['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com']);
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (u.protocol !== 'https:' || !allowedHosts.has(u.hostname.toLowerCase())) return null;
  if (u.username || u.password || u.port) return null;
  let transientUrlState = u.search + u.hash;
  for (let i = 0; i < 2; i++) {
    try {
      const decoded = decodeURIComponent(transientUrlState);
      if (decoded === transientUrlState) break;
      transientUrlState = decoded;
    } catch (e) { break; }
  }
  if (/(?:^|[?&#\/:=])(?:temporary-chat|temporary|incognito)(?=$|[?&#\/:=])/i.test(transientUrlState)) return null;

  const standard = u.pathname.match(/^\/c\/([^/]+)\/?$/i);
  const customGpt = u.pathname.match(/^\/g\/(g-[a-z0-9][a-z0-9_-]*)\/c\/([^/]+)\/?$/i);
  const id = standard?.[1] || customGpt?.[2] || '';
  if (!CHATGPT_CONVERSATION_ID_RE.test(id)) return null;
  const canonicalPath = standard
    ? '/c/' + id.toLowerCase()
    : '/g/' + customGpt[1] + '/c/' + id.toLowerCase();
  return { id: id.toLowerCase(), url: 'https://chatgpt.com' + canonicalPath };
}

function canonicalizeChatGPTSessionUrl(value) {
  return parseChatGPTConversationUrl(value)?.url || '';
}

// Gemini conversation routes:
//   https://gemini.google.com/app/<hex-id>
//   https://gemini.google.com/u/<n>/app/<hex-id>      (multi-account login)
//   https://gemini.google.com/gem/<gem-id>/<hex-id>   (Gems, incl. /u/<n>/ prefix)
// The final segment is the server-assigned hex conversation id. Right after
// send, Gemini can briefly show an optimistic route that is later re-keyed, so
// callers must re-verify the id has settled before storing it. A bare /app,
// settings routes, or non-hex segments are never conversations.
const GEMINI_CONVERSATION_ID_RE = /^[0-9a-f]{8,}$/i;
function parseGeminiConversationUrl(value) {
  const raw = String(value || '').trim();
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (host !== 'gemini.google.com' && host !== 'bard.google.com') return null;
  const path = (u.pathname || '/').replace(/\/+$/, '');
  const m = path.match(/^(\/u\/\d+)?\/(app|gem\/[^/]+)\/([^/]+)$/i);
  if (!m) return null;
  const id = (m[3] || '').toLowerCase();
  if (!GEMINI_CONVERSATION_ID_RE.test(id)) return null;
  // Keep the /u/<n>/ account prefix so recovery reopens the chat under the
  // SAME Google account; drop query/hash noise (?hl=... etc.).
  return {
    id,
    url: 'https://gemini.google.com' + (m[1] || '') + '/' + m[2] + '/' + id
  };
}

function canonicalizeGeminiSessionUrl(value) {
  return parseGeminiConversationUrl(value)?.url || '';
}

// Conversation identity ignores host aliases and cosmetic query/hash changes
// for built-in providers, but keeps the full URL state for custom providers.
// Fast Submit uses this to reject a pre-existing or duplicate chat.
function aiConversationKey(value, providerKind) {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return '';
  try {
    const u = new URL(normalized);
    const detectedKind = detectProviderKind(normalized);
    const kind = detectedKind !== 'generic' ? detectedKind : (providerKind || detectedKind);
    if (kind === 'chatgpt') {
      const parsed = parseChatGPTConversationUrl(normalized);
      return parsed ? 'chatgpt:' + parsed.id : '';
    }
    if (kind === 'gemini') {
      // Identity by conversation id only: /u/1/app/<id> and /app/<id> are the
      // SAME chat, so exclusion and duplicate checks must not treat the
      // account prefix as a different conversation.
      const parsed = parseGeminiConversationUrl(normalized);
      return parsed ? 'gemini:' + parsed.id : '';
    }
    const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
    if (kind && kind !== 'generic') return kind + ':' + path;
    return u.origin.toLowerCase() + path + u.search + u.hash;
  } catch (e) {
    return '';
  }
}

function sameAIProviderFamily(candidateUrl, providerHomeUrl, providerKind) {
  if (!providerHomeUrl) return true;
  try {
    const a = new URL(candidateUrl);
    const b = new URL(providerHomeUrl);
    if (a.origin === b.origin) return true;
    const ah = a.hostname.toLowerCase();
    const bh = b.hostname.toLowerCase();
    const inDomain = (host, root) => host === root || host.endsWith('.' + root);
    if (providerKind === 'chatgpt') {
      const chatHosts = new Set(['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com']);
      return chatHosts.has(ah) && chatHosts.has(bh);
    }
    if (providerKind === 'claude') return inDomain(ah, 'claude.ai') && inDomain(bh, 'claude.ai');
    if (providerKind === 'gemini') {
      const geminiHosts = new Set(['gemini.google.com', 'bard.google.com']);
      return geminiHosts.has(ah) && geminiHosts.has(bh);
    }
    if (providerKind === 'grok') {
      const isGrokHost = (host) => inDomain(host, 'grok.com') || host === 'grok.x.ai';
      return isGrokHost(ah) && isGrokHost(bh);
    }
    if (providerKind === 'deepseek') return inDomain(ah, 'deepseek.com') && inDomain(bh, 'deepseek.com');
    if (providerKind === 'perplexity') return inDomain(ah, 'perplexity.ai') && inDomain(bh, 'perplexity.ai');
    return false;
  } catch (e) {
    return false;
  }
}

function isRecoverableAISessionUrl(value, providerKind, providerHomeUrl) {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return false;
  let u;
  try { u = new URL(normalized); } catch (e) { return false; }
  const detectedKind = detectProviderKind(normalized);
  const kind = detectedKind !== 'generic' ? detectedKind : (providerKind || detectedKind);
  if (!sameAIProviderFamily(normalized, providerHomeUrl, kind)) return false;

  const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
  const lowerPath = path.toLowerCase();
  const lowerSearch = u.search.toLowerCase();
  const lowerHash = u.hash.toLowerCase();
  if (/\/(?:login|log-in|signin|sign-in|signup|sign-up|auth)(?:\/|$)/i.test(lowerPath)) return false;
  if (/(?:^|[?&])(?:temporary-chat|temporary|incognito)=?(?:1|true|yes)?(?:&|$)/i.test(lowerSearch)) return false;

  if (kind === 'chatgpt') {
    return !!canonicalizeChatGPTSessionUrl(normalized);
  }
  if (kind === 'claude') return /\/chat\/[^/]{6,}(?:\/|$)/i.test(path);
  if (kind === 'gemini') return !!parseGeminiConversationUrl(normalized);
  if (kind === 'grok') return /\/(?:c|chat)\/[^/]{6,}(?:\/|$)/i.test(path);
  if (kind === 'deepseek') return /\/(?:a\/)?chat\/(?:s\/)?[^/]{4,}(?:\/|$)/i.test(path);
  if (kind === 'perplexity') return /\/(?:search|page)\/[^/]{4,}(?:\/|$)/i.test(path);

  // Custom web providers: accept explicit session IDs in a query or meaningful
  // hash-based SPA routes, while rejecting cosmetic query/hash changes.
  const hasSessionParam = [...u.searchParams.entries()].some(([k, v]) =>
    /^(?:chat|conversation|session|thread)(?:[-_]?id)?$/i.test(k) && String(v || '').trim().length >= 3
  );
  const hasSessionHash = /(?:^|[#!\/])(?:chat|conversation|session|thread)[=:\/][^/?#&]{3,}/i.test(lowerHash) &&
    !/(?:^|[#!\/])(?:chat|conversation|session|thread)[=:\/]new(?:\/|$)/i.test(lowerHash);
  if (providerHomeUrl && aiUrlKey(normalized, false) === aiUrlKey(providerHomeUrl, false)) {
    const homeHash = (() => { try { return new URL(providerHomeUrl).hash.toLowerCase(); } catch (e) { return ''; } })();
    if (!hasSessionParam && !(hasSessionHash && lowerHash !== homeHash)) return false;
  }
  if (lowerPath === '/') return hasSessionParam || hasSessionHash;
  if (!hasSessionParam && !hasSessionHash && /^\/(?:app|home|dashboard|workspace|chat)$/i.test(lowerPath)) return false;
  if (/\/(?:new|new-chat|chat\/new)(?:\/|$)/i.test(lowerPath)) return false;
  return true;
}

// Validation and normalization are one operation so no caller can validate a
// ChatGPT URL and then accidentally store its transient query/WEB form.
function canonicalizeAISessionUrl(value, providerKind, providerHomeUrl) {
  const normalized = normalizeHttpUrl(value);
  if (!normalized) return '';
  const detectedKind = detectProviderKind(normalized);
  const kind = detectedKind !== 'generic' ? detectedKind : (providerKind || detectedKind);
  if (kind === 'chatgpt') {
    if (!sameAIProviderFamily(normalized, providerHomeUrl, kind)) return '';
    return canonicalizeChatGPTSessionUrl(normalized);
  }
  if (kind === 'gemini') {
    // Same fail-closed contract as ChatGPT: only a parsed conversation route is
    // ever stored, with query/hash noise (?hl=…) stripped so the saved link
    // and every later identity comparison use one canonical form.
    if (!sameAIProviderFamily(normalized, providerHomeUrl, kind)) return '';
    if (!isRecoverableAISessionUrl(normalized, kind, providerHomeUrl)) return '';
    return canonicalizeGeminiSessionUrl(normalized);
  }
  return isRecoverableAISessionUrl(normalized, kind, providerHomeUrl) ? normalized : '';
}

// Only the page's actual location is authoritative. Canonical/OG tags and
// active sidebar anchors can expose stale or optimistic conversation IDs.
function inspectAISessionLocation() {
  return String(location.href || '');
}

async function getAISessionUrlCandidates(tabId) {
  const out = [];
  const add = (v) => {
    const s = String(v || '').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  try {
    const tab = await chrome.tabs.get(tabId);
    add(tab?.url);
  } catch (e) {}
  try {
    const page = await runInTab(tabId, inspectAISessionLocation);
    if (Array.isArray(page?.result)) page.result.forEach(add);
    else add(page?.result);
  } catch (e) {}
  return out;
}

async function getSettledAIPageUrl(tabId, providerHomeUrl) {
  const providerKind = detectProviderKind(providerHomeUrl);
  try {
    const page = await runInTab(tabId, inspectAISessionLocation);
    const currentLocation = Array.isArray(page?.result) ? page.result[0] : page?.result;
    if (normalizeHttpUrl(currentLocation) && sameAIProviderFamily(currentLocation, providerHomeUrl, providerKind)) {
      return normalizeHttpUrl(currentLocation);
    }
  } catch (e) {}
  try {
    const tab = await chrome.tabs.get(tabId);
    const tabUrl = tab?.url || '';
    if (normalizeHttpUrl(tabUrl) && sameAIProviderFamily(tabUrl, providerHomeUrl, providerKind)) {
      return normalizeHttpUrl(tabUrl);
    }
  } catch (e) {}
  return normalizeHttpUrl(providerHomeUrl);
}

async function refreshAISessionUrl(tabId, previousUrl, providerKind, providerHomeUrl) {
  const candidates = await getAISessionUrlCandidates(tabId);
  for (const candidate of candidates) {
    const canonical = canonicalizeAISessionUrl(candidate, providerKind, providerHomeUrl);
    if (canonical) return canonical;
  }
  return canonicalizeAISessionUrl(previousUrl, providerKind, providerHomeUrl);
}

async function waitForAISessionUrl(tabId, providerKind, providerHomeUrl, timeoutMs, excludedUrls) {
  const exclusions = new Set((Array.isArray(excludedUrls) ? excludedUrls : [excludedUrls])
    .map(url => aiConversationKey(url, providerKind))
    .filter(Boolean));
  let wakePoll = null;
  const onUpdated = (updatedTabId, changeInfo) => {
    // Navigation events only wake the next authoritative tab/location check;
    // their transient URL value is never accepted directly.
    if (updatedTabId === tabId && changeInfo?.url && wakePoll) {
      const wake = wakePoll;
      wakePoll = null;
      wake();
    }
  };
  try { chrome.tabs.onUpdated.addListener(onUpdated); } catch (e) {}
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 60000);
  // Gemini pushes its conversation route optimistically and can re-key it when
  // the server commits the chat, so its identity must hold noticeably longer
  // than ChatGPT's before it counts as durable.
  const requiredStablePolls = providerKind === 'gemini' ? 4 : 2;
  let lastKey = '';
  let lastUrl = '';
  let stablePolls = 0;
  try {
    while (Date.now() < deadline && !runtime.stopRequested) {
      const candidates = await getAISessionUrlCandidates(tabId);
      const canonicalByKey = new Map();
      for (const candidate of candidates) {
        const canonical = canonicalizeAISessionUrl(candidate, providerKind, providerHomeUrl);
        const key = aiConversationKey(canonical, providerKind);
        if (!canonical || !key || exclusions.has(key)) continue;
        canonicalByKey.set(key, canonical);
      }
      // A real conversation identity must remain the sole current identity for
      // consecutive polls. This filters ChatGPT's short-lived optimistic WEB
      // route and Gemini's pre-commit placeholder route.
      if (canonicalByKey.size === 1) {
        const [key, canonical] = canonicalByKey.entries().next().value;
        if (key === lastKey) stablePolls++;
        else { lastKey = key; lastUrl = canonical; stablePolls = 1; }
        if (stablePolls >= requiredStablePolls) return lastUrl;
      } else {
        lastKey = '';
        lastUrl = '';
        stablePolls = 0;
      }
      await swPing();
      await Promise.race([
        sleep(750),
        new Promise(resolve => { wakePoll = resolve; })
      ]);
      wakePoll = null;
    }
    return '';
  } finally {
    wakePoll = null;
    try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch (e) {}
  }
}

// ── Gemini durable-link toolkit ──────────────────────────────────────
// The URL Gemini shows right after send is not proof of a saved chat: the id
// can be re-keyed when the server commits the conversation, and with "Gemini
// Apps Activity" off the chat is never saved at all — the route works only in
// the live tab and dies on the next cold load. Fast Submit therefore
//   1) sniffs the SERVER-assigned conversation id from the StreamGenerate
//      network response (authoritative, immune to URL races),
//   2) waits for the reply to start and the route to settle,
//   3) reopens the link in a throwaway tab and requires the conversation to
//      survive that cold load BEFORE the submit tab is allowed to close.

// MAIN-world: patch fetch/XHR so the c_<hex> conversation id in Gemini's own
// streaming response is stashed on <html data-blogedit-gemini-cid>. Idempotent.
function installGeminiConversationSniffer() {
  if (window.__blogeditGeminiSniffer) return { ok: true, already: true };
  window.__blogeditGeminiSniffer = true;
  const stash = (id) => {
    try {
      const clean = String(id || '').replace(/^c_/i, '').toLowerCase();
      if (/^[0-9a-f]{8,}$/.test(clean)) {
        document.documentElement.setAttribute('data-blogedit-gemini-cid', clean);
      }
    } catch (e) {}
  };
  const scan = (text) => {
    try {
      if (typeof text !== 'string' || !text) return;
      const m = text.match(/\\?"(c_[0-9a-f]{8,})\\?"/i);
      if (m) stash(m[1]);
    } catch (e) {}
  };
  try {
    const origFetch = window.fetch;
    window.fetch = function(...args) {
      const p = origFetch.apply(this, args);
      try {
        const url = String((args[0] && args[0].url) || args[0] || '');
        if (/StreamGenerate|BardFrontendService|assistant\.lamda/i.test(url)) {
          p.then((res) => { try { res.clone().text().then(scan).catch(() => {}); } catch (e) {} }).catch(() => {});
        }
      } catch (e) {}
      return p;
    };
  } catch (e) {}
  try {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__blogeditUrl = String(url || '');
      return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function(...args) {
      try {
        if (/StreamGenerate|BardFrontendService|assistant\.lamda/i.test(this.__blogeditUrl || '')) {
          this.addEventListener('readystatechange', () => {
            try { if (this.readyState >= 3) scan(this.responseText); } catch (e) {}
          });
        }
      } catch (e) {}
      return origSend.apply(this, args);
    };
  } catch (e) {}
  return { ok: true };
}

// ISOLATED world reader — attributes are shared across worlds.
function readGeminiConversationIdAttr() {
  return document.documentElement.getAttribute('data-blogedit-gemini-cid') || '';
}

// Best-effort banner check: with Apps Activity off Gemini warns on-page that
// chats are not saved. Heuristic only — the durability probe is the enforcer.
function detectGeminiActivityOff() {
  try {
    const text = (document.body?.innerText || '').slice(0, 4000).toLowerCase();
    return /(apps?\s+activity[^.\n]{0,60}(off|paused))|chats?\s+aren'?t\s+(?:being\s+)?saved|conversations?\s+(?:aren'?t|are\s+not)\s+(?:being\s+)?saved|chat\s+history\s+is\s+(?:off|turned\s+off)/i.test(text);
  } catch (e) { return false; }
}

// '/u/3' when the tab runs under a multi-login account, else ''.
function geminiAccountPrefixFromUrl(url) {
  try {
    const m = new URL(String(url || '')).pathname.match(/^\/u\/(\d+)\//i);
    return m ? '/u/' + m[1] : '';
  } catch (e) { return ''; }
}

// Read the sniffed server id from the submit tab and turn it into a canonical
// conversation URL under the same account prefix. '' when nothing was sniffed.
async function readGeminiNetworkSessionUrl(tabId, providerHomeUrl) {
  try {
    const cid = String((await runInTab(tabId, readGeminiConversationIdAttr))?.result || '').toLowerCase();
    if (!/^[0-9a-f]{8,}$/.test(cid)) return '';
    const pageUrl = await getSettledAIPageUrl(tabId, providerHomeUrl);
    return 'https://gemini.google.com' + geminiAccountPrefixFromUrl(pageUrl) + '/app/' + cid;
  } catch (e) { return ''; }
}

// Cold-load probe in a throwaway tab: 'durable' when the conversation reopens
// at the same id, 'dead' when Gemini bounces to a new-chat shell (discarded or
// re-keyed id), 'unknown' when the probe itself could not decide (do NOT fail
// a post on 'unknown').
async function verifyGeminiSessionDurable(sessionUrl, tag) {
  const expectedKey = aiConversationKey(sessionUrl, 'gemini');
  if (!expectedKey) return 'dead';
  let probeTab = null;
  try {
    probeTab = await createWorkTab(sessionUrl);
    try { await waitForTabLoad(probeTab.id, 20000); } catch (e) {}
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !runtime.stopRequested) {
      const candidates = await getAISessionUrlCandidates(probeTab.id);
      for (const candidate of candidates) {
        if (aiConversationKey(candidate, 'gemini') === expectedKey) return 'durable';
      }
      const bouncedToNewChat = candidates.some((candidate) => {
        try {
          const u = new URL(candidate);
          return (u.hostname.toLowerCase() === 'gemini.google.com' || u.hostname.toLowerCase() === 'bard.google.com') &&
            /^(?:\/u\/\d+)?\/app\/?$/i.test(u.pathname);
        } catch (e) { return false; }
      });
      if (bouncedToNewChat) {
        log('warn', tag + ' Gemini probe: the saved link bounced to a new-chat page — the conversation was NOT saved server-side.');
        return 'dead';
      }
      await swPing();
      await sleep(1000);
    }
    return 'unknown';
  } catch (e) {
    return 'unknown';
  } finally {
    if (probeTab) { try { await safeCloseTab(probeTab.id); } catch (e) {} }
  }
}

// ══════════════════════════════════════════════════════════════════════
// MINIMIZED-CHROME KEEP-ALIVE
//
// When Chrome is minimized (or the window is fully covered), Chrome marks the
// renderer hidden and applies AGGRESSIVE throttling: timers drop to ~1/minute
// after 5 minutes, requestAnimationFrame stops entirely, and SPAs that render
// streaming replies through rAF simply stop painting. Gemini is hit hardest —
// its reply appears to "work very slowly" or stall completely.
//
// Chrome exempts a page from intensive timer throttling while it is playing
// audio. So this injects, in the page's own world:
//   1) a silent looping WebAudio tone → the tab counts as audible → timers and
//      network callbacks keep running at full speed while minimized,
//   2) a visibility spoof (visibilityState/hidden always report "visible" and
//      visibilitychange is swallowed) so the SPA never enters its paused mode,
//   3) a requestAnimationFrame fallback: when real rAF has not fired for 250ms
//      (frozen because the window is hidden), the callback runs on a timer
//      instead, so streaming DOM updates continue.
// Every part is idempotent and harmless when the window IS visible.
// ══════════════════════════════════════════════════════════════════════
function installTabKeepAlivePage() {
  // keepalive.js (a document_start content script) is the real fix — it is in
  // place BEFORE the provider's own scripts run, which is the only moment at
  // which the visibility spoof and the observer fallbacks can still help a
  // page that is about to boot inside a minimized window. This injected copy
  // remains only as a fallback for a host that script does not cover.
  if (window.__apuKeepAlive) return { ok: true, already: true, viaContentScript: true };
  if (window.__blogeditKeepAlive) return { ok: true, already: true };
  window.__blogeditKeepAlive = true;
  const out = { ok: true, audio: false, visibility: false, raf: false };

  // 1) Silent audio → exempts the tab from intensive background throttling.
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      // Inaudible but non-zero: a hard 0 can be optimised away, and Chrome then
      // stops counting the tab as playing audio.
      gain.gain.value = 0.0001;
      osc.frequency.value = 30;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      window.__blogeditKeepAliveCtx = ctx;
      const resume = () => { try { if (ctx.state === 'suspended') ctx.resume(); } catch (e) {} };
      resume();
      setInterval(resume, 5000);   // autoplay policy can suspend it until a gesture
      out.audio = true;
    }
  } catch (e) {}

  // 2) Visibility spoof — the page must believe it is on screen.
  try {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    Object.defineProperty(document, 'webkitHidden', { configurable: true, get: () => false });
    Object.defineProperty(document, 'webkitVisibilityState', { configurable: true, get: () => 'visible' });
    const swallow = (ev) => { ev.stopImmediatePropagation(); };
    document.addEventListener('visibilitychange', swallow, true);
    document.addEventListener('webkitvisibilitychange', swallow, true);
    window.addEventListener('blur', swallow, true);
    out.visibility = true;
  } catch (e) {}

  // 3) requestAnimationFrame fallback — rAF never fires in a hidden window.
  try {
    const realRaf = window.requestAnimationFrame.bind(window);
    const realCancel = window.cancelAnimationFrame.bind(window);
    // Frames the page explicitly cancelled must NOT be revived by our timer
    // fallback. ProseMirror (ChatGPT's editor) cancels frames constantly, and
    // running a cancelled callback corrupts its view state. Each fallback timer
    // is tracked by frame id and cleared on run or cancel, so the map drains
    // itself and a cancelled frame can never fire.
    const pending = new Map();
    window.requestAnimationFrame = function (cb) {
      let id = 0;
      let done = false;
      const run = (ts) => {
        if (done) return;
        done = true;
        const timer = pending.get(id);
        if (timer) { clearTimeout(timer); pending.delete(id); }
        try { cb(ts !== undefined ? ts : performance.now()); } catch (e) {}
      };
      id = realRaf(run);
      pending.set(id, setTimeout(() => run(performance.now()), 250));
      return id;
    };
    window.cancelAnimationFrame = function (id) {
      const timer = pending.get(id);
      if (timer) { clearTimeout(timer); pending.delete(id); }
      try { realCancel(id); } catch (e) {}
    };
    out.raf = true;
  } catch (e) {}

  return out;
}

// Injected into the page's OWN world (MAIN) — a spoof applied to the isolated
// world would not be visible to the provider's SPA.
async function installAITabKeepAlive(tabId) {
  // 1) The real patch set, from the same file the content script uses. On a
  //    Chrome new enough to honour "world": "MAIN" in the manifest this finds
  //    the work already done and returns immediately; on an older build this
  //    is what actually gets the patches into the page's own world.
  try {
    await new Promise((resolve, reject) => {
      chrome.scripting.executeScript(
        { target: { tabId }, files: ['keepalive.js'], world: 'MAIN' },
        () => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve())
      );
    });
  } catch (e) {}
  // 2) The older, smaller in-line version, in case even that was refused.
  try {
    const r = await runInTabMain(tabId, installTabKeepAlivePage);
    return r?.result || null;
  } catch (e) {
    return null;
  }
}

// Runs in the page's OWN world. Reports whether Chrome has frozen this tab's
// rendering lifecycle and drives one pump of the animation-frame, ResizeObserver
// and IntersectionObserver callbacks the freeze would otherwise swallow.
// The machinery itself lives in keepalive.js.
function pumpRenderLifecyclePage() {
  try {
    if (typeof window.__apuPump !== 'function') return { installed: false, frozen: false, ran: 0 };
    const r = window.__apuPump() || {};
    return { installed: true, frozen: r.frozen === true, ran: r.ran || 0 };
  } catch (e) {
    return { installed: false, frozen: false, ran: 0, error: String((e && e.message) || e) };
  }
}

// Is Chrome throttling this tab — minimized, or a window completely covered?
// The page cannot answer this about itself, because a hidden page's own clock
// is exactly what is broken, and document.hidden is spoofed by keepalive.js.
// So the service worker works it out and passes the answer in.
async function isTabThrottled(tabId) {
  if (!tabId) return false;
  try {
    const health = await pumpFrozenTab(tabId);
    if (health && health.installed) return health.frozen === true;
  } catch (e) {}
  try {
    const t = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(t.windowId);
    return win.state === 'minimized' || (Number(win.width) || 0) < 500;
  } catch (e) {}
  return false;
}

// Called from our own wait loops, which run in the service worker — not a page,
// so never throttled. This is the clock a minimized tab actually runs on.
async function pumpFrozenTab(tabId) {
  if (!tabId) return null;
  try {
    const r = await runInTabMain(tabId, pumpRenderLifecyclePage);
    return r?.result || null;
  } catch (e) {
    return null;
  }
}

// Chrome (and Windows) can sleep the display/system during a long unattended
// batch, which suspends every tab. Held only while a batch is running.
function setKeepAwake(on) {
  try {
    if (!chrome.power) return;
    if (on) chrome.power.requestKeepAwake('system');
    else chrome.power.releaseKeepAwake();
  } catch (e) {}
}

// STRICT model rule: Gemini must run every prompt on "Flash" with "Extended
// thinking" ON (the composer pill reads "Flash Extended"). This page function
// checks the pill, opens the model menu, picks Flash (never Flash-Lite),
// toggles Extended thinking on when it is off, and verifies the pill.
async function ensureGeminiFlashThinkingPage(unthrottle) {
  // Chrome clamps a hidden page's timers to one wake-up per second, and to one
  // per MINUTE after five minutes hidden. postMessage tasks are not throttled,
  // so when the caller tells us this tab is hidden we run the clock off a
  // message loop. Plain setTimeout whenever the window is on screen.
  const wait = (ms) => new Promise((resolve) => {
    if (!unthrottle) { setTimeout(resolve, ms); return; }
    const t0 = performance.now();
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    setTimeout(finish, ms);
    let ch;
    try { ch = new MessageChannel(); } catch (e) { return; }
    ch.port1.onmessage = () => {
      if (done) return;
      if (performance.now() - t0 >= ms) finish();
      else ch.port2.postMessage(0);
    };
    ch.port2.postMessage(0);
  });
  const visible = (el) => { const r = el?.getBoundingClientRect?.(); return !!r && (r.width > 0 && r.height > 0 || (window.innerWidth || 0) < 500 || !document.documentElement?.getBoundingClientRect().width); };
  const textOf = (el) => (((el?.textContent) || '') + ' ' + ((el?.getAttribute?.('aria-label')) || '')).replace(/\s+/g, ' ').trim().toLowerCase();

  function findPill() {
    const bySelector = [...document.querySelectorAll(
      'button[data-test-id*="mode" i], button[class*="mode-switch" i], button[class*="logo-pill" i], button[class*="model" i]'
    )].filter(visible).find((el) => /\b(flash|pro|lite|thinking|extended)\b/.test(textOf(el)));
    if (bySelector) return bySelector;
    return [...document.querySelectorAll('button, [role="button"]')].filter(visible).find((el) => {
      const t = textOf(el);
      return t.length <= 60 && /\b(flash|pro|lite)\b/.test(t) && !/send|stop|microphone|\bmic\b|new chat|settings|\bmenu\b/.test(t);
    }) || null;
  }
  function pillOk() {
    const pill = findPill();
    if (!pill) return false;
    const t = textOf(pill);
    return /flash/.test(t) && !/lite/.test(t) && /(extended|thinking)/.test(t);
  }
  function menuItems() {
    return [...document.querySelectorAll(
      '[role="menuitemradio"], [role="menuitemcheckbox"], [role="menuitem"], [role="option"], button[class*="menu-item" i], [class*="mat-mdc-menu-item" i]'
    )].filter(visible);
  }
  const itemChecked = (el) => el.getAttribute('aria-checked') === 'true' ||
    el.getAttribute('aria-selected') === 'true' ||
    !!el.querySelector('mat-icon[data-mat-icon-name*="check" i], mat-icon[fonticon*="check" i]');

  async function openMenu() {
    if (menuItems().length) return true;
    const pill = findPill();
    if (!pill) return false;
    pill.click();
    for (let i = 0; i < 10; i++) { await wait(300); if (menuItems().length) return true; }
    return false;
  }
  async function closeMenu() {
    try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true })); } catch (e) {}
    const backdrop = document.querySelector('.cdk-overlay-backdrop');
    if (backdrop) { try { backdrop.click(); } catch (e) {} }
    await wait(400);
  }

  if (pillOk()) return { ok: true, already: true, pill: textOf(findPill()) };
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!(await openMenu())) { await wait(600); continue; }
    let items = menuItems();
    // Model row first: "Flash", never "Flash-Lite" (a re-click on an already
    // selected model is harmless, so a missed checkmark cannot hurt).
    const flashItem = items.find((el) => { const t = textOf(el); return /\bflash\b/.test(t) && !/lite/.test(t) && !/extended/.test(t); });
    if (flashItem && !itemChecked(flashItem)) {
      flashItem.click();
      await wait(900);
      if (!(await openMenu())) { await wait(400); await openMenu(); }
      items = menuItems();
    }
    // "Extended thinking" is a TOGGLE — only click it while the pill lacks
    // "Extended", otherwise a click would turn it back off.
    const extendedItem = items.find((el) => /extended/.test(textOf(el)));
    if (extendedItem && !pillOk() && !itemChecked(extendedItem)) {
      extendedItem.click();
      await wait(900);
    }
    await closeMenu();
    for (let i = 0; i < 8; i++) { if (pillOk()) return { ok: true, pill: textOf(findPill()) }; await wait(400); }
  }
  const pill = findPill();
  return { ok: false, error: 'model pill shows "' + (pill ? textOf(pill) : 'not found') + '"', pill: pill ? textOf(pill) : '' };
}

// ── GEMINI MODEL LIMIT ────────────────────────────────────────────────
// Gemini does not show a placeholder when an account runs out of quota — it
// simply REMOVES the good model from the picker. The menu then offers only
// "3.5 Flash-Lite" (and Pro), and Gemini quietly answers on Flash-Lite. Every
// article edited in that state comes back at lower quality, so the run must
// stop the moment the non-Lite Flash entry disappears.
//
// Version numbers move (3.6 today, 3.7 tomorrow), so the rule is by NAME:
// a "Flash" entry that is not "Flash-Lite" must exist and be selectable.
async function detectGeminiModelLimitPage(unthrottle) {
  // Chrome clamps a hidden page's timers to one wake-up per second, and to one
  // per MINUTE after five minutes hidden. postMessage tasks are not throttled,
  // so when the caller tells us this tab is hidden we run the clock off a
  // message loop. Plain setTimeout whenever the window is on screen.
  const wait = (ms) => new Promise((resolve) => {
    if (!unthrottle) { setTimeout(resolve, ms); return; }
    const t0 = performance.now();
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    setTimeout(finish, ms);
    let ch;
    try { ch = new MessageChannel(); } catch (e) { return; }
    ch.port1.onmessage = () => {
      if (done) return;
      if (performance.now() - t0 >= ms) finish();
      else ch.port2.postMessage(0);
    };
    ch.port2.postMessage(0);
  });
  const visible = (el) => { const r = el?.getBoundingClientRect?.(); return !!r && (r.width > 0 && r.height > 0 || (window.innerWidth || 0) < 500 || !document.documentElement?.getBoundingClientRect().width); };
  const textOf = (el) => (((el?.textContent) || '') + ' ' + ((el?.getAttribute?.('aria-label')) || '')).replace(/\s+/g, ' ').trim();
  const isFlashLite = (t) => /flash[\s‑-]*lite/i.test(t);
  const isPlainFlash = (t) => /\bflash\b/i.test(t) && !isFlashLite(t);

  function findPill() {
    const bySelector = [...document.querySelectorAll(
      'button[data-test-id*="mode" i], button[class*="mode-switch" i], button[class*="logo-pill" i], button[class*="model" i]'
    )].filter(visible).find((el) => /\b(flash|pro|lite|thinking|extended)\b/i.test(textOf(el)));
    if (bySelector) return bySelector;
    const byName = [...document.querySelectorAll('button, [role="button"]')].filter(visible).find((el) => {
      const t = textOf(el);
      return t.length <= 60 && /\b(flash|pro|lite)\b/i.test(t) && !/send|stop|microphone|\bmic\b|new chat|settings|\bmenu\b/i.test(t);
    });
    if (byName) return byName;
    // The pill shows something we do not recognise (Google renamed it, or the
    // model was withdrawn). Fall back to the composer's dropdown control so the
    // menu can still be inspected — this is exactly when it matters most.
    return [...document.querySelectorAll('[aria-haspopup="menu"], [aria-haspopup="listbox"], button[aria-expanded]')]
      .filter(visible)
      .find((el) => textOf(el).length <= 60) || null;
  }
  function menuItems() {
    return [...document.querySelectorAll(
      '[role="menuitemradio"], [role="menuitemcheckbox"], [role="menuitem"], [role="option"], button[class*="menu-item" i], [class*="mat-mdc-menu-item" i]'
    )].filter(visible);
  }

  const pill = findPill();
  const pillText = pill ? textOf(pill) : '';
  // The pill itself switched to Flash-Lite → Gemini already downgraded us.
  if (pillText && isFlashLite(pillText)) {
    return { limited: true, reason: 'the model pill switched to Flash-Lite', pill: pillText, checkedMenu: false };
  }
  // Fast path: a healthy "Flash" pill means the good model is active. No menu
  // is opened, so a normal post pays nothing for this check.
  if (pillText && isPlainFlash(pillText)) {
    return { limited: false, reason: '', pill: pillText, checkedMenu: false };
  }
  if (!pill) return { limited: false, reason: '', pill: '', checkedMenu: false, noPill: true };

  // Otherwise inspect what the picker still offers.
  let items = menuItems();
  let opened = false;
  if (!items.length) {
    pill.click();
    opened = true;
    for (let i = 0; i < 10 && !items.length; i++) { await wait(300); items = menuItems(); }
  }
  const labels = items.map(textOf).filter(Boolean);
  const hasFlash = labels.some(isPlainFlash);
  const hasFlashLite = labels.some(isFlashLite);
  if (opened) {
    try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true })); } catch (e) {}
    const backdrop = document.querySelector('.cdk-overlay-backdrop');
    if (backdrop) { try { backdrop.click(); } catch (e) {} }
    await wait(300);
  }
  if (!labels.length) {
    // Could not read the menu at all — say nothing rather than guess.
    return { limited: false, reason: '', pill: pillText, checkedMenu: false, menuUnreadable: true };
  }
  if (!hasFlash && hasFlashLite) {
    return {
      limited: true,
      reason: 'the Flash model is gone from Gemini\'s picker — only Flash-Lite is left',
      pill: pillText,
      checkedMenu: true,
      offered: labels.slice(0, 6).join(' | ').slice(0, 200)
    };
  }
  return { limited: false, reason: '', pill: pillText, checkedMenu: true, offered: labels.slice(0, 6).join(' | ').slice(0, 200) };
}

function geminiFlashGuardOn() {
  return runtime.job?.geminiFlashGuard !== false;   // ON unless explicitly off
}

// Confirms twice before stopping a run: a menu caught mid-render can briefly
// look as if Flash is missing.
async function checkGeminiFlashLimit(tabId, tag) {
  if (!geminiFlashGuardOn()) return null;
  let first = null;
  const hidden = await isTabThrottled(tabId);
  try { first = (await runInTab(tabId, detectGeminiModelLimitPage, [hidden]))?.result; } catch (e) { return null; }
  // Inspecting the picker may have opened its overlay — never leave it over
  // the composer, whatever the verdict is.
  if (first && first.checkedMenu) await closeGeminiOverlays(tabId);
  if (!first || !first.limited) return null;
  log('warn', (tag ? tag + ' ' : '') + '⚠ Gemini looks limited (' + first.reason + ') — re-checking before stopping.');
  await stopSleep(4000);
  if (runtime.stopRequested) return null;
  let second = null;
  try { second = (await runInTab(tabId, detectGeminiModelLimitPage, [hidden]))?.result; } catch (e) { return null; }
  if (second && second.limited) return second;
  return null;
}

// Runs the page-side selector with retries. Throws GEMINI_MODEL_NOT_SET when
// the pill cannot be verified — callers must NOT send the prompt in that case.
async function enforceGeminiFlashThinking(tabId, tag) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    throwIfStopped();
    const hidden = await isTabThrottled(tabId);
    try { last = (await runInTab(tabId, ensureGeminiFlashThinkingPage, [hidden]))?.result || null; }
    catch (e) { last = { ok: false, error: e.message || String(e) }; }
    if (last?.ok) {
      log(last.already ? 'info' : 'ok', tag + ' Gemini model check ✓ Flash + Extended thinking' + (last.already ? ' (already selected).' : ' selected.'));
      // The picker's overlay must not be left covering the composer.
      const overlay = await closeGeminiOverlays(tabId);
      if (overlay && overlay.stillOpen) {
        log('warn', tag + ' A Gemini menu overlay is still open after the model check — the paste will clear it.');
      }
      return;
    }
    await stopSleep(2000);
  }
  throwIfStopped();
  const err = new Error('STRICT model rule: could not set Gemini to "Flash + Extended thinking" (' + (last?.error || 'model selector not found') + '). The prompt was NOT sent. Set the model manually in the Gemini tab, then Resume/retry.');
  err.code = 'GEMINI_MODEL_NOT_SET';
  throw err;
}

// Gemini renders its model menu in a CDK overlay that sits ON TOP of the
// composer. If it is still open when the paste starts, every composer selector
// misses ("Visible AI input box not found") or the text lands in the wrong
// element. Always close overlays after touching the model picker.
function closeGeminiOverlaysPage() {
  let closed = 0;
  try {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true }));
  } catch (e) {}
  try {
    document.querySelectorAll('.cdk-overlay-backdrop').forEach((el) => {
      const r = el.getBoundingClientRect();
      if ((r.width > 0 && r.height > 0 || (window.innerWidth || 0) < 500 || !document.documentElement?.getBoundingClientRect().width)) { try { el.click(); closed++; } catch (e) {} }
    });
  } catch (e) {}
  let stillOpen = 0;
  try {
    stillOpen = [...document.querySelectorAll('[role="menu"], [role="listbox"], .cdk-overlay-pane')]
      .filter((el) => { const r = el.getBoundingClientRect(); return (r.width > 0 && r.height > 0 || (window.innerWidth || 0) < 500 || !document.documentElement?.getBoundingClientRect().width); }).length;
  } catch (e) {}
  return { closed, stillOpen };
}

async function closeGeminiOverlays(tabId) {
  try { return (await runInTab(tabId, closeGeminiOverlaysPage))?.result || null; }
  catch (e) { return null; }
}

// Graceful abort: clicking Gemini's own Stop button COMMITS the partial reply
// (unlike killing the tab, which discards the whole first-turn conversation).
function clickGeminiStopButton() {
  const selectors = ['button[data-testid="stop-button"]', 'button[aria-label*="stop" i]', 'button[title*="stop" i]'];
  for (const selector of selectors) {
    for (const btn of document.querySelectorAll(selector)) {
      const r = btn.getBoundingClientRect();
      if ((r.width > 0 && r.height > 0 || (window.innerWidth || 0) < 500 || !document.documentElement?.getBoundingClientRect().width) && !btn.disabled) { btn.click(); return { clicked: true }; }
    }
  }
  return { clicked: false };
}

// ── Gemini finishing pool ────────────────────────────────────────────
// Fast Submit cannot fire-and-forget on Gemini: the reply streams over the
// submit tab's own connection, and Google discards a conversation whose first
// reply never finished. So Gemini submit tabs stay OPEN in this pool while the
// next posts are being submitted, and each tab closes only after its reply
// completes AND its link survives a cold reload. Pool items:
//   { tabId, entry, tag, addedAt, streak, holdCapMs }
// The pool lives in runFastSubmitPass only (an MV3 service-worker restart
// loses it; orphan-tab cleanup collects any leaked tabs).
async function geminiPoolSweep(pool, job, opts) {
  const options = opts || {};
  for (let idx = pool.length - 1; idx >= 0; idx--) {
    const item = pool[idx];
    if (options.force) {
      try { await safeCloseTab(item.tabId); } catch (e) {}
      pool.splice(idx, 1);
      continue;
    }
    let tabAlive = true;
    try { await chrome.tabs.get(item.tabId); } catch (e) { tabAlive = false; }
    let finished = false;
    if (!tabAlive) {
      finished = true;   // can only verify the link as-is now
    } else if (options.finalize || (Date.now() - item.addedAt) > item.holdCapMs) {
      if (!options.finalize) {
        // Held past the cap and possibly still generating: use Gemini's own
        // Stop control so the partial reply is committed instead of discarded.
        log('warn', item.tag + ' Gemini reply exceeded the hold cap — pressing Stop so the chat is committed, then verifying.');
        try { await runInTab(item.tabId, clickGeminiStopButton); await sleep(3000); } catch (e) {}
      }
      finished = true;
    } else {
      try {
        const p = (await runInTab(item.tabId, probeAISend, ['gemini']))?.result;
        if (p && p.assistantCount > 0 && p.generating !== true) item.streak = (item.streak || 0) + 1;
        else item.streak = 0;
      } catch (e) { item.streak = 0; }
      finished = (item.streak || 0) >= 2;
    }
    if (!finished) continue;

    // SMOOTHNESS: the cold-load probe opens and closes an extra tab per post.
    // It exists to catch "Gemini Apps Activity is off", which is an ACCOUNT
    // setting — once a few links have proven durable, the account is known to
    // save chats and the probe is pure overhead. Verify the first 3, then spot
    // check every 10th; any dead link puts full verification back on.
    const verified = Number(runtime.geminiVerifiedLinks) || 0;
    const trustAccount = verified >= 3 && !(Number(runtime.geminiDeadLinks) || 0);
    const spotCheck = trustAccount && (verified % 10 === 0);
    let verdict;
    if (trustAccount && !spotCheck) {
      verdict = 'trusted';
      log('info', item.tag + ' Gemini reply finished — link accepted without a reload probe (this account has already proven it saves chats).');
    } else {
      verdict = await verifyGeminiSessionDurable(item.entry.sessionUrl, item.tag);
    }
    if (verdict === 'dead' && tabAlive && !runtime.stopRequested) {
      const deadKey = aiConversationKey(item.entry.sessionUrl, 'gemini');
      let rescueUrl = await readGeminiNetworkSessionUrl(item.tabId, job.aiUrl);
      if (!rescueUrl || aiConversationKey(rescueUrl, 'gemini') === deadKey) {
        const settled = await getSettledAIPageUrl(item.tabId, job.aiUrl);
        const canonical = canonicalizeAISessionUrl(settled, 'gemini', job.aiUrl);
        rescueUrl = (canonical && aiConversationKey(canonical, 'gemini') !== deadKey) ? canonical : '';
      }
      if (rescueUrl) {
        log('warn', item.tag + ' Saved Gemini link was dead after the reply finished — probing the re-keyed link: ' + rescueUrl);
        if (await verifyGeminiSessionDurable(rescueUrl, item.tag) === 'durable') {
          item.entry.sessionUrl = rescueUrl;
          verdict = 'durable';
        }
      }
    }
    if (verdict === 'dead') {
      item.entry.status = 'failed';
      runtime.successes = Math.max(0, runtime.successes - 1);
      runtime.geminiDeadLinks = (runtime.geminiDeadLinks || 0) + 1;
      const message = 'Fast submit failed — the finished Gemini chat DIED on a cold reload, so Google is not saving conversations for this account. Turn ON "Gemini Apps Activity" at myactivity.google.com/product/gemini, then use "Retry new".';
      runtime.failures.push({ slug: item.entry.slug, time: new Date().toLocaleTimeString(), message, note: '' });
      runtime.failures = runtime.failures.slice(-50);
      rememberAttempt(item.entry.rawSlug, item.entry.slug, 'failed', message, {
        postUrl: item.entry.postUrl || '',
        aiProviderUrl: job.aiUrl || '',
        aiSessionUrl: '',
        aiName: job.aiName || ''
      });
      // ONE dead link fails only this post — the queue keeps moving. TWO dead
      // links in the same run is systemic (Apps Activity off): every later
      // post would die the same way. Whether that pauses — and whether it
      // retries itself later — follows the same user policy as any other
      // repeated failure, so "Never stop" really does keep going.
      if (runtime.geminiDeadLinks >= 2 && failStopCountOf() && !runtime.paused && !runtime.stopRequested) {
        if (tabAlive) runtime.rescueTabId = item.tabId || null;
        runtime.consecFails = Math.max(Number(runtime.consecFails) || 0, effectiveFailThreshold());
        await pauseForRepeatedFailures('Fast Submit',
          runtime.geminiDeadLinks + ' finished Gemini chats vanished on reload — Google is NOT saving these conversations. Turn ON "Gemini Apps Activity" (myactivity.google.com/product/gemini) for the account in the open Gemini tab');
        pool.splice(idx, 1);   // this tab intentionally left open for review
        continue;
      }
      try { await safeCloseTab(item.tabId); } catch (e) {}
      pool.splice(idx, 1);
      continue;
    }
    if (verdict === 'durable') {
      runtime.geminiVerifiedLinks = (Number(runtime.geminiVerifiedLinks) || 0) + 1;
      log('ok', item.tag + ' Gemini reply finished and the link survived a cold reload — closing its tab.');
    } else if (verdict === 'trusted') {
      runtime.geminiVerifiedLinks = (Number(runtime.geminiVerifiedLinks) || 0) + 1;
    } else {
      log('warn', item.tag + ' Gemini durability probe was inconclusive after the reply finished — keeping the link and closing the tab.');
    }
    try { await safeCloseTab(item.tabId); } catch (e) {}
    pool.splice(idx, 1);
  }
}

async function geminiPoolWaitForSlot(pool, job, maxOpen) {
  while (pool.length >= maxOpen && !runtime.stopRequested) {
    setStatus('🕒 ' + pool.length + ' Gemini repl(ies) still finishing — waiting for a free tab before the next submit...');
    await geminiPoolSweep(pool, job, {});
    if (pool.length < maxOpen) break;
    await swPing();
    await sleep(4000);
  }
}

async function geminiPoolDrain(pool, job) {
  if (!pool.length) return;
  if (runtime.stopRequested) {
    await geminiPoolSweep(pool, job, { force: true });
    return;
  }
  log('step', '🕒 All prompts sent. Waiting for ' + pool.length + ' Gemini repl(ies) to finish before closing their tabs — closing early would make Gemini discard those chats.');
  const deadline = Date.now() + Math.max(180, Number(job.aiTimeout) || 180) * 1000 + 120000;
  while (pool.length && Date.now() < deadline && !runtime.stopRequested) {
    setStatus('🕒 ' + pool.length + ' Gemini repl(ies) still finishing — their tabs close automatically when done.');
    await geminiPoolSweep(pool, job, {});
    if (!pool.length) break;
    await swPing();
    await sleep(4000);
  }
  if (pool.length) {
    await geminiPoolSweep(pool, job, runtime.stopRequested ? { force: true } : { finalize: true });
  }
}

// Settle pass: wait for the reply to start, then reconcile URL id vs sniffed
// network id (network wins), preferring the newest valid route.
async function confirmGeminiSessionUrl(tabId, capturedUrl, providerHomeUrl, excludedUrls, tag) {
  let confirmed = capturedUrl;
  const exclusions = new Set((Array.isArray(excludedUrls) ? excludedUrls : [])
    .map(url => aiConversationKey(url, 'gemini'))
    .filter(Boolean));
  // The pool waits for the reply to FINISH later, so this only needs to see the
  // reply BEGIN (the moment the conversation exists server-side). 15s is enough
  // for that; a longer wait here just slowed every post down.
  const replyDeadline = Date.now() + 15000;
  let replyStarted = false;
  while (Date.now() < replyDeadline && !runtime.stopRequested) {
    try {
      const p = (await runInTab(tabId, probeAISend, ['gemini']))?.result;
      if (p && (p.assistantCount > 0 || p.generating === true)) { replyStarted = true; break; }
    } catch (e) {}
    await swPing();
    await sleep(800);
  }
  if (!replyStarted && !runtime.stopRequested) {
    log('info', tag + ' Gemini had not started replying yet — the tab stays open in the pipeline, so this is checked again when the reply finishes.');
  }
  await sleep(1500);
  for (let check = 0; check < 2 && !runtime.stopRequested; check++) {
    const candidates = await getAISessionUrlCandidates(tabId);
    for (const candidate of candidates) {
      const canonical = canonicalizeAISessionUrl(candidate, 'gemini', providerHomeUrl);
      const key = aiConversationKey(canonical, 'gemini');
      if (!canonical || !key || exclusions.has(key)) continue;
      if (aiConversationKey(confirmed, 'gemini') !== key) {
        log('warn', tag + ' Gemini re-keyed the conversation after send — saving the settled link instead: ' + canonical);
      }
      confirmed = canonical;
    }
    await sleep(1500);
  }
  // The id Gemini's own server response carried outranks whatever the address
  // bar showed. A mismatch here is exactly the "saved wrong url" failure.
  const networkUrl = await readGeminiNetworkSessionUrl(tabId, providerHomeUrl);
  if (networkUrl) {
    const networkKey = aiConversationKey(networkUrl, 'gemini');
    if (networkKey && !exclusions.has(networkKey) && aiConversationKey(confirmed, 'gemini') !== networkKey) {
      log('warn', tag + ' Gemini network response carried a different conversation id — trusting the server id: ' + networkUrl);
      confirmed = networkUrl;
    }
  }
  return confirmed;
}

async function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = async () => {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === 'complete') return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error('Tab load timeout'));
        setTimeout(check, 500);
      } catch (e) { reject(e); }
    };
    check();
  });
}

async function runInTab(tabId, func, args) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({
      target: { tabId },
      func: func,
      args: args || []
    }, (results) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      resolve(results?.[0]);
    });
  });
}

// Inject into the page's OWN world so we can intercept the site's clipboard write.
async function runInTabMain(tabId, func, args) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({
      target: { tabId },
      func: func,
      args: args || [],
      world: 'MAIN'
    }, (results) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(results?.[0]);
    });
  });
}

// Last-ditch recovery: many AI sites (Grok especially) keep the FULL code in memory
// and only render part of it. Clicking their "Copy" button copies the whole thing —
// we intercept that write and read the complete article, even from a virtualised box.
// Briefly focus the worker window so page-context clipboard writes/reads
// succeed (Chrome blocks clipboard for fully-unfocused tabs), then restore
// focus to the user's window. No-op outside background mode.
async function withWorkerFocus(fn) {
  let needRestore = false;
  try {
    if (isBackgroundMode() && runtime.workerWindowId) {
      try { await chrome.windows.update(runtime.workerWindowId, { focused: true }); await sleep(250); needRestore = true; } catch (e) {}
    }
    return await fn();
  } finally {
    if (needRestore && runtime.panelWindowId) {
      try { await focusPanelIfVisible(); } catch (e) {}
    }
  }
}

// v3.46.0: one copy capture, capped in time. A page that never answers (a
// clipboard permission prompt nobody clicks, a hung renderer) must not hold
// the post: after COPY_CAPTURE_TIMEOUT_MS the capture yields null and the
// caller carries on with the on-screen text.
const COPY_CAPTURE_TIMEOUT_MS = 20000;
function copyCaptureWithTimeout(tabId, providerKind, strictCodeOnly) {
  return withWorkerFocus(() => {
    let timer = null;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), COPY_CAPTURE_TIMEOUT_MS); });
    return Promise.race([
      runInTabMain(tabId, captureCopyButtonText, [providerKind || '', true, strictCodeOnly]),
      timeout
    ]).finally(() => clearTimeout(timer));
  });
}

async function tryCopyButtonExtract(tabId, originalHtml, promptText, strictMode, providerKind, allowAnyCode) {
  try {
    const compOpts = allowAnyCode ? null : completenessOptions();
    for (const strictCodeOnly of [true, false]) {
      const r = await copyCaptureWithTimeout(tabId, providerKind, strictCodeOnly);
      const copied = htmlFromCopyCapture((r && r.result) || '');
      if (!copied || copied.length < 300) continue;
      const verify = allowAnyCode
        ? verifyRecoverableHtml(copied, promptText)
        : verifyHtml(copied, originalHtml, promptText, strictMode);
      if (!verify.ok) continue;
      if (compOpts && !assessReplyCompleteness(copied, originalHtml, compOpts).complete) continue;
      return copied;
    }
    return '';
  } catch (e) {
    return '';
  }
}

// Ungated capture: returns whatever the page's copy mechanism yields, with the
// largest fenced block extracted. Callers verify/stitch it themselves.
async function tryCopyRaw(tabId, providerKind) {
  let best = '';
  try {
    for (const strictCodeOnly of [true, false]) {
      const r = await copyCaptureWithTimeout(tabId, providerKind, strictCodeOnly);
      const html = htmlFromCopyCapture((r && r.result) || '');
      if (html && html.length > best.length) best = html;
    }
  } catch (e) {
  }
  return best;
}

function htmlFromCopyCapture(text) {
  return trimToHtmlStart(extractHtmlFromAIText(decodeEntityWrappedCode(text || '')));
}

// Some copy paths hand us the HTML FLAVOUR of the code: entity-encoded tags
// (&#x3C;p&#x3E;) wrapped in <pre><code>. Detect and decode it back to real HTML.
function decodeEntityWrappedCode(text) {
  let t = String(text || '');
  const wrap = t.match(/^\s*<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>\s*$/i);
  if (wrap) t = wrap[1];
  const encoded = (t.match(/&#x3c;|&lt;/gi) || []).length;
  const real = (t.match(/<[a-z!\/]/gi) || []).length;
  if (encoded > 5 && encoded > real * 3) {
    t = t
      .replace(/&#x3c;/gi, '<')
      .replace(/&#x3e;/gi, '>')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&amp;/g, '&');
  }
  return t;
}

// If a message-level copy grabbed chat prose before the document (e.g. an audit
// report above the code), cut everything before the real document start.
function trimToHtmlStart(text) {
  // Articles here are body fragments (no <html>), and a message-level copy may
  // include the audit report before the article. cleanExtractedArticle cuts to
  // the "FIXED ARTICLE" divider and the first real HTML tag, so it trims both.
  return cleanExtractedArticle(text);
}

// ──────────────────────────────────────────────────────────────────────
// Process a single slug (one attempt)
// ──────────────────────────────────────────────────────────────────────
async function prepareProviderForEditing(tabId, providerKind, allowWebSearch) {
  // Turn OFF web search / research / browse before pasting for EVERY provider.
  // When ChatGPT (and others) browse, they "fact-check" affiliate roundups and
  // gut them -- removing tables, product scores, images, and products -- which
  // then fails the completeness check. Editing must stay offline.
  // v3.46.0: a prompt marked "Allow AI web search" keeps plain search / web /
  // browse toggles as they are; deep research / agent modes still go OFF.
  try {
    return (await runInTab(tabId, prepareAIProviderPage, [providerKind, allowWebSearch === true]))?.result || { changed: 0 };
  } catch (e) {
    return { changed: 0, error: e.message || String(e) };
  }
}

function siteUsesDirectRest(site) {
  return site?.updateMode === 'rest' && !!site.wpUsername && !!site.wpAppPassword;
}

function normalizeAppPassword(password) {
  return String(password || '').replace(/\s+/g, '');
}

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function wpAuthHeaders(site) {
  if (!site?.wpUsername || !site?.wpAppPassword) return {};
  return {
    Authorization: 'Basic ' + base64Utf8(site.wpUsername + ':' + normalizeAppPassword(site.wpAppPassword))
  };
}

// Which fetch strategy works for the current site. Once the in-tab bridge is
// needed, all later REST calls in the batch use it directly (no wasted 403s).
let wpFetchMode = { origin: '', mode: 'direct' };

// Turn a WAF/security-plugin HTML error page into a short, useful message
// instead of dumping raw <!DOCTYPE html> into the failure list.
function friendlyRestError(status, data, rawText) {
  let detail = data?.message || '';
  if (!detail && rawText) {
    const m = String(rawText).match(/<title[^>]*>([^<]{1,120})<\/title>/i);
    detail = m ? m[1].trim() : String(rawText).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
  }
  let hint = '';
  if (status === 403) hint = " — the site's firewall or a security plugin (Cloudflare, Wordfence, etc.) blocked the request. If this keeps happening, open the site once in a normal tab and complete any human-verification, then Retry.";
  else if (status === 429) hint = ' — the site is rate-limiting; increase the delay between posts.';
  else if (status === 401) hint = ' — check the WordPress username and Application Password.';
  return 'REST API ' + status + (detail ? ': ' + detail : '') + hint;
}

async function wpFetchJson(siteUrl, path, site, options) {
  const opts = options || {};
  const origin = safeOrigin(siteUrl);
  if (wpFetchMode.origin !== origin) wpFetchMode = { origin, mode: 'direct' };

  // Site already known to need the browser-tab bridge — go straight there.
  if (wpFetchMode.mode === 'bridge') {
    return await wpFetchJsonViaBridge(siteUrl, path, site, opts);
  }

  const headers = Object.assign(
    { Accept: 'application/json' },
    wpAuthHeaders(site),
    opts.headers || {}
  );
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';

  let response = null;
  let netErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      response = await fetch(siteUrl + path, Object.assign({}, opts, {
        headers,
        credentials: 'omit'
      }));
      netErr = '';
      // Firewall block / rate limit: wait and retry once or twice before escalating.
      if ((response.status === 403 || response.status === 429 || response.status === 503) && attempt < 3) {
        await sleep(4000 * attempt);
        continue;
      }
      break;
    } catch (e) {
      netErr = (e && e.message) ? e.message : String(e);
      if (attempt < 3) await sleep(1200 * attempt);   // transient blip
    }
  }

  // ULTIMATE FALLBACK: the direct request was refused (typical for Cloudflare /
  // Wordfence / WAF setups that 403 cookie-less extension traffic) — route the
  // SAME request through a real tab on the site, which has the browser's
  // cookies, fingerprint and referer, exactly like the user browsing normally.
  const blockedStatus = response && [401, 403, 429, 503].includes(response.status);
  if (!response || blockedStatus) {
    try {
      const bridged = await wpFetchJsonViaBridge(siteUrl, path, site, opts);
      if (wpFetchMode.mode !== 'bridge') {
        wpFetchMode.mode = 'bridge';
        log('info', 'Direct REST requests are blocked by ' + origin + (response ? ' (HTTP ' + response.status + ')' : ' (' + netErr + ')') + ' — switched to browser-tab mode for the rest of the batch.');
      }
      return bridged;
    } catch (bridgeErr) {
      if (!response) {
        throw new Error(
          'could not reach the REST API (' + netErr + '). Open ' + siteUrl +
          '/wp-json/wp/v2/posts in your browser to test it. A "Failed to fetch" usually means the site is blocking REST API requests (a security plugin such as Wordfence/iThemes, Cloudflare bot protection, or a firewall), the site is temporarily down or rate-limiting rapid requests (try a longer delay between posts), or the site URL/protocol in Settings is wrong. Browser-tab fallback also failed: ' + (bridgeErr?.message || bridgeErr)
        );
      }
      // fall through and report the original blocked response below
    }
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (e) {}
  }
  if (!response.ok) {
    throw new Error(friendlyRestError(response.status, data, text));
  }
  return data;
}

// ── Browser-tab REST bridge ─────────────────────────────────────────────
async function ensureWpBridgeTab(siteUrl) {
  if (runtime.bridgeTabId && (await tabExists(runtime.bridgeTabId))) return runtime.bridgeTabId;
  let tab = null;
  if (isBackgroundMode()) {
    tab = await createWorkTab(siteUrl + '/');
  } else {
    // Foreground mode: open it quietly behind the current tab.
    tab = await chrome.tabs.create({ url: siteUrl + '/', active: false });
    if (tab?.id) {
      runtime.trackedTabs.push(tab.id);
      if (runtime.trackedTabs.length > 20) runtime.trackedTabs = runtime.trackedTabs.slice(-20);
    }
  }
  if (!tab?.id) throw new Error('Could not open a tab on the WordPress site.');
  runtime.bridgeTabId = tab.id;
  await persistRuntime();
  try { await waitForTabLoad(tab.id, 45000); } catch (e) {}
  await sleep(2500); // let a JS firewall challenge clear
  log('info', 'Opened a background tab on the site to route REST requests through the browser (passes firewalls that block extensions).');
  return tab.id;
}

async function closeWpBridgeTab() {
  const id = runtime.bridgeTabId;
  runtime.bridgeTabId = null;
  if (id) { try { await safeCloseTab(id); } catch (e) {} }
}

async function wpFetchJsonViaBridge(siteUrl, path, site, opts) {
  const tabId = await ensureWpBridgeTab(siteUrl);
  const headers = Object.assign({ Accept: 'application/json' }, (opts && opts.headers) || {});
  if (opts && opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const auth = wpAuthHeaders(site);
  const payload = {
    url: siteUrl + path,
    method: (opts && opts.method) || 'GET',
    body: (opts && opts.body) || null,
    headers,
    authHeader: auth.Authorization || '',
    ajaxUrl: siteUrl + '/wp-admin/admin-ajax.php?action=rest-nonce'
  };
  let r = null;
  try {
    r = (await runInTab(tabId, pageWpFetch, [payload]))?.result || null;
  } catch (e) {
    // The tab may have navigated or been challenged — reload once and retry.
    try {
      await chrome.tabs.reload(tabId);
      await waitForTabLoad(tabId, 30000);
      await sleep(2000);
    } catch (e2) {}
    // BUG FIX: this retry was unwrapped - a second injection failure threw a
    // raw "Cannot access contents of the page" error instead of a clear one.
    try {
      r = (await runInTab(tabId, pageWpFetch, [payload]))?.result || null;
    } catch (e3) {
      throw new Error('Browser-tab REST request failed even after reloading the site tab (' + (e3?.message || e3) + '). The site may be showing a challenge page - open ' + siteUrl + ' once in a normal tab, then Retry.');
    }
  }
  if (!r) throw new Error('Browser-tab REST request returned nothing.');
  if (r.error && !r.status) throw new Error('Browser-tab REST request failed: ' + r.error);
  let data = null;
  if (r.text) { try { data = JSON.parse(r.text); } catch (e) {} }
  if (!r.ok) throw new Error(friendlyRestError(r.status, data, r.text));
  return data;
}

// Runs INSIDE a page on the WordPress site (same-origin). Tries, in order:
//   1) Application Password auth without cookies (no nonce conflicts)
//   2) The logged-in cookie session + a fresh REST nonce (passes cookie-WAFs;
//      works when the user is logged into wp-admin in this browser)
//   3) Cookies + Application Password (cookie-WAF sites with no wp-admin login)
async function pageWpFetch(req) {
  async function doFetch(headers, credentials) {
    const res = await fetch(req.url, {
      method: req.method || 'GET',
      headers: headers,
      body: req.body || undefined,
      credentials: credentials
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text: text };
  }
  try {
    const h1 = Object.assign({}, req.headers || {});
    if (req.authHeader) h1.Authorization = req.authHeader;
    let out = await doFetch(h1, 'omit');
    if (out.ok || [401, 403, 429, 503].indexOf(out.status) === -1) return out;

    try {
      const nres = await fetch(req.ajaxUrl, { credentials: 'include' });
      if (nres.ok) {
        const nonce = (await nres.text()).trim();
        if (nonce && nonce !== '0' && nonce.length >= 8 && nonce.length < 30 && !/[<>\s]/.test(nonce)) {
          const h2 = Object.assign({}, req.headers || {}, { 'X-WP-Nonce': nonce });
          const out2 = await doFetch(h2, 'include');
          if (out2.ok) return out2;
          if (out2.status) out = out2;
        }
      }
    } catch (e) {}

    try {
      const h3 = Object.assign({}, req.headers || {});
      if (req.authHeader) h3.Authorization = req.authHeader;
      const out3 = await doFetch(h3, 'include');
      if (out3.ok) return out3;
      if (out3.status) out = out3;
    } catch (e) {}

    return out;
  } catch (e) {
    return { ok: false, status: 0, text: '', error: (e && e.message) ? e.message : String(e) };
  }
}

async function findWordPressItem(site, siteUrl, slug, useDirectRest) {
  const encodedSlug = encodeURIComponent(slug);
  const typeConfigs = [
    { restType: 'posts', label: 'post' },
    { restType: 'pages', label: 'page' }
  ];

  for (const type of typeConfigs) {
    const fields = useDirectRest
      ? 'id,link,slug,title,content,type,status'
      : 'id,link,slug,title,type,status';
    const paths = useDirectRest
      ? [
          '/wp-json/wp/v2/' + type.restType + '?slug=' + encodedSlug + '&context=edit&_fields=' + fields
        ]
      : [
          '/wp-json/wp/v2/' + type.restType + '?slug=' + encodedSlug + '&_fields=' + fields
        ];

    for (const path of paths) {
      const rows = await wpFetchJson(siteUrl, path, site);
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const exact = rows.find(item => item?.slug === slug) || rows[0];
      return {
        id: exact.id,
        link: exact.link || '',
        restType: type.restType,
        label: type.label,
        title: (exact.title && (exact.title.raw || exact.title.rendered)) || '',
        contentRaw: exact.content?.raw || exact.content?.rendered || ''
      };
    }
  }

  return null;
}

// ── wp-admin post-list lookup ───────────────────────────────────────────
// Last-resort lookup for editor-mode sites whose REST API is blocked by a
// firewall even through the bridge: search wp-admin's own post list in the
// logged-in browser session — firewalls practically never block wp-admin for
// the site's admin.
async function findWordPressItemViaAdmin(siteUrl, slug, tag) {
  const tabId = await ensureWpBridgeTab(siteUrl);
  const searchTerm = String(slug || '').replace(/-/g, ' ').trim();
  const targets = [
    { type: 'posts', label: 'post', url: siteUrl + '/wp-admin/edit.php?post_status=all&s=' + encodeURIComponent(searchTerm) },
    { type: 'pages', label: 'page', url: siteUrl + '/wp-admin/edit.php?post_type=page&post_status=all&s=' + encodeURIComponent(searchTerm) }
  ];
  for (const t of targets) {
    try {
      await chrome.tabs.update(tabId, { url: t.url });
      await waitForTabLoad(tabId, 45000);
      await sleep(1500);
      const r = (await runInTab(tabId, parseWpAdminListForSlug, [slug]))?.result || {};
      if (r.error === 'not-logged-in' || r.error === 'not-admin') {
        throw new Error('wp-admin search needs you to be logged into ' + siteUrl + '/wp-admin in this browser. Log in once in a normal tab, then Retry.');
      }
      if (r.id) {
        log('ok', (tag || '') + ' Found ' + t.label + ' ID ' + r.id + ' via wp-admin search (REST API was blocked).');
        return { id: r.id, link: r.link || '', restType: t.type, label: t.label, title: r.title || '', contentRaw: '' };
      }
    } catch (e) {
      if (/needs you to be logged/.test(e?.message || '')) throw e;
      // navigation/parse hiccup — try the next post type
    }
  }
  return null;
}

// Runs in the wp-admin post list. Finds the row whose permalink contains the
// exact slug and returns its post ID.
function parseWpAdminListForSlug(slug) {
  try {
    if (document.querySelector('#loginform, input[name="log"]')) return { error: 'not-logged-in' };
    if (!/\/wp-admin\//.test(location.pathname)) return { error: 'not-admin' };
    const want = String(slug || '').toLowerCase();
    const rows = [].slice.call(document.querySelectorAll('#the-list tr'));
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const idMatch = (row.id || '').match(/post-(\d+)/);
      if (!idMatch) continue;
      const links = [].slice.call(row.querySelectorAll('a'));
      const view = links.find((a) => {
        try {
          const u = new URL(a.href);
          if (u.origin !== location.origin) return false;
          const parts = u.pathname.toLowerCase().split('/').filter(Boolean);
          return parts.indexOf(want) !== -1;
        } catch (e) { return false; }
      });
      if (view) {
        return {
          id: Number(idMatch[1]),
          link: view.href,
          title: ((row.querySelector('.row-title') || {}).textContent || '').trim()
        };
      }
    }
    return { id: 0 };
  } catch (e) {
    return { error: (e && e.message) ? e.message : String(e) };
  }
}

async function updateWordPressItemViaRest(site, siteUrl, item, html) {
  return await wpFetchJson(
    siteUrl,
    '/wp-json/wp/v2/' + item.restType + '/' + item.id,
    site,
    {
      method: 'POST',
      body: JSON.stringify({ content: html })
    }
  );
}

// Save the ORIGINAL article HTML (with title + link) before we overwrite it, so
// a bad edit can always be restored. Kept in storage; downloadable as a ZIP.
// v3.46.0: backups are written one at a time. Parallel slots used to read the
// list at the same moment and each write back its own copy, so all but one
// backup were lost (and the Safety Gate lost its reference original).
let originalBackupChain = Promise.resolve();
function saveOriginalBackup(slug, title, link, html, aiSession) {
  const run = originalBackupChain.then(() => saveOriginalBackupNow(slug, title, link, html, aiSession));
  originalBackupChain = run.catch(() => {});
  return run;
}

async function saveOriginalBackupNow(slug, title, link, html, aiSession) {
  try {
    if (!html || String(html).length < 20) return;
    const data = await chrome.storage.local.get('__originalsBackup');
    let arr = Array.isArray(data.__originalsBackup) ? data.__originalsBackup : [];
    arr.push({
      slug: String(slug || ''),
      title: String(title || slug || ''),
      link: String(link || ''),
      aiSession: String(aiSession || ''),
      sessionId: Number(runtime.sessionId) || 0,
      site: runtime.job?.site?.name || '',
      time: new Date().toISOString(),
      html: String(html)
    });
    if (arr.length > 300) arr = arr.slice(-300);
    // The count is stored separately so the panel can show it without
    // deserializing the whole (potentially many-MB) backup array every poll.
    await chrome.storage.local.set({ __originalsBackup: arr, __originalsBackupCount: arr.length });
    log('info', 'Saved a backup of the original HTML (' + String(html).length + ' chars) before updating.');
  } catch (e) {
    log('warn', 'Could not save original-HTML backup: ' + (e?.message || e));
  }
}

// ══════════════════════════════════════════════════════════════════════
// ORIGINAL HTML FRESH RECOVERY
//
// Rebuilds a post from the ORIGINAL pre-update HTML that was backed up before
// the article was first edited — never from what is on WordPress now, and
// never from the last (bad) AI output. Used when an edit dropped the FAQ or
// Conclusion: re-running against the damaged article can only patch it, while
// re-running against the original rebuilds it properly.
//
// STRICT: if no backup exists the recovery must NOT start. Silently falling
// back to the live article is exactly the mistake this mode exists to avoid.
// ══════════════════════════════════════════════════════════════════════
function freshFromBackupOn() {
  return runtime.job?.freshFromBackup === true;
}

// v3.46.0: does this backup belong to the site the job is running on? Its
// post link is on the site's host, or its site name is the job's site name.
// Two of the user's sites can share a slug; one site's article must never be
// used to rebuild (Fresh Recovery) or to judge (Safety Gate) the other's.
function backupMatchesJobSite(b) {
  const site = (runtime.job && runtime.job.site) || {};
  const siteHost = normalizeGateHost(site.url);
  const siteName = String(site.name || '');
  const linkHost = normalizeGateHost(b && b.link);
  const backupName = String((b && b.site) || '');
  if (!linkHost && !backupName) return true;     // no site recorded (older data): cannot tell
  if (!siteHost && !siteName) return true;       // no site on the job: cannot tell
  if (siteHost && linkHost && linkHost === siteHost) return true;
  return !!(siteName && backupName && backupName === siteName);
}

async function findOriginalBackup(slug, rawSlug) {
  const want = cleanSlug(slug || '');
  const wantRaw = cleanSlug(rawSlug || '');
  let arr = [];
  try {
    const data = await chrome.storage.local.get('__originalsBackup');
    arr = Array.isArray(data.__originalsBackup) ? data.__originalsBackup : [];
  } catch (e) {
    return null;
  }
  // Newest first: the OLDEST entry is the true pre-update original, but later
  // entries were also captured before their own update, so the earliest match
  // is the most "original" HTML we hold for this post.
  const matches = arr.filter((b) => {
    const s = cleanSlug(b?.slug || '');
    return s && (s === want || (wantRaw && s === wantRaw)) && backupMatchesJobSite(b);
  });
  if (!matches.length) return null;
  matches.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
  return matches[0];   // the earliest backup = the original article
}

async function processSlug(slug, num, total, attemptLinks, tryNum, attemptTabs) {
  attemptTabs = attemptTabs || { edit: null, ai: null };
  const site = runtime.job.site;
  const siteUrl = site.url.replace(/\/+$/, '');
  const tag = '[' + num + '/' + total + (tryNum > 0 ? ' try' + (tryNum + 1) : '') + ']';
  attemptLinks.aiName = runtime.job.aiName;
  attemptLinks.aiProviderUrl = attemptLinks.recoverProviderUrl || runtime.job.aiUrl;
  // Safety Gate / Fact-Check results belong to THIS attempt only (v3.46.0).
  attemptLinks.gate = null;
  attemptLinks.factCheck = null;

  // ── 1) Find post via WP REST API ─────────────────────────────────────
  setStatus(tag + ' Looking up "' + slug + '" on ' + site.name);
  const useDirectRest = siteUsesDirectRest(site);
  log('step', tag + ' Step 1: Looking up post via ' + (useDirectRest ? 'authenticated REST API' : 'public REST API'));
  let postId = null;
  let postUrl = '';
  let wpItem = null;
  try {
    wpItem = await findWordPressItem(site, siteUrl, slug, useDirectRest);
  } catch (e) {
    // Editor-mode sites do not need REST at all to proceed — when the lookup
    // is firewalled (403/429 or unreachable), search wp-admin's post list
    // through the logged-in browser session instead.
    const blocked = /REST API (401|403|429|503)|could not reach the REST API/i.test(e?.message || '');
    if (!useDirectRest && blocked) {
      log('warn', tag + ' REST lookup blocked — searching the wp-admin post list instead.');
      setStatus(tag + ' REST blocked — searching wp-admin for "' + slug + '"');
      wpItem = await findWordPressItemViaAdmin(siteUrl, slug, tag);
      if (!wpItem) {
        const err2 = new Error('Post not found for slug "' + slug + '" (REST API is blocked; wp-admin search found no matching row).');
        err2.code = 'POST_NOT_FOUND';
        throw err2;
      }
    } else {
      throw new Error('REST API error: ' + e.message);
    }
  }
  postId = wpItem?.id || null;
  postUrl = wpItem?.link || '';
  if (!postId) {
    const err = new Error('Post not found for slug "' + slug + '"');
    err.code = 'POST_NOT_FOUND';
    throw err;
  }
  log('info', tag + ' Found post ID ' + postId);
  attemptLinks.postUrl = postUrl || siteUrl + '/' + slug.replace(/^\/+|\/+$/g, '') + '/';
  // For the [[POST_TITLE]] prompt token (v3.46.0).
  attemptLinks.postTitle = plainPostTitle(wpItem?.title);

  // ── Original HTML Fresh Recovery ──
  // Resolve the pre-update backup up front and let the normal REST/editor
  // flows below use it as the article source. Everything after this point —
  // AI call, verification, completeness, WordPress update, audit — is the
  // ordinary, already-tested path.
  let freshSourceHtml = '';
  if (freshFromBackupOn()) {
    const backup = await findOriginalBackup(slug, attemptLinks.rawInput);
    freshSourceHtml = String(backup?.html || '').trim();
    if (!freshSourceHtml || freshSourceHtml.length < 30) {
      const err = new Error('Original HTML backup not found for this post — Fresh Recovery was NOT started and nothing on WordPress was changed. This mode never falls back to the current article; use "new session" if you want to re-run against the live post.');
      err.code = 'NO_ORIGINAL_BACKUP';
      throw err;
    }
    log('ok', tag + ' 🗄 Fresh Recovery source = the ORIGINAL backup from ' +
      (backup.time ? new Date(backup.time).toLocaleString() : 'an earlier run') +
      ' (' + freshSourceHtml.length + ' chars). The current WordPress article and the last AI reply are both ignored.');
    setStatus(tag + ' 🗄 Rebuilding from the original HTML backup');
  }

  if (useDirectRest) {
    attemptLinks.editorUrl = siteUrl + '/wp-admin/post.php?post=' + postId + '&action=edit';
    // Fresh Recovery overrides the source with the pre-update backup.
    const originalHtml = freshSourceHtml || String(wpItem?.contentRaw || '').trim();
    if (!originalHtml || originalHtml.length < 30) {
      throw new Error('Authenticated REST lookup found the ' + (wpItem?.label || 'post') + ', but did not return editable content.raw.');
    }
    if (!freshSourceHtml) {
      log('ok', tag + ' Got original HTML through REST API: ' + originalHtml.length + ' chars');
      // Never write a new backup during Fresh Recovery — the stored original
      // must survive untouched (and must not be pushed out by new entries).
      await saveOriginalBackup(slug, wpItem?.title, attemptLinks.postUrl, originalHtml, attemptLinks.aiSessionUrl);
    }

    let aiHtml = await generateHtmlForArticle(tag, num, total, originalHtml, attemptLinks, attemptTabs, 2);

    await sleep((runtime.job.settleTime || 3) * 1000);
    if (attemptTabs.ai) {
      setStatus(tag + ' Closing ' + runtime.job.aiName + ' tab');
      log('step', tag + ' Step 5: Closing AI tab');
      await safeCloseTab(attemptTabs.ai);
      attemptTabs.ai = null;
      await sleep(700);
    }

    // ── Safety Gate + Fact-Check (v3.46.0) — nothing has been written yet.
    // Throws SAFETY_GATE / FACT_CHECK / FACT_CHECK_ERROR; returns the exact
    // HTML to save (marker-free, dead links unwrapped, maybe fix-round HTML).
    aiHtml = await applySafetyPipeline({ slug, tag, num, total, originalHtml, aiHtml, attemptLinks, attemptTabs, wpItem, stepNo: 2 });

    setStatus(tag + ' Updating WordPress directly through REST API');
    log('step', tag + ' Step 6: REST API update for ' + wpItem.restType + '/' + postId);
    const updateResult = await updateWordPressItemViaRest(site, siteUrl, wpItem, aiHtml);
    const returnedHtml = updateResult?.content?.raw || updateResult?.content?.rendered || '';
    if (returnedHtml && returnedHtml.length < aiHtml.length * 0.5) {
      log('warn', tag + ' REST update returned shorter content than expected (' + returnedHtml.length + ' vs ' + aiHtml.length + ' chars)');
    }
    log('ok', tag + ' ✓ POST UPDATED THROUGH REST API (no WordPress editor tab opened)');
    try { if ((runtime.job.promptType || 'audit') === 'audit') { attemptLinks.auditReport = auditSavedArticle(originalHtml, aiHtml); log('info', tag + ' Post-save ' + attemptLinks.auditReport); } } catch (e) {}
    await sleep(800);
    await returnToPanel();
    return;
  }

  // ── 2) Open WP editor ────────────────────────────────────────────────
  const editUrl = siteUrl + '/wp-admin/post.php?post=' + postId + '&action=edit&classic-editor';
  attemptLinks.editorUrl = editUrl;
  setStatus(tag + ' Opening WP editor (post ID ' + postId + ')');
  log('step', tag + ' Step 2: Opening WP editor tab');
  const editTab = await createWorkTab(editUrl);
  attemptTabs.edit = editTab.id;
  await waitForTabLoad(editTab.id, 45000);
  await sleep(2500);

  // ── 3) Switch to HTML / code mode and grab content ───────────────────
  setStatus(tag + ' Switching editor to HTML/Code mode');
  log('step', tag + ' Step 3: Switching to HTML mode');
  await runInTab(editTab.id, switchToCodeMode);
  await sleep(1500);

  setStatus(tag + ' Reading original HTML from editor');
  const grabResult = await runInTab(editTab.id, grabHtmlFromEditor);
  const editorHtml = grabResult?.result?.html;
  if (!editorHtml || editorHtml.length < 30) {
    throw manualReviewError('No HTML found in Classic Editor code box. WordPress tab left open.');
  }
  // Fresh Recovery feeds the AI the pre-update backup instead of what the
  // editor holds now; the editor tab is still needed to write the result back.
  const originalHtml = freshSourceHtml || editorHtml;
  if (!freshSourceHtml) {
    log('ok', tag + ' Got original HTML: ' + editorHtml.length + ' chars');
    await saveOriginalBackup(slug, wpItem?.title, attemptLinks.postUrl, editorHtml, attemptLinks.aiSessionUrl);
  }

  // ── 4-7) Generate the updated HTML via AI ────────────────────────────
  // Routed through generateHtmlForArticle for BOTH web-tab and API mode, so
  // auto-split, ready checks, verification and completeness gating behave the
  // same everywhere (previously web mode here had its own duplicate copy of
  // this flow and silently ignored the auto-split setting).
  let aiHtml = await generateHtmlForArticle(tag, num, total, originalHtml, attemptLinks, attemptTabs, 4);

  // ── 8) Settle, then close AI tab ─────────────────────────────────────
  await sleep((runtime.job.settleTime || 3) * 1000);
  if (attemptTabs.ai) {
    setStatus(tag + ' Closing ' + runtime.job.aiName + ' tab');
    log('step', tag + ' Step 8: Closing AI tab');
    await safeCloseTab(attemptTabs.ai);
    attemptTabs.ai = null;
    await sleep(700);
  }

  // ── 8b) Safety Gate + Fact-Check (v3.46.0) ───────────────────────────
  // Before focusing/pasting, so the editor is never touched by an edit that
  // fails. The paste and the 95% / verifyHtml re-read below use THIS HTML.
  aiHtml = await applySafetyPipeline({ slug, tag, num, total, originalHtml, aiHtml, attemptLinks, attemptTabs, wpItem, stepNo: 4 });

  // ── 9) Focus WP editor tab ───────────────────────────────────────────
  setStatus(tag + ' Switching back to WP editor');
  log('step', tag + ' Step 9: Returning to WP editor');
  await focusTab(editTab.id);
  await sleep(1800);

  // ── 10) Paste new HTML ───────────────────────────────────────────────
  // Stop pressed while the editor tab was being focused: nothing is pasted.
  throwIfStopped();
  setStatus(tag + ' Clearing code box and pasting new HTML');
  log('step', tag + ' Step 10: Pasting new HTML into editor');
  const pasteResult = await runInTab(editTab.id, clearAndPasteHtml, [aiHtml]);
  if (!pasteResult?.result || pasteResult.result.kind === 'none') {
    throw manualReviewError('Failed to find Classic Editor code box for paste.');
  }
  if (!pasteResult.result.matches) {
    throw manualReviewError('Classic Editor paste mismatch (' + pasteResult.result.afterLength + ' of ' + aiHtml.length + ' chars).');
  }
  await sleep(2500);

  // ── 11) Re-verify pasted content ─────────────────────────────────────
  setStatus(tag + ' Verifying pasted content');
  const reread = await runInTab(editTab.id, grabHtmlFromEditor);
  const pastedHtml = reread?.result?.html || '';
  if (pastedHtml.length < aiHtml.length * 0.95) {
    log('err', tag + ' SAFETY: only ' + pastedHtml.length + ' of ' + aiHtml.length + ' chars in editor — NOT clicking UPDATE');
    throw manualReviewError('Paste verification failed: only ' + pastedHtml.length + ' of ' + aiHtml.length + ' chars in editor. UPDATE not clicked.');
  }
  const pastedVerify = runtime.job.recoverAnyCode
    ? verifyRecoverableHtml(pastedHtml, runtime.job.prompt)
    : verifyHtml(pastedHtml, originalHtml, runtime.job.prompt, runtime.job.strictMode);
  if (!pastedVerify.ok) {
    log('err', tag + ' SAFETY: pasted editor content rejected before UPDATE: ' + pastedVerify.reason);
    throw manualReviewError('Pasted WordPress code rejected before UPDATE: ' + pastedVerify.reason + '. UPDATE not clicked.');
  }
  log('ok', tag + ' Paste verified: ' + pastedHtml.length + ' chars in editor');
  await sleep(1500);

  // ── 12) Click UPDATE ─────────────────────────────────────────────────
  setStatus(tag + ' Clicking UPDATE button');
  log('step', tag + ' Step 12: Clicking UPDATE');
  const clickResult = await runInTab(editTab.id, clickUpdateButton);
  if (!clickResult?.result?.clicked) {
    throw manualReviewError(clickResult?.result?.reason || 'Could not find an UPDATE button. WordPress was not submitted.');
  }
  log('info', tag + ' UPDATE clicked (' + clickResult.result.kind + '), waiting for confirmation...');

  // ── 13) Wait for save confirmation ───────────────────────────────────
  const updateWaitMs = (runtime.job.updateWait || 30) * 1000;
  setStatus(tag + ' Waiting up to ' + (updateWaitMs / 1000) + 's for save confirmation');
  const confirmed = await waitForUpdateSuccess(editTab.id, updateWaitMs);
  if (!confirmed) {
    throw manualReviewError('UPDATE did not confirm within ' + (updateWaitMs / 1000) + 's. Check the WordPress tab.');
  }
  log('ok', tag + ' ✓ POST UPDATED ON WORDPRESS');
  try { if ((runtime.job.promptType || 'audit') === 'audit') { attemptLinks.auditReport = auditSavedArticle(originalHtml, aiHtml); log('info', tag + ' Post-save ' + attemptLinks.auditReport); } } catch (e) {}
  await sleep(1500);

  // ── 14) Close editor, return to panel ────────────────────────────────
  setStatus(tag + ' Closing editor and returning to panel');
  log('step', tag + ' Step 14: Cleanup');
  await closeWordPressEditorTabsStrict(editTab.id, siteUrl, postId, tag);
  attemptTabs.edit = null;
  await sleep(500);
  await returnToPanel();
}

// ══════════════════════════════════════════════════════════════════════
// SAFETY GATE + AI FACT-CHECK (v3.46.0)
//
// Nothing bad is ever saved: every AI edit must pass (1) the code Safety Gate
// (safety-gate.js, compared with the TRUE original of this run) and, when on,
// (2) an AI Fact-Check round in a NEW chat — before processSlug writes
// anything to WordPress. applySafetyPipeline is called in BOTH processSlug
// branches right after generation. A failure throws SAFETY_GATE, FACT_CHECK
// or FACT_CHECK_ERROR: the original post stays live and the row lands in the
// Failed box through the normal retry machinery. Gate OFF = none of this runs.
// ══════════════════════════════════════════════════════════════════════
function isSafetyBlockCode(code) {
  return code === 'SAFETY_GATE' || code === 'FACT_CHECK' || code === 'FACT_CHECK_ERROR';
}

// A "Safety Gate prompt": the run prompt asks for the <!-- APU-END --> end
// marker (the prompts written for the gate do). Decides requireEndMarker, the
// gate's rule set and the end-marker exception of the completeness check.
function promptRequiresEndMarker() {
  return String((runtime.job && runtime.job.prompt) || '').indexOf('APU-END') >= 0;
}

// Word-retention minimum for prompts that are NOT Safety Gate prompts: old
// "audit + fix" prompts rewrite more than the gate's own editor prompt (whose
// minimum is the validator default, 75%).
const LEGACY_PROMPT_MIN_RETENTION = 0.6;

// The shared validator object (self.SafetyGate from safety-gate.js), or null
// when the file did not load.
function safetyGateApi() {
  try {
    if (typeof SafetyGate !== 'undefined' && SafetyGate && (typeof SafetyGate === 'object' || typeof SafetyGate === 'function')) return SafetyGate;
  } catch (e) {}
  try {
    if (typeof self !== 'undefined' && self && self.SafetyGate) return self.SafetyGate;
  } catch (e) {}
  return null;
}

// Hostname only, lower case, no scheme / path / port / "www." — '' if unusable.
function normalizeGateHost(value) {
  let h = String(value || '').trim().toLowerCase();
  if (!h) return '';
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  h = h.split(/[\/?#]/)[0];
  const at = h.lastIndexOf('@');
  if (at >= 0) h = h.slice(at + 1);
  h = h.replace(/:\d*$/, '').replace(/\.+$/, '').replace(/^www\d?\./, '');
  return /^[a-z0-9\u00a1-\uffff.-]+$/.test(h) ? h : '';
}

// Internal domains for the gate and [[SITE_DOMAIN]]: the site's own host
// first (always), then the extra domains the panel sent.
function gateSiteDomainsOf() {
  const job = runtime.job || {};
  const out = [];
  const add = (d) => {
    const h = normalizeGateHost(d);
    if (h && out.indexOf(h) === -1) out.push(h);
  };
  add(job.site && job.site.url);
  const extra = Array.isArray(job.gateSiteDomains) ? job.gateSiteDomains : String(job.gateSiteDomains || '').split(/[\s,;]+/);
  extra.forEach(add);
  return out;
}

// WordPress titles arrive HTML-encoded ("Best &#8216;Pro&#8217; Pans").
function plainPostTitle(title) {
  const fromCode = (n) => (n > 0 && n < 0x110000) ? String.fromCodePoint(n) : '';
  return String(title || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => fromCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => fromCode(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function localDateYmd(d) {
  const t = d || new Date();
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
}

// ── Prompt tokens (value substitution only, never rule injection) ─────────
// Only these five exact tokens are replaced. A prompt without tokens comes
// back unchanged. values = { today, siteDomain, webSearch, newFaq, postTitle }.
function substitutePromptTokens(text, values) {
  const s = String(text || '');
  if (s.indexOf('[[') === -1) return s;
  const v = values || {};
  const map = {
    TODAY: v.today,
    SITE_DOMAIN: v.siteDomain,
    WEB_SEARCH: v.webSearch,
    NEW_FAQ: v.newFaq,
    POST_TITLE: v.postTitle
  };
  return s.replace(/\[\[(TODAY|SITE_DOMAIN|WEB_SEARCH|NEW_FAQ|POST_TITLE)\]\]/g, (m, key) => {
    const val = map[key];
    if (val === undefined || val === null) return '';
    if (val === true) return 'yes';
    if (val === false) return 'no';
    return String(val);
  });
}

// Token values for the running job. extra = { postTitle } (optional).
function promptTokenValues(extra) {
  const job = runtime.job || {};
  return {
    today: localDateYmd(),
    siteDomain: gateSiteDomainsOf().join(', '),
    webSearch: job.promptWebSearch === true ? 'yes' : 'no',
    newFaq: job.gateNewFaq === 'no' ? 'no' : 'auto',
    postTitle: (extra && extra.postTitle) ? String(extra.postTitle) : ''
  };
}

// ── Reference original ────────────────────────────────────────────────────
// Retries, audit retries and HTML recovery in the same run read the live post,
// which may already be an AI edit. The gate must compare with the TRUE
// original: the earliest backup taken in THIS run (runtime.sessionId), else
// the fallback (the HTML this attempt read from WordPress / Fresh Recovery).
async function sessionOriginalFor(slug, rawInput, fallbackHtml) {
  const fallback = String(fallbackHtml || '').trim();
  const sid = Number(runtime.sessionId) || 0;
  if (!sid) return fallback;
  const want = cleanSlug(slug || '');
  const wantRaw = cleanSlug(rawInput || '');
  let arr = [];
  try {
    const data = await chrome.storage.local.get('__originalsBackup');
    arr = Array.isArray(data && data.__originalsBackup) ? data.__originalsBackup : [];
  } catch (e) {
    return fallback;
  }
  const matches = arr.filter((b) => {
    if (!b || Number(b.sessionId) !== sid) return false;
    const s = cleanSlug(b.slug || '');
    if (!s || !(s === want || (wantRaw && s === wantRaw))) return false;
    // The site can be switched live during a run: same slug, other site ≠ this post.
    if (!backupMatchesJobSite(b)) return false;
    return String(b.html || '').trim().length >= 30;
  });
  if (!matches.length) return fallback;
  matches.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
  return String(matches[0].html).trim();
}

// True for loopback, private-network, link-local and single-label hosts —
// addresses no reader of a published article can open. hostname = URL.hostname
// (already normalised: "2130706433" / "0x7f.1" arrive as "127.0.0.1").
function isPrivateNetworkHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!h) return true;
  if (h === 'localhost' || /\.(?:localhost|local|internal|lan|home|intranet)$/.test(h)) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.indexOf(':') >= 0) {
    return h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || /^::ffff:/.test(h);
  }
  return h.indexOf('.') < 0;   // "intranet", "router": single-label names
}

// fetch() wrapper for the gate's link check: no cookies, no cache, and a hard
// timeout so one slow site can never hold a post.
// v3.46.0: a NEW link to a loopback / private-network address (the AI can be
// steered by text inside an article) is never requested from the user's
// browser; it fails like an unknown host, so the gate unwraps the link.
function gateFetch(url, init) {
  let host = '';
  try { host = new URL(String(url)).hostname; } catch (e) {}
  if (isPrivateNetworkHost(host)) {
    const blocked = new TypeError('Failed to fetch: ' + (host || 'this address') + ' is a local / private network address (not requested)');
    blocked.code = 'ENOTFOUND';
    return Promise.reject(blocked);
  }
  const opts = Object.assign({}, init || {});
  const controller = (typeof AbortController === 'function') ? new AbortController() : null;
  let timer = null;
  if (controller) {
    const outer = opts.signal;
    if (outer) {
      if (outer.aborted) controller.abort();
      else { try { outer.addEventListener('abort', () => controller.abort()); } catch (e) {} }
    }
    opts.signal = controller.signal;
    timer = setTimeout(() => { try { controller.abort(); } catch (e) {} }, 15000);
  }
  opts.credentials = 'omit';
  opts.cache = 'no-store';
  return fetch(url, opts).then((res) => {
    if (timer) clearTimeout(timer);
    return res;
  }, (e) => {
    if (timer) clearTimeout(timer);
    throw e;
  });
}

// The words "AUDIT ISSUES" classify rows as audit issues in the panel, so
// they must never appear in a gate / fact-check failure message.
function safetyMessageText(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\s+/g, ' ')
    .replace(/AUDIT ISSUES/gi, 'audit problems')
    .trim();
}

function gateIssueCode(item) {
  return (item && typeof item === 'object' && item.code) ? String(item.code) : 'GATE_ERROR';
}
function gateIssueMessage(item) {
  if (item && typeof item === 'object') return safetyMessageText(item.message || item.code || '');
  return safetyMessageText(item);
}
function gateIssueText(item) {
  const msg = gateIssueMessage(item);
  return (item && typeof item === 'object' && item.code) ? item.code + ': ' + msg : msg;
}

// Builds the SAFETY_GATE error and records the reasons on the attempt.
function safetyGateBlockedError(links, codes, messages, warnings, removedLinks) {
  const codeList = [];
  (codes || []).forEach((c) => {
    const k = String(c || '').trim();
    if (k && codeList.indexOf(k) === -1) codeList.push(k);
  });
  if (!codeList.length) codeList.push('GATE_FAILED');
  const msgs = (messages || []).map((m) => safetyMessageText(m).replace(/[.\s]+$/, '')).filter(Boolean);
  const err = manualReviewError('SAFETY GATE BLOCKED: ' + codeList.join(', ') +
    (msgs.length ? ' — ' + msgs.slice(0, 3).join('; ').slice(0, 700) : '') +
    '. The post was NOT changed.');
  err.code = 'SAFETY_GATE';
  // Code + message pairs for the automatic retry's PRIORITY FIX note.
  err.gateReasons = (codes || []).slice(0, 30).map((c, i) => ({
    code: String(c || '').trim() || 'GATE_FAILED',
    message: safetyMessageText((messages || [])[i]).slice(0, 300)
  }));
  if (!err.gateReasons.length) err.gateReasons = codeList.map((c) => ({ code: c, message: '' }));
  if (links) {
    links.gate = {
      codes: codeList,
      messages: msgs.slice(0, 20).map((m) => m.slice(0, 300)),
      warnings: (warnings || []).slice(0, 20).map((w) => safetyMessageText(w).slice(0, 300)),
      removedLinks: (removedLinks || []).slice(0, 20).map((r) => String((r && r.url) || r || '').slice(0, 300))
    };
  }
  return err;
}

// Runs the code Safety Gate on one AI edit. Returns the HTML that must be
// saved (end markers stripped, dead new links unwrapped) or throws SAFETY_GATE.
async function runSafetyGateStep(ctx, referenceHtml, aiHtml, label) {
  const tag = (ctx && ctx.tag) || '';
  const links = (ctx && ctx.attemptLinks) || null;
  const what = label || 'AI';
  const api = safetyGateApi();
  if (!api || typeof api.runSafetyGate !== 'function') {
    log('err', tag + ' 🛡 SAFETY GATE: safety-gate.js not loaded — refusing to save an unchecked edit.');
    throw safetyGateBlockedError(links, ['GATE_NOT_LOADED'], ['safety-gate.js not loaded'], [], []);
  }
  // Rule set per prompt type (v3.46.0): a Safety Gate prompt (it asks for the
  // <!-- APU-END --> end marker) gets every rule. Any other prompt (older audit
  // or affiliate prompts that remove prices or add a "Last updated" line on
  // purpose) gets the structure rules only: no research rules (Last checked /
  // freshness / today's date, new or lost prices, percentages and years, new
  // deep links unwrapped for lack of research) and a lower word-retention
  // minimum. Images, media, tables, links, shortcodes, blocks, lost text,
  // chat text and dead / forbidden / internal links are checked either way.
  const gatePrompt = promptRequiresEndMarker();
  const options = {
    siteDomains: gateSiteDomainsOf(),
    allowNewFaq: runtime.job.gateNewFaq !== 'no',
    webSearchAllowed: runtime.job.promptWebSearch === true,
    researchRules: gatePrompt,
    checkLinks: runtime.job.gateLinkCheck !== false,
    endMarker: 'APU-END',
    // The prompt asks for the end marker => a reply without it was cut off.
    requireEndMarker: gatePrompt,
    fetchFn: gateFetch,
    // v3.46.0: the same local date as [[TODAY]] (today's date added without
    // web research) and the post title (TITLE_IN_BODY) — both checks are off
    // in the validator unless these are given.
    today: localDateYmd(),
    postTitle: (links && links.postTitle) || plainPostTitle(ctx && ctx.wpItem && ctx.wpItem.title)
  };
  // Safety Gate prompts keep the validator's default minimum (75%).
  if (!gatePrompt) options.minRetention = LEGACY_PROMPT_MIN_RETENTION;
  setStatus(tag + ' 🛡 Safety Gate: checking the ' + what + ' edit');
  log('step', tag + ' 🛡 Safety Gate: checking the ' + what + ' edit (' + String(aiHtml || '').length +
    ' chars) against the original (' + String(referenceHtml || '').length + ' chars)' +
    (options.checkLinks ? ', new-link check ON' : '') + '.');
  log('info', tag + ' 🛡 Gate rules: ' + (gatePrompt
    ? 'full rules — Safety Gate prompt.'
    : 'structure rules — this prompt is not a Safety Gate prompt (no <!-- APU-END --> end marker): prices, dates and "Last updated" lines are not checked by code, word-retention minimum ' +
      Math.round(LEGACY_PROMPT_MIN_RETENTION * 100) + '%.'));
  let result = null;
  try {
    result = await api.runSafetyGate(referenceHtml, aiHtml, options);
  } catch (e) {
    const m = (e && e.message) ? e.message : String(e);
    log('err', tag + ' 🛡 Safety Gate crashed: ' + m);
    throw safetyGateBlockedError(links, ['INTERNAL_ERROR'], ['the Safety Gate crashed: ' + m], [], []);
  }
  if (!result || typeof result !== 'object') {
    throw safetyGateBlockedError(links, ['INTERNAL_ERROR'], ['the Safety Gate returned no result'], [], []);
  }
  const errors = Array.isArray(result.errors) ? result.errors : [];
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const removed = Array.isArray(result.removedLinks) ? result.removedLinks : [];
  removed.forEach((r) => {
    log('warn', tag + ' 🛡 Removed link: ' + ((r && r.url) ? r.url : String(r)) + ((r && r.reason) ? ' (' + r.reason + ')' : ''));
  });
  warnings.forEach((w) => log('warn', tag + ' 🛡 Gate warning — ' + gateIssueText(w)));
  // Fail closed: anything but a clean "ok" is a block.
  if (result.ok !== true || errors.length) {
    errors.forEach((e) => log('err', tag + ' 🛡 Gate error — ' + gateIssueText(e)));
    const codes = errors.map(gateIssueCode);
    const messages = errors.map(gateIssueMessage);
    if (!codes.length) { codes.push('GATE_FAILED'); messages.push('the Safety Gate did not approve the edit'); }
    log('err', tag + ' 🛡 SAFETY GATE BLOCKED the ' + what + ' edit — the post is NOT changed.');
    throw safetyGateBlockedError(links, codes, messages, warnings.map(gateIssueText), removed);
  }
  const html = String(result.html || '').trim();
  if (!html) {
    throw safetyGateBlockedError(links, ['INTERNAL_ERROR'], ['the Safety Gate returned empty HTML'], [], []);
  }
  log('ok', tag + ' 🛡 Safety Gate PASSED (' + html.length + ' chars' +
    (removed.length ? ', ' + removed.length + ' link(s) removed' : '') +
    (warnings.length ? ', ' + warnings.length + ' warning(s)' : '') + ').');
  return html;
}

// ── Fact-Check helpers ────────────────────────────────────────────────────
// Payload: both articles first, then the fact-check instructions (tokens
// substituted). extra = { postTitle } (optional).
function buildFactCheckPayload(promptText, originalHtml, editedHtml, extra) {
  const head = (label) => '══════════════════════  ' + label + '  ══════════════════════';
  return head('ORIGINAL ARTICLE HTML START') + '\n\n' +
    String(originalHtml || '').trim() + '\n\n' +
    head('ORIGINAL ARTICLE HTML END') + '\n\n\n' +
    head('EDITED ARTICLE HTML START') + '\n\n' +
    String(editedHtml || '').trim() + '\n\n' +
    head('EDITED ARTICLE HTML END') + '\n\n\n' +
    head('INSTRUCTIONS') + '\n\n' +
    substitutePromptTokens(String(promptText || '').trim(), promptTokenValues(extra));
}

// Index of the '}' that closes the '{' at `open` (string-aware), or -1.
function matchingBraceIndex(s, open) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < s.length; i++) {
    const ch = s.charAt(i);
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Checks one parsed value against the reply contract.
function validateFactCheckObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'the JSON is not an object' };
  const verdict = String(obj.verdict === undefined || obj.verdict === null ? '' : obj.verdict).trim().toLowerCase();
  if (['pass', 'fix', 'reject'].indexOf(verdict) === -1) {
    return { ok: false, error: 'verdict must be pass, fix or reject (got "' + String(obj.verdict === undefined ? '' : obj.verdict).slice(0, 40) + '")' };
  }
  let issues = obj.issues;
  if (issues === undefined || issues === null) issues = [];
  if (!Array.isArray(issues)) return { ok: false, error: '"issues" is not an array' };
  return { ok: true, audit: Object.assign({}, obj, { verdict, issues }) };
}

// v3.46.0: when one reply holds SEVERAL valid verdicts (a draft "pass" then a
// corrected "reject", or a restated example), the most severe one wins
// (reject > fix > pass) — never the first, which would fail open. Ties go to
// the later one (the AI's final word). audits = [{ audit, pos }].
function mostSevereFactCheck(audits) {
  const rank = { pass: 0, fix: 1, reject: 2 };
  let best = null;
  (audits || []).forEach((a) => {
    if (!a || !a.audit) return;
    const r = rank[a.audit.verdict] || 0;
    if (!best || r > best.rank || (r === best.rank && (a.pos || 0) >= best.pos)) best = { audit: a.audit, rank: r, pos: a.pos || 0 };
  });
  return best ? best.audit : null;
}

// Reply text → { ok: true, audit } | { ok: false, error }. Reads ``` code
// blocks, the text itself as JSON (a code block read from the page), and
// every balanced {...} that contains "verdict"; of all valid verdicts the
// most severe wins (mostSevereFactCheck). Smart quotes are NOT repaired (a
// reply that uses them is not valid JSON).
function parseFactCheckReply(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, error: 'empty reply' };
  let lastError = 'no JSON object with a "verdict" was found';
  const found = [];
  const seen = new Set();
  const tryParse = (candidate, pos) => {
    let obj;
    try { obj = JSON.parse(candidate); }
    catch (e) { lastError = 'invalid JSON (' + ((e && e.message) || 'parse error') + ')'; return null; }
    const checked = validateFactCheckObject(obj);
    if (!checked.ok) { lastError = checked.error; return null; }
    const key = JSON.stringify(checked.audit);
    if (!seen.has(key)) { seen.add(key); found.push({ audit: checked.audit, pos }); }
    return checked.audit;
  };
  // 1) Fenced code blocks: ```json … ``` (or a plain ``` fence).
  const fenceRe = /```[ \t]*[A-Za-z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(raw)) !== null) {
    const body = String(m[1] || '').trim();
    if (!body) continue;
    tryParse(body, m.index);
  }
  // 2) The whole text is the JSON (maybe after a bare "json" label line).
  const bare = raw.replace(/^json[ \t]*\r?\n/i, '').trim();
  if (bare.charAt(0) === '{') tryParse(bare, 0);
  // 3) Every balanced {...} that contains "verdict" (prose, rendered code).
  let scanned = 0;
  for (let i = raw.indexOf('{'); i >= 0 && scanned < 400; i = raw.indexOf('{', i + 1)) {
    scanned++;
    const end = matchingBraceIndex(raw, i);
    if (end < 0) continue;
    const candidate = raw.slice(i, end + 1);
    if (candidate.indexOf('"verdict"') === -1) continue;
    tryParse(candidate, i);
    i = end;
  }
  const audit = mostSevereFactCheck(found);
  return audit ? { ok: true, audit } : { ok: false, error: lastError };
}

// audit (parsed reply) → { action: 'pass'|'fix'|'fail', filtered }. Issues whose
// quote is not in the edited article are dropped first (filterAuditIssues).
// The shared filter's effectiveVerdict decides: reject → fail; fix (a HIGH
// issue is left, or a HIGH issue's quote was not found — never downgraded) →
// fix round with filtered.retryIssues; pass → pass (medium/low issues are only
// logged). An explicit "fix" verdict is never a pass: with medium/low issues
// left it is a fix round too, with no usable issue it fails (EXT-SPEC §4).
// Without the filter (or without effectiveVerdict) the conservative
// rule below applies: reject → fail; any HIGH issue, or verdict "fix" with
// issues → fix; otherwise pass. filtered.retryIssues is always an array.
function decideFactCheck(audit, editedHtml, originalHtml) {
  const verdict = String((audit && audit.verdict) || '').trim().toLowerCase();
  const api = safetyGateApi();
  let filtered = null;
  if (api && typeof api.filterAuditIssues === 'function') {
    try {
      filtered = api.filterAuditIssues(editedHtml, audit, originalHtml ? { originalHtml } : {});
    } catch (e) {
      filtered = null;
    }
  }
  if (!filtered) {
    // Without the filter keep EVERY issue (conservative: more blocks, never fewer).
    const raw = (audit && Array.isArray(audit.issues)) ? audit.issues : [];
    filtered = {
      verdict,
      issues: raw.filter((i) => i && typeof i === 'object').map((i) => {
        const sev = String(i.severity || '').trim().toLowerCase();
        return Object.assign({}, i, { severity: (sev === 'medium' || sev === 'low') ? sev : 'high' });
      }),
      dropped: [],
      valid: !!(audit && typeof audit === 'object')
    };
  }
  const kept = Array.isArray(filtered.issues) ? filtered.issues : [];
  const effective = String(filtered.effectiveVerdict || '').trim().toLowerCase();
  let action = 'pass';
  if (filtered.valid === false) action = 'fail';
  else if (['pass', 'fix', 'reject'].indexOf(effective) !== -1) action = (effective === 'reject') ? 'fail' : effective;
  else if (['pass', 'fix', 'reject'].indexOf(verdict) === -1 || verdict === 'reject') action = 'fail';
  else if (kept.some((i) => String((i && i.severity) || '').toLowerCase() === 'high')) action = 'fix';
  else if (verdict === 'fix' && kept.length > 0) action = 'fix';
  // v3.46.0 (EXT-SPEC §4): an explicit "fix" verdict is never turned into a
  // pass. The shared filter passes a "fix" whose remaining issues are only
  // medium / low; here those issues go to the fix round. A "fix" that lists
  // no usable issue at all (none, or entries that are not issue objects) is
  // a contradictory reply and fails closed. Issues dropped only because their
  // quote is not in the edit stay dropped (the anti-hallucination filter).
  if (action === 'pass' && verdict === 'fix') {
    const rawIssues = (audit && Array.isArray(audit.issues)) ? audit.issues : [];
    if (kept.length > 0) action = 'fix';
    else if (!rawIssues.length || rawIssues.some((i) => !i || typeof i !== 'object')) {
      action = 'fail';
      filtered.failReason = 'the fact-checker asked for a fix but listed no usable issue';
    }
  }
  // The issues the fix round must address (the filter's retryIssues include a
  // HIGH issue whose quote was not found); fallback: the kept issues.
  if (!Array.isArray(filtered.retryIssues) || !filtered.retryIssues.length) filtered.retryIssues = kept.slice();
  return { action, filtered };
}

function factIssueText(issue) {
  const clip = (v, max) => safetyMessageText(v).slice(0, max);
  const i = issue || {};
  const sev = String(i.severity || 'high').toUpperCase();
  return '[' + sev + (i.category ? '/' + clip(i.category, 40) : '') + '] ' +
    (clip(i.problem, 200) || 'problem not described') +
    (i.quote ? ' ("' + clip(i.quote, 120) + '")' : '');
}

// The PRIORITY FIX note for the fix round (reuses the auditFixNote path).
// filteredIssues = the filter's retryIssues (an array), or the filtered
// audit itself (its retryIssues are used, else its issues). A HIGH issue whose
// quote was not found word for word is still listed (quoteNotFound).
function buildFactCheckFixNote(filteredIssues) {
  const src = filteredIssues;
  let issues = [];
  if (Array.isArray(src)) issues = src;
  else if (src && typeof src === 'object') {
    issues = (Array.isArray(src.retryIssues) && src.retryIssues.length) ? src.retryIssues : (Array.isArray(src.issues) ? src.issues : []);
  }
  const clip = (v, max) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  const lines = issues.slice(0, 15).map((i, n) => {
    const it = i || {};
    return (n + 1) + '. [' + String(it.severity || 'high').toUpperCase() + (it.category ? ' / ' + clip(it.category, 40) : '') + '] ' +
      'Problem: ' + (clip(it.problem, 400) || 'not described') + '.' +
      (it.fix ? ' Fix: ' + clip(it.fix, 400) + '.' : '') +
      (it.quote ? (it.quoteNotFound ? ' Text the fact-checker quoted (not found word for word in your edit): "' : ' Text in your previous edit: "') +
        clip(it.quote, 300) + '".' : '');
  });
  return 'A fact-check of your previous edit of this exact article found the problems listed below. ' +
    'Start again from the ORIGINAL article HTML above, fix every one of these problems, and keep following all other instructions exactly.\n' +
    lines.join('\n');
}

// Small copies of issues for the attempt row (runtime.attempts is persisted).
function compactFactIssues(list) {
  const clip = (v, max) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
  return (Array.isArray(list) ? list : []).slice(0, 12).map((i) => {
    const it = (i && typeof i === 'object') ? i : { problem: i };
    const out = {
      severity: clip(it.severity, 10),
      category: clip(it.category, 40),
      quote: clip(it.quote, 200),
      problem: clip(it.problem, 300),
      fix: clip(it.fix, 300)
    };
    if (it.dropReason) out.dropReason = clip(it.dropReason, 80);
    return out;
  });
}

function factCheckError(reason, aiSessionUrl) {
  const clean = safetyMessageText(reason || 'unknown error').replace(/[.\s]+$/, '');
  const err = manualReviewError('FACT CHECK ERROR: ' + clean + '. The post was NOT changed.');
  err.code = 'FACT_CHECK_ERROR';
  err.factCheckReason = clean;
  err.aiSessionUrl = aiSessionUrl || '';
  return err;
}

function factCheckBlockedError(fc, afterFixRound, extraReason) {
  // The blocking issues (retryIssues also hold a HIGH issue whose quote was not found).
  const issues = (fc && Array.isArray(fc.retryIssues) && fc.retryIssues.length) ? fc.retryIssues :
    (Array.isArray(fc && fc.issues) ? fc.issues : []);
  let msg = 'FACT CHECK BLOCKED: verdict "' + safetyMessageText((fc && fc.verdict) || '?') + '"' +
    (issues.length ? ', ' + issues.length + ' issue(s)' : '') +
    (afterFixRound ? ' after the fix round' : '');
  if (issues.length) msg += ' — ' + issues.slice(0, 3).map(factIssueText).join('; ');
  if (extraReason) msg += '. ' + safetyMessageText(extraReason).replace(/[.\s]+$/, '');
  const err = manualReviewError(safetyMessageText(msg).replace(/[.\s]+$/, '') + '. The post was NOT changed.');
  err.code = 'FACT_CHECK';
  // The blocking issues, for the automatic retry's PRIORITY FIX note.
  err.factIssues = compactFactIssues(issues);
  return err;
}

// Which AI runs the fact-check: factCheckAi (a resolved AI config) or the
// job's own AI. Read-only — never swaps runtime.job (parallel-safe).
function factCheckAiConfig() {
  const job = runtime.job || {};
  const fa = (job.factCheckAi && typeof job.factCheckAi === 'object') ? job.factCheckAi : null;
  const src = fa || job;
  return {
    aiUrl: src.aiUrl || '',
    aiName: src.aiName || (fa ? 'the fact-check AI' : 'the AI'),
    aiMode: src.aiMode || 'web',
    aiProvider: src.aiProvider || '',
    aiApiBaseUrl: src.aiApiBaseUrl || '',
    aiApiModel: src.aiApiModel || '',
    aiApiKey: src.aiApiKey || ''
  };
}

// The chosen fact-check prompt, else the built-in prompts/fact-check.txt.
let factCheckPromptFileCache = '';
async function factCheckPromptText() {
  const own = String((runtime.job && runtime.job.factCheckPrompt) || '').trim();
  if (own) return own;
  if (factCheckPromptFileCache) return factCheckPromptFileCache;
  try {
    const res = await fetch(chrome.runtime.getURL('prompts/fact-check.txt'));
    if (res && res.ok) {
      const t = String(await res.text()).trim();
      if (t) { factCheckPromptFileCache = t; return t; }
    }
  } catch (e) {}
  return '';
}

// Polls the fact-check tab until the reply holds a valid JSON verdict.
// Accepts when the AI is not generating, the reply has been stable ≥ 8 s and
// it parses (code blocks and the message text; of several verdicts the most
// severe wins). opts = { tag, promptText, aiName } (optional; promptText
// guards against reading our own prompt back as the "reply", aiName names
// the fact-check AI in a limit pause).
// v3.46.0 review fixes: a static "Thinking…" / "Searching the web…" line (or
// a stuck stop button) is the AI at work, never a finished reply without
// JSON — only the overall timeout ends that wait; time spent paused does not
// count; one last read runs before the timeout error.
async function waitForFactCheckJson(tabId, timeoutMs, providerKind, opts) {
  const o = opts || {};
  const tag = o.tag || '';
  let start = Date.now();
  const limitMs = Math.max(30000, Number(timeoutMs) || 180000);
  const POLL_INTERVAL = 2500;
  const MIN_WAIT_MS = 10000;
  const STABLE_MS = 8000;
  const STUCK_INDICATOR_MS = 75000;
  const NO_JSON_GIVEUP_MS = 30000;
  const NO_REPLY_GIVEUP_MS = 180000;
  // Same activity words as the edit waiter (waitForAIResponse), for a SHORT
  // reply text with no code block: that is a status line, not the verdict.
  const WORKING_RE = /\b(thinking|thought|reasoning|working|analy[sz]ing|generating|writing|composing|processing|searching|browsing|researching|reading|drafting)\b/i;
  let lastKey = '';
  let lastChangeAt = start;
  let stoppedPolls = 0;
  let lastLimitCheckAt = 0;
  let lastHeartbeat = 0;
  let lastParseError = '';
  let everGenerated = false;
  let lastActivityAt = start;
  let peeked = false;
  const isOwnPrompt = (text) => {
    const t = String(text || '');
    if (/(?:ORIGINAL|EDITED) ARTICLE HTML (?:START|END)/.test(t)) return true;
    return !!(o.promptText && detectPromptLeak(t, o.promptText));
  };
  const readSnapshot = async () => {
    let snap = null;
    try { snap = (await runInTab(tabId, readAIJsonSnapshot, [providerKind]))?.result || null; } catch (e) {}
    let texts = Array.isArray(snap?.texts) ? snap.texts : [];
    let messageText = String(snap?.messageText || '');
    if (isOwnPrompt(messageText)) { texts = []; messageText = ''; }   // our own message, not the reply
    texts = texts.filter((t) => !isOwnPrompt(t));
    return { snap, texts, messageText };
  };
  // Every valid verdict in the code blocks and the message text; the most
  // severe one wins (a draft "pass" never hides a later "reject").
  const readVerdict = (texts, messageText) => {
    const found = [];
    texts.forEach((t, i) => {
      const r = parseFactCheckReply(t);
      if (r.ok) found.push({ audit: r.audit, pos: i + 1 }); else lastParseError = r.error;
    });
    if (messageText) {
      const r = parseFactCheckReply(messageText);
      if (r.ok) found.push({ audit: r.audit, pos: 0 }); else if (!found.length) lastParseError = r.error || lastParseError;
    }
    const audit = mostSevereFactCheck(found);
    return audit ? { ok: true, audit } : null;
  };
  while (Date.now() - start < limitMs) {
    if (runtime.paused && !runtime.stopRequested) {
      // Time spent paused does not count against the fact-check wait.
      const pausedAt = Date.now();
      while (runtime.paused && !runtime.stopRequested) await sleep(500);
      const pausedMs = Date.now() - pausedAt;
      start += pausedMs;
      lastChangeAt += pausedMs;
      lastActivityAt += pausedMs;
    }
    throwIfStopped();
    const now = Date.now();
    const elapsed = Math.round((now - start) / 1000);
    await pumpFrozenTab(tabId);
    try { await runInTab(tabId, dismissBlockingDialogs); } catch (e) {}
    const { snap, texts, messageText } = await readSnapshot();
    // Usage limit: same rule as the edit tab — pause the batch, not a failure.
    if (snap?.usageLimit && limitGuardOn()) {
      const e = new Error('AI usage limit reached — ' + String(snap.usageLimit).slice(0, 120));
      e.code = 'AI_LIMIT';
      e.limitText = String(snap.usageLimit).slice(0, 200);
      if (o.aiName) e.aiName = o.aiName;
      throw e;
    }
    const generating = snap?.isGenerating === true;
    if (generating) everGenerated = true;
    if (!generating) stoppedPolls++; else stoppedPolls = 0;
    const hasReply = !!(messageText || texts.length);
    const working = generating || (!texts.length && messageText.length <= 160 && WORKING_RE.test(messageText));
    const key = texts.join('\u0001') + '\u0002' + messageText;
    if (key !== lastKey) { lastKey = key; lastChangeAt = now; }
    const stableMs = now - lastChangeAt;
    if (generating || hasReply) lastActivityAt = now;

    // A limited account may leave the composer usable but never reply.
    if (!hasReply && elapsed >= 12 && (now - lastLimitCheckAt) >= 20000) {
      lastLimitCheckAt = now;
      const limitErr = await limitErrorIfLimited(tabId, providerKind, tag, 'no fact-check reply while a limit notice is showing', o.aiName);
      if (limitErr) throw limitErr;
    }
    if (!hasReply && !generating && (now - lastActivityAt) >= NO_REPLY_GIVEUP_MS) {
      throw factCheckError('the fact-check AI never replied (' + elapsed + 's' + (everGenerated ? ', it started but produced no text' : '') + ')');
    }

    // Background-mode safety net (as the edit waiter): a fully covered worker
    // window can be throttled so the AI never starts. Nudge it to the front
    // once, then hand focus straight back.
    if (isBackgroundMode() && !peeked && elapsed >= 25 && !generating && !hasReply) {
      peeked = true;
      try {
        if (runtime.workerWindowId) { await chrome.windows.update(runtime.workerWindowId, { focused: true }); await sleep(350); }
        await focusPanelIfVisible();
      } catch (e) {}
      log('info', tag + ' 🔎 Nudged the worker window so the fact-check AI starts replying.');
    }

    const settled = (!generating && stoppedPolls >= 2 && stableMs >= STABLE_MS) ||
      (generating && stableMs >= STUCK_INDICATOR_MS);
    if (hasReply && settled && (now - start) >= MIN_WAIT_MS) {
      const parsed = readVerdict(texts, messageText);
      if (parsed) {
        log('ok', tag + ' 🔎 Fact-check reply received (verdict "' + parsed.audit.verdict + '", ' + parsed.audit.issues.length + ' issue(s)).');
        return parsed;
      }
      // Give up on "no JSON" only once the AI has really finished: while it is
      // still working (stop button showing, or a thinking / searching status
      // line) keep waiting — the overall timeout is the cap.
      if (!working && stableMs >= NO_JSON_GIVEUP_MS) {
        const preview = messageText.replace(/\s+/g, ' ').trim().slice(0, 160);
        throw factCheckError('the fact-check reply had no valid JSON verdict (' + lastParseError + ')' + (preview ? '. It said: "' + preview + '"' : ''));
      }
    }
    if (elapsed - lastHeartbeat >= 30) {
      lastHeartbeat = elapsed;
      log('info', tag + ' 🔎 Fact check: waiting ' + elapsed + 's — ' +
        (hasReply ? ('reply ' + (messageText.length || texts.join('').length) + ' chars, ' + (generating ? 'streaming' : 'settled ' + Math.round(stableMs / 1000) + 's')) : (generating ? 'AI working, no reply yet' : 'no reply yet')) + '.');
    }
    setStatus(tag + ' 🔎 Fact check: ' + (generating ? 'AI working' : (hasReply ? 'reading the verdict' : 'waiting for the reply')) + '... (' + elapsed + 's)');
    await sleep(POLL_INTERVAL);
  }
  // One last read: a finished verdict that landed during the final poll
  // interval is used instead of being thrown away.
  {
    throwIfStopped();
    const { snap, texts, messageText } = await readSnapshot();
    if (snap && snap.isGenerating !== true) {
      const parsed = readVerdict(texts, messageText);
      if (parsed) {
        log('ok', tag + ' 🔎 Fact-check reply received at the time limit (verdict "' + parsed.audit.verdict + '", ' + parsed.audit.issues.length + ' issue(s)).');
        return parsed;
      }
    }
  }
  throw factCheckError('no fact-check JSON within ' + Math.round(limitMs / 1000) + 's' + (lastParseError ? ' (' + lastParseError + ')' : ''));
}

// Browser mode: the fact-check always runs in a NEW chat tab of `ai`, with
// the same keep-alive / composer-ready / model-limit handling as the edit
// tab. The tab is always closed afterwards. instructionsText = the prompt as
// sent (tokens substituted); it only guards against reading it back.
async function runFactCheckInTab(ai, payload, instructionsText, tag, timeoutMs) {
  if (!ai.aiUrl) throw factCheckError('the fact-check AI has no web address');
  const providerKind = detectProviderKind(ai.aiUrl);
  const allowWebSearch = runtime.job.promptWebSearch === true;
  if (['chatgpt', 'claude', 'gemini', 'grok', 'deepseek'].indexOf(providerKind) === -1) {
    log('info', tag + ' 🔎 Fact check: ' + ai.aiName + ' is not ChatGPT, Claude, Gemini, Grok or DeepSeek — the verdict is read with generic page selectors. If the fact check keeps failing, choose one of those as the fact-check AI.');
  }
  let tabId = null;
  let sessionUrl = '';
  try {
    await ensureWorkerWindowUsable();
    const tab = await createWorkTab(ai.aiUrl);
    tabId = tab.id;
    sessionUrl = canonicalizeAISessionUrl(tab.url || '', providerKind, ai.aiUrl);
    // Before the readiness wait, never after it.
    await installAITabKeepAlive(tabId);
    await reviveHiddenWindowFor(tabId, 'opening the fact-check AI tab');
    const ready = await waitForAIComposerReady(tabId, providerKind === 'claude' ? 150000 : 90000, providerKind);
    if (!ready.ok) {
      const limitErr = await limitErrorIfLimited(tabId, providerKind, tag, 'the fact-check chat box never became usable', ai.aiName);
      if (limitErr) throw limitErr;
      throw factCheckError(ai.aiName + ' is not ready: ' + ready.error);
    }
    const prep = await prepareProviderForEditing(tabId, providerKind, allowWebSearch);
    if (prep?.changed) log('info', tag + ' Fact check: disabled ' + prep.changed + ' research/search toggle(s) in ' + ai.aiName);
    // MODEL LIMIT — before the paste, while the composer is still empty.
    {
      const limited = await checkAIModelLimit(tabId, providerKind, tag);
      if (limited) throw modelLimitError(limited, ai.aiName);
    }
    if (providerKind === 'gemini') {
      const flashLimited = await checkGeminiFlashLimit(tabId, tag);
      if (flashLimited) throw modelLimitError({ kind: 'gemini-flash', evidence: flashLimited.reason + (flashLimited.offered ? ' (offered: ' + flashLimited.offered + ')' : '') }, ai.aiName);
      await enforceGeminiFlashThinking(tabId, tag);
    }
    await sleep(1800);
    setStatus(tag + ' 🔎 Fact check: sending both versions to ' + ai.aiName);
    const sendResult = await sendPromptToAI(tabId, payload, providerKind, { tag });
    if (!sendResult.ok) {
      if (sendResult.stopped) throwIfStopped();
      if (sendResult.limited) throw modelLimitError(sendResult.limitDetection, ai.aiName);
      const limitErr = await limitErrorIfLimited(tabId, providerKind, tag, 'the fact-check prompt could not be sent', ai.aiName);
      if (limitErr) throw limitErr;
      throw factCheckError('the fact-check prompt was not sent: ' + sendResult.error);
    }
    sessionUrl = await refreshAISessionUrl(tabId, sessionUrl, providerKind, ai.aiUrl);
    log('ok', tag + ' 🔎 Fact-check prompt sent through ' + sendResult.method + ' — waiting for the JSON verdict.');
    const parsed = await waitForFactCheckJson(tabId, timeoutMs, providerKind, { tag, promptText: instructionsText, aiName: ai.aiName });
    sessionUrl = await refreshAISessionUrl(tabId, sessionUrl, providerKind, ai.aiUrl);
    return { parsed, aiSessionUrl: sessionUrl };
  } catch (e) {
    if (tabId) {
      try { sessionUrl = await refreshAISessionUrl(tabId, sessionUrl, providerKind, ai.aiUrl); } catch (e2) {}
    }
    if (e && typeof e === 'object' && !e.aiSessionUrl) e.aiSessionUrl = sessionUrl;
    throw e;
  } finally {
    if (tabId) {
      try { await safeCloseTab(tabId); } catch (e) {}
    }
  }
}

// One AI Fact-Check round → { verdict, issues, dropped, aiSessionUrl, action }.
// ctx = { tag, referenceHtml (or originalHtml), editedHtml (or aiHtml),
// attemptLinks, wpItem, fixRound }. Technical failures throw FACT_CHECK_ERROR;
// MODEL_LIMIT / AI_LIMIT / USER_STOPPED keep their own codes (pause / stop).
async function runFactCheck(ctx) {
  const c = ctx || {};
  const tag = c.tag || '';
  const reference = String(c.referenceHtml || c.originalHtml || '');
  const edited = String(c.editedHtml || c.aiHtml || '');
  throwIfStopped();
  const ai = factCheckAiConfig();
  const promptText = await factCheckPromptText();
  if (!promptText) throw factCheckError('no fact-check prompt is available (the chosen prompt is empty and prompts/fact-check.txt could not be read)');
  const postTitle = (c.attemptLinks && c.attemptLinks.postTitle) || plainPostTitle(c.wpItem && c.wpItem.title);
  const payload = buildFactCheckPayload(promptText, reference, edited, { postTitle });
  const timeoutMs = Math.max(30, Number(runtime.job.aiTimeout) || 180) * 1000;
  setStatus(tag + ' 🔎 Fact check with ' + ai.aiName);
  log('step', tag + ' 🔎 Fact check' + (c.fixRound ? ' (after the fix round)' : '') + ': asking ' + ai.aiName +
    ' in a NEW ' + ((ai.aiMode && ai.aiMode !== 'web') ? 'API request' : 'chat') + ' (' + payload.length + ' chars).');
  let parsed = null;
  let aiSessionUrl = '';
  try {
    if (ai.aiMode && ai.aiMode !== 'web') {
      const apiCfg = Object.assign({}, ai, {
        systemText: 'You are a meticulous fact-checker. Follow the instructions exactly and reply with ONE ```json code block and nothing else.'
      });
      const apiResult = await callAIProviderAPI(payload, timeoutMs, apiCfg);
      parsed = parseFactCheckReply(apiResult.text);
      if (!parsed.ok) {
        throw factCheckError('the fact-check reply had no valid JSON verdict (' + parsed.error + ')' +
          (apiResult.truncated ? ' — the reply hit the API max-token limit' : ''));
      }
      log('ok', tag + ' 🔎 Fact-check reply received (verdict "' + parsed.audit.verdict + '", ' + parsed.audit.issues.length + ' issue(s)).');
    } else {
      const instructions = substitutePromptTokens(promptText, promptTokenValues({ postTitle }));
      const r = await runFactCheckInTab(ai, payload, instructions, tag, timeoutMs);
      parsed = r.parsed;
      aiSessionUrl = r.aiSessionUrl || '';
    }
  } catch (e) {
    // A limit on the fact-check AI pauses under THAT AI's name (v3.46.0).
    if (e && (e.code === 'MODEL_LIMIT' || e.code === 'AI_LIMIT') && !e.aiName) e.aiName = ai.aiName;
    if (e && (e.code === 'MODEL_LIMIT' || e.code === 'AI_LIMIT' || e.code === 'USER_STOPPED' || e.code === 'FACT_CHECK_ERROR')) throw e;
    throw factCheckError((e && e.message) || String(e), (e && e.aiSessionUrl) || aiSessionUrl);
  }
  const decision = decideFactCheck(parsed.audit, edited, reference);
  const filtered = decision.filtered || {};
  const issues = Array.isArray(filtered.issues) ? filtered.issues : [];
  return {
    verdict: parsed.audit.verdict,
    effectiveVerdict: String(filtered.effectiveVerdict || '').toLowerCase(),
    issues,
    dropped: Array.isArray(filtered.dropped) ? filtered.dropped : [],
    retryIssues: Array.isArray(filtered.retryIssues) ? filtered.retryIssues : issues,
    aiSessionUrl,
    action: decision.action,
    reason: filtered.failReason || '',
    aiName: ai.aiName
  };
}

// Fix round: regenerate from the ORIGINAL (reference) HTML in a NEW chat with
// the issues as this attempt's PRIORITY FIX note. Never a recovery read.
async function regenerateForFactCheckFix(ctx, referenceHtml, note) {
  const tag = ctx.tag || '';
  const links = ctx.attemptLinks || {};
  const tabs = ctx.attemptTabs || { edit: null, ai: null };
  const fixLinks = Object.assign({}, links, {
    recoverFromUrl: '',
    recoverProviderUrl: '',
    auditFixNote: (links.auditFixNote ? links.auditFixNote + '\n\n' : '') + note
  });
  try {
    const html = await generateHtmlForArticle(tag + ' fix', ctx.num, ctx.total, referenceHtml, fixLinks, tabs, ctx.stepNo || 4);
    await sleep((runtime.job.settleTime || 3) * 1000);
    return html;
  } finally {
    // The fix-round chat is now this attempt's AI session (Failed-box link).
    if (fixLinks.aiSessionUrl && fixLinks.aiSessionUrl !== links.aiSessionUrl) {
      links.aiSessionUrl = fixLinks.aiSessionUrl;
      links.aiProviderUrl = runtime.job.aiUrl || links.aiProviderUrl;
    }
    if (tabs.ai) {
      log('step', tag + ' Closing the fix-round AI tab');
      try { await safeCloseTab(tabs.ai); } catch (e) {}
      tabs.ai = null;
      await sleep(700);
    }
  }
}

// <!-- APU-END --> end markers removed (SafetyGate.stripEndMarkers when the
// gate file is loaded, else the same pattern). Text without a marker comes
// back unchanged, byte for byte.
function stripEndMarkersForSave(html) {
  const s = String(html === undefined || html === null ? '' : html);
  if (!/<!--\s*APU-END\s*-->/i.test(s)) return html;
  const api = safetyGateApi();
  let out = '';
  try {
    out = (api && typeof api.stripEndMarkers === 'function') ? String(api.stripEndMarkers(s, 'APU-END')) : '';
  } catch (e) { out = ''; }
  if (!out || /<!--\s*APU-END\s*-->/i.test(out)) {
    out = s.replace(/^[ \t]*<!--\s*APU-END\s*-->[ \t]*(?:\r?\n|$)/gim, '').replace(/<!--\s*APU-END\s*-->/gi, '');
  }
  return out.trim();
}

// THE HOOK (processSlug, both branches, before ANY write). Returns the final
// HTML to save. ctx = { slug, tag, num, total, originalHtml, aiHtml,
// attemptLinks, attemptTabs, wpItem, stepNo }. Gate OFF → aiHtml unchanged
// (only <!-- APU-END --> end markers are removed).
async function applySafetyPipeline(ctx) {
  // Gate OFF: the edit is saved as generated, except that an end marker the
  // prompt asked for (<!-- APU-END -->) is never written into the post.
  if (!safetyGateOn()) return stripEndMarkersForSave(ctx.aiHtml);
  const tag = ctx.tag || '';
  const links = ctx.attemptLinks || {};
  // 1) Compare with the TRUE original of this run (not an already-edited post).
  const reference = await sessionOriginalFor(ctx.slug, links.rawInput, ctx.originalHtml);
  if (reference !== String(ctx.originalHtml || '').trim()) {
    log('info', tag + ' 🛡 Safety Gate reference = the ORIGINAL backup taken earlier in this run (' + reference.length + ' chars), not the current WordPress content.');
  }
  // 2-4) Code Safety Gate (not relaxed by any recovery / any-code mode).
  let html = await runSafetyGateStep(ctx, reference, ctx.aiHtml, 'AI');
  // Stop / Emergency Stop pressed during the link check or the fact check:
  // nothing is written (v3.46.0).
  if (!factCheckOn()) { throwIfStopped(); return html; }

  // 5) AI Fact-Check, with at most ONE fix round per attempt.
  let fixRoundUsed = false;
  for (;;) {
    let fc = null;
    try {
      fc = await runFactCheck(Object.assign({}, ctx, { referenceHtml: reference, editedHtml: html, fixRound: fixRoundUsed }));
    } catch (e) {
      if (!e || e.code !== 'FACT_CHECK_ERROR') throw e;
      links.factCheck = {
        verdict: 'error',
        error: String(e.factCheckReason || e.message || '').slice(0, 300),
        issues: [],
        dropped: [],
        aiSessionUrl: e.aiSessionUrl || '',
        fixRound: fixRoundUsed
      };
      if (runtime.job.factCheckOnError === 'save') {
        log('warn', tag + ' 🔎 The fact check itself failed (' + (e.factCheckReason || e.message) + ') — saving the gate-approved edit anyway (setting: if the fact check breaks → save).');
        throwIfStopped();
        return html;
      }
      log('err', tag + ' 🔎 The fact check itself failed (' + (e.factCheckReason || e.message) + ') — keeping the original (setting: if the fact check breaks → keep original).');
      throw e;
    }
    links.factCheck = {
      verdict: fc.verdict,
      issues: compactFactIssues(fc.issues),
      dropped: compactFactIssues(fc.dropped),
      aiSessionUrl: fc.aiSessionUrl || '',
      fixRound: fixRoundUsed
    };
    if (fc.dropped.length) {
      log('info', tag + ' 🔎 Fact check: ignored ' + fc.dropped.length + ' issue(s) whose quote is not in the edited article.');
    }
    if (fc.action === 'pass') {
      fc.issues.forEach((i) => log('info', tag + ' 🔎 Minor: ' + factIssueText(i)));
      log('ok', tag + ' 🔎 Fact check PASSED (verdict "' + fc.verdict + '"' + (fixRoundUsed ? ', after one fix round' : '') + ').');
      throwIfStopped();
      return html;
    }
    const blocking = (Array.isArray(fc.retryIssues) && fc.retryIssues.length) ? fc.retryIssues : fc.issues;
    blocking.forEach((i) => log('warn', tag + ' 🔎 ' + factIssueText(i) + (i && i.quoteNotFound ? ' [quote not found word for word]' : '')));
    if (fc.action === 'fail' || fixRoundUsed) {
      log('err', tag + ' 🔎 FACT CHECK BLOCKED the edit (verdict "' + fc.verdict + '"' + (fixRoundUsed ? ', after the fix round' : '') + ') — the post is NOT changed.');
      throw factCheckBlockedError(fc, fixRoundUsed, fc.reason);
    }
    // 2.6) Fix round: once per attempt, from the ORIGINAL, in a NEW chat.
    fixRoundUsed = true;
    const note = buildFactCheckFixNote(blocking);
    log('step', tag + ' 🔧 Fact-check fix round: regenerating from the ORIGINAL article in a NEW chat with ' +
      blocking.length + ' issue(s) attached as a PRIORITY FIX note.');
    setStatus(tag + ' 🔧 Fact-check fix round');
    let fixedHtml = '';
    try {
      fixedHtml = await regenerateForFactCheckFix(ctx, reference, note);
    } catch (e) {
      // Limits / Stop keep their meaning; anything else fails the post here.
      if (e && e.code) throw e;
      log('err', tag + ' 🔧 Fix round failed: ' + ((e && e.message) || e));
      throw factCheckBlockedError(fc, false, 'The fix round could not produce a new version (' + ((e && e.message) || e) + ')');
    }
    log('step', tag + ' 🔧 Fix round returned ' + fixedHtml.length + ' chars — running the Safety Gate and the fact check again.');
    html = await runSafetyGateStep(ctx, reference, fixedHtml, 'fix-round');
  }
}

// ══════════════════════════════════════════════════════════════════════
// PROVIDER DETECTION
// ══════════════════════════════════════════════════════════════════════
function detectProviderKind(url) {
  let host = '';
  try { host = new URL(String(url || '')).hostname.toLowerCase(); } catch (e) { return 'generic'; }
  const inDomain = (root) => host === root || host.endsWith('.' + root);
  if (host === 'chatgpt.com' || host === 'www.chatgpt.com' || host === 'chat.openai.com') return 'chatgpt';
  if (inDomain('claude.ai')) return 'claude';
  if (host === 'gemini.google.com' || host === 'bard.google.com') return 'gemini';
  if (inDomain('grok.com') || host === 'grok.x.ai') return 'grok';
  if (inDomain('deepseek.com')) return 'deepseek';
  if (inDomain('perplexity.ai')) return 'perplexity';
  return 'generic';
}

function isApiAIJob() {
  return runtime.job?.aiMode && runtime.job.aiMode !== 'web';
}

// ── Auto-split: edit a very large article in section-sized parts ───────────
function shouldAutoSplit(originalHtml) {
  if (runtime.job?.autoSplit !== 'on') return false;
  const threshold = runtime.job.splitThreshold || 28000;
  return String(originalHtml || '').length > threshold;
}

function splitHtmlByHeadings(html, maxChars) {
  function group(parts) {
    const chunks = [];
    let cur = '';
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (cur && (cur.length + p.length) > maxChars) { chunks.push(cur); cur = p; }
      else cur += p;
    }
    if (cur.trim()) chunks.push(cur);
    return chunks;
  }
  let parts = html.split(/(?=<h2[\s>])/i);
  if (parts.length < 2) parts = html.split(/(?=<h[23][\s>])/i);
  if (parts.length < 2) return [html];
  const chunks = group(parts);
  return chunks.length ? chunks : [html];
}

function buildChunkPayload(promptText, chunkHtml, partNo, total, extra) {
  return 'You are editing PART ' + partNo + ' of ' + total + ' of one larger WordPress article. ' +
    'Edit ONLY this part and reply with ONLY this part as raw HTML. Do NOT add <html>, <head> or <body> wrappers, do NOT repeat any other part, and do NOT add a whole-article intro or conclusion here.\n\n' +
    'Here is PART ' + partNo + ' HTML:\n```html\n' + String(chunkHtml || '').trim() + '\n```\n\n' +
    // v3.46.0: only the [[TOKENS]] present in the saved prompt are replaced.
    'Editing instructions:\n' + substitutePromptTokens(String(promptText || '').trim(), promptTokenValues(extra)) + '\n\n' +
    'Reply with the edited HTML of this part inside one fenced code block that starts with ```html and ends with ```.';
}

async function generateHtmlForArticleChunked(tag, num, total, originalHtml, attemptLinks, attemptTabs, stepNo, promptOverride) {
  const chunkPrompt = promptOverride || runtime.job.prompt;
  const maxChars = Math.max(4000, Math.min(40000, runtime.job.splitChunkChars || 14000));
  const chunks = splitHtmlByHeadings(originalHtml, maxChars);
  if (chunks.length < 2) {
    log('warn', tag + ' Auto-split found no section breaks; editing the whole article in one pass.');
  }
  log('step', tag + ' Auto-split ON: ' + originalHtml.length + ' chars in ' + chunks.length + ' part(s).');
  const outParts = [];
  const stopped = () => { if (runtime.stopRequested) { const e = new Error('Stopped by user'); e.code = 'USER_STOPPED'; throw e; } };

  if (isApiAIJob()) {
    for (let ci = 0; ci < chunks.length; ci++) {
      stopped();
      setStatus(tag + ' Auto-split: ' + runtime.job.aiName + ' API part ' + (ci + 1) + '/' + chunks.length);
      log('step', tag + ' Part ' + (ci + 1) + '/' + chunks.length + ': calling ' + runtime.job.aiName + ' API');
      const apiResult = await callAIProviderAPI(buildChunkPayload(chunkPrompt, chunks[ci], ci + 1, chunks.length, { postTitle: attemptLinks?.postTitle }), runtime.job.aiTimeout * 1000);
      if (apiResult.truncated) throw new Error('Auto-split part ' + (ci + 1) + ' hit the API max-token limit. Lower the article size or raise max tokens.');
      const partHtml = extractHtmlFromAIText(apiResult.text);
      if (!partHtml || partHtml.length < 40) throw new Error('Auto-split part ' + (ci + 1) + ' returned no HTML.');
      outParts.push(partHtml.trim());
    }
  } else {
    setStatus(tag + ' Opening ' + runtime.job.aiName + ' tab (auto-split)');
    const aiTab = await createWorkTab(runtime.job.aiUrl);
    attemptTabs.ai = aiTab.id;
    const providerKind = detectProviderKind(runtime.job.aiUrl);
    attemptLinks.aiSessionUrl = canonicalizeAISessionUrl(aiTab.url || '', providerKind, runtime.job.aiUrl);
    await installAITabKeepAlive(aiTab.id);   // survive a minimized Chrome window
    await reviveHiddenWindowFor(aiTab.id, 'opening the AI tab');
    const ready = await waitForAIComposerReady(aiTab.id, providerKind === 'claude' ? 150000 : 90000, providerKind);
    if (!ready.ok) {
      const limitErr = await limitErrorIfLimited(aiTab.id, providerKind, tag, 'the chat box never became usable');
      if (limitErr) throw limitErr;
      throw manualReviewError(runtime.job.aiName + ' is not ready: ' + ready.error);
    }
    await prepareProviderForEditing(aiTab.id, providerKind, !!runtime.job.promptWebSearch);
    if (providerKind === 'gemini') await enforceGeminiFlashThinking(aiTab.id, tag);
    await sleep(1500);
    for (let ci = 0; ci < chunks.length; ci++) {
      stopped();
      setStatus(tag + ' Auto-split: part ' + (ci + 1) + '/' + chunks.length + ' to ' + runtime.job.aiName);
      log('step', tag + ' Part ' + (ci + 1) + '/' + chunks.length + ': sending to ' + runtime.job.aiName);
      const sendResult = await sendPromptToAI(aiTab.id, buildChunkPayload(chunkPrompt, chunks[ci], ci + 1, chunks.length, { postTitle: attemptLinks?.postTitle }), providerKind, { tag });
      if (!sendResult.ok) throw manualReviewError('Auto-split part ' + (ci + 1) + ' was not sent: ' + sendResult.error);
      attemptLinks.aiSessionUrl = await refreshAISessionUrl(aiTab.id, attemptLinks.aiSessionUrl, providerKind, runtime.job.aiUrl);
      const partHtml = await waitForAIResponse(aiTab.id, runtime.job.aiTimeout * 1000, num, total, chunks[ci], chunkPrompt, runtime.job.strictMode, providerKind);
      attemptLinks.aiSessionUrl = await refreshAISessionUrl(aiTab.id, attemptLinks.aiSessionUrl, providerKind, runtime.job.aiUrl);
      if (!partHtml || partHtml.length < 40) throw manualReviewError('Auto-split part ' + (ci + 1) + ' returned no HTML.');
      outParts.push(partHtml.trim());
      await sleep(1200);
    }
  }

  const combined = outParts.join('\n\n');
  log('ok', tag + ' Auto-split complete: ' + chunks.length + ' parts -> ' + combined.length + ' chars.');
  return combined;
}

async function generateHtmlForArticle(tag, num, total, originalHtml, attemptLinks, attemptTabs, stepNo) {
  // Automatic HTML Code Recovery: read the code box from an already-finished AI
  // session instead of generating. NO prompt is sent -- we only read what is there.
  if (attemptLinks && attemptLinks.recoverFromUrl) {
    const rawRecUrl = String(attemptLinks.recoverFromUrl || '').trim();
    const recProviderHome = attemptLinks.recoverProviderUrl || attemptLinks.aiProviderUrl || '';
    const recKind = detectProviderKind(rawRecUrl || recProviderHome);
    const recUrl = canonicalizeAISessionUrl(rawRecUrl, recKind, recProviderHome);
    if (!recUrl) {
      throw manualReviewError('The saved AI link is not a verified, canonical conversation URL. Use “Retry new”.');
    }
    const allowAnyCode = runtime.job.recoverAnyCode === true;
    // Section recovery is a middle ground: looser than the completeness gate,
    // stricter than "any code" — the article must still have all three parts.
    const requireSections = runtime.job.recoverSections === true;
    setStatus(tag + ' Recovery: reopening the saved AI session');
    log('step', tag + ' Step ' + stepNo + ': HTML recovery -- reopening the AI session to read the existing code box' + (allowAnyCode ? ' (manual ANY CODE mode)' : ''));
    const recTab = await createWorkTab(recUrl);
    attemptTabs.ai = recTab.id;
    // The submitted session URL is immutable evidence. Never replace it with a
    // provider root/login URL if the reopened tab redirects temporarily.
    attemptLinks.aiSessionUrl = recUrl;
    const expectedConversationKey = aiConversationKey(recUrl, recKind);
    if (recKind === 'chatgpt' || recKind === 'gemini') {
      // Gemini silently redirects a dead conversation id back to the /app new
      // chat shell — without this check recovery would read a blank (or the
      // wrong) chat instead of failing fast with a usable message.
      //
      // TIMING: the page must be genuinely READY before its URL is judged. A
      // throttled tab (Chrome minimized) or a slow network can still be on the
      // provider shell after 8s, which used to be reported as "did not reopen
      // at the same verified conversation ID" — a false failure that killed
      // perfectly good chats. Wait for the composer first, then allow 45s.
      try { await waitForTabLoad(recTab.id, 45000); } catch (e) {}
      try { await installAITabKeepAlive(recTab.id); } catch (e) {}
      try { await reviveHiddenWindowFor(recTab.id, 'reopening the saved chat'); } catch (e) {}
      await waitForAIComposerReady(recTab.id, 90000, recKind);
      const reopenedUrl = await waitForAISessionUrl(recTab.id, recKind, recProviderHome, 45000, []);
      if (!reopenedUrl || aiConversationKey(reopenedUrl, recKind) !== expectedConversationKey) {
        const seen = reopenedUrl || (await getSettledAIPageUrl(recTab.id, recProviderHome)) || 'nothing readable';
        throw manualReviewError(recKind === 'gemini'
          ? 'The saved Gemini conversation did not reopen at the same verified conversation ID (landed on: ' + seen + ') — Gemini likely discarded it (check that "Gemini Apps Activity" is ON and the same Google account is logged in). Use “Retry new”.'
          : 'The saved ChatGPT conversation did not reopen at the same verified conversation ID (landed on: ' + seen + '). If ChatGPT was still loading, retry; otherwise use “Retry new”.');
      }
      attemptLinks.aiSessionUrl = reopenedUrl;
    } else {
      try { await installAITabKeepAlive(recTab.id); } catch (e) {}
      try { await reviveHiddenWindowFor(recTab.id, 'reopening the saved chat'); } catch (e) {}
      await waitForAIComposerReady(recTab.id, 90000, recKind);
    }
    await sleep(2500);
    const refreshedRecoveryUrl = await refreshAISessionUrl(recTab.id, attemptLinks.aiSessionUrl, recKind, recProviderHome);
    if ((recKind === 'chatgpt' || recKind === 'gemini') && aiConversationKey(refreshedRecoveryUrl, recKind) !== expectedConversationKey) {
      throw manualReviewError((recKind === 'gemini' ? 'Gemini' : 'ChatGPT') + ' redirected away from the saved conversation before recovery. Use “Retry new”.');
    }
    attemptLinks.aiSessionUrl = refreshedRecoveryUrl || attemptLinks.aiSessionUrl;
    let recHtml = await waitForAIResponse(
      recTab.id, Math.min(120000, (runtime.job.aiTimeout || 180) * 1000),
      num, total, originalHtml, runtime.job.prompt, runtime.job.strictMode, recKind,
      allowAnyCode || requireSections
    );
    recHtml = cleanExtractedArticle(recHtml);
    const recVerify = (allowAnyCode || requireSections)
      ? verifyRecoverableHtml(recHtml, runtime.job.prompt)
      : verifyHtml(recHtml, originalHtml, runtime.job.prompt, runtime.job.strictMode);
    if (!recVerify.ok) throw manualReviewError('HTML recovery could not read a clean code box from the saved session (' + recVerify.reason + ').');
    if (requireSections) {
      const sections = hasIntroFaqConclusion(recHtml);
      if (!sections.ok) {
        throw manualReviewError('Intro/FAQ/Conclusion recovery: the saved chat\'s article is missing its ' +
          sections.missing.join(' and ') + '. Nothing was saved — use "new session" to regenerate it.');
      }
      log('ok', tag + ' Intro/FAQ/Conclusion recovery: the saved article has all three sections — accepting it.');
    }
    const recComp = completenessOptions();
    if (recComp && !allowAnyCode && !requireSections) {
      const recAssess = assessReplyCompleteness(recHtml, originalHtml, recComp);
      if (!recAssess.complete) throw manualReviewError('Recovered HTML looked incomplete (' + recAssess.reasons.join('; ') + ').');
    }
    log(allowAnyCode ? 'warn' : 'ok', tag + ' Recovered ' + recHtml.length + ' chars of HTML from the existing AI session' + (allowAnyCode ? ' and accepted it through the manual ANY CODE override.' : '.'));
    return recHtml;
  }
  // Effective prompt: the saved prompt plus (for audit re-runs) this post's
  // own PRIORITY FIX note listing the exact issues to correct.
  const jobPrompt = runtime.job.prompt + ((attemptLinks && attemptLinks.auditFixNote)
    ? '\n\n══════════════  PRIORITY FIX (from the last audit of this article)  ══════════════\n' + attemptLinks.auditFixNote
    : '');
  if (shouldAutoSplit(originalHtml)) {
    const splitHtml = await generateHtmlForArticleChunked(tag, num, total, originalHtml, attemptLinks, attemptTabs, stepNo, jobPrompt);
    // v3.46.0: with the Safety Gate on, the RE-JOINED whole article also has
    // to pass the size/leak check and the completeness check (each part was
    // only checked against its own chunk before).
    if (safetyGateOn()) {
      const joinedVerify = verifyHtml(splitHtml, originalHtml, runtime.job.prompt, runtime.job.strictMode);
      if (!joinedVerify.ok) {
        throw manualReviewError('Refused to save — the re-joined auto-split article failed verification (' + joinedVerify.reason + '). The post was NOT changed.');
      }
      const joinedComp = completenessOptions();  // honor the user's completeness setting (null = Off)
      if (joinedComp) {
        const joinedAssess = assessHtmlCompleteness(splitHtml, originalHtml, joinedComp);
        if (!joinedAssess.complete) {
          throw manualReviewError('Refused to save — the re-joined auto-split article looked incomplete (' + joinedAssess.reasons.join('; ') + '). The post was NOT changed.');
        }
      }
    }
    return splitHtml;
  }
  const payload = buildAIPayload(jobPrompt, originalHtml, { postTitle: attemptLinks && attemptLinks.postTitle });
  if (isApiAIJob()) {
    attemptLinks.aiSessionUrl = '';
    setStatus(tag + ' Calling ' + runtime.job.aiName + ' API');
    log('step', tag + ' Step ' + stepNo + ': Calling ' + runtime.job.aiName + ' API (' + (runtime.job.aiApiModel || 'model not set') + ')');
    const apiResult = await callAIProviderAPI(payload, runtime.job.aiTimeout * 1000);
    if (apiResult.truncated) {
      throw new Error('AI API stopped at its max output-token limit, so the article would be truncated. Raise "API max output tokens" or split this round-up. The post was NOT updated.');
    }
    const aiHtml = extractHtmlFromAIText(apiResult.text);
    const verify = verifyHtml(aiHtml, originalHtml, runtime.job.prompt, runtime.job.strictMode);
    if (!verify.ok) {
      const preview = String(apiResult.text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
      throw new Error('AI API result rejected: ' + verify.reason + (preview ? '. Reply preview: "' + preview + '"' : ''));
    }
    const apiComp = completenessOptions();
    const apiAssess = apiComp
      ? assessReplyCompleteness(aiHtml, originalHtml, apiComp)
      : { complete: true, coverage: (originalHtml.length ? aiHtml.length / originalHtml.length : 1), reasons: [] };
    if (!apiAssess.complete) {
      throw new Error('AI API result looks incomplete and was NOT saved (' + apiAssess.reasons.join('; ') + '). Raise max tokens, reduce the article size, or set the completeness check to Off if this is a false alarm.');
    }
    log('ok', tag + ' AI API returned ' + aiHtml.length + ' chars of complete HTML (' + Math.round((apiAssess.coverage || 0) * 100) + '% of source)');
    return aiHtml;
  }

  setStatus(tag + ' Opening ' + runtime.job.aiName + ' tab');
  log('step', tag + ' Step ' + stepNo + ': Opening ' + runtime.job.aiName);
  await ensureWorkerWindowUsable();
  const aiTab = await createWorkTab(runtime.job.aiUrl);
  attemptTabs.ai = aiTab.id;
  const providerKind = detectProviderKind(runtime.job.aiUrl);
  attemptLinks.aiSessionUrl = canonicalizeAISessionUrl(aiTab.url || '', providerKind, runtime.job.aiUrl);
  const aiReadyTimeout = providerKind === 'claude' ? 150000 : 90000;
  // Before the readiness wait, never after it.
  await installAITabKeepAlive(aiTab.id);
  await reviveHiddenWindowFor(aiTab.id, 'opening the AI tab');
  const aiReady = await waitForAIComposerReady(aiTab.id, aiReadyTimeout, providerKind);
  attemptLinks.aiSessionUrl = await refreshAISessionUrl(aiTab.id, attemptLinks.aiSessionUrl, providerKind, runtime.job.aiUrl);
  if (!aiReady.ok) {
    const limitErr = await limitErrorIfLimited(aiTab.id, providerKind, tag, 'the chat box never became usable');
    if (limitErr) throw limitErr;
    throw manualReviewError(runtime.job.aiName + ' is not ready: ' + aiReady.error);
  }
  const prep = await prepareProviderForEditing(aiTab.id, providerKind, !!runtime.job.promptWebSearch);
  if (prep?.changed) log('info', tag + ' Disabled ' + prep.changed + ' research/search toggle(s) in ' + runtime.job.aiName);
  // MODEL LIMIT — before the paste, while the composer is still empty.
  {
    const limited = await checkAIModelLimit(aiTab.id, providerKind, tag);
    if (limited) throw modelLimitError(limited, runtime.job.aiName);
  }
  if (providerKind === 'gemini') {
    const flashLimited = await checkGeminiFlashLimit(aiTab.id, tag);
    if (flashLimited) throw modelLimitError({ kind: 'gemini-flash', evidence: flashLimited.reason + (flashLimited.offered ? ' (offered: ' + flashLimited.offered + ')' : '') }, runtime.job.aiName);
    await enforceGeminiFlashThinking(aiTab.id, tag);
  }
  await sleep(1800);

  setStatus(tag + ' Pasting prompt + HTML into ' + runtime.job.aiName);
  log('step', tag + ' Step ' + (stepNo + 1) + ': Pasting prompt (' + payload.length + ' chars total)');
  if (payload.length > 45000 && providerKind === 'claude') {
    log('warn', tag + ' Claude web UI is receiving a very large prompt (' + payload.length + ' chars). If it stalls on Thinking, use Claude API mode for this batch.');
  }
  const sendResult = await sendPromptToAI(aiTab.id, payload, providerKind, { tag });
  if (!sendResult.ok) {
    attemptLinks.aiSessionUrl = await refreshAISessionUrl(aiTab.id, attemptLinks.aiSessionUrl, providerKind, runtime.job.aiUrl);
    if (sendResult.limited) throw modelLimitError(sendResult.limitDetection, runtime.job.aiName);
    const limitErr = await limitErrorIfLimited(aiTab.id, providerKind, tag, 'the prompt could not be sent');
    if (limitErr) throw limitErr;
    throw manualReviewError(runtime.job.aiName + ' prompt was not sent: ' + sendResult.error);
  }
  // Normal generation is already waiting for the full reply below; take a
  // non-blocking URL snapshot here and refresh again after the response. The
  // strict 60-second route wait belongs only to fire-and-forget Fast Submit.
  attemptLinks.aiSessionUrl = await refreshAISessionUrl(aiTab.id, attemptLinks.aiSessionUrl, providerKind, runtime.job.aiUrl);
  log('ok', tag + ' Prompt sent through ' + sendResult.method);

  setStatus(tag + ' Waiting for ' + runtime.job.aiName + ' to finish (up to ' + runtime.job.aiTimeout + 's)');
  log('step', tag + ' Step ' + (stepNo + 2) + ': Watching AI code box');
  try {
    let aiHtml = await waitForAIResponse(
      aiTab.id, runtime.job.aiTimeout * 1000,
      num, total, originalHtml, jobPrompt, runtime.job.strictMode,
      providerKind
    );
    // FINAL SAFETY NET: whichever internal path produced this (code box, copy
    // button, Grok-flicker cache, or continuation), strip any audit report and
    // keep only the article HTML before it is ever saved to WordPress.
    aiHtml = cleanExtractedArticle(aiHtml);
    // STRICT & FAIL-CLOSED: only a clean, complete HTML code box may be saved.
    // If anything is off (empty, prose leaked in, partial/truncated), FAIL the
    // post so the live article is left untouched rather than overwritten.
    const scbVerify = verifyHtml(aiHtml, originalHtml, runtime.job.prompt, runtime.job.strictMode);
    if (!scbVerify.ok) {
      throw manualReviewError('Refused to save — could not read a clean HTML code box (' + scbVerify.reason + '). The post was NOT changed.');
    }
    const scbComp = completenessOptions();  // honor the user's "Article completeness check" setting (null = Off)
    if (scbComp) {
      const scbAssess = assessReplyCompleteness(aiHtml, originalHtml, scbComp);
      if (!scbAssess.complete) {
        throw manualReviewError('Refused to save — the HTML code box looked incomplete (' + scbAssess.reasons.join('; ') + '). The post was NOT changed. Turn on Fix-it prompts or use API mode for big articles; or set completeness to Off to save it anyway.');
      }
      if (scbAssess.coverageWaived) {
        log('info', tag + ' Completeness: the edit is ' + Math.round((scbAssess.coverage || 0) * 100) + '% of the source length — accepted because it carries the <!-- APU-END --> end marker (the Safety Gate checks for lost words).');
      }
    }
    attemptLinks.aiSessionUrl = await refreshAISessionUrl(aiTab.id, attemptLinks.aiSessionUrl, providerKind, runtime.job.aiUrl);
    log('ok', tag + ' AI returned ' + aiHtml.length + ' chars of complete HTML code box');
    return aiHtml;
  } catch (e) {
    attemptLinks.aiSessionUrl = await refreshAISessionUrl(aiTab.id, attemptLinks.aiSessionUrl, providerKind, runtime.job.aiUrl);
    if (e && (e.code === 'USER_STOPPED' || e.code === 'POST_NOT_FOUND')) throw e;
    throw manualReviewError(e.message);
  }
}

// aiCfg (optional, v3.46.0): a resolved AI config ({aiMode, aiProvider,
// aiApiBaseUrl, aiApiModel, aiApiKey, systemText}) used instead of the job's
// own AI, e.g. by the Fact-Check round. Omitted = the job's AI, as before.
async function callAIProviderAPI(promptText, timeoutMs, aiCfg) {
  const cfg = aiCfg || runtime.job;
  const provider = cfg.aiProvider || cfg.aiMode;
  if (provider === 'gemini') return callGeminiAPI(promptText, timeoutMs, aiCfg);
  if (provider === 'anthropic') return callAnthropicAPI(promptText, timeoutMs, aiCfg);
  return callOpenAICompatibleAPI(promptText, timeoutMs, aiCfg);
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(15000, timeoutMs || 120000));
  let response;
  try {
    response = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('AI API timed out before returning a response');
    throw new Error('AI API network error: ' + (e?.message || e));
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (e) {}
  }
  if (!response.ok) {
    const detail = data?.error?.message || data?.message || text.slice(0, 300) || response.statusText;
    throw new Error('AI API ' + response.status + ': ' + detail);
  }
  if (!data) throw new Error('AI API returned non-JSON response: ' + text.slice(0, 200));
  return data;
}

function apiBaseUrl(defaultUrl, aiCfg) {
  return String((aiCfg || runtime.job).aiApiBaseUrl || defaultUrl || '').replace(/\/+$/, '');
}

function apiMaxTokens() {
  const n = parseInt(runtime.job?.apiMaxTokens, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200000) : 16000;
}

async function callOpenAICompatibleAPI(promptText, timeoutMs, aiCfg) {
  const cfg = aiCfg || runtime.job;
  const key = cfg.aiApiKey;
  const model = cfg.aiApiModel;
  const base = apiBaseUrl('https://api.openai.com/v1', aiCfg);
  if (!key || !model) throw new Error('OpenAI-compatible API needs a model and API key.');
  const endpoint = /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions';
  const messages = [
    { role: 'system', content: (aiCfg && aiCfg.systemText) || 'Return only the complete updated WordPress article HTML. No explanations.' },
    { role: 'user', content: promptText }
  ];
  const request = (body) => fetchJsonWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  }, timeoutMs);
  let data;
  try {
    data = await request({ model, messages, temperature: 0.2, max_tokens: apiMaxTokens() });
  } catch (e) {
    const msg = String(e?.message || '');
    // Newer OpenAI models reject `max_tokens` (they want `max_completion_tokens`)
    // and some reject a custom temperature. Retry once with the modern shape.
    const paramIssue = /max_completion_tokens/i.test(msg) ||
      (/unsupported|not supported|invalid/i.test(msg) && /max_tokens|temperature/i.test(msg));
    if (!paramIssue) throw e;
    data = await request({ model, messages, max_completion_tokens: apiMaxTokens() });
  }
  const text =
    data?.choices?.[0]?.message?.content ||
    data?.choices?.[0]?.text ||
    data?.output_text ||
    '';
  if (!text) throw new Error('AI API response did not include text content.');
  const finish = data?.choices?.[0]?.finish_reason || data?.choices?.[0]?.finishReason || '';
  return { text, truncated: /length|max_tokens|max_output/i.test(String(finish)) };
}

async function callGeminiAPI(promptText, timeoutMs, aiCfg) {
  const cfg = aiCfg || runtime.job;
  const key = cfg.aiApiKey;
  const model = cfg.aiApiModel;
  const base = apiBaseUrl('https://generativelanguage.googleapis.com/v1beta', aiCfg);
  if (!key || !model) throw new Error('Gemini API needs a model and API key.');
  const endpoint = base + '/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key);
  const data = await fetchJsonWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: promptText }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: apiMaxTokens()
      }
    })
  }, timeoutMs);
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p.text || '').join('');
  const finishReason = data?.candidates?.[0]?.finishReason || '';
  if (!text) {
    const reason = finishReason || 'empty response';
    throw new Error('Gemini API response did not include text content (' + reason + ').');
  }
  return { text, truncated: /max_tokens|max_output/i.test(String(finishReason)) };
}

async function callAnthropicAPI(promptText, timeoutMs, aiCfg) {
  const cfg = aiCfg || runtime.job;
  const key = cfg.aiApiKey;
  const model = cfg.aiApiModel;
  const base = apiBaseUrl('https://api.anthropic.com/v1', aiCfg);
  if (!key || !model) throw new Error('Claude API needs a model and API key.');
  const endpoint = /\/messages$/i.test(base) ? base : base + '/messages';
  const data = await fetchJsonWithTimeout(endpoint, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: apiMaxTokens(),
      temperature: 0.2,
      messages: [{ role: 'user', content: promptText }]
    })
  }, timeoutMs);
  const blocks = data?.content || [];
  const text = blocks.map(b => b?.text || '').join('');
  if (!text) throw new Error('Claude API response did not include text content.');
  return { text, truncated: data?.stop_reason === 'max_tokens' };
}

function extractHtmlFromAIText(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    const value = parsed?.html || parsed?.content || parsed?.article || parsed?.text;
    if (typeof value === 'string') return cleanExtractedArticle(normalizeCodeText(value));
  } catch (e) {}
  const hasOutputDivider = findFinalHtmlOutputCut(raw) >= 0;
  const cleanedWholeReply = cleanExtractedArticle(normalizeCodeText(raw));
  if (hasOutputDivider && looksLikeArticleHtml(cleanedWholeReply)) return cleanedWholeReply;
  const fences = [...raw.matchAll(/```(?:html|HTML)?\s*([\s\S]*?)```/g)]
    .map(m => normalizeCodeText(m[1]))
    .filter(looksLikeArticleHtml);
  if (fences.length) {
    fences.sort((a, b) => b.length - a.length);
    return cleanExtractedArticle(fences[0]);
  }
  return cleanedWholeReply;
}

function looksLikeArticleHtml(text) {
  return /<\/?(?:!doctype\s+html|html|body|article|section|main|div|p|h[1-6]|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|figure|img|a|blockquote)\b/i.test(String(text || ''));
}

// ══════════════════════════════════════════════════════════════════════
// AI RESPONSE WATCHING
// ══════════════════════════════════════════════════════════════════════
async function waitForAIResponse(tabId, timeoutMs, num, total, originalHtml, promptText, strictMode, providerKind, allowAnyCode) {
  let startTime = Date.now();
  let lastKey = '';
  let lastCandidate = null;
  let lastChangeAt = 0;          // when the code box content last changed
  let lastCandidateSeenAt = 0;   // when a valid code box was last visible
  let stoppedSignalCount = 0;
  let lastProviderIssue = '';
  let lastAssistantPreview = '';
  let lastAssistantLen = 0;
  let everSawAssistant = false;
  let everSawCodeCard = false;
  let everGenerated = false;
  let completeNoCodePolls = 0;
  let peeked = false;
  let lastHeartbeat = 0;
  let recoverySent = false;
  let copyTried = false;
  let lastActivityAt = Date.now();
  let continueClicks = 0;
  let lastContinueAt = 0;
  let truncationRecoveryTried = false;
  let lastLimitCheckAt = 0;

  const POLL_INTERVAL = 2500;
  const STOPPED_SIGNALS_REQUIRED = 3;
  const MIN_WAIT_MS = 15000;
  const SHORT_STABLE_MS = 8000;     // provider says "done" + box settled this long
  const COMPLETE_STABLE_MS = 12000; // HTML looks complete + settled
  const VERYLONG_STABLE_MS = 40000; // generation stopped + box unchanged this long
  const STUCK_INDICATOR_MS = 75000; // "generating" flag still on but box frozen this long => treat the indicator as stuck (so we never copy while the AI is genuinely still working, yet never hang forever)
  const NO_CODE_GIVEUP_POLLS = 4;   // ~10s of "finished, has a reply, but no code block"

  // Does the extracted HTML look like a finished document (not cut mid-element)?
  function looksCompleteHtml(t) {
    if (!t) return false;
    const s = t.trimEnd();
    if (/<\/html\s*>$/i.test(s)) return true;
    if (/<\/[a-z0-9]+\s*>$/i.test(s)) {
      const tailCloses = (s.slice(-700).match(/<\/[a-z0-9]+\s*>/gi) || []).length;
      return tailCloses >= 2;
    }
    return false;
  }

  // A virtualised/collapsed code card renders only a SLICE of its content on
  // screen, while the page's own Copy mechanism holds all of it. In any-code
  // mode the completeness gate is off, so a sliced candidate used to be
  // accepted as-is and the recovered article "missed" most of its HTML; in
  // strict mode a slice could occasionally sneak past completeness too. So
  // before finalising, compare ONCE against the copy capture and keep the
  // longer verified text. Costs one copy click, and only when the card
  // actually has a copy control — a plain post pays nothing.
  let copyCompareDone = false;
  async function preferCopyIfLonger(cand, cardPresent, coverage) {
    if (copyCompareDone) return cand.text;
    if (!cand.hasCopyButton && !cardPresent) return cand.text;
    // Already at (or above) full length versus the source? Then nothing is
    // missing and the copy click — which briefly focuses the worker window —
    // is not worth paying on every post.
    if (Number(coverage) >= 0.98) return cand.text;
    copyCompareDone = true;
    try {
      const raw = await tryCopyRaw(tabId, providerKind);
      if (raw && raw.length > cand.text.length + Math.max(400, Math.round(cand.text.length * 0.05))) {
        const v = allowAnyCode
          ? verifyRecoverableHtml(raw, promptText)
          : verifyHtml(raw, originalHtml, promptText, strictMode);
        if (v.ok) {
          log('ok', '[' + num + '/' + total + '] Copy button holds the FULL article: ' + raw.length +
            ' chars vs ' + cand.text.length + ' on screen — using the copied version.');
          return raw;
        }
        log('warn', '[' + num + '/' + total + '] Copy capture was longer (' + raw.length + ' chars) but failed verification (' + (v.reason || '?') + ') — keeping the on-screen text.');
      }
    } catch (e) {}
    return cand.text;
  }

  function looksLikeClaudeStall(preview, len) {
    const text = String(preview || '').trim().toLowerCase();
    if (!text && Number(len || 0) === 0) return true;
    return Number(len || text.length || 0) <= 30 && /\b(thinking|working|loading|preparing)\b/.test(text);
  }

  while (Date.now() - startTime < timeoutMs) {
    while (runtime.paused && !runtime.stopRequested) await sleep(500);
    if (runtime.stopRequested) {
      const e = new Error('Stopped by user');
      e.code = 'USER_STOPPED';
      throw e;
    }

    const now = Date.now();
    const elapsed = Math.round((now - startTime) / 1000);
    // Keep the frozen rendering lifecycle turning over while the reply streams
    // in: without this a minimized Gemini paints a few words a minute, and the
    // virtualised code card only ever renders the slice that was already there.
    await pumpFrozenTab(tabId);
    try { await runInTab(tabId, dismissBlockingDialogs); } catch (e) {}

    // A limited account often leaves the composer usable but never replies.
    // Check every ~20s while there is no output, so the run pauses in seconds
    // instead of burning the whole AI timeout on every remaining post.
    if (!lastCandidate && elapsed >= 12 && (now - lastLimitCheckAt) >= 20000) {
      lastLimitCheckAt = now;
      const limitErr = await limitErrorIfLimited(tabId, providerKind, '[' + num + '/' + total + ']', 'no reply while a limit notice is showing');
      if (limitErr) throw limitErr;
    }
    let snapshot = null;
    try {
      const r = await runInTab(tabId, readAICodeSnapshot, [providerKind]);
      snapshot = r?.result || null;
    } catch (e) {}

    // Usage-limit guard: if the provider is showing a "you've hit your limit"
    // banner (e.g. ChatGPT's GPT-5 weekly limit), stop immediately with a
    // distinct code so the batch PAUSES instead of burning the whole list.
    if (snapshot?.usageLimit && limitGuardOn()) {
      const e = new Error('AI usage limit reached — ' + String(snapshot.usageLimit).slice(0, 120));
      e.code = 'AI_LIMIT';
      e.limitText = String(snapshot.usageLimit).slice(0, 200);
      throw e;
    }
    const candidate = pickBestVerifiedCandidate(snapshot?.candidates || [], originalHtml, promptText, strictMode, allowAnyCode);
    const stillGenerating = snapshot?.stillGenerating === true;
    if (snapshot?.providerIssue) lastProviderIssue = snapshot.providerIssue;
    if (snapshot?.hadAssistantMsg) {
      everSawAssistant = true;
      lastAssistantLen = snapshot.assistantLen || lastAssistantLen;
      if (snapshot.assistantPreview) lastAssistantPreview = snapshot.assistantPreview;
    }
    if (stillGenerating) everGenerated = true;
    if (snapshot?.hasCodeCard) everSawCodeCard = true;
    if (!stillGenerating) stoppedSignalCount++; else stoppedSignalCount = 0;

    // Track when the code box content last changed.
    if (candidate) {
      if (candidate.key !== lastKey) {
        lastKey = candidate.key;
        lastCandidate = candidate;
        lastChangeAt = now;
      }
      lastCandidateSeenAt = now;
    }
    const stableMs = candidate ? (now - lastChangeAt) : 0;

    // ChatGPT shows "Continue generating" when a reply hits its per-message
    // output cap. Click it (up to 12 times) so the SAME code box keeps growing
    // instead of failing the post on a half-written article.
    if (!allowAnyCode && snapshot?.truncated === true && continueClicks < 12 && (now - lastContinueAt) > 8000) {
      continueClicks++;
      lastContinueAt = now;
      try {
        const r = await runInTab(tabId, clickContinueGenerating);
        if (r?.result?.clicked) {
          log('info', '[' + num + '/' + total + '] Reply hit the output cap — clicked "Continue generating" (' + continueClicks + '/12).');
          stoppedSignalCount = 0;
          lastActivityAt = now;
          await sleep(POLL_INTERVAL);
          continue;
        }
      } catch (e) {}
    }

    // Keep waiting as long as the AI is actively generating or the code box is
    // still growing — a much larger (4-5x) article simply takes longer. The wait
    // ends only on the (possibly huge) wall-clock cap, when the box settles
    // complete (handled below), or after a long stretch with nothing happening.
    const aiWorking = stillGenerating || /\b(thinking|reasoning|working|analy[sz]ing|generating|writing|composing|processing|searching|reading|drafting)\b/i.test((snapshot && snapshot.assistantPreview) || '');
    if (aiWorking || lastChangeAt === now) lastActivityAt = now;
    if (!candidate && !aiWorking && (now - lastActivityAt) >= 150000 && (now - startTime) >= MIN_WAIT_MS) {
      break;
    }

    // Grok can briefly hide or replace a finished code box with a small status
    // message. If we already captured complete verified HTML, keep it instead
    // of failing on the later UI flicker.
    if (!candidate && lastCandidate && (now - startTime) >= MIN_WAIT_MS) {
      const cachedStableMs = now - lastChangeAt;
      const hiddenMs = lastCandidateSeenAt ? (now - lastCandidateSeenAt) : 0;
      if (((looksCompleteHtml(lastCandidate.text) && cachedStableMs >= COMPLETE_STABLE_MS) || cachedStableMs >= 20000) && hiddenMs >= 6000) {
        log('ok', '[' + num + '/' + total + '] Recovered last visible code box at ' + lastCandidate.text.length + ' chars after Grok UI changed.');
        return lastCandidate.text;
      }
    }

    if (snapshot?.providerIssue && !snapshot?.composerReady && !candidate && !stillGenerating && elapsed >= 20) {
      // "limit or temporary outage" is exactly the case that must pause the run.
      if (/limit|quota|cap\b/i.test(String(snapshot.providerIssue))) {
        const limitErr = await limitErrorIfLimited(tabId, providerKind, '[' + num + '/' + total + ']', snapshot.providerIssue);
        if (limitErr) throw limitErr;
      }
      throw new Error('AI provider problem: ' + snapshot.providerIssue + '. No verified HTML code box was available.');
    }

    // Background-mode safety net: a fully covered/occluded worker window can be
    // throttled so the AI never starts. If nothing at all is happening, nudge
    // the worker window to the front once, then immediately hand focus back.
    if (isBackgroundMode() && !peeked && elapsed >= 25 && !stillGenerating && !candidate && !(snapshot?.hadAssistantMsg)) {
      peeked = true;
      try {
        if (runtime.workerWindowId) { await chrome.windows.update(runtime.workerWindowId, { focused: true }); await sleep(350); }
        await focusPanelIfVisible();
      } catch (e) {}
      log('info', '[' + num + '/' + total + '] Nudged worker window so ' + (providerKind || 'AI') + ' starts generating.');
    }

    // Heartbeat into the log roughly every 30s so long waits are visible.
    if (elapsed - lastHeartbeat >= 30) {
      lastHeartbeat = elapsed;
      const what = candidate
        ? ('code box ' + candidate.text.length + ' chars, ' + (stillGenerating ? 'streaming' : 'settled') + ' ' + Math.round(stableMs / 1000) + 's')
        : stillGenerating ? 'AI generating, no code box yet'
        : snapshot?.hadAssistantMsg ? ('AI replied ' + (snapshot.assistantLen || 0) + ' chars, no code block yet')
        : 'no AI reply yet';
      log('info', '[' + num + '/' + total + '] Waiting ' + elapsed + 's — ' + what + '.');
    }

    if (providerKind === 'claude' && !candidate && everSawAssistant && elapsed >= 300 && looksLikeClaudeStall(lastAssistantPreview, lastAssistantLen)) {
      const preview = lastAssistantPreview ? ' It showed: "' + lastAssistantPreview.replace(/\s+/g, ' ').trim() + '."' : '';
      throw new Error('Claude web UI appears stalled with no HTML after ' + elapsed + 's.' + preview + ' This usually happens with very large prompts; retrying may help, but Claude API mode is more reliable for long batches.');
    }

    // Finished, composer back, no usable candidate yet. Enter this path when
    // there is EITHER a real reply OR a code card present — the card may be a
    // virtualised ChatGPT block whose on-screen text is only a few chars, so the
    // copy button (which holds the full code) is the reliable way to read it.
    const replyEvidence = (everSawAssistant && (snapshot?.assistantLen || 0) > 40) || snapshot?.hasCodeCard || everSawCodeCard;
    if (!stillGenerating && snapshot?.composerReady && !candidate && replyEvidence) {
      const grokProgress = providerKind === 'grok' && looksLikeGrokProgress(lastAssistantPreview);
      if (grokProgress && elapsed < 240) {
        completeNoCodePolls = 0;
        setStatus('[' + num + '/' + total + '] Grok is still formatting the article... (' + elapsed + 's)');
        await sleep(POLL_INTERVAL);
        continue;
      } else {
        completeNoCodePolls++;
      }
      const copyFloorMs = (snapshot?.hasCodeCard || everSawCodeCard) ? 12000 : 30000;
      if (completeNoCodePolls >= NO_CODE_GIVEUP_POLLS && (now - startTime) >= copyFloorMs) {
        if (!copyTried) {
          copyTried = true;
          setStatus('[' + num + '/' + total + '] Reading the full code via the Copy button...');
          const copied = await tryCopyButtonExtract(tabId, originalHtml, promptText, strictMode, providerKind, allowAnyCode);
          if (copied) {
            log('ok', '[' + num + '/' + total + '] Recovered the article via the code Copy button (' + copied.length + ' chars).');
            return copied;
          }
          // Even if it did not pass the completeness gate, keep the raw copy as a
          // candidate for the truncation/continuation logic below.
          const raw = await tryCopyRaw(tabId, providerKind);
          const rawVerify = raw
            ? (allowAnyCode ? verifyRecoverableHtml(raw, promptText) : verifyHtml(raw, originalHtml, promptText, strictMode))
            : { ok: false };
          if (raw && raw.length > 300 && rawVerify.ok && (!lastCandidate || raw.length > lastCandidate.text.length)) {
            lastCandidate = { text: raw, key: stableTextKey(raw) };
            lastChangeAt = now;
            log('info', '[' + num + '/' + total + '] Copy button holds ' + raw.length + ' chars (on-screen text was ' + (snapshot?.assistantLen || 0) + ').');
          } else if (raw && raw.length > 300 && !rawVerify.ok) {
            log('warn', '[' + num + '/' + total + '] Copy capture was rejected: ' + (rawVerify.reason || 'not valid article HTML') + '.');
          }
        }
        // One no-code-block recovery nudge is ALWAYS allowed (independent of
        // continueRounds): when the AI prints a report/prose with no fenced
        // ```html block, re-ask ONCE for just the code block. recoverySent caps
        // it at a single nudge so it can never loop.
        const recoveryAllowed =
          !allowAnyCode &&
          shouldSendNoCodeRecovery(providerKind, lastAssistantPreview) &&
          (providerKind !== 'grok' || elapsed >= 180 || looksLikeGrokBadFinal(lastAssistantPreview));
        if (!recoverySent && recoveryAllowed && !lastCandidate) {
          recoverySent = true;
          log('warn', '[' + num + '/' + total + '] ' + (providerKind || 'AI') + ' replied without HTML. Sending one recovery prompt.');
          setStatus('[' + num + '/' + total + '] Correcting AI response format...');
          const recovery = buildNoCodeRecoveryPayload(promptText, originalHtml, providerKind);
          const sendResult = await sendPromptToAI(tabId, recovery, providerKind, { tag: '[' + num + '/' + total + ']' });
          if (!sendResult.ok) {
            throw new Error('AI replied without HTML, then recovery prompt could not be sent: ' + sendResult.error);
          }
          startTime = Date.now();
          lastActivityAt = Date.now();
          lastKey = '';
          lastCandidate = null;
          lastChangeAt = 0;
          lastCandidateSeenAt = 0;
          stoppedSignalCount = 0;
          lastProviderIssue = '';
          lastAssistantPreview = '';
          lastAssistantLen = 0;
          everSawAssistant = false;
          everGenerated = false;
          completeNoCodePolls = 0;
          lastHeartbeat = 0;
          await sleep(2500);
          continue;
        }
        const said = lastAssistantPreview ? ' It replied: "' + lastAssistantPreview.replace(/\s+/g, ' ').trim() + '…"' : '';
        throw new Error(
          (providerKind === 'chatgpt' && lastAssistantLen < 200)
            ? 'AI finished without returning the article — it may have asked a question or refused.' + said
            : 'AI finished but did not put its answer inside an ```html code block (it likely rendered the article or replied in prose).' + said
        );
      }
    } else {
      completeNoCodePolls = 0;
    }

    // Acceptance is CONTENT-BASED: once the code box stops changing we accept it,
    // even if the provider's "still generating" indicator is stuck on (a known
    // ChatGPT quirk that previously caused 10-min timeouts on finished output).
    if (candidate && (now - startTime) >= MIN_WAIT_MS) {
      const stoppedConfirmed = !stillGenerating && stoppedSignalCount >= STOPPED_SIGNALS_REQUIRED;
      // Universal rule: never finalize/copy the article while the AI is still
      // generating. The ONLY escape is a clearly STUCK indicator (the code box
      // totally unchanged for a very long time) so a provider that leaves its
      // "generating" flag on forever cannot hang the batch.
      const stuckEscape = stillGenerating && stableMs >= STUCK_INDICATOR_MS;
      const generationDone = !stillGenerating || stuckEscape;
      const settledShort = stoppedConfirmed && stableMs >= SHORT_STABLE_MS;
      const settledLong = generationDone && stableMs >= VERYLONG_STABLE_MS;
      const compOpts = allowAnyCode ? null : completenessOptions();
      if (settledShort || settledLong) {
        const comp = compOpts
          ? assessReplyCompleteness(candidate.text, originalHtml, compOpts)
          : { complete: true, coverage: (originalHtml.length ? candidate.text.length / originalHtml.length : 1), reasons: [] };
        if (comp.complete) {
          const finalText = await preferCopyIfLonger(candidate, snapshot?.hasCodeCard === true, comp.coverage);
          log('ok', '[' + num + '/' + total + '] Code box COMPLETE at ' + finalText.length + ' chars (' + Math.round((comp.coverage || 0) * 100) + '% of source, stable ' + Math.round(stableMs / 1000) + 's)');
          return finalText;
        }
        // Generation has stopped but the article is NOT complete => truncated.
        // ULTIMATE RECOVERY LADDER (runs once) before giving up:
        //   1) Copy button — virtualised viewers (Grok, big ChatGPT blocks) keep
        //      the FULL code in memory even when only part is rendered.
        //   2) Up to 3 "continue exactly where you stopped" prompts, with the
        //      parts overlap-stitched into one complete article.
        // Only a still-incomplete result after all of that fails the post.
        if (snapshot?.truncated === true || (generationDone && (settledLong || stableMs >= COMPLETE_STABLE_MS))) {
          if (!truncationRecoveryTried) {
            truncationRecoveryTried = true;
            setStatus('[' + num + '/' + total + '] Output looks cut at ' + candidate.text.length + ' chars — trying the code Copy button...');
            // Pull the FULL code from the page's own copy mechanism — modern
            // ChatGPT code cards are collapsed/virtualised, so the on-screen
            // text can be a fraction of what the page really holds in memory.
            const rawCopy = await tryCopyRaw(tabId, providerKind);
            if (rawCopy) {
              const rcVerify = allowAnyCode
                ? verifyRecoverableHtml(rawCopy, promptText)
                : verifyHtml(rawCopy, originalHtml, promptText, strictMode);
              const rcComp = compOpts ? assessReplyCompleteness(rawCopy, originalHtml, compOpts) : { complete: true };
              if (rcVerify.ok && rcComp.complete) {
                log('ok', '[' + num + '/' + total + '] Full article recovered via the code Copy button (' + rawCopy.length + ' chars).');
                return rawCopy;
              }
            }
            // Continue from the LONGEST capture we have — the copy capture
            // beats innerText whenever the viewer is collapsed.
            const firstPart = (rawCopy && rawCopy.length > candidate.text.length) ? rawCopy : candidate.text;
            if (firstPart.length > candidate.text.length) {
              log('info', '[' + num + '/' + total + '] Copy capture has ' + firstPart.length + ' chars vs ' + candidate.text.length + ' on screen — continuing from the longer one.');
            }
            const assembled = await completeByContinuation(tabId, providerKind, firstPart, originalHtml, promptText, strictMode, num, total);
            if (assembled) {
              log('ok', '[' + num + '/' + total + '] Article completed by continuation prompts: ' + assembled.length + ' chars total.');
              return assembled;
            }
          }
          const cr = Number(runtime.job?.continueRounds) || 0;
          throw new Error('AI output looks truncated and was NOT saved (' + comp.reasons.join('; ') + '). Tried the Copy button' + (cr > 0 ? ' and up to ' + cr + ' continue prompt(s)' : ' (fix-it prompts are Off — no extra prompt was sent)') + '. For big articles use API mode with higher max tokens, turn Auto-split On, or set an API fallback AI.');
        }
        log('warn', '[' + num + '/' + total + '] Output may be incomplete (' + candidate.text.length + ' chars: ' + comp.reasons.join('; ') + ') - confirming...');
      }
      setStatus('[' + num + '/' + total + '] Code box ' + candidate.text.length + ' chars — ' + (stillGenerating ? 'streaming' : 'settled') + ' ' + Math.round(stableMs / 1000) + 's, ' + elapsed + 's');
    } else if (candidate) {
      setStatus('[' + num + '/' + total + '] AI code box ' + candidate.text.length + ' chars (' + elapsed + 's)');
    } else {
      setStatus('[' + num + '/' + total + '] ' + (stillGenerating ? 'AI generating' : 'Waiting for HTML code box') + '... (' + elapsed + 's)');
    }
    await sleep(POLL_INTERVAL);
  }

  // RECOVER ANY CODE keeps its promise even on a timeout: return the best
  // HTML the chat holds (the last seen candidate, or one final copy capture)
  // instead of failing the post with nothing.
  if (allowAnyCode) {
    let salvage = lastCandidate ? lastCandidate.text : '';
    try {
      const raw = await tryCopyRaw(tabId, providerKind);
      if (raw && raw.length > salvage.length) salvage = raw;
    } catch (e) {}
    if (salvage && verifyRecoverableHtml(salvage, promptText).ok) {
      log('warn', '[' + num + '/' + total + '] Any-code mode: the wait ran out, salvaging the best available HTML (' + salvage.length + ' chars).');
      return salvage;
    }
  }

  let tail;
  if (lastProviderIssue) {
    tail = ' Provider problem: ' + lastProviderIssue + '.';
  } else if (lastCandidate) {
    tail = ' Last visible code box had ' + lastCandidate.text.length + ' chars but kept changing (never settled).';
  } else if (everSawAssistant) {
    tail = ' The AI replied (' + lastAssistantLen + ' chars) but no ```html code block was found' +
      (lastAssistantPreview ? '. It said: "' + lastAssistantPreview.replace(/\s+/g, ' ').trim() + '…"' : '.');
  } else if (everGenerated) {
    tail = ' The AI started but never produced a code block.';
  } else {
    tail = ' The AI never produced a reply' +
      (isBackgroundMode() ? ' — in background mode this happens if the worker window is minimized or fully covered; keep it visible.' : '.');
  }
  throw new Error('AI stopped after ' + Math.round((Date.now() - startTime) / 1000) + 's with no further output.' + tail);
}

// ──────────────────────────────────────────────────────────────────────
// Pick the best verified HTML candidate from the snapshot
// ──────────────────────────────────────────────────────────────────────
function cleanExtractedArticle(text) {
  let s = String(text || '');
  // Audit-style replies print the report first, then a final HTML divider,
  // then the article. Drop everything up to the LAST such divider so the report
  // is never saved with the article. (No divider present -> text is unchanged.)
  const cut = findFinalHtmlOutputCut(s);
  if (cut >= 0) s = s.slice(cut);
  // Trim any non-HTML preamble (e.g. a "HTML" code-box label or leftover
  // commentary) and trailing chatter: keep from the first HTML comment or tag
  // through the final '>'.
  let start = s.search(/<!--|<\/?(?:!doctype\s+html|html|article|section|main|header|div|p|h[1-6]|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|figure|img|a|blockquote|script)\b/i);
  // v3.46.0 BUG FIX: a shortcode that opens the article ([toc], a page
  // builder's [et_pb_section ...]) sits before the first tag and used to be
  // cut off. A shortcode at the start of a line now counts as the start too.
  // (A code fence between the two means the "shortcode" is chat text outside
  // the code block, so it is ignored.)
  const shortcodeStart = leadingShortcodeIndex(s);
  if (shortcodeStart >= 0 && (start < 0 || (shortcodeStart < start && s.slice(shortcodeStart, start).indexOf('```') < 0))) start = shortcodeStart;
  if (start >= 0) {
    const lower = s.toLowerCase();
    const closeHtml = lower.lastIndexOf('</html>');
    const lastGt = s.lastIndexOf('>');
    let end = closeHtml > start ? closeHtml + 7 : (lastGt > start ? lastGt + 1 : s.length);
    // v3.46.0 BUG FIX: keep closing shortcodes after the last '>' as well
    // ([related_posts], [/et_pb_section]) instead of dropping them.
    if (!(closeHtml > start) && lastGt > start) end = trailingShortcodeEnd(s, end);
    s = s.slice(start, end);
  }
  return s.trim();
}

// Index of the first shortcode ([name ...] or [/name]) that starts a line, or
// -1. Markdown links "[text](url)" and one-letter "[x]" boxes are not shortcodes.
// Shortcode names are lower case ("[Final HTML]", "[Summary] …" are chat
// labels, not shortcodes). A plain name ([toc], [caption …], [embed]) must
// also end its line, be followed by a tag, another shortcode or a URL, or be
// closed on the same line ([quote]…[/quote]) — "[note] I kept …" is chat
// text. A plugin-style name with "_" or "-" ([su_note], [et_pb_section]) may
// wrap text.
function leadingShortcodeIndex(s) {
  const re = /(^|\n)([ \t]*)\[\/?([a-z][a-z0-9_-]+)(?=[ \t\]\/])[^\]\[\n]{0,2000}\](?!\()/g;
  const str = String(s || '');
  let m;
  while ((m = re.exec(str)) !== null) {
    const rest = str.slice(m.index + m[0].length);
    const line = rest.split('\n')[0];
    if (/[_-]/.test(m[3]) || /^[ \t]*(?:\r?$|<|\[|https?:\/\/)/.test(line) || line.indexOf('[/' + m[3] + ']') >= 0) {
      return m.index + m[1].length + m[2].length;
    }
    re.lastIndex = m.index + m[0].length;
  }
  return -1;
}

// Extends an article end past trailing lines that are shortcodes (e.g.
// "[related_posts]" or "[embed]url[/embed]" after the last tag). Stops at a
// code fence so chat text after the code block is never included. Shortcode
// names are lower case ("[Note] …]" is a chat label).
function trailingShortcodeEnd(s, end) {
  const tail = String(s || '').slice(end);
  if (tail.indexOf('[') < 0) return end;
  const lines = tail.split('\n');
  let pos = end;
  let best = end;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (/^```/.test(t)) break;
    if (/^\[\/?[a-z][a-z0-9_-]+(?=[ \t\]\/])/.test(t) && /\]$/.test(t) && !/\]\(/.test(t)) {
      best = pos + line.replace(/\s+$/, '').length;
    }
    pos += line.length + 1;
  }
  return best;
}

function findFinalHtmlOutputCut(text) {
  const s = String(text || '');
  // v3.46.0 BUG FIX: the "FIXED ARTICLE" divider must start its own line
  // (only decoration such as ──, ##, ** or "2." / "PART 2 —" before it). It
  // used to match anywhere, so an article containing "a fixed article of
  // clothing" lost everything before that phrase.
  const re = /(?:^|\n)\s*(?:#+\s*)?(?:\d+\.\s*)?(?:(?:COMPLETE|FINAL|UPDATED|REVISED|FIXED)[ \t]+)*(?:BODY-ONLY[ \t]+)?(?:ARTICLE[ \t]+)?HTML\b[^\n]*|(?:^|\n)[^A-Za-z0-9<\n]{0,40}(?:\d+\.[^A-Za-z0-9<\n]{0,10})?(?:PART[ \t]+\d+[^A-Za-z0-9<\n]{0,10})?FIXED[ \t]+ARTICLE\b[^<\n]*/ig;
  let m, cut = -1;
  while ((m = re.exec(s)) !== null) cut = m.index + m[0].length;
  return cut;
}

function pickBestVerifiedCandidate(candidates, originalHtml, promptText, strictMode, allowAnyCode) {
  if (!Array.isArray(candidates)) return null;

  const ranked = candidates
    .map((candidate) => {
      // STRICT: accept ONLY real code-box sources (<pre>/<code>/code-viewer).
      // Rendered prose (assistant-text / *-blob) is never eligible, so an audit
      // report or any chat text can never be selected and saved as the article.
      if (!candidate || !['pre', 'code', 'viewer'].includes(candidate.source)) return null;
      const text = cleanExtractedArticle(normalizeCodeText(candidate?.text || ''));
      const verify = allowAnyCode
        ? verifyRecoverableHtml(text, promptText)
        : verifyHtml(text, originalHtml, promptText, strictMode);
      if (!verify.ok) return null;

      const articleTags = (text.match(/<(p|div|h[1-6]|article|section|ul|ol|li|img|a|table)[\s>]/gi) || []).length;
      const score =
        (candidate.score || 0) +
        Math.min(articleTags, 80) +
        Math.min(Math.round(text.length / 1000), 40) +
        (candidate.hasCopyButton ? 10 : 0) +
        (candidate.languageHtml ? 15 : 0) +
        (candidate.fromAssistantMessage ? 30 : 0);  // strong preference for content inside assistant bubble

      return {
        text,
        score,
        source: candidate.source || 'code',
        hasCopyButton: candidate.hasCopyButton === true,
        key: stableTextKey(text)
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || b.text.length - a.text.length);

  return ranked[0] || null;
}

function normalizeCodeText(text) {
  let clean = String(text || '').replace(/\u00a0/g, ' ');
  // Strip language label that some providers prepend on the visible code (e.g. "html\n<!doctype...")
  clean = clean.replace(/^\s*html\s*\n/i, '');
  // Strip markdown fences if present
  clean = clean.replace(/^```(?:html|HTML)?\s*\n?/i, '').replace(/\n?\s*```\s*$/, '');
  // Strip a leading "Copy code" or "Copy" line that some code-viewer chrome includes
  clean = clean.replace(/^\s*Copy(?:\s+code)?\s*\n/i, '');
  return clean.trim();
}

function stableTextKey(text) {
  // More forgiving than v2.1 — bucketed length resists single-char churn.
  const lenBucket = Math.floor(text.length / 50); // 50-char buckets
  const head = text.slice(0, 80).replace(/\s+/g, ' ');
  const tail = text.slice(-80).replace(/\s+/g, ' ');
  let hash = 0;
  const sample = head + '|' + tail;
  for (let i = 0; i < sample.length; i++) {
    hash = ((hash << 5) - hash + sample.charCodeAt(i)) | 0;
  }
  return lenBucket + ':' + hash;
}

function manualReviewError(message) {
  const err = new Error(message);
  err.keepTabs = true;
  return err;
}

// ══════════════════════════════════════════════════════════════════════
// PROMPT PAYLOAD
// ══════════════════════════════════════════════════════════════════════
function buildAIPayload(promptText, sourceHtml, extra) {
  // Keep the user's saved prompt authoritative. The transport wrapper only
  // separates source HTML from instructions; it must not inject editing rules
  // that the user did not save.
  // v3.46.0: [[TODAY]], [[SITE_DOMAIN]], [[WEB_SEARCH]], [[NEW_FAQ]] and
  // [[POST_TITLE]] are substituted when the saved prompt contains them (value
  // substitution only — a prompt without tokens is sent exactly as before).
  // extra = { postTitle } (optional).
  const head = (label) => '══════════════════════  ' + label + '  ══════════════════════';
  return head('ARTICLE HTML START') + '\n\n' +
    String(sourceHtml || '').trim() + '\n\n' +
    head('ARTICLE HTML END') + '\n\n\n' +
    head('INSTRUCTIONS') + '\n\n' +
    substitutePromptTokens(String(promptText || '').trim(), promptTokenValues(extra));
}

// ══════════════════════════════════════════════════════════════════════
// TRUNCATION CONTINUATION — ask the AI to finish a cut-off article and
// stitch the parts together (overlap-aware), so long posts are captured
// whole instead of failing.
// ══════════════════════════════════════════════════════════════════════
function buildContinuePayload(assembledSoFar) {
  const tail = String(assembledSoFar || '').slice(-400);
  return 'Your previous reply was cut off before the article HTML was finished. ' +
    'Continue the SAME article from EXACTLY where you stopped. The last characters you sent were:\n\n' +
    '```\n' + tail + '\n```\n\n' +
    'Reply with ONLY the REMAINING HTML — start at the first character that comes after the text above, do not repeat earlier parts, do not restart the article, and do not explain anything. ' +
    'Put it inside ONE fenced code block that starts with ```html and ends with ```. Continue until the article is fully finished, ending with the final closing tag.';
}

// Join two parts, removing any overlap the model repeated at the seam.
function stitchHtmlParts(a, b) {
  a = String(a || '').replace(/\s+$/, '');
  b = String(b || '').replace(/^\s+/, '');
  const maxOverlap = Math.min(a.length, b.length, 600);
  for (let n = maxOverlap; n >= 20; n--) {
    if (a.slice(-n) === b.slice(0, n)) return a + b.slice(n);
  }
  return a + '\n' + b;
}

async function completeByContinuation(tabId, providerKind, firstPart, originalHtml, promptText, strictMode, num, total) {
  const maxRounds = Math.max(0, Math.min(8, Number(runtime.job?.continueRounds) || 0));
  if (!maxRounds) return '';
  let assembled = firstPart;
  const compOpts = completenessOptions();
  for (let round = 1; round <= maxRounds; round++) {
    if (runtime.stopRequested) return '';
    log('warn', '[' + num + '/' + total + '] Output incomplete at ' + assembled.length + ' chars — asking the AI to continue (round ' + round + '/' + maxRounds + ').');
    setStatus('[' + num + '/' + total + '] Asking AI to continue the article (round ' + round + '/' + maxRounds + ')...');
    let baseline = 0;
    try { baseline = (await runInTab(tabId, probeAISend, [providerKind]))?.result?.assistantCount || 0; } catch (e) {}
    const sendRes = await sendPromptToAI(tabId, buildContinuePayload(assembled), providerKind, { tag: '[' + num + '/' + total + ']' });
    if (!sendRes.ok) {
      log('warn', '[' + num + '/' + total + '] Continue prompt could not be sent: ' + sendRes.error);
      return '';
    }
    const partTimeout = Math.min((runtime.job?.aiTimeout ? runtime.job.aiTimeout * 1000 : 240000), 480000);
    const part = await waitForContinuationPart(tabId, providerKind, partTimeout, baseline);
    if (!part || part.length < 40) {
      log('warn', '[' + num + '/' + total + '] Continuation round ' + round + ' returned no usable HTML.');
      return '';
    }
    // If the model ignored "remaining only" and re-sent the WHOLE article,
    // the new reply may already be complete by itself — prefer it.
    const aloneVerify = verifyHtml(part, originalHtml, promptText, strictMode);
    const aloneComp = compOpts ? assessReplyCompleteness(part, originalHtml, compOpts) : { complete: true };
    if (aloneVerify.ok && aloneComp.complete && part.length > assembled.length * 0.9) {
      return part;
    }
    const before = assembled.length;
    assembled = stitchHtmlParts(assembled, part);
    log('info', '[' + num + '/' + total + '] Continuation round ' + round + ' added ' + (assembled.length - before) + ' chars (total ' + assembled.length + ').');
    if (assembled.length <= before + 30) return '';
    const verify = verifyHtml(assembled, originalHtml, promptText, strictMode);
    const comp = compOpts ? assessReplyCompleteness(assembled, originalHtml, compOpts) : { complete: true };
    if (verify.ok && comp.complete) return assembled;
  }
  return '';
}

// Wait for the NEW reply (after a continue prompt) to settle and return its
// largest HTML code candidate. Baseline assistant count keeps us from grabbing
// the previous (truncated) reply's box.
async function waitForContinuationPart(tabId, providerKind, timeoutMs, baselineAssistantCount) {
  const start = Date.now();
  let lastKey = '';
  let lastChangeAt = 0;
  let best = null;
  let stoppedPolls = 0;
  while (Date.now() - start < timeoutMs) {
    while (runtime.paused && !runtime.stopRequested) await sleep(500);
    if (runtime.stopRequested) return '';
    let snapshot = null;
    let probe = null;
    try { await runInTab(tabId, dismissBlockingDialogs); } catch (e) {}
    try { snapshot = (await runInTab(tabId, readAICodeSnapshot, [providerKind]))?.result || null; } catch (e) {}
    try { probe = (await runInTab(tabId, probeAISend, [providerKind]))?.result || null; } catch (e) {}
    const now = Date.now();
    const replyStarted = !baselineAssistantCount ||
      (probe && probe.assistantCount > baselineAssistantCount) ||
      snapshot?.stillGenerating === true;
    if (replyStarted && snapshot?.candidates?.length) {
      const cand = snapshot.candidates
        .filter(c => c.fromAssistantMessage)
        .map(c => normalizeCodeText(c.text || ''))
        .filter(t => t.length > 40 && /<[a-z][\s\S]*>/i.test(t))
        .sort((x, y) => y.length - x.length)[0] || null;
      if (cand) {
        const key = stableTextKey(cand);
        if (key !== lastKey) { lastKey = key; best = cand; lastChangeAt = now; }
      }
    }
    if (!snapshot?.stillGenerating) stoppedPolls++; else stoppedPolls = 0;
    if (best && lastChangeAt) {
      const stable = now - lastChangeAt;
      if ((stoppedPolls >= 2 && stable >= 6000) || stable >= 30000) {
        // The new reply's code card may be collapsed — the page's own copy
        // mechanism returns its complete text.
        const copied = await tryCopyRaw(tabId, providerKind);
        if (copied && copied.length > best.length && /<[a-z][\s\S]*>/i.test(copied)) return copied;
        return best;
      }
    }
    await sleep(2500);
  }
  return best || '';
}

function shouldSendNoCodeRecovery(providerKind, assistantPreview) {
  // Any provider that finished without a usable code block gets one nudge to
  // re-output the whole article inside a single ```html block.
  return true;
}

function looksLikeGrokProgress(assistantPreview) {
  const text = String(assistantPreview || '').toLowerCase();
  if (!text) return false;
  if (/request was interrupted|interrupted by the user/.test(text)) return false;
  if (/[•·]\s*\d+s\b/.test(text)) return true;
  if (/^\s*thoughts\b/.test(text) || /\b(thinking|reasoning)\b/.test(text)) return true;
  return /\b(formatting|editing|rewriting|writing|creating|generating|analyzing|processing|updating|building|preparing|researching|browsing|searching)\b/.test(text) &&
    !/```|<article|<section|<div|<p[\s>]|<!doctype|<html/i.test(text);
}

function looksLikeGrokBadFinal(assistantPreview) {
  const text = String(assistantPreview || '').toLowerCase();
  if (!text) return false;
  if (/request was interrupted|interrupted by the user/.test(text)) return false;
  return /\b(browsed|searched web|search results|0 results|no results|amazon\.com|could not find|couldn't find|unable to find)\b/.test(text) &&
    !/```|<article|<section|<div|<p[\s>]|<!doctype|<html/i.test(text);
}

function buildNoCodeRecoveryPayload(promptText, sourceHtml, providerKind) {
  return 'The previous response did not contain usable article HTML. Retry the task and follow the saved instructions exactly.\n\n' +
    buildAIPayload(promptText, sourceHtml);
}

// ──────────────────────────────────────────────────────────────────────
// AI prompt sender
// ──────────────────────────────────────────────────────────────────────
// Sleep that returns as soon as the user presses Stop, so no wait can hold a
// batch open after the decision to stop has been made.
async function stopSleep(ms) {
  const until = Date.now() + Math.max(0, Number(ms) || 0);
  while (Date.now() < until) {
    if (runtime.stopRequested) return;
    await sleep(Math.min(250, Math.max(0, until - Date.now())));
  }
}

// Throws the standard user-stop error; callers already treat USER_STOPPED as
// "leave this post untouched and unwind".
function throwIfStopped() {
  if (!runtime.stopRequested) return;
  const e = new Error('Stopped by user');
  e.code = 'USER_STOPPED';
  throw e;
}

async function sendPromptToAI(tabId, payload, providerKind, options) {
  const opts = options || {};
  // Configurable settle time between pasting the prompt and pressing send.
  // Big prompts need a moment to register (ChatGPT converts large pastes into
  // a "Pasted text" attachment; ProseMirror re-renders) before send is safe.
  const pasteWaitMs = Math.max(1000, Math.min(30000, (Number(runtime.job?.pasteWait) || 1) * 1000));
  // Fast Submit's own "Prompt paste wait": counted only AFTER the paste has
  // been verified, and never applied to a normal Start Batch run.
  const extraPasteWaitMs = Math.max(0, Number(opts.extraPasteWaitMs) || 0);
  let lastError = 'AI input box not found.';

  // Baselines so we can tell when OUR message actually went out. Counting the
  // user's own bubbles (not only assistant replies) catches slow providers and
  // kills the main cause of double-sent prompts: a send that succeeded but was
  // not confirmed in time, followed by a refill + re-submit.
  let baseAssistant = 0;
  let baseUser = 0;
  try {
    const b = (await runInTab(tabId, probeAISend, [providerKind]))?.result;
    baseAssistant = b?.assistantCount || 0;
    baseUser = b?.userCount || 0;
  } catch (e) {}
  const strongSubmitSignal = (p) => !!p && (
    p.assistantCount > baseAssistant ||
    (typeof p.userCount === 'number' && p.userCount > baseUser) ||
    p.generating === true
  );

  // How many times the whole paste → verify → send cycle may run. Fast Submit
  // exposes this as "Paste retries"; every other run keeps the classic 3.
  const maxAttempts = Math.max(1, Math.min(3, Number(opts.maxAttempts) || 3));
  // The budget has to be paid for out of what a cycle really costs, not a flat
  // 60s: pasting a large article, polling the composer for up to 12s (twice,
  // when Fast Submit adds its own pre-send wait), up to 12s finding the send
  // button and 20s confirming the send already exceed it. Under the old figure
  // the deadline expired inside attempt 1, so "Paste retries: 3" quietly meant
  // one attempt — and on Gemini, which is slower at every one of those steps,
  // that one attempt was often the one that failed.
  const perAttemptMs = 75000 + pasteWaitMs + extraPasteWaitMs;
  const deadline = Date.now() + perAttemptMs * maxAttempts;
  let outOfTime = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // The budget gates STARTING another paste, never finishing one.
    if (attempt > 1 && Date.now() >= deadline) {
      outOfTime = true;
      log('warn', (opts.tag ? opts.tag + ' ' : '') +
        'Out of time for another paste attempt — not starting attempt ' + attempt + '.');
      break;
    }
    if (runtime.stopRequested) return { ok: false, stopped: true, error: 'Stopped by user before the prompt was sent.' };
    if (attempt > 1) {
      // Never paste a second time into a limited provider: it cannot send, so
      // a retry only stacks another attachment. Pause instead.
      const limited = await checkAIModelLimit(tabId, providerKind, opts.tag);
      if (limited && limited.limited) {
        log('warn', (opts.tag ? opts.tag + ' ' : '') + '⛔ Limit detected before retrying the paste — not trying again.');
        return { ok: false, limited: true, limitDetection: limited, error: 'AI limit reached — the prompt was not retried.' };
      }
    }
    if (attempt > 1) {
      log('warn', (opts.tag ? opts.tag + ' ' : '') + '↻ Paste attempt ' + attempt + ' of ' + maxAttempts + ' — the previous one did not verify.');
    }
    // If a previous attempt actually went through and verification just missed
    // it, do NOT type and send the same prompt again.
    if (attempt > 1) {
      let pre = null;
      try { pre = (await runInTab(tabId, probeAISend, [providerKind]))?.result; } catch (e) {}
      if (strongSubmitSignal(pre)) {
        return { ok: true, method: 'confirmed late — resend skipped' };
      }
    }
    let fillKind = 'composer';
    let fillAttachment = false;

    // 1) Type the prompt into the composer. Cookie banners, "stay logged out"
    //    upsells and model dialogs cover the composer and make every selector
    //    miss it, so clear them first.
    try { await runInTab(tabId, dismissBlockingDialogs); } catch (e) {}
    try {
      const fill = await runInTab(tabId, fillAIComposer, [payload, await isTabThrottled(tabId)]);
      if (!fill?.result?.ok) {
        lastError = fill?.result?.error || lastError;
        // Give a re-mounting composer a moment before the next attempt.
        await sleep(2500);
        continue;
      }
      fillKind = fill.result.kind || fillKind;
      fillAttachment = !!fill.result.attachment;
    } catch (e) { lastError = e.message; await sleep(1200); continue; }

    await stopSleep(pasteWaitMs);
    if (runtime.stopRequested) return { ok: false, stopped: true, error: 'Stopped by user during the paste settle.' };

    // 2) PASTE VERIFICATION — the prompt must still be in the composer. A
    //    provider re-render can silently discard it after the fill reported
    //    success; sending then creates an empty chat with a valid-looking
    //    link. Never press Send against an empty composer — re-fill instead.
    await pumpFrozenTab(tabId);
    let filled = await checkComposerFilled(tabId, payload.length, fillAttachment);
    if (!filled.ok) {
      lastError = 'Paste verification failed before sending — ' + filled.reason + '. Nothing was sent; retrying the paste.';
      log('warn', (opts.tag ? opts.tag + ' ' : '') + lastError);
      await sleep(1200);
      continue;
    }
    log('ok', (opts.tag ? opts.tag + ' ' : '') + '✓ Paste verified (' +
      (filled.attachment ? 'attachment chip' : filled.len + ' chars in the composer') + ') — ready to send.');

    // 2b) Fast Submit only: hold for the user's "Prompt paste wait" so the
    //     provider fully registers a large paste before the click. Pause
    //     freezes it; Stop aborts without sending.
    if (extraPasteWaitMs > 0) {
      const gate = await waitBeforeSendWithGate(extraPasteWaitMs, opts.tag);
      if (gate.stopped) {
        return { ok: false, stopped: true, error: 'Stopped during the pre-send wait — the prompt was NOT sent.' };
      }
      // The long wait is exactly when a re-render can strike: verify again.
      filled = await checkComposerFilled(tabId, payload.length, fillAttachment);
      if (!filled.ok) {
        lastError = 'The composer lost the prompt during the pre-send wait (' + filled.reason + '). Nothing was sent; retrying the paste.';
        log('warn', (opts.tag ? opts.tag + ' ' : '') + lastError);
        await sleep(1000);
        continue;
      }
    }
    // Proof for step 3: the composer genuinely held the prompt at click time.
    const composerWasFull = true;

    // 3) Submit — wait for the real send button to become ENABLED rather than
    //    falling straight to a synthetic Enter (which ChatGPT/ProseMirror ignore).
    let submitMethod = '';
    let clickedButton = false;
    let submitTried = false;
    // ChatGPT keeps Send DISABLED while a "Pasted text" attachment uploads, so
    // attachment mode gets a much longer window to see the button go live
    // before falling back to a synthetic Enter (which ProseMirror ignores).
    // NOT clamped to the overall budget. The prompt is sitting verified in the
    // composer at this point; abandoning it here wastes the whole attempt and
    // reports a button that was never looked for.
    const submitDeadline = Date.now() + (fillAttachment ? 40000 : 12000);
    // The send button enables itself through the provider's own change
    // detection, which a hidden window does not run. Bring the window back and
    // keep the lifecycle turning while we wait, or Gemini's button stays
    // disabled for the whole window and every post falls back to Enter.
    try { await reviveHiddenWindowFor(tabId, 'before pressing Send'); } catch (e) {}
    const submitStarted = Date.now();
    let lastDiag = '';
    while (Date.now() < submitDeadline) {
      if (runtime.stopRequested) return { ok: false, stopped: true, error: 'Stopped by user while waiting for the send button.' };
      // After a few seconds of a stubbornly disabled button, stop waiting and
      // let the page function press Enter instead of failing the whole post.
      const forceEnter = (Date.now() - submitStarted) > 6000;
      await pumpFrozenTab(tabId);
      let submit = null;
      try { submit = (await runInTab(tabId, submitAIComposer, [forceEnter]))?.result; } catch (e) { lastError = e.message; }
      if (submit?.diag) lastDiag = submit.diag;
      if (submit?.ok) { submitMethod = submit.method || 'submit'; clickedButton = !!submit.clickedButton; submitTried = true; break; }
      if (submit?.method === 'button-disabled') {
        // Wake the provider's own model so the button can enable itself.
        try { await runInTab(tabId, nudgeComposerInput); } catch (e) {}
        await sleep(700);
        continue;
      }
      lastError = submit?.error || 'AI send button not found.';
      await sleep(700);
    }

    // 4) Verify the message actually went out (new user bubble / new reply /
    //    generating / composer cleared). 20s window — 12s was short enough for
    //    a slow provider to be wrongly "unconfirmed" and re-sent.
    let submitted = false;
    // Also unclamped: having pressed Send, we must find out whether it went
    // out. Giving up here is what caused duplicate prompts on the retry.
    const verifyDeadline = Date.now() + 20000;
    while (Date.now() < verifyDeadline) {
      if (runtime.stopRequested) break;
      let p = null;
      try { p = (await runInTab(tabId, probeAISend, [providerKind]))?.result; } catch (e) {}
      // "Composer is now empty" only proves a send when the composer was
      // verified FULL immediately before the click (composerWasFull). Without
      // that guard an empty box — i.e. a paste that never landed — was being
      // reported as a successful submission.
      if (strongSubmitSignal(p) || (composerWasFull && !fillAttachment && p && p.composerLen < 5)) { submitted = true; break; }
      await sleep(800);
    }

    if (submitted) {
      return { ok: true, method: fillKind + ' + ' + (submitMethod || 'submit') + (clickedButton ? '' : ' (no send button — used Enter)') };
    }
    lastError = submitTried
      ? 'Prompt typed and ' + (submitMethod || 'submit') + ' triggered, but submission was not confirmed.'
      : 'Prompt typed but no usable send button appeared' + (lastDiag ? ' (saw: ' + lastDiag + ')' : '') + '.';
    log('warn', (opts.tag ? opts.tag + ' ' : '') + lastError);
    await sleep(1500);
  }
  if (outOfTime) {
    lastError = 'ran out of time after ' + maxAttempts + ' paste attempt(s) — last problem: ' + lastError;
  }
  return { ok: false, error: lastError };
}

// ──────────────────────────────────────────────────────────────────────
// Wait for AI composer to load (login/captcha checks)
// ──────────────────────────────────────────────────────────────────────
// A minimized window is not just throttled — Chrome does not lay its content
// out at all, so Gemini's Quill editor never sizes itself and "chat input did
// not become ready" is guaranteed no matter how long we wait. The only cure is
// for the window to be un-minimized. We therefore restore OUR OWN worker
// window (never the user's other windows) and immediately hand focus back to
// the panel, so the batch keeps running while the user works elsewhere.
let workerReviveLogged = false;
// Restore the window this run is using. `tabId` is one of OUR OWN work tabs,
// so the window is always one the batch itself opened or is driving — this
// never enumerates windows and never touches the user's other windows.
// Without a tab it falls back to the worker window, for the call that happens
// before the tab exists.
async function reviveHiddenWindowFor(tabId, reason) {
  let winId = runtime.workerWindowId;
  if (tabId) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t && t.windowId) winId = t.windowId;
    } catch (e) {}
  }
  if (!winId) return false;
  try {
    const win = await chrome.windows.get(winId);
    const needs = win.state === 'minimized' || (Number(win.width) || 0) < 500;
    if (!needs) return false;
    await chrome.windows.update(winId, { state: 'normal', focused: false });
    // Give it a workable size; a 17x24 viewport lays nothing out.
    try { await chrome.windows.update(winId, { width: 1100, height: 900 }); } catch (e) {}
    await sleep(900);
    // Windows frequently refuses to restore a window that is not being focused,
    // and a half-restored window renders exactly as badly as a minimized one.
    // Verify, and if it did not take, insist with focus and hand focus straight
    // back. Skipping this check is why reviving only worked about half the time.
    try {
      const after = await chrome.windows.get(winId);
      if (after.state === 'minimized' || (Number(after.width) || 0) < 500) {
        await chrome.windows.update(winId, { state: 'normal', focused: true });
        try { await chrome.windows.update(winId, { width: 1100, height: 900 }); } catch (e) {}
        await sleep(700);
      }
    } catch (e) {}
    // Push it back behind the panel so it does not steal the user's screen —
    // but only if the panel is on screen. Focusing a minimized window restores
    // it, so doing this blindly popped the user's panel back open every time
    // they minimized the browser.
    if (runtime.panelWindowId) {
      try {
        const panel = await chrome.windows.get(runtime.panelWindowId);
        if (panel && panel.state !== 'minimized') {
          await chrome.windows.update(runtime.panelWindowId, { focused: true });
        }
      } catch (e) {}
    }
    if (!workerReviveLogged) {
      workerReviveLogged = true;
      log('warn', '🪟 The AI window was minimized/collapsed' + (reason ? ' (' + reason + ')' : '') +
        '. Chrome does not lay out a minimized window, so the chat box never sizes itself. It has been restored and pushed behind the panel — leaving it open behind other windows is fine. To keep Chrome minimized for good, start it with --disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-renderer-backgrounding.');
    }
    return true;
  } catch (e) {
    return false;
  }
}

// For the call sites that have no tab yet.
async function reviveCollapsedWorkerWindow(reason) {
  return reviveHiddenWindowFor(null, reason);
}

// A batch runs for hours and the user can minimize Chrome at ANY point in it,
// not just while a tab is opening. Reviving only at tab-open and inside the
// readiness loop left every other stage — sending, streaming, extracting,
// updating — exposed, which is why minimizing failed roughly half the time
// rather than always. This runs off the 30s keep-alive alarm for as long as a
// run is active, so a window minimized mid-reply is back within half a minute.
let lastHiddenWatchdogAt = 0;
async function keepWorkWindowUsable() {
  try {
    if (!runtime.running || runtime.stopRequested) return;
    const now = Date.now();
    if (now - lastHiddenWatchdogAt < 20000) return;
    lastHiddenWatchdogAt = now;
    const ids = Array.isArray(runtime.trackedTabs) ? runtime.trackedTabs.slice(-3) : [];
    let touched = false;
    for (const id of ids) {
      if (!(await tabExists(id))) continue;
      touched = true;
      await pumpFrozenTab(id);
      await reviveHiddenWindowFor(id, 'the browser was minimized during the run');
    }
    if (!touched) await reviveCollapsedWorkerWindow('the browser was minimized during the run');
  } catch (e) {}
}

async function waitForAIComposerReady(tabId, timeoutMs, providerKind) {
  const start = Date.now();
  let lastIssue = '';
  let lastError = '';
  let lastSnapshot = null;
  let nudged = false;
  let reloaded = false;
  let lastReviveAt = -99999;
  let frozenTicks = 0;
  let sawFrozen = false;

  while (Date.now() - start < timeoutMs) {
    while (runtime.paused && !runtime.stopRequested) await sleep(500);
    if (runtime.stopRequested) return { ok: false, error: 'Stopped by user.' };

    const elapsed = Date.now() - start;
    // THE MINIMIZED-GEMINI FIX. Chrome suspends the rendering lifecycle of a
    // hidden window, and Gemini's Quill composer is waiting on a ResizeObserver
    // that the suspension swallows — so it never sizes itself and this loop
    // times out with "chat input did not become ready". Pumping from here (the
    // service worker, which Chrome never throttles) delivers those callbacks.
    const health = await pumpFrozenTab(tabId);
    if (health && health.frozen) { frozenTicks++; sawFrozen = true; } else if (health) { frozenTicks = 0; }
    try { await runInTab(tabId, dismissBlockingDialogs); } catch (e) {}
    try {
      const r = await runInTab(tabId, inspectAIProviderPage, [providerKind]);
      const snapshot = r?.result || {};
      lastSnapshot = snapshot;
      if (snapshot.composerReady) return { ok: true };
      if (snapshot.providerIssue) lastIssue = snapshot.providerIssue;
    } catch (e) { lastError = e.message || ''; }

    // A collapsed viewport means the window is minimized: restore it rather
    // than burning the whole 90s timeout. Checked early and re-checked, since
    // the user may minimize Chrome again mid-run.
    const vp = lastSnapshot && lastSnapshot.viewport;
    const collapsed = !!(vp && vp.w > 0 && vp.w < 500);
    // A frozen renderer with a NORMAL viewport is the other half of this bug:
    // the window is not minimized but fully covered by another window, which
    // Chrome throttles identically. The old check only looked at the viewport,
    // so that case was never rescued at all.
    const stuckHidden = frozenTicks >= 3;
    if ((collapsed || stuckHidden) && (elapsed >= 4000) && (elapsed - lastReviveAt > 12000)) {
      lastReviveAt = elapsed;
      const revived = await reviveHiddenWindowFor(
        tabId,
        collapsed ? (vp.w + 'x' + vp.h + ' viewport') : 'no animation frame for ' + frozenTicks + ' checks'
      );
      if (revived) { frozenTicks = 0; await sleep(1500); }
    }

    if (isBackgroundMode() && !nudged && elapsed >= 25000 && providerKind === 'claude') {
      nudged = true;
      try {
        if (runtime.workerWindowId) { await chrome.windows.update(runtime.workerWindowId, { focused: true }); await sleep(500); }
        await focusPanelIfVisible();
      } catch (e) {}
    }

    if (!reloaded && elapsed >= 70000 && providerKind === 'claude' && !lastIssue) {
      reloaded = true;
      try {
        await chrome.tabs.reload(tabId);
        await sleep(3500);
      } catch (e) {}
    }
    await sleep(1000);
  }

  if (lastIssue) return { ok: false, error: lastIssue + '. AI tab left open for review.' };
  // Say plainly when the browser being hidden is what went wrong, and how to
  // stop it happening again.
  if (sawFrozen && frozenTicks >= 3) {
    return {
      ok: false,
      error: 'the browser kept this tab\'s rendering frozen (no animation frame for ' + frozenTicks +
        ' checks in a row), so the chat box never sized itself. Chrome does this to a window that is minimized or ' +
        'completely covered. Start Chrome with --disable-backgrounding-occluded-windows ' +
        '--disable-background-timer-throttling --disable-renderer-backgrounding to keep working while minimized.'
    };
  }
  // A collapsed viewport is the classic minimized-window symptom; say so
  // instead of leaving the user guessing about login/network.
  if (lastSnapshot?.viewport && lastSnapshot.viewport.w > 0 && lastSnapshot.viewport.w < 400) {
    return {
      ok: false,
      error: 'the AI page reports a collapsed ' + lastSnapshot.viewport.w + 'x' + lastSnapshot.viewport.h +
        ' viewport, so its composer never laid out. This happens when the browser window is minimized or sized to almost nothing — ' +
        'leave the worker window open (it can sit behind other windows) instead of minimizing it.'
    };
  }
  return {
    ok: false,
    error: 'chat input did not become ready within ' + Math.round(timeoutMs / 1000) +
      's. Check login, browser verification, network, or rate limit.' +
      (lastSnapshot?.url ? ' Current page: ' + lastSnapshot.url + '.' : '') +
      (lastSnapshot?.readyState ? ' ReadyState: ' + lastSnapshot.readyState + '.' : '') +
      (lastSnapshot?.composerHint ? ' Seen: ' + lastSnapshot.composerHint + '.' : '') +
      (lastError ? ' Last check: ' + lastError : '')
  };
}

async function waitForUpdateSuccess(tabId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await runInTab(tabId, checkUpdateSuccess);
      if (r?.result === true) return true;
    } catch (e) {}
    await sleep(800);
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────
// Slug cleaning
// ──────────────────────────────────────────────────────────────────────
function cleanSlug(text) {
  let slug = (text || '').trim();
  slug = slug.replace(/^https?:\/\/[^\/]+/i, '');
  // Drop query strings and fragments BEFORE taking the last path segment —
  // otherwise "https://site.com/my-post/?utm_source=x" became slug "?utm_source=x".
  slug = slug.split(/[?#]/)[0];
  slug = slug.replace(/^[\s\/\n\r]+|[\s\/\n\r]+$/g, '');
  if (slug.includes('/')) {
    const parts = slug.split('/').filter(p => p.length > 0);
    if (parts.length > 0) slug = parts[parts.length - 1];
  }
  slug = slug.replace(/[\s\n\r]+/g, '-');
  return slug;
}

// ──────────────────────────────────────────────────────────────────────
// HTML verification (loose size-only safety)
// ──────────────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════
// COMPLETENESS GATE — is this the FULL article, or did the AI stop early?
// Several independent signals decide; an accepted response must look finished
// by CONTENT, not merely because the on-screen code box stopped changing.
// ══════════════════════════════════════════════════════════════════════
function completenessOptions() {
  const level = runtime.job?.completeness || 'balanced';
  if (level === 'off') return null;
  if (level === 'strict') return { level: 'strict', minCoverage: 0.92, sectionRatio: 0.85, maxUnclosed: 0 };
  return { level: 'balanced', minCoverage: 0.85, sectionRatio: 0.70, maxUnclosed: 1 };
}

function countTag(html, tag) {
  const open = (html.match(new RegExp('<' + tag + '(?=[\\s/>])', 'gi')) || []).length;
  const close = (html.match(new RegExp('</' + tag + '\\s*>', 'gi')) || []).length;
  return { open, close };
}

function endsCleanly(html) {
  const s = String(html || '').replace(/ /g, ' ').replace(/```+\s*$/,'').trimEnd();
  if (!s) return false;
  // Unterminated final tag: a '<' with no closing '>' after it = cut mid-tag.
  if (s.lastIndexOf('<') > s.lastIndexOf('>')) return false;
  // Ends exactly on an OPENING (non-void) tag with nothing after = cut right
  // after a tag opened, e.g. "...<div class=\"product\">".
  const m = s.slice(-240).match(/<([a-z][a-z0-9]*)\b[^>]*>$/i);
  if (m) {
    const name = m[1].toLowerCase();
    const isClosing = /^<\//.test(m[0]);
    const voidTags = ['img','hr','br','input','source','meta','link','col','area','base','embed','track','wbr'];
    if (!isClosing && voidTags.indexOf(name) === -1) return false;
  }
  return true;
}

function assessHtmlCompleteness(html, originalHtml, options) {
  const opts = options || {};
  const minCoverage = typeof opts.minCoverage === 'number' ? opts.minCoverage : 0.85;
  const sectionRatio = typeof opts.sectionRatio === 'number' ? opts.sectionRatio : 0.70;
  const maxUnclosed = typeof opts.maxUnclosed === 'number' ? opts.maxUnclosed : 1;
  const out = String(html || '');
  const src = String(originalHtml || '');
  const reasons = [];
  const coverage = src.length ? out.length / src.length : 1;

  // 1) Gross length vs source — a "half article" is far shorter than the source.
  if (src.length && coverage < minCoverage) {
    reasons.push('only ' + Math.round(coverage * 100) + '% of the source length (' + out.length + ' vs ' + src.length + ' chars)');
  }
  // 2) Clean ending — not cut mid-element.
  if (!endsCleanly(out)) {
    reasons.push('it ends mid-element (looks cut off)');
  }
  // 3) Container-tag balance — wrappers that were opened but never closed.
  let unclosed = 0;
  ['div','section','article','ul','ol','table','figure','blockquote'].forEach((tag) => {
    const c = countTag(out, tag);
    if (c.open - c.close > 0) unclosed += (c.open - c.close);
  });
  if (unclosed > maxUnclosed) reasons.push(unclosed + ' unclosed container tag(s)');
  // 4) Full-document parity.
  if (/<html[\s>]/i.test(out) && !/<\/html\s*>/i.test(out)) reasons.push('<html> was never closed');
  if (/<body[\s>]/i.test(out) && !/<\/body\s*>/i.test(out)) reasons.push('<body> was never closed');
  // 5) Section parity — fewer headings than the source. This USED to hard-fail
  // the article on its own, but editing prompts that redesign components or
  // merge sections legitimately reduce heading counts (e.g. H2 sections turned
  // into styled cards). So a heading deficit ALONE is only treated as
  // truncation when the document does not otherwise look finished: any hard
  // failure above, or no finished-looking tail (closing </html> or a
  // conclusion-style final section).
  // v3.46.0: a reply that ENDS with the <!-- APU-END --> marker the prompt
  // asked for was not cut off, so it has a finished tail too (the Safety Gate
  // judges lost content). Without this, the prompt's own FAQ-accordion
  // rebuild (H3 questions → <details>) made complete edits look truncated.
  const srcH = (src.match(/<h[23][\s>]/gi) || []).length;
  const outH = (out.match(/<h[23][\s>]/gi) || []).length;
  if (srcH >= 3 && outH < Math.ceil(srcH * sectionRatio)) {
    const tail = out.replace(/```+\s*$/, '').trim();
    const finishedTail = /<\/html\s*>\s*$/i.test(tail) || hasConclusionMarker(out) || /<!--\s*APU-END\s*-->$/i.test(tail);
    if (reasons.length > 0 || !finishedTail) {
      reasons.push(outH + ' of ~' + srcH + ' section headings present (sections look missing)');
    }
  }
  return { complete: reasons.length === 0, coverage, reasons };
}

// v3.46.0: the completeness check for a FINAL reply (every place that
// accepts or rejects one: waitForAIResponse, the copy-button paths, the
// continuation stitcher, recovery, API mode and the final web check). With
// the Safety Gate on, a Safety Gate prompt (it asks for <!-- APU-END -->) and
// the marker in the extracted HTML, the reply was not cut off, so it is NOT
// rejected for the character-coverage signal alone: cleaning up messy markup
// (Word / Google Docs <span style> clutter) can legitimately shrink the HTML
// by more than 15%. Every other completeness signal stays, and the gate's
// own word-based CONTENT_LOSS / CONTENT_RETENTION still judge lost text.
// result.coverageWaived = true when the coverage alone would have failed.
function assessReplyCompleteness(html, originalHtml, options) {
  const markerOk = safetyGateOn() && promptRequiresEndMarker() && /<!--\s*APU-END\s*-->/i.test(String(html || ''));
  if (!markerOk) return assessHtmlCompleteness(html, originalHtml, options);
  const res = assessHtmlCompleteness(html, originalHtml, Object.assign({}, options || {}, { minCoverage: 0 }));
  const minCoverage = (options && typeof options.minCoverage === 'number') ? options.minCoverage : 0.85;
  res.coverageWaived = String(originalHtml || '').length > 0 && res.coverage < minCoverage;
  return res;
}

// POST-SAVE AUDIT (report-only, no AI) — runs only on successfully saved posts.
// Confirms the saved article came through whole (intro present, ends cleanly,
// the original's final section is present, images kept, no placeholders or
// leaked report text). Returns a short report string and takes NO action.
function lastSectionLandmark(html) {
  const heads = [...String(html || '').matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)]
    .map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return heads.length ? heads[heads.length - 1] : '';
}

// Visible heading texts, in document order.
function extractHeadings(html) {
  return [...String(html || '').matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)]
    .map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// True when the HTML appears to contain an FAQ -- by heading text, the word FAQ,
// or FAQPage schema -- so it still matches after the FAQ is rebuilt as accordions.
function hasFaqSignal(html) {
  const s = String(html || '');
  if (/"@type"\s*:\s*"FAQPage"/i.test(s)) return true;
  const text = s.replace(/<[^>]+>/g, ' ');
  return /frequently\s+asked\s+questions/i.test(text) || /(^|[^a-z])FAQs?([^a-z]|$)/.test(text);
}

// True when any heading reads like a conclusion / summary section.
function hasConclusionHeading(html) {
  return extractHeadings(html).some(h =>
    /\b(conclusion|final thoughts|final verdict|bottom line|wrap[- ]?up|in summary|the verdict)\b/i.test(h));
}

// Lenient "is this original heading still represented in the output?" test.
// Present if the whole heading survives OR if ANY meaningful word from it appears
// anywhere in the output, so a reworded heading is NOT flagged but a section
// whose words vanish entirely IS.
function headingStillPresent(heading, outText) {
  const norm = compactVisibleText(heading);
  if (!norm) return true;
  if (outText.includes(norm)) return true;
  const stop = new Set(['the','and','for','with','your','you','are','that','this','from','what','how','why','when','best','review','reviews','guide','about','into','over','more','tips','top']);
  const tokens = norm.split(' ').filter(w => w.length >= 4 && !stop.has(w));
  if (!tokens.length) return true;
  return tokens.some(w => outText.includes(w));
}

// POST-SAVE AUDIT -- reads the FULL original article, then the saved (AI-modified)
// article, and flags anything that went missing or broke between the two. Pure
// comparison + structure; takes NO action. The "audit OK" / "AUDIT ISSUES" prefix
// drives the panel colours, the Audit Issues box, and the retry logic.
function auditSavedArticle(originalHtml, newHtml) {
  const out = String(newHtml || '');
  const src = String(originalHtml || '');
  const issues = [];

  // ---- Structure of the saved (modified) article ----
  const firstTag = (out.match(/<([a-z0-9]+)\b/i) || [])[1];
  if (firstTag && /^h[1-6]$/i.test(firstTag)) issues.push('starts with a heading, not an intro paragraph');

  if (!endsCleanly(out)) issues.push('ends mid-element (looks cut off)');

  let unclosed = 0;
  ['div','section','article','ul','ol','table','figure','blockquote'].forEach((t) => {
    const c = countTag(out, t); if (c.open - c.close > 0) unclosed += (c.open - c.close);
  });
  if (unclosed > 0) issues.push(unclosed + ' unclosed container tag(s)');

  const ph = [];
  if (/\(rest unchanged\)/i.test(out)) ph.push('(rest unchanged)');
  if (/\bhref=["']#["']/.test(out)) ph.push('href="#"');
  if (/REAL-URL|Source name|add your link/i.test(out)) ph.push('template text');
  if (ph.length) issues.push('placeholder(s): ' + ph.join(', '));

  if (/AUDIT REPORT|FIXED ARTICLE|PART 1\s*[\u2014\u2013-]\s*(DEEP AUDIT|AUDIT|FIX)|Fact-check & freshness|Topic-coverage gaps|Rank Math suggestions/i.test(out)) issues.push('audit-report text leaked in');

  // ---- Compare the ORIGINAL against the MODIFIED -- guess what went missing ----
  const coverage = src.length ? Math.round((out.length / src.length) * 100) : 100;
  if (src) {
    const outText = compactVisibleText(out);

    // Every original image must survive.
    const origImgs = [...src.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map(m => m[1]);
    const missingImgs = origImgs.filter(u => out.indexOf(u) === -1);
    if (missingImgs.length) issues.push(missingImgs.length + ' of ' + origImgs.length + ' original image(s) missing');

    // Overall length.
    if (out.length < src.length * 0.6) issues.push('short: only ' + coverage + '% of the original length');

    // FAQ / Conclusion are kept if the original had them.
    if (hasFaqSignal(src) && !hasFaqSignal(out)) issues.push('FAQ from the original is missing');
    if (hasConclusionHeading(src) && !hasConclusionHeading(out)) issues.push('Conclusion from the original is missing');

    // Section headings: skip the first (the title is intentionally removed) and
    // any FAQ heading (handled above). Flag sections whose words vanish entirely.
    const bodyHeads = extractHeadings(src).slice(1)
      .filter(h => !/frequently\s+asked|(^|[^a-z])faqs?([^a-z]|$)/i.test(h));
    const missingHeads = bodyHeads.filter(h => h.length >= 3 && !headingStillPresent(h, outText));
    if (missingHeads.length) {
      const names = missingHeads.slice(0, 3).map(h => '"' + h.slice(0, 32) + '"').join(', ');
      issues.push(missingHeads.length + ' original section(s) missing: ' + names + (missingHeads.length > 3 ? ' and more' : ''));
    }

    // Body shrink -- paragraphs removed rather than reworded.
    const fpSrc = htmlFingerprint(src), fpOut = htmlFingerprint(out);
    if (fpSrc.paragraphs >= 4 && fpOut.paragraphs < fpSrc.paragraphs * 0.5) {
      issues.push('paragraphs dropped from ' + fpSrc.paragraphs + ' to ' + fpOut.paragraphs + ' (content may be missing)');
    }
  }

  if (!issues.length) return 'audit OK: complete (intro present, sections, images & FAQ preserved, ends cleanly' + (src.length ? ', ' + coverage + '% length' : '') + ')';
  return 'AUDIT ISSUES: ' + issues.join('; ');
}

// Manual "Recover session any code" verification. This deliberately ignores
// source-length, completeness, and "identical to source" checks, but still
// refuses prose, prompt leakage, audit reports, and non-HTML clipboard data.
// Does this HTML contain the three sections that make an article complete:
// an introduction, a FAQ, and a conclusion? Used by the "Intro/FAQ/Conclusion"
// recovery, which accepts a saved chat's HTML on that basis instead of the
// full completeness comparison against the original.
function hasIntroFaqConclusion(html) {
  const text = String(html || '');
  if (text.length < 300) return { ok: false, missing: ['too short'] };

  const headings = [];
  const re = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1\s*>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    headings.push(m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase());
  }
  const anyHeading = (rx) => headings.some((h) => rx.test(h));

  // FAQ: a heading that says so.
  const hasFaq = anyHeading(/\bfaq\b|frequently asked|common questions|questions? (?:and|&) answers?/i);

  // Conclusion: the usual closing headings.
  const hasConclusion = anyHeading(/conclusion|final (?:thoughts|verdict|word)|bottom line|the verdict|wrap[- ]?up|our (?:take|pick)|summary/i);

  // Introduction: either an explicit heading, or real body text before the
  // first section heading (how most articles actually open).
  let hasIntro = anyHeading(/introduction|intro\b|overview/i);
  if (!hasIntro) {
    const firstHeading = text.search(/<h[23][\s>]/i);
    // firstHeading === 0 means the article opens straight into a heading, so
    // there is no lead at all; only -1 (no headings) means read from the top.
    const lead = (firstHeading >= 0 ? text.slice(0, firstHeading) : text.slice(0, 1500))
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    hasIntro = lead.length >= 200;
  }

  const missing = [];
  if (!hasIntro) missing.push('introduction');
  if (!hasFaq) missing.push('FAQ');
  if (!hasConclusion) missing.push('conclusion');
  return { ok: missing.length === 0, missing };
}

// Audit-report text in the first 4000 chars of an extracted article.
// Gate OFF: the v3.45.0 check (the phrase anywhere). Gate ON (v3.46.0): only a
// line that IS a report heading / divider ("── FIXED ARTICLE ──",
// "## AUDIT ISSUES", <h2>Full Audit Report</h2>) counts, and only when the
// original article does not have that line itself — "a fixed article of
// clothing" inside a paragraph is article text. The Safety Gate blocks any
// other stray report / chat text.
const REPORT_LEAK_RE = /Full Audit Report|Extracted Article Information|Prioritized Action Checklist|Complete Updated Body-Only HTML|AUDIT ISSUES|FIXED ARTICLE/i;
function reportLeakLineCount(html) {
  // Inline tags vanish, every other tag breaks the line: each element's text
  // becomes its own line.
  const text = String(html || '')
    .replace(/<\/?(?:a|abbr|b|code|em|i|mark|small|span|strong|sub|sup|u)\b[^>]*>/gi, '')
    .replace(/<[^>]*>/g, '\n');
  const re = /^[^A-Za-z0-9\n]{0,40}(?:\d+\.[^A-Za-z0-9\n]{0,10})?(?:PART[ \t]+\d+[^A-Za-z0-9\n]{0,10})?(?:Full Audit Report|Extracted Article Information|Prioritized Action Checklist|Complete Updated Body-Only HTML|AUDIT ISSUES|FIXED ARTICLE)\b[^\n]{0,60}$/gim;
  return (text.match(re) || []).length;
}
function hasReportLeak(html, originalHtml) {
  const head = String(html || '').slice(0, 4000);
  if (!safetyGateOn()) return REPORT_LEAK_RE.test(head);
  const n = reportLeakLineCount(head);
  return n > 0 && n > reportLeakLineCount(originalHtml);
}

function verifyRecoverableHtml(html, promptText) {
  const text = String(html || '').trim();
  if (text.length < 80) return { ok: false, reason: 'too little HTML to recover (' + text.length + ' chars)' };
  const promptLeak = detectPromptLeak(text, promptText);
  if (promptLeak) return { ok: false, reason: promptLeak };
  if (hasReportLeak(text, '')) {
    return { ok: false, reason: 'AI audit/report text leaked into extracted HTML' };
  }
  if (!/<[a-z][\s\S]*>/i.test(text)) return { ok: false, reason: 'no HTML tags found' };
  return { ok: true };
}

function verifyHtml(html, originalHtml, promptText, strictMode) {
  // Minimum size is relative to the source: a fixed 500-char floor rejected
  // every valid edit of genuinely short posts.
  const minLen = originalHtml && originalHtml.length
    ? Math.max(80, Math.min(500, Math.floor(originalHtml.length * 0.4)))
    : 500;
  if (!html || html.length < minLen) return { ok: false, reason: 'too short (' + (html?.length || 0) + ' chars)' };
  const promptLeak = detectPromptLeak(html, promptText);
  if (promptLeak) return { ok: false, reason: promptLeak };
  if (hasReportLeak(html, originalHtml)) {
    return { ok: false, reason: 'AI audit/report text leaked into extracted HTML' };
  }
  if (originalHtml && equivalentHtml(html, originalHtml)) {
    return { ok: false, reason: 'AI code is identical to source (no edit applied)' };
  }
  if (!/<[a-z][\s\S]*>/i.test(html)) return { ok: false, reason: 'no HTML tags found' };
  if (originalHtml && html.length < originalHtml.length * 0.30) {
    return { ok: false, reason: 'extracted HTML is too small vs original (' + html.length + ' vs ' + originalHtml.length + ' chars)' };
  }
  return { ok: true };
}

function equivalentHtml(left, right) {
  return compactHtmlForCompare(left) === compactHtmlForCompare(right);
}
function compactHtmlForCompare(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}
function detectPromptLeak(html, promptText) {
  const output = compactVisibleText(html);
  if (output.includes('source wordpress article html')) {
    return 'AI result contains the prompt wrapper instead of clean HTML';
  }
  const prompt = compactVisibleText(promptText);
  if (!prompt || prompt.length < 60) return null;
  const samples = [
    prompt.slice(0, 180),
    prompt.slice(Math.max(0, Math.floor(prompt.length * 0.25)), Math.floor(prompt.length * 0.25) + 180),
    prompt.slice(Math.max(0, Math.floor(prompt.length * 0.5)), Math.floor(prompt.length * 0.5) + 180)
  ].map(s => s.trim()).filter(s => s.length >= 60);
  if (samples.some(s => output.includes(s))) {
    return 'AI result contains prompt instruction text instead of only modified article HTML';
  }
  return null;
}
function compactVisibleText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[`*_>#]+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
function htmlFingerprint(html) {
  const count = (re) => (html.match(re) || []).length;
  return {
    chars: html.length,
    paragraphs: count(/<p[\s>]/gi),
    headings:   count(/<h[1-6][\s>]/gi),
    images:     count(/<img[\s>]/gi),
    links:      count(/<a[\s>]/gi),
    lists:      count(/<(ul|ol)[\s>]/gi),
    listItems:  count(/<li[\s>]/gi)
  };
}
function hasConclusionMarker(html) {
  const tail = String(html || '').slice(-2500).replace(/<[^>]+>/g, ' ').toLowerCase();
  return /\b(conclusion|final thoughts|final verdict|in summary|summary|bottom line|takeaway|wrap[- ]?up)\b/.test(tail);
}

function sleep(ms) {
  // Stop-aware sleep: any fixed wait wakes within ~200ms once the user presses
  // Stop, so the whole pipeline becomes responsive to Stop/Pause without having
  // to interrupt an in-progress save.
  return new Promise(resolve => {
    if (!(ms > 0) || runtime.stopRequested) return resolve();
    const step = ms < 200 ? ms : 200;
    let waited = 0;
    const id = setInterval(() => {
      waited += step;
      if (runtime.stopRequested || waited >= ms) { clearInterval(id); resolve(); }
    }, step);
  });
}

// ══════════════════════════════════════════════════════════════════════
// FUNCTIONS INJECTED INTO PAGES
// ══════════════════════════════════════════════════════════════════════

// ── WordPress: switch to HTML/code mode ─────────────────────────────
function prepareTabForClose() {
  try {
    window.onbeforeunload = null;
    window.onunload = null;
    window.addEventListener('beforeunload', (event) => {
      event.stopImmediatePropagation();
      event.preventDefault = function() {};
      delete event.returnValue;
    }, true);
  } catch (e) {}
  try {
    if (window.jQuery) window.jQuery(window).off('beforeunload');
  } catch (e) {}
  try {
    if (window.tinyMCE?.triggerSave) window.tinyMCE.triggerSave();
  } catch (e) {}
  return true;
}

function switchToCodeMode() {
  const t = document.querySelector('#content-html, button#content-html, .switch-html');
  if (t) { t.click(); return 'classic'; }
  try {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'm', code: 'KeyM', ctrlKey: true, shiftKey: true, altKey: true, bubbles: true
    }));
    return 'gutenberg';
  } catch (e) {}
  return 'none';
}

// ── WordPress: grab HTML from the editor ────────────────────────────
function grabHtmlFromEditor() {
  const c = document.querySelector('#content, textarea#content');
  if (c?.value?.trim().length > 30) return { html: c.value.trim() };
  const g = document.querySelector('.editor-post-text-editor, textarea.editor-post-text-editor');
  if (g?.value?.trim().length > 30) return { html: g.value.trim() };
  return { html: null };
}

// ── WordPress: clear + paste HTML ───────────────────────────────────
function clearAndPasteHtml(newHtml) {
  function setVal(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const c = document.querySelector('textarea#content');
  if (c) {
    const beforeLength = c.value.length;
    c.focus(); c.select(); c.setSelectionRange(0, c.value.length);
    setVal(c, ''); setVal(c, newHtml);
    c.setSelectionRange(c.value.length, c.value.length);
    return { kind: 'classic', beforeLength, afterLength: c.value.length, matches: c.value === newHtml };
  }
  const g = document.querySelector('.editor-post-text-editor, textarea.editor-post-text-editor');
  if (g) {
    const beforeLength = g.value.length;
    g.focus(); g.select();
    setVal(g, ''); setVal(g, newHtml);
    return { kind: 'gutenberg', beforeLength, afterLength: g.value.length, matches: g.value === newHtml };
  }
  return { kind: 'none', afterLength: 0, matches: false };
}

// ── WordPress: click UPDATE button (handles Gutenberg two-step) ────
function clickUpdateButton() {
  function visible(el) {
    const r = el?.getBoundingClientRect?.();
    return !!r && (r.width > 0 && r.height > 0 || (window.innerWidth || 0) < 500 || !document.documentElement?.getBoundingClientRect().width);
  }
  function labelOf(el) {
    return [
      el?.textContent,
      el?.value,
      el?.getAttribute?.('aria-label'),
      el?.getAttribute?.('title')
    ].filter(Boolean).join(' ').trim();
  }
  function findGutenbergConfirmButton() {
    const directSelectors = [
      'button.editor-post-publish-button',
      'button.editor-post-publish-panel__publish-button',
      '.editor-post-publish-panel button.is-primary',
      '.editor-post-publish-panel__content button.is-primary',
      '.components-modal__content button.is-primary'
    ];
    const direct = directSelectors.flatMap(sel => [...document.querySelectorAll(sel)]);
    const scoped = [...document.querySelectorAll(
      '.editor-post-publish-panel button, .editor-post-publish-panel__content button, .components-modal__content button'
    )];
    const seen = new Set();
    return direct.concat(scoped).find(btn => {
      if (!btn || seen.has(btn) || btn.disabled || !visible(btn)) return false;
      seen.add(btn);
      return /\b(update|publish|save)\b/i.test(labelOf(btn));
    }) || null;
  }
  function clickGutenbergConfirmSoon() {
    [500, 1200, 2400].forEach(delay => {
      setTimeout(() => {
        const confirmBtn = findGutenbergConfirmButton();
        if (confirmBtn) confirmBtn.click();
      }, delay);
    });
  }

  // Classic Editor: input#publish ("Update" when post is already published)
  let btn = document.querySelector('input#publish');
  if (btn) {
    const label = (btn.value || btn.textContent || '').trim();
    if (!/update/i.test(label)) {
      return { clicked: false, reason: 'Classic Editor button says "' + label + '", not UPDATE.' };
    }
    btn.click();
    return { clicked: true, kind: 'classic' };
  }
  // Gutenberg: look for "Update" button first (single-step for published posts)
  const updateBtns = [...document.querySelectorAll('button')].filter(b => {
    const txt = (b.textContent || '').trim();
    return /^update$/i.test(txt) && !b.disabled && visible(b);
  });
  if (updateBtns.length > 0) {
    updateBtns[0].click();
    clickGutenbergConfirmSoon();
    return { clicked: true, kind: 'gutenberg-update' };
  }

  // Gutenberg fallback: pre-publish toggle then confirm publish
  const toggleBtn = document.querySelector('button.editor-post-publish-panel__toggle, button.editor-post-publish-button__button');
  if (toggleBtn) {
    toggleBtn.click();
    clickGutenbergConfirmSoon();
    return { clicked: true, kind: 'gutenberg-toggle' };
  }
  return { clicked: false, reason: 'No UPDATE button found.' };
}

// ── WordPress: verify save confirmation ─────────────────────────────
function checkUpdateSuccess() {
  const okText = /\b(post|page)?\s*(updated|saved|published|draft saved|post published|page published)\b/i;
  const badText = /\b(update failed|saving failed|failed to update|could not update|error saving)\b/i;
  const statusSelectors = [
    '#message.updated',
    '#message',
    '.notice-success',
    '.updated.notice',
    '.components-snackbar',
    '.components-notice--success',
    '.components-notice',
    '.editor-post-saved-state',
    '[role="status"]',
    '[aria-live]'
  ].join(',');
  const statusText = [...document.querySelectorAll(statusSelectors)]
    .map(el => (el.innerText || el.textContent || '').trim())
    .filter(Boolean)
    .join(' ');
  if (badText.test(statusText)) return false;
  if (okText.test(statusText)) return true;

  try {
    const params = new URL(location.href).searchParams;
    if (/\/wp-admin\/post\.php$/i.test(location.pathname) && params.has('message')) return true;
  } catch (e) {}

  try {
    const editor = window.wp?.data?.select?.('core/editor');
    if (editor) {
      const isSaving = !!(editor.isSavingPost?.() || editor.isAutosavingPost?.());
      const saveFailed = !!editor.didPostSaveRequestFail?.();
      const saveSucceeded = !!editor.didPostSaveRequestSucceed?.();
      const isDirty = !!editor.isEditedPostDirty?.();
      if (saveSucceeded && !isSaving && !saveFailed && !isDirty) return true;
    }
  } catch (e) {}

  const msg = document.querySelector('#message.updated, .notice-success, #message');
  if (msg && /updated|saved|published/i.test(msg.textContent || '')) return true;
  const snack = document.querySelector('.components-snackbar, .components-notice--success');
  if (snack && /updated|saved|published/i.test(snack.textContent || '')) return true;
  // Gutenberg also updates the post status label in the URL/title after save
  if (/post.php\?post=\d+&action=edit/.test(location.href) && document.title && !document.title.startsWith('•')) {
    // Slot/page reloaded; check for absence of unsaved-indicator
    const dirty = document.querySelector('.editor-post-saved-state');
    if (dirty && /saved|published|updated/i.test(dirty.textContent || '')) return true;
  }
  return false;
}

// ══════════════════════════════════════════════════════════════════════
// AI PROVIDER PAGE INSPECTION
// ══════════════════════════════════════════════════════════════════════
function prepareAIProviderPage(providerKind, allowWebSearch) {
  // Applies to all providers: find any ACTIVE search/research/browse/web toggle
  // and switch it off so the AI edits the pasted article offline.
  // v3.46.0: allowWebSearch === true (the prompt allows web search) keeps plain
  // search / web / browse toggles as they are and only switches OFF deep
  // research / research / deep search / agent modes. An active agent mode is
  // switched off in BOTH cases (it was missing from the v3.45.0 list).
  function visible(el) {
    const r = el?.getBoundingClientRect?.();
    return !!r && (r.width > 0 && r.height > 0 || (window.innerWidth || 0) < 500 || !document.documentElement?.getBoundingClientRect().width);
  }
  function labelOf(el) {
    return [
      el?.getAttribute?.('aria-label'),
      el?.getAttribute?.('title'),
      el?.getAttribute?.('data-testid'),
      el?.textContent
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  let changed = 0;
  const offPattern = allowWebSearch === true
    ? /\b(deepsearch|deep search|deep research|research|agent|agent mode)\b/
    : /\b(search|deepsearch|deep search|research|browse|web|agent|agent mode)\b/;
  const controls = [...document.querySelectorAll('button, [role="button"], input[type="checkbox"]')].filter(visible);
  controls.forEach((el) => {
    const label = labelOf(el);
    if (!offPattern.test(label)) return;
    const pressed = el.getAttribute('aria-pressed') === 'true' ||
      el.getAttribute('aria-checked') === 'true' ||
      el.classList?.contains?.('active') ||
      el.classList?.contains?.('selected') ||
      (el.tagName === 'INPUT' && el.checked);
    if (!pressed || el.disabled) return;
    try {
      el.click();
      changed++;
    } catch (e) {}
  });
  return { changed };
}

function inspectAIProviderPage(providerKind) {
  function visible(el) {
    const r = el?.getBoundingClientRect?.();
    return !!r && (r.width > 0 && r.height > 0 || (window.innerWidth || 0) < 500 || !document.documentElement?.getBoundingClientRect().width);
  }
  function labelOf(el) {
    return [
      el?.getAttribute?.('aria-label'),
      el?.getAttribute?.('placeholder'),
      el?.getAttribute?.('data-placeholder'),
      el?.getAttribute?.('data-testid'),
      el?.getAttribute?.('role'),
      el?.className
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  function queryAllSafe(selectors) {
    const found = [];
    selectors.forEach((selector) => {
      try { document.querySelectorAll(selector).forEach(el => found.push(el)); } catch (e) {}
    });
    return [...new Set(found)];
  }
  function innerEditable(el) {
    if (!el) return null;
    if (el.matches?.('textarea, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .ProseMirror, .ql-editor')) return el;
    return el.querySelector?.('textarea, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .ProseMirror, .ql-editor') || el;
  }
  function composerCandidates() {
    const selectors = [
      'textarea',
      'input[type="text"]',
      '[contenteditable]:not([contenteditable="false"])',
      '[role="textbox"]',
      '.ProseMirror',
      '.ql-editor',
      'rich-textarea .ql-editor',
      '[aria-label*="Enter a prompt" i]',
      '[aria-label*="Ask Gemini" i]',
      '[data-testid*="composer" i]',
      '[data-testid*="chat-input" i]',
      '[data-testid*="prompt" i]',
      '[aria-label*="message" i]',
      '[placeholder*="message" i]'
    ];
    if (providerKind === 'claude') {
      selectors.push(
        '[aria-label*="Claude" i]',
        '[placeholder*="Claude" i]',
        '[data-placeholder*="Claude" i]',
        '[data-testid*="chat" i]',
        '[data-testid*="input" i]',
        'div[enterkeyhint="enter"]',
        'p[data-placeholder]'
      );
    }
    return queryAllSafe(selectors).map(innerEditable).filter(Boolean);
  }
  function composerReady() {
    const candidates = composerCandidates();
    let hint = candidates.length ? (candidates.length + ' input-like element(s)') : '';
    const ready = candidates.some(el => {
      if (!visible(el) || el.disabled || el.readOnly) return false;
      if (el.getAttribute?.('aria-hidden') === 'true' || el.getAttribute?.('aria-disabled') === 'true') return false;
      const r = el.getBoundingClientRect();
      // A minimized Chrome window collapses layout: the genuine composer can
      // measure a handful of pixels. Only a zero-size (truly unrendered)
      // element is disqualified here.
      if (r.width <= 0 || r.height <= 0) return false;
      const meta = labelOf(el);
      if (/\b(search|filter|find|sidebar)\b/.test(meta) && !/\b(message|prompt|chat|claude|composer)\b/.test(meta)) return false;
      return el.isContentEditable ||
        el.tagName === 'TEXTAREA' ||
        el.tagName === 'INPUT' ||
        el.getAttribute?.('role') === 'textbox' ||
        /\bprosemirror\b/i.test(String(el.className || ''));
    });
    if (!ready && candidates.length) {
      const biggest = candidates
        .map(el => ({ el, r: el.getBoundingClientRect(), label: labelOf(el).slice(0, 80) }))
        .sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height))[0];
      if (biggest) hint += ', largest ' + Math.round(biggest.r.width) + 'x' + Math.round(biggest.r.height) + (biggest.label ? ' ' + biggest.label : '');
    }
    return { ready, hint };
  }
  function issueText() {
    const alertText = [...document.querySelectorAll('[role="alert"], [role="status"], main')]
      .filter(visible).slice(0, 6)
      .map(el => (el.innerText || el.textContent || '').slice(0, 900))
      .join(' ');
    return (document.title + ' ' + alertText + ' ' + (document.body?.innerText || '').slice(0, 2600)).toLowerCase();
  }
  function providerIssue(text, ready) {
    if (!ready && /verify you are human|checking your browser|just a moment|needs to review the security|attention required|cf-browser-verification|cf-challenge|turnstile/.test(text)) {
      return 'AI provider requires browser verification';
    }
    if (!ready && /too many requests|rate limit|usage limit|limit reached|out of (?:free )?messages|upgrade to (?:continue|keep)|try again later|temporarily unavailable/.test(text)) {
      return 'AI provider limit or temporary outage';
    }
    if (!ready && /log in|login|sign in|sign up|create an account/.test(text)) {
      return 'AI provider login is required';
    }
    if (!ready && /network error|connection lost|failed to load|reload the page/.test(text)) {
      return 'AI provider page did not load cleanly';
    }
    return '';
  }
  const composer = composerReady();
  const ready = composer.ready;
  return {
    viewport: { w: Math.round(window.innerWidth || 0), h: Math.round(window.innerHeight || 0) },
    composerReady: ready,
    providerIssue: providerIssue(issueText(), ready),
    readyState: document.readyState,
    url: location.href,
    composerHint: composer.hint
  };
}

// ══════════════════════════════════════════════════════════════════════
// AI COMPOSER FILL + SUBMIT
// ══════════════════════════════════════════════════════════════════════
async function fillAIComposer(text, unthrottle) {
  // Chrome clamps a hidden page's timers to one wake-up per second, and to one
  // per MINUTE after five minutes hidden. postMessage tasks are not throttled,
  // so when the caller tells us this tab is hidden we run the clock off a
  // message loop. Plain setTimeout whenever the window is on screen.
  const wait = (ms) => new Promise((resolve) => {
    if (!unthrottle) { setTimeout(resolve, ms); return; }
    const t0 = performance.now();
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    setTimeout(finish, ms);
    let ch;
    try { ch = new MessageChannel(); } catch (e) { return; }
    ch.port1.onmessage = () => {
      if (done) return;
      if (performance.now() - t0 >= ms) finish();
      else ch.port2.postMessage(0);
    };
    ch.port2.postMessage(0);
  });
  function visibleSize(el) {
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return r.width * r.height;
    // Zero does not mean hidden when the whole window is not being laid out.
    // Ask the browser whether the element is rendered instead of measuring it,
    // otherwise a minimized Chrome reports "Visible AI input box not found"
    // while looking at a perfectly good composer.
    if ((window.innerWidth || 0) >= 500) return 0;
    if (!el.isConnected) return 0;
    try {
      if (typeof el.checkVisibility === 'function') {
        return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ? 1 : 0;
      }
    } catch (e) {}
    try {
      const st = getComputedStyle(el);
      if (st && (st.display === 'none' || st.visibility === 'hidden')) return 0;
    } catch (e) {}
    return 1;
  }
  // ChatGPT (and Claude) convert big pastes into a "Pasted text" attachment
  // chip and leave the text box empty. That is a SUCCESSFUL fill — the old
  // code thought the paste failed and typed the whole prompt again, sending
  // the prompt twice in one message.
  function attachmentNear(el) {
    function vis(n) { const r = n.getBoundingClientRect && n.getBoundingClientRect(); return !!r && (r.width > 0 && r.height > 0 || (window.innerWidth || 0) < 500 || !document.documentElement?.getBoundingClientRect().width); }
    const scope = el.closest('form') || (el.parentElement && el.parentElement.parentElement && el.parentElement.parentElement.parentElement) || document;
    // ChatGPT's pasted-text chip is now labelled "Show in text field" and its
    // class names are hashed, so neither the old class selectors nor the words
    // "Pasted text" appear. Match the visible label — that is the reliable part.
    const CHIP_TEXT = /show in text field|pasted text|pasted|\.txt\b|document|attachment/i;
    try {
      const chips = [].slice.call(scope.querySelectorAll('[data-testid*="attachment" i], [class*="attachment" i], [data-testid*="file" i], [class*="file" i], [class*="chip" i], [data-testid*="paste" i]'));
      if (chips.some((c) => vis(c) && CHIP_TEXT.test(((c.textContent || '') + ' ' + (c.getAttribute('aria-label') || '')).slice(0, 300)))) return true;
    } catch (e) {}
    try { if (/show in text field|pasted text/i.test((scope.innerText || '').slice(0, 4000))) return true; } catch (e) {}
    return false;
  }
  function findInput() {
    function labelOf(el) {
      return [
        el?.getAttribute?.('aria-label'),
        el?.getAttribute?.('placeholder'),
        el?.getAttribute?.('data-placeholder'),
        el?.getAttribute?.('data-testid'),
        el?.getAttribute?.('role'),
        el?.className
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
    }
    function innerEditable(el) {
      if (!el) return null;
      if (el.matches?.('textarea, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .ProseMirror, .ql-editor')) return el;
      return el.querySelector?.('textarea, input, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .ProseMirror, .ql-editor') || el;
    }
    const selectors = [
      '#prompt-textarea',                 // ChatGPT's ProseMirror composer
      'form [contenteditable="true"]',
      'textarea',
      'input[type="text"]',
      '[contenteditable]:not([contenteditable="false"])',
      '[role="textbox"]',
      '.ProseMirror',
      '.ql-editor',
      'rich-textarea .ql-editor',
      '[aria-label*="Enter a prompt" i]',
      '[aria-label*="Ask Gemini" i]',
      '[data-testid*="composer" i]',
      '[data-testid*="chat-input" i]',
      '[data-testid*="prompt" i]',
      '[data-testid*="input" i]',
      '[aria-label*="message" i]',
      '[placeholder*="message" i]',
      '[aria-label*="Claude" i]',
      '[placeholder*="Claude" i]',
      '[data-placeholder*="Claude" i]'
    ];
    const candidates = [...new Set(selectors.flatMap(sel => {
      try { return [...document.querySelectorAll(sel)]; } catch (e) { return []; }
    }).map(innerEditable).filter(Boolean))].filter(el => {
      // A one-line composer has a small area, and ChatGPT's box is briefly tiny
      // while it re-mounts. The old 300px² floor rejected those and produced
      // "Visible AI input box not found" on a perfectly good page.
      // Size is not identity — a minimized window shrinks the real composer.
      if (visibleSize(el) <= 0 || el.disabled || el.readOnly) return false;
      if (el.getAttribute?.('aria-hidden') === 'true' || el.getAttribute?.('aria-disabled') === 'true') return false;
      const meta = labelOf(el);
      if (/\b(search|filter|find|sidebar)\b/.test(meta) && !/\b(message|prompt|chat|claude|composer)\b/.test(meta)) return false;
      return el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.getAttribute?.('role') === 'textbox' || /\bprosemirror\b/i.test(String(el.className || ''));
    }).sort((a, b) => {
      const aMeta = labelOf(a);
      const bMeta = labelOf(b);
      const aScore = (/\b(message|prompt|chat|claude|composer)\b/.test(aMeta) ? 100000 : 0) + a.getBoundingClientRect().top;
      const bScore = (/\b(message|prompt|chat|claude|composer)\b/.test(bMeta) ? 100000 : 0) + b.getBoundingClientRect().top;
      return bScore - aScore;
    });
    return candidates[0] || null;
  }
  async function setVal(el, v) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, v); else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      el.focus();
      const filledText = () => (el.innerText || el.textContent || '').replace(/\s+/g, '').length >= Math.min(v.replace(/\s+/g, '').length * 0.8, 800);
      const filledEnough = () => filledText() || attachmentNear(el);
      const clearBox = () => {
        try {
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
        } catch (e) {}
      };
      // Method A: execCommand insertText (works in most Chromium contenteditables).
      const byExec = () => { try { document.execCommand('insertText', false, v); } catch (e) {} };
      // Method B: synthetic paste — ProseMirror / React composers (ChatGPT, Claude,
      // Gemini, Grok) read clipboardData on a paste event, and this works even when
      // the tab/window is not focused (so background mode pastes reliably too).
      const byPaste = () => {
        try {
          el.focus();
          const dt = new DataTransfer();
          dt.setData('text/plain', v);
          el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        } catch (e) {}
      };
      // Our prompt may already sit in an attachment chip from a previous
      // attempt whose send was not confirmed — never paste it a second time.
      if (attachmentNear(el)) {
        attachmentMode = true;
        return;
      }
      // How much text is in the box right now (non-whitespace chars).
      const textLen = () => (el.innerText || el.textContent || '').replace(/\s+/g, '').length;
      const targetLen = v.replace(/\s+/g, '').length;
      // Wait for the paste to LAND: either the text appears, or the provider
      // converts it into an attachment chip. ChatGPT's conversion is async and
      // regularly needs several seconds for an article-sized payload — a fixed
      // short wait used to expire first, and the execCommand fallback below
      // then inserted the whole article a SECOND time (chip + full text), which
      // both duplicates the prompt and keeps Send disabled while it uploads.
      const settleFor = async (ms) => {
        const until = Date.now() + ms;
        while (Date.now() < until) {
          if (filledEnough()) return true;
          await wait(200);
        }
        return filledEnough();
      };
      clearBox();
      // For big article payloads the synthetic paste is near-instant, while
      // execCommand insertText can churn for many seconds (per-character layout).
      if (v.length > 10000) {
        byPaste();
        if (!(await settleFor(8000))) { byExec(); await wait(600); }
      } else {
        byExec();
        await wait(250);
        if (!filledEnough()) { byPaste(); await settleFor(3000); }
      }
      // Double-paste repair: both methods landed, so the composer now holds the
      // article roughly twice (or once alongside its own attachment chip).
      // Sending that would give the AI a duplicated prompt.
      if (attachmentNear(el) && textLen() > Math.max(400, targetLen * 0.5)) {
        clearBox();
        await wait(300);
        if (textLen() > Math.max(400, targetLen * 0.5)) {
          // The box refused to clear — start over with a clean slate rather
          // than sending duplicated content.
          try { el.textContent = ''; } catch (e) {}
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        }
      }
      // Method 3: last resort — beforeinput + direct text, then notify.
      if (!filledEnough()) {
        try { el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: v, inputType: 'insertFromPaste' })); } catch (e) {}
        try { el.textContent = v; } catch (e) {}
        await wait(200);
      }
      attachmentMode = !filledText() && attachmentNear(el);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: v, inputType: 'insertText' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  // What the page actually looks like, for a useful error instead of a bare
  // "not found" — how many editable boxes exist and how big the biggest is.
  function describePage() {
    try {
      const all = [...document.querySelectorAll('textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .ProseMirror, .ql-editor')];
      const visible = all.filter(el => { const r = el.getBoundingClientRect(); return (r.width > 0 && r.height > 0 || (window.innerWidth || 0) < 500 || !document.documentElement?.getBoundingClientRect().width); });
      const biggest = visible.map(el => el.getBoundingClientRect()).sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
      const dialog = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
        .some(el => { const r = el.getBoundingClientRect(); return (r.width > 0 && r.height > 0 || (window.innerWidth || 0) < 500 || !document.documentElement?.getBoundingClientRect().width); });
      return all.length + ' editable element(s), ' + visible.length + ' visible' +
        (biggest ? ', biggest ' + Math.round(biggest.width) + 'x' + Math.round(biggest.height) : '') +
        (dialog ? ', a modal dialog is covering the page' : '') +
        ', url ' + location.pathname;
    } catch (e) { return 'page could not be inspected'; }
  }

  let attachmentMode = false;
  // The composer can be MID-REMOUNT at this exact moment: ChatGPT re-renders it
  // right after the page settles and after our own toggle clicks, so a single
  // instant lookup would fail on a perfectly working page. Poll for ~12s and
  // clear any dialog that is covering it before giving up.
  let input = findInput();
  for (let i = 0; i < 24 && !input; i++) {
    if (i === 4 || i === 12) {
      // Escape closes ChatGPT's "stay logged out"/upsell dialogs that sit over
      // the composer and hide it from every selector.
      try {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      } catch (e) {}
    }
    await wait(500);
    input = findInput();
  }
  if (!input) return { ok: false, error: 'Visible AI input box not found after 12s (' + describePage() + ').' };
  input.focus();
  await setVal(input, text);

  // ChatGPT may turn a large paste into a text-file attachment and leave the
  // composer blank. Add a small visible instruction beside that attachment so
  // the model knows the file contains both the article and its complete prompt.
  // Without this, ChatGPT can treat the upload as article-only and answer
  // "HTML received. Awaiting instructions."
  let activeInput = input;
  if (attachmentMode) {
    await wait(200);
    activeInput = findInput() || input;
    const directive = 'Read the attached text completely. It contains the source article and my complete editing instructions. Execute those instructions now; do not wait for another message.';
    activeInput.focus();
    if (activeInput.tagName === 'TEXTAREA' || activeInput.tagName === 'INPUT') {
      const proto = activeInput.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(activeInput, directive); else activeInput.value = directive;
    } else {
      try {
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        document.execCommand('insertText', false, directive);
      } catch (e) {
        try { activeInput.textContent = directive; } catch (_) {}
      }
    }
    activeInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: directive, inputType: 'insertText' }));
    activeInput.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(250);
  }

  const readValue = (node) => node
    ? (node.isContentEditable ? (node.innerText || node.textContent || '') : (node.value || ''))
    : '';
  let value = readValue(activeInput);
  let okByText = value.length >= Math.min(text.length * 0.8, 1000);
  // ChatGPT re-mounts its composer after a big paste, which leaves our element
  // reference detached and reading empty even though the paste succeeded.
  // Re-query once before declaring failure.
  if (!okByText && !attachmentMode && !activeInput.isConnected) {
    const fresh = findInput();
    if (fresh) {
      activeInput = fresh;
      value = readValue(activeInput);
      okByText = value.length >= Math.min(text.length * 0.8, 1000);
      if (!okByText && attachmentNear(activeInput)) attachmentMode = true;
    }
  }
  if (!okByText && !attachmentMode) {
    return { ok: false, error: 'AI input box did not accept the full prompt (composer held ' + value.length + ' of ' + text.length + ' chars).' };
  }
  activeInput.dataset.blogeditComposer = '1';
  return {
    ok: true,
    attachment: attachmentMode,
    kind: (activeInput.isContentEditable ? 'contenteditable' : activeInput.tagName.toLowerCase()) + (attachmentMode ? '+attachment' : '')
  };
}

function submitAIComposer(forceEnter) {
  function vis(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return (r.width > 0 && r.height > 0 || (window.innerWidth || 0) < 500 || !document.documentElement?.getBoundingClientRect().width);
  }
  function findInput() {
    return document.querySelector('[data-blogedit-composer="1"]') ||
      [...document.querySelectorAll('[contenteditable]:not([contenteditable="false"]), [role="textbox"], .ProseMirror, .ql-editor, textarea, [data-testid*="chat-input" i], [data-testid*="composer" i]')]
        .map(el => el.matches?.('textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .ProseMirror, .ql-editor')
          ? el
          : (el.querySelector?.('textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .ProseMirror, .ql-editor') || el))
        .filter(el => { const r = el.getBoundingClientRect(); return (r.width > 0 && r.height > 0 || (window.innerWidth || 0) < 500 || !document.documentElement?.getBoundingClientRect().width); })
        .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0] || null;
  }
  // Selector-based send-button detection (NOT geometry-based — a tall multi-line
  // composer used to push the button out of the old proximity window).
  function findSendButton() {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[data-testid="composer-send-button"]',
      'button[data-testid="fruitjuice-send-button"]',
      // Gemini (Angular Material) uses data-test-id WITH a hyphen and a
      // .send-button class — none of the selectors above ever matched it.
      'button[data-test-id="send-button"]',
      'button.send-button',
      'button[mattooltip*="send" i]',
      'button[aria-label*="send" i]',
      'button[aria-label*="submit" i]',
      'form button[type="submit"]'
    ];
    const isOff = (b) => !!(b.disabled || b.getAttribute('aria-disabled') === 'true' || b.getAttribute('data-disabled') === 'true');
    for (const s of selectors) {
      const list = [...document.querySelectorAll(s)].filter(vis);
      if (!list.length) continue;
      // An enabled button anywhere in the match set beats the last one, which
      // may be a hidden/duplicate control left over from another panel.
      const live = list.filter((b) => !isOff(b));
      return (live.length ? live[live.length - 1] : list[list.length - 1]);
    }
    // Generic fallback: a visible send-ish icon button.
    const generic = [...document.querySelectorAll('button, [role="button"]')].filter(b => {
      if (!vis(b)) return false;
      const meta = [b.getAttribute('aria-label'), b.getAttribute('title'), b.getAttribute('data-testid'), b.textContent]
        .filter(Boolean).join(' ').toLowerCase();
      return /\bsend\b|\bsubmit\b|↑|➤/.test(meta);
    });
    return generic[generic.length - 1] || null;
  }
  const input = findInput();
  if (!input) {
    return {
      ok: false,
      error: 'AI composer disappeared before send.',
      diag: 'composer not found; layout ' +
        (document.documentElement.getBoundingClientRect().width ? 'live' : 'frozen (window hidden)')
    };
  }
  try { input.focus(); } catch (e) {}

  // What the page actually offers, so a timeout can say WHY.
  function describeButtons() {
    try {
      return [...document.querySelectorAll('button, [role="button"]')]
        .filter(vis)
        .map((b) => ({
          label: ([b.getAttribute('aria-label'), b.getAttribute('data-test-id'), b.getAttribute('data-testid'), (b.textContent || '').trim()]
            .filter(Boolean).join('|') || '?').slice(0, 40),
          off: !!(b.disabled || b.getAttribute('aria-disabled') === 'true')
        }))
        .filter((b) => /send|submit|↑|➤/i.test(b.label))
        .slice(0, 4)
        .map((b) => b.label + (b.off ? ' [disabled]' : ' [enabled]'))
        .join(', ') || 'no send-like button on the page';
    } catch (e) { return 'button scan failed'; }
  }

  const btn = findSendButton();
  const btnOff = btn ? !!(btn.disabled || btn.getAttribute('aria-disabled') === 'true' || btn.getAttribute('data-disabled') === 'true') : false;
  if (btn && !btnOff) {
    btn.click();
    return { ok: true, method: 'send button', clickedButton: true };
  }
  // The button exists but is disabled. Gemini keeps it disabled until its own
  // model registers the text, which a synthetic paste does not always trigger.
  // Waiting alone used to spin the whole 12s window and fail the post, so once
  // the caller says the wait is over we press Enter instead — that is how
  // Gemini sends, and it works even while the button looks disabled.
  if (btn && btnOff && !forceEnter) {
    return { ok: false, method: 'button-disabled', error: 'Send button is disabled (input still registering).', diag: describeButtons() };
  }

  // Last resort: synthetic Enter (works on plain textareas; unreliable on ProseMirror).
  ['keydown', 'keypress', 'keyup'].forEach(t => {
    input.dispatchEvent(new KeyboardEvent(t, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
    }));
  });
  return {
    ok: true,
    method: btn ? 'enter key (send button stayed disabled)' : 'enter key',
    clickedButton: false,
    diag: describeButtons()
  };
}

// Is the payload STILL sitting in the composer right before we press Send?
// Between the paste and the click, a provider SPA can re-render and silently
// drop the text (Gemini does this most). Sending then produces an empty chat
// whose link looks valid — the classic "it went back without the prompt".
function probeComposerFilledPage(expectedLen) {
  function vis(el) {
    const r = el?.getBoundingClientRect?.();
    return !!r && (r.width > 0 && r.height > 0 || (window.innerWidth || 0) < 500 || !document.documentElement?.getBoundingClientRect().width);
  }
  const marked = document.querySelector('[data-blogedit-composer="1"]');
  const el = (marked && vis(marked)) ? marked : [...document.querySelectorAll(
    '[contenteditable]:not([contenteditable="false"]), [role="textbox"], .ProseMirror, .ql-editor, textarea'
  )].filter(vis).sort((a, b) => {
    const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
    return (br.width * br.height) - (ar.width * ar.height);
  })[0];
  let len = 0;
  if (el) {
    const v = el.isContentEditable ? (el.innerText || el.textContent || '') : (el.value || '');
    len = v.trim().length;
  }
  // Large pastes may live in an attachment chip with an empty text box — that
  // is a filled composer too.
  let attachment = false;
  try {
    const scope = (el && el.closest('form')) || document.body;
    const chips = [...scope.querySelectorAll('[data-testid*="attachment" i], [class*="attachment" i], [data-testid*="file" i], [class*="chip" i], [data-testid*="paste" i]')];
    // "Show in text field" is the label ChatGPT currently puts on the chip that
    // holds a large paste; "Pasted text" was the older wording.
    attachment = chips.some(c => vis(c) && /show in text field|pasted|\.txt\b|document|attachment/i.test(((c.textContent || '') + ' ' + (c.getAttribute('aria-label') || '')).slice(0, 300)))
      || /show in text field|pasted text/i.test((scope.innerText || '').slice(0, 4000));
  } catch (e) {}
  return { found: !!el, len, attachment, expectedLen: Number(expectedLen) || 0 };
}

// Background-side gate: the composer must hold (most of) the payload, or an
// attachment chip must stand in for it.
//
// This POLLS rather than checking once. ChatGPT converts a large paste into a
// "Pasted text" attachment asynchronously, and that can easily outlast the
// short settle used by a normal Start Batch run (pasteWait defaults to 1s).
// A single instant check therefore reported "the composer lost the prompt",
// the send was skipped, and the post failed — while Fast Submit, which waits
// ~10s before verifying, sailed through. Polling makes both paths behave the
// same regardless of how slow the provider is.
async function checkComposerFilled(tabId, expectedLen, attachmentMode, timeoutMs) {
  const budget = Number.isFinite(Number(timeoutMs)) ? Math.max(0, Number(timeoutMs)) : 12000;
  const deadline = Date.now() + budget;
  const evaluate = (probe) => {
    if (!probe || !probe.found) return { ok: false, reason: 'the composer element disappeared', len: 0 };
    if (attachmentMode || probe.attachment) {
      // Attachment mode carries a short directive in the box; the payload
      // itself is the chip. Accept as long as the chip is still there.
      if (probe.attachment) return { ok: true, len: probe.len, attachment: true };
      return { ok: false, reason: 'the pasted-text attachment disappeared', len: probe.len };
    }
    const need = Math.max(20, Math.min(Number(expectedLen) || 0, 1000) * 0.8);
    if (probe.len < need) {
      return { ok: false, reason: 'the composer lost the prompt (only ' + probe.len + ' chars left)', len: probe.len };
    }
    return { ok: true, len: probe.len, attachment: false };
  };
  let last = { ok: false, reason: 'the composer could not be read', len: 0 };
  for (;;) {
    if (runtime.stopRequested) return { ok: false, reason: 'stopped by the user', len: 0 };
    let probe = null;
    try { probe = (await runInTab(tabId, probeComposerFilledPage, [expectedLen]))?.result; } catch (e) {}
    last = evaluate(probe);
    if (last.ok) return last;
    if (Date.now() >= deadline) return last;
    await sleep(700);
  }
}

// Interruptible pre-send wait (Fast Submit's "Prompt paste wait"). Pause FREEZES
// the countdown without sending; Stop aborts the send entirely so the post stays
// unfinished instead of being recorded as submitted.
async function waitBeforeSendWithGate(totalMs, tag) {
  let remaining = Math.max(0, Number(totalMs) || 0);
  while (remaining > 0) {
    if (runtime.stopRequested) return { stopped: true };
    if (runtime.paused) {
      setStatus((tag ? tag + ' ' : '') + '⏸ Paused during the pre-send wait — nothing has been sent.', 'error');
      await swPing();
      await sleep(1500);
      continue;                      // frozen: the countdown does not advance
    }
    setStatus((tag ? tag + ' ' : '') + '⏳ Paste verified — sending in ' + Math.ceil(remaining / 1000) + 's');
    await swPing();
    const step = Math.min(1000, remaining);
    await sleep(step);
    remaining -= step;
  }
  return { stopped: !!runtime.stopRequested };
}

// ══════════════════════════════════════════════════════════════════════
// MODEL LIMIT DETECTOR
//
// When an account runs out of quota for the large model, ChatGPT does one of:
//   • the composer's model button loses its name and shows the bare
//     placeholder "Model" (the state in the user's screenshot),
//   • a banner appears: "You've hit the Plus plan limit for GPT-5.1.
//     Responses will use GPT-5.1 mini until 4:32 PM." — the dangerous one,
//     because editing silently continues on a weaker model,
//   • a hard message: "You're out of messages until …" / "usage cap".
//
// FALSE POSITIVES MUST NOT HAPPEN — a wrong verdict stops the whole run. So
// this NEVER scans the conversation transcript or the composer (both contain
// the pasted article, which could itself mention "limit"). It only reads
// alerts, dialogs, toasts and the banner strip around the composer.
// ══════════════════════════════════════════════════════════════════════
function detectAIModelLimitPage(providerKind) {
  function vis(el) {
    const r = el?.getBoundingClientRect?.();
    return !!r && (r.width > 0 && r.height > 0 || (window.innerWidth || 0) < 500 || !document.documentElement?.getBoundingClientRect().width);
  }
  const composer = document.querySelector('[data-blogedit-composer="1"]') ||
                   document.querySelector('#prompt-textarea, .ProseMirror, .ql-editor, [contenteditable="true"], textarea');
  const form = composer ? (composer.closest('form') || composer.parentElement) : null;

  // Text sources that can never contain our pasted article.
  function noticeText() {
    const parts = [];
    const push = (el) => {
      if (!el || !vis(el)) return;
      if (composer && el.contains && el.contains(composer)) return;   // skip the composer subtree
      const t = (el.innerText || el.textContent || '').trim();
      if (t && t.length < 600) parts.push(t);
    };
    document.querySelectorAll('[role="alert"], [role="status"], [role="dialog"], [aria-live="polite"], [aria-live="assertive"]').forEach(push);
    document.querySelectorAll('[class*="toast" i], [class*="banner" i], [class*="notice" i], [class*="callout" i]').forEach(push);
    // The cap banner renders immediately above/around the composer form.
    if (form && form.parentElement) {
      [...form.parentElement.children].forEach((child) => { if (child !== form) push(child); });
    }
    return parts.join('\n').slice(0, 4000);
  }

  // Gemini answers a quota block with a short chat message rather than a
  // banner. Reading the LAST model response is safe only while it is too short
  // to be an article — that keeps our own pasted content out of the scan.
  function shortGeminiReply() {
    if (providerKind !== 'gemini' && providerKind !== 'claude') return '';
    try {
      const sel = providerKind === 'claude'
        ? '[data-is-streaming], [class*="font-claude" i], [data-testid*="message" i]'
        : 'model-response, message-content, [class*="model-response" i]';
      const nodes = [...document.querySelectorAll(sel)].filter(vis);
      const last = nodes[nodes.length - 1];
      if (!last) return '';
      const t = (last.innerText || last.textContent || '').trim();
      // Only a message too short to be an article may be scanned.
      return (t && t.length <= 600) ? t : '';
    } catch (e) { return ''; }
  }

  // Page CHROME only: everything except the conversation bubbles and the
  // composer, so our own article can never be mistaken for a provider notice.
  function chromeText() {
    try {
      const skip = [];
      const add = (sel) => { try { document.querySelectorAll(sel).forEach((el) => skip.push(el)); } catch (e) {} };
      add('[data-message-author-role]');       // ChatGPT bubbles
      add('model-response, message-content, user-query');   // Gemini
      add('[data-is-streaming], [class*="font-claude" i]'); // Claude
      add('[class*="message-bubble" i]');      // Grok
      if (composer) skip.push(composer);
      const isSkipped = (el) => skip.indexOf(el) !== -1;
      const holdsSkipped = (el) => {
        for (let i = 0; i < skip.length; i++) {
          if (el.contains && el !== skip[i] && el.contains(skip[i])) return true;
        }
        return false;
      };
      let out = '';
      const walk = (node, depth) => {
        if (!node || depth > 8 || out.length > 20000) return;
        const kids = node.children || [];
        for (let i = 0; i < kids.length; i++) {
          const child = kids[i];
          if (isSkipped(child)) continue;                 // a bubble/composer
          if (holdsSkipped(child)) { walk(child, depth + 1); continue; }
          const t = ((child.innerText || child.textContent || '') + '').trim();
          if (t) out += '\n' + t;
        }
      };
      walk(document.body, 0);
      return out.slice(0, 20000);
    } catch (e) { return ''; }
  }

  // Sentences that only a provider's own UI ever shows.
  const unmistakable = [
    /you\s*(?:are|'re)\s+out of free messages/i,
    /you\s*(?:are|'re)\s+out of messages/i,
    /out of free messages until/i,
    /you'?(?:ve| have)\s+reached your usage limit/i,
    /you'?(?:ve| have)\s+reached the current usage cap/i,
    /(?:message|usage|daily|weekly) limit reached/i,
    /you'?(?:ve| have)\s+hit (?:the|your)[^.\n]{0,40}\blimit for\b/i,
    /your limit will reset at/i,
    /upgrade to (?:continue|keep going|send more|get more)/i,
    /you'?(?:ve| have)\s+reached your (?:daily |current )?limit/i
  ];

  const text = noticeText() + '\n' + shortGeminiReply();
  const wholePage = chromeText();
  // Deliberately specific — none of these appear in normal ChatGPT chrome.
  const hardPatterns = [
    /you'?(?:ve| have) (?:hit|reached) (?:the|your|our)[^\n]{0,80}\blimits?\b/i,
    // Gemini's own phrasings.
    /you'?(?:ve| have) reached your (?:daily |current )?limit/i,
    // Claude's wording.
    /(?:usage|message) limit reached/i,
    /you'?(?:ve| have) reached your usage limit/i,
    /out of free messages/i,
    /limit for (?:\d|gemini|flash|pro)/i,
    /come back (?:tomorrow|later)/i,
    /upgrade to (?:google ai|gemini advanced)/i,
    /you can (?:try again|continue) (?:in|after|tomorrow)/i,
    /you'?(?:re| are) out of messages/i,
    /message limit reached/i,
    /usage cap/i,
    /(?:your |the )?limit (?:will )?resets?\s+(?:at|in|on)\b/i,
    /no (?:more )?messages? (?:left|remaining)/i
  ];
  // Silent downgrade to a smaller model — editing would continue at lower
  // quality without this check.
  const downgradePatterns = [
    /responses will (?:now )?use[^\n]{0,60}\buntil\b/i,
    /switch(?:ed|ing)? to[^\n]{0,40}\b(mini|lite|small)\b/i,
    /you'?(?:re| are) now (?:using|on)[^\n]{0,40}\b(mini|lite)\b/i
  ];
  // "…resets at 3:00 PM" / "…until 4 PM" / "…in 2 hours" — the exact wording
  // the run can resume on.
  function resetPhrase(source) {
    const text = arguments.length ? (source || '') : (typeof wholePage === 'string' ? wholePage : '');
    const patterns = [
      /(?:limit|access|messages?)[^.\n]{0,40}?(?:will\s+)?resets?\s+(?:at|on)\s+([^.\n]{2,40})/i,
      /resets?\s+(?:at|on)\s+([^.\n]{2,40})/i,
      /(?:try again|available again|back)\s+(?:at|after)\s+([^.\n]{2,40})/i,
      /until\s+((?:\d{1,2}(?::\d{2})?\s*(?:am|pm))|(?:\d{1,2}:\d{2}))/i,
      /messages?\s+until\s+([^.\n]{2,30})/i,
      /(?:in|after)\s+(\d{1,2}\s*(?:hours?|hrs?|minutes?|mins?))/i
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (!m || !m[1]) continue;
      const found = m[1].trim().slice(0, 40);
      // A reset time must actually look like one. Without this, a phrase such
      // as "Back at it, Hasan" satisfied the "back at ..." pattern and was
      // stored as the reset time.
      if (!/\d/.test(found) && !/tomorrow/i.test(found)) continue;
      return found;
    }
    return '';
  }

  // 1) Unmistakable provider wording, anywhere on the page. This is what
  //    catches banners rendered inside the composer card with hashed classes.
  for (const re of unmistakable) {
    const m = wholePage.match(re);
    if (m) {
      return {
        limited: true,
        kind: 'cap',
        evidence: m[0].slice(0, 160),
        resetText: resetPhrase(wholePage) || resetPhrase(text)
      };
    }
  }

  // 2) Looser wording, but only from notice zones that cannot hold our article.
  for (const re of hardPatterns) {
    const m = text.match(re);
    if (m) return { limited: true, kind: 'cap', evidence: m[0].slice(0, 160), resetText: resetPhrase(text) };
  }
  for (const re of downgradePatterns) {
    const m = text.match(re);
    if (m) return { limited: true, kind: 'downgrade', evidence: m[0].slice(0, 160), resetText: resetPhrase(text) };
  }

  // ── Reasoning-effort downgrade (ChatGPT) ──
  // The pill sits beside the composer and reads Instant / Medium / High / Pro.
  // Anything below High means the account was throttled down.
  if (providerKind === 'chatgpt') {
    try {
      const EFFORTS = ['instant', 'medium', 'high', 'pro'];
      const controls = [...document.querySelectorAll('button, [role="button"], [role="combobox"]')].filter(vis);
      const pill = controls.find((el) => {
        const own = ((el.innerText || el.textContent || '') + '').replace(/\s+/g, ' ').trim().toLowerCase();
        return EFFORTS.indexOf(own) !== -1;
      });
      if (pill) {
        const shown = ((pill.innerText || pill.textContent || '') + '').replace(/\s+/g, ' ').trim();
        const low = shown.toLowerCase();
        if (low === 'instant' || low === 'medium') {
          return {
            limited: true,
            kind: 'downgrade',
            evidence: 'ChatGPT reasoning effort dropped to "' + shown + '" (only High is acceptable)',
            resetText: resetPhrase(wholePage) || ''
          };
        }
      }
    } catch (e) {}
  }

  // The model button shows the bare placeholder "Model" instead of a model
  // name — ChatGPT could not resolve a usable model for this account, which in
  // practice means the large model is capped. Reported as a SOFT signal: the
  // caller re-checks, because the placeholder also shows for a moment while
  // the picker is still hydrating on a fresh page.
  if (providerKind === 'chatgpt') {
    // The word "Model" on its own is the placeholder, and ChatGPT does not
    // always render it inside a <button>: it can be a bare <span> or <div>
    // beside the mic icon. So look for ANY visible LEAF element whose entire
    // text is exactly "Model" — element type does not matter. A standalone
    // "Model" label appears nowhere else in a working composer.
    let placeholder = null;
    let pickerText = '';
    try {
      const all = document.querySelectorAll('button, [role="button"], [role="combobox"], span, div, p, a');
      for (const el of all) {
        if (!vis(el)) continue;
        if (el.children && el.children.length) continue;          // leaf nodes only
        const own = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!own || own.length > 30) continue;
        if (/^model$/i.test(own)) { placeholder = el; break; }
      }
    } catch (e) {}
    // Whatever the picker DOES show, for the log line.
    try {
      const labelled = [...document.querySelectorAll('button, [role="button"], [role="combobox"]')]
        .filter(vis)
        .find((el) => /model/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('data-testid') || '')));
      if (labelled) pickerText = (labelled.innerText || labelled.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    } catch (e) {}
    if (placeholder) {
      return { limited: false, soft: true, kind: 'placeholder', evidence: 'the model selector shows only "Model"', pickerText: pickerText || 'Model' };
    }
    return { limited: false, soft: false, kind: '', evidence: '', pickerText };
  }
  return { limited: false, soft: false, kind: '', evidence: '' };
}

function modelLimitGuardOn() {
  return runtime.job?.modelLimitGuard !== false;   // ON unless explicitly off
}

// Confirms a limit before it is allowed to stop a run. Hard evidence (a cap or
// downgrade sentence) counts at once; the bare "Model" placeholder must still
// be there after a re-check, so a picker that is merely hydrating is ignored.
async function checkAIModelLimit(tabId, providerKind, tag) {
  if (!modelLimitGuardOn()) {
    log('info', (tag ? tag + ' ' : '') + 'Model Limit check skipped — the guard is Off in Run behaviour.');
    return null;
  }
  let first = null;
  try { first = (await runInTab(tabId, detectAIModelLimitPage, [providerKind]))?.result; }
  catch (e) {
    log('warn', (tag ? tag + ' ' : '') + 'Model Limit check could not run: ' + (e?.message || e));
    return null;
  }
  if (!first) return null;
  // Always leave a trace so the log shows what the model area actually read.
  log('info', (tag ? tag + ' ' : '') + '🔎 Model check — ' + (
    first.limited ? 'LIMIT: ' + first.evidence
      : first.soft ? 'possible limit: ' + first.evidence + ' (confirming in 4s)'
        : 'ok' + (first.pickerText ? ' (model shows "' + first.pickerText + '")' : '')
  ));
  if (first.limited) return first;
  if (!first.soft) return null;
  if (runtime.stopRequested) return null;
  await stopSleep(4000);
  if (runtime.stopRequested) return null;
  let second = null;
  try { second = (await runInTab(tabId, detectAIModelLimitPage, [providerKind]))?.result; } catch (e) { return null; }
  if (second && (second.limited || second.soft)) {
    log('warn', (tag ? tag + ' ' : '') + 'ChatGPT model selector still shows only "Model" after 4s — treating it as a model limit.');
    return {
      limited: true,
      kind: second.kind || 'placeholder',
      evidence: second.evidence || first.evidence,
      resetText: second.resetText || first.resetText || ''
    };
  }
  log('info', (tag ? tag + ' ' : '') + 'Model check cleared on the second look — the picker had just not finished loading.');
  return null;
}

// One place that turns a detection into the "stop everything" error.
function modelLimitError(detection, aiName) {
  const what = detection?.kind === 'downgrade'
    ? (/reasoning effort/i.test(String(detection?.evidence || ''))
        ? 'ChatGPT dropped its reasoning effort below High'
        : 'the AI silently switched to a smaller/fallback model')
    : detection?.kind === 'placeholder'
      ? 'the model selector lost its model and shows only "Model"'
      : detection?.kind === 'gemini-flash'
        ? 'Gemini hid the Flash model and offers only Flash-Lite'
        : 'the AI reported a model usage limit';
  const err = new Error(
    '🚫 MODEL LIMIT — ' + (aiName || 'The AI') + ' is limited: ' + what +
    (detection?.evidence ? ' ("' + detection.evidence + '")' : '') +
    '. The run was STOPPED immediately so no post is edited by a limited or downgraded model. ' +
    'Wait for the limit to reset (or switch AI), then start again. Turn this off with "Model Limit" in Run behaviour.'
  );
  err.code = 'MODEL_LIMIT';
  err.limitWhat = what;
  err.limitDetection = detection || null;   // carries resetText to the pause
  err.aiName = aiName || '';                // v3.46.0: the AI that is limited (pause + alert name)
  return err;
}

// ══════════════════════════════════════════════════════════════════════
// MODEL-LIMIT PAUSE
//
// A model limit halts work immediately, but it must NOT throw the queue away:
// the post being worked on was never sent, so the run keeps its exact place
// and can continue later — either automatically after the user's chosen number
// of hours, or manually with Resume. 0 hours = wait for Resume (default).
// ══════════════════════════════════════════════════════════════════════
// Turns Claude's/any provider's reset wording into a real timestamp:
// "3:00 PM", "15:30", "in 2 hours", "45 minutes", "tomorrow at 9am".
// Clock times that already passed today are read as tomorrow. Returns 0 when
// nothing usable was found — the caller then falls back to its own timer.
function parseResetTimeMs(resetText, nowMs) {
  const raw = String(resetText || '').trim();
  if (!raw) return 0;
  const now = new Date(Number(nowMs) || Date.now());

  // Relative: "in 2 hours" / "45 minutes"
  const rel = raw.match(/(\d{1,3})\s*(hours?|hrs?|minutes?|mins?)/i);
  if (rel) {
    const qty = parseInt(rel[1], 10);
    if (Number.isFinite(qty) && qty > 0) {
      const ms = /^h/i.test(rel[2]) ? qty * 3600000 : qty * 60000;
      if (ms <= 48 * 3600000) return now.getTime() + ms;
    }
  }

  // Absolute clock: "3:00 PM", "3 PM", "15:30"
  const abs = raw.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!abs) return 0;
  let hour = parseInt(abs[1], 10);
  const minute = abs[2] ? parseInt(abs[2], 10) : 0;
  const ampm = (abs[3] || '').toLowerCase();
  if (!Number.isFinite(hour) || hour > 23 || minute > 59) return 0;
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  // A bare number with no am/pm and no colon is too vague to trust.
  if (!ampm && !abs[2]) return 0;

  const target = new Date(now.getTime());
  target.setHours(hour, minute, 0, 0);
  if (/tomorrow/i.test(raw) || target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  const delta = target.getTime() - now.getTime();
  if (delta <= 0 || delta > 48 * 3600000) return 0;
  return target.getTime();
}

// 'exact' = resume at the provider's own reset time when it states one.
function limitResumeModeOf() {
  return runtime.job?.limitResumeMode === 'timer' ? 'timer' : 'exact';
}

function modelLimitRetryHoursOf() {
  const h = Number(runtime.job?.modelLimitRetryHours);
  if (!Number.isFinite(h) || h <= 0) return 0;     // 0 → manual resume only
  return Math.max(1, Math.min(48, Math.round(h)));
}

// Before failing a post for a generic reason, ask whether the real cause is a
// usage/model limit. Returns a MODEL_LIMIT error to throw, or null. This is
// what makes a limit PAUSE the run (with its reset time and alert) instead of
// failing the post as "not ready" / "prompt was not sent".
// aiName (optional, v3.46.0): the AI this tab belongs to when it is not the
// job's own AI (e.g. the fact-check AI), so the pause names the right one.
async function limitErrorIfLimited(tabId, providerKind, tag, extraContext, aiName) {
  const limitedAi = aiName || runtime.job?.aiName;
  try {
    const det = await checkAIModelLimit(tabId, providerKind, tag);
    if (det && det.limited) {
      log('warn', (tag ? tag + ' ' : '') + '⛔ The real cause is an AI limit' +
        (extraContext ? ' (' + extraContext + ')' : '') + ' — pausing instead of failing this post.');
      return modelLimitError(det, limitedAi);
    }
    if (providerKind === 'gemini') {
      const flash = await checkGeminiFlashLimit(tabId, tag);
      if (flash) {
        return modelLimitError({
          kind: 'gemini-flash',
          evidence: flash.reason + (flash.offered ? ' (offered: ' + flash.offered + ')' : ''),
          resetText: ''
        }, limitedAi);
      }
    }
  } catch (e) {
    if (e && e.code === 'MODEL_LIMIT') return e;
  }
  return null;
}

async function pauseForModelLimit(aiName, message, detection) {
  const hours = modelLimitRetryHoursOf();
  // The provider told us when access returns (Claude always does, and Gemini
  // often does) — resume EXACTLY then, plus a 2-minute margin so the reset has
  // definitely landed. Falls back to the retry timer when there is no time to
  // read, or when the user chose to always use their own timer.
  const resetText = detection && detection.resetText ? detection.resetText : '';
  const exactAt = (limitResumeModeOf() === 'exact') ? parseResetTimeMs(resetText, Date.now()) : 0;
  const when = exactAt ? (exactAt + 120000) : (hours ? Date.now() + hours * 3600000 : 0);
  const usingExact = !!exactAt;
  runtime.paused = true;
  runtime.autoPauseKind = 'model-limit';
  if (when) {
    try { chrome.alarms.create(MODEL_LIMIT_ALARM, { when }); } catch (e) {}
  }
  const retryText = !when
    ? ' Press Resume when the limit has reset to continue from this exact post.'
    : usingExact
      ? ' ' + (aiName || 'The AI') + ' says access returns at ' + resetText + ' — the run will resume by itself at ' +
        new Date(when).toLocaleTimeString() + '. Press Resume any time to continue sooner.'
      : ' It will try again automatically at ' + new Date(when).toLocaleTimeString() +
        ' (in ' + hours + ' hour' + (hours === 1 ? '' : 's') + ') — or press Resume any time to continue sooner.';
  runtime.autoPauseReason = '🚫 PAUSED — ' + (aiName || 'the AI') + ' model limit. ' +
    String(message || '').slice(0, 200) + retryText;
  log('err', runtime.autoPauseReason);
  setStatus(runtime.autoPauseReason, 'error');
  await raiseLimitAlert(aiName, String(message || '') + retryText, 'MODEL_LIMIT');
  await persistRuntime();
}

// Fired by MODEL_LIMIT_ALARM. Clears the pause so the parked loop continues
// from the same post; the next pre-paste check re-detects a limit that is
// still in place and simply pauses again with a fresh timer.
async function autoResumeAfterModelLimit() {
  await loadRuntime();
  if (!runtime.running || !runtime.paused || runtime.autoPauseKind !== 'model-limit') return;
  if (runtime.stopRequested) return;
  runtime.paused = false;
  runtime.autoPauseReason = '';
  runtime.autoPauseKind = '';
  runtime.limitAlert = null;
  runtime.modelLimitRetries = (Number(runtime.modelLimitRetries) || 0) + 1;
  log('step', '⏰ Model-limit retry #' + runtime.modelLimitRetries + ': resuming from the same post. If the limit is still in place the run pauses again.');
  setStatus('⏰ Model-limit retry #' + runtime.modelLimitRetries + ' — resuming.', '');
  await persistRuntime();
  if (!processing) processLoop().catch(e => log('err', 'Loop error after the model-limit retry: ' + e.message));
}

// Records the stop so the panel can raise a loud, unmissable alert, and fires
// a sticky desktop notification that stays until the user dismisses it.
async function raiseLimitAlert(aiName, message, kind) {
  runtime.limitAlert = {
    kind: kind || 'MODEL_LIMIT',
    aiName: aiName || 'The AI',
    message: String(message || '').slice(0, 500),
    iso: new Date().toISOString(),
    time: new Date().toLocaleTimeString()
  };
  try {
    chrome.notifications.create('limit-alert-' + Date.now(), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: '⛔ STOPPED — ' + (aiName || 'AI') + ' limit reached',
      message: String(message || '').slice(0, 240),
      priority: 2,
      requireInteraction: true      // stays on screen until dismissed
    });
  } catch (e) {}
  await persistRuntime();
}

// Lightweight probe used to confirm a prompt was actually submitted and to
// power timeout diagnostics. Counts assistant turns, composer length, and
// whether a generation is in progress.
// Some composers (Gemini's Angular editor especially) keep their Send button
// disabled until their OWN model sees the text. A synthetic paste updates the
// DOM without always updating that model. Typing one space and deleting it is
// a real edit: the text ends up identical, but the framework re-reads it.
function nudgeComposerInput() {
  const el = document.querySelector('[data-blogedit-composer="1"]') ||
             document.querySelector('#prompt-textarea, .ProseMirror, .ql-editor, [contenteditable="true"], textarea');
  if (!el) return { ok: false };
  try { el.focus(); } catch (e) {}
  try {
    document.execCommand('insertText', false, ' ');
    document.execCommand('delete', false, null);
  } catch (e) {}
  try {
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' ' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
  } catch (e) {}
  return { ok: true };
}

function probeAISend(providerKind) {
  function vis(el) {
    const r = el?.getBoundingClientRect?.();
    return !!r && (r.width > 0 && r.height > 0 || (window.innerWidth || 0) < 500 || !document.documentElement?.getBoundingClientRect().width);
  }
  let assistantCount = 0;
  if (providerKind === 'chatgpt') {
    assistantCount = document.querySelectorAll('[data-message-author-role="assistant"]').length;
    if (!assistantCount) assistantCount = document.querySelectorAll('article[data-testid^="conversation-turn"]').length;
  } else if (providerKind === 'claude') {
    assistantCount = document.querySelectorAll('[data-is-streaming]').length ||
                     document.querySelectorAll('[class*="font-claude" i]').length;
  } else if (providerKind === 'gemini') {
    assistantCount = document.querySelectorAll('message-content, model-response, [class*="model-response" i]').length;
  } else if (providerKind === 'grok') {
    assistantCount = document.querySelectorAll('[class*="message-bubble" i], [class*="response-content" i]').length;
  } else {
    assistantCount = document.querySelectorAll('[data-message-author-role="assistant"], .markdown').length;
  }

  // The user's own message bubbles — the most direct "my prompt was sent"
  // signal, independent of how fast the assistant starts replying.
  let userCount = 0;
  if (providerKind === 'chatgpt') {
    userCount = document.querySelectorAll('[data-message-author-role="user"]').length;
  } else if (providerKind === 'claude') {
    userCount = document.querySelectorAll('[data-testid="user-message"], [class*="user-message" i]').length;
  } else if (providerKind === 'gemini') {
    userCount = document.querySelectorAll('user-query, [class*="user-query" i], [class*="query-content" i]').length;
  } else if (providerKind === 'grok') {
    userCount = document.querySelectorAll('[class*="message-bubble" i]').length;
  } else {
    userCount = document.querySelectorAll('[data-message-author-role="user"]').length;
  }

  const input = document.querySelector('[data-blogedit-composer="1"]') ||
                document.querySelector('[contenteditable]:not([contenteditable="false"]), [role="textbox"], .ProseMirror, .ql-editor, textarea');
  let composerLen = 0;
  if (input) {
    const v = input.isContentEditable ? (input.innerText || input.textContent || '') : (input.value || '');
    composerLen = v.trim().length;
  }

  const generating = [...document.querySelectorAll(
    'button[aria-label*="stop" i], button[data-testid="stop-button"], [data-is-streaming="true"], .result-streaming'
  )].some(vis);

  return { assistantCount, userCount, composerLen, generating };
}

// ══════════════════════════════════════════════════════════════════════
// AI RESPONSE SNAPSHOT — provider-aware code-block extraction
//
// Strategy:
//   1) Identify the LAST assistant message bubble (ChatGPT/Claude/Gemini specific)
//   2) Inside that bubble, find ALL <pre>/<code> elements and grab their text
//   3) Mark those candidates as fromAssistantMessage=true (huge score bonus)
//   4) Fall back to generic <pre>/<code> scan across the page
//   5) Detect "still generating" using provider-specific selectors + text
//
// This is the KEY fix vs v2.1 which missed ChatGPT's modern DOM structure.
// ══════════════════════════════════════════════════════════════════════
function readAICodeSnapshot(providerKind) {
  function visible(el) {
    const r = el?.getBoundingClientRect?.();
    return !!r && (r.width > 0 && r.height > 0 || (window.innerWidth || 0) < 500 || !document.documentElement?.getBoundingClientRect().width);
  }

  // ── Provider-specific assistant-message locators ───────────────────
  function findLastAssistantMessage() {
    let nodes = [];
    if (providerKind === 'chatgpt') {
      nodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
      if (nodes.length === 0) {
        nodes = [...document.querySelectorAll('article[data-testid^="conversation-turn"]')];
      }
    } else if (providerKind === 'claude') {
      nodes = [...document.querySelectorAll(
        '[data-is-streaming], [data-test-render-count], [data-testid*="message" i], [data-testid*="conversation" i], [class*="font-claude" i], [class*="prose" i], [class*="markdown" i], [class*="message" i]'
      )].filter(el => {
        if (!visible(el)) return false;
        if (el.querySelector?.('[data-blogedit-composer="1"]')) return false;
        const text = (el.innerText || el.textContent || '').trim();
        return text.length > 20 || el.querySelector('pre, code');
      });
    } else if (providerKind === 'gemini') {
      nodes = [...document.querySelectorAll('message-content, model-response, [class*="model-response" i]')];
    } else if (providerKind === 'grok') {
      nodes = [...document.querySelectorAll('[class*="message-bubble" i], [class*="response-content" i]')];
    } else if (providerKind === 'deepseek') {
      nodes = [...document.querySelectorAll('[class*="message" i][class*="assistant" i], .markdown')];
    }
    nodes = nodes.filter(visible);
    return nodes[nodes.length - 1] || null;
  }

  // ── Still-generating signal (provider aware) ───────────────────────
  // Kept deliberately TIGHT: a false "still generating" used to block a finished
  // code box forever. Acceptance is now content-based, but a clean signal still
  // lets us accept faster. Only trust explicit "stop generating/streaming" affordances.
  function isGenerating() {
    const stopSelectors = [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label*="stop generating" i]',
      'button[aria-label*="stop response" i]',
      'button[aria-label*="stop streaming" i]',
      'button[aria-label*="stop model" i]',
      'button[title*="stop generating" i]',
      'button[title*="stop response" i]'
    ];
    if ([...document.querySelectorAll(stopSelectors.join(','))].some(el => visible(el) && !el.disabled)) {
      return true;
    }
    if (document.querySelector('[data-is-streaming="true"]')) return true;
    if (providerKind === 'chatgpt' && document.querySelector('.result-streaming')) return true;
    if (providerKind === 'gemini' && document.querySelector('[class*="loading-indicator" i]')) return true;
    // Conservative text fallback: a button whose entire label is exactly a stop verb.
    return [...document.querySelectorAll('button')].some(el => {
      if (!visible(el) || el.disabled) return false;
      const text = (el.textContent || '').trim().toLowerCase();
      return /^(stop|stop generating|stop response|stop streaming)$/.test(text);
    });
  }

  function composerReady() {
    return [...document.querySelectorAll('[contenteditable="true"], textarea')].some(el => {
      if (!visible(el) || el.disabled || el.readOnly) return false;
      const r = el.getBoundingClientRect();
      return (r.width > 0 && r.height > 0 || (window.innerWidth || 0) < 500 || !document.documentElement?.getBoundingClientRect().width);
    });
  }

  // "Continue generating" (ChatGPT and similar) = the model hit its output cap,
  // so whatever HTML is on screen is only PART of the article.
  function truncationSignal() {
    return [...document.querySelectorAll('button, [role="button"], a')].some(el => {
      if (!visible(el)) return false;
      const t = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
      return t.includes('continue generating');
    });
  }

  function providerIssue(ready) {
    const alertText = [...document.querySelectorAll('[role="alert"], [role="status"], main')]
      .filter(visible).slice(0, 6)
      .map(el => (el.innerText || el.textContent || '').slice(0, 900))
      .join(' ');
    const text = (document.title + ' ' + alertText + ' ' + (document.body?.innerText || '').slice(0, 2600)).toLowerCase();
    if (!ready && /verify you are human|checking your browser|just a moment|needs to review the security|attention required|cf-browser-verification|cf-challenge|turnstile/.test(text)) {
      return 'AI provider requires browser verification';
    }
    if (!ready && /too many requests|rate limit|usage limit|limit reached|try again later|temporarily unavailable/.test(text)) {
      return 'AI provider limit or temporary outage detected';
    }
    if (!ready && /log in|login|sign in|sign up|create an account/.test(text)) {
      return 'AI provider login is required';
    }
    if (!ready && /network error|connection lost|failed to load|reload the page/.test(text)) {
      return 'AI provider page did not load cleanly';
    }
    return '';
  }

  // Dedicated usage-limit detector. Scans banners/toasts/dialogs/system messages
  // and a slice of the page for the SPECIFIC "you've hit your limit" copy the AI
  // providers show (incl. ChatGPT's GPT-5 weekly limit). Deliberately specific so
  // an article that merely contains the word "limit" can never trigger it.
  function usageLimitHit() {
    let zones = '';
    try {
      zones = [...document.querySelectorAll('[role="alert"], [role="status"], [role="dialog"], [class*="banner" i], [class*="toast" i], [class*="notice" i], [class*="modal" i], main')]
        .filter(visible).slice(0, 8)
        .map(el => (el.innerText || el.textContent || '')).join('  ');
    } catch (e) {}
    const text = (zones + '  ' + ((document.body && document.body.innerText) || '').slice(0, 4000))
      .toLowerCase().replace(/\s+/g, ' ');
    const patterns = [
      /you'?ve reached (?:your|our|the)[^.]{0,40}?limit/,
      /you'?ve hit (?:your|the)[^.]{0,40}?limit/,
      /reached (?:your|the) (?:weekly|daily|hourly|free plan|plus|pro)[^.]{0,30}?limit/,
      /\bweekly limit\b/,
      /reached (?:the|your)[^.]{0,20}?limit for gpt/,
      /reached our limit of messages/,
      /reached the current usage cap/,
      /you'?ll be able to send messages again/,
      /message limit reached/,
      /you'?re out of (?:free )?messages/,
      /limit resets (?:in|on|at)/
    ];
    for (const re of patterns) {
      const i = text.search(re);
      if (i >= 0) return text.slice(i, i + 160).trim();
    }
    return '';
  }

  function nearbyCopyButton(el) {
    const scope = el.closest('pre, figure, article, section, [class*="code" i], [class*="artifact" i]') || el.parentElement;
    if (!scope) return false;
    return [...scope.querySelectorAll('button, [role="button"]')].some(btn => {
      const label = [
        btn.getAttribute('aria-label'),
        btn.getAttribute('title'),
        btn.textContent
      ].filter(Boolean).join(' ').toLowerCase();
      return visible(btn) && (label.includes('copy') || label.includes('copy code'));
    });
  }

  function hasHtmlLabel(el) {
    const scope = el.closest('pre, figure, article, section, [class*="code" i], [class*="artifact" i]') || el.parentElement;
    const label = [
      el.className,
      el.getAttribute('data-language'),
      el.getAttribute('aria-label'),
      scope?.className,
      scope?.getAttribute?.('data-language'),
      scope?.textContent?.slice(0, 120)
    ].filter(Boolean).join(' ').toLowerCase();
    return /\bhtml\b/.test(label) || /language-html/.test(label);
  }

  function textOf(el) {
    // Code blocks are often scrolled/clipped, so innerText returns only the
    // VISIBLE lines and truncates large articles. textContent returns the full
    // literal source -- take whichever is longer so the WHOLE code box is read.
    const a = (el && el.innerText) || '';
    const b = (el && el.textContent) || '';
    return (b.length > a.length ? b : a).replace(/\u00a0/g, ' ').trim();
  }

  function addCandidate(el, source, fromAssistantMessage, seen, candidates) {
    if (!visible(el)) return;
    const text = textOf(el);
    if (text.length < 300) return;
    // More forgiving HTML detection — any common article tag is enough
    if (!/<(?:!doctype|html|head|body|article|section|main|div|p|h[1-6]|ul|ol|li|table|thead|tbody|tfoot|tr|td|th|figure|img|a|span)\b/i.test(text)) return;

    const signature = text.length + ':' + text.slice(0, 90) + ':' + text.slice(-90);
    if (seen.has(signature)) return;
    seen.add(signature);

    const articleTags = (text.match(/<(p|div|h[1-6]|article|section|ul|ol|li|img|a|table|figure)[\s>]/gi) || []).length;
    let score = Math.min(articleTags, 80);
    if (/<!doctype\s+html/i.test(text)) score += 12;
    if (/<\/html\s*>/i.test(text)) score += 8;
    if (/<\/(?:p|div|section|article|table|ul|ol)>/i.test(text.slice(-700))) score += 6;

    candidates.push({
      text,
      source,
      score,
      languageHtml: hasHtmlLabel(el),
      hasCopyButton: nearbyCopyButton(el),
      fromAssistantMessage,
      top: Math.round(el.getBoundingClientRect().top)
    });
  }

  // Gemini collapses long code blocks behind an expand toggle, and the
  // collapsed DOM genuinely lacks the hidden lines. Expand before reading.
  if (providerKind === 'gemini') {
    try {
      [...document.querySelectorAll('button, [role="button"]')].forEach((b) => {
        if (!visible(b)) return;
        const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.textContent || '')).toLowerCase();
        if (/expand|show more|show full|see more/.test(label) && !/collapse|show less/.test(label)) {
          try { b.click(); } catch (e) {}
        }
      });
    } catch (e) {}
  }

  const seen = new Set();
  const candidates = [];

  // ── Pass 1: Inside the last assistant message bubble ───────────────
  const assistantMsg = findLastAssistantMessage();
  if (assistantMsg) {
    assistantMsg.querySelectorAll('pre').forEach(el => addCandidate(el.querySelector('code') || el, 'pre', true, seen, candidates));
    assistantMsg.querySelectorAll('code').forEach(el => addCandidate(el, 'code', true, seen, candidates));
    addCandidate(assistantMsg, 'assistant-text', true, seen, candidates);
    // Claude artifact / code viewer
    assistantMsg.querySelectorAll(
      '[class*="code" i], [class*="artifact" i], [class*="syntax" i], [data-language], [data-testid*="code" i]'
    ).forEach(el => {
      if (el.querySelector('pre, code')) return;
      addCandidate(el, 'viewer', true, seen, candidates);
    });
  }

  // ── Pass 2: Global scan for any other code blocks ──────────────────
  document.querySelectorAll('pre').forEach(el => addCandidate(el.querySelector('code') || el, 'pre', false, seen, candidates));
  document.querySelectorAll('code').forEach(el => addCandidate(el, 'code', false, seen, candidates));
  document.querySelectorAll(
    '[class*="code" i], [class*="artifact" i], [class*="syntax" i], [data-language], [data-testid*="code" i]'
  ).forEach(el => {
    if (el.querySelector('pre, code')) return;
    addCandidate(el, 'viewer', false, seen, candidates);
  });

  // ── Pass 3: Look for Claude artifact panels (separate from message) ─
  if (providerKind === 'claude') {
    document.querySelectorAll('[class*="artifact" i] [class*="content" i], iframe[title*="artifact" i]').forEach(el => {
      if (el.tagName === 'IFRAME') return; // can't read iframe text from outside
      addCandidate(el, 'viewer', true, seen, candidates);
    });
  }

  // ── Pass 4: raw HTML blob from the reply — for when the model did NOT use a
  // clean <pre>/<code> block (rendered article, prose with inline tags, or a
  // virtualised/custom code viewer like Grok). Scans wider if nothing was found. ──
  (function () {
    function sliceHtmlBlob(t) {
      const str = String(t || '');
      const m = str.match(/<(?:!doctype\s+html|html|article|section|main|header|div|p|h[1-6]|ul|ol|table|figure)\b/i);
      if (!m) return '';
      const start = m.index;
      const htmlEnd = str.toLowerCase().lastIndexOf('</html>');
      if (htmlEnd > start) return str.slice(start, htmlEnd + 7);
      const end = str.lastIndexOf('>');
      if (end <= start) return '';
      return str.slice(start, end + 1);
    }
    function pushBlob(rawText, fromAssistant, srcName) {
      const blob = sliceHtmlBlob(rawText);
      if (!blob || blob.length < 300) return;
      const sig = 'blob:' + blob.length + ':' + blob.slice(0, 90) + ':' + blob.slice(-90);
      if (seen.has(sig)) return;
      seen.add(sig);
      const articleTags = (blob.match(/<(p|div|h[1-6]|article|section|ul|ol|li|img|a|table|figure)[\s>]/gi) || []).length;
      candidates.push({ text: blob, source: srcName || 'assistant-blob', score: Math.min(articleTags, 80) + (fromAssistant ? 20 : 0), languageHtml: true, hasCopyButton: false, fromAssistantMessage: fromAssistant, top: 0 });
    }
    if (assistantMsg) pushBlob(textOf(assistantMsg), true, 'assistant-blob');
    // If nothing usable yet, scan likely code/answer containers (covers Grok's
    // custom viewer, which is not a <pre>/<code> element).
    if (!candidates.length) {
      let scanned = 0;
      document.querySelectorAll('[class*="code" i], [class*="response" i], [class*="markdown" i], [class*="prose" i], [class*="message" i], main, article').forEach(el => {
        if (scanned > 60) return;
        scanned++;
        try { const t = el.innerText || el.textContent || ''; if (t.length > 300) pushBlob(t, true, 'viewer-blob'); } catch (e) {}
      });
    }
    // Absolute last resort: the whole page text (verify + completeness still gate it).
    if (!candidates.length) { try { pushBlob((document.body && (document.body.innerText || document.body.textContent)) || '', false, 'page-blob'); } catch (e) {} }
  })();

  candidates.sort((a, b) => b.score - a.score || b.top - a.top || b.text.length - a.text.length);

  const ready = composerReady();
  const aText = assistantMsg ? textOf(assistantMsg) : '';
  // A code card/block exists even when its text is virtualised down to a few
  // chars (modern ChatGPT). Used to trigger copy-button extraction instead of
  // waiting out the whole timeout on an "8 char" reply.
  let hasCodeCard = false;
  try {
    const scope = assistantMsg || document;
    hasCodeCard = [...scope.querySelectorAll('pre, code, [data-testid*="code" i], [class*="code-block" i]')].some(visible);
  } catch (e) {}
  return {
    stillGenerating: isGenerating(),
    composerReady: ready,
    truncated: truncationSignal(),
    providerIssue: providerIssue(ready),
    candidates: candidates.slice(0, 10),
    hadAssistantMsg: !!assistantMsg,
    hasCodeCard: hasCodeCard,
    assistantLen: aText.length,
    assistantPreview: aText.slice(0, 200),
    usageLimit: usageLimitHit()
  };
}

// Runs in the AI tab (v3.46.0 Fact-Check). SELF-CONTAINED on purpose: the
// last-assistant-message selectors, the still-generating signals and the
// usage-limit detector are copied from readAICodeSnapshot, because injected
// functions cannot share code. Returns the code-block texts of the LAST
// assistant message and its whole text, for the JSON verdict.
function readAIJsonSnapshot(providerKind) {
  function visible(el) {
    const r = el?.getBoundingClientRect?.();
    return !!r && (r.width > 0 && r.height > 0 || (window.innerWidth || 0) < 500 || !document.documentElement?.getBoundingClientRect().width);
  }

  // ── Provider-specific assistant-message locators (as readAICodeSnapshot) ─
  function findLastAssistantMessage() {
    let nodes = [];
    if (providerKind === 'chatgpt') {
      nodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
      if (nodes.length === 0) {
        nodes = [...document.querySelectorAll('article[data-testid^="conversation-turn"]')];
      }
    } else if (providerKind === 'claude') {
      nodes = [...document.querySelectorAll(
        '[data-is-streaming], [data-test-render-count], [data-testid*="message" i], [data-testid*="conversation" i], [class*="font-claude" i], [class*="prose" i], [class*="markdown" i], [class*="message" i]'
      )].filter(el => {
        if (!visible(el)) return false;
        if (el.querySelector?.('[data-blogedit-composer="1"]')) return false;
        const text = (el.innerText || el.textContent || '').trim();
        return text.length > 20 || el.querySelector('pre, code');
      });
    } else if (providerKind === 'gemini') {
      nodes = [...document.querySelectorAll('message-content, model-response, [class*="model-response" i]')];
    } else if (providerKind === 'grok') {
      nodes = [...document.querySelectorAll('[class*="message-bubble" i], [class*="response-content" i]')];
    } else if (providerKind === 'deepseek') {
      nodes = [...document.querySelectorAll('[class*="message" i][class*="assistant" i], .markdown')];
    } else {
      // v3.46.0: any other chat website (a custom AI address, Perplexity, AI
      // Studio …) — the common assistant-message markers, most specific first.
      const generic = [
        '[data-message-author-role="assistant"]',
        '[data-role="assistant"], [data-author="assistant"], [class*="assistant" i]',
        '[class*="markdown" i], [class*="prose" i]',
        '[class*="response" i], [class*="answer" i], [class*="model-message" i], [class*="bot-message" i]'
      ];
      for (let g = 0; g < generic.length && !nodes.length; g++) {
        nodes = [...document.querySelectorAll(generic[g])].filter(el => {
          if (!visible(el)) return false;
          if (el.querySelector?.('[contenteditable="true"], textarea')) return false;
          const text = (el.innerText || el.textContent || '').trim();
          // A container that also holds our own message (the payload banners) is not the reply.
          return text.length > 0 && text.indexOf('ARTICLE HTML START') < 0;
        });
      }
    }
    nodes = nodes.filter(visible);
    return nodes[nodes.length - 1] || null;
  }

  // ── Still-generating signal (as readAICodeSnapshot) ─────────────────────
  function isGenerating() {
    const stopSelectors = [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label*="stop generating" i]',
      'button[aria-label*="stop response" i]',
      'button[aria-label*="stop streaming" i]',
      'button[aria-label*="stop model" i]',
      'button[title*="stop generating" i]',
      'button[title*="stop response" i]'
    ];
    if ([...document.querySelectorAll(stopSelectors.join(','))].some(el => visible(el) && !el.disabled)) {
      return true;
    }
    if (document.querySelector('[data-is-streaming="true"]')) return true;
    if (providerKind === 'chatgpt' && document.querySelector('.result-streaming')) return true;
    if (providerKind === 'gemini' && document.querySelector('[class*="loading-indicator" i]')) return true;
    return [...document.querySelectorAll('button')].some(el => {
      if (!visible(el) || el.disabled) return false;
      const text = (el.textContent || '').trim().toLowerCase();
      return /^(stop|stop generating|stop response|stop streaming)$/.test(text);
    });
  }

  // ── Usage-limit detector (as readAICodeSnapshot) ────────────────────────
  function usageLimitHit() {
    let zones = '';
    try {
      zones = [...document.querySelectorAll('[role="alert"], [role="status"], [role="dialog"], [class*="banner" i], [class*="toast" i], [class*="notice" i], [class*="modal" i], main')]
        .filter(visible).slice(0, 8)
        .map(el => (el.innerText || el.textContent || '')).join('  ');
    } catch (e) {}
    const text = (zones + '  ' + ((document.body && document.body.innerText) || '').slice(0, 4000))
      .toLowerCase().replace(/\s+/g, ' ');
    const patterns = [
      /you'?ve reached (?:your|our|the)[^.]{0,40}?limit/,
      /you'?ve hit (?:your|the)[^.]{0,40}?limit/,
      /reached (?:your|the) (?:weekly|daily|hourly|free plan|plus|pro)[^.]{0,30}?limit/,
      /\bweekly limit\b/,
      /reached (?:the|your)[^.]{0,20}?limit for gpt/,
      /reached our limit of messages/,
      /reached the current usage cap/,
      /you'?ll be able to send messages again/,
      /message limit reached/,
      /you'?re out of (?:free )?messages/,
      /limit resets (?:in|on|at)/
    ];
    for (const re of patterns) {
      const i = text.search(re);
      if (i >= 0) return text.slice(i, i + 160).trim();
    }
    return '';
  }

  function textOf(el) {
    const a = (el && el.innerText) || '';
    const b = (el && el.textContent) || '';
    return (b.length > a.length ? b : a).replace(/\u00a0/g, ' ').trim();
  }

  const msg = findLastAssistantMessage();
  const texts = [];
  if (msg) {
    const seen = new Set();
    const push = (el) => {
      const t = textOf(el);
      if (!t || seen.has(t)) return;
      seen.add(t);
      texts.push(t);
    };
    msg.querySelectorAll('pre').forEach(pre => push(pre.querySelector('code') || pre));
    msg.querySelectorAll('code').forEach(el => { if (!el.closest('pre')) push(el); });
  }
  // v3.46.0: no code block found in (or no match for) the assistant message —
  // the last code blocks anywhere on the page, the way readAICodeSnapshot's
  // global pass does. The caller drops our own prompt (echo guard), and the
  // verdict must still parse and validate.
  if (!texts.length) {
    const seen = new Set();
    [...document.querySelectorAll('pre')].filter(visible).slice(-6).forEach(pre => {
      if (pre.closest('[contenteditable="true"], textarea')) return;
      const t = textOf(pre.querySelector('code') || pre);
      if (!t || seen.has(t)) return;
      seen.add(t);
      texts.push(t);
    });
  }
  return {
    isGenerating: isGenerating(),
    texts: texts.slice(0, 12),
    messageText: msg ? textOf(msg).slice(0, 200000) : '',
    hadAssistantMsg: !!msg,
    usageLimit: usageLimitHit()
  };
}

// Runs in the AI tab. Clicks ChatGPT's "Continue generating" button when a
// reply hits the per-message output cap, so the code box keeps growing.
function clickContinueGenerating() {
  function visible(el) { const r = el.getBoundingClientRect && el.getBoundingClientRect(); return !!r && (r.width > 0 && r.height > 0 || (window.innerWidth || 0) < 500 || !document.documentElement?.getBoundingClientRect().width); }
  const els = [].slice.call(document.querySelectorAll('button, [role="button"], a'));
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    if (!visible(el) || el.disabled) continue;
    const t = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim().toLowerCase();
    if (t.indexOf('continue generating') !== -1) {
      try { el.click(); return { clicked: true }; } catch (e) {}
    }
  }
  return { clicked: false };
}

// Runs in the AI tab. Finds dialog / modal / overlay / toast popups (e.g. ChatGPT's
// "Too many requests") and clicks their safe dismiss button (Got it / OK / Close /
// Continue / I understand). Never clicks destructive actions.
function dismissBlockingDialogs() {
  function visible(el) { const r = el.getBoundingClientRect && el.getBoundingClientRect(); return !!r && (r.width > 0 && r.height > 0 || (window.innerWidth || 0) < 500 || !document.documentElement?.getBoundingClientRect().width); }
  const dismissRe = /^(got it|got it!|ok|okay|dismiss|close|continue|i understand|understood|done|maybe later|no thanks|reload|try again)$/i;
  const destructiveRe = /delete|remove|regenerate|new chat|log ?out|sign ?out|\bclear\b|cancel|\bstop\b|upgrade|subscribe|buy|pay/i;
  const containers = [].slice.call(document.querySelectorAll(
    '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [class*="modal" i], [class*="dialog" i], [class*="overlay" i], [class*="popover" i], [class*="toast" i], [class*="snackbar" i]'
  )).filter(visible);
  let clicked = 0;
  for (let ci = 0; ci < containers.length; ci++) {
    const btns = [].slice.call(containers[ci].querySelectorAll('button, [role="button"]')).filter(visible);
    for (let bi = 0; bi < btns.length; bi++) {
      const b = btns[bi];
      const txt  = (b.textContent || '').replace(/\s+/g, ' ').trim();
      const aria = (b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const okToClick = (dismissRe.test(txt) || dismissRe.test(aria));
      const bad = (destructiveRe.test(txt) || destructiveRe.test(aria));
      if (okToClick && !bad) { try { b.click(); clicked++; } catch (e) {} }
    }
  }
  return { clicked };
}

// Runs in the PAGE's main world. Wraps the clipboard write, clicks the visible
// "Copy" button(s), and returns the longest text the page tried to copy — which is
// the full code block, even if the on-screen viewer only rendered part of it.
function captureCopyButtonText(providerKind, lastMessageOnly, strictCodeOnly) {
  return new Promise((resolve) => {
    let captured = '';
    let htmlCaptured = '';
    function take(t) { t = String(t || ''); if (t.length > captured.length) captured = t; }
    function decodeHtmlFlavor(h) {
      let t = String(h || '');
      const m = t.match(/^\s*<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>\s*$/i);
      if (m) t = m[1];
      if (/&#x3c;|&lt;/i.test(t)) {
        t = t.replace(/&#x3c;/gi, '<').replace(/&#x3e;/gi, '>')
             .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
             .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
      }
      if (t.length > htmlCaptured.length) htmlCaptured = t;
    }
    const onCopy = (e) => {
      try { const dt = e.clipboardData || window.clipboardData; if (dt && dt.getData) take(dt.getData('text/plain')); } catch (_) {}
    };
    document.addEventListener('copy', onCopy, true);
    let origWriteText = null;
    let origWrite = null;
    // Programmatic copy may be rejected without user activation; capture still succeeds.
    function finishClipboardAttempt(attempt) {
      try {
        return Promise.resolve(attempt).catch(function () { return undefined; });
      } catch (_) {
        return Promise.resolve();
      }
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = function (text) {
          take(text);
          try { return finishClipboardAttempt(origWriteText(text)); } catch (_) { return Promise.resolve(); }
        };
      }
      // New ChatGPT code cards copy via clipboard.write(ClipboardItem) — the
      // old writeText hook never saw those, so capture used to come back empty.
      if (navigator.clipboard && navigator.clipboard.write) {
        origWrite = navigator.clipboard.write.bind(navigator.clipboard);
        navigator.clipboard.write = function (items) {
          try {
            const list = items || [];
            for (let i = 0; i < list.length; i++) {
              const it = list[i];
              if (it && it.getType && it.types) {
                [].slice.call(it.types).forEach((tp) => {
                  const tps = String(tp);
                  if (tps === 'text/plain') {
                    try { it.getType(tps).then((b) => b.text()).then(take).catch(() => {}); } catch (_) {}
                  } else if (tps === 'text/html') {
                    // Some code cards offer ONLY an entity-encoded text/html
                    // flavor; decode it as a fallback (used only if longer than
                    // the plain capture). Handles "Failed to copy" cases where
                    // the real clipboard write was rejected by the browser.
                    try { it.getType(tps).then((b) => b.text()).then(decodeHtmlFlavor).catch(() => {}); } catch (_) {}
                  }
                });
              }
            }
          } catch (_) {}
          try { return finishClipboardAttempt(origWrite(items)); } catch (_) { return Promise.resolve(); }
        };
      }
    } catch (_) {}
    function lastAssistantScope() {
      let nodes = [];
      try {
        if (providerKind === 'chatgpt') nodes = document.querySelectorAll('[data-message-author-role="assistant"]');
        else if (providerKind === 'claude') nodes = document.querySelectorAll('[data-is-streaming], [class*="font-claude" i]');
        else if (providerKind === 'gemini') nodes = document.querySelectorAll('message-content, model-response');
        else if (providerKind === 'grok') nodes = document.querySelectorAll('[class*="message-bubble" i], [class*="response-content" i]');
      } catch (_) {}
      const arr = [].slice.call(nodes || []);
      return arr.length ? arr[arr.length - 1] : null;
    }
    const isVis = (el) => { const r = el.getBoundingClientRect && el.getBoundingClientRect(); return !!r && (r.width > 0 && r.height > 0 || (window.innerWidth || 0) < 500 || !document.documentElement?.getBoundingClientRect().width); };
    function isCopyBtn(b) {
      if (!isVis(b)) return false;
      const label = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.getAttribute('data-testid') || '')).toLowerCase();
      return label.indexOf('copy') !== -1 || label.indexOf('copied') !== -1 || label.indexOf('clipboard') !== -1;
    }
    function copyButtonsIn(root) {
      return [].slice.call(root.querySelectorAll('button, [role="button"]')).filter(isCopyBtn);
    }
    // The code-block's OWN copy button gives the raw, complete HTML (best). It
    // lives in the <pre>'s header/toolbar. Collect those first and in order.
    function codeCardCopyButtons(scope) {
      const out = [];
      const pres = [].slice.call((scope || document).querySelectorAll('pre'));
      pres.forEach((pre) => {
        try { pre.scrollIntoView({ block: 'center' }); } catch (_) {}
        // The copy button is usually a sibling/ancestor-contained control, not
        // inside <pre> itself — search the surrounding code-card container.
        const card = pre.closest('div') || pre.parentElement || pre;
        let host = card;
        for (let up = 0; up < 3 && host; up++) {
          copyButtonsIn(host).forEach((b) => { if (out.indexOf(b) === -1) out.push(b); });
          host = host.parentElement;
        }
      });
      return out;
    }
    // Order: code-card copy buttons (raw HTML) first, then message-level copy.
    let btns = [];
    const scope = lastMessageOnly ? lastAssistantScope() : null;
    if (scope) {
      btns = codeCardCopyButtons(scope);
      if (!strictCodeOnly) {
        // Only when NOT strict may we fall back to message-level copy buttons —
        // those copy the whole reply (prose + code), which strict mode forbids.
        copyButtonsIn(scope).forEach((b) => { if (btns.indexOf(b) === -1) btns.push(b); });
        if (scope.parentElement) copyButtonsIn(scope.parentElement).forEach(function (b) { if (btns.indexOf(b) === -1) btns.push(b); });
      }
    }
    if (!btns.length) {
      btns = codeCardCopyButtons(document);
      if (!strictCodeOnly) {
        copyButtonsIn(document).slice(-4).forEach(function (b) { if (btns.indexOf(b) === -1) btns.push(b); });
      }
    }
    // Also try reading the system clipboard directly after the clicks — works
    // when the worker window is focused (the background script focuses it).
    // v3.46.0: readText() can stay pending forever while Chrome's clipboard
    // permission prompt is unanswered (focused tab, permission 'prompt'), so
    // it is raced against a short timer — the capture never hangs a post.
    async function readClipboard() {
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          const t = await Promise.race([
            navigator.clipboard.readText(),
            new Promise(function (res) { setTimeout(function () { res(''); }, 1500); })
          ]);
          take(t);
        }
      } catch (_) {}
    }
    // Direct DOM read: the full literal code usually lives in <pre>/<code>
    // textContent even when the on-screen viewer clips or scrolls it, so capture
    // it regardless of whether a copy button can be found or clicked.
    try {
      const dscope = scope || document;
      [].slice.call(dscope.querySelectorAll('pre code, pre, code')).forEach(function (c) {
        try { take(c.textContent || ''); } catch (_) {}
      });
    } catch (_) {}
    const cleanup = function () {
      try { document.removeEventListener('copy', onCopy, true); } catch (_) {}
      try { if (origWriteText) navigator.clipboard.writeText = origWriteText; } catch (_) {}
      try { if (origWrite) navigator.clipboard.write = origWrite; } catch (_) {}
      resolve(captured.length >= htmlCaptured.length ? captured : htmlCaptured);
    };
    if (btns.length === 0) { setTimeout(cleanup, 100); return; }
    const toClick = btns.slice(0, 6);
    let i = 0;
    const step = function () {
      if (i < toClick.length) {
        try { toClick[i].scrollIntoView({ block: 'center' }); } catch (_) {}
        try { toClick[i].click(); } catch (_) {}
        i++;
        setTimeout(step, 450);
      } else {
        // Give async ClipboardItem blobs time, then read the clipboard directly.
        setTimeout(function () { readClipboard().then(function () { setTimeout(cleanup, 400); }); }, 1400);
      }
    };
    step();
  });
}
