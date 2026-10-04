// Publish an update that installed copies of the app pick up automatically.
//
//   npm run release            -> bump patch (1.1.0 -> 1.1.1)
//   npm run release minor      -> bump minor (1.1.0 -> 1.2.0)
//   npm run release 2.0.0      -> exact version
//
// Builds the installer, uploads it to the public lecture-notes-releases repo (where the app
// looks for updates), then commits the version bump, tags it and pushes the source repo.
// Needs the GitHub CLI signed in (`gh auth login`) or a GH_TOKEN environment variable.
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sh = (cmd, opts = {}) => execSync(cmd, { cwd: ROOT, stdio: 'inherit', ...opts });
const out = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
const fail = (msg) => { console.error('\n✖ ' + msg + '\n'); process.exit(1); };

if (out('git status --porcelain')) fail('Commit or discard your changes first (git status is not clean).');

const pkg = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const pub = (pkg().build.publish || [])[0] || {};
if (!pub.owner || pub.owner === 'GITHUB_USER') fail('Set build.publish[0].owner in package.json to your GitHub username.');

let token = process.env.GH_TOKEN;
if (!token) {
  const portableGh = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'gh', 'bin', 'gh.exe');
  for (const gh of ['gh', `"${portableGh}"`]) {
    try { token = out(`${gh} auth token`); break; } catch {}
  }
  if (!token) fail('Sign in with `gh auth login` (or set GH_TOKEN) so the installer can be uploaded.');
}

const bump = process.argv[2] || 'patch';
sh(`npm version ${bump} --no-git-tag-version --allow-same-version`, { stdio: 'pipe' });
const version = pkg().version;
console.log(`\nReleasing Lecture Notes v${version} to github.com/${pub.owner}/${pub.repo}\n`);

// electron-builder creates the GitHub release from two parallel uploads (installer + blockmap)
// that race each other and fail with HTTP 422, so create the release up front.
async function ensureRelease(tag) {
  const api = `https://api.github.com/repos/${pub.owner}/${pub.repo}/releases`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  if ((await fetch(`${api}/tags/${tag}`, { headers })).ok) return;
  const r = await fetch(api, {
    method: 'POST', headers,
    body: JSON.stringify({ tag_name: tag, name: tag.slice(1), body: `Lecture Notes ${tag.slice(1)}` })
  });
  if (!r.ok) throw new Error(`Couldn't create release ${tag}: ${r.status} ${await r.text()}`);
}

(async () => {
try {
  await ensureRelease(`v${version}`);
  sh('npx electron-builder --win --publish always', { env: { ...process.env, GH_TOKEN: token } });
} catch (e) {
  if (e && e.message && !e.status) console.error(e.message);
  sh('git checkout -- package.json package-lock.json');
  fail('Build or upload failed — version bump undone.');
}

sh('git add package.json package-lock.json');
if (out('git status --porcelain')) sh(`git commit -m "Release v${version}"`);
sh(`git tag v${version}`);
sh('git push --follow-tags');
console.log(`\n✔ v${version} is live. Installed apps will update the next time they're restarted.\n`);
})();
