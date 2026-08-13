/* ==========================================================================
   Goldo — site behaviour + Botpress webchat bridge
   --------------------------------------------------------------------------
   Every "start matching" control on the site routes through Goldo.openChat().
   The webchat bundle loads async from Botpress's CDN, so calls are queued
   until the SDK reports ready rather than assumed to work on click.
   ========================================================================== */

(function () {
  'use strict';

  // Send the founder's example prompt straight into the conversation after the
  // bot's opening message lands. Set to false to only open the panel.
  var PREFILL_ENABLED = true;
  var PREFILL_DELAY_MS = 1400;
  var READY_TIMEOUT_MS = 12000;

  var state = { ready: false, failed: false, notified: false };
  var queue = [];

  /* ------------------------------------------------------------- utilities */

  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  function bp() {
    return typeof window !== 'undefined' ? window.botpress : undefined;
  }

  /** Last resort: click whatever launcher Botpress actually injected. */
  function clickLauncher() {
    var selectors = [
      '[class*="bpFab"]',
      '#bp-web-widget button',
      '.bpw-widget-btn',
      '[data-testid="webchat-fab"]',
      'iframe#bp-widget'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el && typeof el.click === 'function') {
        el.click();
        return true;
      }
    }
    return false;
  }

  function flush() {
    var pending = queue.splice(0, queue.length);
    for (var i = 0; i < pending.length; i++) run(pending[i]);
  }

  function run(job) {
    var sdk = bp();
    if (!sdk) {
      if (!clickLauncher()) notifyUnavailable();
      return;
    }
    try {
      if (typeof sdk.open === 'function') sdk.open();
      else clickLauncher();
    } catch (err) {
      console.warn('[goldo] could not open webchat:', err && err.message);
      clickLauncher();
    }

    if (job.prompt && PREFILL_ENABLED && typeof sdk.sendMessage === 'function') {
      window.setTimeout(function () {
        try {
          sdk.sendMessage(job.prompt);
        } catch (err) {
          console.warn('[goldo] prefill failed:', err && err.message);
        }
      }, PREFILL_DELAY_MS);
    }
  }

  /** Shown only if the widget genuinely never arrives (blocked, offline, unpublished). */
  function notifyUnavailable() {
    if (state.notified) return;
    state.notified = true;

    var bar = document.createElement('div');
    bar.setAttribute('role', 'status');
    bar.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:24px', 'transform:translateX(-50%)',
      'max-width:min(520px,calc(100vw - 32px))', 'background:#141b2e', 'color:#f6f4ee',
      'padding:14px 18px', 'border-radius:3px', 'font:500 14px/1.5 Inter,system-ui,sans-serif',
      'box-shadow:0 12px 32px -12px rgba(0,0,0,.5)', 'z-index:9999', 'display:flex',
      'gap:14px', 'align-items:flex-start'
    ].join(';');
    bar.innerHTML =
      '<span style="flex:1">The chat assistant could not load. It is usually a browser ' +
      'extension or network blocking <code style="font-size:12px">botpress.cloud</code> — ' +
      'try again in a private window.</span>';

    var close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.style.cssText =
      'background:none;border:0;color:#c3c8d4;font-size:20px;line-height:1;cursor:pointer;padding:0 2px';
    close.addEventListener('click', function () { bar.remove(); });
    bar.appendChild(close);

    document.body.appendChild(bar);
    window.setTimeout(function () { bar.remove(); }, 12000);
  }

  /* ---------------------------------------------------------- public API */

  var Goldo = {
    /**
     * Open the Botpress webchat, optionally seeding it with a description.
     * Safe to call before the SDK has finished loading.
     */
    openChat: function (prompt) {
      var job = { prompt: prompt || null };
      if (state.ready) run(job);
      else queue.push(job);
      // If the SDK is already sitting there, don't wait for the ready event.
      if (!state.ready && bp() && typeof bp().open === 'function') {
        state.ready = true;
        flush();
      }
      return false;
    },
    isReady: function () { return state.ready; }
  };

  window.Goldo = Goldo;
  // Kept because the original landing page's inline onclick called this name.
  window.openGoldo = function () { return Goldo.openChat(); };

  /* --------------------------------------------- detect the SDK becoming ready */

  function markReady(source) {
    if (state.ready) return;
    state.ready = true;
    document.documentElement.setAttribute('data-goldo-chat', 'ready');
    if (window.console && console.debug) console.debug('[goldo] webchat ready via ' + source);
    flush();
  }

  function watchForSdk() {
    var sdk = bp();
    if (sdk && typeof sdk.on === 'function') {
      try {
        sdk.on('webchat:ready', function () { markReady('event'); });
      } catch (err) {
        /* older bundles may not expose this event */
      }
    }

    // Polling covers the window between inject.js defining window.botpress and
    // the bot config script finishing its own initialisation.
    var started = Date.now();
    var timer = window.setInterval(function () {
      if (state.ready) { window.clearInterval(timer); return; }
      var current = bp();
      if (current && typeof current.open === 'function') {
        window.clearInterval(timer);
        markReady('poll');
        return;
      }
      if (Date.now() - started > READY_TIMEOUT_MS) {
        window.clearInterval(timer);
        state.failed = true;
        document.documentElement.setAttribute('data-goldo-chat', 'unavailable');
        // Anything already queued gets the fallback path.
        if (queue.length) { queue.length = 0; notifyUnavailable(); }
      }
    }, 250);
  }

  /* --------------------------------------------------------- site behaviour */

  function bindTriggers() {
    document.addEventListener('click', function (event) {
      var trigger = event.target.closest('[data-goldo-open], [data-goldo-prompt]');
      if (!trigger) return;
      event.preventDefault();
      Goldo.openChat(trigger.getAttribute('data-goldo-prompt') || null);
    });
  }

  function bindNav() {
    var toggle = document.querySelector('.nav-toggle');
    var nav = document.querySelector('.site-nav');
    if (!toggle || !nav) return;

    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    nav.addEventListener('click', function (event) {
      if (event.target.tagName === 'A') {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && nav.classList.contains('open')) {
        nav.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
      }
    });
  }

  /** Mark the current page in the nav without hardcoding it per file. */
  function markCurrentPage() {
    var here = window.location.pathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
    if (here.length > 1) here = here.replace(/\/+$/, '');

    var links = document.querySelectorAll('.site-nav a[href]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href');
      if (!href || href.charAt(0) === '#' || /^https?:/.test(href)) continue;
      var target = href.replace(/\.html$/, '').replace(/#.*$/, '');
      if (target.length > 1) target = target.replace(/\/+$/, '');
      if (target === here || (here === '' && target === '/')) {
        links[i].setAttribute('aria-current', 'page');
      }
    }
  }

  function bindReveal() {
    var items = document.querySelectorAll('.reveal');
    if (!items.length) return;

    if (!('IntersectionObserver' in window)) {
      for (var i = 0; i < items.length; i++) items[i].classList.add('in');
      return;
    }
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

    for (var j = 0; j < items.length; j++) observer.observe(items[j]);
  }

  /**
   * Bars ship with their real width inline so they are correct with scripting
   * off. When JS is available, collapse them and grow them back on scroll.
   */
  function bindBars() {
    var fills = document.querySelectorAll('.bar-fill[data-pct]');
    if (!fills.length) return;

    function paint(el) {
      el.style.width = Math.max(1.5, Number(el.getAttribute('data-pct')) || 0) + '%';
    }
    if (!('IntersectionObserver' in window)) {
      for (var i = 0; i < fills.length; i++) paint(fills[i]);
      return;
    }
    for (var k = 0; k < fills.length; k++) fills[k].style.width = '0';
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          paint(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.25 });

    for (var j = 0; j < fills.length; j++) observer.observe(fills[j]);
  }

  function stampYear() {
    var nodes = document.querySelectorAll('[data-year]');
    var year = String(new Date().getFullYear());
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = year;
  }

  onReady(function () {
    bindTriggers();
    bindNav();
    markCurrentPage();
    bindReveal();
    bindBars();
    stampYear();
    watchForSdk();
  });
})();
