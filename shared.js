/* Shared by the page (index.html) and the service worker (sw.js).
   Exposes a single global: HazeCore. */
(function (g) {
  'use strict';

  const API = 'https://api-open.data.gov.sg/v2/real-time/api';
  const REGIONS = ['central', 'north', 'south', 'east', 'west'];
  const LABELS = { central: 'Central', north: 'North', south: 'South', east: 'East', west: 'West' };
  const METRICS = {
    psi24: '24-hr PSI',
    psi1: '1-hr PSI (est.)',
  };

  // NEA PSI bands.
  const BANDS = [
    { max: 50, key: 'good', label: 'Good' },
    { max: 100, key: 'moderate', label: 'Moderate' },
    { max: 200, key: 'unhealthy', label: 'Unhealthy' },
    { max: 300, key: 'very', label: 'Very unhealthy' },
    { max: Infinity, key: 'haz', label: 'Hazardous' },
  ];
  const bandFor = (v) => BANDS.find((b) => v <= b.max);

  // NEA does not publish a 1-hour PSI. It publishes a 1-hour PM2.5 reading,
  // which we convert with the PSI PM2.5 breakpoints (the same table NEA uses
  // for the 24-hour PSI) to get an estimated PSI-equivalent.
  const BP_C = [0, 12, 55, 150, 250, 350, 500]; // PM2.5 ug/m3
  const BP_I = [0, 50, 100, 200, 300, 400, 500]; // PSI
  function pm25ToPsi(c) {
    if (typeof c !== 'number' || !isFinite(c) || c < 0) return null;
    let i = 1;
    while (i < BP_C.length - 1 && c > BP_C[i]) i++;
    const v = BP_I[i - 1] + ((c - BP_C[i - 1]) * (BP_I[i] - BP_I[i - 1])) / (BP_C[i] - BP_C[i - 1]);
    return Math.round(v);
  }

  async function getJson(url) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (!json || !json.data || !json.data.items || !json.data.items.length) {
        throw new Error((json && json.errorMsg) || 'No data returned');
      }
      return json.data.items[0];
    } finally {
      clearTimeout(t);
    }
  }

  async function fetchReadings() {
    const [psi, pm] = await Promise.all([getJson(API + '/psi'), getJson(API + '/pm25')]);
    const psi24 = psi.readings.psi_twenty_four_hourly || {};
    const pm1 = pm.readings.pm25_one_hourly || {};
    const regions = {};
    for (const r of REGIONS) {
      const p = typeof psi24[r] === 'number' ? psi24[r] : null;
      const m = typeof pm1[r] === 'number' ? pm1[r] : null;
      regions[r] = { psi24: p, pm25: m, psi1: pm25ToPsi(m) };
    }
    return { fetchedAt: Date.now(), psiTimestamp: psi.timestamp, pmTimestamp: pm.timestamp, regions };
  }

  // ---- tiny IndexedDB key/value store (usable from page and service worker)
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('haze-tracker', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const q = db.transaction('kv').objectStore('kv').get(key);
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
  }
  async function idbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbDel(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function buildNotification(settings, value) {
    const band = bandFor(value);
    const region = LABELS[settings.region];
    return {
      title: 'Haze alert: ' + region + ' PSI ' + value,
      options: {
        body:
          METRICS[settings.metric] + ' in the ' + region + ' region is ' + value + ' (' + band.label +
          '), at or above your threshold of ' + settings.threshold + '.',
        icon: 'icons/icon-192.png',
        tag: 'haze-alert',
        renotify: true,
      },
    };
  }

  /* Fetch fresh data and, if the watched value has just crossed the threshold
     upwards, call show(title, options). The first check after settings change
     only records a baseline, so a value that is already above the threshold
     does not trigger an alert until it has dropped below and crossed again. */
  async function runCheck(show) {
    const data = await fetchReadings();
    await idbSet('lastData', data);
    const settings = await idbGet('settings');
    if (!settings || !settings.enabled) return { data, notified: false };

    const value = data.regions[settings.region] && data.regions[settings.region][settings.metric];
    if (typeof value !== 'number') return { data, notified: false };

    const key = [settings.region, settings.metric, settings.threshold].join('|');
    const state = await idbGet('alertState');
    const prevAbove = state && state.key === key ? state.above : undefined;
    const above = value >= settings.threshold;

    let notified = false;
    if (above && prevAbove === false) {
      const n = buildNotification(settings, value);
      await show(n.title, n.options);
      notified = true;
    }
    await idbSet('alertState', { key, above });
    return { data, notified, above };
  }

  g.HazeCore = {
    REGIONS, LABELS, METRICS, BANDS, bandFor, pm25ToPsi,
    fetchReadings, runCheck, buildNotification, idbGet, idbSet, idbDel,
  };
})(typeof self !== 'undefined' ? self : this);
