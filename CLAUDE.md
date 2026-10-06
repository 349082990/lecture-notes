# Interview Notes — notes for Claude

Electron app (Windows only), called "Lecture Notes" before 2.0: `main.js` (main process), `preload.js`,
`renderer/` (plain JS, no bundler) and `editor-src/` (the document editor: ProseMirror via TipTap,
bundled by esbuild into `renderer/editor.bundle.js` — generated and git-ignored; `npm start`,
`npm run dist` and `npm run release` build it, or run `npm run build:editor`).

## Shipping an update to installed copies

1. Make the change, test with `npm start`, commit and push.
2. `npm run release` (or `npm run release minor`) — bumps the version, builds the NSIS installer,
   uploads it to the public `interview-notes` GitHub repo, then commits/tags/pushes the bump.
   `RELEASE_NOTES="..."` adds notes to the release page.
3. Installed apps pick it up automatically (check at launch + every 4h, download in background,
   install on quit; an update that's ready within a minute of launch installs right away). Installing
   shows the "Updating Interview Notes" window, then the installer's progress bar (not silent).

Source lives in the private `lecture-notes` repo; only installers (and `public-repo/README.md`,
copied by hand) go to the public `interview-notes` repo, renamed from `lecture-notes-releases` —
copies before 2.0 still point at the old name and reach it through GitHub's redirect.
electron-updater can't read a private repo without shipping a token in the app.

`npm run release` needs a clean git tree and `gh auth login` (or `GH_TOKEN`).

## Keep for updates to keep working

- `build.appId` stays `com.lecturenotes.app`: the installer's identity comes from it, so changing it
  installs a second app instead of updating.
- Copies updated from Lecture Notes keep using `%APPDATA%\Lecture Notes` for settings (main.js
  switches userData to it when it has a settings.json); new installs use `%APPDATA%\Interview Notes`.

## Editor

- Documents are saved as HTML. `normalizeHtml()` in editor-src runs on everything loaded or pasted:
  it unwraps headings/paragraphs that wrap lists (the old contenteditable editor made those — they
  showed as normal text but counted as headings), moves a list sitting directly in a list into the
  item before it, drops a block's trailing `<br>`, and caps text at 10 pt. Blank lines are saved as
  `<p><br></p>`.
- Pages: the `Pages` plugin measures lines and pushes the ones that would cross a page's bottom margin
  onto the next page with decorations (a transparent `border-top` on the block, or a block widget
  inside a paragraph that's split). The page cards behind the text are `#pages > div` in index.html.

## Gotchas

- Running Electron from this shell: `ELECTRON_RUN_AS_NODE` is set, so use `env -u ELECTRON_RUN_AS_NODE npx electron .`
- The installed app holds a single-instance lock (per profile folder). To test a dev copy alongside it, use
  `--user-data-dir=<temp>` with a `settings.json` there whose `docsFolder` points at a temp folder (so real
  notes aren't touched) AND `LN_TEST_HIDDEN=1`, which parks the window off-screen with no taskbar entry,
  tray icon or global shortcuts — otherwise the user sees a second copy of the app. Drive it with
  `--remote-debugging-port` + CDP (Runtime.evaluate, Page.captureScreenshot, Input.dispatchKeyEvent).
  Reload the page with CDP `Page.reload` — `location.reload()` is blocked by the app's navigation guard.
  Extra dev-only switches: `LN_TEST_HOOK=1` turns the Alt+scroll input hook on in test mode;
  `LN_TEST_SHORTCUTS=1` registers real global shortcuts — only use it with a settings.json whose
  shortcuts are keys the user's copy doesn't hold (e.g. Ctrl+Alt+Shift+F5–F11). Synthetic keys can
  be sent with uiohook-napi's keyToggle; ALWAYS release them in a finally/exit handler.
- A crash in main.js during startup shows an error dialog on the user's screen even in test mode.
- Never change global-shortcut registrations from inside a shortcut's own callback (it froze the
  app when the keys were held); handlers go through `hotkey()` in main.js, which defers them and
  ignores Windows key-repeat.
