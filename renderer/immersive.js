// Immersive reader: shows exactly N visual lines of the document at a time.
// Lines are measured from the rendered text, so wrapped lines, headings and mixed
// font sizes all count correctly. Images are always shown whole as one "line".
window.Immersive = (function () {
  const card = document.getElementById('imm');
  const vp = document.getElementById('imm-viewport');
  const track = document.getElementById('imm-track');
  const content = document.getElementById('imm-content');
  const empty = document.getElementById('imm-empty');
  const posEl = document.getElementById('imm-pos');

  let lines = [];          // [{t, b, img}] in px relative to content top (visual, after zoom)
  let chunks = null;       // for 1/2-line modes: [{s, e}] line ranges; null = sliding window
  let start = 0;           // index of first visible line
  let pinned = false;      // after a heading jump: keep that heading on the first line, even at the end
  let opts = { lines: 25, zoom: 1, step: 3, flatHeadings: true };
  let heads = [];          // line index where each heading starts (for heading jumps)
  let lastHtml = '';
  let maxH = 900;          // max card height (screen work area)
  let active = false;
  let lastWidth = 0;
  let onChange = () => {};
  let wheelAcc = 0;
  let measureQueued = false;

  function isDark() { return matchMedia('(prefers-color-scheme: dark)').matches; }

  // Make pasted colours readable on the overlay background.
  function adaptColors() {
    const dark = isDark();
    content.querySelectorAll('[style]').forEach(el => {
      const c = el.style.color;
      const m = c && c.match(/rgba?\(([^)]+)\)/);
      if (m) {
        const [r, g, b] = m[1].split(/[\s,\/]+/).map(Number);
        const L = colorLum(c);
        const grey = Math.max(r, g, b) - Math.min(r, g, b) < 40;
        if ((dark && L < 0.16) || (!dark && L > 0.8)) {
          if (grey) el.style.removeProperty('color');              // black/white/grey → theme text colour
          else {                                                     // keep the hue, just make it readable
            const k = dark ? 0.45 : -0.45;
            const f = v => Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k));
            el.style.color = `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
          }
        }
      }
      const bg = el.style.backgroundColor;
      if (bg && colorAlpha(bg) > 0) {
        const L = colorLum(bg);
        if (L !== null && dark && L > 0.85 && L < 1) { el.style.color = '#111'; }
        else if (L !== null && dark && L >= 0.97) el.style.removeProperty('background-color');
      }
    });
  }

  const HEAD_SEL = 'h1,h2,h3,h4,h5,h6';
  function load(html, startLine) {
    lastHtml = html;
    content.innerHTML = html;
    content.classList.add('doc');
    content.classList.toggle('flat-headings', !!opts.flatHeadings);
    if (opts.flatHeadings) {
      // pasted headings often carry their size inline (e.g. Google Docs) — drop it, keep the rest
      content.querySelectorAll(`:is(${HEAD_SEL}, p.subtitle) [style], :is(${HEAD_SEL}, p.subtitle)[style]`)
        .forEach(el => el.style.removeProperty('font-size'));
    }
    content.querySelectorAll('[contenteditable]').forEach(e => e.removeAttribute('contenteditable'));
    adaptColors();
    content.querySelectorAll('img').forEach(img => {
      if (!img.complete) img.addEventListener('load', () => queueMeasure(), { once: true });
    });
    start = Math.max(0, startLine | 0);
    pinned = false;
    lastWidth = 0;
    measureAndRender(false);
  }

  function setOptions(o) {
    const keepTop = lines[start] ? lines[start].t / (opts.zoom || 1) : 0;
    const zoomChanged = o.zoom !== undefined && o.zoom !== opts.zoom;
    const headsChanged = o.flatHeadings !== undefined && o.flatHeadings !== opts.flatHeadings;
    Object.assign(opts, o);
    if (o.maxH) maxH = o.maxH;
    if (!active) return;
    if (headsChanged && lastHtml) { load(lastHtml, start); return; }
    measure();
    if (zoomChanged) start = nearestLine(keepTop * opts.zoom);
    buildChunks();
    render();
  }

  function nearestLine(y) {
    let best = 0, d = Infinity;
    lines.forEach((l, i) => { const dd = Math.abs(l.t - y); if (dd < d) { d = dd; best = i; } });
    return best;
  }

  function measure() {
    const z = opts.zoom || 1;
    const w = vp.clientWidth;
    content.style.zoom = z;
    content.style.width = (w / z) + 'px';
    document.documentElement.style.setProperty('--imm-img-max', Math.max(40, (maxH * 0.8) / z) + 'px');
    track.style.transform = 'translateY(0px)';
    const base = content.getBoundingClientRect().top;
    const rects = [];
    const range = document.createRange();
    const tw = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.nodeValue.replace(/[\s​]/g, '') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    });
    while (tw.nextNode()) {
      range.selectNodeContents(tw.currentNode);
      for (const r of range.getClientRects()) {
        if (r.width > 0.5 && r.height > 0.5) rects.push({ t: r.top - base, b: r.bottom - base, img: false });
      }
    }
    content.querySelectorAll('img').forEach(im => {
      const r = im.getBoundingClientRect();
      if (r.height > 1 && r.width > 1) rects.push({ t: r.top - base, b: r.bottom - base, img: true });
    });
    rects.sort((a, b) => a.t - b.t || a.b - b.b);
    lines = [];
    for (const r of rects) {
      const last = lines[lines.length - 1];
      if (last) {
        const ov = Math.min(last.b, r.b) - Math.max(last.t, r.t);
        const minH = Math.min(last.b - last.t, r.b - r.t);
        if (ov > minH * 0.5 || (last.img && r.t < last.b - 1)) {
          last.t = Math.min(last.t, r.t); last.b = Math.max(last.b, r.b); last.img = last.img || r.img;
          continue;
        }
      }
      lines.push({ ...r });
    }
    heads = [];
    content.querySelectorAll(HEAD_SEL).forEach(h => {
      if (!h.textContent.trim()) return;
      const top = h.getBoundingClientRect().top - base;
      const i = lines.findIndex(l => l.b > top + 1);
      if (i >= 0 && heads[heads.length - 1] !== i) heads.push(i);
    });
    lastWidth = w;
  }

  function buildChunks() {
    const N = opts.lines;
    if (N >= 3) { chunks = null; return; }
    chunks = [];
    let cur = null;
    const headSet = new Set(heads);
    lines.forEach((L, i) => {
      if (headSet.has(i) && cur) { chunks.push(cur); cur = null; }   // a heading always starts a view
      if (L.img) { if (cur) chunks.push(cur); cur = null; chunks.push({ s: i, e: i }); return; }
      if (!cur) cur = { s: i, e: i }; else cur.e = i;
      if (cur.e - cur.s + 1 >= N) { chunks.push(cur); cur = null; }
    });
    if (cur) chunks.push(cur);
  }
  function chunkIndexFor(line) {
    if (!chunks || !chunks.length) return 0;
    for (let i = 0; i < chunks.length; i++) if (chunks[i].e >= line) return i;
    return chunks.length - 1;
  }

  function range() {
    if (!lines.length) return null;
    if (chunks) {
      const ci = chunkIndexFor(start);
      return { s: chunks[ci].s, e: chunks[ci].e, ci };
    }
    const N = opts.lines;
    const s = Math.max(0, Math.min(start, lines.length - 1));
    let e = Math.min(lines.length - 1, s + N - 1);
    while (e > s && lines[e].b - lines[s].t > maxH) e--;   // never taller than the screen
    return { s, e };
  }

  function render() {
    const padY = parseFloat(getComputedStyle(card).paddingTop) || 0;
    const border = 2;
    if (!lines.length) {
      empty.hidden = false; vp.style.height = '0px';
      fitHeight(Math.ceil(empty.offsetHeight + padY * 2 + border));
      posEl.textContent = '';
      return;
    }
    empty.hidden = true;
    // In sliding mode keep the window full near the end of the document
    // (not after a heading jump — that heading stays on the first line).
    if (!chunks && !pinned) {
      let s = Math.min(start, lines.length - 1);
      const e = Math.min(lines.length - 1, s + opts.lines - 1);
      if (e === lines.length - 1) {
        while (s > 0 && (e - (s - 1) + 1) <= opts.lines && lines[e].b - lines[s - 1].t <= maxH) s--;
      }
      start = s;
    }
    const r = range();
    start = r.s;
    let top = lines[r.s].t, bottom = lines[r.e].b;
    const prev = lines[r.s - 1], next = lines[r.e + 1];
    // If neighbouring lines overlap our box (tight line spacing), split the difference.
    // Images always win: never show a sliver of a neighbouring image, never crop the current one.
    if (prev && prev.img) top = Math.max(top, Math.ceil(prev.b) + 1);
    else if (prev && prev.b > top && !lines[r.s].img) top = (prev.b + top) / 2;
    if (next && next.img) bottom = Math.min(bottom, Math.floor(next.t) - 1);
    else if (next && next.t < bottom && !lines[r.e].img) bottom = (next.t + bottom) / 2;
    if (bottom <= top) bottom = top + 1;
    let h = Math.max(1, bottom - top);
    // Pinned with fewer lines left than the view holds: keep the box as tall as a full view
    // at the end of the document would be, and leave the rest blank.
    if (pinned && !chunks && r.e - r.s + 1 < opts.lines && r.e === lines.length - 1) {
      const full = lines[r.e].b - lines[Math.max(0, r.e - opts.lines + 1)].t;
      h = Math.max(h, Math.min(maxH, full));
    }
    vp.style.height = h + 'px';
    track.style.transform = `translateY(${-top}px)`;
    fitHeight(Math.ceil(h + padY * 2 + border));
    posEl.textContent = chunks ? `${r.ci + 1}/${chunks.length}` : `${r.s + 1}–${r.e + 1}/${lines.length}`;
    onChange(start);
  }

  let fitTimer = null, wantH = 0;
  function fitHeight(h) {
    wantH = h;
    if (Math.abs(window.innerHeight - h) < 1) return;
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => api.call('win:setBounds', { height: wantH, immersiveOnly: true }), 0);
  }

  function measureAndRender(keep = true) {
    if (!active) return;
    let anchor = 0;
    if (keep && lines.length) {
      const total = lines[lines.length - 1].b || 1;
      anchor = (lines[start] ? lines[start].t : 0) / total;
    }
    measure();
    if (keep && lines.length) start = nearestLine(anchor * (lines[lines.length - 1].b || 1));
    buildChunks();
    render();
  }
  function queueMeasure() {
    if (measureQueued) return;
    measureQueued = true;
    requestAnimationFrame(() => { measureQueued = false; measureAndRender(true); });
  }

  function go(dir, big) {
    if (!lines.length) return;
    if (pinned && dir > 0 && !chunks) {
      const r = range();
      if (r && r.e >= lines.length - 1) return;   // already showing the end — don't slide back up
    }
    const wasPinned = pinned;
    pinned = false;
    if (chunks) {
      const ci = Math.max(0, Math.min(chunks.length - 1, chunkIndexFor(start) + dir));
      start = chunks[ci].s;
    } else {
      const r0 = range();
      const view = r0 ? r0.e - r0.s + 1 : opts.lines;
      // step -1 = move a whole view at a time
      const step = big ? Math.max(1, opts.lines - 2) : opts.step === -1 ? view : Math.max(1, opts.step || 3);
      start = Math.max(0, Math.min(lines.length - 1, start + dir * step));
      if (dir > 0) {
        const r = range();
        if (r && r.e >= lines.length - 1) start = Math.min(start, r.s);
      }
      // scrolling up from a pinned heading moves one step, not straight back to a full view
      if (wasPinned && dir < 0) { pinned = true; const r = range(); pinned = !!r && r.e - r.s + 1 < opts.lines; }
    }
    render();
  }
  // Jump to the next / previous heading; returns false when there isn't one.
  function jumpHeading(dir) {
    if (!lines.length || !heads.length) return false;
    const cur = chunks ? chunks[chunkIndexFor(start)].s : start;
    const target = dir > 0 ? heads.find(h => h > cur) : [...heads].reverse().find(h => h < cur);
    if (target === undefined) return false;
    start = target;
    pinned = true;
    render();
    return true;
  }
  // Enter the overlay with a document in one go: one measure + one resize. (Activating first
  // and loading afterwards laid out the previous document's text, then this one — visible flicker.)
  function open(html, startLine, o) {
    if (o) { Object.assign(opts, o); if (o.maxH) maxH = o.maxH; }
    active = true;
    load(html, startLine);
  }
  function home() { start = 0; pinned = false; render(); }
  function end() { start = lines.length - 1; pinned = false; if (chunks) start = chunks[chunks.length - 1].s; render(); }

  card.addEventListener('wheel', (e) => {
    if (!active) return;
    e.preventDefault();
    if (e.ctrlKey) { window.dispatchEvent(new CustomEvent('imm-zoom', { detail: e.deltaY < 0 ? 0.1 : -0.1 })); return; }
    wheelAcc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    if (Math.abs(wheelAcc) >= 50) {        // one mouse-wheel notch (~100) = one step
      const steps = Math.min(5, Math.max(1, Math.round(Math.abs(wheelAcc) / 100)));
      for (let i = 0; i < steps; i++) go(wheelAcc > 0 ? 1 : -1);
      wheelAcc = 0;
    }
    clearTimeout(card._wt); card._wt = setTimeout(() => { wheelAcc = 0; }, 250);
  }, { passive: false });

  new ResizeObserver(() => {
    if (active && Math.abs(vp.clientWidth - lastWidth) > 0.5) queueMeasure();
  }).observe(card);

  return {
    load, open, setOptions, go, home, end, jumpHeading,
    relayout: () => queueMeasure(),
    setActive(v) { active = v; if (v) { lastWidth = 0; measureAndRender(true); } },
    onPosition(fn) { onChange = fn; },
    get start() { return start; },
    get count() { return lines.length; },
    _debug: () => ({ lines, chunks, start, opts })
  };
})();
