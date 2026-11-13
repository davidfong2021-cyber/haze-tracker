(() => {
  'use strict';
  const C = HazeCore;
  const $ = (sel) => document.querySelector(sel);
  const REFRESH_MS = 5 * 60 * 1000;
  const DEFAULTS = { enabled: false, region: 'central', metric: 'psi24', threshold: 100 };

  let settings = { ...DEFAULTS };
  let data = null;
  let installEvent = null;
  let timer = null;

  // ---------- helpers
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k === 'style') n.setAttribute('style', v);
      else n.setAttribute(k, v);
    }
    for (const kid of kids) n.append(kid);
    return n;
  }

  const timeFmt = new Intl.DateTimeFormat('en-SG', {
    timeZone: 'Asia/Singapore', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short',
  });
  const fmtTime = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : timeFmt.format(d);
  };

  const isStandalone = () =>
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  function showBanner(msg) {
    const b = $('#banner');
    b.textContent = msg || '';
    b.hidden = !msg;
  }

  // ---------- rendering
  function metricBlock(label, value, sub) {
    if (typeof value !== 'number') {
      return el('div', { class: 'metric' }, el('div', { class: 'lbl' }, label), el('div', { class: 'val' }, '–'));
    }
    const band = C.bandFor(value);
    const m = el('div', { class: 'metric', style: '--band: var(--' + band.key + ')' },
      el('div', { class: 'lbl' }, label),
      el('div', { class: 'val' }, String(value)),
      el('span', { class: 'pill' }, band.label));
    if (sub) m.append(el('div', { class: 'sub' }, sub));
    return m;
  }

  function renderCards() {
    const wrap = $('#cards');
    wrap.replaceChildren();
    if (!data) {
      wrap.append(el('p', { class: 'muted' }, 'No readings yet.'));
      return;
    }
    for (const r of C.REGIONS) {
      const d = data.regions[r];
      const watched = settings.enabled && settings.region === r;
      const head = el('div', { class: 'card-head' }, el('h3', {}, C.LABELS[r]));
      if (watched) head.append(el('span', { class: 'badge' }, 'Watching'));
      wrap.append(el('article', { class: 'card' + (watched ? ' watched' : '') },
        head,
        el('div', { class: 'metrics' },
          metricBlock('24-hr PSI', d.psi24),
          metricBlock('1-hr PSI (est.)', d.psi1, d.pm25 == null ? '' : d.pm25 + ' µg/m³ PM2.5'))));
    }
    $('#asof').textContent =
      '24-hr PSI as of ' + fmtTime(data.psiTimestamp) + ' · 1-hr PM2.5 as of ' + fmtTime(data.pmTimestamp) + ' (SGT)';
  }

  function watchedValue() {
    if (!data) return null;
    const v = data.regions[settings.region] && data.regions[settings.region][settings.metric];
    return typeof v === 'number' ? v : null;
  }

  function renderStatus(msg, isError) {
    const s = $('#alert-status');
    s.classList.toggle('error', !!isError);
    if (msg) { s.textContent = msg; return; }
    const toggle = $('#toggle');
    toggle.textContent = settings.enabled ? 'Turn off alerts' : 'Turn on alerts';
    toggle.classList.toggle('primary', !settings.enabled);
    toggle.classList.toggle('on', settings.enabled);
    if (!settings.enabled) { s.textContent = 'Alerts are off.'; return; }
    const v = watchedValue();
    const where = C.LABELS[settings.region] + ' ' + C.METRICS[settings.metric];
    if (v == null) { s.textContent = 'Alerts on for ' + where + '. Waiting for a reading.'; return; }
    s.textContent = v >= settings.threshold
      ? 'Alerts on. ' + where + ' is ' + v + ', already at or above ' + settings.threshold +
        '. You will be notified when it next rises to ' + settings.threshold + ' from below.'
      : 'Alerts on. ' + where + ' is ' + v + '. You will be notified when it reaches ' + settings.threshold + '.';
  }

  // ---------- settings
  async function saveSettings() {
    await C.idbSet('settings', settings);
    await C.idbDel('alertState'); // next check records a fresh baseline
  }

  function readForm() {
    const t = parseInt($('#threshold').value, 10);
    return {
      region: $('#region').value,
      metric: $('#metric').value,
      threshold: Number.isInteger(t) ? Math.min(500, Math.max(1, t)) : NaN,
    };
  }

  async function onFormChange() {
    const f = readForm();
    if (Number.isNaN(f.threshold)) return;
    settings = { ...settings, ...f };
    await saveSettings();
    if (settings.enabled) await refresh();
    renderCards();
    renderStatus();
  }

  async function registerBackgroundCheck(on) {
    try {
      const reg = await navigator.serviceWorker.ready;
      if (!('periodicSync' in reg)) return;
      if (!on) { await reg.periodicSync.unregister('haze-check'); return; }
      const perm = await navigator.permissions.query({ name: 'periodic-background-sync' });
      if (perm.state === 'granted') await reg.periodicSync.register('haze-check', { minInterval: 15 * 60 * 1000 });
    } catch (e) { /* not supported; foreground checks still work */ }
  }

  async function ensurePermission() {
    if (!('Notification' in window)) {
      renderStatus(isIOS() && !isStandalone()
        ? 'On iPhone and iPad, add this app to your Home Screen first, then open it from there to turn on alerts.'
        : 'This browser does not support notifications.', true);
      return false;
    }
    if (Notification.permission === 'denied') {
      renderStatus('Notifications are blocked. Allow them for this site in your browser or phone settings, then try again.', true);
      return false;
    }
    if (Notification.permission !== 'granted') {
      const res = await Notification.requestPermission();
      if (res !== 'granted') {
        renderStatus('Notification permission was not granted, so alerts are off.', true);
        return false;
      }
    }
    return true;
  }

  async function onToggle(ev) {
    ev.preventDefault();
    if (settings.enabled) {
      settings.enabled = false;
      await saveSettings();
      await registerBackgroundCheck(false);
      renderCards();
      renderStatus();
      return;
    }
    const f = readForm();
    if (Number.isNaN(f.threshold)) { renderStatus('Enter a threshold between 1 and 500.', true); return; }
    if (!(await ensurePermission())) return;
    settings = { ...settings, ...f, enabled: true };
    await saveSettings();
    await registerBackgroundCheck(true);
    await refresh();
    renderCards();
    renderStatus();
  }

  async function onTest() {
    if (!(await ensurePermission())) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification('Haze Tracker test', {
        body: 'Notifications are working. You will get one like this when your threshold is reached.',
        icon: 'icons/icon-192.png',
        tag: 'haze-test',
      });
      renderStatus('Test notification sent.');
    } catch (e) {
      renderStatus('Could not show a notification: ' + e.message, true);
    }
  }

  // ---------- data
  async function refresh() {
    const btn = $('#refresh');
    btn.classList.add('spin');
    try {
      const res = await C.runCheck((title, options) =>
        navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, options)));
      data = res.data;
      showBanner('');
    } catch (e) {
      if (!data) data = (await C.idbGet('lastData')) || null;
      showBanner(data
        ? 'Could not reach NEA. Showing the last readings saved ' + fmtTime(data.fetchedAt) + '.'
        : 'Could not reach NEA and there are no saved readings yet. Check your connection.');
    } finally {
      btn.classList.remove('spin');
    }
    renderCards();
    renderStatus();
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  }

  // ---------- install
  function setupInstall() {
    if (isStandalone()) return;
    const sec = $('#install');
    const text = $('#install-text');
    if (isIOS()) {
      text.textContent = 'In Safari, tap the Share button, then “Add to Home Screen”. Open the app from your Home Screen to enable alerts.';
      sec.hidden = false;
    }
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installEvent = e;
      text.textContent = 'Install Haze Tracker for quick access and background alert checks.';
      $('#install-btn').hidden = false;
      sec.hidden = false;
    });
    $('#install-btn').addEventListener('click', async () => {
      if (!installEvent) return;
      installEvent.prompt();
      await installEvent.userChoice;
      installEvent = null;
      sec.hidden = true;
    });
    window.addEventListener('appinstalled', () => { sec.hidden = true; });
  }

  // ---------- init
  async function init() {
    for (const r of C.REGIONS) $('#region').append(el('option', { value: r }, C.LABELS[r]));
    for (const [k, v] of Object.entries(C.METRICS)) $('#metric').append(el('option', { value: k }, v));

    try { settings = { ...DEFAULTS, ...((await C.idbGet('settings')) || {}) }; } catch (e) { /* use defaults */ }
    $('#region').value = settings.region;
    $('#metric').value = settings.metric;
    $('#threshold').value = settings.threshold;
    if (settings.enabled && 'Notification' in window && Notification.permission !== 'granted') {
      settings.enabled = false; // permission was revoked outside the app
      await C.idbSet('settings', settings);
    }

    try { data = (await C.idbGet('lastData')) || null; } catch (e) { /* none */ }
    renderCards();
    renderStatus();

    $('#alert-form').addEventListener('submit', onToggle);
    $('#test').addEventListener('click', onTest);
    $('#refresh').addEventListener('click', refresh);
    for (const id of ['#region', '#metric', '#threshold']) $(id).addEventListener('change', onFormChange);
    document.querySelectorAll('.chip').forEach((c) =>
      c.addEventListener('click', () => { $('#threshold').value = c.dataset.value; onFormChange(); }));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

    setupInstall();
    schedule();
    refresh();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  init();
})();
