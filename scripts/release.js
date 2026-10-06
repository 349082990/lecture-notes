// Publish an update that installed copies of the app pick up automatically.
//
//   npm run release            -> bump patch (1.1.0 -> 1.1.1)
//   npm run release minor      -> bump minor (1.1.0 -> 1.2.0)
//   npm run release 2.0.0      -> exact version
//
// Builds the installer, uploads it to the public interview-notes repo (where people download the
// app and installed copies look for updates), then commits the version bump, tags it and pushes
// the source repo. RELEASE_NOTES (optional, Markdown) is added to the release page.
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
console.log(`\nReleasing Interview Notes v${version} to github.com/${pub.owner}/${pub.repo}\n`);

// The release is created as a DRAFT first and only made public once every file (installer,
// blockmap, latest.yml) is uploaded. Installed apps can't see drafts, so they never catch a
// half-uploaded release ("Cannot find latest.yml"). Creating it up front also stops
// electron-builder's two parallel uploads from racing to create it (HTTP 422).
const api = `https://api.github.com/repos/${pub.owner}/${pub.repo}/releases`;
const gh = async (url, opts = {}) => {
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(`GitHub ${opts.method || 'GET'} ${url}: ${r.status} ${await r.text()}`);
  return r.json();
};
async function draftRelease(tag) {
  const existing = (await gh(`${api}?per_page=30`)).find(r => r.tag_name === tag);
  if (existing) {
    if (!existing.draft) throw new Error(`${tag} is already published — pick a new version`);
    return existing;
  }
  const v = tag.slice(1);
  const body = `Interview Notes ${v}${process.env.RELEASE_NOTES ? '\n\n' + process.env.RELEASE_NOTES : ''}\n\n` +
    `**Download:** \`Interview-Notes-Setup-${v}.exe\` below (Windows 10 / 11). ` +
    'Already installed? The app updates itself — just restart it.';
  return gh(api, { method: 'POST', body: JSON.stringify({ tag_name: tag, name: v, body, draft: true }) });
}
async function publishRelease(release) {
  const assets = (await gh(`${api}/${release.id}/assets`)).map(a => a.name);
  if (!assets.includes('latest.yml')) throw new Error(`latest.yml didn't upload (got: ${assets.join(', ')})`);
  await gh(`${api}/${release.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false, make_latest: 'true' }) });
}

(async () => {
try {
  const release = await draftRelease(`v${version}`);
  sh('npm run build:editor');
  sh('npx electron-builder --win --publish always', { env: { ...process.env, GH_TOKEN: token } });
  await publishRelease(release);
} catch (e) {
  if (e && e.message && !e.status) console.error(e.message);
  sh('git checkout -- package.json package-lock.json');
  fail('Build or upload failed — version bump undone.');
}

sh('git add package.json package-lock.json');
if (out('git status --porcelain')) sh(`git commit -m "Release v${version}"`);
sh(`git tag v${version}`);
sh('git push');
sh(`git push origin v${version}`); // a plain tag isn't sent by --follow-tags
console.log(`\n✔ v${version} is live. Installed apps will update the next time they're restarted.\n`);
})();
