'use strict';

/*
 * ZTE 4G advanced dashboard proxy.
 *
 * Serves index.html and proxies the router's goform API so the browser
 * never has to deal with CORS or the router's short-lived session.
 *
 * Endpoints:
 *   GET  /                 dashboard
 *   GET  /api/status       live router stats (cached 1.2s)
 *   GET  /api/clients      connected WiFi/LAN devices
 *   GET  /api/diag         DNS + TCP + HTTPS health check
 *   GET  /api/speedtest    server-side download speed test
 *   GET  /api/latency      LAN/WAN latency history
 *   GET  /api/settings     current router settings
 *   GET  /api/report       daily availability report
 *   GET  /api/usage        cycle + yesterday + last 7 full days
 *   GET  /api/history      saved totals for past cycles
 *   GET  /api/health       liveness + version
 *   POST /api/band         { band: "auto"|"b1"|"b3"|"b7"|"b20" }
 *   POST /api/reconnect    disconnect + reconnect the PDP session
 *   POST /api/connection   { action: "connect"|"disconnect" }
 *   POST /api/wifi         { enabled?, ssid?, password?, hidden?, channel? }
 *   POST /api/apn          { profileName, wanApn, authMode, username, password, dnsMode, dns1, dns2 }
 *   POST /api/limit        { enabled, size, unit, alertPercent, clearDate, autoClear }
 *   POST /api/mac          { action: "block"|"unblock"|"clear", mac, host, ip }
 *   POST /api/scan
 *   POST /api/operator     { auto: true } or { numeric, rat }
 *   POST /api/reboot       { confirm: "REBOOT" }
 *
 * Config via env vars:
 *   ROUTER       default http://192.168.0.1
 *   ROUTER_PASS  default admin
 *   PORT         default 8787
 *   HOST         default 127.0.0.1
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const net = require('net');
const os = require('os');

const ROUTER = (process.env.ROUTER || 'http://192.168.0.1').replace(/\/+$/, '');
const PASSWORD = process.env.ROUTER_PASS || 'admin';
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
let ROUTER_HOST = '192.168.0.1';
try { ROUTER_HOST = new URL(ROUTER).hostname; } catch (_) { /* keep default */ }

const CMD = [
  'network_type', 'network_provider', 'signalbar',
  'lte_rsrp', 'lte_rsrq', 'lte_sinr', 'lte_rssi', 'lte_band', 'wan_active_band',
  'lte_pci', 'wan_active_channel',
  'ppp_status', 'wan_ipaddr', 'wan_netmask', 'wan_gateway', 'wan_connect_status',
  'ppp_dial_conn_fail_counter', 'modem_main_state',
  'monthly_rx_bytes', 'monthly_tx_bytes', 'monthly_time',
  'data_volume_limit_switch', 'data_volume_limit_size', 'data_volume_limit_unit',
  'date_month',
  'realtime_rx_thrpt', 'realtime_tx_thrpt', 'realtime_rx_bytes', 'realtime_tx_bytes',
  'simcard_roam', 'pin_status', 'imei', 'wa_inner_version', 'web_version', 'hardware_version',
  'device_name',
  'SSID1', 'RadioOff', 'AuthMode', 'EncrypType', 'HideSSID', 'Channel', 'wifi_band',
  'station_num', 'MAX_Access_num',
].join(',');

const BAND_MASKS = {
  auto: '0x2000080044', // router's "all bands" option
  b1: '0x1',
  b3: '0x4',
  b7: '0x40',
  b20: '0x80000',
};

const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function b64(s) {
  return Buffer.from(s, 'utf8').toString('base64');
}

function withTimeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(label || 'timeout')), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

async function routerPost(pathname, body, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ROUTER + pathname, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': ROUTER + '/index.html',
        'User-Agent': 'zte-dashboard/2.0',
      },
      body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not json */ }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

async function login() {
  const body = 'isTest=false&goformId=LOGIN&password=' + encodeURIComponent(b64(PASSWORD));
  const r = await routerPost('/goform/goform_set_cmd_process', body);
  const result = r.json ? String(r.json.result) : '';
  return result === '0' || result === '4';
}

async function getOnce(cmd, multi) {
  await login();
  const body = 'isTest=false&cmd=' + cmd + (multi ? '&multi_data=1' : '');
  const r = await routerPost('/goform/goform_get_cmd_process', body);
  return r.json || null;
}

function hasLiveData(d) {
  if (!d) return false;
  return !!(d.network_type || d.ppp_status || d.signalbar || d.lte_rsrp || d.modem_main_state);
}

let cache = { ts: 0, data: null };
let inflight = null;
const CACHE_MS = 1200;

async function fetchStatusFresh() {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const d = await getOnce(CMD, true);
    if (hasLiveData(d)) return d;
    last = d;
    await sleep(200);
  }
  return last;
}

async function getStatus() {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_MS) return cache.data;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const d = await fetchStatusFresh();
      if (hasLiveData(d)) { cache = { ts: Date.now(), data: d }; recordCycle(d); }
      return d;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function waitConnected(maxMs) {
  const end = Date.now() + maxMs;
  let st = null;
  while (Date.now() < end) {
    st = await fetchStatusFresh();
    if (st && st.ppp_status === 'ppp_connected') return st;
    await sleep(2500);
  }
  return st;
}

async function routerSet(body) {
  await login();
  const r = await routerPost('/goform/goform_set_cmd_process', body);
  return r.json || { raw: r.text };
}

function formEncode(obj) {
  return new URLSearchParams(obj).toString();
}

const SETTINGS_CMD = [
  'SSID1', 'AuthMode', 'EncrypType', 'HideSSID', 'Channel', 'wifi_band',
  'm_ssid_enable', 'RadioOff', 'MAX_Access_num', 'm_MAX_Access_num',
  'WirelessMode', 'CountryCode', 'HT_MCS',
  'ACL_mode', 'wifi_mac_black_list', 'wifi_hostname_black_list', 'user_ip_addr',
  'apn_interface_version', 'APN_config0', 'APN_config1',
  'data_volume_limit_switch', 'data_volume_limit_unit', 'data_volume_limit_size',
  'data_volume_alert_percent', 'wan_auto_clear_flow_data_switch', 'traffic_clear_date',
  'monthly_rx_bytes', 'monthly_tx_bytes', 'monthly_time', 'date_month',
  'net_select_mode', 'm_netselect_save', 'net_select', 'web_net_select',
  'network_provider', 'network_type', 'ppp_status',
  'wan_ipaddr', 'wan_gateway', 'wan_netmask',
].join(',');

function parseApn(s) {
  const a = String(s || '').split('($)');
  return {
    profileName: a[0] || '',
    wanApn: a[1] || '',
    apnSelect: a[2] || 'manual',
    wanDial: a[3] || '*99#',
    authMode: a[4] || 'none',
    username: a[5] || '',
    hasPassword: !!a[6],
    pdpType: a[7] || 'IP',
    pdpSelect: a[8] || 'auto',
    pdpAddr: a[9] || '',
    dnsMode: a[10] || 'auto',
    dns1: a[11] || '',
    dns2: a[12] || '',
    _password: a[6] || '',
  };
}

function parseBlacklist(hosts, macs) {
  const h = String(hosts || '').split(';');
  const m = String(macs || '').split(';');
  const out = [];
  for (let i = 0; i < m.length; i++) {
    const mac = String(m[i] || '').trim();
    if (!mac) continue;
    out.push({ host: String(h[i] || '').trim(), mac });
  }
  return out;
}

function parseNetworks(s) {
  const out = [];
  for (const part of String(s || '').split(';')) {
    if (!part.trim()) continue;
    const m = part.match(/^([^,]*),([^,]*),([^,]*),([^,;]*)$/);
    if (!m) continue;
    const state = Number(m[1]);
    const rat = Number(m[4]);
    out.push({
      state,
      name: m[2].replace(/"/g, '').trim(),
      numeric: m[3].replace(/\D/g, ''),
      rat,
      status: ['unknown', 'available', 'current', 'forbidden'][state] || 'unknown',
      ratName: rat === 0 ? '2G' : rat === 2 ? '3G' : rat === 7 ? '4G' : 'auto',
    });
  }
  return out;
}

function parseLimitSize(s) {
  const parts = String(s || '').split('_');
  return {
    value: Number(parts[0]) || 0,
    unit: Number(parts[1]) === 1024 ? 'GB' : 'MB',
  };
}

async function getSettings() {
  const s = await getOnce(SETTINGS_CMD, true);
  if (!s) throw new Error('No response from router');
  const apn = parseApn(s.APN_config0);
  const limit = parseLimitSize(s.data_volume_limit_size);
  return {
    wifi: {
      ssid: s.SSID1 || '',
      auth: s.AuthMode || '',
      encryp: s.EncrypType || '',
      hidden: s.HideSSID === '1',
      channel: s.Channel || '0',
      band: s.wifi_band || '',
      enabled: s.RadioOff === '1',
      multiSsid: s.m_ssid_enable === '1',
      maxAccess: s.MAX_Access_num || '',
      mMaxAccess: s.m_MAX_Access_num || '',
      mode: s.WirelessMode || '',
      country: s.CountryCode || '',
      rate: s.HT_MCS || '0',
    },
    apn: {
      profileName: apn.profileName,
      wanApn: apn.wanApn,
      apnSelect: apn.apnSelect,
      wanDial: apn.wanDial,
      authMode: apn.authMode,
      username: apn.username,
      hasPassword: apn.hasPassword,
      pdpType: apn.pdpType,
      pdpSelect: apn.pdpSelect,
      dnsMode: apn.dnsMode,
      dns1: apn.dns1,
      dns2: apn.dns2,
      interfaceVersion: s.apn_interface_version || '1',
    },
    limit: {
      enabled: s.data_volume_limit_switch === '1',
      unit: s.data_volume_limit_unit || 'data',
      sizeValue: limit.value,
      sizeUnit: limit.unit,
      alertPercent: s.data_volume_alert_percent || '',
      autoClear: s.wan_auto_clear_flow_data_switch || 'off',
      clearDate: s.traffic_clear_date || '1',
      monthlyRx: Number(s.monthly_rx_bytes) || 0,
      monthlyTx: Number(s.monthly_tx_bytes) || 0,
      monthlyTime: Number(s.monthly_time) || 0,
      cycle: s.date_month || '',
    },
    mac: {
      aclMode: s.ACL_mode || '0',
      blacklist: parseBlacklist(s.wifi_hostname_black_list, s.wifi_mac_black_list),
      userIp: s.user_ip_addr || '',
    },
    net: {
      mode: s.net_select_mode || '',
      save: s.m_netselect_save || '',
      select: s.net_select || '',
      webSelect: s.web_net_select || '',
      provider: s.network_provider || '',
      type: s.network_type || '',
      ppp: s.ppp_status || '',
      ip: s.wan_ipaddr || '',
      gateway: s.wan_gateway || '',
      netmask: s.wan_netmask || '',
    },
  };
}

async function setBand(key) {
  const mask = BAND_MASKS[key];
  if (!mask) throw new Error('Unknown band: ' + key);

  await login();
  await routerPost('/goform/goform_set_cmd_process', 'isTest=false&goformId=DISCONNECT_NETWORK');
  await sleep(2500);

  await login();
  const r = await routerPost('/goform/goform_set_cmd_process',
    'isTest=false&goformId=SET_NETWORK_BAND_LOCK&is_gw_band=0&wcdma_band_lock=0' +
    '&is_lte_band=1&lte_band_lock=' + encodeURIComponent(mask));
  await sleep(1200);

  await login();
  await routerPost('/goform/goform_set_cmd_process', 'isTest=false&goformId=CONNECT_NETWORK');

  const st = await waitConnected(45000);
  return {
    band: key,
    mask,
    setResult: r.json,
    connected: !!(st && st.ppp_status === 'ppp_connected'),
    status: st,
  };
}

async function doReconnect() {
  await login();
  await routerPost('/goform/goform_set_cmd_process', 'isTest=false&goformId=DISCONNECT_NETWORK');
  await sleep(2500);
  await login();
  await routerPost('/goform/goform_set_cmd_process', 'isTest=false&goformId=CONNECT_NETWORK');
  const st = await waitConnected(45000);
  if (st && st.ppp_status === 'ppp_connected') await warmDoh();
  return { connected: !!(st && st.ppp_status === 'ppp_connected'), status: st };
}

async function getClients() {
  const out = [];
  try {
    const s = await getOnce('station_list', false);
    for (const st of (s && s.station_list) || []) {
      out.push({
        type: 'wifi',
        host: st.hostname && st.hostname !== '--' ? st.hostname : 'WiFi device',
        ip: st.ip_addr || '',
        mac: st.mac_addr || '',
        ssid: st.ssid_index || '',
      });
    }
  } catch (_) { /* ignore */ }
  try {
    const l = await getOnce('lan_station_list', false);
    for (const st of (l && l.lan_station_list) || []) {
      out.push({
        type: 'lan',
        host: st.hostname && st.hostname !== '--' ? st.hostname : 'LAN device',
        ip: st.ip_addr || '',
        mac: st.mac_addr || '',
        ssid: '',
      });
    }
  } catch (_) { /* ignore */ }
  return out;
}

function tcpPing(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      s.destroy();
      if (err) reject(err); else resolve(Date.now() - t0);
    };
    s.setTimeout(timeout, () => finish(new Error('timeout')));
    s.once('connect', () => finish());
    s.once('error', (e) => finish(e));
  });
}

/* ---------- latency monitor (LAN router vs internet) ---------- */

const LAT_MAX = 120;
const latency = { lan: [], wan: [] };

async function sampleLatency() {
  const ts = Date.now();
  const [lan, wan] = await Promise.all([
    tcpPing(ROUTER_HOST, 80, 2000).catch(() => null),
    tcpPing('1.1.1.1', 443, 3000).catch(() => null),
  ]);
  latency.lan.push({ ts, ms: lan });
  latency.wan.push({ ts, ms: wan });
  if (latency.lan.length > LAT_MAX) latency.lan.shift();
  if (latency.wan.length > LAT_MAX) latency.wan.shift();
}

function latencySummary(arr) {
  const vals = arr.map((s) => s.ms).filter((v) => v != null);
  const loss = arr.length ? Math.round(((arr.length - vals.length) / arr.length) * 100) : 0;
  return {
    last: arr.length ? arr[arr.length - 1].ms : null,
    min: vals.length ? Math.min(...vals) : null,
    avg: vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null,
    max: vals.length ? Math.max(...vals) : null,
    loss,
    count: arr.length,
  };
}

/* ---------- daily availability report ---------- */

const REPORT_FILE = path.join(__dirname, 'report.jsonl');
const REPORT_KEEP_DAYS = 30;

function readReport() {
  let text = '';
  try { text = fs.readFileSync(REPORT_FILE, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* skip bad line */ }
  }
  return out;
}

function localDate(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function sampleReport() {
  // Wait for the first WAN probe so the opening sample isn't a false loss.
  if (!latency.wan.length) return;
  let st = null;
  try { st = await fetchStatusFresh(); } catch (_) { /* router down */ }
  const rec = {
    ts: Date.now(),
    linked: !!(st && st.ppp_status === 'ppp_connected'),
    rsrp: st ? Number(st.lte_rsrp) || null : null,
    rsrq: st ? Number(st.lte_rsrq) || null : null,
    band: st ? st.wan_active_band || '' : '',
    lan: latencySummary(latency.lan).last,
    wan: latencySummary(latency.wan).last,
    rx: st ? numOrNull(st.monthly_rx_bytes) : null,
    tx: st ? numOrNull(st.monthly_tx_bytes) : null,
  };
  try { fs.appendFileSync(REPORT_FILE, JSON.stringify(rec) + '\n'); } catch (_) { /* ignore */ }
}

function pruneReport() {
  try {
    const recs = readReport();
    const cutoff = Date.now() - REPORT_KEEP_DAYS * 864e5;
    const keep = recs.filter((r) => r && r.ts >= cutoff);
    if (keep.length !== recs.length) {
      fs.writeFileSync(REPORT_FILE, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''));
    }
  } catch (_) { /* ignore */ }
}

function reportSummary(days) {
  const recs = readReport();
  const cutoff = Date.now() - days * 864e5;
  const byDate = new Map();
  for (const r of recs) {
    if (!r || !r.ts || r.ts < cutoff) continue;
    const d = localDate(r.ts);
    let g = byDate.get(d);
    if (!g) {
      g = { date: d, samples: 0, up: 0, wanSum: 0, wanN: 0, loss: 0, rsrpSum: 0, rsrpN: 0 };
      byDate.set(d, g);
    }
    g.samples++;
    if (r.linked) g.up++;
    if (r.wan != null) { g.wanSum += r.wan; g.wanN++; } else g.loss++;
    if (r.rsrp != null) { g.rsrpSum += r.rsrp; g.rsrpN++; }
  }
  const daily = Array.from(byDate.values()).map((g) => ({
    date: g.date,
    samples: g.samples,
    uptimePct: g.samples ? Math.round((g.up / g.samples) * 1000) / 10 : null,
    avgWan: g.wanN ? Math.round(g.wanSum / g.wanN) : null,
    lossPct: g.samples ? Math.round((g.loss / g.samples) * 1000) / 10 : null,
    avgRsrp: g.rsrpN ? Math.round(g.rsrpSum / g.rsrpN) : null,
  })).sort((a, b) => a.date.localeCompare(b.date));

  let samples = 0;
  let up = 0;
  let loss = 0;
  let wanSum = 0;
  let wanN = 0;
  for (const d of daily) {
    samples += d.samples;
    up += Math.round(((d.uptimePct || 0) / 100) * d.samples);
    loss += Math.round(((d.lossPct || 0) / 100) * d.samples);
    if (d.avgWan != null) { wanSum += d.avgWan * d.samples; wanN += d.samples; }
  }
  return {
    daily,
    totals: {
      samples,
      uptimePct: samples ? Math.round((up / samples) * 1000) / 10 : null,
      lossPct: samples ? Math.round((loss / samples) * 1000) / 10 : null,
      avgWan: wanN ? Math.round(wanSum / wanN) : null,
    },
  };
}

function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Per-cycle totals survive the router resetting its monthly counters. The
// last snapshot of a cycle is kept when date_month changes; report.jsonl is
// pruned after 30 days, so it cannot serve as long-term history.
const HISTORY_FILE = path.join(__dirname, 'usage-history.json');
const HISTORY_MAX = 24;

function readHistory() {
  try {
    const v = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch (_) { return []; }
}

function recordCycle(st) {
  const month = String(st && st.date_month || '');
  const rx = numOrNull(st && st.monthly_rx_bytes);
  const tx = numOrNull(st && st.monthly_tx_bytes);
  if (!/^\d{8}$/.test(month) || rx == null || tx == null) return;
  const list = readHistory();
  let entry = list.find((x) => x && x.month === month);
  if (!entry) { entry = { month, rx, tx, updated: 0 }; list.push(entry); }
  // Keep the high-water mark: a transient drop must not erase a cycle total.
  if (rx >= (entry.rx || 0) && tx >= (entry.tx || 0) && (rx !== entry.rx || tx !== entry.tx)) {
    entry.rx = rx;
    entry.tx = tx;
  }
  if (Date.now() - (entry.updated || 0) < 60000) return;
  entry.updated = Date.now();
  list.sort((a, b) => String(b.month).localeCompare(String(a.month)));
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(list.slice(0, HISTORY_MAX), null, 2) + '\n'); } catch (_) { /* ignore */ }
}

// Local-midnight boundary, offset by whole days.
function localDayStart(ts, offsetDays) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  if (offsetDays) d.setDate(d.getDate() + offsetDays);
  return d.getTime();
}

// Usage between two local-midnight boundaries, summed from the router's
// cumulative monthly counters. The router has no daily counters, so this
// fills in as report samples accumulate.
function usageWindow(recs, startMs, endMs) {
  const valid = recs
    .filter((r) => r && r.ts != null && r.rx != null && r.tx != null)
    .sort((a, b) => a.ts - b.ts);
  let base = null;
  let first = null;
  for (const r of valid) {
    if (r.ts <= startMs) base = r;
    else if (!first) first = r;
  }
  const start = base || first;
  if (!start || start.ts > endMs) {
    return { rx: 0, tx: 0, total: 0, complete: false, from: null, to: null, samples: 0 };
  }
  let rx = 0;
  let tx = 0;
  let prev = start;
  let last = start;
  let samples = 0;
  for (const r of valid) {
    if (r.ts <= start.ts) continue;
    if (r.ts > endMs) break;
    // shortcut: the baseline is the last sample before the window, so a
    // window can include up to 60 s of the previous day; a counter reset
    // between samples can lose up to 60 s. Upgrade for second-exact totals.
    rx += r.rx >= prev.rx ? r.rx - prev.rx : r.rx;
    tx += r.tx >= prev.tx ? r.tx - prev.tx : r.tx;
    samples++;
    prev = r;
    last = r;
  }
  return {
    rx, tx, total: rx + tx,
    complete: !!base && last.ts >= endMs - 120000,
    from: start.ts,
    to: last.ts,
    samples,
  };
}

const DNS_TEST_HOSTS = [
  'github.com', 'www.google.com', 'www.microsoft.com', 'www.apple.com', 'cloudflare.com', 'example.com',
];

// Plain DNS to public servers is blocked here, but HTTPS to them works.
const DOH_SERVERS = [
  { ip: '8.8.8.8', host: 'dns.google', path: '/resolve' },
  { ip: '1.1.1.1', host: 'cloudflare-dns.com', path: '/dns-query' },
];
const dohCache = new Map();

function fixedLookup(ip) {
  return (hostname, options, cb) => {
    if (options && options.all) cb(null, [{ address: ip, family: 4 }]);
    else cb(null, ip, 4);
  };
}

function httpsGet(host, path, ip, timeoutMs, collect = false) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: host,
      servername: host,
      path,
      lookup: fixedLookup(ip),
      timeout: timeoutMs,
    }, (res) => {
      const chunks = collect ? [] : null;
      if (!collect) res.resume();
      res.on('data', (c) => { if (chunks) chunks.push(c); });
      res.on('end', () => resolve({
        status: res.statusCode,
        body: chunks ? Buffer.concat(chunks) : null,
      }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function dohResolve(name) {
  const hit = dohCache.get(name);
  if (hit && Date.now() - hit.ts < 60000) return hit.addrs;
  let last = null;
  for (const s of DOH_SERVERS) {
    try {
      const url = s.path + '?name=' + encodeURIComponent(name) + '&type=A';
      const res = await httpsGet(s.host, url, s.ip, 6000, true);
      const j = JSON.parse(res.body.toString());
      const addrs = (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
      if (addrs.length) {
        dohCache.set(name, { ts: Date.now(), addrs });
        return addrs;
      }
    } catch (e) { last = e; }
  }
  throw last || new Error('DoH lookup failed');
}

async function warmDoh() {
  for (const host of DNS_TEST_HOSTS.slice(0, 4)) {
    try { await dohResolve(host); } catch (_) { /* keep warming */ }
  }
}

async function runDiag() {
  const out = { ts: Date.now() };

  let t0 = Date.now();
  const host = DNS_TEST_HOSTS[Math.floor(Date.now() / 1000) % DNS_TEST_HOSTS.length];
  try {
    const addrs = await dohResolve(host);
    out.dns = { ok: true, ms: Date.now() - t0, host, addrs, via: 'DoH' };
  } catch (e) {
    out.dns = { ok: false, ms: Date.now() - t0, host, error: String((e && e.message) || e) };
  }

  const times = [];
  for (let i = 0; i < 3; i++) {
    try { times.push(await tcpPing('1.1.1.1', 443, 3000)); } catch (_) { times.push(null); }
  }
  const good = times.filter((x) => x != null);
  out.tcp = {
    ok: good.length > 0,
    min: good.length ? Math.min(...good) : null,
    avg: good.length ? Math.round(good.reduce((a, b) => a + b, 0) / good.length) : null,
    times,
  };

  t0 = Date.now();
  try {
    const ip = (await dohResolve('www.google.com'))[0];
    const res = await httpsGet('www.google.com', '/generate_204', ip, 8000);
    out.http = { ok: res.status === 204 || (res.status >= 200 && res.status < 300), status: res.status, ms: Date.now() - t0 };
  } catch (e) {
    out.http = { ok: false, ms: Date.now() - t0, error: String((e && e.message) || e) };
  }

  return out;
}

async function runSpeedTest(bytes) {
  const n = Math.max(1e6, Math.min(50e6, Number(bytes) || 10e6));
  const t0 = Date.now();
  const ip = (await dohResolve('speed.cloudflare.com'))[0];
  const res = await httpsGet('speed.cloudflare.com', '/__down?bytes=' + n + '&r=' + Math.random(), ip, 120000, true);
  if (!(res.status >= 200 && res.status < 300)) throw new Error('HTTP ' + res.status);
  const buf = res.body;
  const secs = Math.max(0.001, (Date.now() - t0) / 1000);
  return {
    bytes: buf.byteLength,
    seconds: Number(secs.toFixed(2)),
    mbps: Number(((buf.byteLength * 8) / 1e6 / secs).toFixed(2)),
    mbPerSec: Number((buf.byteLength / 1e6 / secs).toFixed(2)),
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;

  try {
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(indexHtml);
      return;
    }

    if (p === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    const STATIC_FILES = {
      '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
      '/service-worker.js': ['service-worker.js', 'application/javascript; charset=utf-8'],
      '/icon-192.png': ['icon-192.png', 'image/png'],
      '/icon-512.png': ['icon-512.png', 'image/png'],
      '/icon.svg': ['icon.svg', 'image/svg+xml'],
    };
    if (STATIC_FILES[p]) {
      const [file, type] = STATIC_FILES[p];
      try {
        const buf = fs.readFileSync(path.join(__dirname, file));
        res.writeHead(200, {
          'Content-Type': type,
          'Cache-Control': file === 'service-worker.js' ? 'no-cache' : 'public, max-age=86400',
        });
        res.end(buf);
      } catch (_) {
        sendJson(res, 404, { ok: false, error: 'Missing ' + file });
      }
      return;
    }

    if (p === '/api/health') {
      sendJson(res, 200, { ok: true, version: '3.0' });
      return;
    }

    if (p === '/api/status') {
      const data = await getStatus();
      if (!hasLiveData(data)) {
        sendJson(res, 502, {
          ok: false,
          error: 'Router did not return live data (login failed or session lost).',
          raw: data,
        });
        return;
      }
      sendJson(res, 200, { ok: true, ts: Date.now(), router: ROUTER, data });
      return;
    }

    if (p === '/api/clients') {
      const clients = await getClients();
      sendJson(res, 200, { ok: true, ts: Date.now(), clients });
      return;
    }

    if (p === '/api/diag') {
      const d = await runDiag();
      sendJson(res, 200, Object.assign({ ok: true }, d));
      return;
    }

    if (p === '/api/speedtest') {
      const r = await runSpeedTest(url.searchParams.get('bytes'));
      sendJson(res, 200, Object.assign({ ok: true }, r));
      return;
    }

    if (p === '/api/latency') {
      sendJson(res, 200, {
        ok: true,
        ts: Date.now(),
        lan: latencySummary(latency.lan),
        wan: latencySummary(latency.wan),
        samples: { lan: latency.lan.slice(-60), wan: latency.wan.slice(-60) },
      });
      return;
    }

    if (p === '/api/settings') {
      const settings = await getSettings();
      sendJson(res, 200, { ok: true, ts: Date.now(), settings });
      return;
    }

    if (p === '/api/wifi') {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST required' }); return; }
      const body = await readJson(req);
      const results = {};

      if (typeof body.enabled === 'boolean') {
        const cur = await getOnce('m_ssid_enable', false);
        const mSsid = cur && cur.m_ssid_enable === '1' ? '1' : '0';
        const cmd = 'isTest=false&goformId=SET_WIFI_INFO&wifiEnabled=' + (body.enabled ? '1' : '0') +
          (body.enabled ? '&m_ssid_enable=' + encodeURIComponent(mSsid) : '');
        results.toggle = await routerSet(cmd);
      }

      if (body.ssid !== undefined || body.password) {
        const cur = await getOnce('SSID1,AuthMode,EncrypType,HideSSID,MAX_Access_num', true);
        const ssid = String(body.ssid !== undefined ? body.ssid : (cur && cur.SSID1) || '').trim();
        if (!ssid) throw new Error('SSID is required');
        let pass = String(body.password || '');
        if (!pass) {
          const p = await getOnce('WPAPSK1_encode,WPAPSK1', true);
          pass = p && p.WPAPSK1_encode
            ? Buffer.from(p.WPAPSK1_encode, 'base64').toString('utf8')
            : (p && p.WPAPSK1) || '';
        }
        if (!pass || pass.length < 8 || pass.length > 63) throw new Error('WiFi password must be 8-63 characters');
        const auth = (cur && cur.AuthMode) || 'WPA2PSK';
        const enc = (cur && cur.EncrypType) || '';
        const cipher = enc === 'TKIP' ? '0' : enc === 'AES' ? '1' : '2';
        const hidden = body.hidden !== undefined
          ? (body.hidden ? '1' : '0')
          : (cur && cur.HideSSID) === '1' ? '1' : '0';
        const cmd = 'isTest=false&goformId=SET_WIFI_SSID1_SETTINGS' +
          '&ssid=' + encodeURIComponent(ssid) +
          '&broadcastSsidEnabled=' + hidden +
          '&MAX_Access_num=' + encodeURIComponent((cur && cur.MAX_Access_num) || '10') +
          '&security_mode=' + encodeURIComponent(auth) +
          '&cipher=' + cipher +
          '&NoForwarding=0' +
          '&security_shared_mode=' + cipher +
          '&passphrase=' + encodeURIComponent(b64(pass));
        results.ssid = await routerSet(cmd);
      }

      if (body.channel !== undefined) {
        const cur = await getOnce('WirelessMode,CountryCode,HT_MCS,MAX_Access_num,m_MAX_Access_num', true);
        const cmd = 'isTest=false&goformId=SET_WIFI_INFO' +
          '&wifiMode=' + encodeURIComponent((cur && cur.WirelessMode) || '4') +
          '&countryCode=' + encodeURIComponent((cur && cur.CountryCode) || 'MA') +
          '&MAX_Access_num=' + encodeURIComponent((cur && cur.MAX_Access_num) || '10') +
          '&m_MAX_Access_num=' + encodeURIComponent((cur && cur.m_MAX_Access_num) || '7') +
          '&selectedChannel=' + encodeURIComponent(String(body.channel || '0')) +
          '&abg_rate=' + encodeURIComponent((cur && cur.HT_MCS) || '0');
        results.channel = await routerSet(cmd);
      }

      if (!Object.keys(results).length) throw new Error('Nothing to change');
      sendJson(res, 200, { ok: true, results });
      return;
    }

    if (p === '/api/apn') {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST required' }); return; }
      const body = await readJson(req);
      const cur = await getOnce('APN_config0', true);
      const a = parseApn(cur && cur.APN_config0);
      const profileName = String(body.profileName !== undefined ? body.profileName : a.profileName || 'inwi').trim();
      const wanApn = String(body.wanApn !== undefined ? body.wanApn : a.wanApn || '').trim();
      if (!wanApn) throw new Error('APN is required');
      const dnsMode = String(body.dnsMode || a.dnsMode || 'auto').toLowerCase();
      if (dnsMode !== 'auto' && dnsMode !== 'manual') throw new Error('dnsMode must be auto or manual');
      const dns1 = dnsMode === 'manual' ? String(body.dns1 !== undefined ? body.dns1 : a.dns1 || '').trim() : '';
      const dns2 = dnsMode === 'manual' ? String(body.dns2 !== undefined ? body.dns2 : a.dns2 || '').trim() : '';
      const authMode = String(body.authMode || a.authMode || 'none').toLowerCase();
      const username = String(body.username !== undefined ? body.username : a.username || '');
      const password = body.password ? String(body.password) : (a._password || '');
      const params = {
        isTest: 'false',
        goformId: 'APN_PROC_EX',
        apn_action: 'save',
        apn_mode: 'manual',
        profile_name: profileName,
        wan_dial: '*99#',
        apn_select: 'manual',
        pdp_type: 'IP',
        pdp_select: 'auto',
        pdp_addr: '',
        index: '0',
        wan_apn: wanApn,
        ppp_auth_mode: authMode,
        ppp_username: username,
        ppp_passwd: password,
        dns_mode: dnsMode,
        prefer_dns_manual: dns1,
        standby_dns_manual: dns2,
      };
      const save = await routerSet(formEncode(params));
      if (!save || String(save.result) !== 'success') {
        sendJson(res, 502, { ok: false, error: 'APN save failed', save });
        return;
      }
      const rec = await doReconnect();
      sendJson(res, 200, { ok: true, save, connected: rec.connected, status: rec.status });
      return;
    }

    if (p === '/api/limit') {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST required' }); return; }
      const body = await readJson(req);
      const enabled = !!body.enabled;
      const params = {
        isTest: 'false',
        goformId: 'DATA_LIMIT_SETTING',
        data_volume_limit_switch: enabled ? '1' : '0',
        wan_auto_clear_flow_data_switch: body.autoClear ? 'on' : 'off',
        traffic_clear_date: String(Math.max(1, Math.min(31, Number(body.clearDate) || 1))),
      };
      if (enabled) {
        const size = Number(body.size);
        if (!isFinite(size) || size <= 0) throw new Error('Limit size must be greater than 0');
        const unit = String(body.unit || 'GB').toUpperCase() === 'MB' ? '1' : '1024';
        params.data_volume_limit_unit = 'data';
        params.data_volume_limit_size = size + '_' + unit;
        params.data_volume_alert_percent = String(Math.max(1, Math.min(100, Number(body.alertPercent) || 90)));
      }
      const r = await routerSet(formEncode(params));
      sendJson(res, 200, { ok: true, result: r });
      return;
    }

    if (p === '/api/mac') {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST required' }); return; }
      const body = await readJson(req);
      const action = String(body.action || '');
      const mac = String(body.mac || '').trim().toUpperCase();
      const host = String(body.host || '').trim();
      if (action !== 'clear' && !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) throw new Error('Invalid MAC address');
      const cur = await getOnce('ACL_mode,wifi_mac_black_list,wifi_hostname_black_list,user_ip_addr', true);
      if (body.ip && cur && cur.user_ip_addr && String(body.ip) === String(cur.user_ip_addr)) {
        throw new Error('Refusing to block the computer running the dashboard');
      }
      let list = parseBlacklist(cur && cur.wifi_hostname_black_list, cur && cur.wifi_mac_black_list);
      if (action === 'block') {
        if (!list.some((x) => x.mac.toUpperCase() === mac)) list.push({ host, mac });
      } else if (action === 'unblock') {
        list = list.filter((x) => x.mac.toUpperCase() !== mac);
      } else if (action === 'clear') {
        list = [];
      } else {
        throw new Error('action must be block, unblock or clear');
      }
      const params = {
        isTest: 'false',
        goformId: 'WIFI_MAC_FILTER',
        ACL_mode: '2',
        macFilteringMode: '2',
        wifi_hostname_black_list: list.map((x) => x.host).join(';'),
        wifi_mac_black_list: list.map((x) => x.mac).join(';'),
      };
      const r = await routerSet(formEncode(params));
      sendJson(res, 200, { ok: true, result: r, blacklist: list });
      return;
    }

    if (p === '/api/scan') {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST required' }); return; }
      const scan = await routerSet('isTest=false&goformId=SCAN_NETWORK');
      if (!scan || String(scan.result) !== 'success') {
        sendJson(res, 502, { ok: false, error: 'Scan request failed', scan });
        return;
      }
      let status = '';
      for (let i = 0; i < 60; i++) {
        await sleep(1000);
        const s = await getOnce('m_netselect_status', false);
        status = String((s && s.m_netselect_status) || '');
        if (status && status !== 'manual_selecting') break;
      }
      const d = await getOnce('m_netselect_contents,net_select_mode,m_netselect_save,net_select,web_net_select,network_provider,network_type', true);
      sendJson(res, 200, {
        ok: true,
        scan,
        status,
        networks: parseNetworks(d && d.m_netselect_contents),
        current: {
          mode: (d && d.net_select_mode) || '',
          save: (d && d.m_netselect_save) || '',
          select: (d && d.net_select) || '',
          webSelect: (d && d.web_net_select) || '',
          provider: (d && d.network_provider) || '',
          type: (d && d.network_type) || '',
        },
      });
      return;
    }

    if (p === '/api/operator') {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST required' }); return; }
      const body = await readJson(req);
      if (body.auto) {
        const r = await routerSet(formEncode({
          isTest: 'false',
          goformId: 'SET_BEARER_PREFERENCE',
          BearerPreference: 'NETWORK_auto',
          web_net_select: 'NETWORK_auto_all',
        }));
        let st = null;
        for (let i = 0; i < 20; i++) {
          await sleep(1500);
          st = await getOnce('ppp_status,net_select_mode,net_select,web_net_select,network_provider', true);
          if (st && st.net_select_mode === 'auto_select') break;
        }
        sendJson(res, 200, { ok: true, mode: 'auto', result: r, status: st });
        return;
      }
      const numeric = String(body.numeric || '').replace(/\D/g, '');
      const rat = Number(body.rat);
      if (!numeric) throw new Error('numeric is required');
      if (![0, 2, 7].includes(rat)) throw new Error('rat must be 0, 2 or 7');
      const set = await routerSet(formEncode({
        isTest: 'false',
        goformId: 'SET_NETWORK',
        NetworkNumber: numeric,
        Rat: rat,
      }));
      if (!set || String(set.result) !== 'success') {
        sendJson(res, 502, { ok: false, error: 'Network set failed', set });
        return;
      }
      let result = '';
      let st = null;
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        st = await getOnce('m_netselect_result,net_select_mode,net_select,web_net_select,network_provider,ppp_status', true);
        result = String((st && st.m_netselect_result) || '');
        if (result === 'manual_success' || result === 'manual_fail') break;
      }
      sendJson(res, 200, { ok: true, mode: 'manual', set, result, success: result === 'manual_success', status: st });
      return;
    }

    if (p === '/api/connection') {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST required' }); return; }
      const body = await readJson(req);
      const action = String(body.action || '');
      if (action === 'disconnect') {
        const r = await routerSet('isTest=false&notCallback=true&goformId=DISCONNECT_NETWORK');
        let st = null;
        for (let i = 0; i < 15; i++) {
          await sleep(1000);
          st = await fetchStatusFresh();
          if (st && st.ppp_status === 'ppp_disconnected') break;
        }
        sendJson(res, 200, { ok: true, action, result: r, connected: !!(st && st.ppp_status === 'ppp_connected'), status: st });
        return;
      }
      if (action === 'connect') {
        const r = await routerSet('isTest=false&notCallback=true&goformId=CONNECT_NETWORK');
        const st = await waitConnected(45000);
        sendJson(res, 200, { ok: true, action, result: r, connected: !!(st && st.ppp_status === 'ppp_connected'), status: st });
        return;
      }
      throw new Error('action must be connect or disconnect');
    }

    if (p === '/api/reboot') {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST required' }); return; }
      const body = await readJson(req);
      if (String(body.confirm || '') !== 'REBOOT') {
        sendJson(res, 400, { ok: false, error: 'Type REBOOT to confirm' });
        return;
      }
      let r = null;
      try {
        r = await routerSet('isTest=false&goformId=REBOOT_DEVICE');
      } catch (e) {
        r = { error: String((e && e.message) || e) };
      }
      sendJson(res, 200, { ok: true, rebooting: true, result: r });
      return;
    }

    if (p === '/api/report') {
      const days = Math.max(1, Math.min(30, Number(url.searchParams.get('days')) || 7));
      const r = reportSummary(days);
      sendJson(res, 200, { ok: true, days, generatedAt: Date.now(), daily: r.daily, totals: r.totals });
      return;
    }

    if (p === '/api/usage') {
      const recs = readReport();
      const st = await getStatus();
      const cycleRx = st ? numOrNull(st.monthly_rx_bytes) || 0 : 0;
      const cycleTx = st ? numOrNull(st.monthly_tx_bytes) || 0 : 0;
      const today = localDayStart(Date.now(), 0);
      const yesterday = localDayStart(today, -1);
      const weekStart = localDayStart(today, -7);
      sendJson(res, 200, {
        ok: true,
        ts: Date.now(),
        cycle: {
          rx: cycleRx,
          tx: cycleTx,
          total: cycleRx + cycleTx,
          resets: st ? st.date_month || '' : '',
        },
        day: usageWindow(recs, yesterday, today),
        week: usageWindow(recs, weekStart, today),
        ranges: {
          day: { from: yesterday, to: today },
          week: { from: weekStart, to: today },
        },
      });
      return;
    }

    if (p === '/api/history') {
      const st = await getStatus();
      const current = st ? String(st.date_month || '') : '';
      const cycles = readHistory()
        .filter((x) => x && /^\d{8}$/.test(String(x.month)))
        .sort((a, b) => String(b.month).localeCompare(String(a.month)))
        .map((x) => {
          const rx = Number(x.rx) || 0;
          const tx = Number(x.tx) || 0;
          return {
            month: x.month, rx, tx, total: rx + tx,
            current: x.month === current,
            updated: x.updated || null,
          };
        });
      sendJson(res, 200, { ok: true, current, cycles });
      return;
    }

    if (p === '/api/band') {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST required' }); return; }
      const body = await readJson(req);
      const key = String(body.band || '').toLowerCase();
      if (!BAND_MASKS[key]) { sendJson(res, 400, { ok: false, error: 'Unknown band' }); return; }
      const r = await setBand(key);
      sendJson(res, 200, Object.assign({ ok: true }, r));
      return;
    }

    if (p === '/api/reconnect') {
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'POST required' }); return; }
      const r = await doReconnect();
      sendJson(res, 200, Object.assign({ ok: true }, r));
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log('ZTE 4G dashboard -> http://' + HOST + ':' + PORT);
  console.log('Router        -> ' + ROUTER);
  if (HOST === '0.0.0.0') {
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) {
          console.log('LAN           -> http://' + a.address + ':' + PORT + '  (' + name + ')');
        }
      }
    }
  }
  warmDoh();
  sampleLatency();
  setInterval(sampleLatency, 10000);
  pruneReport();
  setTimeout(sampleReport, 5000);
  setInterval(sampleReport, 60000);
  setInterval(pruneReport, 24 * 60 * 60 * 1000);
  setInterval(warmDoh, 5 * 60 * 1000);
});

process.on('unhandledRejection', (e) => {
  console.error('unhandledRejection:', e);
});
