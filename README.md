# Lecture Notes

An always-on-top notes overlay for Windows: a Google Docs–style editor plus a frameless "immersive" reader that can show just 1 or 2 lines at a time.

## Install

**Easiest:** run `Lecture-Notes-Setup-1.0.0.exe`. It installs for your user only (no admin needed), adds Desktop + Start Menu shortcuts, and starts the app.

Windows SmartScreen may say "Windows protected your PC" because the app isn't code-signed. Click **More info → Run anyway**.

**No install:** unzip `Lecture-Notes-1.0.0-portable.zip` anywhere and run `Lecture Notes.exe`.

Uninstall from Settings → Apps. Your documents are never deleted.

## Shortcuts

| Shortcut | What it does |
|---|---|
| **Ctrl + ]** | Show / hide the overlay — works from any app (changeable in Settings) |
| **Ctrl + Alt + I** | Switch between editor and immersive mode — works from any app (changeable) |
| **Ctrl + Alt + M** | Immersive: switch lines shown (1 → 2 → custom → 25) — works from any app (changeable) |
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
| Ctrl + Alt + 0–4 | Normal text / Heading 1–4 |
| Ctrl + Q or Alt + F4 | Quit completely (or right-click the tray icon) |

## How it works

- **Editor mode** — a normal page like Google Docs: fonts, sizes, bold/italic/underline/strikethrough, colours and highlight, headings, bullets/numbers/checklists, alignment, line & paragraph spacing, indent, links, images (paste, drag in, or Insert → Image; click an image to resize/align), tables (right-click a cell to add/remove rows and columns), find & replace, word count, spell check, zoom, print, and download as .docx / .pdf / .html. Defaults: Arial 8 pt, 1.15 spacing.
- **Paste from Google Docs or Word** keeps the formatting, and images are copied into the document so they don't break later. File → Import also opens .docx files directly.
- **Immersive mode** — no window bar or buttons, just the text on a rounded card. Drag anywhere to move it (including right up to the top edge of the screen); drag the left/right edges to change the width. The height adjusts itself to the lines being shown. Hover to reveal tiny controls (lines per view, text size, exit, hide).
- **Lines per view** (Settings, the "25 / 1L / 2L" button on hover, or Ctrl + Alt + M): 1 line, 2 lines, a custom number (1–25), or default (up to 25). **Lines per scroll** (Settings) sets how far each scroll moves when 3 or more lines are shown — automatic (3), a fixed number, or a whole view. In 1- or 2-line mode nothing else is visible until you scroll. Images aren't cut up by the line rule — they show whole, as their own step. Your reading position is remembered per document.
- **Documents** — the ☰ button (top-left) lists every document with a preview. Right-click for rename, move to folder, delete, new folder. Drag documents onto folders to organise them. Everything autosaves as plain .html files in `Documents\Lecture Notes` (change the folder in Settings).
- **Full screen** — press F11, click the full-screen button in the title bar, or use View → Full screen to fill the whole screen with the editor. F11 or Esc leaves it. Full screen opens at 100% zoom and remembers its own zoom level; use the − / + by the status bar's zoom percentage, Ctrl + scroll, or Ctrl + = / −.
- **Settings** — theme (follows Windows by default, or force light/dark; dark is pure black by default, with a dark-gray option; the page stays white in dark mode unless you pick gray or black — each choice shows a small preview), overlay opacity, background opacity, always-on-top, start with Windows, immersive margins (narrow by default) and text size, editor page margins, default font/size/spacing, shortcuts, documents folder.
- The window stays on top and stays open until you hide it with Ctrl + ] — there's no close button. Alt + F4 quits the app completely. The tray icon (near the clock) can also show/hide, reset the window position, or quit.

## Updates

The app updates itself. It checks for a new version when it starts (and every few hours), downloads it in the background, and installs it when you quit — so closing and reopening the app is all it takes. If an update is already downloaded when the app opens, it installs straight away and reopens. You can also use **Settings → Updates → Check for updates**, **Tools → Check for updates**, or the tray menu; when an update is ready, a **Restart to update** button appears in the title bar.

## Building from source

Needs Node.js 18+ on Windows.

```
npm install
npm start          # run it
npm run dist       # build the installer into dist\
npm run release    # publish an update — installed apps get it on their next restart
```
