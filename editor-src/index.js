// Interview Notes — the document editor (ProseMirror via TipTap).
// Bundled into renderer/editor.bundle.js by `npm run build:editor`; app.js uses window.LNEditor.
//
// Documents are still saved as plain HTML. The schema below keeps the formatting that Google Docs
// and Word pastes carry (inline styles on paragraphs, list items and text), but — unlike the old
// contenteditable editor — it never lets a heading wrap a list, a paragraph wrap a list, etc.
import { Editor, Extension, Mark, Node, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey, NodeSelection, TextSelection, EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import { TextStyle, Color, FontFamily, FontSize, BackgroundColor } from '@tiptap/extension-text-style'
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import { HardBreak } from '@tiptap/extension-hard-break'
import { Bold } from '@tiptap/extension-bold'
import { Italic } from '@tiptap/extension-italic'
import { Underline } from '@tiptap/extension-underline'
import { Strike } from '@tiptap/extension-strike'
import { Heading } from '@tiptap/extension-heading'
import { Paragraph } from '@tiptap/extension-paragraph'
import { Blockquote } from '@tiptap/extension-blockquote'
import { CodeBlock } from '@tiptap/extension-code-block'
import { BulletList, OrderedList } from '@tiptap/extension-list'
import { UndoRedo } from '@tiptap/extensions'

// Every shortcut (bold, headings, lists, undo, …) is set in the app's Settings and handled by app.js,
// so these extensions lose their built-in keys — otherwise Ctrl+B would still bold after rebinding.
// Enter / Backspace / Tab in lists and tables are editing keys and stay.
const noKeys = ext => ext.extend({ addKeyboardShortcuts() { return {} } })

/* ---------------- HTML clean-up before parsing ---------------- */
const KEEP_CLASSES = ['title', 'subtitle', 'checklist', 'ln-table', 'ln-ink']
const BLOCK_TAGS = new Set(['P', 'DIV', 'UL', 'OL', 'LI', 'TABLE', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'FIGURE'])
const MAX_PT = 10

// font-size in pt, or null if it can't be told
function sizeInPt(v) {
  v = String(v || '').trim().toLowerCase()
  const kw = { 'xx-small': 7, 'x-small': 7.5, small: 10, medium: 12, large: 13.5, 'x-large': 18, 'xx-large': 24, 'xxx-large': 36, larger: 12, smaller: 8 }
  if (kw[v] !== undefined) return kw[v]
  const m = v.match(/^(-?\d*\.?\d+)\s*(pt|px|em|rem|%)?$/)
  if (!m) return null
  const n = parseFloat(m[1])
  switch (m[2]) {
    case 'px': return n * 0.75
    case 'em': case 'rem': return n * MAX_PT
    case '%': return (n / 100) * MAX_PT
    default: return n
  }
}

// Turns stored / pasted HTML into something that maps cleanly onto the editor's schema.
// Fixes the structures the old editor (and Google Docs' clipboard) produce:
//  - a heading or paragraph wrapping lists / paragraphs (shows as normal text, but counted as a heading)
//  - a list placed directly inside another list (Chrome's "indent", Google Docs' nesting)
//  - truly empty <p></p> (invisible in a browser, but would become a blank line)
//  - text bigger than 10 pt
export function normalizeHtml(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html')
  const body = doc.body
  const tw = doc.createTreeWalker(body, NodeFilter.SHOW_COMMENT)
  const comments = []
  while (tw.nextNode()) comments.push(tw.currentNode)
  comments.forEach(c => c.remove())

  body.querySelectorAll('font').forEach(f => {
    const s = doc.createElement('span')
    if (f.getAttribute('style')) s.setAttribute('style', f.getAttribute('style'))
    if (f.getAttribute('color')) s.style.color = f.getAttribute('color')
    if (f.getAttribute('face')) s.style.fontFamily = f.getAttribute('face')
    if (f.className) s.className = f.className
    s.append(...f.childNodes)
    f.replaceWith(s)
  })
  body.querySelectorAll('big').forEach(b => b.replaceWith(...b.childNodes))

  // headings / paragraphs that contain blocks: keep the blocks, wrap loose inline runs in the original tag
  const hasBlockChild = el => [...el.children].some(c => BLOCK_TAGS.has(c.tagName))
  let wrappers
  while ((wrappers = [...body.querySelectorAll('h1,h2,h3,h4,h5,h6,p')].filter(hasBlockChild)).length) {
    const el = wrappers[wrappers.length - 1] // innermost first
    const out = []
    let run = null
    const flush = () => {
      if (run && (run.textContent.trim() || run.querySelector('img,br'))) out.push(run)
      run = null
    }
    for (const n of [...el.childNodes]) {
      if (n.nodeType === 1 && BLOCK_TAGS.has(n.tagName)) { flush(); out.push(n) } else {
        if (!run) { run = el.cloneNode(false) }
        run.appendChild(n)
      }
    }
    flush()
    el.replaceWith(...out)
  }

  // list directly inside a list → belongs to the item before it. That item's own text colour /
  // weight / style must not spill onto the moved list (Google Docs colours a bullet via its <li>).
  body.querySelectorAll('ul > ul, ul > ol, ol > ul, ol > ol').forEach(list => {
    const prev = list.previousElementSibling
    if (prev && prev.tagName === 'LI') {
      const from = list.parentElement
      for (const prop of ['color', 'font-weight', 'font-style']) {
        if (!prev.style.getPropertyValue(prop) || list.style.getPropertyValue(prop)) continue
        let v = ''
        for (let a = from; a && a !== body && !v; a = a.parentElement) v = a.style.getPropertyValue(prop)
        if (v) list.style.setProperty(prop, v)
        else if (prop === 'color') list.classList.add('ln-ink') // the page's default text colour
        else list.style.setProperty(prop, 'normal')
      }
      prev.appendChild(list)
    } else { const li = doc.createElement('li'); list.replaceWith(li); li.appendChild(list) }
  })
  // stray text / paragraphs directly in a list
  body.querySelectorAll('ul, ol').forEach(list => {
    for (const n of [...list.childNodes]) {
      if (n.nodeType === 3 && !n.nodeValue.trim()) { n.remove(); continue }
      if (n.nodeType === 1 && n.tagName === 'LI') continue
      const li = doc.createElement('li')
      n.replaceWith(li)
      li.appendChild(n)
    }
  })

  // empty blocks that never showed (no <br>, no text)
  body.querySelectorAll('p, h1, h2, h3, h4, h5, h6').forEach(el => {
    if (!el.textContent.length && !el.querySelector('br,img')) el.remove()
  })
  // A browser ignores a <br> at the very end of a block ("text<br>" is one line, "<br>" alone is a
  // blank line). The editor would keep it as a real line break, so drop it — an empty block is a
  // blank line in the editor too.
  body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote, div').forEach(el => {
    let n = el.lastChild
    while (n) {
      if (n.nodeType === 3 && !n.nodeValue.trim() && n.previousSibling) { n = n.previousSibling; continue }
      if (n.nodeType === 1 && n.tagName === 'BR') { n.remove(); break }
      if (n.nodeType === 1 && !BLOCK_TAGS.has(n.tagName) && n.tagName !== 'IMG') { n = n.lastChild; continue }
      break
    }
  })

  // a heading whose text was all set to "not bold" stays not bold (kept on the heading itself)
  body.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(h => {
    const tw = doc.createTreeWalker(h, NodeFilter.SHOW_TEXT)
    let any = false, allNormal = true
    while (tw.nextNode()) {
      if (!tw.currentNode.nodeValue.trim()) continue
      any = true
      let normal = false
      for (let a = tw.currentNode.parentElement; a && a !== h.parentElement; a = a.parentElement) {
        const w = a.style.fontWeight
        if (w) { normal = w === 'normal' || +w < 600; break }
      }
      if (!normal) { allNormal = false; break }
    }
    if (any && allNormal) h.style.fontWeight = 'normal'
  })
  body.querySelectorAll('[style]').forEach(el => {
    // nothing bigger than 10 pt
    const pt = el.style.fontSize ? sizeInPt(el.style.fontSize) : null
    if (pt !== null && pt > MAX_PT + 0.01) el.style.fontSize = MAX_PT + 'pt'
    // A colour that points at one of the app's own theme variables (copied within the old editor,
    // e.g. "var(--page-text)") is really "default text colour" — black on the page, but invisible
    // on the dark overlay. Same for a background.
    if (/var\(/.test(el.style.color)) { el.style.removeProperty('color'); el.classList.add('ln-ink') }
    if (/var\(/.test(el.style.backgroundColor)) el.style.removeProperty('background-color')
    // Google Docs puts "background-color: transparent" on every piece of text
    if (/^(transparent|rgba\(0, 0, 0, 0\))$/.test(el.style.backgroundColor)) el.style.removeProperty('background-color')
    // underline / strikethrough written as text-decoration-line (the editor reads text-decoration)
    const deco = el.style.textDecorationLine
    if (deco && deco !== 'none' && !/text-decoration\s*:/.test(el.getAttribute('style'))) {
      el.style.removeProperty('text-decoration-line')
      el.style.textDecoration = deco
    }
    if (!el.getAttribute('style').trim()) el.removeAttribute('style')
  })
  return body.innerHTML
}

/* ---------------- schema extensions ---------------- */
const JUNK_STYLE = /^(white-space|caret-color|font-variant[\w-]*|text-wrap[\w-]*|vertical-align|user-select|cursor|position|z-index|top|left|right|bottom|overflow|max-height)$/
function cleanStyle(style, { dropListType = false } = {}) {
  if (!style) return null
  const out = []
  for (const part of style.split(';')) {
    const i = part.indexOf(':')
    if (i < 0) continue
    const k = part.slice(0, i).trim().toLowerCase()
    const v = part.slice(i + 1).trim()
    if (!k || !v || JUNK_STYLE.test(k)) continue
    if (k === 'background-color' && /transparent|rgba\([^)]*,\s*0\)/.test(v)) continue
    if (dropListType && k === 'list-style-type') continue
    out.push(`${k}: ${v}`)
  }
  return out.length ? out.join('; ') + ';' : null
}
// set / remove CSS properties in a style string
export function patchStyle(style, props) {
  const map = new Map()
  for (const part of String(style || '').split(';')) {
    const i = part.indexOf(':')
    if (i > 0) map.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim())
  }
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === '') map.delete(k)
    else map.set(k, String(v))
  }
  const s = [...map].map(([k, v]) => `${k}: ${v}`).join('; ')
  return s ? s + ';' : null
}
export function styleProp(style, prop) {
  for (const part of String(style || '').split(';')) {
    const i = part.indexOf(':')
    if (i > 0 && part.slice(0, i).trim().toLowerCase() === prop) return part.slice(i + 1).trim()
  }
  return null
}

const STYLED_BLOCKS = ['paragraph', 'heading', 'listItem', 'bulletList', 'orderedList', 'blockquote', 'tableCell', 'tableHeader', 'codeBlock', 'table']
const BlockAttrs = Extension.create({
  name: 'blockAttrs',
  addGlobalAttributes() {
    return [
      {
        types: STYLED_BLOCKS,
        attributes: {
          style: {
            default: null,
            keepOnSplit: true,
            parseHTML: el => cleanStyle(el.getAttribute('style'), { dropListType: el.tagName === 'LI' }),
            renderHTML: a => (a.style ? { style: a.style } : {}),
          },
        },
      },
      {
        types: ['paragraph', 'heading', 'listItem', 'bulletList', 'orderedList', 'table'],
        attributes: {
          class: {
            default: null,
            keepOnSplit: false,
            parseHTML: el => [...el.classList].filter(c => KEEP_CLASSES.includes(c)).join(' ') || null,
            renderHTML: a => (a.class ? { class: a.class } : {}),
          },
        },
      },
      {
        types: ['listItem'],
        attributes: {
          checked: {
            default: null,
            keepOnSplit: false,
            parseHTML: el => (el.getAttribute('data-checked') === 'true' ? 'true' : null),
            renderHTML: a => (a.checked ? { 'data-checked': 'true' } : {}),
          },
        },
      },
    ]
  },
})

// "Default text colour" for black text pasted inside coloured text (see paste.js)
const Ink = Mark.create({
  name: 'ink',
  parseHTML: () => [{ tag: 'span.ln-ink', consuming: false }], // (on blocks it's kept as a class)
  renderHTML: () => ['span', { class: 'ln-ink' }, 0],
})

const Image = Node.create({
  name: 'image',
  inline: true,
  group: 'inline',
  atom: true,
  draggable: true,
  addAttributes() {
    const attr = name => ({ default: null, parseHTML: el => el.getAttribute(name), renderHTML: a => (a[name] ? { [name]: a[name] } : {}) })
    return { src: attr('src'), alt: attr('alt'), title: attr('title'), width: attr('width'), height: attr('height'), style: attr('style') }
  },
  parseHTML: () => [{ tag: 'img[src]' }],
  renderHTML: ({ HTMLAttributes }) => ['img', HTMLAttributes],
})

// A tab character. Its own node so it survives saving (plain tabs would be collapsed to spaces on reopen).
const Tab = Node.create({
  name: 'tab',
  priority: 50, // after lists and tables, which use Tab themselves
  inline: true,
  group: 'inline',
  atom: true,
  selectable: false,
  marks: '',
  parseHTML: () => [
    { tag: 'span.ln-tab', priority: 60 },
    {
      tag: 'span',
      priority: 60,
      getAttrs: el => (/^\t+$/.test(el.textContent) && /white-space:\s*pre/.test(el.getAttribute('style') || '') ? null : false),
    },
  ],
  renderHTML: () => ['span', { class: 'ln-tab', style: 'white-space:pre' }, '\t'],
  addKeyboardShortcuts() {
    return {
      // lists and tables handle Tab first (higher priority); anywhere else it types a tab
      Tab: ({ editor }) => editor.chain().insertContent({ type: 'tab' }).run() || true,
      'Shift-Tab': () => true,
    }
  },
})

// Insert → Page break, or "@page" + Tab in the document. Everything after it starts on a new page.
const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: 'div.page-break' }],
  renderHTML: () => ['div', { class: 'page-break' }],
  addCommands() {
    return {
      // splits the paragraph at the caret; the rest of it starts the next page
      insertPageBreak: () => ({ tr, dispatch, state }) => {
        if (!dispatch) return true
        tr.deleteSelection()
        const pos = tr.selection.from
        const $p = tr.doc.resolve(pos)
        const pb = state.schema.nodes.pageBreak.create()
        if ($p.parent.isTextblock && $p.depth === 1) {
          tr.split(pos)
          tr.insert(pos + 1, pb)
          tr.setSelection(TextSelection.create(tr.doc, pos + 3))
        } else {
          // inside a list or table: the break goes after that whole block
          const after = $p.after(1)
          tr.insert(after, [pb, state.schema.nodes.paragraph.create()])
          tr.setSelection(TextSelection.create(tr.doc, after + 2))
        }
        tr.scrollIntoView()
        return true
      },
    }
  },
})

/* ---------------- pages (like Google Docs' print layout) ---------------- */
// The document is laid out once, then each line that would run past the bottom of a page is pushed
// to the top of the next one by an invisible spacer (a decoration — never saved into the file).
// Spacers are either a transparent top border on a block, or a block-level widget inside a
// paragraph when a long paragraph is split across two pages.
const pagesKey = new PluginKey('pages')
function Pages(opts) {
  return Extension.create({
    name: 'pages',
    addProseMirrorPlugins() {
      return [new Plugin({
        key: pagesKey,
        state: {
          init: () => ({ breaks: [], deco: DecorationSet.empty }),
          apply(tr, v, _old, state) {
            const m = tr.getMeta(pagesKey)
            if (m) return { breaks: m, deco: buildPageDeco(state.doc, m) }
            if (tr.docChanged) return { breaks: v.breaks, deco: v.deco.map(tr.mapping, tr.doc) }
            return v
          },
        },
        props: { decorations: s => pagesKey.getState(s).deco },
        view: view => {
          let raf = 0
          const run = () => {
            raf = 0
            if (view.isDestroyed) return
            if (view.composing) { schedule(); return }
            paginate(view, opts)
          }
          const schedule = () => { if (!raf) raf = requestAnimationFrame(run) }
          view.dom.addEventListener('load', schedule, true) // images
          view.__paginate = schedule
          schedule()
          return {
            update(v, prev) { if (prev.doc !== v.state.doc) schedule() },
            destroy() { cancelAnimationFrame(raf) },
          }
        },
      })]
    },
  })
}
function buildPageDeco(doc, breaks) {
  const decos = []
  for (const b of breaks) {
    if (b.kind === 'node') {
      const node = doc.nodeAt(b.pos)
      if (!node) continue
      decos.push(Decoration.node(b.pos, b.pos + node.nodeSize, { class: 'pb-push', style: `--pb:${b.h}px` }, { pb: b.h }))
    } else {
      const el = document.createElement(b.kind === 'widget' ? 'div' : 'span')
      el.className = 'pb-gap'
      el.style.height = b.h + 'px'
      el.contentEditable = 'false'
      decos.push(Decoration.widget(b.pos, el, { side: -1, key: 'pb' + b.pos + ':' + b.h, pb: b.h, ignoreSelection: true }))
    }
  }
  return DecorationSet.create(doc, decos)
}

// Document position of the first character on a line. (Works for lines scrolled out of view,
// which ProseMirror's posAtCoords can't do.)
function lineStart(view, L) {
  const n = L.n
  if (!n) return null
  if (n.nodeType === 1) return view.posAtDOM(n.parentNode, Array.prototype.indexOf.call(n.parentNode.childNodes, n))
  const r = document.createRange()
  const top = i => { r.setStart(n, i); r.setEnd(n, i + 1); const q = r.getBoundingClientRect(); return q.top }
  let lo = 0, hi = n.nodeValue.length - 1, ans = -1
  while (lo <= hi) { // first character whose top is on this line (tops only grow along a text node)
    const mid = (lo + hi) >> 1
    if (top(mid) >= L.top - L.h / 2) { ans = mid; hi = mid - 1 } else lo = mid + 1
  }
  return ans < 0 ? null : view.posAtDOM(n, ans)
}

function paginate(view, opts) {
  const { pageH, gap } = opts
  const ed = view.dom
  const cs = getComputedStyle(ed)
  const pad = parseFloat(cs.paddingTop) || 0
  const P = pageH + gap
  const contentH = pageH - 2 * pad
  const edRect = ed.getBoundingClientRect()
  const z = edRect.height / (ed.offsetHeight || 1) || 1
  const Y = clientY => (clientY - edRect.top) / z - pad // unzoomed, from the first page's text area

  // spacers currently on screen: [start, height]
  const spacers = []
  ed.querySelectorAll('.pb-push').forEach(el => spacers.push([Y(el.getBoundingClientRect().top), parseFloat(el.style.getPropertyValue('--pb')) || 0]))
  ed.querySelectorAll('.pb-gap').forEach(el => spacers.push([Y(el.getBoundingClientRect().top), parseFloat(el.style.height) || 0]))
  spacers.sort((a, b) => a[0] - b[0])
  // where y would be without the spacers above it (a block's own spacer starts at its top edge)
  const natural = y => {
    let s = 0
    for (const [st, h] of spacers) { if (st < y - 0.5) s += h; else break }
    return y - s
  }

  // units: lines of text (or whole tables / rules), in document order
  const units = []
  const range = document.createRange()
  view.state.doc.descendants((node, pos, parent, index) => {
    if (node.type.name === 'pageBreak') { units.push({ force: true }); return false }
    if (node.type.name === 'table' || node.type.name === 'horizontalRule') {
      const dom = view.nodeDOM(pos)
      if (!dom || !dom.getBoundingClientRect) return false
      // pushed by a block-level spacer placed just before it
      const r = dom.getBoundingClientRect()
      const t = natural(Y(r.top))
      units.push({ top: t, bottom: t + r.height / z, anchorTop: t, anchor: { kind: 'widget', pos }, first: true })
      return false
    }
    if (!node.isTextblock) return true
    const dom = view.nodeDOM(pos)
    if (!dom || dom.nodeType !== 1) return false
    // the box that moves when this block moves: a list item's first paragraph moves the whole item
    let target = pos, targetDom = dom
    {
      const $p = view.state.doc.resolve(pos)
      let d = $p.depth
      let childIndex = $p.index(d)
      while (d > 0 && $p.node(d).type.name === 'listItem' && childIndex === 0) {
        target = $p.before(d)
        targetDom = view.nodeDOM(target) || targetDom
        childIndex = $p.index(d - 1)
        d--
      }
    }
    const lines = []
    const tw = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: n => {
        if (n.nodeType === 1) {
          if (n.classList.contains('pb-gap')) return NodeFilter.FILTER_REJECT
          return n.tagName === 'IMG' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
        }
        return n.nodeValue.length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
      },
    })
    while (tw.nextNode()) {
      const n = tw.currentNode
      let rects
      if (n.nodeType === 1) rects = [n.getBoundingClientRect()]
      else { range.selectNodeContents(n); rects = range.getClientRects() }
      for (const r of rects) {
        if (r.height < 0.5 && r.width < 0.5) continue
        const t = Y(r.top), b = Y(r.bottom)
        const last = lines[lines.length - 1]
        if (last && Math.min(last.b, b) - Math.max(last.t, t) > Math.min(last.b - last.t, b - t) * 0.5) {
          last.t = Math.min(last.t, t); last.b = Math.max(last.b, b); last.l = Math.min(last.l, r.left); last.n = last.n || n
        } else lines.push({ t, b, l: r.left, top: r.top, h: r.height, n })
      }
    }
    if (!lines.length) { // empty paragraph
      const r = dom.getBoundingClientRect()
      const own = dom.classList.contains('pb-push') ? parseFloat(dom.style.getPropertyValue('--pb')) || 0 : 0
      lines.push({ t: Y(r.top) + own, b: Y(r.bottom), l: r.left, top: r.top, h: r.height })
    }
    const tr = targetDom.getBoundingClientRect ? targetDom.getBoundingClientRect() : dom.getBoundingClientRect()
    const anchorTop = natural(Y(tr.top))
    const isHeading = node.type.name === 'heading'
    lines.forEach((L, i) => {
      const u = { top: natural(L.t), bottom: natural(L.b), first: i === 0, last: i === lines.length - 1, heading: isHeading }
      if (i === 0) { u.anchor = { kind: 'node', pos: target }; u.anchorTop = anchorTop } else {
        // a long paragraph is split: the spacer goes in front of this line's first character
        let p = null
        try { p = lineStart(view, L) } catch { p = null }
        if (p === null || p <= pos + 1 || p >= pos + node.nodeSize - 1) u.anchor = null
        else { u.anchor = { kind: 'inline', pos: p }; u.anchorTop = u.top }
      }
      units.push(u)
    })
    return false
  })

  const breaks = []
  let acc = 0, force = false, lastBottom = 0
  for (let i = 0; i < units.length; i++) {
    const u = units[i]
    if (u.force) { force = true; continue }
    const top = u.top + acc, bottom = u.bottom + acc
    const page = Math.max(0, Math.floor((top + 0.5) / P))
    const pageEnd = page * P + contentH
    const need = force || top > pageEnd - 0.5 || (bottom > pageEnd + 0.5 && bottom - top <= contentH)
    force = false
    if (need && u.anchor) {
      let a = u
      // keep a heading with the line after it
      if (u.first && !u.heading) {
        let j = i - 1
        while (j >= 0 && units[j].heading && !units[j].first) j--
        if (j >= 0 && units[j].heading && units[j].first && units[j].anchor) {
          const ht = units[j].anchorTop + acc
          if (Math.floor((ht + 0.5) / P) === page && ht > page * P + 1) a = units[j]
        }
      }
      const at = a.anchorTop + acc
      const h = Math.round(((Math.max(page, Math.floor((at + 0.5) / P)) + 1) * P - at) * 100) / 100
      if (h > 0.5) {
        breaks.push({ kind: a.anchor.kind, pos: a.anchor.pos, h })
        acc += h
      }
    }
    lastBottom = Math.max(lastBottom, u.bottom + acc)
  }
  const pages = Math.max(1, Math.floor(Math.max(0, lastBottom - 0.5) / P) + 1)
  if (opts.onPages) opts.onPages(pages)

  const cur = pagesKey.getState(view.state).breaks
  const same = cur.length === breaks.length && cur.every((b, i) => b.kind === breaks[i].kind && b.pos === breaks[i].pos && Math.abs(b.h - breaks[i].h) < 0.6)
  if (same) return
  // keep the scroll position steady while spacers change size
  const sc = opts.scroller && opts.scroller()
  const st = sc ? sc.scrollTop : 0
  view.dispatch(view.state.tr.setMeta(pagesKey, breaks).setMeta('addToHistory', false))
  if (sc && sc.scrollTop !== st) sc.scrollTop = st
}

/* ---------------- find highlights ---------------- */
const findKey = new PluginKey('find')
const FindHighlights = Extension.create({
  name: 'findHighlights',
  addProseMirrorPlugins() {
    return [new Plugin({
      key: findKey,
      state: {
        init: () => DecorationSet.empty,
        apply(tr, set) {
          const m = tr.getMeta(findKey)
          if (m) {
            return DecorationSet.create(tr.doc, m.ranges.map((r, i) =>
              Decoration.inline(r.from, r.to, { class: i === m.current ? 'find-hit find-current' : 'find-hit' })))
          }
          return set.map(tr.mapping, tr.doc)
        },
      },
      props: { decorations: s => findKey.getState(s) },
    })]
  },
})
// every match of `q`, as document ranges (matches never cross a paragraph)
function findAll(doc, q, matchCase) {
  const out = []
  if (!q) return out
  const needle = matchCase ? q : q.toLowerCase()
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    let text = '', map = []
    node.forEach((child, off) => {
      if (child.isText) { for (let k = 0; k < child.text.length; k++) map.push(pos + 1 + off + k); text += child.text } else { map.push(pos + 1 + off); text += child.type.name === 'tab' ? '\t' : '￼' }
    })
    const hay = matchCase ? text : text.toLowerCase()
    let i = hay.indexOf(needle)
    while (i >= 0) {
      out.push({ from: map[i], to: map[i + needle.length - 1] + 1 })
      i = hay.indexOf(needle, i + needle.length)
    }
    return false
  })
  return out
}

/* ---------------- editor ---------------- */
// hooks: { onPaste(event, view) → bool, onDrop(event, view, moved) → bool, onPages(n), scroller() }
export function createEditor(element, hooks = {}) {
  const editor = new Editor({
    element,
    enableInputRules: ['bulletList', 'orderedList'], // "* " / "- " / "1. " start lists, like Google Docs
    enablePasteRules: false,
    extensions: [
      StarterKit.configure({
        code: false,
        hardBreak: false,
        bold: false, italic: false, underline: false, strike: false, heading: false, paragraph: false,
        blockquote: false, codeBlock: false, bulletList: false, orderedList: false, undoRedo: false,
        link: { openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { target: null, rel: null, class: null } },
        dropcursor: { color: '#1a73e8', width: 2 },
        trailingNode: false,
      }),
      noKeys(Paragraph), noKeys(Heading).configure({ levels: [1, 2, 3, 4, 5, 6] }),
      noKeys(Bold), noKeys(Italic), noKeys(Underline), noKeys(Strike),
      noKeys(Blockquote), noKeys(CodeBlock), noKeys(BulletList), noKeys(OrderedList),
      noKeys(UndoRedo).configure({ depth: 300 }),
      HardBreak.extend({ addKeyboardShortcuts() { return { 'Shift-Enter': () => this.editor.commands.setHardBreak() } } }),
      TextStyle.configure({ mergeNestedSpanStyles: true }),
      Color, FontFamily, FontSize, BackgroundColor,
      noKeys(Subscript), noKeys(Superscript),
      Table.configure({ resizable: false }), TableRow, TableHeader, TableCell,
      BlockAttrs, Ink, Image, Tab, PageBreak, FindHighlights,
      Pages({ pageH: hooks.pageH || 1056, gap: hooks.gap || 16, onPages: hooks.onPages, scroller: hooks.scroller }),
    ],
    editorProps: {
      attributes: { class: 'doc', spellcheck: 'true' },
      handlePaste: (view, event) => (hooks.onPaste ? !!hooks.onPaste(event, view) : false),
      handleDrop: (view, event, _slice, moved) => (hooks.onDrop ? !!hooks.onDrop(event, view, moved) : false),
      handleDOMEvents: {
        // checklist: click the box to tick it
        mousedown: (view, e) => {
          const li = e.target.closest && e.target.closest('ul.checklist > li')
          if (!li || e.button !== 0 || e.clientX >= li.getBoundingClientRect().left) return false
          const pos = view.posAtDOM(li, 0) - 1
          const node = view.state.doc.nodeAt(pos)
          if (!node || node.type.name !== 'listItem') return false
          e.preventDefault()
          view.dispatch(view.state.tr.setNodeMarkup(pos, null, { ...node.attrs, checked: node.attrs.checked ? null : 'true' }))
          return true
        },
      },
    },
  })

  const ln = {
    // replace the document without an undo step back to the old one
    load(html) {
      editor.commands.setContent(normalizeHtml(html), { emitUpdate: false })
      const st = EditorState.create({ doc: editor.state.doc, plugins: editor.state.plugins, selection: TextSelection.atStart(editor.state.doc) })
      editor.view.updateState(st)
      editor.view.__paginate && editor.view.__paginate()
    },
    // blank lines are saved as <p><br></p>, which a browser (and the overlay) shows as a blank line
    html() {
      return editor.getHTML().replace(/<(p|h[1-6])(\s[^>]*)?><\/\1>/g, '<$1$2><br></$1>')
    },
    paginate() { editor.view.__paginate && editor.view.__paginate() },
    find(q, matchCase, current = -1) {
      const ranges = findAll(editor.state.doc, q, matchCase)
      editor.view.dispatch(editor.state.tr.setMeta(findKey, { ranges, current }).setMeta('addToHistory', false))
      return ranges
    },
    clearFind() { editor.view.dispatch(editor.state.tr.setMeta(findKey, { ranges: [], current: -1 }).setMeta('addToHistory', false)) },
    // headings that have text: [{ pos, node }]
    headings() {
      const out = []
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') { if (node.textContent.trim()) out.push({ pos, node }); return false }
        return node.isBlock && !node.isTextblock
      })
      return out
    },
    // set CSS properties on every paragraph / heading in the selection
    setBlockStyle(props) {
      const { state } = editor
      const tr = state.tr
      const { from, to } = state.selection
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isTextblock) return true
        tr.setNodeMarkup(pos, null, { ...node.attrs, style: patchStyle(node.attrs.style, props) })
        return false
      })
      if (tr.docChanged) editor.view.dispatch(tr)
      return tr.docChanged
    },
    blockStyle(prop) {
      const { $from } = editor.state.selection
      for (let d = $from.depth; d > 0; d--) {
        const n = $from.node(d)
        if (n.isTextblock) return styleProp(n.attrs.style, prop)
      }
      return null
    },
    findAll: (q, mc) => findAll(editor.state.doc, q, mc),
  }
  editor.ln = ln
  return editor
}

window.LNEditor = { createEditor, normalizeHtml, patchStyle, styleProp, NodeSelection, TextSelection, sizeInPt }
