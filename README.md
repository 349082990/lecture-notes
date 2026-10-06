# Interview Notes

A notes app for Windows: a Google Docs–style editor (with real pages) plus a frameless, always-on-top "immersive" reader that can show just 1 or 2 lines at a time — handy for glancing at your notes during a call or interview. (Called "Lecture Notes" before version 2.0.)

## Install

Download `Interview-Notes-Setup-<version>.exe` from https://github.com/349082990/interview-notes/releases/latest and run it. It installs for your user only (no admin needed), adds Desktop + Start Menu shortcuts, and starts the app.

Windows SmartScreen may say "Windows protected your PC" because the app isn't code-signed. Click **More info → Run anyway**.

Uninstall from Settings → Apps. Your documents are never deleted.

## Shortcuts

Every shortcut can be changed in **Settings → Keyboard shortcuts**: click a shortcut and press new keys, × removes one, + adds another, ↺ puts back the default. These are the defaults:

| Shortcut | What it does |
|---|---|
| **Ctrl + ]** | Show / hide the overlay — works from any app (changeable in Settings) |
| **Ctrl + Alt + I** | Switch between editor and immersive mode — works from any app (changeable) |
| **Ctrl + Alt + M** | Immersive: switch lines shown (1 → 2 → custom → 25) — works from any app (changeable) |
| **Ctrl + Alt + O** | Overlay opacity 100 → 80 → 60 → 40 → 20% — works from any app (changeable) |
| **Ctrl + Alt + scroll** | Previous / next heading (scroll up / down) — in the editor, and from any app while the overlay is showing (changeable in Settings) |
| **Ctrl + Alt + ↑ / ↓** | Previous / next heading — the overlay puts that heading on its first line (blank lines below it near the end of the document), the editor scrolls there (changeable; only taken from other apps while the overlay is showing) |
| **Ctrl + Alt + 0** | Immersive: move the overlay to the very top of the screen, centred, same width (changeable; in the editor it's still Normal text) |
| **Alt + scroll** (anywhere) | Immersive: scroll the overlay while your mouse is over any other app (modifier changeable, or off) |
| Scroll / ↓ / Space / Enter | Immersive: next line(s) |
| ↑ / Backspace | Immersive: previous line(s) |
| Ctrl + scroll, or A− / A+ | Immersive: text size |
| Esc | Immersive: back to the editor (editor: leave full screen) |
| F11 | Editor: full screen on / off |
| Ctrl + = / Ctrl + − / Ctrl + 0, or Ctrl + scroll | Editor: zoom in / out / back to 100% |
| Ctrl + N / Ctrl + O | New document / document list |
| Ctrl + F / Ctrl + H | Find / Find and replace |
| Ctrl + K | Link |
| Ctrl + Shift + V | Paste without formatting |
| Ctrl + Shift + 7 / 8 / 9 | Numbered / bulleted / checklist |
| Tab / Shift + Tab | In a list: indent / outdent the bullet. Elsewhere: a tab |
| Ctrl + Enter | Page break |
| Ctrl + Alt + 0–4 | Normal text / Heading 1–4 |
| Ctrl + Q or Alt + F4 | Quit completely (or right-click the tray icon) |

## How it works

- **Editor mode** — pages like Google Docs' print layout (8.5 × 11 in, with a gap between pages; text that doesn't fit moves to the next page, and Ctrl + Enter starts a new page): fonts, sizes, bold/italic/underline/strikethrough, colours and highlight, headings, bullets/numbers/checklists, alignment, line & paragraph spacing, indent, links, images (paste, drag in, or Insert → Image; click an image to resize/align), tables (right-click a cell to add/remove rows and columns), find & replace, word count, spell check, zoom, print, and download as .docx / .pdf / .html. Defaults: Arial 10 pt, 1.15 spacing. Nothing is ever bigger than 10 pt — headings stand out by bold and colour instead, and larger pasted or older text is shrunk to 10 pt. Typing "* " or "- " at the start of a line starts a bulleted list, "1. " a numbered one. Lists work like Google Docs: Enter on an empty bullet ends the list, Backspace at the start of a bullet removes the bullet, Tab / Shift + Tab nest and un-nest.
- **Paste from Google Docs or Word** keeps the formatting, and images are copied into the document so they don't break later. File → Import also opens .docx files directly.
- **Immersive mode** — no window bar or buttons, just the text on a rounded card. Drag anywhere to move it (including right up to the top edge of the screen); drag the left/right edges to change the width. The height adjusts itself to the lines being shown. It has no taskbar button — get back to it with the shortcut or the tray icon. Hover to reveal tiny controls (lines per view, text size, exit, hide).
- **Lines per view** (Settings, the "25 / 1L / 2L" button on hover, or Ctrl + Alt + M): 1 line, 2 lines, a custom number (1–25), or default (up to 25). **Lines per scroll** (Settings) sets how far each scroll moves when 3 or more lines are shown — automatic (3), a fixed number, or a whole view. In 1- or 2-line mode nothing else is visible until you scroll. Headings show at the same size as the text (their bold / italics / colour stay) unless you pick "Original size" in Settings. Images aren't cut up by the line rule — they show whole, as their own step. Your reading position is remembered per document.
- **Documents** — the ☰ button (top-left) lists every document with a preview. Right-click for rename, move to folder, delete, new folder. Drag documents onto folders to organise them. Everything autosaves as plain .html files in `Documents\Interview Notes` (`Documents\Lecture Notes` if you used the app before 2.0; change the folder in Settings).
- **Full screen** — press F11, click the full-screen button in the title bar, or use View → Full screen to maximize the editor (it fills the screen but leaves the taskbar visible). F11 or Esc leaves it. Full screen opens at 100% zoom and remembers its own zoom level; use the − / + by the status bar's zoom percentage, Ctrl + scroll, or Ctrl + = / −.
- **Settings** — theme (follows Windows by default, or force light/dark; dark is pure black by default, with a dark-gray option; the page stays white in dark mode unless you pick gray or black — each choice shows a small preview), overlay opacity and background opacity (immersive overlay only — the editor is never see-through), always-on-top, start with Windows, immersive margins (narrow by default) and text size, editor page margins, default font/size/spacing, shortcuts, documents folder.
- The immersive overlay stays on top of other apps (Settings → Overlay always on top). The editor, full screen included, is a normal window that other apps can cover. Hide it with Ctrl + ] or the − button (it keeps running in the tray); the × button at the top right closes the app completely. Minimizing puts it on the taskbar; turn on Settings → Minimize to the tray to hide it in the tray's hidden icons instead. Alt + F4 quits the app completely. The tray icon (near the clock) can also show/hide, reset the window position, or quit.

## Updates

The app checks for a new version when it starts (and every few hours) and downloads it in the background, but it never installs one without asking. Each time you open the app (start it, or open it again from the Start menu or desktop while it's in the tray) and a newer version is available, it asks **Update now** or **Not now**. Not now leaves your version alone until the next time you open the app; switching between the editor and the overlay doesn't count. Updating shows a small "Updating Interview Notes" window, then the installer's progress bar, and the new version says "Interview Notes was updated to version …" when it opens. You can also use **Settings → Updates → Check for updates**, **Tools → Check for updates**, or the tray menu; when an update is ready, a **Restart to update** button appears in the title bar.

## Building from source

Needs Node.js 18+ on Windows.

```
npm install
npm start          # run it
npm run dist       # build the installer into dist\
npm run release    # publish an update — installed apps get it on their next restart
```
