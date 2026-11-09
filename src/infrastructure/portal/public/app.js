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
  events: ['الحركات النهائية', 'الحركات النهائية المحفوظة، بتوقيت الرياض. لا تشمل الحركات المعلقة.']
};
const columns = {
  devices: ['الجهاز', 'الرقم التسلسلي', 'الطراز', 'حالة الاتصال', 'آخر اتصال'],
  people: ['الشخص', 'كود الشخص', 'الحالة'],
  events: ['الشخص', 'نوع الحركة', 'التوقيت · الرياض', 'طريقة التحقق', 'الجهاز']
};
const numbers = new Intl.NumberFormat('ar-SA');
const dates = new Intl.DateTimeFormat('ar-SA-u-ca-gregory', { timeZone: 'Asia/Riyadh', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const state = { session: null, view: 'overview', pending: false, request: 0, list: null, searches: { devices: '', people: '', events: '' }, pages: { devices: 1, people: 1, events: 1 } };
let searchTimer;

function isDemo() { return (state.session?.mode ?? document.body.dataset.portalMode) === 'demo'; }
function canCreatePerson() {
  return state.session?.capabilities?.createPerson === true && state.session?.user.role === 'admin' && state.session?.mode === 'demo';
}
function columnNames(view) {
  return view === 'devices' && !isDemo()
    ? ['الجهاز', 'الرقم التسلسلي', 'الطراز', 'الحالة الإدارية', 'حالة الاتصال', 'آخر ملاحظة'] : columns[view];
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
  const init = { ...options, headers, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) };
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
  const view = window.location.hash.slice(1);
  return Object.hasOwn(descriptions, view) ? view : 'overview';
}

function toggleMenu(open) {
  document.body.classList.toggle('sidebar-open', open);
  $('sidebarBackdrop').hidden = !open;
  $('menuToggle').setAttribute('aria-expanded', String(open));
  $('menuToggle').setAttribute('aria-label', open ? 'إغلاق القائمة الرئيسية' : 'فتح القائمة الرئيسية');
}

function setView(view) {
  if (!Object.hasOwn(descriptions, view)) return;
  clearTimeout(searchTimer);
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
  $('addPersonButton').hidden = view !== 'people' || !canCreatePerson();
  if (view !== 'overview') {
    $('searchInput').value = state.searches[view];
    $('searchInput').placeholder = view === 'people' ? 'ابحث بالاسم أو الكود…' : view === 'devices' ? 'ابحث باسم الجهاز أو رقمه…' : 'ابحث في الحركات…';
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
      const data = await api(`/api/portal/${view}?${parameters}`);
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

function renderList(view, data) {
  $('tableBody').replaceChildren();
  const items = Array.isArray(data.items) ? data.items : [];
  const total = Math.max(0, Number(data.page?.total) || 0);
  const nouns = isDemo()
    ? { devices: 'جهاز تجريبي', people: 'شخص في مساحة التجربة', events: 'حركة تجريبية' }
    : { devices: 'جهاز مسجل', people: 'شخص مسجل', events: 'حركة نهائية' };
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
  const nav = { devices: 'navDevicesCount', people: 'navPeopleCount', events: 'navEventsCount' }[view];
  if (!state.searches[view]) $(nav).textContent = numbers.format(total);
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
  if (window.location.hash === `#${view}` || view === state.view) setView(view);
  else window.location.hash = view;
}));
window.addEventListener('hashchange', () => setView(viewFromHash()));
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

if (document.body.dataset.portalMode === 'database-readonly') applyPortalMode();
initializeSession();
