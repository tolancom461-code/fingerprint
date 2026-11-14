import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../src/infrastructure/portal/public/', import.meta.url);
const [html, source] = await Promise.all([fs.readFile(new URL('index.html', root), 'utf8'), fs.readFile(new URL('app.js', root), 'utf8')]);
class Element {
  constructor() {
    this.children = []; this.textContent = ''; this.value = ''; this.hidden = false; this.disabled = false;
    this.listeners = {}; this.dataset = {}; this.attributes = new Map();
    this.classList = { toggle() {}, contains() { return false; } };
    this.parentElement = { previousElementSibling: { textContent: '' } };
  }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = [...items]; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  close() {}
  focus() {}
}
async function initialize({ hash = '#device-users', historicalTotal = 7, mode = 'database-ingest' } = {}) {
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const nav = new Map([...html.matchAll(/<button class="nav-item[^\"]*" data-view="([^"]+)"([^>]*)>/g)].map(([, view, attributes]) => {
    const button = new Element();
    button.dataset.view = view;
    button.hidden = /\bhidden\b/.test(attributes);
    button.ingestOnly = attributes.includes('data-ingest-only');
    return [view, button];
  }));
  const navButtons = [...nav.values()];
  const requests = [];
  const document = { body: new Element(), title: '', getElementById: id => nodes.get(id),
    createElement: () => new Element(), querySelectorAll: selector => {
      if (selector === '.nav-item' || selector === '[data-view]') return navButtons;
      if (selector === '[data-ingest-only]') return navButtons.filter(button => button.ingestOnly);
      return [];
    }, addEventListener() {} };
  document.body.dataset.portalMode = mode;
  const windowEvents = new Map();
  const window = { location: { get hash() { return hash; }, set hash(view) {
    const next = view.startsWith('#') ? view : `#${view}`;
    if (next === hash) return;
    hash = next;
    windowEvents.get('hashchange')?.();
  }, replace() {} }, addEventListener(name, callback) { windowEvents.set(name, callback); } };
  const context = { document, window,
    URLSearchParams, AbortSignal, Intl, Date, setTimeout, clearTimeout,
    async fetch(path) {
      requests.push(path);
      let body;
      if (path === '/auth/session') {
        body = { mode, user: { username: 'SYNTHETIC', role: 'viewer' }, capabilities: { receivedRecords: mode === 'database-ingest' } };
      } else if (path === '/api/portal/overview') {
        body = { counts: { deviceUsers: 175, historicalDeviceUsers: historicalTotal, allDeviceUsers: 175 + historicalTotal } };
      } else {
        const { pathname, searchParams: params } = new URL(path, 'http://local.test');
        assert.equal(pathname, '/api/portal/device-users');
        const roster = params.get('roster');
        assert.ok(roster === 'current' || roster === 'historical');
        const historical = roster === 'historical';
        const total = historical ? historicalTotal : 175;
        const filtered = params.get('search') && total > 0 ? 1 : total;
        body = { items: total ? [{ id: '20', deviceUserId: historical ? 'OLD-PIN' : 'CURRENT-PIN', displayName: 'Synthetic user',
          status: historical ? 'absent_from_device' : 'seen', deviceName: 'Synthetic terminal', mappedPersonName: 'Linked person' }] : [],
          page: { number: Number(params.get('page')), limit: 10, total: filtered, totalPages: Math.max(1, Math.ceil(filtered / 10)) } };
        if (historicalTotal) body.rosterCounts = { current: 175, historical: historicalTotal, all: 175 + historicalTotal };
      }
      return { status: 200, ok: true, async json() { return body; } };
    } };
  vm.runInNewContext(source, context, { filename: 'portal-app.js' });
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, nav, requests, window, async settle() { await new Promise(resolve => setImmediate(resolve)); } };
}
const number = value => new Intl.NumberFormat('ar-SA').format(value);
const query = f => new URL(f.requests.at(-1), 'http://local.test').searchParams;

test('the device users page contains only current users and both navigation counts reflect their own roster', async () => {
  const f = await initialize();
  assert.equal(query(f).get('roster'), 'current');
  assert.equal(f.nav.get('device-users').attributes.get('aria-current'), 'page');
  assert.equal(f.nav.get('historical-device-users').hidden, false);
  assert.equal(f.nodes.has('deviceUserRosterFilter'), false);
  assert.equal(f.nodes.get('navDeviceUsersCount').textContent, number(175));
  assert.equal(f.nodes.get('navHistoricalDeviceUsersCount').textContent, number(7));
  assert.equal(f.nodes.get('statDeviceUsers').textContent, number(175));
  assert.ok(f.nodes.get('statDeviceUsersRosterBreakdown').textContent.includes(number(182)));
  assert.equal(f.nodes.get('tableBody').children[0].children[1].textContent, 'CURRENT-PIN');
  assert.equal(f.nodes.get('tableBody').children[0].children[3].children[0].textContent, 'حالي · Current');
});

test('the historical page is deep-linkable and retains previous person associations', async () => {
  const f = await initialize({ hash: '#historical-device-users' });
  assert.equal(query(f).get('roster'), 'historical');
  assert.equal(f.nodes.get('pageTitle').textContent, 'المستخدمون التاريخيون');
  assert.equal(f.nodes.get('listTitle').textContent, 'المستخدمون التاريخيون');
  assert.equal(f.nav.get('historical-device-users').attributes.get('aria-current'), 'page');
  assert.equal(f.nav.get('device-users').attributes.has('aria-current'), false);
  assert.equal(f.nodes.get('listTotal').textContent, `${number(7)} مستخدم تاريخي`);
  const columns = f.nodes.get('tableBody').children[0].children;
  assert.equal(columns[1].textContent, 'OLD-PIN');
  assert.equal(columns[3].children[0].textContent, 'تاريخي · Historical');
  assert.equal(columns[4].textContent, 'Linked person');
  assert.equal(f.nodes.get('navDeviceUsersCount').textContent, number(175));
  assert.equal(f.nodes.get('navHistoricalDeviceUsersCount').textContent, number(7));
});

test('navigation, pagination, search and refresh stay within the selected user roster', async () => {
  const f = await initialize({ historicalTotal: 12 });
  f.nodes.get('nextPage').listeners.click();
  await f.settle();
  assert.equal(query(f).get('page'), '2');

  f.nav.get('historical-device-users').listeners.click();
  await f.settle();
  assert.equal(f.window.location.hash, '#historical-device-users');
  assert.equal(query(f).get('roster'), 'historical');
  assert.equal(query(f).get('page'), '1');
  f.nodes.get('nextPage').listeners.click();
  await f.settle();
  assert.equal(query(f).get('page'), '2');

  f.nodes.get('searchInput').value = 'OLD-PIN';
  f.nodes.get('searchForm').listeners.submit({ preventDefault() {} });
  await f.settle();
  assert.equal(query(f).get('roster'), 'historical');
  assert.equal(query(f).get('page'), '1');
  assert.equal(query(f).get('search'), 'OLD-PIN');
  assert.equal(f.nodes.get('listTotal').textContent, `${number(1)} مستخدم تاريخي`);
  assert.equal(f.nodes.get('navHistoricalDeviceUsersCount').textContent, number(12));
  assert.equal(f.nodes.get('navDeviceUsersCount').textContent, number(175));

  f.nav.get('device-users').listeners.click();
  await f.settle();
  assert.equal(query(f).get('roster'), 'current');
  assert.equal(query(f).get('page'), '2');
  assert.equal(query(f).get('search'), '');
  f.nav.get('historical-device-users').listeners.click();
  await f.settle();
  assert.equal(f.nodes.get('searchInput').value, 'OLD-PIN');
  f.nodes.get('refreshButton').listeners.click();
  await f.settle();
  assert.equal(query(f).get('roster'), 'historical');
  assert.equal(query(f).get('search'), 'OLD-PIN');
});

test('zero historical users render an empty page, and modes without ingestion cannot open it', async () => {
  const empty = await initialize({ hash: '#historical-device-users', historicalTotal: 0 });
  assert.equal(empty.nodes.get('listTotal').textContent, `${number(0)} مستخدم تاريخي`);
  assert.equal(empty.nodes.get('navHistoricalDeviceUsersCount').textContent, number(0));
  assert.equal(empty.nodes.get('nextPage').disabled, true);
  for (const mode of ['database-readonly', 'demo']) {
    const other = await initialize({ hash: '#historical-device-users', mode });
    assert.deepEqual(other.requests, ['/auth/session', '/api/portal/overview']);
    assert.equal(other.nav.get('historical-device-users').hidden, true);
  }
});
