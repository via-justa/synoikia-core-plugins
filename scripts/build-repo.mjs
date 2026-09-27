// Builds the signed plugin repository that Synoikia installs plugins from (Synoikia design §4.2–4.3).
//
// Every plugin version is a GitHub release `<id>-v<version>` holding `<id>-<version>.tgz` and its minisign
// signature. `index.json` lists every released version and lives on the fixed `index` release. The
// release workflow runs these steps in order, signing between `pack` and `index`:
//
//   pack     build and pack each plugin whose manifest version isn't in the current index yet
//   index    merge the new versions, with their signatures, into the current index
//   verify   install the new versions with Synoikia's own repository service, pinned to minisign.pub
//   publish  create the version releases, then replace index.json on the `index` release
//
// Released versions are never rebuilt or removed: to ship a change, bump the plugin's version.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'via-justa/synoikia-core-plugins';
const DOWNLOAD_BASE = `https://github.com/${REPO}/releases/download`;
const INDEX_TAG = 'index';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: '.repo' },
    // The index currently published; absent before the first release.
    current: { type: 'string', default: '.repo-current/index.json' },
  },
});
const out = path.resolve(ROOT, args.out);
const releasesFile = path.join(out, 'releases.json');

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const publicKey = () => readFileSync(path.join(ROOT, 'minisign.pub'), 'utf8').trim().split('\n').at(-1).trim();

function currentIndex() {
  const file = path.resolve(ROOT, args.current);
  const empty = {
    schema: 1,
    name: 'Synoikia plugins',
    homepage: `https://github.com/${REPO}`,
    publicKey: publicKey(),
    plugins: [],
  };
  if (!existsSync(file)) return empty;
  const index = readJson(file);
  if (index.publicKey !== empty.publicKey) {
    throw new Error('The published index has a different public key than minisign.pub; refusing to extend it.');
  }
  return index;
}

const released = (index, id, version) =>
  index.plugins.some((p) => p.id === id && p.versions.some((v) => v.version === version));

function pack() {
  const index = currentIndex();
  mkdirSync(out, { recursive: true });
  const releases = [];
  const pluginsDir = path.join(ROOT, 'plugins');
  for (const id of readdirSync(pluginsDir).sort()) {
    const dir = path.join(pluginsDir, id);
    if (!existsSync(path.join(dir, 'manifest.json'))) continue;
    const manifest = readJson(path.join(dir, 'manifest.json'));
    const pkg = readJson(path.join(dir, 'package.json'));
    if (manifest.id !== id) throw new Error(`plugins/${id}: manifest id is ${manifest.id}`);
    if (pkg.version !== manifest.version) {
      throw new Error(`plugins/${id}: package.json ${pkg.version} and manifest.json ${manifest.version} differ`);
    }
    if (released(index, id, manifest.version)) continue;

    execFileSync('pnpm', ['--filter', `./plugins/${id}`, 'run', 'build'], { cwd: ROOT, stdio: 'inherit' });
    const file = `${id}-${manifest.version}.tgz`;
    // Flat layout, what core installs: manifest.json, package.json, dist/. Sorted, with fixed times and
    // owners, so the same sources give the same bytes.
    const tarball = execFileSync(
      'tar',
      [
        '--sort=name',
        '--mtime=1970-01-01 00:00:00Z',
        '--owner=0',
        '--group=0',
        '--numeric-owner',
        '-C',
        dir,
        '-cf',
        '-',
        'manifest.json',
        'package.json',
        'dist',
      ],
      { maxBuffer: 256 * 1024 * 1024 },
    );
    const gz = execFileSync('gzip', ['-n', '-9'], { input: tarball, maxBuffer: 256 * 1024 * 1024 });
    writeFileSync(path.join(out, file), gz);
    releases.push({
      id,
      version: manifest.version,
      tag: `${id}-v${manifest.version}`,
      file,
      sha256: createHash('sha256').update(gz).digest('hex'),
      name: manifest.name,
      description: manifest.description,
      sdk: manifest.sdk,
      minCoreVersion: pkg.synoikia?.minCoreVersion,
    });
    console.log(`packed ${file}`);
  }
  writeFileSync(releasesFile, JSON.stringify(releases, null, 2) + '\n');
  console.log(releases.length ? `${releases.length} new version(s)` : 'nothing new to release');
}

function index() {
  const idx = currentIndex();
  for (const r of readJson(releasesFile)) {
    const sigFile = path.join(out, `${r.file}.minisig`);
    if (!existsSync(sigFile)) throw new Error(`${r.file} is not signed`);
    let plugin = idx.plugins.find((p) => p.id === r.id);
    if (!plugin) idx.plugins.push((plugin = { id: r.id, name: r.name, versions: [] }));
    plugin.name = r.name;
    if (r.description) plugin.description = r.description;
    plugin.versions.push({
      version: r.version,
      sdk: r.sdk,
      ...(r.minCoreVersion ? { minCoreVersion: r.minCoreVersion } : {}),
      url: `${DOWNLOAD_BASE}/${r.tag}/${r.file}`,
      sha256: r.sha256,
      signature: readFileSync(sigFile, 'utf8'),
    });
  }
  idx.plugins.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(path.join(out, 'index.json'), JSON.stringify(idx, null, 2) + '\n');
}

async function verify() {
  const releases = readJson(releasesFile);
  if (!releases.length) return console.log('nothing to verify');
  // Only this run's versions are local; the check installs exactly those, from the index as published.
  const full = readJson(path.join(out, 'index.json'));
  const subset = {
    ...full,
    plugins: full.plugins
      .map((p) => ({
        ...p,
        versions: p.versions.filter((v) => releases.some((r) => r.id === p.id && r.version === v.version)),
      }))
      .filter((p) => p.versions.length),
  };
  const file = path.join(out, 'verify-index.json');
  writeFileSync(file, JSON.stringify(subset));
  const { verifyPluginRepository } = await import('@synoikia/core/testing');
  const verified = await verifyPluginRepository({ index: file, assets: out, publicKey: publicKey() });
  for (const v of verified) {
    if (!v.signatureVerified) throw new Error(`${v.id}@${v.version}: signature not verified`);
    console.log(`verified ${v.id}@${v.version}`);
  }
}

function publish() {
  const releases = readJson(releasesFile);
  if (!releases.length) return console.log('nothing to publish');
  const gh = (...a) => execFileSync('gh', a, { cwd: ROOT, stdio: 'inherit' });
  const exists = (tag) => {
    try {
      execFileSync('gh', ['release', 'view', tag], { cwd: ROOT, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  for (const r of releases) {
    const tarball = path.join(out, r.file);
    // Left by a run that stopped before updating the index: replace its assets with this run's, which
    // the index about to be published describes.
    if (exists(r.tag)) {
      gh('release', 'upload', r.tag, tarball, `${tarball}.minisig`, '--clobber');
      continue;
    }
    gh(
      'release',
      'create',
      r.tag,
      tarball,
      `${tarball}.minisig`,
      '--title',
      `${r.name} ${r.version}`,
      '--notes',
      `${r.name} ${r.version}, signed with the key in minisign.pub. Install it from Synoikia's Plugins page.`,
      '--latest=false',
    );
  }
  if (!exists(INDEX_TAG)) {
    gh(
      'release',
      'create',
      INDEX_TAG,
      '--title',
      'Plugin index',
      '--notes',
      'The index Synoikia reads this repository from. Replaced on every release.',
      '--latest=false',
    );
  }
  gh('release', 'upload', INDEX_TAG, path.join(out, 'index.json'), '--clobber');
}

const steps = { pack, index, verify, publish };
const step = steps[positionals[0]];
if (!step) {
  console.error(`usage: build-repo.mjs <${Object.keys(steps).join('|')}> [--out dir] [--current index.json]`);
  process.exit(2);
}
await step();
