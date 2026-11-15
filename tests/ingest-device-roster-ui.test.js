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
  append(...items) { for (const item of items) item.container = this; this.children.push(...items); }
  replaceChildren(...items) {
    for (const item of this.children) item.container = null;
    this.children = [];
    this.append(...items);
  }
  after(item) {
    item.container = this.container;
    this.container.children.splice(this.container.children.indexOf(this) + 1, 0, item);
  }
  remove() {
    if (!this.container) return;
    this.container.children.splice(this.container.children.indexOf(this), 1);
    this.container = null;
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  close() {}
  focus() {}
}
async function initialize({ hash = '#device-users', historicalTotal = 7, mode = 'database-ingest', capabilities = {}, receivedPunches } = {}) {
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Element()]));
  const nav = new Map([...html.matchAll(/<button class="nav-item[^\"]*" data-view="([^"]+)"([^>]*)>/g)].map(([, view, attributes]) => {
    const button = new Element();
    button.dataset.view = view;
    button.hidden = /\bhidden\b/.test(attributes);
    button.ingestOnly = attributes.includes('data-ingest-only');
    button.deviceChangesOnly = attributes.includes('data-device-changes-only');
    return [view, button];
  }));
  const navButtons = [...nav.values()];
  const requests = [];
  const document = { body: new Element(), title: '', getElementById: id => nodes.get(id),
    createElement: () => new Element(), querySelectorAll: selector => {
      if (selector === '.nav-item' || selector === '[data-view]') return navButtons;
      if (selector === '[data-ingest-only]') return navButtons.filter(button => button.ingestOnly);
      if (selector === '[data-device-changes-only]') return navButtons.filter(button => button.deviceChangesOnly);
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
    URLSearchParams, AbortController, AbortSignal, Intl, Date, setTimeout, clearTimeout,
    async fetch(path, options) {
      requests.push(path);
      let body;
      let status = 200;
      if (path === '/auth/session') {
        body = { mode, user: { username: 'SYNTHETIC', role: 'viewer' }, capabilities: { receivedRecords: mode === 'database-ingest', ...capabilities } };
      } else if (path === '/api/portal/overview') {
        body = { counts: { deviceUsers: 175, historicalDeviceUsers: historicalTotal, allDeviceUsers: 175 + historicalTotal } };
      } else {
        const { pathname, searchParams: params } = new URL(path, 'http://local.test');
        if (pathname === '/api/portal/device-user-changes') {
          const added = params.get('kind') === 'added';
          body = { items: [{ id: '31', deviceUserRowId: '20', deviceUserId: 'NEW-PIN', deviceName: 'Synthetic terminal',
            before: added ? null : { displayName: 'Old name', status: 'seen', metadata: { Pri: '0', Grp: '3' } },
            after: { displayName: 'New name', status: 'seen', metadata: { Pri: '1', Grp: '3' } }, occurredAt: '2026-11-15T12:00:00.000Z' }],
          page: { number: Number(params.get('page')), limit: 10, total: 1, totalPages: 1 } };
        } else if (pathname === '/api/portal/received-punches') {
          if (receivedPunches) {
            ({ body, status = 200 } = await receivedPunches(params, options));
          } else {
            body = { items: [{ id: '30', deviceUserId: 'OLD-PIN', parseValid: true, processingStatus: 'processed' }],
              page: { number: Number(params.get('page')), limit: 10, total: 1, totalPages: 1 } };
          }
        } else {
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
      }
      return { status, ok: status >= 200 && status < 300, async json() { return body; } };
    } };
  vm.runInNewContext(source, context, { filename: 'portal-app.js' });
  await new Promise(resolve => setImmediate(resolve));
  return { nodes, nav, requests, window, async settle() { await new Promise(resolve => setImmediate(resolve)); } };
}
const number = value => new Intl.NumberFormat('ar-SA').format(value);
const query = f => new URL(f.requests.at(-1), 'http://local.test').searchParams;
const punchPanel = f => f.nodes.get('tableBody').children[1].children[0].children[0];

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

test('current user names expand their own received movements and show all six canonical device states', async () => {
  const movement = (punchState, devicePunchState) => ({ punchState, devicePunchState, eventTimeUtc: '2026-11-15T09:01:00.000Z' });
  const first = ['check_in', 'check_out', 'break_out', 'break_in', 'overtime_in', 'overtime_out']
    .map((state, code) => movement(state, String(code)));
  first[0].eventTimeLocal = '2026-11-15 10:01:47';
  const second = [{ punchState: null, devicePunchState: '0', eventTimeLocal: '2026-11-15 10:02:00' },
    { punchState: null, devicePunchState: null, eventTimeUtc: 'invalid' }];
  const f = await initialize({ capabilities: { deviceUserPunches: true }, receivedPunches(params) {
    const page = Number(params.get('page'));
    assert.equal(params.get('deviceUserRowId'), '20');
    return { body: { items: page === 1 ? first : second, page: { number: page, totalPages: 2 } } };
  } });
  const name = f.nodes.get('tableBody').children[0].children[0].children[0];
  assert.equal(name.textContent, 'Synthetic user');
  assert.equal(name.attributes.get('aria-expanded'), 'false');
  name.listeners.click();
  await f.settle();
  assert.equal(f.window.location.hash, '#device-users');
  const panel = punchPanel(f);
  assert.equal(name.attributes.get('aria-controls'), panel.id);
  assert.equal(name.attributes.get('aria-expanded'), 'true');
  assert.equal(panel.attributes.get('aria-labelledby'), name.id);
  const [, , table, more] = panel.children;
  const rows = table.children[1].children;
  assert.equal(table.hidden, false);
  assert.equal(table.children[0].children[0].children[0].textContent, 'التاريخ والوقت');
  assert.deepEqual(rows.map(row => row.children[1].textContent),
    ['دخول', 'خروج', 'خروج للاستراحة', 'عودة من الاستراحة', 'بداية العمل الإضافي', 'نهاية العمل الإضافي']);
  assert.equal(rows[0].children[0].textContent, 'وقت الجهاز: 2026-11-15 10:01:47');
  assert.equal(rows[1].children[0].textContent, `وقت الرياض: ${new Intl.DateTimeFormat('ar-SA-u-ca-gregory', {
    timeZone: 'Asia/Riyadh', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(new Date(first[1].eventTimeUtc))}`);
  assert.equal(more.hidden, false);
  more.listeners.click();
  await f.settle();
  assert.equal(query(f).get('page'), '2');
  assert.equal(more.hidden, true);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows[6].children.map(cell => cell.textContent), ['وقت الجهاز: 2026-11-15 10:02:00', 'غير معروفة · الرمز 0']);
  assert.deepEqual(rows[7].children.map(cell => cell.textContent), ['وقت الجهاز غير متاح', 'غير مسجلة']);
  name.listeners.click();
  assert.equal(name.attributes.get('aria-expanded'), 'false');
  assert.equal(f.nodes.get('tableBody').children.length, 1);
});

test('empty and error states stay in the expanded row and retry the same page', async () => {
  let attempts = 0;
  const f = await initialize({ capabilities: { deviceUserPunches: true }, receivedPunches(params) {
    assert.equal(params.get('page'), '1');
    return ++attempts === 1
      ? { status: 500, body: { message: 'تعذر تحميل الحركات.' } }
      : { body: { items: [], page: { number: 1, totalPages: 1 } } };
  } });
  f.nodes.get('tableBody').children[0].children[0].children[0].listeners.click();
  await f.settle();
  const [, status, table, more] = punchPanel(f).children;
  assert.equal(status.textContent, 'تعذر تحميل الحركات.');
  assert.equal(more.textContent, 'إعادة المحاولة');
  assert.equal(more.hidden, false);
  more.listeners.click();
  await f.settle();
  assert.equal(status.textContent, 'لا توجد حركات مستلمة لهذا المستخدم.');
  assert.equal(table.hidden, true);
  assert.equal(more.hidden, true);
});

test('roster page changes cancel pending expanded requests and ignore any late response', async () => {
  let finish;
  let requestSignal;
  const f = await initialize({ capabilities: { deviceUserPunches: true }, receivedPunches(params, options) {
    requestSignal = options.signal;
    return new Promise(resolve => { finish = resolve; });
  } });
  f.nodes.get('tableBody').children[0].children[0].children[0].listeners.click();
  const [, , table] = punchPanel(f).children;
  f.nodes.get('nextPage').listeners.click();
  await f.settle();
  assert.equal(requestSignal.aborted, true);
  assert.equal(query(f).get('page'), '2');
  assert.equal(f.nodes.get('tableBody').children.length, 1);
  finish({ body: { items: [{ punchState: 'check_in' }], page: { number: 1, totalPages: 1 } } });
  await f.settle();
  assert.equal(table.children[1].children.length, 0);
  assert.equal(f.nodes.get('tableBody').children.length, 1);
});

test('historical moves use the stored identity row id and clear back to all receipts', async () => {
  const f = await initialize({ hash: '#historical-device-users', capabilities: { deviceUserPunches: true } });
  const action = f.nodes.get('tableBody').children[0].children[6].children[0];
  assert.equal(action.textContent, 'عرض الحركات');
  action.listeners.click();
  await f.settle();
  assert.equal(new URL(f.requests.at(-1), 'http://local.test').pathname, '/api/portal/received-punches');
  assert.equal(query(f).get('deviceUserRowId'), '20');
  assert.equal(query(f).get('search'), '');
  assert.equal(f.nodes.get('punchIdentityFilter').hidden, false);
  f.nodes.get('clearPunchIdentityFilter').listeners.click();
  await f.settle();
  assert.equal(query(f).has('deviceUserRowId'), false);
  assert.equal(f.nodes.get('punchIdentityFilter').hidden, true);
});

test('device history shows newly added users and only changed before/after fields', async () => {
  const f = await initialize({ hash: '#new-device-users', capabilities: { deviceUserChanges: true } });
  assert.equal(query(f).get('kind'), 'added');
  assert.equal(f.nav.get('new-device-users').hidden, false);
  assert.equal(f.nodes.get('pageTitle').textContent, 'المستخدمون الجدد');
  assert.equal(f.nodes.get('tableBody').children[0].children[0].textContent, 'New name');
  f.nav.get('device-user-changes').listeners.click();
  await f.settle();
  assert.equal(query(f).get('kind'), 'updated');
  assert.equal(f.nodes.get('pageTitle').textContent, 'التعديلات');
  const [before, after] = f.nodes.get('tableBody').children[0].children.slice(2, 4);
  const values = cell => cell.children.map(field => field.children.map(node => node.textContent));
  assert.deepEqual(values(before), [['الاسم', 'Old name'], ['الصلاحية', '0']]);
  assert.deepEqual(values(after), [['الاسم', 'New name'], ['الصلاحية', '1']]);
  const disabled = await initialize({ hash: '#device-user-changes' });
  assert.equal(disabled.nav.get('device-user-changes').hidden, true);
  assert.deepEqual(disabled.requests, ['/auth/session', '/api/portal/overview']);
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
