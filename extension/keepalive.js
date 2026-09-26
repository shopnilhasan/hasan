// ══════════════════════════════════════════════════════════════════════
// MINIMIZED / HIDDEN WINDOW SURVIVAL KIT  (MAIN world, document_start)
//
// Why this is a content script and not an injected function:
// Chrome suspends the whole RENDERING LIFECYCLE for a hidden window —
// minimized, or (on Windows) fully covered by another window. Three browser
// features are delivered by that lifecycle and therefore never fire:
//
//     requestAnimationFrame   -> streaming replies stop painting
//     ResizeObserver          -> Gemini's Quill editor never sizes itself,
//                                so the composer "never becomes ready"
//     IntersectionObserver    -> virtualised lists never render their rows,
//                                so a long code block is only half there
//
// Injecting the patches after the page has loaded is too late: Angular and
// Quill have already booted, already read document.hidden, and already handed
// their layout work to observers that will never call back. The fix has to be
// in place BEFORE the provider's own scripts run, which only a document_start
// content script can guarantee.
//
// Everything here is inert while the window is genuinely on screen: each
// fallback first checks whether real animation frames are still arriving, and
// does nothing if they are. Only a frozen renderer is ever patched around.
// ══════════════════════════════════════════════════════════════════════
(function () {
  if (window.__apuKeepAlive) return;
  window.__apuKeepAlive = true;

  var FROZEN_MS = 1000;   // no real frame for this long = the renderer is asleep
  var TICK_MS = 250;

  var realRaf = window.requestAnimationFrame && window.requestAnimationFrame.bind(window);
  var realCancel = window.cancelAnimationFrame && window.cancelAnimationFrame.bind(window);
  var lastFrameAt = 0;

  function now() {
    try { return performance.now(); } catch (e) { return Date.now(); }
  }
  lastFrameAt = now();

  // The heartbeat runs on the REAL rAF. While the window is visible it updates
  // 60x a second; the moment Chrome freezes the lifecycle it stops, and that
  // silence is our signal.
  if (realRaf) {
    (function beat() {
      lastFrameAt = now();
      try { realRaf(beat); } catch (e) {}
    })();
  }
  function frozen() { return (now() - lastFrameAt) > FROZEN_MS; }
  window.__apuFrozen = frozen;

  // ── 1) The page must believe it is on screen ──
  // Gemini and ChatGPT both throttle their own streaming when they think the
  // tab is in the background. Applied at document_start, before any of their
  // code has had a chance to read it.
  try {
    Object.defineProperty(document, 'hidden', { configurable: true, get: function () { return false; } });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return 'visible'; } });
    Object.defineProperty(document, 'webkitHidden', { configurable: true, get: function () { return false; } });
    Object.defineProperty(document, 'webkitVisibilityState', { configurable: true, get: function () { return 'visible'; } });
    document.hasFocus = function () { return true; };
  } catch (e) {}
  try {
    var swallow = function (ev) { ev.stopImmediatePropagation(); };
    document.addEventListener('visibilitychange', swallow, true);
    document.addEventListener('webkitvisibilitychange', swallow, true);
    window.addEventListener('blur', swallow, true);
  } catch (e) {}

  // ── 2) requestAnimationFrame ──
  // A frozen frame callback is run off a timer instead. Frames the page
  // cancelled must never be revived: ChatGPT's ProseMirror editor cancels
  // constantly and running a cancelled callback corrupts its view state.
  var pending = new Map();
  var fakeId = -1;

  if (realRaf) {
    window.requestAnimationFrame = function (cb) {
      var id = 0, done = false, timer = 0;

      function run(ts) {
        if (done) return;
        done = true;
        if (timer) { clearTimeout(timer); timer = 0; }
        pending.delete(id);
        try { cb(ts === undefined ? now() : ts); } catch (e) {}
      }
      function tick() {
        if (done) return;
        // Still painting normally? Leave the real frame to do its job.
        if (!frozen()) { timer = setTimeout(tick, TICK_MS); return; }
        run(now());
      }
      function cancel() {
        done = true;
        if (timer) { clearTimeout(timer); timer = 0; }
      }

      try { id = realRaf(run); } catch (e) { id = fakeId--; }
      pending.set(id, { run: run, cancel: cancel });
      // Only pay for a fallback timer when the renderer is ALREADY frozen. A
      // frame requested while the window was visible and frozen a moment later
      // is still in `pending`, so the pump runs it — nothing is stranded, and a
      // page painting normally creates no extra timers at all.
      if (frozen()) timer = setTimeout(tick, TICK_MS);
      return id;
    };
    window.cancelAnimationFrame = function (id) {
      var p = pending.get(id);
      if (p) { p.cancel(); pending.delete(id); }
      try { if (realCancel) realCancel(id); } catch (e) {}
    };
  }

  // ── 3) ResizeObserver ──
  // This is the one that actually breaks Gemini. Quill asks a ResizeObserver
  // for the composer's size and waits for the answer; in a frozen renderer the
  // answer never comes, so the editor stays unusable and the run fails with
  // "chat input did not become ready". The fallback measures the element
  // directly and delivers the callback itself.
  var roList = new Set();
  var RealRO = window.ResizeObserver;
  if (RealRO) {
    var PatchedRO = function (cb) {
      var self = this;
      var sizes = new Map();
      var real = null;
      try {
        real = new RealRO(function (entries) {
          // A real delivery is the truth: re-baseline so the fallback does not
          // repeat it.
          try {
            for (var i = 0; i < entries.length; i++) {
              var rr = entries[i].contentRect;
              if (rr) sizes.set(entries[i].target, { w: rr.width, h: rr.height });
            }
          } catch (e) {}
          try { cb(entries, self); } catch (e) {}
        });
      } catch (e) {}

      this.observe = function (el, opts) {
        // -1 guarantees the fallback delivers an initial size, which is
        // exactly the delivery Quill never receives in a hidden window.
        if (!sizes.has(el)) sizes.set(el, { w: -1, h: -1 });
        try { if (real) real.observe(el, opts); } catch (e) {}
      };
      this.unobserve = function (el) {
        sizes.delete(el);
        try { if (real) real.unobserve(el); } catch (e) {}
      };
      this.disconnect = function () {
        sizes.clear();
        roList.delete(self);
        try { if (real) real.disconnect(); } catch (e) {}
      };
      this.__apuFlush = function () {
        var out = [];
        sizes.forEach(function (last, el) {
          var r;
          try { r = el.getBoundingClientRect(); } catch (e) { return; }
          if (!r) return;
          if (Math.abs(r.width - last.w) > 0.5 || Math.abs(r.height - last.h) > 0.5) {
            last.w = r.width; last.h = r.height;
            var box = [{ inlineSize: r.width, blockSize: r.height }];
            out.push({
              target: el,
              contentRect: r,
              borderBoxSize: box,
              contentBoxSize: box,
              devicePixelContentBoxSize: box
            });
          }
        });
        if (out.length) { try { cb(out, self); } catch (e) {} }
      };
      roList.add(this);
    };
    PatchedRO.prototype = RealRO.prototype;
    window.ResizeObserver = PatchedRO;
  }

  // ── 4) IntersectionObserver ──
  // Virtualised message lists and collapsed code cards only render the rows an
  // IntersectionObserver reports as on screen. Frozen renderer, no report, no
  // rows — which is why a long article sometimes comes back half-copied. When
  // frozen we report every observed target as fully visible, so the provider
  // renders the lot and the full HTML is there to read.
  var ioList = new Set();
  var RealIO = window.IntersectionObserver;
  if (RealIO) {
    var PatchedIO = function (cb, opts) {
      var self = this;
      var targets = new Set();
      var real = null;
      try {
        real = new RealIO(function (entries) { try { cb(entries, self); } catch (e) {} }, opts);
      } catch (e) {}

      this.root = (opts && opts.root) || null;
      this.rootMargin = (opts && opts.rootMargin) || '0px';
      this.thresholds = [0];
      this.observe = function (el) { targets.add(el); try { if (real) real.observe(el); } catch (e) {} };
      this.unobserve = function (el) { targets.delete(el); try { if (real) real.unobserve(el); } catch (e) {} };
      this.disconnect = function () { targets.clear(); ioList.delete(self); try { if (real) real.disconnect(); } catch (e) {} };
      this.takeRecords = function () { try { return real ? real.takeRecords() : []; } catch (e) { return []; } };
      this.__apuFlush = function () {
        if (!targets.size) return;
        var out = [];
        targets.forEach(function (el) {
          var r;
          try { r = el.getBoundingClientRect(); } catch (e) { return; }
          if (!r) return;
          out.push({
            target: el,
            isIntersecting: true,
            intersectionRatio: 1,
            boundingClientRect: r,
            intersectionRect: r,
            rootBounds: null,
            time: now()
          });
        });
        if (out.length) { try { cb(out, self); } catch (e) {} }
      };
      ioList.add(this);
    };
    PatchedIO.prototype = RealIO.prototype;
    window.IntersectionObserver = PatchedIO;
  }

  // ── 5) The pump ──
  // Chrome clamps a hidden page's timers to one wake-up per second, and after
  // five minutes to one per MINUTE, so the in-page timers above cannot be
  // trusted on their own during a long batch. The extension's service worker
  // is not a page and is not throttled, so it calls this from its own loop —
  // that is the clock this page really runs on while Chrome is minimized.
  window.__apuPump = function () {
    if (!frozen()) return { frozen: false, ran: 0 };
    var ran = 0;
    pending.forEach(function (p) { try { p.run(now()); ran++; } catch (e) {} });
    roList.forEach(function (o) { try { o.__apuFlush(); } catch (e) {} });
    ioList.forEach(function (o) { try { o.__apuFlush(); } catch (e) {} });
    return { frozen: true, ran: ran };
  };

  // A local pump as well, for the stretches between service-worker calls.
  setInterval(function () { try { window.__apuPump(); } catch (e) {} }, 500);
})();
