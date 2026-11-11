import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../src/infrastructure/portal/public/', import.meta.url);
const [html, source] = await Promise.all([fs.readFile(new URL('index.html', root), 'utf8'), fs.readFile(new URL('app.js', root), 'utf8')]);
class Element {
  constructor() {
    this.children = []; this.textContent = ''; this.value = ''; this.hidden = false; this.disabled = false;
    this.listeners = {}; this.dataset = {}; this.classList = { toggle() {}, contains() { return false; } };
    this.parentElement = { previousElementSibling: { textContent: '' } };
  }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = [...items]; }
  setAttribute() {}
  removeAttribute() {}
  addEventListener(name, callback) { this.listeners[name] = callback; }
  close() {}
  focus() {}
}
async function initialize() {
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const requests = [];
  const document = { body: new Element(), title: '', getElementById: id => nodes.get(id),
    createElement: () => new Element(), querySelectorAll: () => [], addEventListener() {} };
  document.body.dataset.portalMode = 'database-ingest';
  const context = { document, window: { location: { hash: '#device-users', replace() {} }, addEventListener() {} },
    URLSearchParams, AbortSignal, Intl, Date, setTimeout, clearTimeout,
    async fetch(path) {
      requests.push(path);
      let body;
      if (path === '/auth/session') body = { mode: 'database-ingest', user: { username: 'SYNTHETIC', role: 'viewer' }, capabilities: { receivedRecords: true } };
      else {
        const params = new URL(path, 'http://local.test').searchParams;
        const roster = params.get('roster');
        const historical = roster === 'historical';
        body = { items: [{ id: '20', deviceUserId: historical ? 'OLD-PIN' : 'CURRENT-PIN', displayName: 'Synthetic user',
          status: historical ? 'absent_from_device' : 'seen', deviceName: 'Synthetic terminal', mappedPersonName: 'Linked person' }],
          page: { number: Number(params.get('page')), limit: 10, total: historical ? 7 : roster === 'all' ? 182 : 175, totalPages: historical ? 1 : 19 },
          rosterCounts: { current: 175, historical: 7, all: 182 } };
      }
      return { status: 200, ok: true, async json() { return body; } };
    } };
  vm.runInNewContext(source, context, { filename: 'portal-app.js' });
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, requests, async settle() { await new Promise(resolve => setImmediate(resolve)); } };
}
const number = value => new Intl.NumberFormat('ar-SA').format(value);

test('roster UI defaults to current and distinguishes retained total from current device users', async () => {
  const f = await initialize();
  assert.equal(new URL(f.requests[1], 'http://local.test').searchParams.get('roster'), 'current');
  assert.equal(f.nodes.get('deviceUserRosterControls').hidden, false);
  assert.equal(f.nodes.get('navDeviceUsersCount').textContent, number(175));
  assert.equal(f.nodes.get('statDeviceUsers').textContent, number(175));
  assert.ok(f.nodes.get('statDeviceUsersRosterBreakdown').textContent.includes(number(182)));
  assert.ok(f.nodes.get('deviceUserRosterSummary').textContent.includes(number(7)));
  assert.equal(f.nodes.get('tableBody').children[0].children[3].children[0].textContent, 'حالي · Current');
});

test('switching to historical or all resets pagination and preserves the current-only navigation count', async () => {
  const f = await initialize();
  f.nodes.get('nextPage').listeners.click();
  await f.settle();
  assert.equal(new URL(f.requests.at(-1), 'http://local.test').searchParams.get('page'), '2');
  for (const [roster, expected] of [['historical', 7], ['all', 182]]) {
    f.nodes.get('deviceUserRosterFilter').value = roster;
    f.nodes.get('deviceUserRosterFilter').listeners.change();
    await f.settle();
    const query = new URL(f.requests.at(-1), 'http://local.test').searchParams;
    assert.equal(query.get('roster'), roster);
    assert.equal(query.get('page'), '1');
    assert.ok(f.nodes.get('listTotal').textContent.startsWith(number(expected)));
    assert.equal(f.nodes.get('navDeviceUsersCount').textContent, number(175));
    assert.equal(f.nodes.get('statDeviceUsers').textContent, number(175));
    if (roster === 'historical') assert.equal(f.nodes.get('tableBody').children[0].children[3].children[0].textContent, 'تاريخي · Historical');
  }
});
