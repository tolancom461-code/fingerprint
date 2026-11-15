'use strict';

const $ = id => document.getElementById(id);
const descriptions = {
  overview: ['نظرة عامة', 'ملخص الأجهزة والأشخاص والحركات في مساحة التجربة.'],
  devices: ['الأجهزة', 'نماذج أجهزة تجريبية. لا يوجد جهاز حقيقي متصل بهذه البوابة.'],
  people: ['الأشخاص', 'عرض الأشخاص واختبار إدارة سجل تجريبي معزول.'],
  events: ['الحركات', 'أمثلة دخول وخروج للعرض فقط، بتوقيت الرياض.']
};
const databaseDescriptions = {
  overview: ['نظرة عامة', 'ملخص الأجهزة والأشخاص والحركات النهائية المحفوظة في قاعدة نظام البصمة.'],
  devices: ['الأجهزة', 'الأجهزة المسجلة وآخر ملاحظة لها؛ وجود سجل لا يثبت الاتصال الحالي.'],
  people: ['الأشخاص', 'الأشخاص المسجلون في نظام البصمة، للعرض فقط.'],
  events: ['الحركات النهائية', 'الحركات النهائية المحفوظة، بتوقيت الرياض. لا تشمل الحركات المعلقة.'],
  'received-punches': ['الحركات المستلمة', 'السجلات المحفوظة عند الاستقبال، بما فيها المعلقة وغير المرتبطة بشخص.'],
  'device-users': ['مستخدمو الأجهزة الحاليون', 'المستخدمون الحاليون في دليل الجهاز، مع إبقاء ربطهم بالأشخاص مستقلًا.'],
  'historical-device-users': ['المستخدمون التاريخيون', 'هويات محفوظة لحركاتها السابقة وروابطها بالأشخاص.'],
  'new-device-users': ['المستخدمون الجدد', 'المستخدمون الذين سجّل النظام إضافتهم إلى دليل الجهاز.'],
  'device-user-changes': ['التعديلات', 'القيم السابقة والجديدة للحقول التي تغيّرت في بيانات المستخدم.']
};
const deviceUserColumns = ['المستخدم', 'رقمه في الجهاز', 'الجهاز', 'القائمة', 'الشخص المرتبط', 'آخر ملاحظة'];
const columns = {
  devices: ['الجهاز', 'الرقم التسلسلي', 'الطراز', 'حالة الاتصال', 'آخر اتصال'],
  people: ['الشخص', 'كود الشخص', 'الحالة'],
  events: ['الشخص', 'نوع الحركة', 'التوقيت · الرياض', 'طريقة التحقق', 'الجهاز'],
  'received-punches': ['رقم المستخدم في الجهاز', 'وقت الحركة', 'الجهاز', 'المعالجة', 'حدث نهائي'],
  'device-users': deviceUserColumns,
  'historical-device-users': deviceUserColumns,
  'new-device-users': ['المستخدم', 'رقمه في الجهاز', 'الجهاز', 'وقت الإضافة'],
  'device-user-changes': ['رقم المستخدم في الجهاز', 'الجهاز', 'قبل التعديل', 'بعد التعديل', 'وقت التعديل']
};
const deviceRosters = { 'device-users': 'current', 'historical-device-users': 'historical' };
const deviceChangeKinds = { 'new-device-users': 'added', 'device-user-changes': 'updated' };
const devicePunchStates = new Map([
  ['check_in', 'دخول'], ['check_out', 'خروج'], ['break_out', 'خروج للاستراحة'], ['break_in', 'عودة من الاستراحة'],
  ['overtime_in', 'بداية العمل الإضافي'], ['overtime_out', 'نهاية العمل الإضافي']
]);
const numbers = new Intl.NumberFormat('ar-SA');
const dates = new Intl.DateTimeFormat('ar-SA-u-ca-gregory', { timeZone: 'Asia/Riyadh', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const state = {
  session: null, view: 'overview', pending: false, request: 0, list: null, deviceUserRowId: null, userPunches: null,
  searches: Object.fromEntries(Object.keys(columns).map(view => [view, ''])),
  pages: Object.fromEntries(Object.keys(columns).map(view => [view, 1]))
};
let searchTimer;

function isDemo() { return (state.session?.mode ?? document.body.dataset.portalMode) === 'demo'; }
function hasReceivedRecords() { return state.session?.capabilities?.receivedRecords === true; }
function hasDeviceUserChanges() { return hasReceivedRecords() && state.session.capabilities.deviceUserChanges === true; }
function hasDeviceUserPunches() { return hasReceivedRecords() && state.session.capabilities.deviceUserPunches === true; }
function allowedView(view) {
  if (Object.hasOwn(deviceChangeKinds, view)) return !isDemo() && hasDeviceUserChanges();
  if (view === 'received-punches' || Object.hasOwn(deviceRosters, view)) return !isDemo() && hasReceivedRecords();
  return Object.hasOwn(descriptions, view);
}
function canCreatePerson() {
  return state.session?.capabilities?.createPerson === true && state.session?.user.role === 'admin' && state.session?.mode === 'demo';
}
function columnNames(view) {
  if (view === 'devices' && !isDemo()) return ['الجهاز', 'الرقم التسلسلي', 'الطراز', 'الحالة الإدارية', 'حالة الاتصال', 'آخر ملاحظة'];
  if (view === 'historical-device-users' && hasDeviceUserPunches()) return [...columns[view], 'الحركات'];
  return columns[view];
}

function applyPortalMode() {
  if (isDemo()) return;
  for (const [id, text] of Object.entries({
    sidebarModeName: 'قراءة فقط',
    sidebarModeDescription: 'عرض السجلات المحفوظة دون تعديل بيانات النظام.',
    bannerTitle: 'بيانات نظام البصمة · قراءة فقط',
    bannerDescription: 'تعرض السجلات من قاعدة الخدمة دون إتاحة التعديل. وجود جهاز أو حركة محفوظة لا يثبت اتصال الجهاز الآن.',
    bannerBadge: 'عرض البيانات',
    statDevicesLabel: 'الأجهزة المسجلة',
    statDevicesDescription: 'سجلات الأجهزة، وليست عدد الأجهزة المتصلة',
    statPeopleDescription: 'الأشخاص المسجلون في قاعدة الخدمة',
    statEventsLabel: 'الحركات النهائية',
    navEventsLabel: 'الحركات النهائية',
    statEventsDescription: 'حركات نهائية محفوظة؛ لا تشمل الحركات المعلقة',
    deviceConnectionStatus: 'غير مؤكدة',
    deviceConnectionDescription: 'هذه القراءة لا تختبر اتصال الأجهزة الحالي',
    systemPanelTitle: 'حالة عرض البيانات',
    systemPanelDescription: 'مصدر السجلات وحدود المعلومات المعروضة.',
    systemPanelBadge: 'قراءة فقط',
    sourceDescription: 'قاعدة بيانات نظام البصمة',
    deviceReception: 'غير متحقق من هذه الواجهة',
    deliveryState: 'غير متحقق من هذه الواجهة',
    databaseLabel: 'تعديل البيانات',
    databaseState: 'غير متاح في وضع القراءة',
    exploreDescription: 'تصفح السجلات المحفوظة في نظام البصمة.',
    exploreDevicesDescription: 'الأجهزة المسجلة وآخر ملاحظة لها',
    explorePeopleDescription: 'عرض الأشخاص المسجلين',
    exploreEventsDescription: 'الحركات النهائية بتوقيت الرياض'
  })) $(id).textContent = text;
  $('searchInput').maxLength = 100;
  $('addPersonDialog').hidden = true;
  $('addPersonForm').inert = true;
  document.querySelectorAll('[data-ingest-only]').forEach(node => { node.hidden = !hasReceivedRecords(); });
  document.querySelectorAll('[data-device-changes-only]').forEach(node => { node.hidden = !hasDeviceUserChanges(); });
  $('statsGrid').classList.toggle('ingest-stats', hasReceivedRecords());
  if (hasReceivedRecords()) {
    for (const [id, text] of Object.entries({
      sidebarModeName: 'استقبال محمي',
      sidebarModeDescription: 'استقبال الحركات وعرض السجلات المحفوظة.',
      bannerTitle: 'استقبال الحركات ومتابعتها',
      bannerDescription: 'تظهر السجلات المستلمة هنا قبل اعتمادها كحركات نهائية. تظل حالة اتصال الجهاز غير مؤكدة حتى الاختبار الفعلي.',
      bannerBadge: 'استقبال محمي',
      deviceReception: 'مفعّل للطلبات المصادق عليها',
      deliveryState: 'الإرسال إلى البرامج الأخرى معطّل',
      systemPanelTitle: 'حالة الاستقبال والعرض',
      databaseLabel: 'حفظ الحركات',
      databaseState: 'مفعّل عبر قناة الاستقبال',
      systemPanelDescription: 'حالة الخدمة لا تعني أن الجهاز متصل حاليًا.'
    })) $(id).textContent = text;
  }
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function showNotice(message, kind = 'error') {
  $('globalNotice').className = `notice notice-${kind}`;
  $('globalNotice').textContent = message;
  $('globalNotice').hidden = false;
}

async function api(url, options = {}) {
  const headers = { Accept: 'application/json', ...options.headers };
  const timeout = AbortSignal.timeout(15000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const init = { ...options, headers, credentials: 'same-origin', cache: 'no-store', signal };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = state.session?.csrfToken || '';
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, init);
  if (response.status === 401) {
    state.session = null;
    window.location.replace('/login');
    throw new Error('انتهت الجلسة. يرجى تسجيل الدخول مجددًا.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 403) throw new Error(data.message || 'هذا الإجراء غير متاح لحسابك، أو انتهت صلاحية الطلب. حدّث الصفحة.');
    if (response.status === 429) throw new Error('طلبات كثيرة خلال وقت قصير. انتظر قليلًا ثم أعد المحاولة.');
    throw new Error(data.message || 'تعذر إكمال الطلب. أعد المحاولة.');
  }
  return data;
}

function connectionError(error) {
  return error instanceof TypeError || error.name === 'TimeoutError'
    ? 'تعذر الاتصال بالخدمة. تحقق من الاتصال ثم اضغط تحديث.' : error.message;
}

function viewFromHash() {
  const view = window.location.hash.slice(1).split('?')[0];
  return allowedView(view) ? view : 'overview';
}

function punchIdentityFromHash() {
  if (!hasDeviceUserPunches()) return null;
  const [view, query] = window.location.hash.slice(1).split('?');
  if (view !== 'received-punches' || !query) return null;
  const rowId = new URLSearchParams(query).get('deviceUserRowId');
  return rowId && /^[1-9][0-9]{0,19}$/.test(rowId) && BigInt(rowId) <= 18446744073709551615n ? rowId : null;
}

function toggleMenu(open) {
  document.body.classList.toggle('sidebar-open', open);
  $('sidebarBackdrop').hidden = !open;
  $('menuToggle').setAttribute('aria-expanded', String(open));
  $('menuToggle').setAttribute('aria-label', open ? 'إغلاق القائمة الرئيسية' : 'فتح القائمة الرئيسية');
}

function setView(view) {
  if (!allowedView(view)) return;
  clearTimeout(searchTimer);
  const deviceUserRowId = view === 'received-punches' ? punchIdentityFromHash() : null;
  if (deviceUserRowId !== state.deviceUserRowId && view === 'received-punches') {
    state.pages[view] = 1;
    state.searches[view] = '';
  }
  state.deviceUserRowId = deviceUserRowId;
  state.view = view;
  state.list = null;
  const [title, description] = (isDemo() ? descriptions : databaseDescriptions)[view];
  $('pageTitle').textContent = title;
  $('breadcrumb').textContent = title;
  $('pageDescription').textContent = description;
  document.title = `${title} · نظام البصمة`;
  document.querySelectorAll('.nav-item').forEach(button => {
    const current = button.dataset.view === view;
    button.classList.toggle('is-active', current);
    if (current) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('overviewView').hidden = view !== 'overview';
  $('listView').hidden = view === 'overview';
  $('punchIdentityFilter').hidden = !deviceUserRowId;
  $('addPersonButton').hidden = view !== 'people' || !canCreatePerson();
  if (view !== 'overview') {
    $('searchInput').value = state.searches[view];
    const searchPlaceholders = { people: 'ابحث بالاسم أو الكود…', devices: 'ابحث باسم الجهاز أو رقمه…' };
    $('searchInput').placeholder = Object.hasOwn(deviceRosters, view) || Object.hasOwn(deviceChangeKinds, view)
      ? 'ابحث باسم المستخدم أو رقمه…' : searchPlaceholders[view] || 'ابحث في الحركات…';
    $('listTitle').textContent = title;
    $('tableCaption').textContent = `${title} · ${isDemo() ? 'بيانات تجريبية' : 'قراءة فقط'}`;
    const row = element('tr');
    for (const name of columnNames(view)) { const heading = element('th', name); heading.scope = 'col'; row.append(heading); }
    $('tableHead').replaceChildren(row);
    $('tableBody').replaceChildren();
  }
  $('globalNotice').hidden = true;
  toggleMenu(false);
  loadView();
}

function setLoading(loading) {
  state.pending = loading;
  $('mainContent').setAttribute('aria-busy', String(loading));
  $('refreshButton').disabled = loading;
  $('tableStatus').hidden = !loading || state.view === 'overview';
  if (loading) {
    $('previousPage').disabled = true;
    $('nextPage').disabled = true;
  }
}

async function loadView({ preserveNotice = false } = {}) {
  if (!state.session) return;
  closeUserPunches();
  const view = state.view;
  const request = ++state.request;
  if (!preserveNotice) $('globalNotice').hidden = true;
  setLoading(true);
  try {
    if (view === 'overview') {
      const data = await api('/api/portal/overview');
      if (request !== state.request) return;
      updateCounts(data.counts || {});
      $('lastUpdated').textContent = dates.format(new Date());
    } else {
      const parameters = new URLSearchParams({ page: String(state.pages[view]), limit: '10', search: state.searches[view] });
      const roster = deviceRosters[view];
      const kind = deviceChangeKinds[view];
      if (roster) parameters.set('roster', roster);
      if (kind) parameters.set('kind', kind);
      if (view === 'received-punches' && state.deviceUserRowId) parameters.set('deviceUserRowId', state.deviceUserRowId);
      const resource = roster ? 'device-users' : kind ? 'device-user-changes' : view;
      const data = await api(`/api/portal/${resource}?${parameters}`);
      if (request !== state.request) return;
      state.list = data;
      renderList(view, data);
    }
  } catch (error) {
    if (request !== state.request || !state.session) return;
    showNotice(connectionError(error));
    if (view !== 'overview') {
      state.list = null;
      renderEmpty('تعذر تحميل البيانات', 'اضغط تحديث لإعادة المحاولة.');
      $('listTotal').textContent = 'البيانات غير متاحة حاليًا';
    }
  } finally {
    if (request === state.request) {
      setLoading(false);
      if (view !== 'overview') updatePagination(state.list?.page);
    }
  }
}

function updateCounts(counts) {
  for (const [name, stat, nav] of [['devices', 'statDevices', 'navDevicesCount'], ['people', 'statPeople', 'navPeopleCount'], ['events', 'statEvents', 'navEventsCount']]) {
    const value = Math.max(0, Number(counts[name]) || 0);
    $(stat).textContent = numbers.format(value);
    $(nav).textContent = numbers.format(value);
  }
  if (hasReceivedRecords()) {
    for (const [name, stat, nav] of [['received', 'statReceived', 'navReceivedCount'], ['deviceUsers', 'statDeviceUsers', 'navDeviceUsersCount']]) {
      const value = Math.max(0, Number(counts[name]) || 0);
      $(stat).textContent = numbers.format(value);
      $(nav).textContent = numbers.format(value);
    }
    setRosterCounts({ current: Number(counts.deviceUsers) || 0, historical: Number(counts.historicalDeviceUsers) || 0,
      all: counts.allDeviceUsers === undefined ? Number(counts.deviceUsers) || 0 : Number(counts.allDeviceUsers) });
  }
}

function setRosterCounts(counts) {
  if (!counts || !['current', 'historical', 'all'].every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0) || counts.current + counts.historical !== counts.all) return;
  $('statDeviceUsers').textContent = numbers.format(counts.current);
  $('navDeviceUsersCount').textContent = numbers.format(counts.current);
  $('navHistoricalDeviceUsersCount').textContent = numbers.format(counts.historical);
  $('statDeviceUsersRosterBreakdown').hidden = counts.historical === 0;
  $('statDeviceUsersRosterBreakdown').textContent = `تاريخيون محفوظون: ${numbers.format(counts.historical)} · جميع الهويات: ${numbers.format(counts.all)}`;
}

function renderEmpty(title = 'لا توجد نتائج', detail = 'جرّب البحث بكلمة أخرى أو امسح البحث لعرض القائمة.') {
  const row = element('tr');
  const cell = element('td', undefined, 'empty-cell');
  cell.colSpan = columnNames(state.view)?.length || 1;
  cell.append(element('strong', title), element('p', detail));
  row.append(cell);
  $('tableBody').replaceChildren(row);
}

function cell(row, text, className) {
  const node = element('td', text, className);
  row.append(node);
  return node;
}

function badge(text, className = 'badge-neutral') {
  return element('span', text, `badge ${className}`);
}

function localTime(value) {
  if (!value) return isDemo() ? 'لم يتم الاتصال' : 'لا توجد ملاحظة مسجلة';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'وقت غير متاح' : dates.format(date);
}

function devicePunchTime(item) {
  if (item.eventTimeLocal) return `وقت الجهاز: ${item.eventTimeLocal}`;
  const instant = new Date(item.eventTimeUtc ?? '');
  return Number.isNaN(instant.getTime()) ? 'وقت الجهاز غير متاح' : `وقت الرياض: ${dates.format(instant)}`;
}

function closeUserPunches() {
  const punches = state.userPunches;
  if (!punches) return;
  state.userPunches = null;
  punches.controller.abort();
  punches.button.setAttribute('aria-expanded', 'false');
  punches.button.removeAttribute('aria-controls');
  punches.detail.remove();
}

function appendDeviceUserName(row, item, view) {
  const name = item.displayName || 'بلا اسم';
  if (view !== 'device-users' || !hasDeviceUserPunches()) {
    cell(row, name, 'cell-primary');
    return;
  }
  const button = element('button', name, 'device-user-name');
  button.type = 'button';
  button.id = `user-name-${item.id}`;
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => {
    const wasOpen = state.userPunches?.button === button;
    closeUserPunches();
    if (!wasOpen && state.view === 'device-users' && !state.pending) openUserPunches(row, item.id, button);
  });
  cell(row, undefined, 'cell-primary').append(button);
}

function openUserPunches(row, identity, button) {
  const detail = element('tr', undefined, 'device-user-punch-detail');
  const wrapper = cell(detail);
  wrapper.colSpan = deviceUserColumns.length;
  const panel = element('div', undefined, 'device-user-punch-panel');
  panel.id = `user-punches-${identity}`;
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-labelledby', button.id);
  const status = element('p', undefined, 'device-user-punch-status');
  status.setAttribute('role', 'status');
  const table = element('table');
  table.hidden = true;
  const heading = element('thead');
  const headings = element('tr');
  for (const title of ['التاريخ والوقت', 'حالة الحركة']) {
    const header = element('th', title);
    header.scope = 'col';
    headings.append(header);
  }
  heading.append(headings);
  const body = element('tbody');
  table.append(heading, body);
  const more = element('button', 'تحميل المزيد', 'button button-secondary button-small');
  more.type = 'button';
  more.hidden = true;
  const punches = { identity, detail, panel, button, status, table, body, more, page: 0, loading: false, controller: new AbortController() };
  more.addEventListener('click', () => loadUserPunches(punches));
  panel.append(element('h3', 'الحركات المستلمة'), status, table, more);
  wrapper.append(panel);
  row.after(detail);
  button.setAttribute('aria-controls', panel.id);
  button.setAttribute('aria-expanded', 'true');
  state.userPunches = punches;
  loadUserPunches(punches);
}

async function loadUserPunches(punches) {
  if (state.userPunches !== punches || punches.loading) return;
  const { session } = state;
  const { identity, panel, table, body, status, more, controller } = punches;
  const next = punches.page + 1;
  punches.loading = true;
  panel.setAttribute('aria-busy', 'true');
  status.textContent = 'جارٍ تحميل الحركات…';
  more.disabled = true;
  try {
    const parameters = new URLSearchParams({ deviceUserRowId: identity, page: String(next), limit: '10' });
    const data = await api(`/api/portal/received-punches?${parameters}`, { signal: controller.signal });
    if (state.userPunches !== punches || state.session !== session) return;
    for (const item of data.items) {
      const row = element('tr');
      cell(row, devicePunchTime(item));
      const stateLabel = devicePunchStates.get(item.punchState)
        ?? (item.devicePunchState == null ? 'غير مسجلة' : `غير معروفة · الرمز ${item.devicePunchState}`);
      cell(row, stateLabel);
      body.append(row);
    }
    punches.page = next;
    if (data.items.length) table.hidden = false;
    status.textContent = table.hidden ? 'لا توجد حركات مستلمة لهذا المستخدم.' : '';
    more.textContent = 'تحميل المزيد';
    more.hidden = next >= data.page.totalPages;
  } catch (error) {
    if (state.userPunches !== punches || state.session !== session) return;
    status.textContent = connectionError(error);
    more.textContent = 'إعادة المحاولة';
    more.hidden = false;
  } finally {
    if (state.userPunches === punches) {
      panel.setAttribute('aria-busy', 'false');
      punches.loading = false;
      more.disabled = false;
    }
  }
}

function appendDeviceUserChanges(row, before, after) {
  const statuses = new Map([['active', 'نشط'], ['seen', 'حالي'], ['absent_from_device', 'تاريخي']]);
  const labels = { Pri: 'الصلاحية', Grp: 'المجموعة', TZ: 'المنطقة الزمنية', Verify: 'طريقة التحقق',
    StartDatetime: 'بداية الصلاحية', EndDatetime: 'نهاية الصلاحية' };
  const changes = [];
  if (before.displayName !== after.displayName) changes.push(['الاسم', before.displayName || 'بلا اسم', after.displayName || 'بلا اسم']);
  if (before.status !== after.status) changes.push(['الحالة', statuses.get(before.status) ?? 'غير معروف', statuses.get(after.status) ?? 'غير معروف']);
  for (const [field, label] of Object.entries(labels)) {
    const previous = before.metadata?.[field] ?? null;
    const next = after.metadata?.[field] ?? null;
    if (previous !== next) changes.push([label, previous ?? '—', next ?? '—']);
  }
  for (const index of [1, 2]) {
    const detail = cell(row);
    if (!changes.length) detail.textContent = '—';
    for (const change of changes) {
      const entry = element('span', undefined, 'cell-stack');
      entry.append(element('small', change[0], 'muted'), element('strong', change[index]));
      detail.append(entry);
    }
  }
}

function renderList(view, data) {
  $('tableBody').replaceChildren();
  const items = Array.isArray(data.items) ? data.items : [];
  const total = Math.max(0, Number(data.page?.total) || 0);
  const roster = deviceRosters[view];
  if (roster && data.rosterCounts) {
    setRosterCounts(data.rosterCounts);
  } else if (roster === 'current' && !state.searches[view]) {
    setRosterCounts({ current: total, historical: 0, all: total });
  } else if (roster) {
    $('navHistoricalDeviceUsersCount').textContent = numbers.format(0);
    $('statDeviceUsersRosterBreakdown').hidden = true;
  }
  const nouns = isDemo()
    ? { devices: 'جهاز تجريبي', people: 'شخص في مساحة التجربة', events: 'حركة تجريبية' }
    : { devices: 'جهاز مسجل', people: 'شخص مسجل', events: 'حركة نهائية', 'received-punches': 'سجل استقبال',
      'device-users': 'مستخدم جهاز', 'historical-device-users': 'مستخدم تاريخي',
      'new-device-users': 'إضافة مسجّلة', 'device-user-changes': 'تعديل مسجّل' };
  $('listTotal').textContent = `${numbers.format(total)} ${nouns[view]}`;
  if (!items.length) renderEmpty();
  for (const item of items) {
    const row = element('tr');
    if (view === 'devices') {
      cell(row, item.name || (isDemo() ? 'جهاز تجريبي' : 'جهاز مسجل'), 'cell-primary');
      cell(row, item.serialNumber || '—', 'cell-code');
      cell(row, item.model || '—');
      if (!isDemo()) {
        const statuses = { active: 'مفعّل', inactive: 'غير مفعّل' };
        cell(row).append(badge(statuses[item.administrativeStatus] || 'غير معروف'));
      }
      cell(row).append(badge(isDemo() ? 'غير متصل · تجريبي' : 'غير مؤكدة'));
      cell(row, localTime(item.lastSeenAt));
    } else if (view === 'people') {
      cell(row, item.displayName || '—', 'cell-primary');
      cell(row, item.personCode || '—', 'cell-code');
      cell(row).append(badge(item.status === 'active' ? (isDemo() ? 'نشط في التجربة' : 'نشط') : 'غير نشط', item.status === 'active' ? 'badge-success' : 'badge-neutral'));
    } else if (view === 'received-punches') {
      cell(row, item.deviceUserId || 'غير مقروء', 'cell-code');
      cell(row, item.eventTimeUtc ? localTime(item.eventTimeUtc) : item.eventTimeLocal ? `وقت الجهاز: ${item.eventTimeLocal}` : 'وقت الجهاز غير متاح');
      cell(row, item.deviceName || '—');
      const statuses = { pending: 'بانتظار المعالجة', processing: 'تجري المعالجة', processed: 'محفوظة', retry: 'إعادة محاولة', not_applicable: 'تحتاج مراجعة' };
      cell(row).append(badge(item.parseValid ? statuses[item.processingStatus] || 'تحتاج مراجعة' : 'صيغة غير معتمدة'));
      cell(row).append(badge(item.hasFinalEvent ? 'محفوظ' : 'لم يُنشأ', item.hasFinalEvent ? 'badge-success' : 'badge-neutral'));
    } else if (roster) {
      appendDeviceUserName(row, item, view);
      cell(row, item.deviceUserId || '—', 'cell-code');
      cell(row, item.deviceName || '—');
      cell(row).append(badge(item.status === 'absent_from_device' ? 'تاريخي · Historical' : 'حالي · Current',
        item.status === 'absent_from_device' ? 'badge-neutral' : 'badge-success'));
      cell(row, item.mappedPersonName || item.mappedPersonCode || 'غير مرتبط');
      cell(row, item.lastSeenAt ? localTime(item.lastSeenAt) : 'غير متاح');
      if (view === 'historical-device-users' && hasDeviceUserPunches()) {
        const open = element('button', 'عرض الحركات', 'button button-secondary button-small');
        open.type = 'button';
        open.setAttribute('aria-label', `عرض حركات الهوية التاريخية للرقم ${item.deviceUserId}`);
        open.addEventListener('click', () => { window.location.hash = `received-punches?deviceUserRowId=${encodeURIComponent(item.id)}`; });
        cell(row).append(open);
      }
    } else if (view === 'new-device-users') {
      cell(row, item.after.displayName ?? 'بلا اسم', 'cell-primary');
      cell(row, item.deviceUserId, 'cell-code');
      cell(row, item.deviceName);
      cell(row, localTime(item.occurredAt));
    } else if (view === 'device-user-changes') {
      cell(row, item.deviceUserId, 'cell-code');
      cell(row, item.deviceName);
      appendDeviceUserChanges(row, item.before, item.after);
      cell(row, localTime(item.occurredAt));
    } else {
      const person = cell(row);
      const stack = element('span', undefined, 'cell-stack');
      stack.append(element('strong', item.personName || item.personCode || '—', 'cell-primary'), element('small', item.personCode || '—', 'cell-code'));
      person.append(stack);
      const eventTypes = { check_in: 'دخول', check_out: 'خروج', break_in: 'عودة من استراحة', break_out: 'خروج لاستراحة', overtime_in: 'بداية إضافي', overtime_out: 'نهاية إضافي' };
      const entering = ['check_in', 'break_in', 'overtime_in'].includes(item.eventType);
      cell(row).append(badge(eventTypes[item.eventType] || (isDemo() ? 'حركة تجريبية' : 'غير معروف'), entering ? 'badge-check-in' : 'badge-check-out'));
      cell(row, item.eventTimeUtc ? localTime(item.eventTimeUtc) : 'وقت غير متاح');
      const methods = { face: 'الوجه', fingerprint: 'بصمة الإصبع', card: 'بطاقة', password: 'كلمة مرور', palm: 'راحة اليد' };
      cell(row, methods[item.verificationMethod] || (isDemo() ? 'مثال تجريبي' : 'غير معروف'));
      cell(row, item.deviceName || (isDemo() ? 'جهاز تجريبي' : '—'));
    }
    $('tableBody').append(row);
  }
  const nav = { devices: 'navDevicesCount', people: 'navPeopleCount', events: 'navEventsCount',
    'received-punches': 'navReceivedCount', 'device-users': 'navDeviceUsersCount',
    'historical-device-users': 'navHistoricalDeviceUsersCount', 'new-device-users': 'navNewDeviceUsersCount',
    'device-user-changes': 'navDeviceUserChangesCount' }[view];
  if (!state.searches[view] && !roster && !state.deviceUserRowId) $(nav).textContent = numbers.format(total);
  updatePagination(data.page);
}

function updatePagination(page) {
  const total = Math.max(0, Number(page?.total) || 0);
  const number = Math.max(1, Number(page?.number) || 1);
  const totalPages = Math.max(1, Number(page?.totalPages) || 1);
  const limit = Math.max(1, Number(page?.limit) || 10);
  const start = total ? (number - 1) * limit + 1 : 0;
  const end = Math.min(number * limit, total);
  $('pageSummary').textContent = `عرض ${numbers.format(start)}–${numbers.format(end)} من ${numbers.format(total)}`;
  $('pageNumber').textContent = numbers.format(number);
  $('previousPage').disabled = state.pending || !page || number <= 1;
  $('nextPage').disabled = state.pending || !page || number >= totalPages;
}

function closePersonDialog() { $('addPersonDialog').close(); }
function submitSearch() {
  if (state.view === 'overview') return;
  state.searches[state.view] = $('searchInput').value.trim();
  state.pages[state.view] = 1;
  state.list = null;
  loadView();
}

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => {
  const view = button.dataset.view;
  if (window.location.hash === `#${view}`) setView(view);
  else window.location.hash = view;
}));
window.addEventListener('hashchange', () => setView(viewFromHash()));
$('clearPunchIdentityFilter').addEventListener('click', () => { window.location.hash = 'received-punches'; });
$('refreshButton').addEventListener('click', () => state.session ? loadView() : initializeSession());
$('menuToggle').addEventListener('click', () => toggleMenu(!document.body.classList.contains('sidebar-open')));
$('sidebarBackdrop').addEventListener('click', () => toggleMenu(false));
document.addEventListener('keydown', event => { if (event.key === 'Escape') toggleMenu(false); });
$('searchForm').addEventListener('submit', event => { event.preventDefault(); clearTimeout(searchTimer); submitSearch(); });
$('searchInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(submitSearch, 350); });
for (const [button, delta] of [['previousPage', -1], ['nextPage', 1]]) {
  $(button).addEventListener('click', () => {
    if (state.pending || !state.list?.page) return;
    state.pages[state.view] = Math.max(1, Number(state.list.page.number) + delta);
    loadView();
  });
}
$('logoutButton').addEventListener('click', async () => {
  $('logoutButton').disabled = true;
  try { await api('/auth/logout', { method: 'POST', body: {} }); state.session = null; window.location.replace('/login'); }
  catch (error) { if (state.session) showNotice(connectionError(error)); }
  finally { $('logoutButton').disabled = false; }
});
$('addPersonButton').addEventListener('click', () => {
  if (!canCreatePerson()) return;
  $('addPersonForm').reset();
  $('personFormError').hidden = true;
  $('addPersonDialog').showModal();
  $('personCode').focus();
});
$('closePersonDialog').addEventListener('click', closePersonDialog);
$('cancelPersonDialog').addEventListener('click', closePersonDialog);
$('addPersonDialog').addEventListener('close', () => $('addPersonButton').focus());
$('addPersonDialog').addEventListener('click', event => { if (event.target === $('addPersonDialog')) { const box = event.target.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closePersonDialog(); } });
$('personCode').addEventListener('input', () => { $('personCode').value = $('personCode').value.toUpperCase(); });
$('addPersonForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!canCreatePerson() || $('savePersonButton').disabled || !$('addPersonForm').reportValidity()) return;
  $('savePersonButton').disabled = true;
  $('savePersonButton').textContent = 'جارٍ الإضافة…';
  $('personFormError').hidden = true;
  try {
    await api('/api/portal/people', { method: 'POST', body: { personCode: $('personCode').value.trim(), displayName: $('personName').value.trim() } });
    closePersonDialog();
    showNotice('أضيف الشخص إلى بيانات التجربة فقط. ستُمسح الإضافة عند إعادة تشغيل الخدمة.', 'success');
    state.list = null;
    await loadView({ preserveNotice: true });
  } catch (error) {
    $('personFormError').textContent = connectionError(error);
    $('personFormError').hidden = false;
  } finally {
    $('savePersonButton').disabled = false;
    $('savePersonButton').textContent = 'إضافة الشخص';
  }
});

async function initializeSession() {
  $('mainContent').setAttribute('aria-busy', 'true');
  $('refreshButton').disabled = true;
  try {
    state.session = await api('/auth/session');
    const user = state.session.user;
    $('accountName').textContent = user.username;
    $('accountRole').textContent = user.role === 'admin' ? 'مدير النظام' : 'عرض فقط';
    $('accountRole').parentElement.previousElementSibling.textContent = Array.from(user.username)[0]?.toUpperCase() || 'م';
    $('readOnlyBadge').hidden = user.role === 'admin' && isDemo();
    applyPortalMode();
    setView(viewFromHash());
  } catch (error) {
    setLoading(false);
    if (state.session) showNotice(connectionError(error));
    else if (!(error.message || '').includes('انتهت الجلسة')) showNotice(connectionError(error));
  }
}

if (['database-readonly', 'database-ingest'].includes(document.body.dataset.portalMode)) applyPortalMode();
initializeSession();
