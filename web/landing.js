/* Sluice landing, populates the hero terminal, numbers strip, and
 * transparency "Last record_delivery deploys" block from the live matcher
 * snapshot at /api/snapshot.json. Vanilla JS, no framework.
 */
(() => {
  'use strict';
  const POLL_MS = 8000;
  const FRESH_MS = 90_000; // anything newer than this counts as "live"
  const $ = (id) => document.getElementById(id);

  const motesToCspr = (m) => {
    try { return Number(BigInt(String(m)) / 1_000_000_000n); }
    catch { return 0; }
  };
  const fmtRel = (iso) => {
    if (!iso) return '…';
    const dt = Date.now() - new Date(iso).getTime();
    if (dt < 5_000) return 'just now';
    if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
    if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
    return `${Math.floor(dt / 3_600_000)}h ago`;
  };
  const trunc = (s, head = 4, tail = 4) => {
    if (!s) return '…';
    if (s.length <= head + tail + 1) return s;
    return s.slice(0, head) + '…' + s.slice(-tail);
  };
  const setStatus = ({ ok, label, ratePerMin }) => {
    const heroStatus = $('hero-status');
    const heroDot = $('hero-status-dot');
    if (heroStatus) {
      heroStatus.lastChild.textContent = ' ' + label + (ratePerMin != null ? ` · ${ratePerMin}/MIN` : '');
      if (heroDot) heroDot.style.background = ok ? '#3edc64' : '#ff2d2e';
    }
    const fs = $('footer-status');
    const fd = $('footer-status-dot');
    if (fs) {
      fs.lastChild.textContent = ok ? 'MATCHER OPERATIONAL · CONTRACT LIVE' : 'MATCHER OFFLINE';
      fs.style.color = ok ? '#3edc64' : '#ff2d2e';
      if (fd) fd.style.background = ok ? '#3edc64' : '#ff2d2e';
    }
  };

  function renderNumbers(snap, events) {
    const subs = snap.subscriptions || [];
    const totalDeliveries = subs.reduce((a, s) => a + (s.deliveries || 0), 0);
    const active = subs.filter(s => s.active).length;
    const ok = events.filter(e => e.status >= 200 && e.status < 300).length;
    const successPct = events.length ? (ok / events.length * 100).toFixed(1) : null;
    const latencies = events.map(e => e.latency_ms).filter(n => typeof n === 'number');
    const p50 = latencies.length ? latencies.slice().sort((a, b) => a - b)[Math.floor(latencies.length / 2)] : null;

    if ($('ns-delivered')) $('ns-delivered').textContent = totalDeliveries.toLocaleString('en-US');
    if ($('ns-active'))    $('ns-active').textContent    = active.toLocaleString('en-US');
    if ($('ns-success')) {
      $('ns-success').textContent = successPct != null ? successPct : '…';
      $('ns-success-suffix').textContent = successPct != null ? '%' : '';
    }
    if ($('ns-latency')) {
      $('ns-latency').textContent = p50 != null ? p50.toString() : '…';
      $('ns-latency-suffix').textContent = p50 != null ? 'ms' : '';
    }
    // Fallback to lifetime Prometheus counters when the in-memory recent buffer
    // is empty (typical right after a matcher restart). Best-effort.
    if (!events.length) renderNumbersFromMetrics();
  }

  async function renderNumbersFromMetrics() {
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
      if (total > 0 && $('ns-success')) {
        $('ns-success').textContent = ((ok / total) * 100).toFixed(1);
        $('ns-success-suffix').textContent = '%';
      }
      // p50 from the histogram, find smallest bucket whose cumulative ≥ 0.5
      const buckets = ['10','25','50','100','250','500','1000','2500','5000','10000'];
      const totalLat = grab('sluice_webhook_latency_ms_count') ?? 0;
      if (totalLat > 0 && $('ns-latency')) {
        let cum = 0;
        let p50bucket = '+Inf';
        for (const b of buckets) {
          cum = grab(`sluice_webhook_latency_ms_bucket{le="${b}"}`) ?? cum;
          if (cum >= totalLat * 0.5) { p50bucket = '≤' + b; break; }
        }
        $('ns-latency').textContent = p50bucket;
        $('ns-latency-suffix').textContent = '';
      }
    } catch { /* leave dashes */ }
  }

  /* Synthetic delivery events shown when the matcher has no real recent
     deliveries yet. Cycle through them so the terminal feels alive without
     misrepresenting live state, each row is stamped DEMO. */
  const DEMO_EVENTS = [
    { subscription_id: 3, description: 'Transfer · 12,500 CSPR → dc7252…787c9c', channel: 'webhook',   status: 200, latency_ms: 108 },
    { subscription_id: 7, description: 'Transfer · 250,000 CSPR → ecf442…4e73',   channel: 'mcp',       status: 200, latency_ms: 141 },
    { subscription_id: 3, description: 'Transfer · 4,200 CSPR → dc7252…787c9c',   channel: 'websocket', status: 200, latency_ms: 96  },
    { subscription_id: 12,description: 'Transfer · 100,000 CSPR → 8b31a2…c009',   channel: 'webhook',   status: 200, latency_ms: 122 },
    { subscription_id: 7, description: 'Transfer · 500,000 CSPR → ecf442…4e73',   channel: 'mcp',       status: 200, latency_ms: 133 },
  ];
  let _demoTimer = null;
  function startDemoTerminalCycle() {
    if (_demoTimer) return;
    let head = 0;
    const tick = () => {
      const now = Date.now();
      const buf = DEMO_EVENTS.map((e, k) => ({
        ...e,
        event_hash: 'demo-' + (head + k),
        timestamp: new Date(now - k * 3200 - (head % 6) * 900).toISOString(),
        _demo: true,
      }));
      renderTerminal(buf);
      head++;
    };
    tick();
    _demoTimer = setInterval(tick, 3200);
  }
  function stopDemoTerminalCycle() {
    if (_demoTimer) { clearInterval(_demoTimer); _demoTimer = null; }
  }

  function renderTerminal(events) {
    const root = $('live-rows');
    if (!root) return;
    if (events.length === 0) {
      startDemoTerminalCycle();
      return;
    }
    // Have real events. Kill the demo cycle if it was running.
    if (!events[0]._demo) stopDemoTerminalCycle();
    root.innerHTML = '';
    const opacities = [1, 1, 1, 0.78, 0.55, 0.35];
    events.slice(0, 6).forEach((e, i) => {
      const status = e.status || 0;
      const ok = status >= 200 && status < 300;
      const isLatest = i === 0;
      const time = new Date(e.timestamp).toISOString().substr(11, 8);
      const row = document.createElement('div');
      row.setAttribute('style',
        `display:grid;grid-template-columns:72px 70px 1fr 88px;gap:12px;padding:11px 18px;align-items:center;` +
        (isLatest
          ? 'background:#bcfc07;color:#000;border-left:3px solid #000'
          : `border-top:1px solid #1a1a1a;opacity:${opacities[i] ?? 0.25}`)
      );
      const cell = (txt, style = '') => {
        const c = document.createElement('div');
        if (style) c.setAttribute('style', style);
        c.textContent = txt;
        return c;
      };
      row.appendChild(cell(time, isLatest ? '' : 'color:#666'));
      row.appendChild(cell(`sub_${String(e.subscription_id).padStart(4, '0')}`, isLatest ? 'font-weight:500' : 'color:#3edc64'));
      // Event cell shows description plus a channel tag (webhook / mcp / websocket)
      const evtCell = document.createElement('div');
      evtCell.setAttribute('style', isLatest ? '' : 'color:#ccc');
      const desc = document.createElement('span');
      desc.textContent = e.description || `delivery ${trunc(e.event_hash, 6, 4)}`;
      evtCell.appendChild(desc);
      if (e.channel) {
        const chip = document.createElement('span');
        chip.textContent = e.channel.toUpperCase();
        chip.setAttribute('style', 'margin-left:8px;font:500 9px JetBrains Mono;letter-spacing:.1em;padding:1px 5px;' +
          (isLatest ? 'background:#000;color:#bcfc07' : 'background:#1a1a1a;color:#888'));
        evtCell.appendChild(chip);
      }
      if (e._demo) {
        const demo = document.createElement('span');
        demo.textContent = 'DEMO';
        demo.setAttribute('style', 'margin-left:6px;font:500 9px JetBrains Mono;letter-spacing:.1em;padding:1px 5px;' +
          (isLatest ? 'background:#000;color:#fff' : 'background:#3a1a1a;color:#ffb347'));
        evtCell.appendChild(demo);
      }
      row.appendChild(evtCell);
      row.appendChild(cell(ok ? `${status} · ${e.latency_ms ?? '?'}ms` : `${status || 'FAIL'} · retry ${e.attempts ?? '?'}`, `text-align:right;font-size:10px;${isLatest ? 'font-weight:500' : (ok ? 'color:#3edc64' : 'color:#ff2d2e')}`));
      root.appendChild(row);
    });
  }

  function renderDeploys(events, contractHash) {
    const root = $('live-deploys');
    if (!root) return;
    if (events.length === 0) {
      root.innerHTML = '<div style="padding:18px 0;color:#666;font:400 13px Casper Sans,Inter;text-align:center">Waiting for the next delivery…</div>';
      return;
    }
    root.innerHTML = '';
    events.slice(0, 5).forEach((e, i) => {
      const isLast = i === Math.min(events.length, 5) - 1;
      const wrap = document.createElement('div');
      wrap.setAttribute('style', `display:grid;grid-template-columns:80px 1fr 100px;gap:14px;padding:14px 0;${isLast ? '' : 'border-bottom:1px solid #ccc;'}align-items:center;font:400 14px;color:#000`);
      wrap.appendChild(Object.assign(document.createElement('div'), { textContent: fmtRel(e.timestamp).toUpperCase(), style: 'font:500 12px JetBrains Mono;color:#666' }));
      const mid = document.createElement('div');
      const a = document.createElement('a');
      a.href = e.tx_hash ? `https://testnet.cspr.live/transaction/${e.tx_hash}` : `https://testnet.cspr.live/contract-package/${contractHash}?tab=events`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.setAttribute('style', 'font:500 14px JetBrains Mono;color:#4589f6;text-decoration:none');
      a.textContent = e.tx_hash ? trunc(e.tx_hash, 4, 4) : 'demo lane, no escrow to bill';
      mid.appendChild(a);
      mid.appendChild(document.createTextNode(` · sub_${String(e.subscription_id).padStart(4, '0')}`));
      wrap.appendChild(mid);
      // Three states, not two. A 2xx webhook with no receipt is a successful
      // delivery on an off-chain demo lane, not a failure. Only a non-2xx
      // response is a failure.
      const delivered = e.status >= 200 && e.status < 300;
      const onChain = delivered && !!e.tx_hash;
      const colour = !delivered ? '#ff2d2e' : onChain ? '#3edc64' : '#666';
      const label = !delivered ? '✕ FAILED' : onChain ? '✓ CONFIRMED' : '✓ DELIVERED';
      const status = document.createElement('div');
      status.setAttribute('style', `text-align:right;font:500 11px JetBrains Mono;color:${colour};letter-spacing:.04em`);
      status.textContent = label;
      wrap.appendChild(status);
      root.appendChild(wrap);
    });
  }

  async function tick() {
    try {
      const r = await fetch(`/api/snapshot.json?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const snap = await r.json();
      const events = snap.recent_events || [];
      const updatedAt = new Date(snap.updated_at).getTime();
      const fresh = Date.now() - updatedAt < FRESH_MS;
      // Rate calculation: events per minute over the last 10 events.
      let ratePerMin = null;
      if (events.length >= 2) {
        const tEnd = new Date(events[0].timestamp).getTime();
        const tStart = new Date(events[events.length - 1].timestamp).getTime();
        const spanMin = Math.max(1, (tEnd - tStart) / 60_000);
        ratePerMin = Math.round(events.length / spanMin);
      }
      setStatus({ ok: fresh, label: fresh ? 'MATCHER ONLINE' : 'MATCHER STALE', ratePerMin });
      renderNumbers(snap, events);
      renderTerminal(events);
      renderDeploys(events, snap.contract_hash);
      const window = $('hero-window');
      if (window) window.textContent = `↑ LAST UPDATED ${fmtRel(snap.updated_at).toUpperCase()}`;
    } catch (e) {
      setStatus({ ok: false, label: 'MATCHER OFFLINE' });
    }
  }

  /* ─────────────────── recipe gallery ─────────────────── */
  function bindRecipes() {
    document.querySelectorAll('.recipe').forEach((card) => {
      const cli = card.dataset.cli;
      const predicate = card.dataset.predicate;
      const btn = card.querySelector('.copy-recipe');
      if (!btn || !cli || !predicate) return;
      // Inject "Open in builder ↗" link next to the copy button.
      if (!card.querySelector('.open-in-builder')) {
        const link = document.createElement('a');
        link.className = 'open-in-builder';
        link.href = `/app?p=${encodeURIComponent(btoa(predicate))}#build`;
        link.innerHTML = 'Tweak in builder <span style="font:500 12px \'JetBrains Mono\'">↗</span>';
        link.title = 'Load this predicate into the workspace Build tab so you can edit it';
        link.style.cssText = "display:inline-flex;align-items:center;gap:6px;font:500 11.5px 'JetBrains Mono';color:#000;text-decoration:none;letter-spacing:.04em;text-transform:uppercase;padding-bottom:2px;border-bottom:1px solid #000;align-self:flex-start";
        btn.parentElement.insertBefore(link, btn);
      }
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const fullSnippet =
`# save the predicate
cat > predicate.json <<'EOF'
${JSON.stringify(JSON.parse(predicate), null, 2)}
EOF

# subscribe (matcher key + contract from .env)
${cli}`.replace(/\.\/[a-z0-9-]+\.json/i, './predicate.json');
        try {
          await navigator.clipboard.writeText(fullSnippet);
          // New markup: btn has [<span.recipe-cta-label>, <span.recipe-cta-slug>].
          // Legacy markup: firstChild is a text node.
          const labelEl = btn.querySelector('.recipe-cta-label') || btn.firstChild;
          const prev = labelEl.textContent != null ? labelEl.textContent : labelEl.nodeValue;
          const setLabel = (v) => { if (labelEl.nodeValue !== undefined && labelEl.nodeType === 3) labelEl.nodeValue = v; else labelEl.textContent = v; };
          setLabel('✓ COPIED · paste in shell');
          btn.style.background = '#3edc64';
          btn.style.color = '#000';
          setTimeout(() => {
            setLabel(prev);
            // Restore CTA colours (new design: black bg / white fg for all cards).
            btn.style.background = '';
            btn.style.color = '';
          }, 1800);
        } catch (e) {
          alert('Clipboard blocked. CLI:\n\n' + fullSnippet);
        }
      });
      // Card hover affordance
      card.addEventListener('mouseenter', () => { card.style.background = '#fafafa'; });
      card.addEventListener('mouseleave', () => { card.style.background = '#fff'; });
    });
  }

  /* ─────────────────── predicate playground ─────────────────── */
  const PB_FIELDS = [
    { name: 'amount', desc: 'transfer amount in motes (1 CSPR = 1e9)', sample: '5000000000000' },
    { name: 'to_account_hash', desc: 'recipient account hash (64-hex)', sample: 'dc725246306b8ebfb6623feca7f777c4e9f52c96691cdccf338b797480787c9c' },
    { name: 'initiator_account_hash', desc: 'sender account hash', sample: 'b383c7cc23d18bc1b42406a1b2d29fc8dba86425197b6f553d7fd61375b5e446' },
    { name: 'deploy_hash', desc: '64-hex tx hash', sample: 'c60a4bfebc1ad5e6ac7272b0cc0a3ed93cc3a34335c049368db75e139b5711db' },
    { name: 'block_height', desc: 'block this transfer landed in', sample: '8338998' },
    { name: 'transfer_index', desc: 'index within deploy', sample: '0' },
    { name: 'from_purse', desc: 'source purse uref', sample: 'uref-b06a…007' },
    { name: 'to_purse', desc: 'dest purse uref', sample: 'uref-bf49…004' },
  ];
  const PB_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with', 'ends_with', 'in', 'not_in', 'regex'];
  // Real captured testnet Transfer event, same as examples/transfer-event.json.
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

  const pbState = {
    rows: [
      { field: 'amount', op: 'gte', value: '1000000000000' },
      { field: 'to_account_hash', op: 'eq', value: 'dc725246306b8ebfb6623feca7f777c4e9f52c96691cdccf338b797480787c9c' },
    ],
  };

  function pbRender() {
    const root = $('pb-rows');
    if (!root) return;
    root.innerHTML = '';
    pbState.rows.forEach((row, idx) => {
      const fieldSel = document.createElement('select');
      fieldSel.style.cssText = "flex:0 0 200px;padding:8px 10px;border:1px solid #000;background:#fafafa;font:400 13px 'JetBrains Mono';color:#000";
      PB_FIELDS.forEach((f) => {
        const opt = document.createElement('option'); opt.value = f.name; opt.textContent = f.name;
        if (row.field === f.name) opt.selected = true;
        fieldSel.appendChild(opt);
      });
      fieldSel.addEventListener('change', () => { row.field = fieldSel.value; pbUpdate(); });

      const opSel = document.createElement('select');
      opSel.style.cssText = "flex:0 0 130px;padding:8px 10px;border:1px solid #000;background:#fafafa;font:400 13px 'JetBrains Mono';color:#000";
      PB_OPS.forEach((o) => {
        const opt = document.createElement('option'); opt.value = o; opt.textContent = o;
        if (row.op === o) opt.selected = true;
        opSel.appendChild(opt);
      });
      opSel.addEventListener('change', () => { row.op = opSel.value; pbUpdate(); });

      const valIn = document.createElement('input');
      valIn.type = 'text';
      valIn.value = row.value;
      valIn.placeholder = 'value';
      valIn.style.cssText = "flex:1;padding:8px 10px;border:1px solid #000;background:#fff;font:400 13px 'JetBrains Mono';color:#000;min-width:160px";
      valIn.addEventListener('input', () => { row.value = valIn.value; pbUpdate(); });

      const rm = document.createElement('button');
      rm.textContent = '✕';
      rm.title = 'Remove condition';
      rm.style.cssText = "flex:0 0 32px;padding:8px 0;border:1px solid #000;background:#fff;cursor:pointer;font:500 14px 'Casper Sans',Inter;color:#ff2d2e";
      rm.addEventListener('click', () => { pbState.rows.splice(idx, 1); pbRender(); pbUpdate(); });

      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;align-items:stretch;gap:8px;flex-wrap:wrap';
      wrap.appendChild(fieldSel); wrap.appendChild(opSel); wrap.appendChild(valIn); wrap.appendChild(rm);
      root.appendChild(wrap);
    });
    pbUpdate();
  }

  function pbCoerceValue(op, raw) {
    if (op === 'in' || op === 'not_in') {
      return raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return raw;
  }

  function pbEvaluate(predicate, event) {
    const cmp = (l, op, r) => {
      const ls = l == null ? '' : String(l);
      if (op === 'contains')    return ls.includes(String(r ?? ''));
      if (op === 'starts_with') return ls.startsWith(String(r ?? ''));
      if (op === 'ends_with')   return ls.endsWith(String(r ?? ''));
      if (op === 'regex')       { try { return new RegExp(String(r ?? '')).test(ls); } catch { return false; } }
      if (op === 'in' || op === 'not_in') {
        if (!Array.isArray(r)) return false;
        const inList = r.some((v) => String(v) === ls);
        return op === 'in' ? inList : !inList;
      }
      // try bigint
      const tryBigInt = (v) => {
        if (typeof v === 'string' && /^-?\d+$/.test(v)) { try { return BigInt(v); } catch { return null; } }
        if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
        return null;
      };
      const lb = tryBigInt(l); const rb = tryBigInt(r);
      if (lb !== null && rb !== null) {
        switch (op) {
          case 'eq':  return lb === rb;
          case 'neq': return lb !== rb;
          case 'gt':  return lb >  rb;
          case 'gte': return lb >= rb;
          case 'lt':  return lb <  rb;
          case 'lte': return lb <= rb;
        }
      }
      const rs = r == null ? '' : String(r);
      switch (op) {
        case 'eq':  return ls === rs;
        case 'neq': return ls !== rs;
        case 'gt':  return ls >  rs;
        case 'gte': return ls >= rs;
        case 'lt':  return ls <  rs;
        case 'lte': return ls <= rs;
      }
      return false;
    };
    if (!predicate?.and?.length) return false;
    for (const c of predicate.and) {
      const lhs = event[c.field];
      if (lhs === undefined) return false;
      if (!cmp(lhs, c.op, c.value)) return false;
    }
    return true;
  }

  function pbUpdate() {
    const predicate = {
      and: pbState.rows.map((r) => ({ field: r.field, op: r.op, value: pbCoerceValue(r.op, r.value) })),
    };
    if ($('pb-json')) $('pb-json').textContent = JSON.stringify(predicate, null, 2);
    if ($('pb-event')) $('pb-event').textContent = JSON.stringify(PB_REFERENCE, null, 2);
    const matches = pbEvaluate(predicate, PB_REFERENCE);
    const verdict = $('pb-verdict');
    if (verdict) {
      verdict.textContent = matches ? '✓ MATCHES' : '✕ NO MATCH';
      verdict.style.background = matches ? '#3edc64' : '#ff2d2e';
    }
  }

  function bindPredicateBuilder() {
    if (!$('pb-rows')) return;
    // Hydrate from ?p=base64 if present (predicate share-link).
    try {
      const params = new URLSearchParams(window.location.search);
      const seed = params.get('p');
      if (seed) {
        const decoded = JSON.parse(atob(decodeURIComponent(seed)));
        if (Array.isArray(decoded.and) && decoded.and.length) {
          pbState.rows = decoded.and.map((c) => ({
            field: String(c.field),
            op: String(c.op),
            value: Array.isArray(c.value) ? c.value.join(',') : String(c.value),
          }));
        }
      }
    } catch (e) { /* ignore malformed share-links */ }
    pbRender();
    $('pb-add').addEventListener('click', () => {
      pbState.rows.push({ field: 'amount', op: 'gte', value: '0' });
      pbRender();
    });

    // ✨ AI prompt → predicate (server-side rule-based parser at /api/predicate/from-prompt).
    const aiInput = $('pb-ai-input');
    const aiGo = $('pb-ai-go');
    const aiStatus = $('pb-ai-status');
    if (aiInput && aiGo) {
      const fire = async () => {
        const prompt = aiInput.value.trim();
        if (!prompt) { aiStatus.textContent = 'type a description first'; aiStatus.style.color = '#ff2d2e'; return; }
        const prev = aiGo.textContent; aiGo.disabled = true; aiGo.textContent = '… parsing';
        aiStatus.style.color = '#666'; aiStatus.textContent = '';
        try {
          const r = await fetch('/api/predicate/from-prompt', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ prompt }) });
          const j = await r.json();
          if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
          if (!j.predicate || !j.predicate.and || !j.predicate.and.length) {
            aiStatus.style.color = '#ff2d2e';
            aiStatus.textContent = 'couldn\'t understand, try "over 100k cspr to <64-hex>"';
            return;
          }
          pbState.rows = j.predicate.and.map((c) => ({
            field: String(c.field),
            op: String(c.op),
            value: Array.isArray(c.value) ? c.value.join(',') : String(c.value),
          }));
          pbRender();
          aiStatus.style.color = '#3edc64';
          aiStatus.textContent = '✓ ' + (j.understood || []).slice(0, 2).join(' · ') + (j.unknown && j.unknown.length ? '  (ignored: ' + j.unknown.length + ')' : '');
        } catch (e) {
          aiStatus.style.color = '#ff2d2e';
          aiStatus.textContent = 'failed: ' + ((e && e.message) || e);
        } finally {
          aiGo.disabled = false; aiGo.textContent = prev;
        }
      };
      aiGo.addEventListener('click', fire);
      aiInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') fire(); });
    }
    // "Share link" wiring, encode predicate as base64 in ?p=
    const shareBtn = $('pb-share');
    if (shareBtn) {
      shareBtn.addEventListener('click', () => {
        const predicate = {
          and: pbState.rows.map((r) => ({ field: r.field, op: r.op, value: pbCoerceValue(r.op, r.value) })),
        };
        const enc = btoa(JSON.stringify(predicate));
        const url = `${window.location.origin}/?p=${enc}#builder`;
        navigator.clipboard.writeText(url).then(() => {
          const prev = shareBtn.textContent;
          shareBtn.textContent = '✓ LINK COPIED'; shareBtn.style.background = '#3edc64';
          setTimeout(() => { shareBtn.textContent = prev; shareBtn.style.background = '#fff'; }, 1800);
        });
      });
    }

    // "Why no match?", appears when verdict turns red. POSTs predicate + reference event to /api/predicate/explain and lists per-condition trace.
    const verdictEl = $('pb-verdict');
    if (verdictEl) {
      const explainBtn = document.createElement('button');
      explainBtn.id = 'pb-explain';
      explainBtn.textContent = '? Why no match';
      explainBtn.style.cssText = "background:#000;color:#fff;border:1px solid #000;padding:3px 10px;font:500 11px 'JetBrains Mono';letter-spacing:.05em;cursor:pointer;margin-left:8px;display:none";
      verdictEl.parentElement.appendChild(explainBtn);
      const updateExplainVisibility = () => {
        const isMatch = verdictEl.textContent.includes('MATCHES');
        explainBtn.style.display = isMatch ? 'none' : 'inline-block';
      };
      // Observe verdict changes (pbRender mutates textContent).
      new MutationObserver(updateExplainVisibility).observe(verdictEl, { childList: true, characterData: true, subtree: true });
      updateExplainVisibility();
      explainBtn.addEventListener('click', async () => {
        const predicate = {
          and: pbState.rows.map((r) => ({ field: r.field, op: r.op, value: pbCoerceValue(r.op, r.value) })),
        };
        const out = $('pb-dryrun-result');
        if (out) { out.style.display = 'block'; out.textContent = '… explaining …'; }
        try {
          const res = await fetch('/api/predicate/explain', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ predicate, event: PB_REFERENCE }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          const rows = (data.trace || []).map((t) => {
            const glyph = t.pass ? '<span style="color:#3edc64">✓</span>' : '<span style="color:#ff2d2e">✗</span>';
            return `<div style="font:400 12px 'JetBrains Mono';padding:3px 0">${glyph} <span style="color:#666">[${t.index}]</span> <b>${t.field}</b> ${t.op} → <span style="color:#333">${escapeHtml(t.reason)}</span></div>`;
          }).join('');
          if (out) {
            out.innerHTML =
              `<div style="font:500 12px 'JetBrains Mono';color:#000;margin-bottom:6px">` +
                `${data.conditions_passed} of ${data.conditions_total} conditions passed, ` +
                `<span style="color:${data.match ? '#3edc64' : '#ff2d2e'}">${data.match ? 'MATCHES' : 'NO MATCH'}</span>` +
              `</div>` + rows;
          }
        } catch (e) {
          if (out) out.innerHTML = `<div style="color:#ff2d2e">explain failed: ${(e && e.message) || e}</div>`;
        }
      });
    }
    function escapeHtml(s) { return String(s).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

    // "Dry-run", POST predicate to /api/predicate/validate, render result inline.
    const dryBtn = $('pb-dryrun');
    if (dryBtn) {
      dryBtn.addEventListener('click', async () => {
        const predicate = {
          and: pbState.rows.map((r) => ({ field: r.field, op: r.op, value: pbCoerceValue(r.op, r.value) })),
        };
        const out = $('pb-dryrun-result');
        if (out) { out.style.display = 'block'; out.textContent = '… running against recent events …'; }
        const prev = dryBtn.textContent; dryBtn.disabled = true; dryBtn.textContent = '… RUNNING …';
        try {
          const res = await fetch('/api/predicate/validate', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ predicate }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          const ratio = data.total_scanned > 0 ? Math.round((data.matches / data.total_scanned) * 100) : 0;
          const rate = data.estimated_per_day == null
            ? 'window too short to estimate per-day rate'
            : `~${data.estimated_per_day} matches/day at this rate`;
          const windowH = data.time_window_seconds ? `${(data.time_window_seconds / 3600).toFixed(1)}h` : '…';
          const sourceNote = data.source === 'sample'
            ? '<div style="margin-top:6px;color:#666">Matcher hasn\'t seen live traffic yet, scanned a 25-event recorded sample.</div>'
            : data.source === 'mixed'
            ? '<div style="margin-top:6px;color:#666">Buffer mixes recorded sample + live events the matcher has observed.</div>'
            : '';
          const samples = (data.sample_matches || []).slice(0, 3).map((ev) =>
            `<div style="font:400 11px 'JetBrains Mono';color:#333;padding:2px 0">↳ ${ev.amount} motes → ${(ev.to_account_hash || '').slice(0, 12)}…  <span style="color:#999">(${ev.deploy_hash.slice(0, 12)}…)</span></div>`
          ).join('');
          if (out) {
            out.innerHTML =
              `<div style="display:flex;align-items:baseline;gap:18px;flex-wrap:wrap">` +
                `<div style="font:600 28px 'Casper Sans',Inter;color:#000">${data.matches}</div>` +
                `<div style="color:#666">of ${data.total_scanned} scanned · ${ratio}% hit rate · window ${windowH}</div>` +
                `<div style="flex:1"></div>` +
                `<div style="font:500 11px 'JetBrains Mono';color:#000;letter-spacing:.06em">${rate}</div>` +
              `</div>` +
              (samples ? `<div style="margin-top:10px;border-top:1px dashed #ccc;padding-top:8px">${samples}</div>` : '') +
              sourceNote;
          }
        } catch (e) {
          if (out) out.innerHTML = `<div style="color:#ff2d2e">dry-run failed: ${(e && e.message) || e}</div>`;
        } finally {
          dryBtn.disabled = false; dryBtn.textContent = prev;
        }
      });
    }

    $('pb-copy').addEventListener('click', () => {
      const predicate = {
        and: pbState.rows.map((r) => ({ field: r.field, op: r.op, value: pbCoerceValue(r.op, r.value) })),
      };
      const snippet =
`# save predicate
cat > predicate.json <<'EOF'
${JSON.stringify(predicate, null, 2)}
EOF

# subscribe
export SLUICE_CONTRACT_HASH=f3710eaf12c30346eb1c642da832bc1af8ff900254c46bcc49a1efca81d8b971
export SLUICE_KEY=~/keys/subscriber/secret_key.pem
sluice subscribe --predicate ./predicate.json --webhook https://your.app/hook --amount 10`;
      navigator.clipboard.writeText(snippet)
        .then(() => {
          const btn = $('pb-copy'); const prev = btn.textContent;
          btn.textContent = '✓ COPIED'; btn.style.background = '#3edc64'; btn.style.color = '#000';
          setTimeout(() => { btn.textContent = prev; btn.style.background = '#000'; btn.style.color = '#fff'; }, 1800);
        })
        .catch(() => alert(snippet));
    });
  }

  /** Render the "live demo subs" gallery from /api/snapshot.json. Each card is
   *  the real /embed/sub/N iframe plus copy buttons for the integration points
   *  (.ics, .og, /embed/). Re-renders every 30s in case new subs come online. */
  function bindDemoSubs() {
    const list = $('demos-list');
    if (!list) return;
    const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

    async function render() {
      try {
        const r = await fetch('/api/snapshot.json?t=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        const subs = (j.subscriptions || []).filter((s) => s.active);
        if (subs.length === 0) {
          list.innerHTML = '<div style="padding:38px;background:#1a1a1a;color:#666;text-align:center;font:500 12px JetBrains Mono;letter-spacing:.06em">no active subscriptions right now, create one via /app or `sluice subscribe`</div>';
          return;
        }
        list.innerHTML = subs.slice(0, 6).map((s) => {
          const cspr = (BigInt(s.balance) / 1000000000n).toString();
          const conds = s.predicate && Array.isArray(s.predicate.and) ? s.predicate.and : [];
          const filterLine = conds.length
            ? conds.slice(0, 2).map((c) => `${escHtml(c.field)} ${escHtml(c.op)} ${escHtml(String(c.value).slice(0,18))}${String(c.value).length>18?'…':''}`).join(' AND ')
            : '(no filter)';
          const moreConds = conds.length > 2 ? ` +${conds.length - 2} more` : '';
          const wh = (s.webhook_url || '').replace(/^https?:\/\//, '');
          const whTrunc = wh.length > 40 ? wh.slice(0, 38) + '…' : wh;
          return `
            <div style="background:#0d0d0d;border:1px solid #222;display:flex;flex-direction:column">
              <iframe src="/embed/sub/${s.id}" width="100%" height="120" frameborder="0" loading="lazy" style="border:0;background:#000;border-bottom:1px solid #1a1a1a" title="sub_${s.id} live card"></iframe>
              <div style="padding:18px 22px;display:flex;flex-direction:column;gap:10px">
                <div style="font:500 11px 'JetBrains Mono';color:#bcfc07;letter-spacing:.08em">FILTER</div>
                <div style="font:400 13px/1.4 'JetBrains Mono';color:#fff;word-break:break-all">${filterLine}${moreConds}</div>
                <div style="font:500 11px 'JetBrains Mono';color:#666;letter-spacing:.08em;margin-top:4px">WEBHOOK</div>
                <div style="font:400 12px/1.4 'JetBrains Mono';color:#aaa;word-break:break-all">${escHtml(whTrunc)}</div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
                  <span style="background:#1a1a1a;color:#bcfc07;padding:3px 8px;font:500 10px 'JetBrains Mono';letter-spacing:.06em">${cspr} CSPR</span>
                  <span style="background:#1a1a1a;color:#fff;padding:3px 8px;font:500 10px 'JetBrains Mono';letter-spacing:.06em">${s.deliveries} delivered</span>
                </div>
                <div style="display:flex;gap:14px;margin-top:10px;font:500 11px 'JetBrains Mono';letter-spacing:.06em">
                  <a href="/embed/sub/${s.id}" target="_blank" style="color:#bcfc07;text-decoration:none">EMBED ↗</a>
                  <a href="/og/sub/${s.id}" target="_blank" style="color:#bcfc07;text-decoration:none">OG ↗</a>
                  <a href="/api/sub/${s.id}.ics" style="color:#bcfc07;text-decoration:none">ICS ↗</a>
                  <a href="/app#sub-${s.id}" style="color:#fff;text-decoration:none;margin-left:auto">DASHBOARD →</a>
                </div>
              </div>
            </div>`;
        }).join('');
      } catch (e) {
        list.innerHTML = `<div style="padding:38px;background:#1a1a1a;color:#ff8a65;text-align:center;font:500 12px JetBrains Mono">failed to load: ${escHtml((e && e.message) || String(e))}</div>`;
      }
    }
    render();
    setInterval(render, 30_000);
  }

  // MCP is an open standard, the same hosted endpoint works with any client.
  // Each entry is the config a given client needs to add the Sluice server.
  const MCP_URL = 'https://sluice.unitynodes.com/mcp';
  const MCP_CLIENTS = {
    claude:   { hint: 'Terminal · one command',                     snippet: 'claude mcp add --transport http sluice ' + MCP_URL },
    cursor:   { hint: '~/.cursor/mcp.json',                          snippet: '{\n  "mcpServers": {\n    "sluice": { "url": "' + MCP_URL + '" }\n  }\n}' },
    windsurf: { hint: '~/.codeium/windsurf/mcp_config.json',         snippet: '{\n  "mcpServers": {\n    "sluice": { "serverUrl": "' + MCP_URL + '" }\n  }\n}' },
    vscode:   { hint: '.vscode/mcp.json',                            snippet: '{\n  "servers": {\n    "sluice": { "type": "http", "url": "' + MCP_URL + '" }\n  }\n}' },
    desktop:  { hint: 'claude_desktop_config.json · via mcp-remote', snippet: '{\n  "mcpServers": {\n    "sluice": { "command": "npx", "args": ["mcp-remote", "' + MCP_URL + '"] }\n  }\n}' },
    any:      { hint: 'Streamable HTTP endpoint · paste into any MCP client', snippet: MCP_URL },
  };

  function bindMcpDemoInstall() {
    const cmd = $('mcp-install-cmd');
    const hint = $('mcp-install-hint');
    const pills = document.querySelectorAll('#mcp-clients .mcp-pill');
    const copyBtn = $('mcp-install-copy');
    if (!cmd || !pills.length) return;

    function select(key) {
      const c = MCP_CLIENTS[key];
      if (!c) return;
      cmd.textContent = c.snippet;
      if (hint) hint.textContent = c.hint;
      pills.forEach((p) => p.classList.toggle('active', p.dataset.mcpClient === key));
    }
    pills.forEach((p) => p.addEventListener('click', () => select(p.dataset.mcpClient)));
    select('claude');

    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(cmd.textContent.trim());
          const prev = copyBtn.textContent;
          copyBtn.textContent = '✓ COPIED';
          setTimeout(() => { copyBtn.textContent = prev; }, 1500);
        } catch {}
      });
    }
  }

  /* ─────────────────── hero inline AI parser ─────────────────── */
  function escHeroHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function fmtMotes(v) {
    // Best-effort: if value parses as bigint and divides cleanly into CSPR, show "N CSPR (motes)".
    try {
      const n = BigInt(String(v));
      const cspr = n / 1_000_000_000n;
      if (cspr >= 1n) return `${cspr.toLocaleString('en-US')} CSPR <span style="color:#666">(${n.toLocaleString('en-US')} motes)</span>`;
    } catch {}
    return escHeroHtml(String(v));
  }
  function bindHeroAi() {
    const input = $('hero-ai-input');
    const btn = $('hero-ai-go');
    const out = $('hero-ai-output');
    const suggest = $('hero-ai-suggest');
    if (!input || !btn || !out) return;
    let lastReq = 0;

    function renderError(msg) {
      out.style.display = 'block';
      out.innerHTML = `<div style="background:#fff4f4;border:1px solid #ff2d2e;color:#ff2d2e;padding:10px 14px;font:500 12.5px 'JetBrains Mono';letter-spacing:.02em">${escHeroHtml(msg)}</div>`;
    }
    async function runHeroDryRun(predicate) {
      const el = $('hero-ai-dryrun');
      if (!el) return;
      try {
        const r = await fetch('/api/predicate/validate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ predicate }),
        });
        const j = await r.json();
        if (!r.ok) {
          el.innerHTML = `<span style="color:#ff2d2e">dry-run failed: ${escHeroHtml(j.error || ('HTTP ' + r.status))}</span>`;
          return;
        }
        const { matches, total_scanned, time_window_seconds, estimated_per_day, sample_matches, source } = j;
        const windowLabel = time_window_seconds
          ? (time_window_seconds >= 3600 ? `${Math.round(time_window_seconds / 3600)}h` : `${Math.round(time_window_seconds / 60)}m`)
          : 'sample';
        const perDay = estimated_per_day != null ? ` · <span style="color:#000">≈ ${estimated_per_day.toLocaleString('en-US')}/day</span>` : '';
        const sourceBadge = source === 'live'  ? '<span style="background:#3edc64;color:#000;padding:1px 6px;font-size:9.5px;letter-spacing:.08em">LIVE</span>'
                          : source === 'mixed' ? '<span style="background:#ffb347;color:#000;padding:1px 6px;font-size:9.5px;letter-spacing:.08em">MIXED</span>'
                          : '<span style="background:#ccc;color:#000;padding:1px 6px;font-size:9.5px;letter-spacing:.08em">SAMPLE</span>';
        const headline = matches === 0
          ? `<span style="color:#ff2d2e">⚠</span> 0 matches in last ${total_scanned} events (${windowLabel})${perDay}, predicate may be too strict`
          : `<span style="color:#3edc64">✓</span> <span style="color:#000">${matches} of ${total_scanned}</span> events matched (last ${windowLabel})${perDay}`;
        let sampleHtml = '';
        if (matches > 0 && Array.isArray(sample_matches) && sample_matches.length) {
          const items = sample_matches.slice(0, 3).map((ev) => {
            const amt = fmtMotes(ev.amount);
            const to = (ev.to_account_hash || '').slice(0, 8) + '…';
            const ago = ev.timestamp ? (() => { const dt = Math.max(0, Date.now() - new Date(ev.timestamp).getTime()); if (dt < 60000) return Math.floor(dt/1000)+'s ago'; if (dt < 3600000) return Math.floor(dt/60000)+'m ago'; return Math.floor(dt/3600000)+'h ago'; })() : '';
            const blk = ev.block_height ? `block ${ev.block_height.toLocaleString('en-US')}` : '';
            return `<div style="display:flex;gap:10px;padding:6px 0;border-top:1px dashed #ddd;font:400 11.5px 'JetBrains Mono';color:#333"><span style="color:#666;min-width:80px">${escHeroHtml(ago)}</span><span style="color:#000;min-width:120px;text-align:right">${amt}</span><span style="color:#666;min-width:100px">→ ${escHeroHtml(to)}</span><span style="color:#999">${escHeroHtml(blk)}</span></div>`;
          }).join('');
          sampleHtml = `<div style="margin-top:8px">${items}</div>`;
        }
        el.innerHTML = `<div style="display:flex;align-items:center;gap:10px"><span style="font:500 10.5px 'JetBrains Mono';color:#666;letter-spacing:.1em">DRY-RUN</span>${sourceBadge}<span style="color:#000;font-weight:400;letter-spacing:0;font-size:12px">${headline}</span></div>${sampleHtml}`;
      } catch (e) {
        el.innerHTML = `<span style="color:#999">dry-run unavailable: ${escHeroHtml((e && e.message) || String(e))}</span>`;
      }
    }
    function renderCond(c) {
      const val = Array.isArray(c.value) ? c.value.join(', ') : c.value;
      const isAmount = c.field === 'amount';
      const valHtml = isAmount && typeof val === 'string' && /^\d+$/.test(val) ? fmtMotes(val) : escHeroHtml(String(val));
      return `<div style="display:grid;grid-template-columns:170px 70px 1fr;gap:12px;padding:8px 0;border-top:1px dashed #ccc;align-items:baseline">
        <span style="font:500 12.5px 'JetBrains Mono';color:#000">${escHeroHtml(c.field)}</span>
        <span style="font:500 12.5px 'JetBrains Mono';color:#bcfc07;background:#000;padding:2px 7px;display:inline-block;width:fit-content;letter-spacing:.04em;text-transform:uppercase">${escHeroHtml(c.op)}</span>
        <span style="font:500 12.5px 'JetBrains Mono';color:#000;overflow-wrap:anywhere">${valHtml}</span>
      </div>`;
    }
    function renderNode(node, depth) {
      if (node && Array.isArray(node.or)) {
        const inner = node.or.map((n) => renderNode(n, depth + 1)).join('');
        return `<div style="margin:8px 0;border-left:3px solid #bcfc07;background:#fff;padding:6px 12px">
          <div style="font:500 10px 'JetBrains Mono';color:#bcfc07;background:#000;padding:2px 8px;display:inline-block;letter-spacing:.1em;margin:4px 0">ANY OF (OR)</div>
          ${inner}
        </div>`;
      }
      if (node && Array.isArray(node.and)) {
        const inner = node.and.map((n) => renderNode(n, depth + 1)).join('');
        return `<div style="margin:8px 0;border-left:3px solid #666;background:#fff;padding:6px 12px">
          <div style="font:500 10px 'JetBrains Mono';color:#fff;background:#666;padding:2px 8px;display:inline-block;letter-spacing:.1em;margin:4px 0">ALL OF (AND)</div>
          ${inner}
        </div>`;
      }
      return renderCond(node);
    }
    function renderResult(j) {
      const conds = (j && j.predicate && j.predicate.and) || [];
      if (!conds.length) {
        out.style.display = 'block';
        out.innerHTML = `<div style="background:#fffbe6;border:1px solid #d4a700;padding:10px 14px;font:500 12.5px 'JetBrains Mono';color:#000">couldn't extract anything, try <code style="color:#000">"over 100k cspr to &lt;64-hex&gt;"</code> or <code style="color:#000">"from &lt;hex&gt; or &lt;hex&gt;"</code></div>`;
        return;
      }
      const understood = (j.understood || []).slice(0, 6);
      const unknown = (j.unknown || []).slice(0, 4);
      const rows = conds.map((c) => renderNode(c, 0)).join('');
      const jsonPretty = JSON.stringify(j.predicate, null, 2);
      const shareLink = '/app#build?p=' + encodeURIComponent(btoa(JSON.stringify(j.predicate)).replace(/=+$/, ''));
      out.style.display = 'block';
      out.innerHTML =
        `<div style="background:#fafafa;border:1px solid #000;padding:0">
          <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #000;background:#bcfc07;font:500 11px 'JetBrains Mono';letter-spacing:.1em;text-transform:uppercase">
            <span>✓ PREDICATE</span>
            <span style="color:#000;font-weight:400;letter-spacing:0;text-transform:none;font-size:11px">${understood.length ? understood.join(' · ') : ''}</span>
            <span style="flex:1"></span>
            ${unknown.length ? `<span style="color:#666;font-weight:400;letter-spacing:0;text-transform:none;font-size:10.5px">${unknown.length} word(s) ignored</span>` : ''}
          </div>
          <div style="padding:6px 14px 12px">${rows}</div>
          <div id="hero-ai-dryrun" style="border-top:1px solid #000;padding:10px 14px;background:#fff;font:500 11px 'JetBrains Mono';color:#666;letter-spacing:.04em">
            <span class="dryrun-spinner">⏳ checking against recent testnet events…</span>
          </div>
          <details style="border-top:1px solid #000;padding:10px 14px;background:#fff">
            <summary style="cursor:pointer;font:500 11px 'JetBrains Mono';letter-spacing:.08em;color:#666">VIEW JSON</summary>
            <pre id="hero-ai-json" style="margin:10px 0 0;padding:12px 14px;background:#000;color:#fff;font:500 12px/1.55 'JetBrains Mono';overflow-x:auto;white-space:pre">${escHeroHtml(jsonPretty)}</pre>
          </details>
          <div style="display:flex;gap:8px;padding:10px 14px;border-top:1px solid #000;background:#fff;flex-wrap:wrap">
            <a href="${shareLink}" style="background:#000;color:#bcfc07;text-decoration:none;padding:8px 14px;font:500 12px 'Casper Sans',Inter;letter-spacing:.02em">Open in builder →</a>
            <button id="hero-ai-copy" type="button" style="background:#fff;color:#000;border:1px solid #000;padding:8px 14px;font:500 12px 'Casper Sans',Inter;cursor:pointer">⧉ Copy JSON</button>
            <span style="flex:1"></span>
            <span style="font:500 10.5px 'JetBrains Mono';color:#666;align-self:center;letter-spacing:.06em">RULE-BASED · 0 LLM CALLS · &lt; 5 MS</span>
          </div>
        </div>`;
      // Fire dry-run in parallel
      runHeroDryRun(j.predicate);
      const copyBtn = $('hero-ai-copy');
      if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(jsonPretty);
            const prev = copyBtn.textContent;
            copyBtn.textContent = '✓ COPIED';
            setTimeout(() => { copyBtn.textContent = prev; }, 1400);
          } catch {}
        });
      }
    }

    async function fire() {
      const prompt = input.value.trim();
      if (!prompt) { renderError('type a description first, e.g., "over 100k cspr to <64-hex>"'); input.focus(); return; }
      const myReq = ++lastReq;
      const prevLabel = btn.textContent;
      btn.disabled = true;
      btn.textContent = '…';
      out.style.display = 'block';
      out.innerHTML = `<div style="padding:10px 14px;font:500 12px 'JetBrains Mono';color:#666">parsing…</div>`;
      try {
        const r = await fetch('/api/predicate/from-prompt', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt }),
        });
        const j = await r.json();
        if (myReq !== lastReq) return; // outdated response
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        renderResult(j);
      } catch (e) {
        if (myReq !== lastReq) return;
        renderError('parser unreachable: ' + ((e && e.message) || e));
      } finally {
        if (myReq === lastReq) { btn.disabled = false; btn.textContent = prevLabel; }
      }
    }

    btn.addEventListener('click', fire);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') fire(); });
    if (suggest) {
      suggest.addEventListener('click', (e) => {
        const t = e.target;
        if (t && t.classList && t.classList.contains('hero-ai-chip')) {
          input.value = t.getAttribute('data-q') || '';
          fire();
        }
      });
    }
  }

  /* Scroll-reveal via IntersectionObserver. Each element with [data-reveal]
     picks up the .revealed class once ~15% of it enters the viewport, then
     unobserves so we don't re-fire when the user scrolls past again. */
  function bindReveals() {
    const nodes = document.querySelectorAll('[data-reveal]');
    if (!nodes.length) return;
    if (!('IntersectionObserver' in window)) {
      nodes.forEach((n) => n.classList.add('revealed'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('revealed');
          io.unobserve(e.target);
        }
      }
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.12 });
    nodes.forEach((n) => io.observe(n));
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindRecipes();
    bindPredicateBuilder();
    bindMcpDemoInstall();
    bindDemoSubs();
    bindHeroAi();
    bindReveals();
    // Wire up the "Copy the MCP endpoint" CTA, the hosted URL any client uses.
    const mcpBtn = $('copy-mcp-cta');
    if (mcpBtn) {
      mcpBtn.addEventListener('click', async () => {
        const cmd = 'https://sluice.unitynodes.com/mcp';
        try {
          await navigator.clipboard.writeText(cmd);
          const label = mcpBtn.lastElementChild;
          const prev = label.textContent;
          label.textContent = '✓ COPIED';
          setTimeout(() => { label.textContent = prev; }, 1500);
        } catch {
          window.open('https://github.com/UnityNodes/Sluice/tree/main/mcp#readme', '_blank');
        }
      });
    }
    tick();
    setInterval(tick, POLL_MS);
    // Live Casper testnet head, every 5s via /api/chain/head (cached server-side at 3s).
    const blockH = $('hero-block-h');
    const blockDot = $('hero-block-dot');
    let lastH = 0;
    async function pollHead() {
      try {
        const r = await fetch('/api/chain/head?t=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (typeof j.height === 'number') {
          const fmt = j.height.toLocaleString('en-US');
          if (j.height !== lastH) {
            if (blockH) blockH.textContent = fmt;
            const stampBlock = $('hero-stamp-block'); if (stampBlock) stampBlock.textContent = 'BLOCK ' + fmt;
            const tickerBlock = $('ticker-block');    if (tickerBlock) tickerBlock.textContent = 'BLOCK ' + fmt;
            lastH = j.height;
            if (blockDot) {
              blockDot.style.transition = 'background .2s';
              blockDot.style.background = '#bcfc07';
              setTimeout(() => { blockDot.style.background = '#4589f6'; }, 280);
            }
          }
        }
      } catch {
        if (blockH && !blockH.textContent.match(/\d/)) blockH.textContent = 'offline';
      }
    }
    pollHead();
    setInterval(pollHead, 5_000);

    /* ─────────── 30-second live tour modal ─────────── */
    const tourBtn = $('tour-open');
    const tourModal = $('tour-modal');
    if (tourBtn && tourModal) {
      const stage = $('tour-stage');
      const stepLabel = $('tour-step');
      const progress = $('tour-progress');
      const prev = $('tour-prev');
      const next = $('tour-next');
      const close = $('tour-close');

      const escHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
      const codeBlock = (body) => `<pre style="margin:14px 0 0;padding:14px 16px;background:#000;color:#bcfc07;font:400 12px/1.55 'JetBrains Mono';overflow-x:auto;white-space:pre-wrap;word-break:break-word">${escHtml(body)}</pre>`;
      const note = (heading, body) => `<div style="font:500 11px 'JetBrains Mono';letter-spacing:.1em;color:#666">${heading}</div><div style="margin-top:8px;font:400 16px/1.55 'Casper Sans',Inter;color:#000">${body}</div>`;

      const TOTAL = 5;
      let idx = 0;
      let autoTimer = null;

      const steps = [
        {
          run: async () => {
            const r = await fetch('/api/health', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
            const j = await r.json();
            return note('STEP 1 · IS THE MATCHER ALIVE?', `One POST to <code style="font:500 13px 'JetBrains Mono';background:#fafafa;padding:2px 6px">/api/health</code> and we have a live answer plus the contract hash we're watching.`) + codeBlock(JSON.stringify(j, null, 2));
          },
        },
        {
          run: async () => {
            const r = await fetch('/api/chain/head?t=' + Date.now(), { cache: 'no-store' });
            const j = await r.json();
            return note('STEP 2 · CASPER TESTNET HEAD', `The matcher caches Casper's head every 3s and serves it through <code style="font:500 13px 'JetBrains Mono';background:#fafafa;padding:2px 6px">/api/chain/head</code>. Block <b>${j.height.toLocaleString('en-US')}</b> · era ${j.era}.`) + codeBlock(JSON.stringify(j, null, 2));
          },
        },
        {
          run: async () => {
            const predicate = { and: [{ field: 'amount', op: 'gte', value: '5000000000000' }] };
            const r = await fetch('/api/predicate/validate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ predicate }) });
            const j = await r.json();
            return note('STEP 3 · DRY-RUN A FILTER BEFORE PAYING', `POST a predicate to <code style="font:500 13px 'JetBrains Mono';background:#fafafa;padding:2px 6px">/api/predicate/validate</code> and see how many recent on-chain Transfers it would have caught, <b>${j.matches} of ${j.total_scanned}</b> in the last ${Math.round((j.time_window_seconds || 0) / 60)} min.`) + codeBlock(JSON.stringify({ predicate, result: { matches: j.matches, total_scanned: j.total_scanned, estimated_per_day: j.estimated_per_day, source: j.source } }, null, 2));
          },
        },
        {
          run: async () => {
            const r = await fetch('/api/snapshot.json?t=' + Date.now(), { cache: 'no-store' });
            const j = await r.json();
            const active = j.subscriptions.filter((s) => s.active);
            const sub = active[0] || j.subscriptions[0];
            if (!sub) return note('STEP 4 · LIVE SUBSCRIPTION CARD', 'No subscriptions in the matcher view right now.');
            return note('STEP 4 · EMBED IT', `Every active subscription has a 320×120 widget at <code style="font:500 13px 'JetBrains Mono';background:#fafafa;padding:2px 6px">/embed/sub/${sub.id}</code>. Drop it into a Notion page or a blog post.`) +
              `<div style="margin-top:14px;display:flex;gap:18px;flex-wrap:wrap"><iframe src="/embed/sub/${sub.id}" width="320" height="120" frameborder="0" style="border:1px solid #000"></iframe>` +
              codeBlock(`<iframe src="https://sluice.unitynodes.com/embed/sub/${sub.id}" width="320" height="120" frameborder="0"></iframe>`) + `</div>`;
          },
        },
        {
          run: async () => {
            return note('STEP 5 · TWO LINES TO INTEGRATE', `Add the hosted MCP endpoint to any MCP client, or grab the typed client for your runtime.`) +
              codeBlock(`# MCP, any client (Claude, Cursor, Windsurf, VS Code)
#   endpoint: https://sluice.unitynodes.com/mcp
#   Claude Code:
claude mcp add --transport http sluice https://sluice.unitynodes.com/mcp

# TypeScript client
npm i @sluice/client

# Python client
pip install sluice-client`) +
              `<div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">` +
                `<a href="/app" style="background:#bcfc07;color:#000;border:1px solid #000;padding:10px 18px;font:500 14px 'Casper Sans',Inter;text-decoration:none">Open the app →</a>` +
                `<a href="/app#build" style="background:#fff;color:#000;border:1px solid #000;padding:10px 18px;font:500 14px 'Casper Sans',Inter;text-decoration:none">Try the predicate builder</a>` +
                `<a href="/status" style="background:#fff;color:#000;border:1px solid #000;padding:10px 18px;font:500 14px 'Casper Sans',Inter;text-decoration:none">Live status →</a>` +
              `</div>`;
          },
        },
      ];

      async function render(i) {
        idx = Math.max(0, Math.min(i, TOTAL - 1));
        stepLabel.textContent = String(idx + 1);
        progress.style.width = ((idx + 1) / TOTAL * 100).toFixed(1) + '%';
        stage.innerHTML = `<div style="font:400 14px 'Casper Sans',Inter;color:#666">running step ${idx + 1}…</div>`;
        try {
          const html = await steps[idx].run();
          stage.innerHTML = html;
        } catch (e) {
          stage.innerHTML = `<div style="color:#ff2d2e;font:400 13px 'JetBrains Mono'">step ${idx + 1} failed: ${escHtml((e && e.message) || String(e))}</div>`;
        }
      }
      function schedule() {
        if (autoTimer) clearTimeout(autoTimer);
        if (idx < TOTAL - 1) autoTimer = setTimeout(() => render(idx + 1).then(schedule), 6_000);
      }
      function open() {
        tourModal.style.display = 'block';
        document.body.style.overflow = 'hidden';
        render(0).then(schedule);
      }
      function shut() {
        tourModal.style.display = 'none';
        document.body.style.overflow = '';
        if (autoTimer) clearTimeout(autoTimer);
      }
      tourBtn.addEventListener('click', open);
      close.addEventListener('click', shut);
      tourModal.addEventListener('click', (e) => { if (e.target === tourModal) shut(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && tourModal.style.display === 'block') shut(); });
      prev.addEventListener('click', () => { if (autoTimer) clearTimeout(autoTimer); render(idx - 1); });
      next.addEventListener('click', () => { if (autoTimer) clearTimeout(autoTimer); render(idx + 1).then(schedule); });
    }
  });
})();
