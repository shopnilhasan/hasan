'use strict';
// ═══════════════════════════════════════════════════════════════════════
// load-background.js — runs extension/background.js in a Node vm context
//
// The service worker is a classic script, so its top-level function
// declarations become properties of the vm context (ctx.buildAIPayload …).
// Top-level let/const (runtime, …) are NOT properties: reach them with
// ctx.__run('runtime.job') or ctx.__setJob(job).
//
// Stubs:
//   • chrome.*  runtime / storage / alarms / tabs / windows / scripting /
//               notifications / power / action — every method is a no-op that
//               returns a Promise; every on* event has add/remove/hasListener.
//               chrome.storage.local is a small in-memory store (ctx.__storage).
//   • importScripts('safety-gate.js') evaluates extension/safety-gate.js in
//               the SAME context (so it sets self.SafetyGate, exactly like the
//               worker). opts.gate === false makes importScripts throw instead
//               (the "file could not be loaded" path).
//
// Usage:
//   const { loadBackground } = require('./load-background');
//   const ctx = loadBackground({ storage: { __originalsBackup: [...] } });
//
// Options:
//   storage   initial chrome.storage.local contents (copied)
//   fetch     fetch implementation for the worker (default: rejects)
//   gate      false = importScripts throws (default: load safety-gate.js)
//   source    background.js source text to run instead of the current file
//             (used to load the v3.45.0 baseline from git)
//   quiet     false = pass console output through (default: captured only)
// ═══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO_ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(REPO_ROOT, 'extension');
const BACKGROUND_FILE = path.join(EXT_DIR, 'background.js');
const SAFETY_GATE_FILE = path.join(EXT_DIR, 'safety-gate.js');

function makeEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(fn) { listeners.push(fn); },
    removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    hasListener(fn) { return listeners.indexOf(fn) >= 0; },
    hasListeners() { return listeners.length > 0; }
  };
}

// A namespace whose explicitly given members win; anything else is an async
// no-op (or an event object for on* names), created on first access.
function makeNamespace(name, members) {
  const target = Object.assign({}, members || {});
  return new Proxy(target, {
    get(t, key) {
      if (typeof key !== 'string') return t[key];
      if (key in t) return t[key];
      if (key === 'then' || key === 'lastError') return undefined;
      t[key] = /^on[A-Z]/.test(key) ? makeEvent() : function () { return Promise.resolve(undefined); };
      return t[key];
    }
  });
}

function makeStorageArea(backing) {
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    async get(keys) {
      const out = {};
      if (keys === null || keys === undefined) {
        Object.keys(backing).forEach((k) => { out[k] = clone(backing[k]); });
      } else if (typeof keys === 'string') {
        if (keys in backing) out[keys] = clone(backing[keys]);
      } else if (Array.isArray(keys)) {
        keys.forEach((k) => { if (k in backing) out[k] = clone(backing[k]); });
      } else if (typeof keys === 'object') {
        Object.keys(keys).forEach((k) => { out[k] = (k in backing) ? clone(backing[k]) : keys[k]; });
      }
      return out;
    },
    async set(items) {
      Object.keys(items || {}).forEach((k) => { backing[k] = clone(items[k]); });
    },
    async remove(keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach((k) => { delete backing[k]; });
    },
    async clear() {
      Object.keys(backing).forEach((k) => { delete backing[k]; });
    },
    onChanged: makeEvent()
  };
}

function makeChrome(storageBacking) {
  const local = makeStorageArea(storageBacking);
  return {
    runtime: makeNamespace('runtime', {
      id: 'test-extension-id',
      lastError: undefined,
      getURL: (p) => 'chrome-extension://test-extension-id/' + String(p || '').replace(/^\/+/, ''),
      getManifest: () => JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8')),
      getPlatformInfo: async () => ({ os: 'linux', arch: 'x86-64' }),
      sendMessage: async () => undefined
    }),
    storage: makeNamespace('storage', { local, session: makeStorageArea({}), onChanged: makeEvent() }),
    alarms: makeNamespace('alarms', { clear: async () => true, clearAll: async () => true, create: async () => undefined, get: async () => undefined, getAll: async () => [] }),
    tabs: makeNamespace('tabs', { query: async () => [], get: async () => { throw new Error('No tab with id'); } }),
    windows: makeNamespace('windows', { getAll: async () => [] }),
    scripting: makeNamespace('scripting', { executeScript: async () => [] }),
    notifications: makeNamespace('notifications', {}),
    power: makeNamespace('power', { requestKeepAwake: () => undefined, releaseKeepAwake: () => undefined }),
    action: makeNamespace('action', {})
  };
}

function loadBackground(opts) {
  opts = opts || {};
  const storage = JSON.parse(JSON.stringify(opts.storage || {}));
  const chrome = makeChrome(storage);
  const consoleLines = [];
  const capture = (level) => function () {
    const line = Array.prototype.map.call(arguments, (a) => (typeof a === 'string' ? a : String(a))).join(' ');
    consoleLines.push({ level, line });
    if (opts.quiet === false) console[level === 'log' ? 'log' : level](line);
  };
  const ctx = {
    console: { log: capture('log'), info: capture('log'), debug: capture('log'), warn: capture('warn'), error: capture('error') },
    chrome,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, URLSearchParams, AbortController, TextEncoder, TextDecoder, structuredClone,
    atob, btoa,
    fetch: opts.fetch || (async () => { throw new TypeError('fetch is not available in the unit-test worker'); })
  };
  ctx.self = ctx;
  ctx.globalThis = ctx;
  ctx.importScripts = function () {
    for (let i = 0; i < arguments.length; i++) {
      const name = String(arguments[i]);
      if (opts.gate === false) throw new Error("Failed to execute 'importScripts': " + name + ' failed to load.');
      const file = path.join(EXT_DIR, name);
      vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
    }
  };
  vm.createContext(ctx);
  const source = (typeof opts.source === 'string') ? opts.source : fs.readFileSync(BACKGROUND_FILE, 'utf8');
  vm.runInContext(source, ctx, { filename: BACKGROUND_FILE });

  const hidden = (name, value) => Object.defineProperty(ctx, name, { value, enumerable: false, configurable: true, writable: true });
  hidden('__storage', storage);
  hidden('__chrome', chrome);
  hidden('__console', consoleLines);
  hidden('__run', (code) => vm.runInContext(code, ctx));
  hidden('__set', (name, value) => { ctx.__value = value; vm.runInContext(name + ' = __value;', ctx); delete ctx.__value; });
  hidden('__setJob', (job) => { ctx.__set('runtime.job', job); return job; });
  hidden('__logs', () => vm.runInContext('runtime.log', ctx).map((l) => l.kind + ' ' + l.msg));
  return ctx;
}

module.exports = { loadBackground, REPO_ROOT, EXT_DIR, BACKGROUND_FILE, SAFETY_GATE_FILE };
