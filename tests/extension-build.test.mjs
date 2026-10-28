import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const directory = fileURLToPath(new URL('../apps/extension/dist/', import.meta.url));
const root = fileURLToPath(new URL('../', import.meta.url));

before(async () => {
  await promisify(execFile)(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build', '-w', '@clickflow/extension'], {
    cwd: root,
    env: { ...process.env, MODEL_API_KEY: 'clickflow-build-secret-sentinel' },
    timeout: 30_000,
  });
});

test('unpacked extension has valid local entrypoints and minimal permissions', async () => {
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['sidePanel']);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1/*']);
  assert.equal(manifest.content_scripts, undefined);
  await access(join(directory, manifest.background.service_worker));
  await access(join(directory, manifest.side_panel.default_path));
  const html = await readFile(join(directory, manifest.side_panel.default_path), 'utf8');
  for (const [, asset] of html.matchAll(/(?:src|href)="\.\/([^"#]+)"/g)) await access(join(directory, asset));
});

test('production extension contains no backend secrets or remote scripts', async () => {
  async function files(path) {
    const entries = await readdir(path, { withFileTypes: true });
    return (await Promise.all(entries.map((entry) => entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]))).flat();
  }
  const paths = await files(directory);
  for (const path of paths) {
    const source = await readFile(path, 'utf8');
    assert.equal(/MODEL_API_KEY|clickflow-build-secret-sentinel/.test(source), false, `Secret found in ${path}`);
    assert.equal(/<script[^>]+src=["']https?:/.test(source), false, `Remote script found in ${path}`);
  }
});
