// Clipboard HTML → clean, self-contained HTML that keeps the formatting.
(function () {
  const DROP_TAGS = 'script,style,meta,link,title,xml,iframe,object,embed,noscript,form,input,button,select,textarea,svg,canvas,video,audio,base,template';
  const KEEP_CLASSES = new Set(['title', 'subtitle', 'checklist', 'ln-table']);
  // properties copied when a stylesheet (e.g. Word "MsoNormal") is resolved into inline styles
  const INLINE_PROPS = ['font-weight', 'font-style', 'text-decoration-line', 'color', 'background-color',
    'font-size', 'font-family', 'vertical-align'];
  const BLOCK_PROPS = ['text-align', 'margin-left', 'text-indent', 'line-height', 'margin-top', 'margin-bottom'];

  function rgb(str) {
    const m = String(str || '').match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function lum(c) {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  window.colorLum = (s) => { const c = rgb(s); return c ? lum(c) : null; };
  window.colorAlpha = (s) => { const c = rgb(s); return c ? c.a : 1; };

  // Resolve <style> rules (Word, web pages) into inline styles using a hidden frame.
  async function inlineStylesheets(html) {
    const ifr = document.createElement('iframe');
    ifr.setAttribute('sandbox', 'allow-same-origin');
    ifr.style.cssText = 'position:fixed;left:-20000px;top:0;width:816px;height:400px;visibility:hidden;border:0';
    document.body.appendChild(ifr);
    try {
      const d = window.docDefaults || { font: 'Arial', size: 8, ls: 1.15 };
      // Same defaults as the document, so only the source's real formatting differs and gets copied.
      const reset = `<style>body{margin:0;font-family:"${d.font}";font-size:${d.size}pt;line-height:${d.ls};color:#000}p,h1,h2,h3,h4,h5,h6,ul,ol,blockquote,figure{margin:0}h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit}</style>`;
      const safeHtml = reset + html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<img\b/gi, '<img loading="lazy" data-ln-img');
      await new Promise((res) => { ifr.onload = res; ifr.srcdoc = safeHtml; setTimeout(res, 1500); });
      const doc = ifr.contentDocument;
      if (!doc || !doc.body) return html;
      const win = ifr.contentWindow;
      const all = [...doc.body.querySelectorAll('*')];
      const computed = all.map(el => win.getComputedStyle(el));
      const bodyCs = win.getComputedStyle(doc.body);
      const csOf = new Map(all.map((el, i) => [el, computed[i]]));
      all.forEach((el, i) => {
        const cs = computed[i];
        const parent = el.parentElement;
        const pcs = csOf.get(parent) || bodyCs;
        const tag = el.tagName;
        INLINE_PROPS.forEach(prop => {
          const v = cs.getPropertyValue(prop);
          if (prop === 'background-color') {
            if (colorAlpha(v) > 0 && v !== pcs.getPropertyValue(prop) && !el.style.backgroundColor) el.style.setProperty(prop, v);
            return;
          }
          if (prop === 'text-decoration-line') {
            if (v && v !== 'none' && !/^(A|U|S|STRIKE|DEL|INS)$/.test(tag) && v !== pcs.getPropertyValue(prop)) el.style.setProperty('text-decoration', v);
            return;
          }
          if (v && v !== pcs.getPropertyValue(prop) && !el.style.getPropertyValue(prop)) el.style.setProperty(prop, v);
        });
        if (cs.display === 'block' || cs.display === 'list-item') {
          BLOCK_PROPS.forEach(prop => {
            const v = cs.getPropertyValue(prop);
            if (prop === 'text-align' && (v === 'start' || v === 'left')) return;
            if (/^margin|text-indent/.test(prop) && parseFloat(v) === 0) return;
            if (/^margin-(top|bottom)/.test(prop) && /^(UL|OL|LI|TABLE|TR|TD|TH|TBODY)$/.test(tag)) return;
            if (prop === 'line-height' && v === 'normal') return;
            if (prop === 'line-height' && v.endsWith('px')) {
              const fs = parseFloat(cs.fontSize) || 16;
              el.style.setProperty(prop, (parseFloat(v) / fs).toFixed(2));
              return;
            }
            if (!el.style.getPropertyValue(prop)) el.style.setProperty(prop, v);
          });
        }
      });
      return doc.body.innerHTML.replace(/ data-ln-img=""/g, '').replace(/ loading="lazy"/g, '');
    } catch (e) {
      console.warn('style inlining failed', e);
      return html;
    } finally { ifr.remove(); }
  }

  function sanitize(html) {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    const body = doc.body;
    // comments (Word conditional comments etc.)
    const tw = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT);
    const comments = []; while (tw.nextNode()) comments.push(tw.currentNode);
    comments.forEach(c => c.remove());
    body.querySelectorAll(DROP_TAGS).forEach(n => n.remove());
    // Word's namespaced tags like <o:p>
    [...body.querySelectorAll('*')].filter(e => e.tagName.includes(':')).forEach(e => e.replaceWith(...e.childNodes));
    // Google Docs wrapper
    body.querySelectorAll('b[id^="docs-internal-guid"]').forEach(b => b.replaceWith(...b.childNodes));

    body.querySelectorAll('*').forEach(el => {
      for (const a of [...el.attributes]) {
        const n = a.name.toLowerCase();
        if (n.startsWith('on') || n === 'id' || n === 'lang' || n === 'contenteditable' || n === 'role' || n === 'tabindex' ||
          n.startsWith('aria-') || (n.startsWith('data-') && n !== 'data-checked') || n === 'width' && el.tagName !== 'IMG' && el.tagName !== 'TD' && el.tagName !== 'COL') {
          el.removeAttribute(a.name);
        }
      }
      if (el.hasAttribute('class')) {
        const keep = [...el.classList].filter(c => KEEP_CLASSES.has(c));
        keep.length ? el.setAttribute('class', keep.join(' ')) : el.removeAttribute('class');
      }
      if (el.tagName === 'A') {
        const href = el.getAttribute('href') || '';
        if (!/^(https?:|mailto:|#)/i.test(href)) el.removeAttribute('href');
        el.removeAttribute('target');
      }
      if (el.tagName === 'IMG') {
        const src = el.getAttribute('src') || '';
        if (!/^(data:image\/|https?:|file:)/i.test(src)) { el.remove(); return; }
        el.removeAttribute('srcset');
      }
      const st = el.style;
      if (st && st.length) {
        // Default black text / white background become "theme" colours so dark mode stays readable.
        const L = colorLum(st.color);
        if (L !== null && L < 0.02) st.removeProperty('color');
        const bg = st.backgroundColor;
        if (bg && (colorAlpha(bg) === 0 || (colorLum(bg) ?? 0) > 0.97)) st.removeProperty('background-color');
        if (st.background && !st.backgroundColor) st.removeProperty('background');
        ['white-space', 'font-variant-numeric', 'font-variant-east-asian', 'font-variant-alternates', 'font-variant-position',
          'text-wrap', 'text-wrap-mode', 'position', 'z-index', 'top', 'left', 'right', 'bottom', 'overflow', 'max-height', 'cursor', 'user-select', 'caret-color']
          .forEach(p => st.removeProperty(p));
        if (st.fontWeight === 'normal' && el.tagName === 'B') { /* Google Docs uses <b style=normal> wrappers */ }
        const css = st.cssText.trim();
        css ? el.setAttribute('style', css) : el.removeAttribute('style');
      } else el.removeAttribute('style');
    });
    // unwrap attribute-less spans/fonts
    body.querySelectorAll('span:not([style]):not([class]), font:not([style]):not([color]):not([face]):not([size])').forEach(s => s.replaceWith(...s.childNodes));
    return body.innerHTML.trim();
  }

  window.cleanPastedHtml = async function (html) {
    // keep only the fragment Chrome/Word marks as copied, if present
    const frag = html.match(/<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/);
    const hasStyleSheet = /<style[\s>]/i.test(html) && /class=/i.test(html);
    let work = html;
    if (hasStyleSheet) {
      // Word & web pages: resolve classes to inline styles. Keep the <style> blocks, but cut to the fragment.
      const styles = (html.match(/<style[\s\S]*?<\/style>/gi) || []).join('');
      work = styles + (frag ? frag[1] : (html.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [, html])[1]);
      work = await inlineStylesheets(work);
    } else if (frag) work = frag[1];
    return sanitize(work);
  };
  window.sanitizeHtml = sanitize;

  // Nothing in a document is ever bigger than 10 pt (headings' own sizes are ≤ 10 pt in the CSS).
  // Shrinks inline sizes (pasted, imported or from older documents) that come out larger.
  // Works on the live DOM so em / % / px / <font size> all resolve. Returns how many changed.
  const MAX_PX = 10 * 4 / 3 + 0.05;
  window.capFontSizes = function (root) {
    let n = 0;
    root.querySelectorAll('[style*="font-size"], font[size], big').forEach(el => {
      if (parseFloat(getComputedStyle(el).fontSize) <= MAX_PX) return;
      el.removeAttribute('size');
      el.style.fontSize = '10pt';
      n++;
    });
    return n;
  };
})();
