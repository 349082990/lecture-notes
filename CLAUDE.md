# Lecture Notes — notes for Claude

Electron app (Windows only): `main.js` (main process), `preload.js`, `renderer/` (plain JS, no bundler).

## Shipping an update to installed copies

1. Make the change, test with `npm start`, commit and push.
2. `npm run release` (or `npm run release minor`) — bumps the version, builds the NSIS installer,
   uploads it to the public `lecture-notes-releases` GitHub repo, then commits/tags/pushes the bump.
3. Installed apps pick it up automatically (check at launch + every 4h, download in background,
   install on quit; an update that's ready within a minute of launch installs right away).

Source lives in the private `lecture-notes` repo; only installers go to the public releases repo
(electron-updater can't read a private repo without shipping a token in the app).

`npm run release` needs a clean git tree and `gh auth login` (or `GH_TOKEN`).

## Gotchas

- Running Electron from this shell: `ELECTRON_RUN_AS_NODE` is set, so use `env -u ELECTRON_RUN_AS_NODE npx electron .`
- The installed app holds a single-instance lock (per profile folder). To test a dev copy alongside it, use
  `--user-data-dir=<temp>` with a `settings.json` there whose `docsFolder` points at a temp folder (so real
  notes aren't touched) AND `LN_TEST_HIDDEN=1`, which parks the window off-screen with no taskbar entry,
  tray icon or global shortcuts — otherwise the user sees a second copy of the app. Drive it with
  `--remote-debugging-port` + CDP (Runtime.evaluate, Page.captureScreenshot).
