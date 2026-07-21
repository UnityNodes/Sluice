/* Sluice, dashboard front-end. Vanilla JS, no framework.
 *
 * Data flow:
 *   1. Poll  GET /api/snapshot.json  every 5s for the matcher's view of the chain.
 *   2. Render stat cards, subscription table, and live feed from that snapshot.
 *   3. Wallet ops (connect / create / top-up / cancel) use window.CasperWalletProvider
 *      plus a server-side tx-builder at  /api/tx/...  to side-step casper-js-sdk's
 *      Stored-target serialisation bug (HONEST_LIMITS §9).
 */

(function () {
  var css = '@media (max-width:880px){'
    + '#onboard-strip{grid-template-columns:1fr !important}'
    + '.subs-grid{grid-template-columns:1fr !important;gap:4px 0 !important;font-size:12px !important;padding:14px 16px !important;align-items:start !important}'
    + '.subs-grid>div{min-width:0;overflow-wrap:anywhere;text-align:left !important;justify-content:flex-start !important}'
    + '.subs-grid>div:nth-child(3),.subs-grid>div:nth-child(5){display:none !important}'
    + '}';
  var s = document.createElement('style');
  s.textContent = css;
  (document.head || document.documentElement).appendChild(s);
})();

(() => {
  'use strict';

  const SNAPSHOT_URL = '/api/snapshot.json';
  const POLL_MS = 5000;
  const CSPR_PER_MOTE = 1_000_000_000n;
  const NULL_BAL_STR = '…';

  /* ─────────────────── state ─────────────────── */
  const state = {
    snapshot: null,
    filter: 'all',        // all | mine | active | low | depleted
    search: '',
    selectedSub: null,
    lastBlockHeight: null,
    pollTimer: null,
    relativeTimerId: null,
    wallet: { connected: false, pubkey: null, accountHash: null }, // read-only, filter only, no signing in v0.1
  };
  const STORAGE_KEY = 'sluice-wallet';
  // CSPR.click app id, register one for this origin at https://console.cspr.build .
  // While empty, the dashboard uses the direct Casper Wallet provider (no CSPR.click
  // load), so connect keeps working; set this to activate multi-wallet + social login.
  const CSPRCLICK_APP_ID = 'f3f81255-ff8d-458e-b844-68440025';

  /* ─────────────────── helpers ─────────────────── */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null || c === false) continue;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return n;
  };
  // BigInt division floors, which rendered an on-chain 2.5 CSPR predicate as
  // "2" and let a 5.9 CSPR balance trip the "at most 5" low-balance gate.
  // Divide as a Number so fractional CSPR survives.
  const motesToCspr = (motes) => {
    try { return Number(BigInt(String(motes))) / Number(CSPR_PER_MOTE); }
    catch { return 0; }
  };
  const fmtCsprNum = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });
  const fmtCspr = (motes) => {
    const c = motesToCspr(motes);
    return c.toLocaleString('en-US');
  };
  const fmtRelative = (iso) => {
    if (!iso) return '…';
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 5) return 'just now';
    if (diff < 60) return `${Math.floor(diff)}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  };
  const truncHash = (s, head = 4, tail = 4) => {
    if (!s) return '…';
    if (s.length <= head + tail + 1) return s;
    return `${s.slice(0, head)}…${s.slice(-tail)}`;
  };
  /* ──────── humanize layer ────────
   * Internal predicate JSON uses field/op names that match the Casper event
   * schema (to_account_hash, gte, etc.). For human-facing rows we want plain
   * English with emoji. Keep the raw JSON one click away via `title=...`.
   */
  const FIELD_LABEL = {
    amount: 'Amount',
    to_account_hash: 'Recipient',
    initiator_account_hash: 'Sender',
    deploy_hash: 'Tx hash',
    block_height: 'Block',
    transfer_index: 'Transfer #',
    from_purse: 'From purse',
    to_purse: 'To purse',
    timestamp: 'Time',
    event_type: 'Source',
    name: 'Event',
    contract_package_hash: 'Contract',
  };
  /* Known third-party Casper testnet contracts Sluice watches, so predicate
   * rows show the project name instead of a bare package hash. */
  const KNOWN_CONTRACTS = {
    '65bedddde009284db1bd62614afc8bbeb405590ddec1669eca3db38b5e18810f': 'Wisp Dollar (stablecoin)',
    '1d25c895320b16f37eb57b344b8b655f56c30ca6e941e903976fc0e97a803409': 'STEWARD Institutional Fund (RWA)',
    '0d5ae3015928b0070f03b9a377cf09fa86c63f3ce86f24b357f570977b786d8d': 'Meridian RWA',
    'ffb5a95650e034784bb8c2f2a2bd03c814f8edf9a895b10d3edd4690e907b7b7': 'DemoDex (Sluice)',
  };
  const FIELD_ICON_ID = {
    amount: 'icon-amount',
    to_account_hash: 'icon-recipient',
    initiator_account_hash: 'icon-sender',
    block_height: 'icon-block',
    timestamp: 'icon-time',
  };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const iconNode = (field) => {
    const id = FIELD_ICON_ID[field];
    if (!id) return document.createTextNode('·');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'pi');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#' + id);
    svg.appendChild(use);
    return svg;
  };
  const OP_LABEL = {
    eq:          { word: 'is',           sym: '=' },
    neq:         { word: 'is NOT',       sym: '≠' },
    gt:          { word: 'more than',    sym: '>' },
    gte:         { word: 'at least',     sym: '≥' },
    lt:          { word: 'less than',    sym: '<' },
    lte:         { word: 'at most',      sym: '≤' },
    contains:    { word: 'contains',     sym: '⊇' },
    starts_with: { word: 'starts with',  sym: '↦' },
    ends_with:   { word: 'ends with',    sym: '⇥' },
    in:          { word: 'is one of',    sym: '∈' },
    not_in:      { word: 'NOT one of',   sym: '∉' },
    regex:       { word: 'matches',      sym: '~' },
  };
  const humanizeValue = (field, v) => {
    if (Array.isArray(v)) return `${v.length} addresses`;
    const s = String(v ?? '');
    if (field === 'amount' && /^\d{10,}$/.test(s)) return `${fmtCsprNum(motesToCspr(s))} CSPR`;
    if (field === 'timestamp' && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 16).replace('T', ' ');
    if (KNOWN_CONTRACTS[s.toLowerCase()]) return KNOWN_CONTRACTS[s.toLowerCase()];
    if (/^[0-9a-f]{64}$/i.test(s)) return truncHash(s, 6, 4);
    return s.length > 32 ? truncHash(s, 14, 10) : s;
  };
  /**
   * Build a single condition as DOM nodes. Predicate values are attacker
   * controlled, so they only ever become text nodes; the sole markup is the
   * trusted icon sprite reference. Nothing here is parsed as HTML.
   */
  const condNode = (c) => {
    const frag = document.createDocumentFragment();
    const op = OP_LABEL[c.op] || { word: c.op, sym: c.op };
    frag.appendChild(iconNode(c.field));
    frag.appendChild(document.createTextNode(
      ` ${FIELD_LABEL[c.field] || c.field} ${op.sym} ${humanizeValue(c.field, c.value)}`,
    ));
    return frag;
  };
  /** Recursive node builder for AND/OR groups + plain conditions. */
  const nodeSummary = (node) => {
    const frag = document.createDocumentFragment();
    const group = (arr, joiner) => {
      frag.appendChild(document.createTextNode('('));
      arr.forEach((n, i) => {
        if (i) frag.appendChild(document.createTextNode(joiner));
        frag.appendChild(nodeSummary(n));
      });
      frag.appendChild(document.createTextNode(')'));
    };
    if (node && Array.isArray(node.or))  { group(node.or, ' OR '); return frag; }
    if (node && Array.isArray(node.and)) { group(node.and, ' AND '); return frag; }
    frag.appendChild(condNode(node));
    return frag;
  };
  const predicateSummaryNode = (pred) => {
    const frag = document.createDocumentFragment();
    if (!pred || !Array.isArray(pred.and)) {
      frag.appendChild(document.createTextNode(JSON.stringify(pred ?? {})));
      return frag;
    }
    pred.and.forEach((n, i) => {
      if (i) frag.appendChild(document.createTextNode(' AND '));
      frag.appendChild(nodeSummary(n));
    });
    return frag;
  };
  const toast = (msg, kind = 'info') => {
    const c = $('#toasts') || document.body.appendChild(el('div', { id: 'toasts', style: 'position:fixed;right:24px;bottom:24px;z-index:1000;display:flex;flex-direction:column;gap:8px' }));
    const colors = { info: '#000', error: '#ff2d2e', success: '#3edc64', warn: '#ff8a65' };
    const ink = (kind === 'success' || kind === 'warn') ? '#000' : '#fff';
    const t = el('div', { style: `background:${colors[kind] || '#000'};color:${ink};padding:14px 18px;font:500 13px 'Casper Sans',Inter;max-width:380px;box-shadow:4px 4px 0 ${kind === 'error' ? '#000' : '#bcfc07'};border:1px solid #000` }, msg);
    c.appendChild(t);
    setTimeout(() => t.remove(), 6000);
  };
  const copyToClipboard = async (text, label = 'Copied') => {
    try { await navigator.clipboard.writeText(text); toast(`${label}: ${truncHash(text, 16, 10)}`, 'success'); }
    catch (e) { toast(`Clipboard failed: ${e.message}`, 'error'); }
  };

  /* ─────────────────── webhook health (Prometheus) ─────────────────── */
  // Pulls /api/metrics, parses two cumulative counters, paints the green stat
  // card. We don't cache across ticks, Prometheus deltas are cheap.
  async function fetchHealthFromMetrics() {
    try {
      const r = await fetch('/api/metrics?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const body = await r.text();
      const grab = (prefix) => {
        for (const raw of body.split('\n')) {
          const line = raw.trim();
          if (!line || line.startsWith('#')) continue;
          if (!line.startsWith(prefix)) continue;
          const m = line.slice(prefix.length).match(/^\s+([\d.eE+-]+)$/);
          if (m) return Number(m[1]);
        }
        return null;
      };
      const ok = grab('sluice_webhook_results_total{result="ok"}') ?? 0;
      const fail = grab('sluice_webhook_results_total{result="fail"}') ?? 0;
      const total = ok + fail;
      const healthEl = $('#stat-health');
      const detailEl = $('#stat-health-detail');
      if (!healthEl) return;
      if (total === 0) {
        healthEl.textContent = '…';
        detailEl.textContent = 'no webhook attempts yet';
        return;
      }
      const pct = (ok / total) * 100;
      healthEl.textContent = `${pct.toFixed(1)}%`;
      detailEl.textContent = `${ok}/${total} ok · lifetime`;
    } catch { /* leave dash */ }
  }

  /* ─────────────────── snapshot polling ─────────────────── */
  async function fetchSnapshot() {
    try {
      const resp = await fetch(`${SNAPSHOT_URL}?t=${Date.now()}`, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      state.snapshot = json;
      render();
    } catch (e) {
      $('#status-sync').textContent = `offline · ${e.message}`;
    }
  }
  function startPolling() {
    fetchSnapshot();
    state.pollTimer = setInterval(fetchSnapshot, POLL_MS);
    state.relativeTimerId = setInterval(() => render(), 1000); // keep "Xs ago" fresh
  }

  /* ─────────────────── render ─────────────────── */
  function render() {
    if (!state.snapshot) return;
    renderHeader();
    renderStats();
    renderTable();
    renderActivity();
    renderActivityFull();
    renderThroughput();
    updateTabBadges();
  }

  function renderHeader() {
    const s = state.snapshot;
    const subs = s.subscriptions || [];
    const active = subs.filter(x => x.active).length;
    const mine = state.wallet.connected
      ? subs.filter(x => x.owner === state.wallet.accountHash).length
      : null;
    $('#status-active').textContent = active;
    $('#status-sync').textContent  = `synced ${fmtRelative(s.updated_at)}${mine != null ? ` · ${mine} owned by you` : ''}`;
    $('#contract-link').href = `https://testnet.cspr.live/contract-package/${s.contract_hash}`;
    $('#contract-link').textContent = `${truncHash(s.contract_hash, 6, 4)} on cspr.live`;
  }

  function renderStats() {
    const subs = state.snapshot.subscriptions || [];
    const totalEscrow = subs.filter(s => !s.demo).reduce((a, s) => a + motesToCspr(s.balance), 0);
    const totalDeliveries = subs.reduce((a, s) => a + (s.deliveries || 0), 0);
    const active = subs.filter(s => s.active).length;
    const deliveryCost = motesToCspr(state.snapshot.delivery_unit_cost || '1000000000');
    const coverage = deliveryCost > 0 ? Math.floor(totalEscrow / deliveryCost) : 0;

    $('#stat-active-count').textContent = active;
    $('#stat-active-total').textContent = subs.length;
    $('#stat-escrow').textContent = totalEscrow.toLocaleString('en-US');
    $('#stat-coverage').textContent = `~ ${coverage.toLocaleString()} deliveries`;
    $('#stat-deliveries').textContent = totalDeliveries.toLocaleString('en-US');
    $('#stat-deliveries-trend').textContent = ''; // requires timeseries; omit until v0.2

    // webhook health needs delivery history; show "…" until matcher exposes it
    // Webhook health, pull lifetime success/fail counters from /api/metrics.
    // We fire-and-forget; the next render won't block on it. Failure leaves
    // the placeholder dash intact so we never lie about health.
    fetchHealthFromMetrics().catch(() => {});
  }

  function renderTable() {
    const subs = state.snapshot.subscriptions || [];
    const f = state.filter;
    const q = state.search.trim().toLowerCase();
    const filtered = subs.filter((s) => {
      if (f === 'active' && !s.active) return false;
      if (f === 'low' && (motesToCspr(s.balance) > 5 || !s.active)) return false;
      if (f === 'depleted' && s.active) return false;
      if (f === 'mine' && (!state.wallet.connected || s.owner !== state.wallet.accountHash)) return false;
      if (q) {
        const hay = `${s.id} ${s.owner} ${s.webhook_url} ${JSON.stringify(s.predicate)}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const tbody = $('#subs-tbody');
    tbody.innerHTML = '';

    if (filtered.length === 0) {
      tbody.appendChild(el('div', { style: 'padding:48px 22px;text-align:center;color:#666;font:400 14px Casper Sans,Inter' },
        subs.length === 0 ? 'No subscriptions on this contract yet.' : 'No subscriptions match the current filter.',
        el('div', { style: 'margin-top:14px' },
          el('button', {
            class: 'btn-primary',
            style: 'background:#bcfc07;color:#000;border:1px solid #000;padding:11px 20px;font:500 14px Casper Sans,Inter;cursor:pointer',
            onclick: () => openCreateModal(),
          }, '+ Create the first one'),
        ),
      ));
    } else {
      for (const s of filtered) tbody.appendChild(renderRow(s));
    }

    $('#subs-count').textContent = String(filtered.length);
    $('#subs-total-footer').textContent = `${subs.length} SUBSCRIPTION${subs.length === 1 ? '' : 'S'} · ${subs.filter(x => x.active).length} ACTIVE`;
  }

  function renderRow(s) {
    const lowBalance = motesToCspr(s.balance) <= 5 && s.active;
    const statusBadge = !s.active
      ? el('span', { style: 'font:500 10.5px JetBrains Mono;background:#fff;border:1px solid #000;color:#000;padding:2px 7px;letter-spacing:.08em' }, 'DEPLETED')
      : lowBalance
        ? el('span', { style: 'font:500 10.5px JetBrains Mono;background:#ff2d2e;color:#fff;padding:3px 8px;letter-spacing:.08em' }, 'LOW')
        : el('span', { style: 'font:500 10.5px JetBrains Mono;background:#bcfc07;color:#000;padding:3px 8px;letter-spacing:.08em' }, 'ACTIVE');
    const isMine = state.wallet.connected && s.owner === state.wallet.accountHash;
    return el('div', {
      class: 'subs-grid',
      style: `display:grid;grid-template-columns:84px 1.8fr 1.3fr 100px 90px 110px;gap:14px;padding:16px 22px;border-bottom:1px solid #ccc;align-items:center;font:400 13.5px Casper Sans,Inter;color:#000${isMine ? ';background:#f6ffd6' : ''}`,
    },
      el('div', { style: 'font:500 12.5px JetBrains Mono;color:#000' },
        `sub_${String(s.id).padStart(4, '0')}`,
        s.demo ? el('span', { title: 'Injected demo lane, no on-chain escrow', style: 'display:block;margin-top:5px;width:fit-content;font:500 9px JetBrains Mono;background:#e9e9e9;color:#555;padding:2px 6px;letter-spacing:.08em' }, 'DEMO LANE') : null,
      ),
      el('div', {},
        el('div', { style: 'font:500 12.5px JetBrains Mono;color:#000' }, predicateSummaryNode(s.predicate)),
        el('div', { style: 'margin-top:6px;font:500 11px JetBrains Mono;color:#666;letter-spacing:.04em' },
          `${s.deliveries} delivered · owner ${truncHash(s.owner)}${isMine ? ' · YOU' : ''}`,
        ),
      ),
      el('div', { style: 'min-width:0' },
        el('div', {
          title: s.webhook_url,
          style: 'font-family:JetBrains Mono;font-size:12.5px;color:#000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis',
        }, s.webhook_url || ''),
      ),
      el('div', { style: 'text-align:right' },
        el('div', { style: `font:500 14px JetBrains Mono;color:${lowBalance || !s.active ? '#ff2d2e' : '#000'}` }, s.demo ? '—' : fmtCsprNum(motesToCspr(s.balance))),
        el('div', { style: 'font:400 11px JetBrains Mono;color:#666' }, 'CSPR'),
      ),
      el('div', { style: 'text-align:right;font:500 14px JetBrains Mono;color:#000' }, String(s.deliveries)),
      el('div', { style: 'display:flex;justify-content:flex-end;gap:8px;align-items:center' },
        statusBadge,
        el('button', {
          style: 'background:none;border:none;color:#000;cursor:pointer;font:500 16px Casper Sans;padding:2px 6px',
          title: 'Open sub menu',
          onclick: (ev) => openRowMenu(s, ev.currentTarget),
        }, '⋯'),
      ),
    );
  }

  function renderActivity() {
    const events = state.snapshot.recent_events || [];
    const list = $('#activity-list');
    list.innerHTML = '';
    if (events.length === 0) {
      list.appendChild(el('div', { style: 'padding:24px 16px;color:#8f8f8f;font:400 12px JetBrains Mono;text-align:center' }, 'No deliveries yet · waiting for matches'));
      return;
    }
    for (const e of events.slice(0, 6)) {
      const ok = e.status >= 200 && e.status < 300;
      const replayBtn = el('button', {
        title: 'Re-fire this webhook to the subscriber',
        style: 'background:transparent;border:1px solid #333;color:#bcfc07;cursor:pointer;font:500 10px JetBrains Mono;padding:2px 6px;letter-spacing:.06em',
        onclick: (ev) => { ev.stopPropagation(); replayEvent(e.event_hash, replayBtn); },
      }, '↻ RESEND');
      list.appendChild(el('div', { style: 'padding:13px 16px;border-bottom:1px solid #1a1a1a' },
        el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline' },
          el('span', { style: 'color:#fff;font-weight:500' }, `sub_${String(e.subscription_id).padStart(4, '0')}`),
          el('span', { style: 'color:#8f8f8f' }, fmtRelative(e.timestamp)),
        ),
        el('div', { style: 'margin-top:4px;color:#ccc' }, e.description || `event ${truncHash(e.event_hash || '', 6, 4)}`),
        el('div', { style: 'margin-top:4px;display:flex;justify-content:space-between;align-items:center' },
          el('span', { style: `color:${ok ? '#3edc64' : '#ff2d2e'}` },
            ok ? `→ ${e.status} · ${e.latency_ms ?? '?'}ms` : `↻ ${e.status || 'FAIL'} · retry ${e.attempts || '?'}`,
          ),
          replayBtn,
        ),
      ));
    }
  }

  async function sendTestWebhook(subscriptionId) {
    toast(`Sending test event to sub_${String(subscriptionId).padStart(4, '0')}…`, 'info');
    try {
      const r = await fetch('/api/tx/test-webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription_id: subscriptionId }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      const data = await r.json();
      toast(`Test sent, ${data.statusCode ?? '?'} · ${data.latency_ms}ms · ${truncHash(data.webhook_url || '', 16, 8)}`, data.ok ? 'success' : 'warn');
    } catch (e) {
      toast(`Test webhook failed: ${e.message}`, 'error');
    }
  }

  async function replayEvent(eventHash, btn) {
    if (!eventHash) return;
    const orig = btn.textContent;
    btn.textContent = '… RESENDING';
    btn.disabled = true;
    try {
      const r = await fetch('/api/tx/replay', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event_hash: eventHash }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      const data = await r.json();
      toast(`Resent, status ${data.statusCode ?? '?'} · ${data.latency_ms}ms`, data.ok ? 'success' : 'warn');
      btn.textContent = data.ok ? '✓ SENT' : '✕ FAIL';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1800);
    } catch (e) {
      toast(`Replay failed: ${e.message}`, 'error');
      btn.textContent = orig; btn.disabled = false;
    }
  }

  function renderThroughput() {
    // Best-effort: matcher snapshot may include a `throughput_24h` array of {t, deliveries}.
    const tp = state.snapshot.throughput_24h;
    const totalEl = $('#tp-total');
    if (!tp || !Array.isArray(tp) || tp.length === 0) {
      totalEl.textContent = String((state.snapshot.subscriptions || []).reduce((a, s) => a + (s.deliveries || 0), 0));
      $('#tp-peak').textContent = ',  · waiting on timeseries';
      return;
    }
    totalEl.textContent = tp.reduce((a, p) => a + (p.deliveries || 0), 0).toLocaleString();
  }

  /* ─────────────────── filter + search ─────────────────── */
  function bindToolbar() {
    $$('#filter-pills > [data-filter]').forEach((b) => {
      b.addEventListener('click', () => {
        state.filter = b.dataset.filter;
        $$('#filter-pills > [data-filter]').forEach(x => x.classList.toggle('active', x.dataset.filter === state.filter));
        renderTable();
      });
    });
    $('#search-input').addEventListener('input', (e) => { state.search = e.target.value; renderTable(); });
    $('#csv-btn').addEventListener('click', exportCsv);
  }

  function exportCsv() {
    if (!state.snapshot) return;
    const subs = state.snapshot.subscriptions || [];
    const header = ['id', 'owner', 'predicate_json', 'webhook_url', 'balance_motes', 'deliveries', 'active', 'created_at'];
    const rows = subs.map(s => [s.id, s.owner, JSON.stringify(s.predicate), s.webhook_url, s.balance, s.deliveries, s.active, s.created_at]
      .map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const csv = [header.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `sluice-subscriptions-${new Date().toISOString().slice(0,10)}.csv` });
    document.body.appendChild(a); a.click(); a.remove();
    toast('CSV downloaded', 'success');
  }

  /* ─────────────────── row dropdown ─────────────────── */
  function openRowMenu(sub, anchor) {
    const existing = $('#row-menu');
    if (existing) existing.remove();
    const r = anchor.getBoundingClientRect();
    const menu = el('div', {
      id: 'row-menu',
      style: `position:fixed;top:${r.bottom + 4}px;left:${r.right - 220}px;background:#fff;border:1px solid #000;width:220px;box-shadow:6px 6px 0 #bcfc07;z-index:50;font:400 13px Casper Sans,Inter`,
    });
    const item = (txt, fn) => el('button', {
      style: 'display:block;width:100%;text-align:left;padding:10px 14px;background:#fff;border:none;border-bottom:1px solid #ccc;cursor:pointer;font:400 13px Casper Sans,Inter;color:#000',
      onclick: () => { menu.remove(); fn(); },
    }, txt);
    menu.appendChild(item('View on cspr.live →', () => window.open(`https://testnet.cspr.live/contract-package/${state.snapshot.contract_hash}?tab=events`, '_blank')));
    menu.appendChild(item('Copy webhook URL', () => copyToClipboard(sub.webhook_url, 'Webhook')));
    menu.appendChild(item('Copy predicate JSON', () => copyToClipboard(JSON.stringify(sub.predicate), 'Predicate')));
    menu.appendChild(item('Send test webhook', () => sendTestWebhook(sub.id)));
    menu.appendChild(item('Top-up CSPR…', () => openTopUpModal(sub)));
    menu.appendChild(item('Cancel & refund…', () => openCancelModal(sub)));
    document.body.appendChild(menu);
    setTimeout(() => document.addEventListener('click', function once(ev) {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', once); }
    }), 0);
  }

  /* ─────────────────── modals ─────────────────── */
  function openModal(title, body, footer) {
    const footerChildren = footer ? (Array.isArray(footer) ? footer : [footer]) : null;
    const overlay = el('div', {
      class: 'modal-overlay',
      style: 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:100;padding:24px',
      onclick: (ev) => { if (ev.target === overlay) overlay.remove(); },
    },
      el('div', { style: 'background:#fff;border:1px solid #000;width:min(640px,100%);box-shadow:10px 10px 0 #bcfc07;max-height:calc(100vh - 48px);overflow:auto' },
        el('div', { style: 'padding:18px 26px;border-bottom:1px solid #000;display:flex;align-items:center' },
          el('div', { style: 'font:500 18px Casper Sans,Inter;color:#000' }, title),
          el('div', { style: 'flex:1' }),
          el('button', { style: 'background:none;border:none;font:500 22px Casper Sans;cursor:pointer;color:#000', onclick: () => overlay.remove() }, '×'),
        ),
        el('div', { style: 'padding:24px 26px' }, body),
        footerChildren && el('div', { style: 'padding:18px 26px;background:#fafafa;border-top:1px solid #000;display:flex;gap:10px;justify-content:flex-end' }, ...footerChildren),
      ),
    );
    document.body.appendChild(overlay);
    return overlay;
  }

  function openCreateModal(prefillPredicate) {
    const ownerHash = 'YOUR_ACCOUNT_HASH';
    const defaultPredicate = {
      and: [
        { field: 'to_account_hash', op: 'eq', value: ownerHash },
        { field: 'amount', op: 'gte', value: '2500000000' },
      ],
    };
    const samplePredicate = JSON.stringify(prefillPredicate || defaultPredicate, null, 2);

    const predicateTa = el('textarea', { style: 'width:100%;box-sizing:border-box;min-height:160px;padding:12px;border:1px solid #000;font:400 12px JetBrains Mono;background:#fafafa;color:#000;resize:vertical' }, samplePredicate);
    const webhookIn = el('input', { type: 'url', placeholder: 'https://your.app/webhook', value: 'https://webhook.site/4f3f550f-6836-43b2-ba94-83b6839360d6', style: 'width:100%;box-sizing:border-box;padding:12px;border:1px solid #000;font:400 13px JetBrains Mono' });
    const amountIn = el('input', { type: 'number', min: '1', value: '10', style: 'width:100%;box-sizing:border-box;padding:12px;border:1px solid #000;font:500 16px JetBrains Mono' });

    const cliBox = el('pre', { id: 'create-cli', style: 'margin:0;background:#000;color:#fff;padding:14px 18px;font:400 12px JetBrains Mono;line-height:1.6;white-space:pre-wrap;word-break:break-all' });
    const mcpBox = el('pre', { id: 'create-mcp', style: 'margin:0;background:#1a1a1a;color:#fff;padding:14px 18px;font:400 12px JetBrains Mono;line-height:1.55;white-space:pre-wrap;word-break:break-all' });
    const tab = (label, panel, isActive) => el('button', {
      style: `padding:10px 18px;background:${isActive ? '#000' : '#fafafa'};color:${isActive ? '#bcfc07' : '#666'};border:1px solid #000;border-right:none;cursor:pointer;font:500 11px JetBrains Mono;letter-spacing:.06em;text-transform:uppercase`,
      'data-panel': panel,
    }, label);
    const tabs = el('div', { style: 'display:flex' },
      tab('CLI', 'cli', true),
      tab('Claude / MCP', 'mcp', false),
    );
    const panels = el('div', { style: 'border:1px solid #000;border-top:none' });
    cliBox.dataset.panel = 'cli';
    mcpBox.dataset.panel = 'mcp';
    mcpBox.style.display = 'none';
    panels.appendChild(cliBox);
    panels.appendChild(mcpBox);
    tabs.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      tabs.querySelectorAll('button').forEach(x => {
        const active = x.dataset.panel === b.dataset.panel;
        x.style.background = active ? '#000' : '#fafafa';
        x.style.color = active ? '#bcfc07' : '#666';
      });
      [cliBox, mcpBox].forEach(p => { p.style.display = p.dataset.panel === b.dataset.panel ? 'block' : 'none'; });
    }));

    const copyBtn = el('button', { style: 'background:#bcfc07;color:#000;border:1px solid #000;padding:11px 20px;font:500 14px Casper Sans,Inter;cursor:pointer' }, '⧉ Copy current command');

    const body = el('div', {},
      el('div', { style: 'background:#f4f4f4;border:1px solid #000;padding:14px 16px;font:400 13px/1.6 Casper Sans,Inter;color:#000;margin-bottom:20px' },
        el('div', { style: 'font:500 11px JetBrains Mono;color:#000;letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px;display:flex;align-items:center;gap:8px' },
          el('span', { style: 'display:inline-flex;width:16px;height:16px;background:#bcfc07;align-items:center;justify-content:center' }, el('svg', { width: '11', height: '11' }, (() => { const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#icon-sparkle'); return u; })())),
          'Two ways to lock a subscription',
        ),
        `Sluice is agent-first. Subscriptions are created with one signed deploy, driven either by the `,
        el('strong', {}, 'CLI'),
        ` (you sign locally with casper-client) or by your `,
        el('strong', {}, 'AI agent over MCP'),
        ` (Claude Code / Codex signs and submits for you). Fill the fields below and copy the exact command. `,
        el('span', { style: 'color:#666' }, 'One-click wallet signing lands in v0.2 alongside the TransactionV1 contract rewrite. Until then create, top-up and cancel run through the CLI or any MCP client; this dashboard is read-only.'),
      ),
      el('div', { style: 'font:500 11px JetBrains Mono;color:#666;letter-spacing:.12em;text-transform:uppercase;margin-bottom:8px' }, '1 · Predicate'),
      predicateTa,
      el('div', { style: 'font:400 12px JetBrains Mono;color:#666;margin-top:6px' }, 'AND-of-conditions. fields: amount · to_account_hash · deploy_hash · initiator_account_hash · from_purse · to_purse · transfer_index · block_height. ops: eq, neq, gt, gte, lt, lte. amount is in motes (1 CSPR = 1e9 motes).'),
      el('div', { style: 'font:500 11px JetBrains Mono;color:#666;letter-spacing:.12em;text-transform:uppercase;margin:22px 0 8px' }, '2 · Webhook URL'),
      webhookIn,
      el('div', { style: 'font:500 11px JetBrains Mono;color:#666;letter-spacing:.12em;text-transform:uppercase;margin:22px 0 8px' }, '3 · Escrow (CSPR)'),
      el('div', { style: 'display:flex;align-items:center;gap:14px' }, amountIn, el('div', { style: 'font:400 13px JetBrains Mono;color:#666' }, '~ 1 delivery per CSPR (configurable per-contract)')),
      el('div', { style: 'margin-top:22px' }, tabs, panels),
    );

    const updateSnippets = () => {
      const pred = predicateTa.value.replace(/\s+/g, ' ');
      const wh = webhookIn.value.trim() || '<webhook url>';
      const amt = amountIn.value || '?';
      cliBox.textContent =
`# 1. save the predicate to a file
echo '${pred}' > whale.json

# 2. install the matcher CLI (one-time)
git clone https://github.com/UnityNodes/Sluice && cd Sluice/matcher
npm install && npm run build && npm link

# 3. lock CSPR into a subscription
export SLUICE_CONTRACT_HASH=f3710eaf12c30346eb1c642da832bc1af8ff900254c46bcc49a1efca81d8b971
export SLUICE_KEY=~/keys/subscriber/secret_key.pem
sluice subscribe \\
  --predicate ./whale.json \\
  --webhook ${wh} \\
  --amount ${amt}`;
      mcpBox.textContent =
`# 1. add the hosted MCP endpoint, works with any MCP client
#    Claude Code:
claude mcp add --transport http sluice https://sluice.unitynodes.com/mcp
#    Cursor / Windsurf / VS Code / Cline: add this URL to your MCP config:
#    https://sluice.unitynodes.com/mcp

# 2. then, in any MCP client chat:
"Subscribe me to Casper transfers matching this predicate:
${pred}
Webhook it to ${wh}, lock ${amt} CSPR."`;
    };
    [predicateTa, webhookIn, amountIn].forEach(i => i.addEventListener('input', updateSnippets));
    updateSnippets();

    copyBtn.addEventListener('click', () => {
      const activePanel = [cliBox, mcpBox].find(p => p.style.display !== 'none');
      copyToClipboard(activePanel.textContent, 'Command');
    });

    const overlay = openModal('New subscription', body, [
      el('button', { style: 'background:#fff;color:#000;border:1px solid #000;padding:11px 20px;font:500 14px Casper Sans,Inter;cursor:pointer', onclick: () => overlay.remove() }, 'Close'),
      copyBtn,
    ]);
  }

  function openTopUpModal(sub) {
    const amountIn = el('input', { type: 'number', min: '1', value: '10', style: 'width:100%;box-sizing:border-box;padding:12px;border:1px solid #000;font:500 16px JetBrains Mono' });
    const cliBox = el('pre', { style: 'margin:14px 0 0;background:#000;color:#fff;padding:14px 18px;font:400 12px JetBrains Mono;line-height:1.6;white-space:pre-wrap;word-break:break-all' });
    const copyBtn = el('button', { style: 'background:#bcfc07;color:#000;border:1px solid #000;padding:11px 20px;font:500 14px Casper Sans,Inter;cursor:pointer' }, '⧉ Copy CLI command');

    const updateCli = () => {
      cliBox.textContent = `export SLUICE_CONTRACT_HASH=f3710eaf12c30346eb1c642da832bc1af8ff900254c46bcc49a1efca81d8b971\nexport SLUICE_KEY=~/keys/subscriber/secret_key.pem\nsluice top-up --id ${sub.id} --amount ${amountIn.value || '?'}`;
    };
    amountIn.addEventListener('input', updateCli);
    updateCli();
    copyBtn.addEventListener('click', () => copyToClipboard(cliBox.textContent, 'Command'));

    const body = el('div', {},
      el('div', { style: 'background:#fafafa;border:1px solid #ccc;padding:12px 14px;font:400 13px/1.5 Casper Sans,Inter;color:#333;margin-bottom:18px' },
        el('strong', {}, 'v0.1, wallet flow ships with v0.2.'),
        ` Same purse-construct constraint as creating a subscription. Copy the equivalent CLI / MCP command for now.`,
      ),
      el('div', { style: 'font:400 14px Casper Sans,Inter;color:#000' }, `Sub `, el('span', { style: 'font:500 13px JetBrains Mono' }, `sub_${String(sub.id).padStart(4, '0')}`), ` · current balance ${fmtCsprNum(motesToCspr(sub.balance))} CSPR.`),
      el('div', { style: 'font:500 11px JetBrains Mono;color:#666;letter-spacing:.12em;text-transform:uppercase;margin:22px 0 8px' }, 'Top-up (CSPR)'),
      amountIn,
      cliBox,
    );

    const overlay = openModal(`Top up sub_${String(sub.id).padStart(4, '0')}`, body, [
      el('button', { style: 'background:#fff;color:#000;border:1px solid #000;padding:11px 20px;font:500 14px Casper Sans,Inter;cursor:pointer', onclick: () => overlay.remove() }, 'Close'),
      copyBtn,
    ]);
  }

  function openCancelModal(sub) {
    const cliBox = el('pre', { style: 'margin:14px 0 0;background:#000;color:#fff;padding:14px 18px;font:400 12px JetBrains Mono;line-height:1.6;white-space:pre-wrap;word-break:break-all' });
    const copyBtn = el('button', { style: 'background:#ff2d2e;color:#fff;border:1px solid #000;padding:11px 20px;font:500 14px Casper Sans,Inter;cursor:pointer' }, '⧉ Copy CLI command');
    cliBox.textContent = `export SLUICE_CONTRACT_HASH=f3710eaf12c30346eb1c642da832bc1af8ff900254c46bcc49a1efca81d8b971\nexport SLUICE_KEY=~/keys/subscriber/secret_key.pem\nsluice cancel --id ${sub.id}`;
    copyBtn.addEventListener('click', () => copyToClipboard(cliBox.textContent, 'Command'));

    const body = el('div', {},
      el('div', { style: 'background:#fafafa;border:1px solid #ccc;padding:12px 14px;font:400 13px/1.5 Casper Sans,Inter;color:#333;margin-bottom:18px' },
        el('strong', {}, 'v0.1, read-only dashboard.'),
        ' All mutations (create, top-up, cancel) go through the CLI or the MCP server (works with any MCP client). The dashboard reflects on-chain state within ~30 s of each change.',
      ),
      el('p', { style: 'font:400 15px/1.55 Casper Sans,Inter;color:#000' },
        'Cancel ', el('span', { style: 'font:500 13px JetBrains Mono' }, `sub_${String(sub.id).padStart(4, '0')}`),
        `? Your remaining ${fmtCsprNum(motesToCspr(sub.balance))} CSPR refunds to the owner's account on-chain.`,
      ),
      el('p', { style: 'font:400 13px Casper Sans,Inter;color:#666;margin-top:14px' },
        'Only the subscription owner key can submit this, anyone else gets a NotOwner revert from the contract.',
      ),
      cliBox,
    );

    const overlay = openModal(`Cancel sub_${String(sub.id).padStart(4, '0')}`, body, [
      el('button', { style: 'background:#fff;color:#000;border:1px solid #000;padding:11px 20px;font:500 14px Casper Sans,Inter;cursor:pointer', onclick: () => overlay.remove() }, 'Close'),
      copyBtn,
    ]);
  }

  /* ─────────────────── init ─────────────────── */
  /* ─────────────────── wallet (read-only · v0.1) ─────────────────── */
  function applyWalletAccount(pubkey, accountHash) {
    state.wallet.connected = true;
    state.wallet.pubkey = pubkey;
    state.wallet.accountHash = accountHash;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.wallet)); } catch {}
    renderWalletButton();
    render();
  }
  function clearWalletState() {
    state.wallet = { connected: false, pubkey: null, accountHash: null };
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    renderWalletButton();
    render();
  }

  /* CSPR.click, Casper's official auth layer (multi-wallet + social login). We
   * drive it headlessly from our own button; the account (public key + account
   * hash) arrives on the signed_in event, so no manual derivation is needed. The
   * SDK is loaded dynamically after its options are set. If it is unavailable,
   * connect() falls back to the Casper Wallet provider directly. */
  function setupCsprClick() {
    if (!CSPRCLICK_APP_ID) return; // not configured, direct Casper Wallet provider is used instead
    window.clickUIOptions = { uiContainer: 'csprclick-ui', rootAppElement: 'body', defaultTheme: 'light', showTopBar: false };
    window.clickSDKOptions = { appName: 'Sluice', appId: CSPRCLICK_APP_ID, contentMode: 'iframe', providers: ['casper-wallet', 'ledger', 'metamask-snap'] };
    const onAccount = (evt) => {
      const acc = (evt && (evt.account || evt)) || {};
      const pubkey = acc.public_key || acc.publicKey || acc.public_key_hex;
      if (!pubkey) return;
      let accountHash = acc.account_hash || acc.accountHash || '';
      accountHash = String(accountHash).replace(/^account-hash-/, '');
      if (!accountHash) { try { accountHash = pubkeyToAccountHash(pubkey); } catch {} }
      applyWalletAccount(pubkey, accountHash);
      toast('Wallet connected · ' + truncHash(pubkey, 6, 6), 'success');
    };
    window.addEventListener('csprclick:loaded', () => {
      try {
        window.csprclick.on('csprclick:signed_in', onAccount);
        window.csprclick.on('csprclick:switched_account', onAccount);
        window.csprclick.on('csprclick:signed_out', clearWalletState);
        window.csprclick.on('csprclick:disconnected', clearWalletState);
        const active = window.csprclick.getActiveAccount && window.csprclick.getActiveAccount();
        if (active) onAccount({ account: active });
      } catch (e) { console.warn('csprclick wiring failed', e); }
    });
  }

  // Judge-clickable live x402 payment: POST /api/x402/pay fires a real on-chain
  // micropayment (server-side paying agent) and returns the settlement tx.
  function bindX402() {
    const btn = document.getElementById('x402-pay-btn');
    const out = document.getElementById('x402-result');
    if (!btn) return;
    btn.onclick = async () => {
      const label = btn.textContent;
      btn.disabled = true; btn.style.opacity = '.6'; btn.textContent = 'Settling on-chain…';
      if (out) out.textContent = 'Signing the payment authorization and settling through the facilitator…';
      try {
        const r = await fetch('/api/x402/pay', { method: 'POST' });
        const j = await r.json();
        if (j && j.ok && j.tx) {
          const ev = j.event || {};
          const d = (ev.event && ev.event.data) || {};
          let evText = escHtml(ev.description || 'matched event');
          if (d.token_in && d.amount_in) {
            evText = 'Swap ' + escHtml((Number(d.amount_in) / 1e9).toLocaleString('en-US')) + ' ' + escHtml(d.token_in) + ' → ' + escHtml(d.token_out || '');
          }
          const tx = safeHash(j.tx);
          const explorer = 'https://testnet.cspr.live/transaction/' + tx;
          out.innerHTML = 'Paid 0.1 WCSPR, delivered: ' + evText + (tx
            ? ' · <a href="' + explorer + '" target="_blank" rel="noopener" style="color:#bcfc07;text-decoration:underline">' + tx.slice(0, 10) + '…' + tx.slice(-6) + ' on cspr.live</a>'
            : '');
        } else {
          out.textContent = (j && j.error) ? j.error : 'payment failed, try again in a moment';
        }
      } catch (e) {
        out.textContent = 'error: ' + ((e && e.message) || e);
      } finally {
        btn.disabled = false; btn.style.opacity = '1'; btn.textContent = label;
      }
    };
  }

  async function connectWallet() {
    if (window.csprclick && typeof window.csprclick.signIn === 'function') {
      try { await window.csprclick.signIn(); return; }
      catch (e) { console.warn('csprclick signIn failed, using direct provider', e); }
    }
    return connectWalletLegacy();
  }
  async function connectWalletLegacy() {
    if (typeof window.CasperWalletProvider !== 'function') {
      toast('Casper Wallet extension not detected, install from casperwallet.io', 'error');
      window.open('https://www.casperwallet.io/', '_blank');
      return;
    }
    try {
      const wallet = window.CasperWalletProvider();
      const ok = await wallet.requestConnection();
      if (!ok) { toast('Wallet connection rejected', 'warn'); return; }
      const pubkey = await wallet.getActivePublicKey();
      applyWalletAccount(pubkey, pubkeyToAccountHash(pubkey));
      toast('Wallet connected · ' + truncHash(pubkey, 6, 6), 'success');
    } catch (e) {
      toast(`Wallet error: ${(e && e.message) || e}`, 'error');
    }
  }
  async function disconnectWallet() {
    if (window.csprclick && typeof window.csprclick.signOut === 'function') {
      try { await window.csprclick.signOut(); } catch {}
    } else {
      try { await window.CasperWalletProvider().disconnectFromSite(); } catch {}
    }
    clearWalletState();
  }
  function renderWalletButton() {
    const btn = $('#wallet-btn');
    if (!btn) return;
    btn.innerHTML = '';
    const mineFilter = $('#filter-mine');
    if (state.wallet.connected) {
      btn.appendChild(el('span', { style: 'width:7px;height:7px;background:#3edc64;border-radius:50%' }));
      btn.appendChild(document.createTextNode(' ' + truncHash(state.wallet.pubkey, 6, 6)));
      btn.title = 'Click to disconnect (read-only, sub filter only)';
      btn.onclick = disconnectWallet;
      btn.style.background = '#fff';
      if (mineFilter) { mineFilter.style.opacity = '1'; mineFilter.title = 'Show only your subscriptions'; }
    } else {
      btn.appendChild(document.createTextNode('Connect wallet'));
      btn.title = 'Connect to filter to your own subscriptions and cancel them. Create uses the CLI or your AI agent (see New subscription).';
      btn.onclick = connectWallet;
      btn.style.background = '#bcfc07';
      if (mineFilter) { mineFilter.style.opacity = '.4'; mineFilter.title = 'Connect wallet to enable'; }
    }
  }

  /* Self-contained BLAKE2b-256 (adapted from blakejs, public domain) so wallet
   * account-hash derivation has no CDN dependency. Verified against the
   * standard test vectors and casper-client account-address output. */
  function blake2b256(input) {
    const IV = new Uint32Array([
      0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372,
      0x5f1d36f1, 0xa54ff53a, 0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c,
      0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19
    ]);
    const SIGMA = [
      0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15, 14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3,
      11,8,12,0,5,2,15,13,10,14,3,6,7,1,9,4, 7,9,3,1,13,12,11,14,2,6,5,10,4,0,15,8,
      9,0,5,7,2,4,10,15,14,1,11,12,6,8,3,13, 2,12,6,10,0,11,8,3,4,13,7,5,15,14,1,9,
      12,5,1,15,14,13,4,10,0,7,6,3,9,2,8,11, 13,11,7,14,12,1,3,9,5,0,15,4,8,6,2,10,
      6,15,14,9,11,3,0,8,12,2,13,7,1,4,10,5, 10,2,8,4,7,6,1,5,15,11,9,14,3,12,13,0,
      0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15, 14,10,4,8,9,15,13,6,1,12,0,2,11,7,5,3
    ].map(x => x * 2);
    const v = new Uint32Array(32), m = new Uint32Array(32);
    const addAA = (a, b) => { let o0 = v[a] + v[b], o1 = v[a+1] + v[b+1]; if (o0 >= 0x100000000) o1++; v[a] = o0; v[a+1] = o1; };
    const addAC = (a, b0, b1) => { let o0 = v[a] + b0; if (b0 < 0) o0 += 0x100000000; let o1 = v[a+1] + b1; if (o0 >= 0x100000000) o1++; v[a] = o0; v[a+1] = o1; };
    const get32 = (arr, i) => arr[i] ^ (arr[i+1] << 8) ^ (arr[i+2] << 16) ^ (arr[i+3] << 24);
    const G = (a, b, c, d, ix, iy) => {
      addAA(a, b); addAC(a, m[ix], m[ix+1]);
      let x0 = v[d] ^ v[a], x1 = v[d+1] ^ v[a+1]; v[d] = x1; v[d+1] = x0;
      addAA(c, d);
      x0 = v[b] ^ v[c]; x1 = v[b+1] ^ v[c+1]; v[b] = (x0 >>> 24) ^ (x1 << 8); v[b+1] = (x1 >>> 24) ^ (x0 << 8);
      addAA(a, b); addAC(a, m[iy], m[iy+1]);
      x0 = v[d] ^ v[a]; x1 = v[d+1] ^ v[a+1]; v[d] = (x0 >>> 16) ^ (x1 << 16); v[d+1] = (x1 >>> 16) ^ (x0 << 16);
      addAA(c, d);
      x0 = v[b] ^ v[c]; x1 = v[b+1] ^ v[c+1]; v[b] = (x1 >>> 31) ^ (x0 << 1); v[b+1] = (x0 >>> 31) ^ (x1 << 1);
    };
    const ctx = { b: new Uint8Array(128), h: new Uint32Array(16), t: 0, c: 0 };
    for (let i = 0; i < 16; i++) ctx.h[i] = IV[i];
    ctx.h[0] ^= 0x01010000 ^ 32;
    const compress = (last) => {
      let i;
      for (i = 0; i < 16; i++) { v[i] = ctx.h[i]; v[i+16] = IV[i]; }
      v[24] ^= ctx.t; v[25] ^= (ctx.t / 0x100000000);
      if (last) { v[28] = ~v[28]; v[29] = ~v[29]; }
      for (i = 0; i < 32; i++) m[i] = get32(ctx.b, 4 * i);
      for (i = 0; i < 12; i++) {
        G(0, 8, 16, 24, SIGMA[i*16+0], SIGMA[i*16+1]);
        G(2, 10, 18, 26, SIGMA[i*16+2], SIGMA[i*16+3]);
        G(4, 12, 20, 28, SIGMA[i*16+4], SIGMA[i*16+5]);
        G(6, 14, 22, 30, SIGMA[i*16+6], SIGMA[i*16+7]);
        G(0, 10, 20, 30, SIGMA[i*16+8], SIGMA[i*16+9]);
        G(2, 12, 22, 24, SIGMA[i*16+10], SIGMA[i*16+11]);
        G(4, 14, 16, 26, SIGMA[i*16+12], SIGMA[i*16+13]);
        G(6, 8, 18, 28, SIGMA[i*16+14], SIGMA[i*16+15]);
      }
      for (i = 0; i < 16; i++) ctx.h[i] ^= v[i] ^ v[i+16];
    };
    for (let i = 0; i < input.length; i++) {
      if (ctx.c === 128) { ctx.t += ctx.c; compress(false); ctx.c = 0; }
      ctx.b[ctx.c++] = input[i];
    }
    ctx.t += ctx.c;
    while (ctx.c < 128) ctx.b[ctx.c++] = 0;
    compress(true);
    const out = new Uint8Array(32);
    for (let j = 0; j < 32; j++) out[j] = (ctx.h[j >> 2] >> (8 * (j & 3))) & 0xff;
    return out;
  }

  function pubkeyToAccountHash(pubkeyHex) {
    const bytes = (() => { const o = new Uint8Array(pubkeyHex.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(pubkeyHex.substr(i * 2, 2), 16); return o; })();
    const algoByte = bytes[0];
    const raw = bytes.slice(1);
    const label = algoByte === 0x01 ? 'ed25519' : algoByte === 0x02 ? 'secp256k1' : null;
    if (!label) throw new Error(`unknown algo byte 0x${algoByte.toString(16)}`);
    const labelBytes = new TextEncoder().encode(label);
    const buf = new Uint8Array(labelBytes.length + 1 + raw.length);
    buf.set(labelBytes, 0);
    buf[labelBytes.length] = 0;
    buf.set(raw, labelBytes.length + 1);
    const out = blake2b256(buf);
    return Array.from(out).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function restoreWalletFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const w = JSON.parse(raw);
      if (w && w.connected && w.pubkey && w.accountHash) {
        state.wallet = w;
        renderWalletButton();
      }
    } catch {}
  }

  /* ─────────────────── tabs ─────────────────── */
  const TABS = ['subs', 'build', 'sandbox', 'activity'];
  function selectTab(name) {
    if (!TABS.includes(name)) name = 'subs';
    TABS.forEach((t) => {
      const btn = document.getElementById('tab-btn-' + t);
      const pane = document.getElementById('tab-' + t);
      if (btn) btn.setAttribute('aria-selected', t === name ? 'true' : 'false');
      if (pane) pane.classList.toggle('active', t === name);
    });
    try { history.replaceState(null, '', '#' + name); } catch {}
  }
  function bindTabs() {
    TABS.forEach((t) => {
      const btn = document.getElementById('tab-btn-' + t);
      if (btn) btn.addEventListener('click', () => selectTab(t));
    });
    // Honor #hash on initial load.
    // Strip both /#tab and /#tab?x=y; hash with query is a real browser thing.
    const initial = (location.hash || '').replace(/^#/, '').split('?')[0].split('&')[0];
    if (initial && TABS.includes(initial)) selectTab(initial);
  }

  /* ─────────────────── keyboard shortcuts ─────────────────── */
  function bindKeyboard() {
    // Single-key nav: u=subscriptions, b=build, s=sandbox, a=activity, ?=help.
    // n=new sub. Escape closes any open modal. Ignored while typing.
    const KEYMAP = { u: 'subs', b: 'build', s: 'sandbox', a: 'activity' };
    document.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (typing) return;
      if (e.key === 'Escape') {
        const m = document.getElementById('explain-modal') || document.querySelector('[data-modal-overlay]');
        if (m) m.remove();
        return;
      }
      if (e.key === '?') { e.preventDefault(); toggleShortcutHelp(); return; }
      if (e.key === 'n') { const b = document.getElementById('new-sub-btn'); if (b) { e.preventDefault(); b.click(); } return; }
      const tab = KEYMAP[e.key.toLowerCase()];
      if (tab) { e.preventDefault(); selectTab(tab); }
    });
  }
  function toggleShortcutHelp() {
    let box = document.getElementById('kbd-help');
    if (box) { box.remove(); return; }
    box = document.createElement('div');
    box.id = 'kbd-help';
    box.style.cssText = 'position:fixed;right:22px;bottom:22px;z-index:9500;background:#000;color:#fff;border:1px solid #000;box-shadow:6px 6px 0 #bcfc07;padding:16px 18px;font:400 12.5px/1.7 \'JetBrains Mono\',monospace;min-width:230px';
    const rows = [['U', 'Subscriptions'], ['B', 'Build'], ['S', 'Sandbox'], ['A', 'Activity'], ['N', 'New subscription'], ['Esc', 'Close modal'], ['?', 'Toggle this help']];
    box.innerHTML = '<div style="font:500 11px \'JetBrains Mono\';color:#bcfc07;letter-spacing:.1em;margin-bottom:10px">KEYBOARD SHORTCUTS</div>' +
      rows.map(([k, v]) => '<div style="display:flex;justify-content:space-between;gap:16px"><span style="color:#bcfc07">' + k + '</span><span style="color:#ccc">' + v + '</span></div>').join('');
    document.body.appendChild(box);
    setTimeout(() => { if (box && box.parentNode) box.remove(); }, 6000);
  }

  /* ─────────────────── predicate builder (was on landing) ─────────────────── */
  const PB_FIELDS = ['amount', 'to_account_hash', 'initiator_account_hash', 'deploy_hash', 'block_height', 'transfer_index', 'from_purse', 'to_purse'];
  const PB_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with', 'ends_with', 'in', 'not_in', 'regex'];
  const PB_REFERENCE = {
    id: 0,
    deploy_hash: 'c60a4bfebc1ad5e6ac7272b0cc0a3ed93cc3a34335c049368db75e139b5711db',
    block_height: 8338998,
    transform_key: null,
    transfer_index: 0,
    initiator_account_hash: 'b383c7cc23d18bc1b42406a1b2d29fc8dba86425197b6f553d7fd61375b5e446',
    from_purse: 'uref-b06a1ab0cfb52b5d4f9a08b68a5dbe78e999de0b0484c03e64f5c03897cf637b-007',
    to_purse: 'uref-bf49d64c019420b4988804e02be96dd6be15331ba95537ef04d3e7e74db230fa-004',
    to_account_hash: 'dc725246306b8ebfb6623feca7f777c4e9f52c96691cdccf338b797480787c9c',
    amount: '5000000000000',
    timestamp: '2026-06-29T11:14:49.671Z',
  };
  const PB_RECIPES = [
    { key: 'whale-100k',  label: '🐋 ≥ 100k CSPR', predicate: { and: [{ field:'amount', op:'gte', value:'100000000000000' }] } },
    { key: 'whale-1m',    label: '🐋🐋 ≥ 1M CSPR', predicate: { and: [{ field:'amount', op:'gte', value:'1000000000000000' }] } },
    { key: 'micro',       label: '💸 < 10 CSPR',   predicate: { and: [{ field:'amount', op:'lt',  value:'10000000000' }] } },
    { key: 'round',       label: '🎯 round CSPR',  predicate: { and: [{ field:'amount', op:'ends_with', value:'000000000' }, { field:'amount', op:'gte', value:'5000000000' }] } },
    { key: 'to-treasury', label: '📥 to my acct',  predicate: { and: [{ field:'to_account_hash', op:'eq', value:'YOUR_ACCOUNT_HASH' }] } },
  ];
  const pbState = { rows: [
    { field: 'amount', op: 'gte', value: '1000000000000' },
    { field: 'to_account_hash', op: 'eq', value: 'dc725246306b8ebfb6623feca7f777c4e9f52c96691cdccf338b797480787c9c' },
  ], advanced: null /* nested predicate that the row UI can't represent */,
     baseline: null /* JSON-serialised snapshot of the loaded predicate, for diff */
  };
  function pbCoerceValue(op, raw) {
    if (op === 'in' || op === 'not_in') {
      return String(raw).split(',').map(s => s.trim()).filter(Boolean);
    }
    return String(raw);
  }
  function pbHasNested(predicate) {
    if (!predicate || !Array.isArray(predicate.and)) return false;
    return predicate.and.some((n) => n && (Array.isArray(n.or) || Array.isArray(n.and)));
  }
  function pbBuildPredicate() {
    if (pbState.advanced) return pbState.advanced;
    return { and: pbState.rows.map(r => ({ field: r.field, op: r.op, value: pbCoerceValue(r.op, r.value) })) };
  }
  // Rebuild a predicate from an untrusted source (the ?p= query seed) using only
  // allowlisted fields and operators, coercing every value to a bounded string.
  // Returns a fresh object so no attacker-controlled reference survives, or null.
  function pbSanitizePredicate(input) {
    if (!input || !Array.isArray(input.and)) return null;
    const okOp = new Set(Object.keys(OP_LABEL));
    const and = [];
    for (const c of input.and) {
      if (!c || !PB_FIELDS.includes(String(c.field)) || !okOp.has(String(c.op))) continue;
      const field = String(c.field);
      const op = String(c.op);
      const value = Array.isArray(c.value)
        ? c.value.slice(0, 64).map((v) => String(v).slice(0, 256))
        : String(c.value ?? '').slice(0, 256);
      and.push({ field, op, value });
    }
    return and.length ? { and } : null;
  }
  function pbAdoptPredicate(predicate, opts) {
    if (pbHasNested(predicate)) {
      pbState.advanced = predicate;
      pbState.rows = [];
    } else {
      pbState.advanced = null;
      pbState.rows = (predicate.and || []).map((c) => ({
        field: String(c.field), op: String(c.op),
        value: Array.isArray(c.value) ? c.value.join(',') : String(c.value),
      }));
    }
    // Snapshot the loaded predicate as a baseline for diff display. The user
    // can clear it (or the recipe-load path passes resetBaseline:true).
    if (!opts || opts.resetBaseline !== false) {
      pbState.baseline = JSON.stringify(predicate);
    }
  }
  function pbCondKey(c) {
    // Order-insensitive key, sort sub-values for `in`/`not_in` so order edits
    // don't show up as a diff.
    if (c && Array.isArray(c.value)) {
      const sorted = c.value.slice().sort();
      return JSON.stringify({ field: c.field, op: c.op, value: sorted });
    }
    return JSON.stringify(c);
  }
  function pbComputeDiff() {
    if (!pbState.baseline) return null;
    let base; try { base = JSON.parse(pbState.baseline); } catch { return null; }
    const cur = pbBuildPredicate();
    // Nested predicates: we don't try to per-node diff; just say "edited" if
    // the whole-thing JSON differs.
    if (pbHasNested(base) || pbHasNested(cur)) {
      const same = JSON.stringify(base) === JSON.stringify(cur);
      return { nested: true, added: [], removed: [], changed: [], same };
    }
    const baseConds = base.and || [];
    const curConds  = cur.and  || [];
    const baseKeys = new Set(baseConds.map(pbCondKey));
    const curKeys  = new Set(curConds.map(pbCondKey));
    const removed = baseConds.filter((c) => !curKeys.has(pbCondKey(c)));
    const added   = curConds.filter((c) => !baseKeys.has(pbCondKey(c)));
    // For each "removed", see if there's a matching field+op in "added", call
    // it a "changed" instead so the user sees what specifically moved.
    const changed = [];
    for (const r of removed.slice()) {
      const match = added.find((a) => a.field === r.field && a.op === r.op);
      if (match) {
        changed.push({ field: r.field, op: r.op, from: r.value, to: match.value });
        removed.splice(removed.indexOf(r), 1);
        added.splice(added.indexOf(match), 1);
      }
    }
    return { nested: false, added, removed, changed, same: added.length + removed.length + changed.length === 0 };
  }
  function pbRenderDiff() {
    const host = document.getElementById('pb-diff');
    if (!host) return;
    const d = pbComputeDiff();
    if (!d || d.same) { host.innerHTML = ''; host.style.display = 'none'; return; }
    host.style.display = '';
    if (d.nested) {
      host.innerHTML = `<div style="display:flex;align-items:center;gap:10px;padding:6px 12px;background:#fffbe6;border:1px solid #d4a700;font:500 11px 'JetBrains Mono';color:#000;letter-spacing:.06em">
        <span style="background:#d4a700;color:#000;padding:1px 7px;letter-spacing:.08em">DIFF</span>
        <span>advanced predicate edited, view JSON to compare</span>
        <span style="flex:1"></span>
        <button type="button" id="pb-diff-reset" style="background:#fff;border:1px solid #000;padding:3px 9px;font:500 10.5px 'JetBrains Mono';cursor:pointer">reset baseline</button>
      </div>`;
    } else {
      const chip = (label, count, bg, fg) => `<span style="background:${bg};color:${fg};padding:2px 8px;font:500 10.5px 'JetBrains Mono';letter-spacing:.06em">${label} ${count}</span>`;
      const fmtCond = (c) => `${escHtml(c.field)} ${escHtml(c.op)} ${escHtml(Array.isArray(c.value) ? c.value.join(',') : String(c.value)).slice(0, 36)}`;
      const detailRows = [
        ...d.added.map((c) => `<div style="color:#0a7c2c">+ ${fmtCond(c)}</div>`),
        ...d.removed.map((c) => `<div style="color:#c01515">− ${fmtCond(c)}</div>`),
        ...d.changed.map((c) => `<div style="color:#a45e00">~ ${escHtml(c.field)} ${escHtml(c.op)}: <span style="color:#c01515">${escHtml(String(c.from)).slice(0,24)}</span> → <span style="color:#0a7c2c">${escHtml(String(c.to)).slice(0,24)}</span></div>`),
      ].join('');
      host.innerHTML = `<div style="border:1px solid #000;background:#fafafa">
        <div style="display:flex;align-items:center;gap:10px;padding:6px 12px;border-bottom:1px solid #ddd;font:500 11px 'JetBrains Mono';color:#000;letter-spacing:.06em">
          <span style="background:#000;color:#bcfc07;padding:2px 8px;letter-spacing:.08em">DIFF</span>
          ${d.added.length    ? chip('+', d.added.length,    '#dcffe6', '#0a7c2c') : ''}
          ${d.removed.length  ? chip('−', d.removed.length,  '#ffe0e0', '#c01515') : ''}
          ${d.changed.length  ? chip('~', d.changed.length,  '#fff4d6', '#a45e00') : ''}
          <span style="flex:1"></span>
          <button type="button" id="pb-diff-toggle" style="background:#fff;border:1px solid #000;padding:3px 9px;font:500 10.5px 'JetBrains Mono';cursor:pointer">view</button>
          <button type="button" id="pb-diff-reset" style="background:#fff;border:1px solid #000;padding:3px 9px;font:500 10.5px 'JetBrains Mono';cursor:pointer">reset baseline</button>
        </div>
        <div id="pb-diff-detail" style="display:none;padding:10px 14px;font:500 11.5px/1.6 'JetBrains Mono';background:#fff">${detailRows}</div>
      </div>`;
      const t = document.getElementById('pb-diff-toggle');
      const det = document.getElementById('pb-diff-detail');
      if (t && det) t.addEventListener('click', () => { det.style.display = det.style.display === 'none' ? 'block' : 'none'; t.textContent = det.style.display === 'none' ? 'view' : 'hide'; });
    }
    const reset = document.getElementById('pb-diff-reset');
    if (reset) reset.addEventListener('click', () => { pbState.baseline = JSON.stringify(pbBuildPredicate()); pbRenderDiff(); });
  }
  function pbGetField(obj, path) {
    const parts = String(path).split('.');
    let cur = obj;
    for (const p of parts) { if (cur == null || typeof cur !== 'object') return undefined; cur = cur[p]; }
    return cur;
  }
  function pbCompareSingle(lhs, op, value) {
    const lstr = lhs == null ? '' : String(lhs);
    const isList = Array.isArray(value);
    if (op === 'contains')    return lstr.includes(String(value));
    if (op === 'starts_with') return lstr.startsWith(String(value));
    if (op === 'ends_with')   return lstr.endsWith(String(value));
    if (op === 'regex')       { try { return new RegExp(String(value)).test(lstr); } catch { return false } }
    if (op === 'in')          return isList && value.some(v => String(v) === lstr);
    if (op === 'not_in')      return isList && !value.some(v => String(v) === lstr);
    const lb = /^-?\d+$/.test(lstr) ? BigInt(lstr) : null;
    const rb = /^-?\d+$/.test(String(value)) ? BigInt(String(value)) : null;
    if (lb !== null && rb !== null) {
      if (op === 'eq')  return lb === rb;
      if (op === 'neq') return lb !== rb;
      if (op === 'gt')  return lb >  rb;
      if (op === 'gte') return lb >= rb;
      if (op === 'lt')  return lb <  rb;
      if (op === 'lte') return lb <= rb;
    }
    if (op === 'eq')  return lstr === String(value);
    if (op === 'neq') return lstr !== String(value);
    if (op === 'gt')  return lstr >  String(value);
    if (op === 'gte') return lstr >= String(value);
    if (op === 'lt')  return lstr <  String(value);
    if (op === 'lte') return lstr <= String(value);
    return false;
  }
  function pbEvaluate(predicate, event) {
    for (const c of (predicate.and || [])) {
      const v = pbGetField(event, c.field);
      if (v === undefined) return false;
      if (!pbCompareSingle(v, c.op, c.value)) return false;
    }
    return true;
  }
  function pbRender() {
    const rows = document.getElementById('pb-rows');
    if (!rows) return;
    rows.innerHTML = '';
    if (pbState.advanced) {
      const banner = document.createElement('div');
      banner.style.cssText = 'background:#fff4e6;border:1px solid #d4a700;padding:14px 16px;font:500 13px/1.5 \'Casper Sans\',Inter;color:#000';
      const orCount = (pbState.advanced.and || []).filter((n) => n && Array.isArray(n.or)).length;
      const andCount = (pbState.advanced.and || []).filter((n) => n && Array.isArray(n.and)).length;
      banner.innerHTML = '<div style="font:500 11px \'JetBrains Mono\';color:#000;letter-spacing:.1em;margin-bottom:8px">⚠ ADVANCED PREDICATE</div>'
        + 'This predicate uses ' + (orCount ? orCount + ' OR-group(s)' : '') + (orCount && andCount ? ' + ' : '')
        + (andCount ? andCount + ' nested AND-group(s)' : '')
        + (orCount + andCount === 0 ? 'nested groups' : '') + '. '
        + 'The row editor can\'t represent these yet, view the JSON on the right, copy CLI/use in new sub still works.'
        + '<div style="margin-top:10px"><button type="button" id="pb-reset" style="background:#fff;color:#000;border:1px solid #000;padding:6px 12px;font:500 11px \'Casper Sans\',Inter;cursor:pointer">Discard advanced predicate (start fresh)</button></div>';
      rows.appendChild(banner);
      const reset = document.getElementById('pb-reset');
      if (reset) reset.addEventListener('click', () => {
        pbState.advanced = null;
        pbState.rows = [{ field: 'amount', op: 'gte', value: '1000000000' }];
        pbRender();
      });
      pbUpdate();
      return;
    }
    pbState.rows.forEach((row, idx) => {
      const tr = document.createElement('div');
      tr.className = 'pb-row';
      const sf = document.createElement('select');
      PB_FIELDS.forEach(f => {
        const o = document.createElement('option');
        o.value = f;
        const label = FIELD_LABEL[f] || f;
        o.textContent = `${label}  (${f})`;
        if (f === row.field) o.selected = true;
        sf.appendChild(o);
      });
      const so = document.createElement('select');
      PB_OPS.forEach(op => {
        const o = document.createElement('option');
        o.value = op;
        const lbl = OP_LABEL[op];
        o.textContent = lbl ? `${lbl.sym}  ${lbl.word}` : op;
        if (op === row.op) o.selected = true;
        so.appendChild(o);
      });
      const iv = document.createElement('input');
      iv.value = row.value;
      iv.placeholder = (row.op === 'in' || row.op === 'not_in') ? 'comma,separated' : 'value';
      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'pb-rm'; rm.textContent = '✕'; rm.title = 'Remove condition';
      sf.addEventListener('change', () => { row.field = sf.value; pbUpdate(); });
      so.addEventListener('change', () => { row.op = so.value; iv.placeholder = (row.op === 'in' || row.op === 'not_in') ? 'comma,separated' : 'value'; pbUpdate(); });
      iv.addEventListener('input', () => { row.value = iv.value; pbUpdate(); });
      rm.addEventListener('click', () => { pbState.rows.splice(idx, 1); pbRender(); pbUpdate(); });
      tr.append(sf, so, iv, rm);
      rows.appendChild(tr);
    });
    pbUpdate();
  }
  function pbEvalNode(node, event) {
    if (node && Array.isArray(node.or)) return node.or.some((n) => pbEvalNode(n, event));
    if (node && Array.isArray(node.and)) return node.and.every((n) => pbEvalNode(n, event));
    if (!node || typeof node !== 'object' || !node.field) return false;
    const v = pbGetField(event, node.field);
    if (v === undefined) return false;
    return pbCompareSingle(v, node.op, node.value);
  }
  function pbEvalFull(predicate, event) {
    return (predicate.and || []).every((n) => pbEvalNode(n, event));
  }
  function pbUpdate() {
    const predicate = pbBuildPredicate();
    const json = document.getElementById('pb-json');
    if (json) json.textContent = JSON.stringify(predicate, null, 2);
    const ref = document.getElementById('pb-reference');
    if (ref && !ref.textContent) ref.textContent = JSON.stringify(PB_REFERENCE, null, 2);
    const verdict = document.getElementById('pb-verdict');
    if (verdict) {
      const ok = pbEvalFull(predicate, PB_REFERENCE);
      verdict.textContent = ok ? '✓ MATCHES' : '✕ NO MATCH';
      verdict.style.background = ok ? '#3edc64' : '#ff2d2e';
      verdict.style.color = ok ? '#00330f' : '#fff';
    }
    pbRenderDiff();
  }
  function pbBind() {
    if (!document.getElementById('pb-rows')) return;
    // Hydrate from ?p=base64 if present. The query string is attacker
    // controlled, so the decoded predicate is rebuilt field by field from the
    // known field and operator sets; anything not on the allowlist is dropped.
    try {
      const seed = new URLSearchParams(location.search).get('p');
      if (seed) {
        const clean = pbSanitizePredicate(JSON.parse(atob(decodeURIComponent(seed))));
        if (clean && clean.and.length) {
          pbAdoptPredicate(clean);
          selectTab('build');
        }
      }
    } catch {}
    pbRender();
    // Render reference once.
    const ref = document.getElementById('pb-reference');
    if (ref) ref.textContent = JSON.stringify(PB_REFERENCE, null, 2);
    // Recipe chips
    const grid = document.getElementById('pb-recipes');
    if (grid) {
      grid.innerHTML = '';
      PB_RECIPES.forEach((r) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.style.cssText = "background:#fff;border:1px solid #000;padding:8px 10px;font:500 12px 'JetBrains Mono';color:#000;cursor:pointer;text-align:left";
        b.textContent = r.label;
        b.addEventListener('click', () => {
          pbAdoptPredicate(r.predicate);
          pbRender();
        });
        grid.appendChild(b);
      });
    }
    document.getElementById('pb-add').addEventListener('click', () => { pbState.rows.push({ field: 'amount', op: 'gte', value: '0' }); pbRender(); });
    document.getElementById('pb-copy').addEventListener('click', () => {
      const p = pbBuildPredicate();
      const cli = `cat > predicate.json <<'EOF'\n${JSON.stringify(p, null, 2)}\nEOF\n\nexport SLUICE_CONTRACT_HASH=f3710eaf12c30346eb1c642da832bc1af8ff900254c46bcc49a1efca81d8b971\nexport SLUICE_KEY=~/keys/subscriber/secret_key.pem\nsluice subscribe --predicate ./predicate.json --webhook https://your.app/hook --amount 10 --watch`;
      copyToClipboard(cli, 'CLI snippet');
    });
    document.getElementById('pb-share').addEventListener('click', () => {
      const p = pbBuildPredicate();
      const url = `${location.origin}/app?p=${encodeURIComponent(btoa(JSON.stringify(p)))}#build`;
      copyToClipboard(url, 'Share link');
    });
    document.getElementById('pb-apply').addEventListener('click', () => {
      const p = pbBuildPredicate();
      openCreateModal(p);
      selectTab('subs');
    });
    document.getElementById('pb-dryrun').addEventListener('click', async () => {
      const out = document.getElementById('pb-dryrun-result');
      out.style.display = 'block';
      out.textContent = '… running against recent events …';
      try {
        const r = await fetch('/api/predicate/validate', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ predicate: pbBuildPredicate() }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        const ratio = j.total_scanned > 0 ? Math.round((j.matches / j.total_scanned) * 100) : 0;
        const rate = j.estimated_per_day == null ? 'window too short for /day estimate' : `~${j.estimated_per_day} matches/day`;
        const samples = (j.sample_matches || []).slice(0, 3).map((ev) =>
          `<div style="font:400 11px 'JetBrains Mono';color:#333;padding:2px 0">↳ ${ev.amount} motes → ${(ev.to_account_hash||'').slice(0,12)}…</div>`
        ).join('');
        out.innerHTML = `<div style="display:flex;align-items:baseline;gap:18px;flex-wrap:wrap">
            <div style="font:600 28px 'Casper Sans',Inter;color:#000">${j.matches}</div>
            <div style="color:#666">of ${j.total_scanned} scanned · ${ratio}% hit rate</div>
            <div style="flex:1"></div>
            <div style="font:500 11px 'JetBrains Mono';color:#000;letter-spacing:.06em">${rate}</div>
          </div>${samples ? '<div style="margin-top:10px;border-top:1px dashed #ccc;padding-top:8px">' + samples + '</div>' : ''}`;
      } catch (e) {
        out.innerHTML = `<div style="color:#ff2d2e">dry-run failed: ${escHtml(e.message || e)}</div>`;
      }
    });
    // ✨ AI input
    const aiInput = document.getElementById('pb-ai-input');
    const aiGo = document.getElementById('pb-ai-go');
    const aiStatus = document.getElementById('pb-ai-status');
    if (aiInput && aiGo) {
      const fire = async () => {
        const prompt = aiInput.value.trim();
        if (!prompt) { aiStatus.style.color = '#ff2d2e'; aiStatus.textContent = 'type a description first'; return; }
        const prev = aiGo.textContent; aiGo.disabled = true; aiGo.textContent = '… parsing';
        aiStatus.style.color = '#666'; aiStatus.textContent = '';
        try {
          const r = await fetch('/api/predicate/from-prompt', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ prompt }) });
          const j = await r.json();
          if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
          if (!j.predicate || !j.predicate.and || !j.predicate.and.length) {
            aiStatus.style.color = '#ff2d2e';
            aiStatus.textContent = 'couldn\'t understand, try: "over 100k cspr to <64-hex>"';
            return;
          }
          pbAdoptPredicate(j.predicate);
          pbRender();
          aiStatus.style.color = '#1a7f37';
          aiStatus.textContent = '✓ ' + (j.understood || []).slice(0,2).join(' · ') + (j.unknown && j.unknown.length ? '  (ignored: ' + j.unknown.length + ')' : '');
        } catch (e) {
          aiStatus.style.color = '#ff2d2e';
          aiStatus.textContent = 'failed: ' + (e.message || e);
        } finally {
          aiGo.disabled = false; aiGo.textContent = prev;
        }
      };
      aiGo.addEventListener('click', fire);
      aiInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') fire(); });
    }
  }

  /* ─────────────────── sandbox ─────────────────── */
  const SANDBOX_PREDICATES = {
    any: null,
    'whale-100k': { and: [{ field:'amount', op:'gte', value:'100000000000000' }] },
    'whale-1m':   { and: [{ field:'amount', op:'gte', value:'1000000000000000' }] },
    micro:        { and: [{ field:'amount', op:'lt',  value:'10000000000' }] },
    round:        { and: [{ field:'amount', op:'ends_with', value:'000000000' }, { field:'amount', op:'gte', value:'5000000000' }] },
  };
  function bindSandbox() {
    const wh = document.getElementById('sb-webhook');
    const rec = document.getElementById('sb-recipe');
    const cnt = document.getElementById('sb-count');
    const cntNum = document.getElementById('sb-count-num');
    const fireN = document.getElementById('sb-fire-n');
    const fire = document.getElementById('sb-fire');
    const out = document.getElementById('sb-results');
    if (!wh || !fire) return;
    // Pre-fill webhook URL with a hosted-receiver slug so the user can
    // click Fire immediately and see the result on /h/<slug>. Random suffix
    // avoids collisions across visitors.
    if (!wh.value) {
      const slug = 'sandbox-' + Math.random().toString(36).slice(2, 8);
      wh.value = '/api/hooks/' + slug;
      wh.title = 'POST will land in the hosted receiver at /h/' + slug + ', open it in another tab to watch live.';
    }
    if (cnt && cntNum) {
      cnt.addEventListener('input', () => { cntNum.textContent = cnt.value; if (fireN) fireN.textContent = cnt.value; });
    }
    fire.addEventListener('click', async () => {
      const webhook = wh.value.trim();
      if (!/^https?:\/\//i.test(webhook) && !webhook.startsWith('/api/hooks/')) {
        out.innerHTML = '<div style="color:#ff8a65">Webhook URL must start with http(s):// or /api/hooks/&lt;slug&gt;</div>';
        return;
      }
      // Allow /api/hooks/slug, expand to absolute on the matcher origin.
      const fullUrl = webhook.startsWith('/api/hooks/') ? location.origin + webhook : webhook;
      const predicate = SANDBOX_PREDICATES[rec.value] ?? null;
      const count = Number(cnt.value);
      const prev = fire.textContent; fire.disabled = true; fire.textContent = '… firing';
      out.innerHTML = '<div style="color:#666">… dispatching, hold on …</div>';
      try {
        const r = await fetch('/api/sandbox/dispatch', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ webhook: fullUrl, predicate, count }) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        const rows = (j.results || []).map((r, i) => {
          const color = r.ok ? '#3edc64' : '#ff8a65';
          const evHash = safeHash(r.event_hash);
          return `<div style="display:grid;grid-template-columns:32px 80px 90px 1fr;gap:10px;padding:6px 0;border-bottom:1px solid #1a1a1a">
            <span style="color:#666">#${i+1}</span>
            <span style="color:${color};font-weight:500">${Number(r.statusCode) || 'no-resp'}</span>
            <span style="color:#fff">${Number(r.latency_ms) || 0}ms</span>
            <span style="color:#aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${evHash}">${evHash.slice(0,16)}…</span>
          </div>`;
        }).join('');
        const slugMatch = fullUrl.match(/\/api\/hooks\/([a-z0-9-]+)/i);
        const slug = slugMatch ? escHtml(slugMatch[1]) : '';
        const peekLink = slug
          ? `<div style="margin-top:8px;color:#bcfc07;font:500 11px 'JetBrains Mono';letter-spacing:.04em">↳ peek the requests: <a href="/h/${slug}" target="_blank" style="color:#bcfc07;text-decoration:underline">/h/${slug}</a></div>`
          : '';
        out.innerHTML = `<div style="color:#bcfc07;font:500 12px 'JetBrains Mono';margin-bottom:10px">${Number(j.delivered) || 0}/${Number(j.requested) || 0} delivered · ${Number(j.matched_in_buffer) || 0} matched buffer · ${j.used_synthetic ? 'synthetic top-up used' : 'all real events'}</div>${rows}${peekLink}<div style="margin-top:12px;color:#666;font:500 11px 'JetBrains Mono';letter-spacing:.06em">NO CSPR SPENT · NO ON-CHAIN RECORD · SUB ID = 0</div>`;
      } catch (e) {
        out.innerHTML = `<div style="color:#ff2d2e">sandbox failed: ${escHtml(e.message || e)}</div>`;
      } finally {
        fire.disabled = false; fire.textContent = prev;
      }
    });
  }

  /* ─────────────────── activity tab (full feed) ─────────────────── */
  function renderActivityFull() {
    const list = document.getElementById('activity-list-full');
    if (!list) return;
    const events = (state.snapshot?.recent_events) || [];
    document.getElementById('activity-count').textContent = events.length;
    document.getElementById('tab-badge-activity').textContent = events.length;
    if (events.length === 0) {
      list.innerHTML = '<div style="padding:48px 22px;text-align:center;color:#666;font:400 14px Casper Sans,Inter">no deliveries in the matcher buffer yet · ring buffer is live-only, restarts wipe it</div>';
      return;
    }
    list.innerHTML = events.map((e, i) => {
      const code = Number(e.status) || 0;
      const status = code === 0 ? `<span style="background:#ffb347;color:#000;padding:2px 7px;font:500 10.5px 'JetBrains Mono';letter-spacing:.06em">PENDING</span>`
        : code >= 200 && code < 300 ? `<span style="background:#3edc64;color:#000;padding:2px 7px;font:500 10.5px 'JetBrains Mono';letter-spacing:.06em">${code}</span>`
        : `<span style="background:#ff2d2e;color:#fff;padding:2px 7px;font:500 10.5px 'JetBrains Mono';letter-spacing:.06em">${code}</span>`;
      const hash = safeHash(e.tx_hash);
      const tx = hash ? `<a href="https://testnet.cspr.live/deploy/${hash}" target="_blank" rel="noopener" style="color:#1a56c4;text-decoration:none" onclick="event.stopPropagation()">${hash.slice(0,16)}…</a>` : '<span style="color:#999">…</span>';
      return `<div data-act-idx="${i}" class="act-row" title="Click to see condition-by-condition why this matched" style="display:grid;grid-template-columns:130px 70px 70px 80px 1fr 220px;gap:14px;padding:14px 22px;border-bottom:1px solid #eee;align-items:center;font:400 12.5px 'JetBrains Mono';cursor:pointer">
        <span style="color:#666">${escHtml(String(e.timestamp || '').substr(11,8))} <span style="color:#999">UTC</span></span>
        <span style="color:#000;font-weight:500">sub_${Number(e.subscription_id) || 0}</span>
        ${status}
        <span style="color:#000">${Number(e.latency_ms) || 0}ms</span>
        <span style="color:#333">${escHtml(String(e.description || '').slice(0,80))}</span>
        <span>${tx}</span>
      </div>`;
    }).join('');
    // attach click → explain
    list.querySelectorAll('.act-row').forEach((row) => {
      row.addEventListener('mouseenter', () => { row.style.background = '#fafafa'; });
      row.addEventListener('mouseleave', () => { row.style.background = ''; });
      row.addEventListener('click', () => {
        const idx = Number(row.getAttribute('data-act-idx'));
        const evt = events[idx];
        if (evt) openExplain(evt);
      });
    });
  }

  /* ─────────────────── explain modal ─────────────────── */
  function escHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
  function safeHash(h) { const s = String(h ?? ''); return /^[0-9a-f]{64}$/i.test(s) ? s : ''; }
  function fmtVal(v, field) {
    if (Array.isArray(v)) return `[${v.length} addresses]`;
    if (v == null) return '<missing>';
    const s = String(v);
    if (field === 'amount' && /^\d+$/.test(s)) {
      try { const n = BigInt(s); const c = n / 1_000_000_000n; if (c >= 1n) return `${c.toLocaleString('en-US')} CSPR <span style="color:#666">(${n.toLocaleString('en-US')} motes)</span>`; } catch {}
    }
    if (/^[0-9a-f]{64}$/i.test(s)) return s.slice(0, 12) + '…' + s.slice(-6);
    return escHtml(s.length > 80 ? s.slice(0, 76) + '…' : s);
  }
  function openExplain(evt) {
    let modal = document.getElementById('explain-modal');
    let liveWs = null;
    const closeAll = () => {
      if (liveWs) { try { liveWs.close(); } catch {} liveWs = null; }
      if (modal) modal.remove();
    };
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'explain-modal';
      modal.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.7);overflow-y:auto;padding:24px 16px;display:flex;align-items:flex-start;justify-content:center';
      modal.addEventListener('click', (e) => { if (e.target === modal) closeAll(); });
      document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { closeAll(); document.removeEventListener('keydown', esc); } });
      document.body.appendChild(modal);
    }
    const subs = (state.snapshot?.subscriptions) || [];
    const sub = subs.find((s) => s.id === evt.subscription_id);
    modal.innerHTML = `<div style="background:#fff;border:1px solid #000;box-shadow:8px 8px 0 #bcfc07;max-width:1080px;width:100%;margin-top:32px;display:grid;grid-template-columns:1fr 280px">
      <div style="grid-column:1/-1;padding:18px 24px;border-bottom:1px solid #000;display:flex;align-items:center;gap:14px">
        <div style="font:500 11px 'JetBrains Mono';color:#bcfc07;background:#000;padding:4px 10px;letter-spacing:.1em">EXPLAIN</div>
        <div style="font:500 16px 'Casper Sans',Inter;color:#000">Why sub_${Number(evt.subscription_id) || 0} matched this event</div>
        <div style="flex:1"></div>
        <button type="button" id="explain-close" aria-label="close" style="background:#000;color:#fff;border:1px solid #000;width:32px;height:32px;font:500 18px 'JetBrains Mono';cursor:pointer">×</button>
      </div>
      <div style="grid-column:1/-1;padding:20px 24px;display:grid;grid-template-columns:1fr 1fr;gap:20px;background:#fafafa;border-bottom:1px solid #ddd">
        <div>
          <div style="font:500 10.5px 'JetBrains Mono';color:#666;letter-spacing:.1em;text-transform:uppercase;margin-bottom:8px">EVENT</div>
          <div style="font:500 12.5px/1.6 'JetBrains Mono';color:#000">amount: ${fmtVal(evt.event?.amount, 'amount')}</div>
          <div style="font:500 12.5px/1.6 'JetBrains Mono';color:#000">to: ${fmtVal(evt.event?.to_account_hash)}</div>
          <div style="font:500 12.5px/1.6 'JetBrains Mono';color:#000">from: ${fmtVal(evt.event?.initiator_account_hash)}</div>
          <div style="font:500 12.5px/1.6 'JetBrains Mono';color:#000">block: ${Number.isFinite(Number(evt.event?.block_height)) ? Number(evt.event.block_height) : '…'}</div>
        </div>
        <div>
          <div style="font:500 10.5px 'JetBrains Mono';color:#666;letter-spacing:.1em;text-transform:uppercase;margin-bottom:8px">DELIVERY</div>
          <div style="font:500 12.5px/1.6 'JetBrains Mono';color:#000">status: ${Number(evt.status) || 'pending'}</div>
          <div style="font:500 12.5px/1.6 'JetBrains Mono';color:#000">latency: ${Number(evt.latency_ms) || 0} ms</div>
          <div style="font:500 12.5px/1.6 'JetBrains Mono';color:#000">attempts: ${Number(evt.attempts) || 1}</div>
          ${safeHash(evt.tx_hash) ? `<div style="font:500 12.5px/1.6 'JetBrains Mono';color:#000">on-chain: <a href="https://testnet.cspr.live/deploy/${safeHash(evt.tx_hash)}" target="_blank" rel="noopener" style="color:#1a56c4;text-decoration:none">${safeHash(evt.tx_hash).slice(0,16)}…</a></div>` : ''}
        </div>
      </div>
      <div id="explain-body" style="padding:24px;min-height:240px;font:400 14px 'Casper Sans',Inter;color:#666;border-right:1px solid #ddd">running predicate/explain…</div>
      <aside id="explain-live" style="padding:18px;background:#fafafa;min-height:240px;display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;align-items:center;gap:8px"><span id="explain-live-dot" style="width:8px;height:8px;background:#999;border-radius:50%"></span><span style="font:500 10.5px 'JetBrains Mono';color:#000;letter-spacing:.1em">MORE LIKE THIS · LIVE</span></div>
        <div style="font:400 11px/1.4 'JetBrains Mono';color:#666">New deliveries to sub_${Number(evt.subscription_id) || 0} appear here as the matcher dispatches them.</div>
        <div id="explain-live-list" style="display:flex;flex-direction:column;gap:8px;margin-top:6px;flex:1"></div>
      </aside>
    </div>`;
    document.getElementById('explain-close').addEventListener('click', closeAll);
    if (!sub || !sub.predicate) {
      document.getElementById('explain-body').innerHTML = '<div style="color:#ff2d2e;font:500 12px \'JetBrains Mono\'">subscription ' + (Number(evt.subscription_id) || 0) + ' no longer in matcher view, cannot resolve predicate</div>';
      return;
    }
    fetch('/api/predicate/explain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ predicate: sub.predicate, event: evt.event }),
    }).then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        const body = document.getElementById('explain-body');
        if (!body) return;
        if (!ok) { body.innerHTML = '<div style="color:#ff2d2e;font:500 12px \'JetBrains Mono\'">explain HTTP error: ' + escHtml(j.error || JSON.stringify(j)) + '</div>'; return; }
        body.innerHTML = renderExplain(j);
      })
      .catch((e) => { const body = document.getElementById('explain-body'); if (body) body.innerHTML = '<div style="color:#ff2d2e">' + escHtml(e.message || String(e)) + '</div>'; });

    // Connect to /api/stream for live "MORE LIKE THIS" deliveries
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = proto + '//' + location.host + '/api/stream?sub=' + evt.subscription_id;
      const ws = new WebSocket(wsUrl);
      liveWs = ws;
      const dot = document.getElementById('explain-live-dot');
      const list = document.getElementById('explain-live-list');
      ws.addEventListener('open', () => { if (dot) { dot.style.background = '#bcfc07'; dot.style.boxShadow = '0 0 0 4px rgba(188,252,7,.25)'; } });
      ws.addEventListener('close', () => { if (dot) { dot.style.background = '#666'; dot.style.boxShadow = ''; } });
      ws.addEventListener('error', () => { if (dot) { dot.style.background = '#ff2d2e'; dot.style.boxShadow = ''; } });
      ws.addEventListener('message', (msg) => {
        if (!list) return;
        let env;
        try { env = JSON.parse(msg.data); } catch { return; }
        if (!env || env.type !== 'delivery') return;
        const e = env.data;
        if (!e || e.event_hash === evt.event_hash) return; // skip the seed event itself
        const amt = fmtVal(e.event?.amount, 'amount');
        const ago = e.timestamp ? (() => { const dt = Math.max(0, Date.now() - new Date(e.timestamp).getTime()); if (dt < 5000) return 'just now'; if (dt < 60000) return Math.floor(dt/1000)+'s ago'; return Math.floor(dt/60000)+'m ago'; })() : '';
        const card = document.createElement('div');
        card.style.cssText = "background:#fff;border:1px solid #000;padding:8px 10px;font:500 11px/1.45 'JetBrains Mono';color:#000;cursor:pointer";
        const code = Number(e.status) || 0;
        const status = code >= 200 && code < 300 ? '#3edc64' : code === 0 ? '#ffb347' : '#ff2d2e';
        card.innerHTML = `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px"><span style="background:${status};color:#000;padding:1px 5px;font-size:9.5px;letter-spacing:.06em">${code || 'PEND'}</span><span style="flex:1;color:#666">${escHtml(ago)}</span><span style="color:#666">${Number(e.latency_ms) || 0}ms</span></div>` +
          `<div style="color:#000">${amt}</div>` +
          `<div style="color:#999;font-size:10px;margin-top:2px">→ ${fmtVal(e.event?.to_account_hash)}</div>`;
        card.addEventListener('click', () => { closeAll(); setTimeout(() => openExplain(e), 50); });
        // animate in
        card.style.opacity = '0';
        card.style.transform = 'translateY(-4px)';
        card.style.transition = 'opacity .25s, transform .25s';
        list.insertBefore(card, list.firstChild);
        requestAnimationFrame(() => { card.style.opacity = '1'; card.style.transform = 'none'; });
        // cap at 5
        while (list.children.length > 5) list.removeChild(list.lastChild);
      });
    } catch (e) {
      const list = document.getElementById('explain-live-list');
      if (list) list.innerHTML = '<div style="color:#ff2d2e;font:500 11px \'JetBrains Mono\'">WS unavailable: ' + escHtml((e && e.message) || String(e)) + '</div>';
    }
  }
  function renderExplain(j) {
    const trace = j.trace || [];
    const groups = {};  // group prefix → trace[]
    for (const s of trace) {
      const g = s.group || 'and[0]';
      // group key = parent dotted path WITHOUT leaf index
      const parent = g.replace(/\.(or|and)\[\d+\]$/, '');
      const op = (g.match(/\.(or|and)\[\d+\]$/) || [])[1] || 'and';
      const key = parent + '|' + op;
      (groups[key] = groups[key] || { op, parent, steps: [] }).steps.push(s);
    }
    const groupKeys = Object.keys(groups);
    const inner = groupKeys.map((k) => {
      const g = groups[k];
      const allPass = g.steps.every((s) => s.pass);
      const headerColor = allPass ? '#bcfc07' : '#ffd6d6';
      const headerText = g.op === 'or' ? 'ANY OF (OR)' : 'ALL OF (AND)';
      const passSummary = g.op === 'or'
        ? (g.steps.some((s) => s.pass) ? '✓ at least one matched' : '✗ none matched')
        : (allPass ? '✓ all matched' : `✗ ${g.steps.filter((s) => !s.pass).length} failed`);
      return `<div style="margin-top:12px;border:1px solid #000">
        <div style="background:${headerColor};padding:8px 14px;font:500 11px 'JetBrains Mono';letter-spacing:.08em;display:flex;align-items:center;gap:14px">
          <span>${headerText}</span>
          <span style="flex:1;color:#000;font-weight:400">${passSummary}</span>
          <span style="color:#666;font-weight:400">${g.parent}</span>
        </div>
        ${g.steps.map((s) => {
          const glyph = s.pass ? '<span style="color:#1a7f37;font:500 14px \'JetBrains Mono\'">✓</span>' : '<span style="color:#ff2d2e;font:500 14px \'JetBrains Mono\'">✗</span>';
          const bg = s.pass ? '#fff' : '#fff8f8';
          return `<div style="display:grid;grid-template-columns:24px 170px 70px 1fr;gap:12px;padding:10px 14px;border-top:1px solid #eee;align-items:baseline;background:${bg}">
            ${glyph}
            <span style="font:500 12.5px 'JetBrains Mono';color:#000">${escHtml(s.field)}</span>
            <span style="font:500 11px 'JetBrains Mono';color:#bcfc07;background:#000;padding:2px 7px;display:inline-block;width:fit-content;letter-spacing:.06em;text-transform:uppercase">${escHtml(s.op)}</span>
            <span style="font:400 12.5px/1.5 'JetBrains Mono';color:#333;overflow-wrap:anywhere">${fmtVal(s.actual, s.field)} <span style="color:#999">vs</span> ${fmtVal(s.expected, s.field)}</span>
          </div>`;
        }).join('')}
      </div>`;
    }).join('');
    const verdict = j.match ? '<span style="background:#3edc64;color:#000;padding:4px 12px;font:500 12px \'JetBrains Mono\';letter-spacing:.08em">✓ MATCHED</span>'
                            : '<span style="background:#ff2d2e;color:#fff;padding:4px 12px;font:500 12px \'JetBrains Mono\';letter-spacing:.08em">✗ NO MATCH</span>';
    return `<div style="display:flex;align-items:center;gap:14px;margin-bottom:6px">${verdict} <span style="font:500 12px 'JetBrains Mono';color:#666;letter-spacing:.06em">${j.conditions_passed}/${j.conditions_total} conditions passed</span></div>${inner}`;
  }

  /* ─────────────────── badges & wiring ─────────────────── */
  function updateTabBadges() {
    const subs = (state.snapshot?.subscriptions) || [];
    const badge = document.getElementById('tab-badge-subs');
    if (badge) badge.textContent = String(subs.filter(s => s.active).length);
  }

  function bindReveals() {
    const nodes = document.querySelectorAll('[data-reveal]');
    if (!nodes.length) return;
    if (!('IntersectionObserver' in window)) { nodes.forEach(n => n.classList.add('revealed')); return; }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { e.target.classList.add('revealed'); io.unobserve(e.target); }
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    nodes.forEach((n) => io.observe(n));
  }
  document.addEventListener('DOMContentLoaded', () => {
    bindTabs();
    bindToolbar();
    restoreWalletFromStorage();
    renderWalletButton();
    setupCsprClick();
    bindX402();
    pbBind();
    bindSandbox();
    bindReveals();
    bindKeyboard();
    $('#new-sub-btn').addEventListener('click', () => openCreateModal());
    $('#topup-btn').addEventListener('click', () => {
      const subs = state.snapshot?.subscriptions || [];
      const active = subs.filter(s => s.active);
      if (active.length === 0) { toast('No active subscription to top up', 'warn'); return; }
      if (active.length === 1) openTopUpModal(active[0]);
      else toast('Open a subscription from the list and use its ⋯ menu', 'info');
    });
    $('#copy-mcp').addEventListener('click', () => copyToClipboard('https://sluice.unitynodes.com/mcp', 'MCP endpoint'));
    startPolling();
  });
})();
