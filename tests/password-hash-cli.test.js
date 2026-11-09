import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/hash-admin-password.mjs', import.meta.url));
const derive = promisify(scrypt);
function run(input, args = ['--stdin']) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', data => { out += data; });
    child.stderr.on('data', data => { err += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, out, err }));
    if (Array.isArray(input)) { for (const part of input) child.stdin.write(part); child.stdin.end(); }
    else child.stdin.end(input);
  });
}

test('password CLI emits only a usable salted hash for valid input', async () => {
  const password = 'Synthetic-cli-password!2026';
  const result = await run(password + '\r\n');
  assert.equal(result.code, 0);
  assert.match(result.out, /^scrypt-v1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}\n$/);
  assert.equal(result.err, '');
  assert.ok(!result.out.includes(password));
});

test('password CLI preserves Arabic characters when UTF-8 arrives across chunks', async () => {
  const password = 'كلمة-تجريبية-طويلة-فقط-2026';
  const bytes = Buffer.from(password + '\n');
  const result = await run([bytes.subarray(0, 1), bytes.subarray(1, 7), bytes.subarray(7)]);
  assert.equal(result.code, 0);
  const [, salt, hash] = result.out.trim().split('$');
  const key = await derive(password, Buffer.from(salt, 'base64url'), 64, { N: 16384, r: 8, p: 5, maxmem: 64 * 1024 * 1024 });
  assert.ok(timingSafeEqual(key, Buffer.from(hash, 'base64url')));
  assert.ok(!result.out.includes(password) && !result.err.includes(password));
});

test('password CLI distinguishes empty, short, long and multiline input without echoing it', async () => {
  for (const [password, expected] of [
    ['', /لم يتم إدخال/], ['short-only', /أقصر من 12/], ['x'.repeat(257), /أطول من/], ['First-test-password\nSecond-test-password', /أكثر من سطر/]
  ]) {
    const result = await run(password + '\n');
    assert.equal(result.code, 1);
    assert.equal(result.out, '');
    assert.match(result.err, expected);
    if (password) assert.ok(!result.err.includes(password));
  }
});

test('password CLI rejects positional passwords and unknown flags without displaying them', async () => {
  const password = 'Never-pass-this-on-command-line';
  for (const args of [[password], ['--unknown'], ['--stdin', '--stdin']]) {
    const result = await run('', args);
    assert.equal(result.code, 1);
    assert.equal(result.out, '');
    assert.match(result.err, /دون كتابة/);
    assert.ok(!result.err.includes(password));
  }
});
