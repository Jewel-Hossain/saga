/* Shared engine for the pattern simulators.
   Pages build an SVG with the helpers below, then call Sim.init({ reset, run, finish }).
   run(g) is an async script; every await on sleep/travel/checkpoint throws Sim.CANCEL once the run is reset.
   URL hash: any control id can be preset (#fault=crash&mode=orch); "noplay" stops autoplay; "fast" runs at test speed. */
window.Sim = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const $ = s => document.querySelector(s);
  const params = new URLSearchParams(location.hash.slice(1));
  const FAST = params.has('fast');
  const raf = FAST ? cb => setTimeout(() => cb(performance.now()), 0) : cb => requestAnimationFrame(cb);
  const RUN = { gen: 0, playing: false, stepping: false, running: false, done: false, simT: 0 };
  const CANCEL = Symbol('cancel');
  let speed = 1, tokLayer = null, O = null;

  const active = () => RUN.playing || RUN.stepping;
  (function clock() {
    let last = performance.now();
    (function tick(now) {
      const dt = FAST ? 400 : Math.min(64, now - last); last = now;
      if (active()) RUN.simT += dt * speed;
      raf(tick);
    })(last);
  })();

  const hex = n => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  function el(tag, attrs = {}, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function txt(parent, x, y, s, cls, anchor = 'middle') {
    const t = el('text', { x, y, class: cls, 'text-anchor': anchor }, parent);
    t.textContent = s;
    return t;
  }

  /* ---------- Timing ---------- */
  function sleep(g, ms) {
    return new Promise((res, rej) => {
      let t = 0, last = performance.now();
      function tick(now) {
        if (g !== RUN.gen) return rej(CANCEL);
        const dt = FAST ? 400 : Math.min(64, now - last); last = now;
        if (active()) t += dt * speed;
        if (t >= ms) res(); else raf(tick);
      }
      raf(tick);
    });
  }
  const frame = g => new Promise((res, rej) => raf(() => g === RUN.gen ? res() : rej(CANCEL)));
  async function checkpoint(g) {
    if (RUN.stepping) { RUN.stepping = false; sync(); }
    while (!active()) { await new Promise(r => raf(r)); if (g !== RUN.gen) throw CANCEL; }
  }

  /* ---------- SVG building ---------- */
  function stage(svg) {
    svg.innerHTML = '';
    const defs = el('defs', {}, svg);
    const mk = el('marker', { id: 'arr', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: 'auto' }, defs);
    el('path', { d: 'M0 0 L8 4 L0 8 z', class: 'arrow' }, mk);
    const L = { zones: el('g', {}, svg), edges: el('g', {}, svg), nodes: el('g', {}, svg), toks: el('g', {}, svg) };
    tokLayer = L.toks;
    return L;
  }
  const path = (layer, d, cls = '', arrow = true) => el('path', { d, class: 'edge' + (cls ? ' ' + cls : ''), ...(arrow ? { 'marker-end': 'url(#arr)' } : {}) }, layer);
  function node(layer, { x, y, w, h, title, sub, status = 'idle' }) {
    const g = el('g', { class: 'node' }, layer);
    el('rect', { x: x - w / 2, y: y - h / 2, width: w, height: h, rx: 10, class: 'box' }, g);
    const big = h > 80;
    txt(g, x, y - (big ? 16 : 10), title, 'title');
    if (sub) txt(g, x, y + (big ? 2 : 6), sub, 'sub');
    const st = txt(g, x, y + (big ? 26 : 24), status, 'status');
    const n = { g, st, base: '', x, y, w, h,
      set(text, cls = '') { g.setAttribute('class', ['node', n.base, cls].filter(Boolean).join(' ')); if (text != null) st.textContent = text; } };
    return n;
  }
  function exchange(layer, { x, y, r = 28, name, type, letter, labelSide = 'top' }) {
    const g = el('g', { class: 'ex' }, layer);
    el('polygon', { points: `${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`, class: 'dia' }, g);
    txt(g, x, y + 5, letter || type[0].toUpperCase(), 'letter');
    if (labelSide === 'left') { txt(g, x - r - 8, y - 1, name, 'name', 'end'); txt(g, x - r - 8, y + 12, type, 'type', 'end'); }
    else if (labelSide === 'bottom') { txt(g, x, y + r + 16, name, 'name'); txt(g, x, y + r + 28, type, 'type'); }
    else { txt(g, x, y - r - 20, name, 'name'); txt(g, x, y - r - 8, type, 'type'); }
    return { g, hit() { g.classList.add('hit'); setTimeout(() => g.classList.remove('hit'), 450); } };
  }
  /* A queue drawn as slots; items[0] is the head (rightmost slot). item = { label, kind, unacked } */
  function queue(layer, { x, y, name, cap = 8, keys = [], below = false, dash = false }) {
    const w = cap * 17 + 16;
    const g = el('g', { class: 'q' + (dash ? ' dash' : '') }, layer);
    el('rect', { x: x - w / 2, y: y - 17, width: w, height: 34, rx: 4, class: 'qbox' }, g);
    const slots = [];
    for (let i = 0; i < cap; i++) {
      const sx = x - w / 2 + 8.5 + i * 17;
      slots.push({ r: el('rect', { x: sx, y: y - 9, width: 14, height: 18, rx: 2, class: 'slot' }, g), t: txt(g, sx + 7, y + 3.5, '', 'stext') });
    }
    const ny = below ? y + 31 : y - 24, cy = below ? y + 45 : y + 30;
    const label = txt(g, x, ny, name, 'name');
    const count = txt(g, x, cy, '', 'count');
    keys.forEach((k, i) => txt(g, x, cy + 13 + i * 12, k, 'key'));
    const q = { g, x, y, w, items: [], label, extra: '',
      draw() {
        slots.forEach((s, i) => {
          const it = q.items[cap - 1 - i];
          s.r.setAttribute('class', 'slot' + (it ? ' full' + (it.unacked ? ' unacked' : '') : ''));
          s.r.setAttribute('style', it ? `fill:var(--k-${it.kind});stroke:var(--k-${it.kind})` : '');
          s.t.textContent = it ? (it.label || '') : '';
        });
        const r = q.items.filter(i => !i.unacked).length, u = q.items.length - r;
        count.textContent = `ready ${r} · unacked ${u}` + (q.items.length > cap ? ` · +${q.items.length - cap} more` : '') + q.extra;
      },
      push(it) { q.items.push(it); q.draw(); return it; },
      remove(it) { const i = q.items.indexOf(it); if (i >= 0) q.items.splice(i, 1); q.draw(); },
      head() { return q.items.find(i => !i.unacked); },
    };
    q.draw();
    return q;
  }
  /* A table drawn in SVG. rows: { cells, state, flash } */
  function table(layer, { x, y, w, title, cols, gap = 18, cellClass = () => '', max = 99 }) {
    const g = el('g', {}, layer);
    const t = { g, rows: [],
      draw() {
        while (g.firstChild) g.firstChild.remove();
        txt(g, x, y, title, 'tname', 'start');
        cols.forEach(([h, cx]) => txt(g, x + cx, y + 18, h, 'thead', 'start'));
        el('line', { x1: x, x2: x + w, y1: y + 24, y2: y + 24, class: 'tline' }, g);
        const rows = t.rows.slice(-max);
        if (!rows.length) txt(g, x, y + 40, '(0 rows)', 'tempty', 'start');
        rows.forEach((r, i) => {
          const ry = y + 40 + i * gap;
          const rg = el('g', { class: 'trow' + (r.state ? ' ' + r.state : '') }, g);
          el('rect', { x: x - 5, y: ry - 13, width: w + 10, height: gap - 1, rx: 3, class: 'tbg' }, rg);
          el('rect', { x: x - 5, y: ry - 13, width: w + 10, height: gap - 1, rx: 3, class: 'hl' }, rg);
          r.cells.forEach((c, j) => { const cc = r.state ? '' : cellClass(String(c), j); txt(rg, x + cols[j][1], ry, c, 'tcell' + (cc ? ' ' + cc : ''), 'start'); });
          if (r.flash) { rg.classList.add('flash'); r.flash = false; }
        });
        t.onDraw && t.onDraw();
      },
      add(cells, state = '') { const r = { cells, state, flash: true }; t.rows.push(r); t.draw(); return r; },
      set(r, patch = {}) { Object.assign(r, patch, { flash: true }); t.draw(); },
      clear() { t.rows = []; t.draw(); },
    };
    t.draw();
    return t;
  }

  /* ---------- Tokens ---------- */
  function token(label, kind, ghost = false) {
    const g = el('g', { class: 'tok' + (ghost ? ' ghost' : ''), visibility: 'hidden' }, tokLayer);
    const w = String(label).length * 6.4 + 18;
    const rect = el('rect', { x: -w / 2, y: -10, width: w, height: 20, rx: 10 }, g);
    const t = txt(g, 0, 4, label, '');
    const tok = { el: g, color: '',
      setKind(k) { this.color = `var(--k-${k})`; rect.setAttribute('style', `fill:${this.color}`); },
      setLabel(s) { t.textContent = s; const nw = String(s).length * 6.4 + 18; rect.setAttribute('x', -nw / 2); rect.setAttribute('width', nw); },
      at(x, y) { g.setAttribute('transform', `translate(${x},${y})`); g.setAttribute('visibility', 'visible'); },
      remove() { g.remove(); } };
    tok.setKind(kind);
    return tok;
  }
  function travel(g, tok, p, reverse = false) {
    const len = p.getTotalLength();
    p.style.setProperty('--live', tok.color);
    p.classList.add('live');
    const place = d => { const pt = p.getPointAtLength(reverse ? len - d : d); tok.at(pt.x, pt.y); };
    place(0);
    return new Promise((res, rej) => {
      let d = 0, last = performance.now();
      function tick(now) {
        if (g !== RUN.gen) { p.classList.remove('live'); return rej(CANCEL); }
        const dt = FAST ? 400 : Math.min(64, now - last); last = now;
        if (active()) d += dt * 0.34 * speed;
        place(Math.min(d, len));
        if (d >= len) { p.classList.remove('live'); res(); } else raf(tick);
      }
      raf(tick);
    });
  }
  async function send(g, label, kind, p, reverse = false, ghost = false) {
    const t = token(label, kind, ghost);
    await travel(g, t, p, reverse);
    t.remove();
  }

  /* ---------- Panels ---------- */
  function log(cls, verb, html) {
    const ol = $('#log'); if (!ol) return;
    const li = document.createElement('li');
    li.innerHTML = `<span class="t">${(RUN.simT / 1000).toFixed(1)}s</span><span class="v ${cls}">${verb}</span><span class="m">${html}</span>`;
    ol.appendChild(li);
    ol.scrollTop = ol.scrollHeight;
  }
  function verdict(text, cls = '') { const p = $('#verdict'); if (p) { p.className = 'pill ' + cls; p.textContent = text; } }
  function note(html) { const n = $('#note'); if (n) n.innerHTML = html; }
  function kv(sel, rows) { const d = $(sel); if (d) d.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join(''); }

  /* ---------- Controls ---------- */
  function sync() {
    const b = $('#play');
    if (b) b.textContent = RUN.done ? 'Replay' : RUN.playing ? 'Pause' : RUN.running ? 'Resume' : 'Run';
  }
  function reset() {
    RUN.gen++;
    Object.assign(RUN, { playing: false, stepping: false, running: false, done: false, simT: 0 });
    const ol = $('#log'); if (ol) ol.innerHTML = '';
    verdict('NOT STARTED', '');
    note('');
    O.reset();
    sync();
  }
  function startRun() {
    if (RUN.running) return;
    RUN.running = true;
    verdict('RUNNING', 'run');
    const g = RUN.gen;
    Promise.resolve().then(() => O.run(g)).then(() => {
      if (g !== RUN.gen) return;
      if (O.finish) O.finish();
      Object.assign(RUN, { running: false, playing: false, stepping: false, done: true });
      sync();
    }).catch(e => { if (e !== CANCEL) console.error(e); });
  }
  function play() {
    if (RUN.done) reset();
    if (RUN.running && RUN.playing) { RUN.playing = false; sync(); return; }
    RUN.playing = true;
    startRun();
    sync();
  }
  function stepOnce() {
    if (RUN.done) reset();
    RUN.playing = false;
    RUN.stepping = true;
    startRun();
    sync();
  }
  function restart() { reset(); play(); }
  function bindSelect(sel, onChange) {
    const s = $(sel);
    if (params.has(s.id) && [...s.options].some(o => o.value === params.get(s.id))) s.value = params.get(s.id);
    onChange(s.value);
    s.addEventListener('change', () => { onChange(s.value); restart(); });
    return s;
  }
  function bindSeg(sel, onChange) {
    const box = $(sel), btns = [...box.querySelectorAll('button[data-value]')];
    const key = box.id;
    const pick = v => { btns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === v))); onChange(v); };
    const pre = btns.find(b => b.getAttribute('aria-pressed') === 'true') || btns[0];
    pick(params.has(key) && btns.some(b => b.dataset.value === params.get(key)) ? params.get(key) : pre.dataset.value);
    btns.forEach(b => b.addEventListener('click', () => { if (b.getAttribute('aria-pressed') !== 'true') { pick(b.dataset.value); restart(); } }));
    return { pick };
  }
  function init(opts) {
    O = opts;
    $('#play').addEventListener('click', play);
    $('#step').addEventListener('click', stepOnce);
    $('#reset').addEventListener('click', reset);
    const sp = $('#speed');
    if (sp) sp.addEventListener('input', () => { speed = +sp.value; $('#speedOut').textContent = speed + '×'; });
    reset();
    if (!params.has('noplay')) setTimeout(play, FAST ? 0 : 500);
  }

  return { NS, $, RUN, CANCEL, FAST, hex, esc, el, txt, sleep, frame, checkpoint, stage, path, node, exchange, queue, table,
    token, travel, send, log, verdict, note, kv, init, restart, bindSelect, bindSeg, all: Promise.all.bind(Promise),
    get simT() { return RUN.simT; } };
})();
