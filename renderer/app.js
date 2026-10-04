/* Lecture Notes — renderer */
(async function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const page = $("#page");
  const canvas = $("#canvas");
  const titleInput = $("#doc-title");
  const saveState = $("#save-state");
  page.classList.add("doc");
  paintIcons();

  /* ---------------- helpers ---------------- */
  let toastTimer;
  function toast(msg, ms = 2600) {
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
  const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72, 96];

  function applySettings() {
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
      `Lines per view: ${S.linesPerView === 25 ? "default (25 max)" : S.linesPerView} — click or ${prettyAccel(S.linesShortcut)} to change`;
    $("#hint").textContent =
      `${prettyAccel(S.toggleShortcut)} hide · ${prettyAccel(S.immersiveShortcut)} immersive`;
    window.docDefaults = {
      font: S.defaultFont,
      size: S.defaultFontSize,
      ls: S.defaultLineSpacing,
    };
    if (S.mode === "immersive") Immersive.setOptions(immOpts());
    applyZoom();
  }
  const saveSettingsSoon = debounce(
    (patch) => api.call("settings:set", patch).catch(() => {}),
    300,
  );
  async function setSetting(patch, quiet) {
    Object.assign(S, patch);
    applySettings();
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
    };
  }
  // Lines-per-view modes the cycle shortcut / button steps through: 1, 2, your custom number, 25.
  function lineModes() {
    const c = Math.max(1, Math.min(25, +S.customLines || 3));
    return [...new Set([1, 2, c, 25])].sort((a, b) => a - b);
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
    return (a || "")
      .replace(/CommandOrControl|CmdOrCtrl/g, "Ctrl")
      .replace(/\+/g, " + ")
      .replace(/Super/g, "Win");
  }

  /* ---------------- document state ---------------- */
  let cur = { rel: null, dirty: false, saving: null };
  let tree = [];
  let targetFolder = "";

  function serialize() {
    const c = page.cloneNode(true);
    c.querySelectorAll(".sel").forEach((e) => {
      e.classList.remove("sel");
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
    page.innerHTML = html && html.trim() ? html : "<p><br></p>";
    titleInput.value = baseName(rel);
    document.title = baseName(rel) + " — Lecture Notes";
    saveState.textContent = "Saved to this PC";
    targetFolder = dirOf(rel);
    canvas.scrollTop = 0;
    setSetting({ lastDoc: rel }, true);
    updateWordCount();
    renderTree();
    deselectImage();
    if (S.mode === "immersive") loadImmersive();
    else if (opts.focus !== false) {
      page.focus();
      placeCaretStart();
    }
    return true;
  }
  function placeCaretStart() {
    const sel = getSelection(),
      r = document.createRange();
    r.setStart(page, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
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
      page.focus();
    }
    if (e.key === "Escape") {
      titleInput.value = baseName(cur.rel);
      page.focus();
    }
  });
  titleInput.addEventListener("blur", () => renameCurrent(titleInput.value));

  /* ---------------- selection & toolbar state ---------------- */
  let savedRange = null;
  document.addEventListener("selectionchange", () => {
    const sel = getSelection();
    if (sel.rangeCount && page.contains(sel.anchorNode)) {
      savedRange = sel.getRangeAt(0).cloneRange();
      updateToolbarSoon();
      updateLinkBubble();
    }
  });
  function restoreSel() {
    if (document.activeElement !== page) page.focus({ preventScroll: true });
    const sel = getSelection();
    if (savedRange && page.contains(savedRange.startContainer)) {
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
  }
  function anchorEl() {
    const sel = getSelection();
    let n = sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
    if (!n || !page.contains(n)) n = savedRange && savedRange.startContainer;
    if (!n) return page;
    return n.nodeType === 1 ? n : n.parentElement;
  }
  const BLOCK_SEL = "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div,td,th";
  function closestBlock(n) {
    let el = n && (n.nodeType === 1 ? n : n.parentElement);
    while (el && el !== page) {
      if (el.matches(BLOCK_SEL)) return el;
      el = el.parentElement;
    }
    return null;
  }
  function selectedBlocks() {
    const sel = getSelection();
    const r = sel.rangeCount ? sel.getRangeAt(0) : savedRange;
    if (!r) return [];
    const out = $$(BLOCK_SEL, page).filter(
      (el) =>
        r.intersectsNode(el) && !el.querySelector(BLOCK_SEL + ",table,ul,ol"),
    );
    if (!out.length) {
      const b = closestBlock(r.startContainer);
      if (b) out.push(b);
    }
    return out;
  }
  function updateToolbar() {
    if (S.mode !== "editor") return;
    const st = (c) => {
      try {
        return document.queryCommandState(c);
      } catch {
        return false;
      }
    };
    [
      "bold",
      "italic",
      "underline",
      "strikeThrough",
      "insertUnorderedList",
      "insertOrderedList",
      "justifyCenter",
      "justifyRight",
      "justifyFull",
    ].forEach((c) => {
      const b = $(`.tb[data-cmd="${c}"]`);
      if (b) b.classList.toggle("on", st(c));
    });
    const el = anchorEl();
    const inChecklist = !!(el && el.closest && el.closest("ul.checklist"));
    $('.tb[data-cmd="checklist"]').classList.toggle("on", inChecklist);
    if (inChecklist)
      $('.tb[data-cmd="insertUnorderedList"]').classList.remove("on");
    $('.tb[data-cmd="justifyLeft"]').classList.toggle(
      "on",
      !st("justifyCenter") && !st("justifyRight") && !st("justifyFull"),
    );
    if (!el) return;
    const cs = getComputedStyle(el);
    const fam = cs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
    const ff = $("#font-family");
    if (![...ff.options].some((o) => o.value === fam))
      ff.add(new Option(fam, fam));
    ff.value = fam;
    if (document.activeElement !== $("#font-size")) {
      const pt = Math.round(parseFloat(cs.fontSize) * 0.75 * 2) / 2;
      $("#font-size").value = pt;
    }
    const b = closestBlock(el);
    let style = "p";
    if (b) {
      if (b.matches("h1.title")) style = "title";
      else if (b.matches("p.subtitle")) style = "subtitle";
      else if (/^H[1-4]$/.test(b.tagName)) style = b.tagName.toLowerCase();
    }
    $("#block-style").value = style;
    $("#fore-bar").style.background = cs.color;
  }
  const updateToolbarSoon = debounce(updateToolbar, 60);

  /* ---------------- formatting commands ---------------- */
  document.execCommand("defaultParagraphSeparator", false, "p");
  document.execCommand("styleWithCSS", false, true);
  function exec(cmd, val = null) {
    restoreSel();
    document.execCommand(cmd, false, val);
    afterEdit();
  }
  function afterEdit() {
    fixFontTags();
    markDirty();
    updateToolbarSoon();
  }

  let pendingPt = 8;
  function fixFontTags() {
    $$('font[size="7"]', page).forEach((f) => {
      f.removeAttribute("size");
      f.style.fontSize = pendingPt + "pt";
      $$("[style]", f).forEach((c) => {
        c.style.fontSize = "";
        if (!c.getAttribute("style")) c.removeAttribute("style");
      });
    });
  }
  function setFontSize(pt) {
    pt = Math.max(1, Math.min(400, Math.round(pt * 2) / 2));
    if (!isFinite(pt)) return;
    pendingPt = pt;
    restoreSel();
    document.execCommand("styleWithCSS", false, false);
    document.execCommand("fontSize", false, "7");
    document.execCommand("styleWithCSS", false, true);
    afterEdit();
    $("#font-size").value = pt;
  }
  function stepFontSize(dir) {
    const v = parseFloat($("#font-size").value) || S.defaultFontSize;
    const next =
      dir > 0
        ? SIZES.find((s) => s > v) || v + 12
        : [...SIZES].reverse().find((s) => s < v) || Math.max(1, v - 1);
    setFontSize(next);
  }
  function setBlockStyle(v) {
    restoreSel();
    if (v === "title") document.execCommand("formatBlock", false, "h1");
    else if (v === "subtitle") document.execCommand("formatBlock", false, "p");
    else document.execCommand("formatBlock", false, v);
    selectedBlocks().forEach((b) => {
      b.classList.remove("title", "subtitle");
      if (v === "title" && b.tagName === "H1") b.classList.add("title");
      if (v === "subtitle" && b.tagName === "P") b.classList.add("subtitle");
      if (!b.className) b.removeAttribute("class");
    });
    afterEdit();
  }
  function setLineSpacing(v) {
    restoreSel();
    let blocks = selectedBlocks();
    if (!blocks.length) {
      document.execCommand("formatBlock", false, "p");
      blocks = selectedBlocks();
    }
    blocks.forEach((b) => (b.style.lineHeight = v));
    afterEdit();
  }
  function paraSpace(which, add) {
    restoreSel();
    selectedBlocks().forEach((b) => {
      b.style[which === "before" ? "marginTop" : "marginBottom"] = add
        ? "10pt"
        : "0";
    });
    afterEdit();
  }
  function toggleChecklist() {
    restoreSel();
    const el = anchorEl();
    const ul = el && el.closest && el.closest("ul");
    if (ul && page.contains(ul)) {
      if (ul.classList.contains("checklist")) {
        document.execCommand("insertUnorderedList");
      } else ul.classList.add("checklist");
    } else {
      document.execCommand("insertUnorderedList");
      const u = anchorEl().closest("ul");
      if (u) u.classList.add("checklist");
    }
    afterEdit();
  }
  function clearFormat() {
    restoreSel();
    document.execCommand("removeFormat");
    document.execCommand("unlink");
    selectedBlocks().forEach((b) => {
      [
        "lineHeight",
        "marginTop",
        "marginBottom",
        "textAlign",
        "marginLeft",
        "textIndent",
      ].forEach((p) => (b.style[p] = ""));
      if (!b.getAttribute("style")) b.removeAttribute("style");
    });
    afterEdit();
  }
  function setColor(kind, color) {
    restoreSel();
    if (color === null) {
      if (kind === "hiliteColor")
        document.execCommand("hiliteColor", false, "transparent");
      else {
        document.execCommand("foreColor", false, "rgb(1, 2, 3)");
        $$('[style*="rgb(1, 2, 3)"], font[color="#010203"]', page).forEach(
          (e) => {
            e.style.color = "";
            e.removeAttribute("color");
            if (!e.getAttribute("style")) e.removeAttribute("style");
          },
        );
      }
    } else document.execCommand(kind, false, color);
    if (kind === "hiliteColor")
      $("#hilite-bar").style.background = color || "transparent";
    afterEdit();
  }

  function insertHtmlAtCursor(html) {
    restoreSel();
    document.execCommand("insertHTML", false, html);
    afterEdit();
  }
  function insertImages(srcs) {
    if (!srcs.length) return;
    insertHtmlAtCursor(
      srcs.map((s) => `<img src="${s}" style="width:50%">`).join(""),
    );
  }
  function insertTable(rows, cols) {
    const tr = `<tr>${"<td><br></td>".repeat(cols)}</tr>`;
    insertHtmlAtCursor(
      `<table class="ln-table"><tbody>${tr.repeat(rows)}</tbody></table><p><br></p>`,
    );
  }

  /* ---------------- table / image ops (from context menu) ---------------- */
  let ctxTarget = null;
  function tableOp(op) {
    const cell = ctxTarget && ctxTarget.closest && ctxTarget.closest("td,th");
    if (!cell || !page.contains(cell)) return;
    const tr = cell.parentElement,
      table = cell.closest("table"),
      idx = cell.cellIndex;
    const blankRow = () => {
      const r = tr.cloneNode(false);
      [...tr.cells].forEach((c) => {
        const n = document.createElement(c.tagName);
        n.innerHTML = "<br>";
        n.setAttribute("style", c.getAttribute("style") || "");
        if (!n.getAttribute("style")) n.removeAttribute("style");
        r.appendChild(n);
      });
      return r;
    };
    if (op === "rowAbove") tr.before(blankRow());
    if (op === "rowBelow") tr.after(blankRow());
    if (op === "colLeft" || op === "colRight")
      [...table.rows].forEach((r) => {
        const ref = r.cells[Math.min(idx, r.cells.length - 1)];
        const n = document.createElement(ref ? ref.tagName : "td");
        n.innerHTML = "<br>";
        if (ref) op === "colLeft" ? ref.before(n) : ref.after(n);
        else r.appendChild(n);
      });
    if (op === "delRow") {
      tr.remove();
      if (!table.rows.length) table.remove();
    }
    if (op === "delCol") {
      [...table.rows].forEach((r) => r.cells[idx] && r.deleteCell(idx));
      if (!table.rows[0] || !table.rows[0].cells.length) table.remove();
    }
    if (op === "delTable") table.remove();
    afterEdit();
  }

  let selImg = null;
  const imgBubble = $("#img-bubble"),
    imgHandle = $("#img-handle");
  function selectImage(img) {
    deselectImage();
    selImg = img;
    img.classList.add("sel");
    positionImageUi();
  }
  function deselectImage() {
    if (selImg) {
      selImg.classList.remove("sel");
      if (!selImg.className) selImg.removeAttribute("class");
    }
    selImg = null;
    imgBubble.hidden = true;
    imgHandle.hidden = true;
  }
  function positionImageUi() {
    if (!selImg || !page.contains(selImg) || S.mode !== "editor") {
      if (selImg && !page.contains(selImg)) deselectImage();
      imgBubble.hidden = true;
      imgHandle.hidden = true;
      return;
    }
    const r = selImg.getBoundingClientRect();
    imgHandle.hidden = false;
    imgHandle.style.left = r.right - 6 + "px";
    imgHandle.style.top = r.bottom - 6 + "px";
    imgBubble.hidden = false;
    const bw = imgBubble.offsetWidth;
    imgBubble.style.left =
      Math.max(8, Math.min(innerWidth - bw - 8, r.left)) + "px";
    const below = r.bottom + 8,
      above = r.top - imgBubble.offsetHeight - 8;
    imgBubble.style.top =
      (below + 40 < innerHeight ? below : Math.max(8, above)) + "px";
  }
  function imgOp(
    v,
    img = selImg || (ctxTarget && ctxTarget.tagName === "IMG" && ctxTarget),
  ) {
    if (!img) return;
    if (v === "delete") {
      img.remove();
      deselectImage();
      afterEdit();
      return;
    }
    img.style.width = v + "%";
    img.style.height = "auto";
    afterEdit();
    positionImageUi();
  }
  function imgAlign(
    v,
    img = selImg || (ctxTarget && ctxTarget.tagName === "IMG" && ctxTarget),
  ) {
    if (!img) return;
    img.style.float = "";
    if (v === "inline") {
      img.style.display = "";
      img.style.margin = "";
    } else {
      img.style.display = "block";
      img.style.margin =
        v === "center" ? "0 auto" : v === "left" ? "0 auto 0 0" : "0 0 0 auto";
    }
    if (!img.getAttribute("style")) img.removeAttribute("style");
    afterEdit();
    positionImageUi();
  }
  imgBubble.addEventListener("mousedown", (e) => e.preventDefault());
  imgBubble.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.img) imgOp(b.dataset.img);
    if (b.dataset.imgalign) imgAlign(b.dataset.imgalign);
  });
  imgHandle.addEventListener("pointerdown", (e) => {
    if (!selImg) return;
    e.preventDefault();
    imgHandle.setPointerCapture(e.pointerId);
    const startX = e.clientX,
      w0 = selImg.getBoundingClientRect().width,
      z = currentZoom();
    const maxW = page.clientWidth - 2 * (PAGE_PAD[S.editorMargins] || 96);
    const move = (ev) => {
      selImg.style.width =
        Math.max(16, Math.min(maxW, (w0 + ev.clientX - startX) / z)) + "px";
      selImg.style.height = "auto";
      positionImageUi();
    };
    const up = () => {
      imgHandle.removeEventListener("pointermove", move);
      imgHandle.removeEventListener("pointerup", up);
      afterEdit();
    };
    imgHandle.addEventListener("pointermove", move);
    imgHandle.addEventListener("pointerup", up);
  });
  canvas.addEventListener("scroll", () => {
    positionImageUi();
    hideLinkBubble();
  });
  window.addEventListener("resize", () => {
    positionImageUi();
    applyZoom();
  });

  /* ---------------- page events ---------------- */
  page.addEventListener("input", () => {
    fixFontTags();
    markDirty();
  });
  page.addEventListener("click", (e) => {
    const img = e.target.closest("img");
    if (img && page.contains(img)) {
      selectImage(img);
      return;
    }
    deselectImage();
    const a = e.target.closest("a");
    if (a && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      api.call("open:external", a.href);
      return;
    }
    // checklist toggle (click on the box)
    const li = e.target.closest("ul.checklist > li");
    if (li && e.clientX < li.getBoundingClientRect().left) {
      li.dataset.checked = li.dataset.checked === "true" ? "false" : "true";
      if (li.dataset.checked === "false") li.removeAttribute("data-checked");
      markDirty();
    }
  });
  page.addEventListener("contextmenu", (e) => {
    ctxTarget = e.target;
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
  page.addEventListener("keydown", (e) => {
    if (selImg && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      imgOp("delete");
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const inList = anchorEl().closest("li");
      if (inList) document.execCommand(e.shiftKey ? "outdent" : "indent");
      else if (!e.shiftKey)
        document.execCommand(
          "insertHTML",
          false,
          '<span style="white-space:pre">\t</span>',
        );
      afterEdit();
    }
  });
  page.addEventListener("focus", () => {
    if (!page.innerHTML.trim()) page.innerHTML = "<p><br></p>";
  });

  /* ---------------- paste & drop ---------------- */
  let plainNext = false;
  page.addEventListener("paste", async (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const html = cd.getData("text/html");
    const text = cd.getData("text/plain");
    const files = [...(cd.files || [])].filter((f) =>
      f.type.startsWith("image/"),
    );
    if (plainNext) {
      plainNext = false;
      e.preventDefault();
      document.execCommand("insertText", false, text);
      afterEdit();
      return;
    }
    if (files.length && !html) {
      e.preventDefault();
      const srcs = await Promise.all(files.map(readAsDataUrl));
      insertImages(srcs);
      return;
    }
    if (html) {
      e.preventDefault();
      const range = savedRange && savedRange.cloneRange();
      let clean;
      try {
        clean = await cleanPastedHtml(html);
      } catch (err) {
        console.error(err);
        clean = escHtml(text).replace(/\n/g, "<br>");
      }
      if (range) savedRange = range;
      insertHtmlAtCursor(clean || escHtml(text));
      inlineRemoteImages();
      return;
    }
    // plain text: keep paragraphs
    if (text && /\n/.test(text)) {
      e.preventDefault();
      const paras = text.replace(/\r/g, "").split("\n");
      insertHtmlAtCursor(
        paras.map((p) => `<p>${escHtml(p) || "<br>"}</p>`).join(""),
      );
    }
  });
  function readAsDataUrl(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(file);
    });
  }
  async function inlineRemoteImages() {
    const imgs = $$("img", page).filter((i) =>
      /^(https?:|file:)/i.test(i.getAttribute("src") || ""),
    );
    if (!imgs.length) return;
    let changed = false;
    await Promise.all(
      imgs.map(async (img) => {
        const data = await api
          .call("image:inline", img.getAttribute("src"))
          .catch(() => null);
        if (data) {
          img.setAttribute("src", data);
          changed = true;
        } else if (/^file:/i.test(img.getAttribute("src"))) img.remove();
      }),
    );
    if (changed) markDirty();
  }
  let internalDrag = false;
  page.addEventListener("dragstart", () => {
    internalDrag = true;
  });
  page.addEventListener("dragend", () => {
    internalDrag = false;
  });
  page.addEventListener("drop", async (e) => {
    if (internalDrag) return;
    const dt = e.dataTransfer;
    const files = [...dt.files].filter((f) => f.type.startsWith("image/"));
    const html = dt.getData("text/html");
    if (!files.length && !html) return;
    e.preventDefault();
    const pos = document.caretRangeFromPoint(e.clientX, e.clientY);
    if (pos) savedRange = pos;
    if (files.length) insertImages(await Promise.all(files.map(readAsDataUrl)));
    else {
      insertHtmlAtCursor(await cleanPastedHtml(html));
      inlineRemoteImages();
    }
  });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    if (!page.contains(e.target)) e.preventDefault();
  });

  /* ---------------- link bubble ---------------- */
  const linkBubble = $("#link-bubble");
  let bubbleLink = null;
  function updateLinkBubble() {
    const el = anchorEl();
    const a = el && el.closest && el.closest("a");
    if (!a || !page.contains(a) || S.mode !== "editor") return hideLinkBubble();
    bubbleLink = a;
    $("#lb-url").textContent = a.getAttribute("href") || "(no link)";
    $("#lb-url").href = "#";
    const r = a.getBoundingClientRect();
    linkBubble.hidden = false;
    linkBubble.style.left =
      Math.max(8, Math.min(innerWidth - linkBubble.offsetWidth - 8, r.left)) +
      "px";
    linkBubble.style.top = r.bottom + 6 + "px";
  }
  function hideLinkBubble() {
    linkBubble.hidden = true;
    bubbleLink = null;
  }
  linkBubble.addEventListener("mousedown", (e) => e.preventDefault());
  $("#lb-url").onclick = (e) => {
    e.preventDefault();
    if (bubbleLink) api.call("open:external", bubbleLink.href);
  };
  $("#lb-edit").onclick = () => openLinkDialog();
  $("#lb-remove").onclick = () => {
    if (!bubbleLink) return;
    const r = document.createRange();
    r.selectNodeContents(bubbleLink);
    savedRange = r;
    exec("unlink");
    hideLinkBubble();
  };

  /* ---------------- dialogs ---------------- */
  const back = $("#modal-back");
  let dialogResolve = null;
  function openDialog(id) {
    $$(".modal", back).forEach((m) => (m.hidden = m.id !== id));
    back.hidden = false;
    hidePopover();
  }
  function closeDialog() {
    back.hidden = true;
    $$(".modal", back).forEach((m) => (m.hidden = true));
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
    restoreSel();
    const el = anchorEl();
    const a = el && el.closest && el.closest("a");
    const sel = getSelection();
    let range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    if (a) {
      range = document.createRange();
      range.selectNodeContents(a);
    }
    $("#link-text").value = a ? a.textContent : range ? range.toString() : "";
    $("#link-url").value = a ? a.getAttribute("href") : "";
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
      if (a) {
        a.setAttribute("href", url);
        if (a.textContent !== text) a.textContent = text;
        afterEdit();
        return;
      }
      savedRange = range;
      if (range && !range.collapsed && range.toString() === text)
        exec("createLink", url);
      else
        insertHtmlAtCursor(
          `<a href="${escHtml(url)}">${escHtml(text)}</a>&nbsp;`,
        );
    };
    $("#link-apply").onclick = apply;
    $("#link-url").onkeydown = $("#link-text").onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        apply();
      }
    };
  }

  function showWordCount() {
    const text = page.innerText || "";
    const sel = getSelection();
    const selText =
      sel.rangeCount && page.contains(sel.anchorNode) ? sel.toString() : "";
    const words = (t) => (t.match(/\S+/g) || []).length;
    const rows = [
      ["Words", words(text)],
      ["Characters", text.replace(/\n/g, "").length],
      ["Characters excluding spaces", text.replace(/\s/g, "").length],
      [
        "Paragraphs",
        $$("p,h1,h2,h3,h4,li", page).filter((p) => p.textContent.trim()).length,
      ],
    ];
    if (selText) rows.unshift(["Words in selection", words(selText)]);
    $("#word-stats").innerHTML = rows
      .map(([k, v]) => `<tr><td>${k}</td><td>${v.toLocaleString()}</td></tr>`)
      .join("");
    openDialog("dlg-words");
  }
  function updateWordCount() {
    const n = ((page.innerText || "").match(/\S+/g) || []).length;
    $("#word-count").textContent =
      `${n.toLocaleString()} word${n === 1 ? "" : "s"}`;
  }
  const updateWordCountSoon = debounce(updateWordCount, 400);
  $("#word-count").onclick = showWordCount;

  /* ---------------- popovers ---------------- */
  const pop = $("#popover");
  function showPopover(anchor, html, onClick) {
    pop.innerHTML = html;
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    pop.style.left =
      Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.left)) + "px";
    pop.style.top =
      Math.min(innerHeight - pop.offsetHeight - 8, r.bottom + 4) + "px";
    pop.onclick = (e) => onClick(e);
  }
  function hidePopover() {
    pop.hidden = true;
    pop.innerHTML = "";
    pop.onclick = null;
  }
  pop.addEventListener("mousedown", (e) => {
    if (e.target.tagName !== "INPUT") e.preventDefault();
  });
  document.addEventListener("mousedown", (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest(".tb"))
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
    showPopover(
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
    $("#custom-color").onchange = (e) => {
      setColor(kind, e.target.value);
      hidePopover();
    };
  }
  function spacingPopover(btn) {
    const blk = selectedBlocks()[0];
    const curLh = blk
      ? blk.style.lineHeight || String(S.defaultLineSpacing)
      : "";
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
    showPopover(
      btn,
      `<div class="grid-pick">${Array.from({ length: R * C }, (_, i) => `<span data-r="${Math.floor(i / C) + 1}" data-c="${(i % C) + 1}"></span>`).join("")}</div><div class="grid-label">Insert table</div>`,
      (e) => {
        const s = e.target.closest("[data-r]");
        if (!s) return;
        hidePopover();
        insertTable(+s.dataset.r, +s.dataset.c);
      },
    );
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
    page.focus();
  };
  $("#zoom-in").onclick = () => stepZoom(1);
  $("#zoom-out").onclick = () => stepZoom(-1);
  $("#zoom-label").onclick = () => setZoom(1);
  let wheelZoomAt = 0;
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
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
  const hasHighlights =
    typeof CSS !== "undefined" &&
    CSS.highlights &&
    typeof Highlight !== "undefined";
  function openFind(replace) {
    findOpen = true;
    $("#findbar").hidden = false;
    const sel = getSelection().toString();
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
    if (hasHighlights) {
      CSS.highlights.delete("find");
      CSS.highlights.delete("find-current");
    }
    restoreSel();
  }
  function runFind(keepIdx) {
    const q = $("#find-input").value;
    const mc = $("#find-case").checked;
    findRanges = [];
    if (q) {
      const needle = mc ? q : q.toLowerCase();
      const tw = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
      while (tw.nextNode()) {
        const n = tw.currentNode,
          hay = mc ? n.nodeValue : n.nodeValue.toLowerCase();
        let i = hay.indexOf(needle);
        while (i >= 0) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + q.length);
          findRanges.push(r);
          i = hay.indexOf(needle, i + q.length);
        }
      }
    }
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
    if (!hasHighlights) return;
    CSS.highlights.set("find", new Highlight(...findRanges));
    if (findIdx >= 0) {
      CSS.highlights.set("find-current", new Highlight(findRanges[findIdx]));
      if (scroll) {
        const r = findRanges[findIdx].getBoundingClientRect(),
          c = canvas.getBoundingClientRect();
        if (r.top < c.top + 40 || r.bottom > c.bottom - 40)
          canvas.scrollTop += r.top - c.top - c.height / 3;
      }
    } else CSS.highlights.delete("find-current");
  }
  function findStep(d) {
    if (!findRanges.length) return;
    findIdx = (findIdx + d + findRanges.length) % findRanges.length;
    paintFind();
  }
  function replaceOne() {
    if (findIdx < 0) return;
    const r = findRanges[findIdx];
    const sel = getSelection();
    page.focus();
    sel.removeAllRanges();
    sel.addRange(r);
    document.execCommand("insertText", false, $("#replace-input").value);
    afterEdit();
    runFind(true);
    paintFind();
    $("#replace-input").focus();
  }
  function replaceAll() {
    if (!findRanges.length) return;
    const n = findRanges.length,
      rep = $("#replace-input").value;
    page.focus();
    for (let i = findRanges.length - 1; i >= 0; i--) {
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(findRanges[i]);
      document.execCommand("insertText", false, rep);
    }
    afterEdit();
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
p,div{margin:0}h1,h2,h3,h4{font-weight:400;margin:0;line-height:1.15}h1{font-size:20pt;padding:10pt 0 3pt}h2{font-size:16pt;padding:9pt 0 3pt}h3{font-size:14pt;padding:8pt 0 2pt;color:#434343}h4{font-size:12pt;padding:7pt 0 2pt;color:#666}
h1.title{font-size:26pt;padding:0 0 3pt}p.subtitle{font-size:15pt;color:#666;padding:0 0 8pt}ul,ol{margin:0;padding-left:3.2em}li>p{display:inline}img{max-width:100%;height:auto}
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
      serialize(),
      pageCss(),
    );
    if (p) toast("Saved " + p.split(/[\\/]/).pop());
  }

  /* ---------------- menus ---------------- */
  const MENUS = {
    file: () => [
      { id: "new", label: "New document", accel: "CmdOrCtrl+N" },
      { id: "newFolder", label: "New folder" },
      { id: "docs", label: "Open… (document list)", accel: "CmdOrCtrl+O" },
      { type: "separator" },
      { id: "import", label: "Import .docx / .html / .txt…" },
      {
        label: "Download",
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
      { id: "print", label: "Print", accel: "CmdOrCtrl+P" },
      { type: "separator" },
      { id: "hide", label: "Hide window", accel: S.toggleShortcut },
      { id: "quit", label: "Quit", accel: "CmdOrCtrl+Q" },
    ],
    edit: () => [
      { id: "undo", label: "Undo", accel: "CmdOrCtrl+Z" },
      { id: "redo", label: "Redo", accel: "CmdOrCtrl+Y" },
      { type: "separator" },
      { id: "cut", label: "Cut", accel: "CmdOrCtrl+X" },
      { id: "copy", label: "Copy", accel: "CmdOrCtrl+C" },
      { id: "paste", label: "Paste", accel: "CmdOrCtrl+V" },
      {
        id: "pastePlain",
        label: "Paste without formatting",
        accel: "CmdOrCtrl+Shift+V",
      },
      { type: "separator" },
      { id: "selectAll", label: "Select all", accel: "CmdOrCtrl+A" },
      { id: "delSel", label: "Delete" },
      { type: "separator" },
      { id: "find", label: "Find and replace", accel: "CmdOrCtrl+H" },
    ],
    view: () => [
      { id: "immersive", label: "Immersive mode", accel: S.immersiveShortcut },
      { id: "docs", label: "Document list", checked: !!S.sidebarOpen },
      {
        id: "fullscreen",
        label: "Full screen",
        accel: "F11",
        checked: fullscreen,
      },
      {
        label: "Zoom",
        submenu: [
          { id: "zoom:in", label: "Zoom in", accel: "CmdOrCtrl+=" },
          { id: "zoom:out", label: "Zoom out", accel: "CmdOrCtrl+-" },
          { id: "zoom:1", label: "Actual size (100%)", accel: "CmdOrCtrl+0" },
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
      { id: "alwaysOnTop", label: "Always on top", checked: !!S.alwaysOnTop },
    ],
    insert: () => [
      { id: "image", label: "Image…" },
      { id: "table", label: "Table" },
      { id: "link", label: "Link", accel: "CmdOrCtrl+K" },
      { id: "hr", label: "Horizontal line" },
      { id: "date", label: "Date" },
      { id: "checklist", label: "Checklist" },
    ],
    format: () => [
      {
        label: "Text",
        submenu: [
          { id: "bold", label: "Bold", accel: "CmdOrCtrl+B" },
          { id: "italic", label: "Italic", accel: "CmdOrCtrl+I" },
          { id: "underline", label: "Underline", accel: "CmdOrCtrl+U" },
          { id: "strikeThrough", label: "Strikethrough", accel: "Alt+Shift+5" },
          { id: "superscript", label: "Superscript", accel: "CmdOrCtrl+." },
          { id: "subscript", label: "Subscript", accel: "CmdOrCtrl+," },
          { type: "separator" },
          {
            id: "fontUp",
            label: "Increase font size",
            accel: "CmdOrCtrl+Shift+.",
          },
          {
            id: "fontDown",
            label: "Decrease font size",
            accel: "CmdOrCtrl+Shift+,",
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
        ].map(([v, l, a]) => ({ id: "style:" + v, label: l, accel: a })),
      },
      {
        label: "Align & indent",
        submenu: [
          { id: "justifyLeft", label: "Left", accel: "CmdOrCtrl+Shift+L" },
          { id: "justifyCenter", label: "Center", accel: "CmdOrCtrl+Shift+E" },
          { id: "justifyRight", label: "Right", accel: "CmdOrCtrl+Shift+R" },
          { id: "justifyFull", label: "Justified", accel: "CmdOrCtrl+Shift+J" },
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
            accel: "CmdOrCtrl+Shift+8",
          },
          {
            id: "insertOrderedList",
            label: "Numbered list",
            accel: "CmdOrCtrl+Shift+7",
          },
          { id: "checklist", label: "Checklist", accel: "CmdOrCtrl+Shift+9" },
        ],
      },
      { type: "separator" },
      { id: "clearFormat", label: "Clear formatting", accel: "CmdOrCtrl+\\" },
    ],
    tools: () => [
      { id: "wordCount", label: "Word count", accel: "CmdOrCtrl+Shift+C" },
      { id: "spell", label: "Spell check", checked: page.spellcheck },
      { type: "separator" },
      {
        id: "update",
        label:
          update.state === "ready"
            ? `Restart to update (v${update.version})`
            : "Check for updates",
      },
      { id: "settings", label: "Settings", accel: "CmdOrCtrl+," },
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
      case "print":
        await saveNow();
        return safeCall("print", baseName(cur.rel), serialize(), pageCss());
      case "hide":
        await saveNow();
        return api.call("win:hide");
      case "quit":
        await saveNow();
        return api.call("win:quit");
      case "undo":
      case "redo":
        return exec(cmd);
      case "cut":
      case "copy":
      case "paste":
      case "selectAll":
        restoreSel();
        return api.call("edit:native", cmd);
      case "delSel":
        return exec("delete");
      case "pastePlain":
        restoreSel();
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
      case "lines":
        return setSetting({ linesPerView: +arg });
      case "cycleLines":
        return cycleLines();
      case "alwaysOnTop":
        return setSetting({ alwaysOnTop: !S.alwaysOnTop });
      case "image": {
        const srcs = await safeCall("image:pick");
        restoreSel();
        return insertImages(srcs);
      }
      case "table":
        return tablePopover(srcEl || $('.tb[data-cmd="table"]'));
      case "link":
        return openLinkDialog();
      case "unlink": {
        const a = ctxTarget && ctxTarget.closest && ctxTarget.closest("a");
        if (a) {
          const r = document.createRange();
          r.selectNodeContents(a);
          savedRange = r;
        }
        return exec("unlink");
      }
      case "hr":
        return exec("insertHorizontalRule");
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
        page.spellcheck = !page.spellcheck;
        ls.set("spell", page.spellcheck);
        $('.tb[data-cmd="spell"]').classList.toggle("on", !page.spellcheck);
        page.blur();
        page.focus();
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
    exec("fontName", ff.value);
  };
  $("#block-style").onchange = (e) => setBlockStyle(e.target.value);
  const fsInput = $("#font-size");
  fsInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      setFontSize(parseFloat(fsInput.value));
    }
    if (e.key === "Escape") {
      restoreSel();
      updateToolbar();
    }
  });
  fsInput.addEventListener("focus", () => fsInput.select());
  if (ls.get("spell", true) === false) {
    page.spellcheck = false;
    $('.tb[data-cmd="spell"]').classList.add("on");
  }

  /* ---------------- immersive ---------------- */
  async function loadImmersive() {
    try {
      const wa = await api.call("win:workArea");
      Immersive.setOptions({ maxH: wa.height - 24 });
    } catch {}
    Immersive.setActive(true);
    Immersive.setOptions(immOpts());
    Immersive.load(serialize(), (S.readPositions || {})[cur.rel] || 0);
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
        restoreSel();
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

  function fillSettings() {
    renderPreviews();
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
    fillLines();
    $$(".shortcut").forEach(
      (i) => (i.value = prettyAccel(S[i.dataset.setting])),
    );
    $("#set-folder").textContent = S.docsFolder;
    $("#set-folder").title = S.docsFolder;
    $("#set-version").textContent = `Lecture Notes ${S.version || ""}`;
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
  $("#btn-hide").onclick = () => run("hide");
  $$(".seg[data-setting], .pv-group[data-setting]").forEach((seg) =>
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const v = "num" in seg.dataset ? +b.dataset.v : b.dataset.v;
      setSetting({ [seg.dataset.setting]: v }).then(fillSettings);
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
      anywhereScroll: "alt",
    }).then(fillSettings);

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
      const taken = ["toggleShortcut", "immersiveShortcut", "linesShortcut"]
        .filter((k) => k !== inp.dataset.setting)
        .some((k) => S[k] === accel);
      if (taken) {
        inp.value = "Already used by another shortcut";
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
    b.title = fullscreen ? "Exit full screen (F11)" : "Full screen (F11)";
    b.innerHTML = icon(fullscreen ? "fullscreenExit" : "fullscreen");
    applyZoom();
  }
  $("#btn-fullscreen").onclick = () => run("fullscreen");

  /* ---------------- updates ---------------- */
  const UPDATE_TEXT = {
    idle: () => "Updates install automatically when you restart the app.",
    dev: () => "Updates only work in the installed app.",
    checking: () => "Checking for updates…",
    none: () => `You're on the latest version (${S.version}).`,
    downloading: (u) =>
      `Downloading version ${u.version}… ${u.percent != null ? Math.round(u.percent) + "%" : ""}`,
    ready: (u) =>
      `Version ${u.version} is ready — it installs when you restart.`,
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
    applyUpdateStatus({ ...update, state: "installing" });
    toast(
      `Installing version ${update.version} — the app will reopen in a moment…`,
      10000,
    );
    await saveNow().catch(() => {});
    await api.call("update:install");
  }
  $("#set-update").onclick = () => run("update");
  $("#btn-update").onclick = installUpdate;

  /* ---------------- keyboard ---------------- */
  document.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (S.mode === "immersive") {
      const k = e.key;
      if (
        ["ArrowDown", "ArrowRight", "PageDown", " ", "j", "Enter"].includes(k)
      ) {
        e.preventDefault();
        Immersive.go(1, k === "PageDown");
      } else if (
        ["ArrowUp", "ArrowLeft", "PageUp", "k", "Backspace"].includes(k)
      ) {
        e.preventDefault();
        Immersive.go(-1, k === "PageUp");
      } else if (k === "Home") Immersive.home();
      else if (k === "End") Immersive.end();
      else if (k === "Escape") setMode("editor");
      else if (ctrl && (k === "=" || k === "+")) {
        e.preventDefault();
        zoomBy(0.1);
      } else if (ctrl && k === "-") {
        e.preventDefault();
        zoomBy(-0.1);
      } else if (ctrl && k.toLowerCase() === "q") run("quit");
      return;
    }
    if (!back.hidden) return;
    if (e.key === "F11") {
      e.preventDefault();
      return run("fullscreen");
    }
    if (e.key === "Escape") {
      if (!pop.hidden) hidePopover();
      else if (findOpen) closeFind();
      else if (selImg) deselectImage();
      else if (fullscreen) run("fullscreen");
      return;
    }
    if (e.altKey && e.shiftKey && e.code === "Digit5") {
      e.preventDefault();
      return exec("strikeThrough");
    }
    if (!ctrl) return;
    const code = e.code,
      sh = e.shiftKey,
      alt = e.altKey;
    const go = (id) => {
      e.preventDefault();
      run(id);
    };
    if (ctrl && alt && /^Digit[0-4]$/.test(code))
      return go("style:" + (code === "Digit0" ? "p" : "h" + code.slice(5)));
    if (alt) return;
    if (sh) {
      if (code === "Digit7") return go("insertOrderedList");
      if (code === "Digit8") return go("insertUnorderedList");
      if (code === "Digit9") return go("checklist");
      if (code === "KeyL") return go("justifyLeft");
      if (code === "KeyE") return go("justifyCenter");
      if (code === "KeyR") return go("justifyRight");
      if (code === "KeyJ") return go("justifyFull");
      if (code === "Period") return go("fontUp");
      if (code === "Comma") return go("fontDown");
      if (code === "KeyC") return go("wordCount");
      if (code === "KeyV") {
        plainNext = true;
        setTimeout(() => (plainNext = false), 600);
        return;
      }
      if (code === "KeyZ") return go("redo");
      if (code === "Equal") return go("zoom:in");
      return;
    }
    switch (code) {
      case "Equal":
      case "NumpadAdd":
        return go("zoom:in");
      case "Minus":
      case "NumpadSubtract":
        return go("zoom:out");
      case "Digit0":
      case "Numpad0":
        return go("zoom:1");
      case "KeyS":
        e.preventDefault();
        cur.dirty = true;
        saveNow().then(() => toast("Saved", 1200));
        return;
      case "KeyN":
        return go("new");
      case "KeyO":
        return go("docs");
      case "KeyF":
        e.preventDefault();
        return openFind(false);
      case "KeyH":
        return go("find");
      case "KeyK":
        return go("link");
      case "KeyP":
        return go("print");
      case "KeyQ":
        return go("quit");
      case "KeyY":
        return go("redo");
      case "Comma":
        return go("settings");
      case "Period":
        return go("superscript");
      case "Backslash":
        return go("clearFormat");
    }
  });

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
  api.on("update-status", (u) => {
    applyUpdateStatus(u);
    // An update that was already downloaded when the app opened is applied straight away.
    if (u.state === "ready" && u.auto) installUpdate();
  });
  api.on("theme-changed", () => {
    if (S.mode === "immersive") Immersive.load(serialize(), Immersive.start);
  });
  api.on("shortcut-errors", (errs) => {
    S.shortcutErrors = errs;
    showShortcutErrors();
    const msgs = Object.values(errs);
    if (msgs.length)
      toast("Shortcut problem: " + msgs[0] + " — change it in Settings", 6000);
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
    page,
  };
})();
