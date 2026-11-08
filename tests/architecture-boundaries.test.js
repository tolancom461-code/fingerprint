import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function jsFiles(directory) {
  const output = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await jsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) output.push(full);
  }
  return output;
}

test('service source has no imports into the existing application', async () => {
  const forbidden = [
    '/server/', '/client/', '/shared/', '/drizzle/',
    '../server', '../../server', '../client', '../../client', '../shared', '../../shared'
  ];

  for (const file of await jsFiles(path.join(root, 'src'))) {
    const content = await fs.readFile(file, 'utf8');
    for (const token of forbidden) {
      assert.equal(content.includes(token), false, `${path.relative(root, file)} references forbidden boundary ${token}`);
    }
  }
});

test('database dependency is isolated from the existing application ORM', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  assert.equal(typeof dependencies.mysql2, 'string');
  for (const name of ['drizzle-orm', 'drizzle-kit', 'pg', 'postgres', '@supabase/supabase-js']) {
    assert.equal(name in dependencies, false, `${name} must not be present`);
  }
});

test('application and domain layers are vendor neutral', async () => {
  const coreDirs = [path.join(root, 'src', 'application'), path.join(root, 'src', 'domain'), path.join(root, 'src', 'ports')];
  for (const directory of coreDirs) {
    for (const file of await jsFiles(directory)) {
      const content = (await fs.readFile(file, 'utf8')).toLowerCase();
      for (const vendor of ['zkteco', 'hikvision', 'suprema', 'anviz']) {
        assert.equal(content.includes(vendor), false, `${path.relative(root, file)} must not depend on vendor ${vendor}`);
      }
    }
  }
});

test('vendor implementation has a single canonical infrastructure path', async () => {
  await assert.rejects(fs.access(path.join(root, 'src', 'infrastructure', 'zkteco')));
  await fs.access(path.join(root, 'src', 'infrastructure', 'vendors', 'zkteco'));
});

test('startup replay remains before automatic finalization activation to prevent historical backfill', async () => {
  const content = await fs.readFile(path.join(root, 'src', 'index.js'), 'utf8');
  const replayPosition = content.indexOf('const replay = await replayDurableIngest');
  const activationPosition = content.indexOf('new AutomaticFinalizingPunchStore');
  assert.notEqual(replayPosition, -1);
  assert.notEqual(activationPosition, -1);
  assert.equal(replayPosition < activationPosition, true);
});

test('integration credential is not spread into the device vendor adapter configuration', async () => {
  const content = await fs.readFile(path.join(root, 'src', 'index.js'), 'utf8');
  assert.equal(content.includes('config: { ...config, adms: config.zkteco.adms }'), false);
  assert.match(content, /config:\s*\{\s*adms: config\.zkteco\.adms,\s*maxBodyBytes: config\.maxBodyBytes,\s*attlogAckMode: config\.attlogAckMode\s*\}/s);
});
