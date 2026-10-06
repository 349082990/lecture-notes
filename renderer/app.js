/* Interview Notes — renderer */
(async function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const canvas = $("#canvas");
  const titleInput = $("#doc-title");
  const saveState = $("#save-state");
  paintIcons();

  /* ---------------- the editor (ProseMirror, see editor-src/) ---------------- */
  // Pages are 8.5 × 11 in like Google Docs' print layout, with a gap between them.
  const PAGE_H = 1056,
    PAGE_GAP = 16;
  const pagesEl = $("#pages");
  const editor = LNEditor.createEditor($("#page"), {
    pageH: PAGE_H,
    gap: PAGE_GAP,
    scroller: () => canvas,
    onPages: (n) => {
      while (pagesEl.children.length < n) pagesEl.appendChild(document.createElement("div"));
      while (pagesEl.children.length > n) pagesEl.lastChild.remove();
      ed.style.minHeight = n * PAGE_H + (n - 1) * PAGE_GAP + "px";
      updatePageCount();
    },
    onPaste: (e, view) => handlePaste(e, view),
    onDrop: (e, view, moved) => handleDrop(e, view, moved),
  });
  const ed = editor.view.dom; // the editable page
  const { NodeSelection } = LNEditor;

  /* ---------------- helpers ---------------- */
  let toastTimer;
  function toast(msg, ms = 2600) {
    // The overlay window is only as tall as its text, so a popup inside it is cut off —
    // the main process shows it in its own little window next to the overlay instead.
    if (document.body.classList.contains("mode-immersive")) {
      $("#toast").hidden = true;
      return void api.call("toast:show", msg, ms).catch(() => {});
    }
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), ms);
  }
  const debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };
  const escHtml = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const baseName = (rel) =>
    (rel || "")
      .split("/")
      .pop()
      .replace(/\.html$/i, "");
  const dirOf = (rel) => {
    const i = (rel || "").lastIndexOf("/");
    return i < 0 ? "" : rel.slice(0, i);
  };
  const ls = {
    get(k, d) {
      try {
        const v = localStorage.getItem(k);
        return v === null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {}
    },
  };
  async function safeCall(ch, ...a) {
    try {
      return await api.call(ch, ...a);
    } catch (e) {
      toast(e.message || String(e), 4000);
      throw e;
    }
  }

  /* ---------------- settings ---------------- */
  let S = await api.call("settings:get");
  let fullscreen = false;
  let lastImmOpts = "";
  let refreshingSettings = false;
  let update = { state: "idle" };
  const IMM_PAD = {
    none: [4, 3],
    narrow: [12, 8],
    normal: [24, 14],
    wide: [44, 20],
  };
  const PAGE_PAD = { narrow: 48, normal: 96, wide: 144 };
  const FONTS = [
    "Arial",
    "Arial Black",
    "Calibri",
    "Cambria",
    "Candara",
    "Century Gothic",
    "Comic Sans MS",
    "Consolas",
    "Constantia",
    "Corbel",
    "Courier New",
    "Franklin Gothic Medium",
    "Garamond",
    "Georgia",
    "Helvetica",
    "Lucida Sans Unicode",
    "Palatino Linotype",
    "Segoe UI",
    "Tahoma",
    "Times New Roman",
    "Trebuchet MS",
    "Verdana",
  ];
  const MAX_PT = 10; // no text, headings included, is ever bigger than this
  const SIZES = [6, 7, 8, 9, 10];

  // `changed`: the settings that just changed (none = all of them, at start-up). Everything here is
  // cheap except re-measuring the pages and refreshing the open Settings dialog, which only happen
  // when something they depend on changed — so dragging a slider applies instantly.
  const LAYOUT_KEYS = ["editorMargins", "defaultFont", "defaultFontSize", "defaultLineSpacing"];
  function applySettings(changed) {
    const has = (keys) => !changed || keys.some((k) => changed.includes(k));
    const r = document.documentElement.style;
    r.setProperty("--overlay-opacity", S.overlayOpacity);
    r.setProperty("--bg-opacity", S.backgroundOpacity);
    r.setProperty("--page-pad", (PAGE_PAD[S.editorMargins] || 96) + "px");
    const [px, py] = IMM_PAD[S.immersiveMargins] || IMM_PAD.narrow;
    r.setProperty("--imm-pad-x", px + "px");
    r.setProperty("--imm-pad-y", py + "px");
    r.setProperty("--doc-font", `"${S.defaultFont}"`);
    r.setProperty("--doc-size", S.defaultFontSize + "pt");
    r.setProperty("--doc-ls", S.defaultLineSpacing);
    document.body.classList.toggle("page-gray", S.editorPage === "gray");
    document.body.classList.toggle("page-black", S.editorPage === "black");
    document.body.classList.toggle(
      "page-dark",
      S.editorPage === "gray" || S.editorPage === "black",
    );
    document.body.classList.toggle("dark-black", S.darkStyle !== "gray");
    document.body.classList.toggle("sidebar-open", !!S.sidebarOpen);
    $("#imm-lines").textContent =
      S.linesPerView === 25 ? "25" : S.linesPerView + "L";
    $("#imm-lines").title =
      `Lines per view: ${S.linesPerView === 25 ? "default (25 max)" : S.linesPerView}. Click or ${prettyAccel(S.linesShortcut)} to change`;
    $("#hint").textContent =
      `${prettyAccel(S.toggleShortcut)} hide · ${prettyAccel(S.immersiveShortcut)} immersive`;
    window.docDefaults = {
      font: S.defaultFont,
      size: S.defaultFontSize,
      ls: S.defaultLineSpacing,
    };
    // Only re-lay-out the overlay when one of its options changed — not on every save of the
    // reading position (that used to re-measure the whole document after each scroll).
    const io = JSON.stringify(immOpts());
    if (S.mode === "immersive" && io !== lastImmOpts) Immersive.setOptions(immOpts());
    lastImmOpts = io;
    refreshOpenSettings(changed);
    if (has(["sidebarOpen"])) applyZoom();
    if (has(LAYOUT_KEYS)) editor.ln.paginate();
  }
  // Settings changed in quick succession are saved together (none of them lost).
  let pendingSettings = {};
  const flushSettings = debounce(() => {
    const patch = pendingSettings;
    pendingSettings = {};
    api.call("settings:set", patch).catch(() => {});
  }, 300);
  function saveSettingsSoon(patch) {
    Object.assign(pendingSettings, patch);
    flushSettings();
  }
  async function setSetting(patch, quiet) {
    Object.assign(S, patch);
    applySettings(Object.keys(patch));
    if ("keys" in patch) rebuildKeys();
    if (quiet) {
      saveSettingsSoon(patch);
      return;
    }
    const res = await api.call("settings:set", patch);
    S = { ...S, ...res };
    showShortcutErrors();
  }
  function immOpts() {
    return {
      lines: +S.linesPerView || 25,
      zoom: +S.immersiveZoom || 1,
      step: +S.scrollLines || 3, // 0 = automatic (3); -1 = a whole view
      flatHeadings: S.immersiveHeadings !== "original",
    };
  }
  // Lines-per-view modes the cycle shortcut / button steps through: 1, 2, your custom number, 25.
  function lineModes() {
    const c = Math.max(1, Math.min(25, +S.customLines || 3));
    return [...new Set([1, 2, c, 25])].sort((a, b) => a - b);
  }
  // Overlay opacity steps 100 → 80 → 60 → 40 → 20% → back to 100%.
  // Keep an open Settings dialog in step when a shortcut or menu changes a value.
  function refreshOpenSettings(changed) {
    const dlg = document.getElementById("dlg-settings");
    if (!dlg || dlg.hidden || refreshingSettings) return;
    refreshingSettings = true;
    try {
      const previews = !changed || ["theme", "darkStyle", "editorPage"].some((k) => changed.includes(k));
      fillSettings({ previews, keyRows: !changed });
    } finally {
      refreshingSettings = false;
    }
  }
  function cycleOpacity() {
    const cur = +S.overlayOpacity || 1;
    const next = [0.8, 0.6, 0.4, 0.2].find((v) => v < cur - 0.01) || 1;
    setSetting({ overlayOpacity: next }, true);
    toast(
      `Overlay opacity ${Math.round(next * 100)}%` +
        (S.mode === "immersive" ? "" : " (shows in the overlay)"),
      1400,
    );
  }
  // Previous / next heading: in the overlay it jumps there; in the editor it scrolls there.
  function jumpHeading(dir) {
    if (S.mode === "immersive") {
      if (!Immersive.jumpHeading(dir))
        toast(dir > 0 ? "No more headings below" : "No more headings above", 1200);
      return;
    }
    // Measured from where you are in the document — the caret, or the top of the screen if the
    // caret has been scrolled out of view — never from how far the page could scroll (near the
    // end of a document the last headings can't reach the top, which used to stall the jumps).
    const hs = editor.ln.headings();
    const view = editor.view;
    const c = canvas.getBoundingClientRect();
    const blockAt = (pos) => {
      const $p = editor.state.doc.resolve(pos);
      return $p.depth ? $p.before($p.depth) : pos;
    };
    let ref = blockAt(editor.state.selection.from); // the paragraph / heading the caret is in
    try {
      const at = view.coordsAtPos(editor.state.selection.from);
      if (at.bottom < c.top || at.top > c.bottom) {
        const hit = view.posAtCoords({ left: c.left + c.width / 2, top: c.top + 8 });
        if (hit) ref = blockAt(hit.pos);
      }
    } catch {}
    const target =
      dir > 0 ? hs.find((h) => h.pos > ref) : [...hs].reverse().find((h) => h.pos < ref);
    if (!target)
      return toast(dir > 0 ? "No more headings below" : "No more headings above", 1200);
    editor.chain().setTextSelection(target.pos + 1).focus(null, { scrollIntoView: false }).run();
    // the heading's text (its box may start higher, when a page gap is above it)
    canvas.scrollTop += view.coordsAtPos(target.pos + 1).top - c.top - 24;
  }
  function matchesAccel(e, accel) {
    if (!accel) return false;
    const parts = accel.split("+");
    const key = parts.pop();
    const want = { ctrl: false, alt: false, shift: false, meta: false };
    parts.forEach((m) => {
      if (/^(CommandOrControl|CmdOrCtrl|Control|Ctrl)$/i.test(m)) want.ctrl = true;
      else if (/^Alt$/i.test(m)) want.alt = true;
      else if (/^Shift$/i.test(m)) want.shift = true;
      else if (/^(Super|Meta|Command|Cmd)$/i.test(m)) want.meta = true;
    });
    return (
      e.ctrlKey === want.ctrl && e.altKey === want.alt && e.shiftKey === want.shift &&
      e.metaKey === want.meta && (keyName(e.code) || "").toLowerCase() === key.toLowerCase()
    );
  }
  function cycleLines() {
    const order = lineModes();
    const i = order.indexOf(+S.linesPerView);
    const n = order[(i + 1) % order.length];
    setSetting({ linesPerView: n });
    toast(
      n === 25
        ? "Showing up to 25 lines"
        : `Showing ${n} line${n > 1 ? "s" : ""} at a time`,
      1400,
    );
  }
  function prettyAccel(a) {
    const names = { numadd: "Num +", numsub: "Num −", nummult: "Num *", numdiv: "Num /", numdec: "Num .", Escape: "Esc", Super: "Win" };
    return (a || "")
      .replace(/CommandOrControl|CmdOrCtrl/g, "Ctrl")
      .split("+")
      .map((p) => names[p] || p.replace(/^num(\d)$/, "Num $1"))
      .join(" + ");
  }

  /* ---------------- document state ---------------- */
  let cur = { rel: null, dirty: false, saving: null };
  let tree = [];
  let targetFolder = "";

  function serialize() {
    return editor.ln.html();
  }
  // Downloads and printing are always black text on white: "default colour" text is black there.
  function exportHtml() {
    const c = document.createElement("div");
    c.innerHTML = serialize();
    c.querySelectorAll(".ln-ink").forEach((e) => {
      e.style.color = "#000000";
      e.classList.remove("ln-ink");
      if (!e.className) e.removeAttribute("class");
    });
    return c.innerHTML;
  }
  const saveSoon = debounce(() => saveNow(), 600);
  function markDirty() {
    if (!cur.rel) return;
    cur.dirty = true;
    saveState.textContent = "Saving…";
    saveSoon();
    updateWordCountSoon();
    if (findOpen) runFindSoon();
  }
  async function saveNow() {
    if (!cur.rel || !cur.dirty) return;
    if (cur.saving) await cur.saving;
    if (!cur.dirty) return;
    cur.dirty = false;
    const rel = cur.rel;
    cur.saving = api
      .call("docs:write", rel, serialize())
      .then(() => {
        if (cur.rel === rel && !cur.dirty)
          saveState.textContent = "Saved to this PC";
        refreshTreeSoon();
      })
      .catch((e) => {
        cur.dirty = true;
        saveState.textContent = "Not saved";
        toast("Could not save: " + e.message, 5000);
      })
      .finally(() => {
        cur.saving = null;
      });
    return cur.saving;
  }

  async function openDoc(rel, opts = {}) {
    await saveNow();
    let html;
    try {
      html = await api.call("docs:read", rel);
    } catch (e) {
      toast("Could not open document");
      await refreshTree();
      return false;
    }
    cur = { rel, dirty: false, saving: null };
    if (findOpen) closeFind();
    // (sizes over 10 pt, headings wrapped around lists etc. are fixed while loading)
    editor.ln.load(html && html.trim() ? html : "<p><br></p>");
    titleInput.value = baseName(rel);
    document.title = baseName(rel) + " - Interview Notes";
    saveState.textContent = "Saved to this PC";
    targetFolder = dirOf(rel);
    canvas.scrollTop = 0;
    setSetting({ lastDoc: rel }, true);
    updateWordCount();
    renderTree();
    deselectImage();
    updateToolbarSoon();
    if (S.mode === "immersive") loadImmersive();
    else if (opts.focus !== false) editor.commands.focus("start", { scrollIntoView: false });
    return true;
  }

  async function newDoc(
    folder = targetFolder,
    name = "Untitled document",
    body = "<p><br></p>",
  ) {
    await saveNow();
    const rel = await safeCall("docs:create", folder, name, body);
    await refreshTree();
    await openDoc(rel);
    if (name === "Untitled document") {
      titleInput.focus();
      titleInput.select();
    }
    return rel;
  }
  async function renameCurrent(name) {
    if (!cur.rel) return;
    name = (name || "").trim();
    if (!name || name === baseName(cur.rel)) {
      titleInput.value = baseName(cur.rel);
      return;
    }
    await saveNow();
    const old = cur.rel;
    const rel = await safeCall("docs:rename", cur.rel, name);
    cur.rel = rel;
    titleInput.value = baseName(rel);
    movePosition(old, rel);
    setSetting({ lastDoc: rel }, true);
    await refreshTree();
  }
  function movePosition(oldRel, newRel) {
    if (S.readPositions && S.readPositions[oldRel] !== undefined) {
      S.readPositions[newRel] = S.readPositions[oldRel];
      delete S.readPositions[oldRel];
      setSetting({ readPositions: S.readPositions }, true);
    }
  }
  async function deleteItem(rel, isFolder) {
    const name = isFolder ? rel.split("/").pop() : baseName(rel);
    if (
      !confirm(
        `Move "${name}"${isFolder ? " and everything in it" : ""} to the Recycle Bin?`,
      )
    )
      return;
    const affectsCurrent =
      cur.rel && (cur.rel === rel || cur.rel.startsWith(rel + "/"));
    if (affectsCurrent) {
      cur.dirty = false;
    }
    await safeCall("docs:delete", rel);
    await refreshTree();
    if (affectsCurrent) {
      const first = firstDoc(tree);
      if (first) await openDoc(first);
      else await newDoc("");
    }
  }
  function firstDoc(items) {
    let best = null;
    const walk = (arr) =>
      arr.forEach((i) => {
        if (i.type === "doc") {
          if (!best || i.mtime > best.mtime) best = i;
        } else walk(i.children);
      });
    walk(items);
    return best && best.rel;
  }
  function allFolders(items, out = []) {
    items.forEach((i) => {
      if (i.type === "folder") {
        out.push(i.rel);
        allFolders(i.children, out);
      }
    });
    return out;
  }
  async function moveItem(rel, dest) {
    if (rel === dest || dirOf(rel) === dest) return;
    await saveNow();
    const newRel = await safeCall("docs:move", rel, dest);
    if (cur.rel === rel) {
      cur.rel = newRel;
      setSetting({ lastDoc: newRel }, true);
    } else if (cur.rel && cur.rel.startsWith(rel + "/")) {
      cur.rel = newRel + cur.rel.slice(rel.length);
      setSetting({ lastDoc: cur.rel }, true);
    }
    movePosition(rel, newRel);
    const exp = ls.get("expanded", {});
    exp[dest] = true;
    ls.set("expanded", exp);
    await refreshTree();
  }

  /* ---------------- sidebar tree ---------------- */
  const treeEl = $("#tree");
  async function refreshTree() {
    try {
      tree = await api.call("docs:list");
    } catch (e) {
      tree = [];
    }
    renderTree();
  }
  const refreshTreeSoon = debounce(refreshTree, 800);
  function fmtDate(ms) {
    const d = new Date(ms),
      now = new Date();
    if (d.toDateString() === now.toDateString())
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return d.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
    });
  }
  function renderTree() {
    const q = $("#sb-filter").value.trim().toLowerCase();
    const exp = ls.get("expanded", {});
    const match = (i) =>
      i.type === "doc"
        ? !q ||
          i.name.toLowerCase().includes(q) ||
          (i.preview || "").toLowerCase().includes(q)
        : !q || i.name.toLowerCase().includes(q) || i.children.some(match);
    const build = (items) =>
      items
        .filter(match)
        .map((i) => {
          if (i.type === "folder") {
            const open = q ? true : !!exp[i.rel];
            return `<div class="tree-row folder ${open ? "expanded" : ""}" draggable="true" data-rel="${escHtml(i.rel)}" data-type="folder">
          <span class="chev">${icon("chevron", 14)}</span><span class="ico">${icon(open ? "folderOpen" : "folder", 16)}</span>
          <div class="meta"><div class="name">${escHtml(i.name)}</div></div></div>
          ${open ? `<div class="tree-children">${build(i.children) || '<div class="tree-empty">Empty folder</div>'}</div>` : ""}`;
          }
          return `<div class="tree-row doc ${i.rel === cur.rel ? "current" : ""}" draggable="true" data-rel="${escHtml(i.rel)}" data-type="doc">
        <span class="ico doc-ico">${icon("doc", 16)}</span>
        <div class="meta"><div class="name">${escHtml(i.name)}</div>
        <div class="preview">${escHtml(i.preview || "Empty document")}</div>
        <div class="date">${fmtDate(i.mtime)}</div></div></div>`;
        })
        .join("");
    treeEl.innerHTML =
      build(tree) ||
      `<div class="tree-empty">${q ? "No matches" : "No documents yet"}</div>`;
  }
  $("#sb-filter").addEventListener("input", renderTree);
  treeEl.addEventListener("click", (e) => {
    const row = e.target.closest(".tree-row");
    if (!row) {
      targetFolder = "";
      return;
    }
    const rel = row.dataset.rel;
    if (row.dataset.type === "doc") {
      if (rel !== cur.rel) openDoc(rel);
    } else {
      const exp = ls.get("expanded", {});
      exp[rel] = !exp[rel];
      ls.set("expanded", exp);
      targetFolder = rel;
      renderTree();
    }
  });
  treeEl.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    const row = e.target.closest(".tree-row");
    const rel = row ? row.dataset.rel : "";
    const isFolder = !row || row.dataset.type === "folder";
    const folder = isFolder ? rel : dirOf(rel);
    const folders = ["", ...allFolders(tree)].filter(
      (f) => f !== rel && !f.startsWith(rel + "/") && f !== dirOf(rel),
    );
    const items = [];
    if (row && !isFolder) items.push({ id: "open", label: "Open" });
    items.push(
      { id: "newdoc", label: "New document here" },
      { id: "newfolder", label: "New folder here" },
    );
    if (row) {
      items.push({ type: "separator" }, { id: "rename", label: "Rename…" });
      if (folders.length)
        items.push({
          label: "Move to",
          submenu: folders.map((f) => ({
            id: "move:" + f,
            label: f ? f : "Documents (top level)",
          })),
        });
      items.push({ id: "delete", label: "Delete" });
    }
    items.push(
      { type: "separator" },
      { id: "reveal", label: "Show in File Explorer" },
    );
    const id = await api.call("menu:popup", items);
    if (!id) return;
    if (id === "open") openDoc(rel);
    else if (id === "newdoc") {
      targetFolder = folder;
      newDoc(folder);
    } else if (id === "newfolder") newFolder(folder);
    else if (id === "rename") {
      const cur0 = isFolder ? rel.split("/").pop() : baseName(rel);
      const name = await promptDlg("Rename", cur0);
      if (name && name !== cur0) {
        await saveNow();
        const nr = await safeCall("docs:rename", rel, name);
        if (cur.rel === rel) {
          cur.rel = nr;
          titleInput.value = baseName(nr);
          setSetting({ lastDoc: nr }, true);
        } else if (isFolder && cur.rel && cur.rel.startsWith(rel + "/")) {
          cur.rel = nr + cur.rel.slice(rel.length);
          setSetting({ lastDoc: cur.rel }, true);
        }
        movePosition(rel, nr);
        refreshTree();
      }
    } else if (id.startsWith("move:")) moveItem(rel, id.slice(5));
    else if (id === "delete") deleteItem(rel, isFolder);
    else if (id === "reveal") api.call("docs:openFolder", folder);
  });
  // drag & drop to move docs/folders
  let dragRel = null;
  treeEl.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".tree-row");
    if (!row) return;
    dragRel = row.dataset.rel;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/x-ln", dragRel);
  });
  treeEl.addEventListener("dragover", (e) => {
    if (!dragRel) return;
    e.preventDefault();
    $$(".tree-row.drop", treeEl).forEach((r) => r.classList.remove("drop"));
    const row = e.target.closest(".tree-row");
    if (row && row.dataset.type === "folder") row.classList.add("drop");
  });
  treeEl.addEventListener("dragleave", (e) => {
    if (e.target.classList) e.target.classList.remove("drop");
  });
  treeEl.addEventListener("drop", (e) => {
    if (!dragRel) return;
    e.preventDefault();
    const row = e.target.closest(".tree-row");
    const dest = row
      ? row.dataset.type === "folder"
        ? row.dataset.rel
        : dirOf(row.dataset.rel)
      : "";
    $$(".tree-row.drop", treeEl).forEach((r) => r.classList.remove("drop"));
    const rel = dragRel;
    dragRel = null;
    moveItem(rel, dest);
  });
  treeEl.addEventListener("dragend", () => {
    dragRel = null;
    $$(".tree-row.drop", treeEl).forEach((r) => r.classList.remove("drop"));
  });

  async function newFolder(parent = targetFolder) {
    const name = await promptDlg("New folder", "New folder");
    if (!name) return;
    const rel = await safeCall("docs:mkdir", parent, name);
    const exp = ls.get("expanded", {});
    exp[rel] = true;
    if (parent) exp[parent] = true;
    ls.set("expanded", exp);
    targetFolder = rel;
    if (!S.sidebarOpen) setSetting({ sidebarOpen: true }, true);
    await refreshTree();
  }
  function toggleSidebar(force) {
    const open = force !== undefined ? force : !S.sidebarOpen;
    setSetting({ sidebarOpen: open }, true);
    if (open) refreshTree();
    setTimeout(applyZoom, 200);
  }
  $("#btn-sidebar").onclick = () => toggleSidebar();
  $("#sb-new-doc").onclick = () => newDoc();
  $("#sb-new-folder").onclick = () => newFolder();
  $("#sb-open-folder").onclick = () =>
    api.call("docs:openFolder", targetFolder);
  $("#sb-root").onclick = () => api.call("docs:openFolder", "");

  titleInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      editor.commands.focus();
    }
    if (e.key === "Escape") {
      titleInput.value = baseName(cur.rel);
      editor.commands.focus();
    }
  });
  titleInput.addEventListener("blur", () => renameCurrent(titleInput.value));

  /* ---------------- selection & toolbar state ---------------- */
  editor.on("selectionUpdate", () => {
    updateToolbarSoon();
    updateLinkBubble();
    syncImageSelection();
  });
  editor.on("transaction", ({ transaction }) => {
    if (transaction.docChanged) {
      updateToolbarSoon();
      positionImageUi();
    }
  });
  editor.on("update", () => markDirty());
  // the DOM element the caret / selection starts in (for computed font, size and colour)
  function anchorEl() {
    try {
      const { node } = editor.view.domAtPos(editor.state.selection.from);
      return node.nodeType === 1 ? node : node.parentElement;
    } catch {
      return ed;
    }
  }
  // the nearest list (bulletList / orderedList) around the selection: { node, pos } or null
  function listAround() {
    const $f = editor.state.selection.$from;
    for (let d = $f.depth; d > 0; d--) {
      const n = $f.node(d);
      if (n.type.name === "bulletList" || n.type.name === "orderedList") return { node: n, pos: $f.before(d) };
    }
    return null;
  }
  function textblock() {
    const $f = editor.state.selection.$from;
    for (let d = $f.depth; d > 0; d--) if ($f.node(d).isTextblock) return $f.node(d);
    return null;
  }
  function updateToolbar() {
    if (S.mode !== "editor") return;
    const set = (c, v) => {
      const b = $(`.tb[data-cmd="${c}"]`);
      if (b) b.classList.toggle("on", !!v);
    };
    set("bold", editor.isActive("bold"));
    set("italic", editor.isActive("italic"));
    set("underline", editor.isActive("underline"));
    set("strikeThrough", editor.isActive("strike"));
    const list = listAround();
    const checklist = !!list && list.node.type.name === "bulletList" && list.node.attrs.class === "checklist";
    set("checklist", checklist);
    set("insertUnorderedList", !!list && list.node.type.name === "bulletList" && !checklist);
    set("insertOrderedList", !!list && list.node.type.name === "orderedList");
    const align = (editor.ln.blockStyle("text-align") || "left").replace("start", "left");
    set("justifyLeft", align === "left");
    set("justifyCenter", align === "center");
    set("justifyRight", align === "right");
    set("justifyFull", align === "justify");
    const el = anchorEl();
    if (!el) return;
    const cs = getComputedStyle(el);
    const ts = editor.getAttributes("textStyle");
    const fam = (ts.fontFamily || cs.fontFamily).split(",")[0].replace(/["']/g, "").trim();
    const ff = $("#font-family");
    if (fam && ![...ff.options].some((o) => o.value === fam)) ff.add(new Option(fam, fam));
    ff.value = fam;
    if (document.activeElement !== $("#font-size")) {
      const pt = ts.fontSize ? LNEditor.sizeInPt(ts.fontSize) : parseFloat(cs.fontSize) * 0.75;
      $("#font-size").value = Math.round(Math.min(MAX_PT, pt || S.defaultFontSize) * 2) / 2;
    }
    const b = textblock();
    let style = "p";
    if (b) {
      if (b.type.name === "heading") style = b.attrs.class === "title" ? "title" : "h" + Math.min(4, b.attrs.level);
      else if (b.attrs.class === "subtitle") style = "subtitle";
    }
    $("#block-style").value = style;
    $("#fore-bar").style.background = ts.color || cs.color;
  }
  const updateToolbarSoon = debounce(updateToolbar, 60);

  /* ---------------- formatting commands ---------------- */
  const chain = () => editor.chain().focus();
  // toolbar / menu command ids → editor commands
  const COMMANDS = {
    undo: () => chain().undo().run(),
    redo: () => chain().redo().run(),
    bold: () => chain().toggleBold().run(),
    italic: () => chain().toggleItalic().run(),
    underline: () => chain().toggleUnderline().run(),
    strikeThrough: () => chain().toggleStrike().run(),
    superscript: () => chain().toggleSuperscript().run(),
    subscript: () => chain().toggleSubscript().run(),
    justifyLeft: () => align(null),
    justifyCenter: () => align("center"),
    justifyRight: () => align("right"),
    justifyFull: () => align("justify"),
    insertUnorderedList: () => toggleList("bulletList"),
    insertOrderedList: () => toggleList("orderedList"),
    indent: () => indent(1),
    outdent: () => indent(-1),
    delete: () => chain().deleteSelection().run(),
  };
  function exec(cmd) {
    if (COMMANDS[cmd]) COMMANDS[cmd]();
  }
  function align(v) {
    editor.commands.focus();
    editor.ln.setBlockStyle({ "text-align": v });
  }
  // Bullets on / off. A checklist counts as a bulleted list here, so this turns it into plain bullets.
  function toggleList(type) {
    const list = listAround();
    if (list && list.node.type.name === "bulletList" && list.node.attrs.class === "checklist" && type === "bulletList") {
      editor.chain().focus().command(({ tr }) => {
        tr.setNodeMarkup(list.pos, null, { ...list.node.attrs, class: null });
        return true;
      }).run();
      return;
    }
    if (type === "bulletList") chain().toggleBulletList().run();
    else chain().toggleOrderedList().run();
  }
  // Tab / Shift+Tab: nests list items; outside lists moves the paragraph by half an inch (like Google Docs).
  function indent(dir) {
    if (listAround()) {
      if (dir > 0) chain().sinkListItem("listItem").run();
      else chain().liftListItem("listItem").run();
      return;
    }
    editor.commands.focus();
    const cur = parseFloat(editor.ln.blockStyle("margin-left")) || 0;
    const next = Math.max(0, Math.round((cur + dir * 36) / 36) * 36);
    editor.ln.setBlockStyle({ "margin-left": next ? next + "pt" : null });
  }

  function setFontSize(pt) {
    pt = Math.max(1, Math.min(MAX_PT, Math.round(pt * 2) / 2));
    if (!isFinite(pt)) return;
    chain().setFontSize(pt + "pt").run();
    $("#font-size").value = pt;
  }
  function stepFontSize(dir) {
    const v = parseFloat($("#font-size").value) || S.defaultFontSize;
    const next =
      dir > 0
        ? SIZES.find((s) => s > v) || MAX_PT
        : [...SIZES].reverse().find((s) => s < v) || Math.max(1, v - 1);
    setFontSize(next);
  }
  // Normal text / Title / Subtitle / Heading 1–4 for every paragraph in the selection.
  // Keeps each paragraph's own alignment and spacing.
  function setBlockStyle(v) {
    editor.commands.focus();
    const { state } = editor;
    const { heading, paragraph } = state.schema.nodes;
    const type = v === "p" || v === "subtitle" ? paragraph : heading;
    const attrs = {
      class: v === "title" ? "title" : v === "subtitle" ? "subtitle" : null,
      ...(type === heading ? { level: v === "title" ? 1 : +v.slice(1) } : {}),
    };
    const tr = state.tr;
    const { from, to } = state.selection;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock) return true;
      const $p = tr.doc.resolve(pos);
      if (!$p.parent.canReplaceWith($p.index(), $p.index() + 1, type)) return false; // e.g. a heading as a list item
      tr.setNodeMarkup(pos, type, { ...node.attrs, ...attrs });
      return false;
    });
    if (tr.docChanged) editor.view.dispatch(tr);
  }
  function setLineSpacing(v) {
    editor.commands.focus();
    editor.ln.setBlockStyle({ "line-height": String(v) });
  }
  function paraSpace(which, add) {
    editor.commands.focus();
    editor.ln.setBlockStyle({ [which === "before" ? "margin-top" : "margin-bottom"]: add ? "10pt" : null });
  }
  function toggleChecklist() {
    const list = listAround();
    if (list && list.node.type.name === "bulletList" && list.node.attrs.class === "checklist") {
      chain().toggleBulletList().run(); // checklist off: back to normal paragraphs
      return;
    }
    if (!list || list.node.type.name !== "bulletList") chain().toggleBulletList().run();
    const l = listAround();
    if (l && l.node.type.name === "bulletList")
      editor.chain().focus().command(({ tr }) => {
        tr.setNodeMarkup(l.pos, null, { ...l.node.attrs, class: "checklist" });
        return true;
      }).run();
  }
  function clearFormat() {
    chain().unsetAllMarks().run();
    editor.ln.setBlockStyle({
      "line-height": null,
      "margin-top": null,
      "margin-bottom": null,
      "text-align": null,
      "margin-left": null,
      "text-indent": null,
    });
  }
  function setColor(kind, color) {
    if (kind === "hiliteColor") {
      if (color === null) chain().unsetBackgroundColor().run();
      else chain().setBackgroundColor(color).run();
      $("#hilite-bar").style.background = color || "transparent";
    } else {
      if (color === null) chain().unsetColor().unsetMark("ink").run();
      else chain().setColor(color).unsetMark("ink").run();
    }
  }

  function insertHtmlAtCursor(html) {
    chain().insertContent(LNEditor.normalizeHtml(html)).run();
  }
  function insertImages(srcs) {
    if (!srcs.length) return;
    chain()
      .insertContent(srcs.map((src) => ({ type: "image", attrs: { src, style: "width: 50%;" } })))
      .run();
  }
  function insertTable(rows, cols) {
    chain().insertTable({ rows, cols, withHeaderRow: false }).run();
    const $f = editor.state.selection.$from;
    for (let d = $f.depth; d > 0; d--)
      if ($f.node(d).type.name === "table") {
        const pos = $f.before(d),
          node = $f.node(d);
        const tr = editor.state.tr.setNodeMarkup(pos, null, { ...node.attrs, class: "ln-table" });
        // always leave a line after the table to carry on typing
        const after = pos + node.nodeSize;
        const next = tr.doc.resolve(after).nodeAfter;
        if (!next || next.type.name !== "paragraph") tr.insert(after, editor.schema.nodes.paragraph.create());
        editor.view.dispatch(tr);
        break;
      }
  }

  /* ---------------- table / image ops (from context menu) ---------------- */
  let ctxTarget = null;
  // put the caret where the right-click happened, so table / image commands act on that spot
  function caretToCtxTarget() {
    if (!ctxTarget || !ed.contains(ctxTarget)) return false;
    try {
      const pos = editor.view.posAtDOM(ctxTarget, 0);
      editor.chain().focus().setTextSelection(pos).run();
      return true;
    } catch {
      return false;
    }
  }
  function tableOp(op) {
    const cell = ctxTarget && ctxTarget.closest && ctxTarget.closest("td,th");
    if (!cell || !ed.contains(cell)) return;
    caretToCtxTarget();
    const c = editor.chain().focus();
    ({
      rowAbove: () => c.addRowBefore(),
      rowBelow: () => c.addRowAfter(),
      colLeft: () => c.addColumnBefore(),
      colRight: () => c.addColumnAfter(),
      delRow: () => c.deleteRow(),
      delCol: () => c.deleteColumn(),
      delTable: () => c.deleteTable(),
    })[op]?.().run();
  }

  // Images: click one to select it, then use the bubble (size / alignment) or drag the corner.
  let selImg = null; // { pos, dom }
  const imgBubble = $("#img-bubble"),
    imgHandle = $("#img-handle");
  function syncImageSelection() {
    const sel = editor.state.selection;
    if (sel instanceof NodeSelection && sel.node.type.name === "image") {
      selImg = { pos: sel.from, dom: editor.view.nodeDOM(sel.from) };
      positionImageUi();
    } else if (selImg) deselectImage(true);
  }
  function deselectImage(keepSelection) {
    selImg = null;
    imgBubble.hidden = true;
    imgHandle.hidden = true;
    if (!keepSelection && editor.state.selection instanceof NodeSelection)
      editor.commands.setTextSelection(editor.state.selection.to);
  }
  function positionImageUi() {
    if (selImg) {
      const sel = editor.state.selection;
      if (!(sel instanceof NodeSelection) || sel.node.type.name !== "image") selImg = null;
      else selImg = { pos: sel.from, dom: editor.view.nodeDOM(sel.from) };
    }
    if (!selImg || !selImg.dom || S.mode !== "editor") {
      imgBubble.hidden = true;
      imgHandle.hidden = true;
      return;
    }
    const r = selImg.dom.getBoundingClientRect();
    imgHandle.hidden = false;
    imgHandle.style.left = r.right - 6 + "px";
    imgHandle.style.top = r.bottom - 6 + "px";
    imgBubble.hidden = false;
    const bw = imgBubble.offsetWidth;
    imgBubble.style.left = Math.max(8, Math.min(innerWidth - bw - 8, r.left)) + "px";
    const below = r.bottom + 8,
      above = r.top - imgBubble.offsetHeight - 8;
    imgBubble.style.top = (below + 40 < innerHeight ? below : Math.max(8, above)) + "px";
  }
  // the image a command applies to: the selected one, or the one that was right-clicked
  function targetImage() {
    if (selImg) return selImg.pos;
    if (ctxTarget && ctxTarget.tagName === "IMG" && ed.contains(ctxTarget)) {
      try {
        return editor.view.posAtDOM(ctxTarget, 0);
      } catch {}
    }
    return null;
  }
  function patchImage(pos, props) {
    const node = editor.state.doc.nodeAt(pos);
    if (!node || node.type.name !== "image") return;
    const style = LNEditor.patchStyle(node.attrs.style, props);
    const tr = editor.state.tr.setNodeMarkup(pos, null, { ...node.attrs, style, width: null, height: null });
    tr.setSelection(NodeSelection.create(tr.doc, pos));
    editor.view.dispatch(tr);
    positionImageUi();
  }
  function imgOp(v) {
    const pos = targetImage();
    if (pos === null) return;
    if (v === "delete") {
      editor.view.dispatch(editor.state.tr.delete(pos, pos + 1));
      deselectImage(true);
      return;
    }
    patchImage(pos, { width: v + "%", height: "auto" });
  }
  function imgAlign(v) {
    const pos = targetImage();
    if (pos === null) return;
    const inline = v === "inline";
    patchImage(pos, {
      float: null,
      display: inline ? null : "block",
      margin: inline ? null : v === "center" ? "0 auto" : v === "left" ? "0 auto 0 0" : "0 0 0 auto",
    });
  }
  imgBubble.addEventListener("mousedown", (e) => e.preventDefault());
  imgBubble.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.img) imgOp(b.dataset.img);
    if (b.dataset.imgalign) imgAlign(b.dataset.imgalign);
  });
  imgHandle.addEventListener("pointerdown", (e) => {
    if (!selImg || !selImg.dom) return;
    e.preventDefault();
    imgHandle.setPointerCapture(e.pointerId);
    const img = selImg.dom,
      pos = selImg.pos;
    const startX = e.clientX,
      w0 = img.getBoundingClientRect().width,
      z = currentZoom();
    const maxW = ed.clientWidth - 2 * (PAGE_PAD[S.editorMargins] || 96);
    let w = w0 / z;
    const move = (ev) => {
      w = Math.max(16, Math.min(maxW, (w0 + ev.clientX - startX) / z));
      img.style.width = w + "px";
      img.style.height = "auto";
      imgHandle.style.left = img.getBoundingClientRect().right - 6 + "px";
      imgHandle.style.top = img.getBoundingClientRect().bottom - 6 + "px";
    };
    const up = () => {
      imgHandle.removeEventListener("pointermove", move);
      imgHandle.removeEventListener("pointerup", up);
      patchImage(pos, { width: Math.round(w) + "px", height: "auto" });
    };
    imgHandle.addEventListener("pointermove", move);
    imgHandle.addEventListener("pointerup", up);
  });
  canvas.addEventListener("scroll", () => {
    positionImageUi();
    hideLinkBubble();
    updatePageCount();
  });
  window.addEventListener("resize", () => {
    positionImageUi();
    applyZoom();
  });

  /* ---------------- page events ---------------- */
  ed.addEventListener("click", (e) => {
    const a = e.target.closest("a");
    if (a && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      api.call("open:external", a.href);
    }
  });
  ed.addEventListener("contextmenu", (e) => {
    ctxTarget = e.target;
    if (e.target.tagName === "IMG") {
      try {
        const pos = editor.view.posAtDOM(e.target, 0);
        editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
      } catch {}
    }
    api.ctxInfo({
      immersive: false,
      link: !!e.target.closest("a"),
      image: e.target.tagName === "IMG",
      table: !!e.target.closest("td,th"),
    });
  });
  $("#imm").addEventListener("contextmenu", () =>
    api.ctxInfo({ immersive: true }),
  );

  /* ---------------- paste & drop ---------------- */
  // Pastes from Google Docs / Word / web pages are cleaned up first (paste.js): their stylesheets
  // become inline formatting, black text follows the theme, and images are copied in.
  let plainNext = false,
    pastingClean = false;
  function handlePaste(e, view) {
    if (pastingClean) return false; // our own cleaned paste going through ProseMirror
    const cd = e.clipboardData;
    if (!cd) return false;
    const html = cd.getData("text/html");
    const text = cd.getData("text/plain");
    const files = [...(cd.files || [])].filter((f) => f.type.startsWith("image/"));
    if (plainNext) {
      plainNext = false;
      view.pasteText(text);
      return true;
    }
    if (files.length && !html) {
      Promise.all(files.map(readAsDataUrl)).then(insertImages);
      return true;
    }
    // copied from this editor: ProseMirror keeps the structure itself
    if (!html || /data-pm-slice/.test(html)) return false;
    cleanPastedHtml(html)
      .catch((err) => {
        console.error(err);
        return escHtml(text).replace(/\n/g, "<br>");
      })
      .then((clean) => {
        pastingClean = true;
        try {
          view.pasteHTML(LNEditor.normalizeHtml(clean || escHtml(text)));
        } finally {
          pastingClean = false;
        }
        inlineRemoteImages();
      });
    return true;
  }
  function readAsDataUrl(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(file);
    });
  }
  // Images that point at the web or a temp file become part of the document, so they don't break later.
  async function inlineRemoteImages() {
    const todo = [];
    editor.state.doc.descendants((n) => {
      if (n.type.name === "image" && /^(https?:|file:)/i.test(n.attrs.src || "")) todo.push(n.attrs.src);
    });
    if (!todo.length) return;
    const done = {};
    await Promise.all(
      [...new Set(todo)].map(async (src) => {
        done[src] = await api.call("image:inline", src).catch(() => null);
      }),
    );
    const tr = editor.state.tr;
    const drop = [];
    tr.doc.descendants((n, pos) => {
      if (n.type.name !== "image" || !(n.attrs.src in done)) return;
      if (done[n.attrs.src]) tr.setNodeMarkup(pos, null, { ...n.attrs, src: done[n.attrs.src] });
      else if (/^file:/i.test(n.attrs.src)) drop.push(pos);
    });
    drop.reverse().forEach((pos) => tr.delete(pos, pos + 1));
    if (tr.docChanged) editor.view.dispatch(tr);
  }
  function handleDrop(e, view, moved) {
    if (moved) return false; // dragging inside the document
    const dt = e.dataTransfer;
    const files = [...dt.files].filter((f) => f.type.startsWith("image/"));
    const html = dt.getData("text/html");
    if (!files.length && !html) return false;
    e.preventDefault();
    const at = view.posAtCoords({ left: e.clientX, top: e.clientY });
    if (at) editor.commands.setTextSelection(at.pos);
    if (files.length) Promise.all(files.map(readAsDataUrl)).then(insertImages);
    else
      cleanPastedHtml(html).then((clean) => {
        insertHtmlAtCursor(clean);
        inlineRemoteImages();
      });
    return true;
  }
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    if (!ed.contains(e.target)) e.preventDefault();
  });

  /* ---------------- link bubble ---------------- */
  const linkBubble = $("#link-bubble");
  let bubbleHref = null;
  function updateLinkBubble() {
    if (!editor.isActive("link") || S.mode !== "editor" || !editor.isFocused) return hideLinkBubble();
    bubbleHref = editor.getAttributes("link").href || "";
    $("#lb-url").textContent = bubbleHref || "(no link)";
    $("#lb-url").href = "#";
    const r = editor.view.coordsAtPos(editor.state.selection.from);
    linkBubble.hidden = false;
    linkBubble.style.left =
      Math.max(8, Math.min(innerWidth - linkBubble.offsetWidth - 8, r.left)) +
      "px";
    linkBubble.style.top = r.bottom + 6 + "px";
  }
  function hideLinkBubble() {
    linkBubble.hidden = true;
    bubbleHref = null;
  }
  linkBubble.addEventListener("mousedown", (e) => e.preventDefault());
  $("#lb-url").onclick = (e) => {
    e.preventDefault();
    if (bubbleHref) api.call("open:external", bubbleHref);
  };
  $("#lb-edit").onclick = () => openLinkDialog();
  $("#lb-remove").onclick = () => {
    chain().extendMarkRange("link").unsetLink().run();
    hideLinkBubble();
  };
  editor.on("blur", () => setTimeout(() => { if (!editor.isFocused) hideLinkBubble(); }, 150));

  /* ---------------- @ commands ---------------- */
  // Like Google Docs: type "@" (at the start of a line or after a space) and a menu of things to
  // insert appears — keep typing to narrow it ("@page"), then Tab or Enter inserts it.
  const AT_COMMANDS = [
    ["Page break", "Start a new page", () => chain().insertPageBreak().run()],
    ["Date", "Today's date", () => run("date")],
    ["Table", "3 × 3", () => insertTable(3, 3)],
    ["Checklist", "", () => toggleChecklist()],
    ["Bulleted list", "", () => toggleList("bulletList")],
    ["Numbered list", "", () => toggleList("orderedList")],
    ["Heading 1", "", () => setBlockStyle("h1")],
    ["Heading 2", "", () => setBlockStyle("h2")],
    ["Heading 3", "", () => setBlockStyle("h3")],
    ["Horizontal line", "", () => chain().setHorizontalRule().run()],
    ["Image", "From a file", () => run("image")],
    ["Link", "", () => openLinkDialog()],
  ].map(([label, hint, fn]) => ({ label, hint, fn }));
  const atMenu = document.createElement("div");
  atMenu.id = "at-menu";
  atMenu.className = "popover";
  atMenu.hidden = true;
  document.body.appendChild(atMenu);
  let at = null; // { from, to, items, i } while the menu is showing
  let atDismissed = -1; // the "@" the menu was closed for with Esc
  function atMatch() {
    const sel = editor.state.selection;
    if (!sel.empty || S.mode !== "editor" || !editor.isFocused) return null;
    const $p = sel.$from;
    if (!$p.parent.isTextblock || $p.parent.type.spec.code) return null;
    const before = $p.parent.textBetween(Math.max(0, $p.parentOffset - 30), $p.parentOffset, "\n", "￼");
    const m = before.match(/(?:^|\s)@([a-z0-9][a-z0-9 ]{0,24})?$/i);
    if (!m) return null;
    const q = (m[1] || "").toLowerCase();
    const from = sel.from - q.length - 1;
    if (from === atDismissed) return null;
    const items = AT_COMMANDS.filter((c) => {
      const l = c.label.toLowerCase();
      return !q || l.startsWith(q.trimEnd()) || l.split(" ").some((w) => w.startsWith(q.trim()));
    });
    return items.length ? { from, to: sel.from, items } : null;
  }
  function updateAtMenu() {
    const m = atMatch();
    if (!m) return hideAtMenu();
    const keep = at && at.from === m.from ? Math.min(at.i, m.items.length - 1) : 0;
    at = { ...m, i: keep };
    atMenu.innerHTML =
      `<div class="pop-menu at-list">${at.items
        .map((c, k) => `<button data-k="${k}" class="${k === at.i ? "on-row" : ""}"><span>${escHtml(c.label)}</span>${c.hint ? `<small>${escHtml(c.hint)}</small>` : ""}</button>`)
        .join("")}</div><div class="at-foot">Tab or Enter to insert · Esc to close</div>`;
    atMenu.hidden = false;
    const r = editor.view.coordsAtPos(at.from);
    const h = atMenu.offsetHeight,
      w = atMenu.offsetWidth;
    atMenu.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + "px";
    atMenu.style.top = (r.bottom + 6 + h < innerHeight ? r.bottom + 6 : Math.max(8, r.top - h - 6)) + "px";
  }
  function hideAtMenu() {
    at = null;
    atMenu.hidden = true;
  }
  function chooseAt(k) {
    const c = at && at.items[k];
    if (!c) return;
    const { from, to } = at;
    hideAtMenu();
    editor.chain().focus().deleteRange({ from, to }).run();
    c.fn();
  }
  editor.on("transaction", () => setTimeout(updateAtMenu, 0));
  editor.on("blur", () => setTimeout(() => !editor.isFocused && hideAtMenu(), 150));
  canvas.addEventListener("scroll", () => at && updateAtMenu());
  atMenu.addEventListener("mousedown", (e) => {
    e.preventDefault(); // keep the caret in the document
    const b = e.target.closest("[data-k]");
    if (b) chooseAt(+b.dataset.k);
  });
  // runs before the editor and the shortcut handler see the key
  window.addEventListener(
    "keydown",
    (e) => {
      if (!at || atMenu.hidden) return;
      const n = at.items.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        at.i = (at.i + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
        $$("[data-k]", atMenu).forEach((b) => b.classList.toggle("on-row", +b.dataset.k === at.i));
      } else if ((e.key === "Tab" && !e.shiftKey) || e.key === "Enter") chooseAt(at.i);
      else if (e.key === "Escape") {
        atDismissed = at.from;
        hideAtMenu();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );

  /* ---------------- dialogs ---------------- */
  const back = $("#modal-back");
  let dialogResolve = null;
  function openDialog(id) {
    $$(".modal", back).forEach((m) => (m.hidden = m.id !== id));
    back.hidden = false;
    hidePopover();
    // keys go to the dialog (Esc closes it), not to the document behind it
    const m = document.getElementById(id);
    m.tabIndex = -1;
    m.focus({ preventScroll: true });
  }
  function closeDialog() {
    const wasOpen = !back.hidden;
    back.hidden = true;
    $$(".modal", back).forEach((m) => (m.hidden = true));
    // typing carries on in the document (focus was inside the dialog, which is now hidden)
    if (wasOpen && S.mode === "editor" && (!document.activeElement || document.activeElement === document.body || back.contains(document.activeElement)))
      editor.commands.focus(null, { scrollIntoView: false });
    if (dialogResolve) {
      dialogResolve(null);
      dialogResolve = null;
    }
    api.call("shortcuts:pause", false).catch(() => {});
  }
  back.addEventListener("mousedown", (e) => {
    if (e.target === back) closeDialog();
  });
  $$("[data-close]", back).forEach((b) => (b.onclick = closeDialog));
  back.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$(".shortcut.rec")) {
      e.stopPropagation();
      closeDialog();
    }
  });

  function promptDlg(title, value = "") {
    $("#prompt-title").textContent = title;
    const inp = $("#prompt-input");
    inp.value = value;
    openDialog("dlg-prompt");
    setTimeout(() => {
      inp.focus();
      inp.select();
    }, 30);
    return new Promise((res) => {
      dialogResolve = res;
      const ok = () => {
        const v = inp.value.trim();
        dialogResolve = null;
        closeDialog();
        res(v || null);
      };
      $("#prompt-ok").onclick = ok;
      inp.onkeydown = (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          ok();
        }
      };
    });
  }

  function openLinkDialog() {
    editor.commands.focus();
    const inLink = editor.isActive("link");
    if (inLink) editor.commands.extendMarkRange("link");
    const { from, to } = editor.state.selection;
    const selText = editor.state.doc.textBetween(from, to, " ");
    $("#link-text").value = selText;
    $("#link-url").value = inLink ? editor.getAttributes("link").href || "" : "";
    openDialog("dlg-link");
    setTimeout(
      () => ($("#link-text").value ? $("#link-url") : $("#link-text")).focus(),
      30,
    );
    const apply = () => {
      let url = $("#link-url").value.trim();
      const text = $("#link-text").value || url;
      back.hidden = true;
      $("#dlg-link").hidden = true;
      if (!url) return;
      if (!/^(https?:|mailto:|#)/i.test(url))
        url =
          (/^[^@\s]+@[^@\s]+\.\w+$/.test(url) ? "mailto:" : "https://") + url;
      const c = editor.chain().focus().setTextSelection({ from, to });
      if (from !== to && text === selText) c.setLink({ href: url }).run();
      else
        c.insertContent([
          { type: "text", text, marks: [{ type: "link", attrs: { href: url } }] },
          ...(from === to ? [{ type: "text", text: " " }] : []),
        ]).run();
    };
    $("#link-apply").onclick = apply;
    $("#link-url").onkeydown = $("#link-text").onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        apply();
      }
    };
  }

  function docText() {
    const d = editor.state.doc;
    return d.textBetween(0, d.content.size, "\n", " ");
  }
  function showWordCount() {
    const text = docText();
    const { from, to } = editor.state.selection;
    const selText = from !== to ? editor.state.doc.textBetween(from, to, "\n", " ") : "";
    const words = (t) => (t.match(/\S+/g) || []).length;
    let paras = 0;
    editor.state.doc.descendants((n) => {
      if (n.isTextblock) {
        if (n.textContent.trim()) paras++;
        return false;
      }
    });
    const rows = [
      ["Words", words(text)],
      ["Characters", text.replace(/\n/g, "").length],
      ["Characters excluding spaces", text.replace(/\s/g, "").length],
      ["Paragraphs", paras],
    ];
    if (selText) rows.unshift(["Words in selection", words(selText)]);
    $("#word-stats").innerHTML = rows
      .map(([k, v]) => `<tr><td>${k}</td><td>${v.toLocaleString()}</td></tr>`)
      .join("");
    openDialog("dlg-words");
  }
  function updateWordCount() {
    const n = (docText().match(/\S+/g) || []).length;
    $("#word-count").textContent =
      `${n.toLocaleString()} word${n === 1 ? "" : "s"}`;
  }
  const updateWordCountSoon = debounce(updateWordCount, 400);
  // "Page 2 of 6": the page at the top part of the screen, like Google Docs
  function pageAt(scrollTop) {
    const n = Math.max(1, $("#pages").children.length);
    const c = canvas.getBoundingClientRect(),
      s = $("#sheet").getBoundingClientRect();
    const sheetTop = s.top - c.top + canvas.scrollTop;
    const y = (scrollTop + Math.min(c.height / 3, 200) - sheetTop) / currentZoom();
    return { at: Math.max(1, Math.min(n, Math.floor(y / (PAGE_H + PAGE_GAP)) + 1)), n };
  }
  function updatePageCount() {
    const { at, n } = pageAt(canvas.scrollTop);
    $("#page-count").textContent = `Page ${at} of ${n}`;
    if ($("#sb-page").classList.contains("show")) showScrollbarPage();
  }

  // Hovering the editor's scrollbar shows a small "Page 3 of 12" beside it: on the thumb (or
  // while dragging it) the page you're on, elsewhere on the track the page that's there.
  const sbPage = $("#sb-page");
  let sbHoverY = null; // mouse position on the track, or null when on the thumb / dragging
  let sbDragging = false;
  function scrollbarAt(e) {
    const c = canvas.getBoundingClientRect();
    return (
      canvas.scrollHeight > canvas.clientHeight &&
      e.clientX >= c.left + canvas.clientLeft + canvas.clientWidth &&
      e.clientX <= c.right &&
      e.clientY >= c.top &&
      e.clientY <= c.top + canvas.clientHeight
    );
  }
  function scrollbarThumb() {
    const track = canvas.clientHeight,
      max = canvas.scrollHeight - track;
    const h = Math.max(24, (track * track) / canvas.scrollHeight);
    return { h, top: max > 0 ? ((track - h) * canvas.scrollTop) / max : 0, track, max };
  }
  function showScrollbarPage() {
    const c = canvas.getBoundingClientRect(),
      t = scrollbarThumb();
    let top = canvas.scrollTop,
      y = t.top + t.h / 2;
    if (sbHoverY != null) {
      const f = Math.max(0, Math.min(1, (sbHoverY - t.h / 2) / (t.track - t.h || 1)));
      top = f * t.max;
      y = sbHoverY;
    }
    const { at, n } = pageAt(top);
    sbPage.textContent = `Page ${at} of ${n}`;
    sbPage.style.top = c.top + Math.max(12, Math.min(t.track - 12, y)) + "px";
    sbPage.style.right = innerWidth - (c.left + canvas.clientLeft + canvas.clientWidth) + 6 + "px";
    sbPage.classList.add("show");
  }
  const hideScrollbarPage = () => sbPage.classList.remove("show");
  document.addEventListener("mousemove", (e) => {
    if (sbDragging && e.buttons) return showScrollbarPage();
    sbDragging = false;
    if (!scrollbarAt(e)) return hideScrollbarPage();
    const t = scrollbarThumb(),
      y = e.clientY - canvas.getBoundingClientRect().top;
    sbHoverY = e.buttons || (y >= t.top && y <= t.top + t.h) ? null : y;
    showScrollbarPage();
  });
  // A click or drag on the scrollbar follows the page you're on until the mouse moves again.
  canvas.addEventListener("mousedown", (e) => {
    if (scrollbarAt(e)) (sbHoverY = null), (sbDragging = true);
  });
  window.addEventListener("mouseup", () => (sbDragging = false));
  document.documentElement.addEventListener("mouseleave", hideScrollbarPage);
  $("#word-count").onclick = showWordCount;

  /* ---------------- popovers ---------------- */
  const pop = $("#popover");
  // Toolbar popovers (colours, line spacing, table): clicking the same button again closes it.
  // Returns false when it closed instead of opening.
  let popAnchor = null;
  function showPopover(anchor, html, onClick) {
    if (!pop.hidden && popAnchor === anchor) {
      hidePopover();
      return false;
    }
    hidePopover();
    popAnchor = anchor;
    anchor.classList.add("open");
    pop.innerHTML = html;
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    pop.style.left =
      Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.left)) + "px";
    pop.style.top =
      Math.min(innerHeight - pop.offsetHeight - 8, r.bottom + 4) + "px";
    pop.onclick = (e) => onClick(e);
    return true;
  }
  function hidePopover() {
    pop.hidden = true;
    pop.innerHTML = "";
    pop.onclick = null;
    pop.onmouseover = null;
    if (popAnchor) popAnchor.classList.remove("open");
    popAnchor = null;
  }
  pop.addEventListener("mousedown", (e) => {
    if (e.target.tagName !== "INPUT") e.preventDefault();
  });
  document.addEventListener("mousedown", (e) => {
    // (a click on the popover's own button is left to toggle it)
    if (!pop.hidden && !pop.contains(e.target) && e.target.closest(".tb") !== popAnchor)
      hidePopover();
  });

  const PALETTE = [
    "#000000",
    "#434343",
    "#666666",
    "#999999",
    "#b7b7b7",
    "#cccccc",
    "#d9d9d9",
    "#efefef",
    "#f3f3f3",
    "#ffffff",
    "#980000",
    "#ff0000",
    "#ff9900",
    "#ffff00",
    "#00ff00",
    "#00ffff",
    "#4a86e8",
    "#0000ff",
    "#9900ff",
    "#ff00ff",
    "#e6b8af",
    "#f4cccc",
    "#fce5cd",
    "#fff2cc",
    "#d9ead3",
    "#d0e0e3",
    "#c9daf8",
    "#cfe2f3",
    "#d9d2e9",
    "#ead1dc",
    "#dd7e6b",
    "#ea9999",
    "#f9cb9c",
    "#ffe599",
    "#b6d7a8",
    "#a2c4c9",
    "#a4c2f4",
    "#9fc5e8",
    "#b4a7d6",
    "#d5a6bd",
    "#cc4125",
    "#e06666",
    "#f6b26b",
    "#ffd966",
    "#93c47d",
    "#76a5af",
    "#6d9eeb",
    "#6fa8dc",
    "#8e7cc3",
    "#c27ba0",
    "#a61c00",
    "#cc0000",
    "#e69138",
    "#f1c232",
    "#6aa84f",
    "#45818e",
    "#3c78d8",
    "#3d85c6",
    "#674ea7",
    "#a64d79",
    "#85200c",
    "#990000",
    "#b45f06",
    "#bf9000",
    "#38761d",
    "#134f5c",
    "#1155cc",
    "#0b5394",
    "#351c75",
    "#741b47",
    "#5b0f00",
    "#660000",
    "#783f04",
    "#7f6000",
    "#274e13",
    "#0c343d",
    "#1c4587",
    "#073763",
    "#20124d",
    "#4c1130",
  ];
  function colorPopover(btn, kind) {
    const opened = showPopover(
      btn,
      `<div class="palette">${PALETTE.map((c) => `<button data-c="${c}" title="${c}" style="background:${c}"></button>`).join("")}</div>
      <div class="pop-row"><button class="text-btn" data-c="reset">${kind === "hiliteColor" ? "None" : "Reset"}</button>
      <span style="flex:1"></span>Custom <input type="color" id="custom-color"></div>`,
      (e) => {
        const b = e.target.closest("[data-c]");
        if (!b) return;
        setColor(kind, b.dataset.c === "reset" ? null : b.dataset.c);
        hidePopover();
      },
    );
    if (!opened) return;
    $("#custom-color").onchange = (e) => {
      setColor(kind, e.target.value);
      hidePopover();
    };
  }
  function spacingPopover(btn) {
    const curLh = editor.ln.blockStyle("line-height") || String(S.defaultLineSpacing);
    const opt = (v, l) =>
      `<button data-ls="${v}" class="${String(curLh) === String(v) ? "on" : ""}">${l}</button>`;
    showPopover(
      btn,
      `<div class="pop-menu">${opt(1, "Single")}${opt(1.15, "1.15")}${opt(1.5, "1.5")}${opt(2, "Double")}
      <button data-ls="custom">Custom…</button><hr>
      <button data-ps="before:1">Add space before paragraph</button><button data-ps="after:1">Add space after paragraph</button>
      <button data-ps="before:0">Remove space before paragraph</button><button data-ps="after:0">Remove space after paragraph</button></div>`,
      async (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        hidePopover();
        if (b.dataset.ls === "custom") {
          const v = parseFloat(
            await promptDlg("Custom line spacing", curLh || "1.15"),
          );
          if (v > 0 && v < 10) setLineSpacing(v);
        } else if (b.dataset.ls) setLineSpacing(b.dataset.ls);
        else if (b.dataset.ps) {
          const [w, add] = b.dataset.ps.split(":");
          paraSpace(w, add === "1");
        }
      },
    );
  }
  function tablePopover(btn) {
    const R = 8,
      C = 10;
    const opened = showPopover(
      btn,
      `<div class="grid-pick">${Array.from({ length: R * C }, (_, i) => `<span data-r="${Math.floor(i / C) + 1}" data-c="${(i % C) + 1}"></span>`).join("")}</div><div class="grid-label">Insert table</div>`,
      (e) => {
        const s = e.target.closest("[data-r]");
        if (!s) return;
        hidePopover();
        insertTable(+s.dataset.r, +s.dataset.c);
      },
    );
    if (!opened) return;
    pop.onmouseover = (e) => {
      const s = e.target.closest("[data-r]");
      if (!s) return;
      const r = +s.dataset.r,
        c = +s.dataset.c;
      $$("[data-r]", pop).forEach((x) =>
        x.classList.toggle("on", +x.dataset.r <= r && +x.dataset.c <= c),
      );
      $(".grid-label", pop).textContent = `${r} × ${c}`;
    };
  }

  /* ---------------- zoom ---------------- */
  // Full screen keeps its own zoom (default 100%) so a page that fits a small window isn't blown up to screen width.
  const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  const zoomSel = $("#zoom");
  zoomSel.innerHTML = "";
  zoomSel.add(new Option("Fit", "fit")); // fit to window width, never above 100%
  ZOOMS.forEach((z) =>
    zoomSel.add(new Option(Math.round(z * 100) + "%", String(z))),
  );
  const zoomKey = () => (fullscreen ? "zoomFull" : "zoom");
  const zoomPref = () => String(ls.get(zoomKey(), fullscreen ? "1" : "fit"));
  function currentZoom() {
    return (
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--zoom"),
      ) || 1
    );
  }
  function applyZoom() {
    const v = zoomPref();
    if (![...zoomSel.options].some((o) => o.value === v))
      zoomSel.add(new Option(Math.round(v * 100) + "%", v));
    zoomSel.value = v;
    let z =
      v === "fit"
        ? Math.max(0.5, Math.min(1, (canvas.clientWidth - 44) / 816))
        : parseFloat(v); // fit only shrinks
    if (!isFinite(z) || z <= 0) z = 1;
    document.documentElement.style.setProperty("--zoom", z);
    $("#zoom-label").textContent =
      (v === "fit" ? "Fit " : "") + Math.round(z * 100) + "%";
    updatePageCount();
  }
  function setZoom(v) {
    ls.set(zoomKey(), String(v));
    applyZoom();
  }
  function stepZoom(dir) {
    const z = currentZoom();
    const next =
      dir > 0
        ? ZOOMS.find((s) => s > z + 0.001)
        : [...ZOOMS].reverse().find((s) => s < z - 0.001);
    if (next) setZoom(next);
  }
  zoomSel.onchange = (e) => {
    setZoom(e.target.value);
    editor.commands.focus();
  };
  $("#zoom-in").onclick = () => stepZoom(1);
  $("#zoom-out").onclick = () => stepZoom(-1);
  $("#zoom-label").onclick = () => setZoom(1);
  let wheelZoomAt = 0;
  // Ctrl + Alt + scroll (Settings → Shortcuts) jumps between headings, in the editor and the overlay.
  function wheelMatches(e, mods) {
    if (!mods || mods === "off") return false;
    const m = mods.split("+");
    return e.ctrlKey === m.includes("ctrl") && e.altKey === m.includes("alt") && e.shiftKey === m.includes("shift");
  }
  let headWheelAt = 0;
  function headingWheel(e) {
    e.preventDefault();
    const d = e.deltaY || e.deltaX; // Shift + wheel scrolls sideways
    if (!d || e.timeStamp - headWheelAt < 120) return; // one heading per notch, even on touchpads
    headWheelAt = e.timeStamp;
    jumpHeading(d > 0 ? 1 : -1);
  }
  Immersive.onHeadingWheel((e) => wheelMatches(e, S.headingScroll) && (headingWheel(e), true));
  canvas.addEventListener(
    "wheel",
    (e) => { if (!e.ctrlKey && wheelMatches(e, S.headingScroll)) headingWheel(e); },
    { passive: false },
  );
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (wheelMatches(e, S.headingScroll)) return headingWheel(e);
      if (e.timeStamp - wheelZoomAt < 60) return; // one step per notch, even on touchpads
      wheelZoomAt = e.timeStamp;
      stepZoom(e.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );

  /* ---------------- find & replace ---------------- */
  let findOpen = false,
    findRanges = [],
    findIdx = -1;
  function openFind(replace) {
    findOpen = true;
    $("#findbar").hidden = false;
    const { from, to } = editor.state.selection;
    const sel = from !== to ? editor.state.doc.textBetween(from, to, "\n") : "";
    if (sel && sel.length < 80 && !sel.includes("\n"))
      $("#find-input").value = sel;
    (replace ? $("#replace-input") : $("#find-input")).focus();
    $("#find-input").select();
    runFind();
  }
  function closeFind() {
    findOpen = false;
    $("#findbar").hidden = true;
    findRanges = [];
    findIdx = -1;
    editor.ln.clearFind();
    editor.commands.focus();
  }
  function runFind(keepIdx) {
    const q = $("#find-input").value;
    findRanges = editor.ln.findAll(q, $("#find-case").checked);
    findIdx = findRanges.length
      ? Math.min(keepIdx ? Math.max(0, findIdx) : 0, findRanges.length - 1)
      : -1;
    paintFind(false);
  }
  const runFindSoon = debounce(() => runFind(true), 250);
  function paintFind(scroll = true) {
    $("#find-count").textContent = $("#find-input").value
      ? findRanges.length
        ? `${findIdx + 1} of ${findRanges.length}`
        : "0 of 0"
      : "";
    editor.ln.find($("#find-input").value, $("#find-case").checked, findIdx);
    if (scroll && findIdx >= 0) {
      const r = editor.view.coordsAtPos(findRanges[findIdx].from),
        c = canvas.getBoundingClientRect();
      if (r.top < c.top + 40 || r.bottom > c.bottom - 40)
        canvas.scrollTop += r.top - c.top - c.height / 3;
    }
  }
  function findStep(d) {
    if (!findRanges.length) return;
    findIdx = (findIdx + d + findRanges.length) % findRanges.length;
    paintFind();
  }
  function replaceOne() {
    if (findIdx < 0) return;
    const r = findRanges[findIdx];
    const rep = $("#replace-input").value;
    const tr = editor.state.tr;
    if (rep) tr.insertText(rep, r.from, r.to);
    else tr.delete(r.from, r.to);
    editor.view.dispatch(tr);
    runFind(true);
    paintFind();
    $("#replace-input").focus();
  }
  function replaceAll() {
    if (!findRanges.length) return;
    const n = findRanges.length,
      rep = $("#replace-input").value;
    const tr = editor.state.tr;
    for (let i = findRanges.length - 1; i >= 0; i--) {
      const r = findRanges[i];
      if (rep) tr.insertText(rep, r.from, r.to);
      else tr.delete(r.from, r.to);
    }
    editor.view.dispatch(tr);
    runFind();
    toast(`Replaced ${n} occurrence${n === 1 ? "" : "s"}`);
  }
  $("#find-input").addEventListener("input", () => runFind());
  $("#find-case").addEventListener("change", () => runFind());
  $("#find-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      findStep(e.shiftKey ? -1 : 1);
    }
    if (e.key === "Escape") closeFind();
  });
  $("#replace-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      replaceOne();
    }
    if (e.key === "Escape") closeFind();
  });
  $("#find-next").onclick = () => findStep(1);
  $("#find-prev").onclick = () => findStep(-1);
  $("#find-close").onclick = closeFind;
  $("#replace-one").onclick = replaceOne;
  $("#replace-all").onclick = replaceAll;

  /* ---------------- import / export ---------------- */
  function pageCss() {
    const m = (PAGE_PAD[S.editorMargins] || 96) / 96;
    return `@page{size:letter;margin:${m}in}body{margin:0;font-family:"${S.defaultFont}",Arial,sans-serif;font-size:${S.defaultFontSize}pt;line-height:${S.defaultLineSpacing};color:#000;overflow-wrap:break-word}
p,div{margin:0}h1,h2,h3,h4{font-weight:700;margin:0;line-height:1.15;font-size:10pt}h1{padding:8pt 0 2pt}h2{padding:6pt 0 2pt}h3{padding:5pt 0 1pt;color:#434343}h4{padding:4pt 0 1pt;color:#666;font-style:italic}
h1.title{font-size:10pt;padding:0 0 3pt}p.subtitle{font-size:10pt;color:#666;padding:0 0 6pt}ul,ol{margin:0;padding-left:3.2em}ol ol{list-style-type:lower-alpha}ol ol ol{list-style-type:lower-roman}.page-break{break-after:page}img{max-width:100%;height:auto}
table{border-collapse:collapse;margin:4pt 0}table.ln-table{width:100%;table-layout:fixed}td,th{border:1px solid #9e9e9e;padding:4px 6px;vertical-align:top}hr{border:0;border-top:1px solid #9e9e9e}
blockquote{margin:0 0 0 40px}ul.checklist{list-style:none}ul.checklist li[data-checked=true]{text-decoration:line-through}a{color:#1155cc}`;
  }
  async function importFiles() {
    const files = await safeCall("import:file");
    let last = null;
    for (const f of files)
      last = await safeCall(
        "docs:create",
        targetFolder,
        f.name,
        sanitizeHtml(f.html) || "<p><br></p>",
      );
    if (last) {
      await refreshTree();
      await openDoc(last);
      toast(`Imported ${files.length} document${files.length > 1 ? "s" : ""}`);
    }
  }
  async function exportAs(fmt) {
    await saveNow();
    const p = await safeCall(
      "export:file",
      fmt,
      baseName(cur.rel),
      exportHtml(),
      pageCss(),
    );
    if (p) toast("Saved " + p.split(/[\\/]/).pop());
  }

  /* ---------------- menus ---------------- */
  const MENUS = {
    file: () => [
      { id: "new", label: "New document", accel: acc("new") },
      { id: "newFolder", label: "New folder" },
      { id: "docs", label: "Open… (document list)", accel: acc("docs") },
      { type: "separator" },
      { id: "import", label: "Import .docx / .html / .txt…" },
      { id: "print", label: "Print…", accel: acc("print") },
      { id: "export:pdf", label: "Download as PDF" },
      {
        label: "Download as…",
        submenu: [
          { id: "export:docx", label: "Microsoft Word (.docx)" },
          { id: "export:pdf", label: "PDF document (.pdf)" },
          { id: "export:html", label: "Web page (.html)" },
        ],
      },
      { type: "separator" },
      { id: "rename", label: "Rename" },
      { id: "delete", label: "Move to bin" },
      { id: "reveal", label: "Show in File Explorer" },
      { type: "separator" },
      { id: "hide", label: "Hide window", accel: S.toggleShortcut },
      { id: "quit", label: "Quit", accel: acc("quit") },
    ],
    edit: () => [
      { id: "undo", label: "Undo", accel: acc("undo") },
      { id: "redo", label: "Redo", accel: acc("redo") },
      { type: "separator" },
      { id: "cut", label: "Cut", accel: "CmdOrCtrl+X" },
      { id: "copy", label: "Copy", accel: "CmdOrCtrl+C" },
      { id: "paste", label: "Paste", accel: "CmdOrCtrl+V" },
      {
        id: "pastePlain",
        label: "Paste without formatting",
        accel: acc("pastePlain"),
      },
      { type: "separator" },
      { id: "selectAll", label: "Select all", accel: "CmdOrCtrl+A" },
      { id: "delSel", label: "Delete" },
      { type: "separator" },
      { id: "find", label: "Find and replace", accel: acc("find") },
    ],
    view: () => [
      { id: "immersive", label: "Immersive mode", accel: S.immersiveShortcut },
      { id: "docs", label: "Document list", checked: !!S.sidebarOpen },
      {
        id: "fullscreen",
        label: "Full screen",
        accel: acc("fullscreen"),
        checked: fullscreen,
      },
      {
        label: "Zoom",
        submenu: [
          { id: "zoom:in", label: "Zoom in", accel: acc("zoom:in") },
          { id: "zoom:out", label: "Zoom out", accel: acc("zoom:out") },
          { id: "zoom:1", label: "Actual size (100%)", accel: acc("zoom:1") },
          { type: "separator" },
        ].concat(
          ["fit", ...ZOOMS.map(String)].map((z) => ({
            id: "zoom:" + z,
            label: z === "fit" ? "Fit to window" : Math.round(z * 100) + "%",
            checked: zoomPref() === z,
          })),
        ),
      },
      {
        label: "Page color in dark mode",
        submenu: [
          ["paper", "White"],
          ["gray", "Gray"],
          ["black", "Black"],
        ].map(([v, l]) => ({
          id: "page:" + v,
          label: l,
          checked: S.editorPage === v,
        })),
      },
      {
        label: "Theme",
        submenu: [
          ["system", "Use system setting"],
          ["light", "Light"],
          ["dark", "Dark"],
        ]
          .map(([v, l]) => ({
            id: "theme:" + v,
            label: l,
            checked: S.theme === v,
          }))
          .concat(
            [{ type: "separator" }],
            [
              ["black", "Dark style: pure black"],
              ["gray", "Dark style: dark gray"],
            ].map(([v, l]) => ({
              id: "darkStyle:" + v,
              label: l,
              checked: (S.darkStyle || "black") === v,
            })),
          ),
      },
      {
        label: "Immersive lines",
        submenu: lineModes().map((n) => ({
          id: "lines:" + n,
          label: n === 25 ? "Default (25 max)" : `${n} line${n > 1 ? "s" : ""}`,
          checked: S.linesPerView === n,
        })),
      },
      { id: "alwaysOnTop", label: "Overlay always on top (immersive only)", checked: !!S.alwaysOnTop },
    ],
    insert: () => [
      { id: "image", label: "Image…" },
      { id: "table", label: "Table" },
      { id: "link", label: "Link", accel: acc("link") },
      { id: "hr", label: "Horizontal line" },
      { id: "pageBreak", label: "Page break (or type @page)" },
      { id: "date", label: "Date" },
      { id: "checklist", label: "Checklist" },
    ],
    format: () => [
      {
        label: "Text",
        submenu: [
          { id: "bold", label: "Bold", accel: acc("bold") },
          { id: "italic", label: "Italic", accel: acc("italic") },
          { id: "underline", label: "Underline", accel: acc("underline") },
          { id: "strikeThrough", label: "Strikethrough", accel: acc("strikeThrough") },
          { id: "superscript", label: "Superscript", accel: acc("superscript") },
          { id: "subscript", label: "Subscript" },
          { type: "separator" },
          {
            id: "fontUp",
            label: "Increase font size",
            accel: acc("fontUp"),
          },
          {
            id: "fontDown",
            label: "Decrease font size",
            accel: acc("fontDown"),
          },
        ],
      },
      {
        label: "Paragraph styles",
        submenu: [
          ["p", "Normal text", "CmdOrCtrl+Alt+0"],
          ["title", "Title"],
          ["subtitle", "Subtitle"],
          ["h1", "Heading 1", "CmdOrCtrl+Alt+1"],
          ["h2", "Heading 2", "CmdOrCtrl+Alt+2"],
          ["h3", "Heading 3", "CmdOrCtrl+Alt+3"],
          ["h4", "Heading 4", "CmdOrCtrl+Alt+4"],
        ].map(([v, l]) => ({ id: "style:" + v, label: l, accel: acc("style:" + v) || undefined })),
      },
      {
        label: "Align & indent",
        submenu: [
          { id: "justifyLeft", label: "Left", accel: acc("justifyLeft") },
          { id: "justifyCenter", label: "Center", accel: acc("justifyCenter") },
          { id: "justifyRight", label: "Right", accel: acc("justifyRight") },
          { id: "justifyFull", label: "Justified", accel: acc("justifyFull") },
          { type: "separator" },
          { id: "indent", label: "Increase indent" },
          { id: "outdent", label: "Decrease indent" },
        ],
      },
      {
        label: "Line & paragraph spacing",
        submenu: [
          ["1", "Single"],
          ["1.15", "1.15"],
          ["1.5", "1.5"],
          ["2", "Double"],
        ]
          .map(([v, l]) => ({ id: "ls:" + v, label: l }))
          .concat([
            { type: "separator" },
            { id: "ps:before:1", label: "Add space before paragraph" },
            { id: "ps:after:1", label: "Add space after paragraph" },
          ]),
      },
      {
        label: "Bullets & numbering",
        submenu: [
          {
            id: "insertUnorderedList",
            label: "Bulleted list",
            accel: acc("insertUnorderedList"),
          },
          {
            id: "insertOrderedList",
            label: "Numbered list",
            accel: acc("insertOrderedList"),
          },
          { id: "checklist", label: "Checklist", accel: acc("checklist") },
        ],
      },
      { type: "separator" },
      { id: "clearFormat", label: "Clear formatting", accel: acc("clearFormat") },
    ],
    tools: () => [
      { id: "wordCount", label: "Word count", accel: acc("wordCount") },
      { id: "spell", label: "Spell check", checked: ed.spellcheck },
      { type: "separator" },
      {
        id: "update",
        label:
          update.state === "ready"
            ? `Restart to update (v${update.version})`
            : "Check for updates",
      },
      { id: "settings", label: "Settings", accel: acc("settings") },
    ],
  };
  $$("#menubar [data-menu]").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", async () => {
      btn.classList.add("open");
      const r = btn.getBoundingClientRect();
      const id = await api.call(
        "menu:popup",
        MENUS[btn.dataset.menu](),
        Math.round(r.left),
        Math.round(r.bottom + 2),
      );
      btn.classList.remove("open");
      if (id) run(id);
    });
  });

  /* ---------------- command dispatcher ---------------- */
  async function run(id, srcEl) {
    const [cmd, arg, arg2] = id.split(":");
    switch (cmd) {
      case "new":
        return newDoc();
      case "newFolder":
        return newFolder();
      case "docs":
        return toggleSidebar();
      case "import":
        return importFiles();
      case "export":
        return exportAs(arg);
      case "rename":
        titleInput.focus();
        titleInput.select();
        return;
      case "delete":
        return cur.rel && deleteItem(cur.rel, false);
      case "reveal":
        return api.call("docs:openFolder", dirOf(cur.rel));
      case "print": {
        await saveNow();
        const r = await safeCall("print", baseName(cur.rel), exportHtml(), pageCss());
        if (r && !r.ok && r.why && !/cancel/i.test(r.why) && r.why !== "busy")
          toast(`Couldn't print (${r.why}). Try Download as PDF instead.`, 6000);
        return;
      }
      case "hide":
        await saveNow();
        return api.call("win:hide");
      case "quit":
        await saveNow();
        return api.call("win:quit");
      case "undo":
      case "redo":
        return exec(cmd);
      case "selectAll":
        return chain().selectAll().run();
      case "cut":
      case "copy":
      case "paste":
        editor.commands.focus();
        return api.call("edit:native", cmd);
      case "delSel":
        return exec("delete");
      case "pastePlain":
        editor.commands.focus();
        plainNext = true;
        setTimeout(() => (plainNext = false), 600);
        return api.call("edit:native", "paste");
      case "find":
        return openFind(true);
      case "immersive":
        return setMode(S.mode === "immersive" ? "editor" : "immersive");
      case "zoom":
        return arg === "in"
          ? stepZoom(1)
          : arg === "out"
            ? stepZoom(-1)
            : setZoom(arg);
      case "page":
        return setSetting({ editorPage: arg });
      case "theme":
        return setSetting({ theme: arg });
      case "darkStyle":
        return setSetting({ darkStyle: arg });
      case "fullscreen":
        return api.call("win:fullscreen", !fullscreen);
      case "update":
        return update.state === "ready" ? installUpdate() : checkForUpdates();
      case "installUpdate": // you said "Update now" in the update dialog
        return installUpdate();
      case "lines":
        return setSetting({ linesPerView: +arg });
      case "cycleLines":
        return cycleLines();
      case "cycleOpacity":
        return cycleOpacity();
      case "heading":
        return jumpHeading(arg === "prev" ? -1 : 1);
      case "imm": // overlay: home / end / bigger / smaller / exit
        return S.mode === "immersive" && runKey("imm:" + arg);
      case "alwaysOnTop":
        return setSetting({ alwaysOnTop: !S.alwaysOnTop });
      case "image": {
        const srcs = await safeCall("image:pick");
        return insertImages(srcs);
      }
      case "table":
        return tablePopover(srcEl || $('.tb[data-cmd="table"]'));
      case "link":
        return openLinkDialog();
      case "unlink":
        caretToCtxTarget();
        return chain().extendMarkRange("link").unsetLink().run();
      case "hr":
        return chain().setHorizontalRule().run();
      case "pageBreak":
        return chain().insertPageBreak().run();
      case "date":
        return insertHtmlAtCursor(
          escHtml(
            new Date().toLocaleDateString(undefined, {
              year: "numeric",
              month: "long",
              day: "numeric",
            }),
          ),
        );
      case "checklist":
        return toggleChecklist();
      case "style":
        return setBlockStyle(arg);
      case "ls":
        return setLineSpacing(arg);
      case "ps":
        return paraSpace(arg, arg2 === "1");
      case "fontUp":
        return stepFontSize(1);
      case "fontDown":
        return stepFontSize(-1);
      case "clearFormat":
        return clearFormat();
      case "foreColor":
      case "hiliteColor":
        return colorPopover(srcEl || $(`.tb[data-cmd="${cmd}"]`), cmd);
      case "lineSpacing":
        return spacingPopover(srcEl || $('.tb[data-cmd="lineSpacing"]'));
      case "wordCount":
        return showWordCount();
      case "spell":
        ed.spellcheck = !ed.spellcheck;
        ls.set("spell", ed.spellcheck);
        $('.tb[data-cmd="spell"]').classList.toggle("on", !ed.spellcheck);
        ed.blur();
        editor.commands.focus();
        return;
      case "settings":
        return openSettings();
      case "table-op":
        return tableOp(arg);
      case "img":
        return imgOp(arg);
      case "imgalign":
        return imgAlign(arg);
      case "bold":
      case "italic":
      case "underline":
      case "strikeThrough":
      case "superscript":
      case "subscript":
      case "justifyLeft":
      case "justifyCenter":
      case "justifyRight":
      case "justifyFull":
      case "insertUnorderedList":
      case "insertOrderedList":
      case "indent":
      case "outdent":
        return exec(cmd);
    }
  }
  $$("#toolbar .tb").forEach((b) => {
    b.addEventListener("mousedown", (e) => e.preventDefault()); // keep the text selection
    b.addEventListener("click", () => run(b.dataset.cmd, b));
  });
  const ff = $("#font-family");
  FONTS.forEach((f) => {
    const o = new Option(f, f);
    o.style.fontFamily = f;
    ff.add(o);
  });
  ff.onchange = () => {
    chain().setFontFamily(ff.value).run();
  };
  $("#block-style").onchange = (e) => setBlockStyle(e.target.value);
  const fsInput = $("#font-size");
  fsInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      setFontSize(parseFloat(fsInput.value));
    }
    if (e.key === "Escape") {
      editor.commands.focus();
      updateToolbar();
    }
  });
  fsInput.addEventListener("focus", () => fsInput.select());
  if (ls.get("spell", true) === false) {
    ed.spellcheck = false;
    $('.tb[data-cmd="spell"]').classList.add("on");
  }

  /* ---------------- immersive ---------------- */
  async function loadImmersive() {
    const o = immOpts();
    try {
      o.maxH = (await api.call("win:workArea")).height - 24;
    } catch {}
    if (S.mode !== "immersive") return; // switched back while waiting
    lastImmOpts = JSON.stringify(immOpts());
    Immersive.open(serialize(), (S.readPositions || {})[cur.rel] || 0, o);
  }
  Immersive.onPosition(
    debounce((line) => {
      if (!cur.rel) return;
      S.readPositions = S.readPositions || {};
      if (S.readPositions[cur.rel] === line) return;
      S.readPositions[cur.rel] = line;
      setSetting({ readPositions: S.readPositions }, true);
    }, 500),
  );
  async function setMode(m) {
    if (m === "immersive") {
      await saveNow();
      deselectImage();
      hideLinkBubble();
      hidePopover();
    }
    await api.call("win:setMode", m);
  }
  function applyMode(m) {
    S.mode = m;
    document.body.classList.toggle("mode-immersive", m === "immersive");
    document.body.classList.toggle("mode-editor", m === "editor");
    if (m === "immersive") {
      closeDialog();
      loadImmersive();
    } else {
      Immersive.setActive(false);
      setTimeout(() => {
        applyZoom();
        editor.commands.focus(null, { scrollIntoView: false });
        editor.ln.paginate();
      }, 50);
    }
  }
  $("#btn-immersive").onclick = () => setMode("immersive");
  $("#imm-exit").onclick = () => setMode("editor");
  $("#imm-hide").onclick = () => api.call("win:hide");
  $("#imm-lines").onclick = cycleLines;
  const zoomBy = (d) =>
    setSetting(
      {
        immersiveZoom:
          Math.round(
            Math.max(0.5, Math.min(3, (+S.immersiveZoom || 1) + d)) * 10,
          ) / 10,
      },
      true,
    );
  $("#imm-smaller").onclick = () => zoomBy(-0.1);
  $("#imm-bigger").onclick = () => zoomBy(0.1);
  window.addEventListener("imm-zoom", (e) => zoomBy(e.detail));
  $$("#imm-controls button").forEach((b) =>
    b.addEventListener("pointerdown", (e) => e.stopPropagation()),
  );

  // hover controls
  const imm = $("#imm");
  let ctlTimer;
  imm.addEventListener("pointermove", () => {
    imm.classList.add("show-controls");
    clearTimeout(ctlTimer);
    ctlTimer = setTimeout(() => imm.classList.remove("show-controls"), 1800);
  });
  imm.addEventListener("pointerleave", () => {
    clearTimeout(ctlTimer);
    ctlTimer = setTimeout(() => imm.classList.remove("show-controls"), 300);
  });

  // drag the overlay anywhere
  imm.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const sx = e.screenX,
      sy = e.screenY,
      wx = window.screenX,
      wy = window.screenY;
    let moved = false,
      raf = 0,
      lx = sx,
      ly = sy;
    imm.setPointerCapture(e.pointerId);
    const move = (ev) => {
      lx = ev.screenX;
      ly = ev.screenY;
      if (!moved && Math.abs(lx - sx) + Math.abs(ly - sy) < 3) return;
      if (!moved) {
        moved = true;
        document.body.classList.add("dragging");
      }
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          api.move(wx + lx - sx, wy + ly - sy);
        });
    };
    const up = () => {
      imm.removeEventListener("pointermove", move);
      imm.removeEventListener("pointerup", up);
      imm.removeEventListener("pointercancel", up);
      document.body.classList.remove("dragging");
    };
    imm.addEventListener("pointermove", move);
    imm.addEventListener("pointerup", up);
    imm.addEventListener("pointercancel", up);
  });

  /* ---------------- window resize handles ---------------- */
  $$(".rz").forEach((h) =>
    h.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      h.setPointerCapture(e.pointerId);
      const edge = h.dataset.edge,
        sx = e.screenX,
        sy = e.screenY;
      const b0 = {
        x: window.screenX,
        y: window.screenY,
        width: window.outerWidth,
        height: window.outerHeight,
      };
      const minW = S.mode === "immersive" ? 160 : 420,
        minH = 240;
      let raf = 0,
        last = null;
      const move = (ev) => {
        const dx = ev.screenX - sx,
          dy = ev.screenY - sy;
        const b = { ...b0 };
        if (edge.includes("e")) b.width = Math.max(minW, b0.width + dx);
        if (edge.includes("w")) {
          b.width = Math.max(minW, b0.width - dx);
          b.x = b0.x + b0.width - b.width;
        }
        if (edge.includes("s")) b.height = Math.max(minH, b0.height + dy);
        if (edge.includes("n")) {
          b.height = Math.max(minH, b0.height - dy);
          b.y = b0.y + b0.height - b.height;
        }
        last = b;
        if (!raf)
          raf = requestAnimationFrame(() => {
            raf = 0;
            api.resize(last);
          });
      };
      const up = () => {
        h.removeEventListener("pointermove", move);
        h.removeEventListener("pointerup", up);
      };
      h.addEventListener("pointermove", move);
      h.addEventListener("pointerup", up);
    }),
  );

  /* ---------------- settings dialog ---------------- */
  // Mini editor mock-ups for the appearance choices. Colours are fixed (not theme tokens) so each card
  // shows what that option looks like, combined with whatever else is currently chosen.
  const PV_WIN = {
    light: {
      chrome: "#f9fbfd",
      bar: "#edf2fa",
      canvas: "#f9fbfd",
      border: "#dadce0",
      line: "#5f6368",
    },
    gray: {
      chrome: "#1b1b1b",
      bar: "#282a2c",
      canvas: "#1f1f1f",
      border: "#3c4043",
      line: "#9aa0a6",
    },
    black: {
      chrome: "#000000",
      bar: "#141414",
      canvas: "#000000",
      border: "#262626",
      line: "#9aa0a6",
    },
  };
  const PV_PAGE = {
    paper: { page: "#ffffff", edge: "#d0d0d0", text: "#a9adb1" },
    gray: { page: "#262626", edge: "#3a3a3a", text: "#6e6e6e" },
    black: { page: "#000000", edge: "#2e2e2e", text: "#555555" },
  };
  function pvHtml(win, pg, cls = "") {
    const w = PV_WIN[win],
      p = PV_PAGE[win === "light" ? "paper" : pg] || PV_PAGE.paper;
    const vars = `--pv-chrome:${w.chrome};--pv-bar:${w.bar};--pv-canvas:${w.canvas};--pv-border:${w.border};--pv-line:${w.line};--pv-page:${p.page};--pv-page-edge:${p.edge};--pv-text:${p.text}`;
    return `<span class="pv ${cls}" style="${vars}"><i class="pv-top"></i><i class="pv-bar"></i><span class="pv-canvas"><span class="pv-page"><b></b><b></b><b></b><b></b></span></span></span>`;
  }
  function renderPreviews() {
    const dark = S.darkStyle === "gray" ? "gray" : "black",
      pg = S.editorPage || "paper";
    $$(".pv-group[data-preview]").forEach((group) => {
      $$("button", group).forEach((b) => {
        if (!b.dataset.label) b.dataset.label = b.textContent.trim();
        const v = b.dataset.v;
        let mock;
        if (group.dataset.preview === "theme") {
          mock =
            v === "light"
              ? pvHtml("light")
              : v === "dark"
                ? pvHtml(dark, pg)
                : pvHtml("light") + pvHtml(dark, pg, "pv-dark-half");
        } else if (group.dataset.preview === "darkStyle") mock = pvHtml(v, pg);
        else mock = pvHtml(dark, v);
        b.innerHTML = `<span class="pv-stack">${mock}</span><span class="pv-label">${escHtml(b.dataset.label)}${"default" in b.dataset ? "<em>Default</em>" : ""}</span>`;
      });
    });
  }

  // previews: redraw the appearance mock-ups; keyRows: redraw the shortcut list (both slow-ish)
  function fillSettings({ previews = true, keyRows = true } = {}) {
    if (previews) renderPreviews();
    $$(".seg[data-setting], .pv-group[data-setting]").forEach((seg) => {
      const v = String(S[seg.dataset.setting]);
      $$("button", seg).forEach((b) =>
        b.classList.toggle("on", b.dataset.v === v),
      );
    });
    $$("input[type=range][data-setting]").forEach((r) => {
      r.value = Math.round(S[r.dataset.setting] * (+r.dataset.scale || 1));
      const lab = $("#v-" + r.dataset.setting);
      if (lab) lab.textContent = r.value + "%";
    });
    $$(".switch input[data-setting]").forEach(
      (c) => (c.checked = !!S[c.dataset.setting]),
    );
    const sf = $("#set-font");
    if (!sf.options.length) FONTS.forEach((f) => sf.add(new Option(f, f)));
    sf.value = S.defaultFont;
    const ss = $("#set-size");
    if (!ss.options.length)
      SIZES.forEach((s) => ss.add(new Option(s + " pt", s)));
    ss.value = S.defaultFontSize;
    $('select[data-setting="defaultLineSpacing"]').value = String(
      S.defaultLineSpacing,
    );
    $('select[data-setting="scrollLines"]').value = String(+S.scrollLines || 0);
    $('select[data-setting="anywhereScroll"]').value = S.anywhereScroll || "off";
    $('select[data-setting="headingScroll"]').value = S.headingScroll || "off";
    fillLines();
    $$(".k[data-accel]").forEach((k) => (k.textContent = prettyAccel(S[k.dataset.accel])));
    $$(".shortcut:not(.rec)").forEach(
      (i) => (i.value = prettyAccel(S[i.dataset.setting])),
    );
    if (keyRows && !keyRecorder) renderKeyRows();
    $("#set-folder").textContent = S.docsFolder;
    $("#set-folder").title = S.docsFolder;
    $("#set-version").textContent = `Interview Notes ${S.version || ""}`;
    showShortcutErrors();
  }
  function showShortcutErrors() {
    const errs = S.shortcutErrors || {};
    $$(".sc-err").forEach(
      (el) => (el.textContent = errs[el.dataset.err] || ""),
    );
    $("#hint").textContent =
      `${prettyAccel(S.toggleShortcut)} hide · ${prettyAccel(S.immersiveShortcut)} immersive`;
  }
  async function openSettings() {
    if (S.mode === "immersive") await setMode("editor");
    S = { ...S, ...(await api.call("settings:get")) };
    fillSettings();
    openDialog("dlg-settings");
  }
  $("#btn-settings").onclick = openSettings;
  $("#btn-export").onclick = async () => {
    const r = $("#btn-export").getBoundingClientRect();
    const id = await api.call("menu:popup", [
      { id: "print", label: "Print…", accel: acc("print") },
      { type: "separator" },
      { id: "export:pdf", label: "Download as PDF (.pdf)" },
      { id: "export:docx", label: "Download as Word (.docx)" },
      { id: "export:html", label: "Download as web page (.html)" },
    ], Math.round(r.left), Math.round(r.bottom + 2));
    if (id) run(id);
  };
  $("#btn-hide").onclick = () => run("hide");
  $("#btn-close").onclick = () => run("quit");
  $$(".seg[data-setting], .pv-group[data-setting]").forEach((seg) =>
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const v = "num" in seg.dataset ? +b.dataset.v : b.dataset.v;
      setSetting({ [seg.dataset.setting]: v }); // the dialog updates straight away
    }),
  );
  $$("input[type=range][data-setting]").forEach((r) =>
    r.addEventListener("input", () => {
      const lab = $("#v-" + r.dataset.setting);
      if (lab) lab.textContent = r.value + "%";
      setSetting(
        { [r.dataset.setting]: +r.value / (+r.dataset.scale || 1) },
        true,
      );
    }),
  );
  $$(".switch input[data-setting]").forEach((c) =>
    c.addEventListener("change", () =>
      setSetting({ [c.dataset.setting]: c.checked }),
    ),
  );
  $$(".settings-body select[data-setting]").forEach((s) =>
    s.addEventListener("change", () =>
      setSetting({
        [s.dataset.setting]: "num" in s.dataset ? +s.value : s.value,
      }),
    ),
  );
  $("#set-folder-change").onclick = async () => {
    const p = await safeCall("docs:chooseFolder");
    if (!p) return;
    await saveNow();
    await setSetting({ docsFolder: p });
    fillSettings();
    await refreshTree();
    const first = firstDoc(tree);
    if (first) openDoc(first, { focus: false });
    else newDoc("");
    $("#sb-root").textContent = p;
  };
  $("#set-folder-open").onclick = () => api.call("docs:openFolder", "");
  $("#set-quit").onclick = () => run("quit");
  $("#sc-reset").onclick = () =>
    setSetting({
      toggleShortcut: "CommandOrControl+]",
      immersiveShortcut: "CommandOrControl+Alt+I",
      linesShortcut: "CommandOrControl+Alt+M",
      opacityShortcut: "CommandOrControl+Alt+O",
      headingPrevShortcut: "CommandOrControl+Alt+Up",
      headingNextShortcut: "CommandOrControl+Alt+Down",
      recenterShortcut: "CommandOrControl+Alt+0",
      scrollUpShortcut: "Alt+Up",
      scrollDownShortcut: "Alt+Down",
      homeShortcut: "CommandOrControl+Alt+Home",
      endShortcut: "CommandOrControl+Alt+End",
      biggerShortcut: "CommandOrControl+Alt+=",
      smallerShortcut: "CommandOrControl+Alt+-",
      anywhereScroll: "alt",
      headingScroll: "ctrl+alt",
      keys: {},
    }).then(() => {
      rebuildKeys();
      fillSettings();
    });

  // lines shown at a time: 1 / 2 / custom (1–25) / default 25
  const linesSeg = $("#lines-seg"),
    linesN = $("#lines-custom-n");
  const isCustomLines = () => ![1, 2, 25].includes(+S.linesPerView);
  function fillLines() {
    const v = isCustomLines() ? "custom" : String(S.linesPerView);
    $$("button", linesSeg).forEach((b) =>
      b.classList.toggle("on", b.dataset.v === v),
    );
    linesN.value = isCustomLines() ? S.linesPerView : +S.customLines || 3;
    $("#lines-custom").classList.toggle("dim", !isCustomLines());
  }
  function setCustomLines(n) {
    n = Math.max(1, Math.min(25, Math.round(+n) || 3));
    setSetting({ linesPerView: n, customLines: n }).then(fillLines);
  }
  linesSeg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.v === "custom") setCustomLines(linesN.value);
    else setSetting({ linesPerView: +b.dataset.v }).then(fillLines);
  });
  $$("#lines-custom button").forEach((b) =>
    b.addEventListener("click", () =>
      setCustomLines((+linesN.value || 3) + +b.dataset.d),
    ),
  );
  linesN.addEventListener("change", () => setCustomLines(linesN.value));
  linesN.addEventListener("keydown", (e) => {
    if (e.key === "Enter") setCustomLines(linesN.value);
  });

  // shortcut recorder
  const CODE_MAP = {
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
    Space: "Space",
    Enter: "Enter",
    Tab: "Tab",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Insert: "Insert",
    Delete: "Delete",
    Backspace: "Backspace",
    Escape: "Escape",
    NumpadAdd: "numadd",
    NumpadSubtract: "numsub",
    NumpadMultiply: "nummult",
    NumpadDivide: "numdiv",
    NumpadDecimal: "numdec",
    NumpadEnter: "Enter",
  };
  function keyName(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^Numpad\d$/.test(code)) return "num" + code.slice(6);
    if (/^F\d{1,2}$/.test(code)) return code;
    return CODE_MAP[code] || null;
  }
  $$(".shortcut").forEach((inp) => {
    inp.addEventListener("focus", () => {
      inp.classList.add("rec");
      inp.value = "Press a key combination…";
      api.call("shortcuts:pause", true);
    });
    inp.addEventListener("blur", () => {
      inp.classList.remove("rec");
      inp.value = prettyAccel(S[inp.dataset.setting]);
      api.call("shortcuts:pause", false);
    });
    inp.addEventListener("keydown", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        inp.blur();
        return;
      }
      const k = keyName(e.code);
      if (!k) return;
      const mods = [];
      if (e.ctrlKey) mods.push("CommandOrControl");
      if (e.altKey) mods.push("Alt");
      if (e.shiftKey) mods.push("Shift");
      if (e.metaKey) mods.push("Super");
      if (!mods.length && !/^F\d+$/.test(k)) {
        inp.value = "Add Ctrl, Alt or Shift";
        return;
      }
      const accel = [...mods, k].join("+");
      const g = GLOBAL_KEYS.find((x) => x[0] === inp.dataset.setting);
      const owner = RESERVED[accel] || keyOwner(accel, scopesOf(g ? g[2] : "both"), inp.dataset.setting);
      if (owner) {
        inp.value = `Used by “${owner}”`;
        return;
      }
      inp.classList.remove("rec");
      await setSetting({ [inp.dataset.setting]: accel });
      inp.blur();
      fillSettings();
      if (!(S.shortcutErrors || {})[inp.dataset.setting])
        toast("Shortcut set to " + prettyAccel(accel));
    });
  });

  /* ---------------- full screen ---------------- */
  function applyFullscreen(on) {
    fullscreen = !!on;
    document.body.classList.toggle("fullscreen", fullscreen);
    const b = $("#btn-fullscreen");
    b.dataset.base = fullscreen ? "Exit full screen" : "Full screen";
    refreshKeyHints();
    b.innerHTML = icon(fullscreen ? "fullscreenExit" : "fullscreen");
    applyZoom();
  }
  $("#btn-fullscreen").onclick = () => run("fullscreen");

  /* ---------------- updates ---------------- */
  const UPDATE_TEXT = {
    idle: () => "When there's a new version, you're asked whether to install it each time you open the app.",
    dev: () => "Updates only work in the installed app.",
    checking: () => "Checking for updates…",
    none: () => `You're on the latest version (${S.version}).`,
    downloading: (u) =>
      `Downloading version ${u.version}… ${u.percent != null ? Math.round(u.percent) + "%" : ""}`,
    ready: (u) =>
      `Version ${u.version} is ready to install. Click Restart & update now, or you'll be asked next time you open the app.`,
    installing: (u) => `Installing version ${u.version}…`,
    error: (u) =>
      `Couldn't check for updates${u.message ? ": " + u.message : ""}`,
  };
  function applyUpdateStatus(u) {
    update = u;
    $("#set-update-status").textContent = (
      UPDATE_TEXT[u.state] || UPDATE_TEXT.idle
    )(u);
    $("#set-update").textContent =
      u.state === "ready" ? "Restart & update now" : "Check for updates";
    $("#set-update").disabled =
      u.state === "checking" ||
      u.state === "downloading" ||
      u.state === "installing";
    $("#btn-update").hidden = u.state !== "ready";
  }
  async function checkForUpdates() {
    const u = await safeCall("update:check");
    if (u) applyUpdateStatus(u);
    if (u && !$("#dlg-settings").hidden) return;
    if (u && ["dev", "none", "error"].includes(u.state))
      toast(UPDATE_TEXT[u.state](u), 4000);
    else if (u && u.state === "downloading")
      toast(`Downloading version ${u.version} in the background…`);
  }
  async function installUpdate() {
    // (the main process shows an "Updating Interview Notes" screen while it installs)
    applyUpdateStatus({ ...update, state: "installing" });
    await saveNow().catch(() => {});
    await api.call("update:install");
  }
  $("#set-update").onclick = () => run("update");
  $("#btn-update").onclick = installUpdate;

  /* ---------------- keyboard shortcuts ---------------- */
  // Every in-app shortcut, changeable in Settings → Keyboard shortcuts (the ones that work from any
  // app are the separate *Shortcut settings above, registered by the main process).
  // scope: "editor" | "overlay" | "both". repeat: keeps firing while the keys are held.
  // Changed ones are saved in S.keys as { id: [accelerators] }.
  const C = "CommandOrControl+";
  // Standard editing keys (undo, bold, headings, print, …) work as everywhere else and aren't listed
  // in Settings; only the app's own ones are (`shown`).
  const APP_KEYS = [
    ["File", "new", "New document", [C + "N"]],
    ["File", "docs", "Show / hide the document list", [C + "O"], "editor", false, true],
    ["File", "save", "Save now", [C + "S"]],
    ["File", "print", "Print", [C + "P", C + "Shift+P"]],
    ["File", "settings", "Settings", [C + ","], "both"],
    ["File", "quit", "Quit", [C + "Q"], "both"],
    ["Edit", "undo", "Undo", [C + "Z"], "editor", true],
    ["Edit", "redo", "Redo", [C + "Y", C + "Shift+Z"], "editor", true],
    ["Edit", "pastePlain", "Paste without formatting", [C + "Shift+V"]],
    ["Edit", "findOnly", "Find", [C + "F"]],
    ["Edit", "find", "Find and replace", [C + "H"]],
    ["View", "fullscreen", "Full screen", ["F11"], "editor", false, true],
    ["View", "zoom:in", "Zoom in", [C + "=", C + "Shift+=", C + "numadd"], "editor", true],
    ["View", "zoom:out", "Zoom out", [C + "-", C + "numsub"], "editor", true],
    ["View", "zoom:1", "Zoom to 100%", [C + "0", C + "num0"]],
    ["Insert", "link", "Link", [C + "K"]],
    ["Format", "bold", "Bold", [C + "B"]],
    ["Format", "italic", "Italic", [C + "I"]],
    ["Format", "underline", "Underline", [C + "U"]],
    ["Format", "strikeThrough", "Strikethrough", ["Alt+Shift+5"]],
    ["Format", "superscript", "Superscript", [C + "."]],
    ["Format", "fontUp", "Bigger text", [C + "Shift+."], "editor", true],
    ["Format", "fontDown", "Smaller text", [C + "Shift+,"], "editor", true],
    ["Format", "clearFormat", "Clear formatting", [C + "\\"]],
    ["Format", "style:p", "Normal text", [C + "Alt+0"]],
    ["Format", "style:h1", "Heading 1", [C + "Alt+1"]],
    ["Format", "style:h2", "Heading 2", [C + "Alt+2"]],
    ["Format", "style:h3", "Heading 3", [C + "Alt+3"]],
    ["Format", "style:h4", "Heading 4", [C + "Alt+4"]],
    ["Format", "justifyLeft", "Align left", [C + "Shift+L"]],
    ["Format", "justifyCenter", "Align center", [C + "Shift+E"]],
    ["Format", "justifyRight", "Align right", [C + "Shift+R"]],
    ["Format", "justifyFull", "Justify", [C + "Shift+J"]],
    ["Format", "insertOrderedList", "Numbered list", [C + "Shift+7"]],
    ["Format", "insertUnorderedList", "Bulleted list", [C + "Shift+8"]],
    ["Format", "checklist", "Checklist", [C + "Shift+9"]],
    ["Tools", "wordCount", "Word count", [C + "Shift+C"], "editor", false, true],
    ["Overlay", "imm:exit", "Back to the editor (when the overlay has focus)", ["Escape"], "overlay", false, true],
  ].map(([group, id, label, keys, scope = "editor", repeat = false, shown = false]) => ({ group, id, label, keys, scope, repeat, shown }));
  const APP_KEY = Object.fromEntries(APP_KEYS.map((c) => [c.id, c]));
  // shortcuts that work from any app (main process) — and where they also apply
  const GLOBAL_KEYS = [
    ["toggleShortcut", "Show / hide Interview Notes", "both"],
    ["immersiveShortcut", "Switch editor ↔ overlay", "both"],
    ["linesShortcut", "Change lines shown", "both"],
    ["opacityShortcut", "Change overlay opacity", "both"],
    ["headingPrevShortcut", "Previous heading", "both"],
    ["headingNextShortcut", "Next heading", "both"],
    ["recenterShortcut", "Recenter the overlay", "overlay"],
    ["scrollUpShortcut", "Scroll the overlay up", "overlay"],
    ["scrollDownShortcut", "Scroll the overlay down", "overlay"],
    ["homeShortcut", "Overlay: back to the start", "overlay"],
    ["endShortcut", "Overlay: go to the end", "overlay"],
    ["biggerShortcut", "Overlay: bigger text", "overlay"],
    ["smallerShortcut", "Overlay: smaller text", "overlay"],
  ];
  // kept for typing and the clipboard — never offered as a shortcut
  const RESERVED = {
    [C + "C"]: "copy", [C + "V"]: "paste", [C + "X"]: "cut", [C + "A"]: "select all",
    Tab: "indenting lists", "Shift+Tab": "indenting lists",
  };

  const keysFor = (id) => ((S.keys || {})[id] !== undefined ? S.keys[id] : APP_KEY[id] ? APP_KEY[id].keys : []);
  const acc = (id) => keysFor(id)[0]; // shown next to menu items
  const scopesOf = (scope) => (scope === "both" ? ["editor", "overlay"] : [scope]);
  let keyIndex = new Map(); // "scope|accelerator" → command
  function rebuildKeys() {
    keyIndex = new Map();
    for (const c of APP_KEYS)
      for (const a of keysFor(c.id))
        for (const sc of scopesOf(c.scope)) if (!keyIndex.has(sc + "|" + a)) keyIndex.set(sc + "|" + a, c);
    refreshKeyHints();
  }
  // the accelerator a key press stands for, in the same format as the settings
  function accelOf(e) {
    const k = keyName(e.code);
    if (!k) return null;
    const mods = [];
    if (e.ctrlKey) mods.push("CommandOrControl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Super");
    return [...mods, k].join("+");
  }
  // who already uses an accelerator in a scope: a label, or null
  function keyOwner(accel, scopes, exceptId) {
    for (const [k, label, sc] of GLOBAL_KEYS)
      if (k !== exceptId && S[k] === accel && scopesOf(sc).some((x) => scopes.includes(x))) return label;
    for (const c of APP_KEYS)
      if (c.id !== exceptId && keysFor(c.id).includes(accel) && scopesOf(c.scope).some((x) => scopes.includes(x)))
        return (c.group === "Overlay" ? "Overlay: " : "") + c.label;
    return null;
  }
  function runKey(id) {
    switch (id) {
      case "save":
        cur.dirty = true;
        return saveNow().then(() => toast("Saved", 1200));
      case "findOnly":
        return openFind(false);
      case "imm:home":
        return Immersive.home();
      case "imm:end":
        return Immersive.end();
      case "imm:bigger":
        return zoomBy(0.1);
      case "imm:smaller":
        return zoomBy(-0.1);
      case "imm:exit":
        return setMode("editor");
      case "pastePlain":
        return run("pastePlain");
    }
    return run(id);
  }
  // Runs before the editor sees the key, so a shortcut always wins over typing and a key you
  // removed from a command really does nothing.
  window.addEventListener(
    "keydown",
    (e) => {
      if (keyRecorder || !back.hidden) return; // recording a shortcut, or a dialog is open
      const a = accelOf(e);
      if (!a) return;
      const c = keyIndex.get((S.mode === "immersive" ? "overlay" : "editor") + "|" + a);
      if (!c) return;
      const t = e.target;
      if (t && t.matches && t.matches("input, textarea, select")) {
        // in a text box (title, find, font size…) its own editing keys win
        if (["Edit", "Format", "Insert"].includes(c.group) && c.id !== "findOnly" && c.id !== "find") return;
        if (!/CommandOrControl|Alt|Super|^F\d/.test(a)) return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat && !c.repeat) return;
      runKey(c.id);
    },
    true,
  );
  // Keys that aren't commands: Esc closes things, and the from-any-app shortcuts when they reach the window.
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || keyRecorder) return;
    if (matchesAccel(e, S.headingPrevShortcut) || matchesAccel(e, S.headingNextShortcut)) {
      e.preventDefault();
      return jumpHeading(matchesAccel(e, S.headingPrevShortcut) ? -1 : 1);
    }
    if (matchesAccel(e, S.opacityShortcut)) {
      e.preventDefault();
      return cycleOpacity();
    }
    if (S.mode === "immersive") {
      if (matchesAccel(e, S.recenterShortcut)) {
        e.preventDefault();
        api.call("win:recenter");
      } else if (matchesAccel(e, S.scrollUpShortcut) || matchesAccel(e, S.scrollDownShortcut)) {
        e.preventDefault(); // (normally taken by the main process before it gets here)
        Immersive.go(matchesAccel(e, S.scrollUpShortcut) ? -1 : 1);
      } else {
        const c = [["homeShortcut", "imm:home"], ["endShortcut", "imm:end"], ["biggerShortcut", "imm:bigger"], ["smallerShortcut", "imm:smaller"]]
          .find(([k]) => matchesAccel(e, S[k]));
        if (c) {
          e.preventDefault();
          runKey(c[1]);
        }
      }
      return;
    }
    if (!back.hidden) return;
    if (e.key === "Escape") {
      if (!pop.hidden) hidePopover();
      else if (findOpen) closeFind();
      else if (selImg) deselectImage();
      else if (fullscreen) run("fullscreen");
    }
  });

  // Show each command's current shortcut in button tooltips: "Bold (Ctrl + B)".
  function refreshKeyHints() {
    $$("[data-cmd], [data-key-cmd]").forEach((b) => {
      const id = b.dataset.keyCmd || b.dataset.cmd;
      if (!APP_KEY[id]) return;
      if (b.dataset.base === undefined) b.dataset.base = (b.title || "").replace(/\s*\([^)]*\)\s*$/, "");
      const k = acc(id);
      b.title = b.dataset.base + (k ? ` (${prettyAccel(k)})` : "");
    });
  }

  // Settings → Keyboard shortcuts: one row per command, its keys as chips
  // (click one to change it, × to remove it, + to add another, ↺ for the default).
  let keyRecorder = null; // { id, index, button } while waiting for keys
  function renderKeyRows() {
    const box = $("#app-keys");
    let html = "";
    let group = "";
    for (const c of APP_KEYS) {
      if (!c.shown) continue;
      const g = c.group === "Overlay" ? "Overlay" : "Editor";
      if (g !== group) {
        group = g;
        html += `<h4 class="keys-group" data-group="${group}">${group === "Overlay" ? "In the overlay window" : "In the editor"}</h4>`;
      }
      const keys = keysFor(c.id);
      const changed = (S.keys || {})[c.id] !== undefined;
      html += `<div class="row key-row" data-cmd="${c.id}" data-group="${g}"><span>${escHtml(c.label)}</span><div class="keys">${keys
        .map((k, i) => `<button class="key-chip" data-i="${i}" title="Click to change">${escHtml(prettyAccel(k))}<i class="x" data-x="${i}" title="Remove">×</i></button>`)
        .join("")}<button class="key-add" title="Add a shortcut">+</button>${changed ? `<button class="key-reset" title="Back to the default (${escHtml(APP_KEY[c.id].keys.map(prettyAccel).join(", ") || "none")})">↺</button>` : ""}</div></div>`;
    }
    box.innerHTML = html;
    filterKeyRows();
  }
  function filterKeyRows() {
    const q = $("#keys-filter").value.trim().toLowerCase();
    $$(".settings-body .row[data-key-search], #app-keys .key-row").forEach((r) => {
      const text = (r.textContent + " " + (r.dataset.group || "")).toLowerCase();
      r.hidden = !!q && !text.includes(q);
    });
    $$(".settings-body .keys-group").forEach((h) => {
      h.hidden = !!q && !$$(`.settings-body .row[data-group="${h.dataset.group}"]`).some((r) => !r.hidden);
    });
  }
  $("#keys-filter").addEventListener("input", filterKeyRows);
  async function saveKeys(id, list) {
    const keys = { ...(S.keys || {}) };
    const def = APP_KEY[id].keys;
    if (list && !(list.length === def.length && list.every((k, i) => k === def[i]))) keys[id] = list;
    else delete keys[id];
    await setSetting({ keys });
    rebuildKeys();
    renderKeyRows();
  }
  function stopRecording() {
    if (!keyRecorder) return;
    keyRecorder = null;
    api.call("shortcuts:pause", false).catch(() => {});
    renderKeyRows();
  }
  $("#app-keys").addEventListener("click", (e) => {
    const row = e.target.closest(".key-row");
    if (!row) return;
    const id = row.dataset.cmd;
    if (e.target.dataset.x !== undefined) {
      const list = keysFor(id).filter((_, i) => i !== +e.target.dataset.x);
      return void saveKeys(id, list);
    }
    if (e.target.closest(".key-reset")) return void saveKeys(id, null);
    const b = e.target.closest(".key-chip, .key-add");
    if (!b) return;
    if (keyRecorder) stopRecording();
    const btn = $(
      b.classList.contains("key-add") ? `.key-row[data-cmd="${id}"] .key-add` : `.key-row[data-cmd="${id}"] .key-chip[data-i="${b.dataset.i}"]`,
    );
    keyRecorder = { id, index: b.classList.contains("key-add") ? -1 : +b.dataset.i, button: btn };
    btn.classList.add("rec");
    btn.textContent = "Press keys…";
    api.call("shortcuts:pause", true).catch(() => {}); // so Ctrl+] etc. can be typed here
  });
  document.addEventListener("mousedown", (e) => {
    if (keyRecorder && e.target !== keyRecorder.button) stopRecording();
  });
  window.addEventListener(
    "keydown",
    (e) => {
      if (!keyRecorder) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey) return void stopRecording();
      const a = accelOf(e);
      if (!a) return; // a modifier on its own: wait for the rest
      const { id, index, button } = keyRecorder;
      const c = APP_KEY[id];
      const say = (msg) => {
        button.textContent = msg;
        setTimeout(() => keyRecorder && keyRecorder.button === button && (button.textContent = "Press keys…"), 1600);
      };
      if (c.scope !== "overlay" && !/CommandOrControl|Alt|Super|^F\d|(^|\+)F\d/.test(a))
        return say("Add Ctrl or Alt");
      if (RESERVED[a]) return say(`${prettyAccel(a)} is for ${RESERVED[a]}`);
      const owner = keyOwner(a, scopesOf(c.scope), id);
      if (owner) return say(`Used by “${owner}”`);
      const list = [...keysFor(id)];
      if (index < 0) { if (!list.includes(a)) list.push(a); } else list[index] = a;
      keyRecorder = null;
      api.call("shortcuts:pause", false).catch(() => {});
      saveKeys(id, [...new Set(list)]);
    },
    true,
  );

  /* ---------------- IPC from main ---------------- */
  api.on("mode", (m) => applyMode(m));
  api.on("cmd", (c) => {
    if (c.startsWith("table:")) return tableOp(c.slice(6));
    run(c);
  });
  api.on("set-setting", (patch) => setSetting(patch));
  // Alt + scroll (or the chosen modifier) over any other app — sent by the main process.
  api.on("imm-scroll", (dir, steps) => {
    if (S.mode !== "immersive") return;
    for (let i = 0; i < Math.min(5, steps || 1); i++) Immersive.go(dir);
  });
  api.on("fullscreen", applyFullscreen);
  api.on("update-status", (u) => applyUpdateStatus(u));
  api.on("theme-changed", () => {
    if (S.mode === "immersive") Immersive.load(serialize(), Immersive.start);
  });
  let lastShortcutErrs = "";
  api.on("shortcut-errors", (errs) => {
    S.shortcutErrors = errs;
    showShortcutErrors();
    const msgs = Object.values(errs);
    const sig = JSON.stringify(errs);
    // shortcuts are re-registered on every mode switch — only mention a problem once
    if (msgs.length && sig !== lastShortcutErrs)
      toast("Shortcut problem: " + msgs[0] + ". Change it in Settings", 6000);
    lastShortcutErrs = sig;
  });
  window.addEventListener("focus", () => refreshTreeSoon());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) saveNow();
  });
  window.addEventListener("beforeunload", () => {
    if (cur.dirty) saveNow();
  });

  /* ---------------- start ---------------- */
  applySettings();
  rebuildKeys();
  $("#sb-root").textContent = S.docsFolder;
  await refreshTree();
  let startRel = S.lastDoc;
  if (
    !startRel ||
    !(await api.call("docs:exists", startRel).catch(() => false))
  )
    startRel = firstDoc(tree);
  if (startRel) await openDoc(startRel, { focus: S.mode !== "immersive" });
  else await newDoc("");
  applyMode(S.mode);
  showShortcutErrors();
  if (S.updatedFrom) toast(`Interview Notes was updated to version ${S.version}`, 5000);
  api
    .call("update:status")
    .then(applyUpdateStatus)
    .catch(() => {});
  window.__ln = {
    run,
    Immersive,
    setSetting,
    get S() {
      return S;
    },
    openDoc,
    editor,
    exportHtml,
    pageCss,
  };
})();
