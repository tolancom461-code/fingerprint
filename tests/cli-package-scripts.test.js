import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('Final Events consumer npm script loads the standalone service .env file', () => {
  assert.equal(
    pkg.scripts['simulate:final-events-consumer'],
    'node --env-file=.env src/cli/simulate-final-events-consumer.js'
  );
});
