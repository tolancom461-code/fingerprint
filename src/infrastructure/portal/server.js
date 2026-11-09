import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagingPortalConfig } from '../../config/staging-portal.js';
import { createPortalAuth } from './auth.js';
import { createDemoPortalService } from '../../application/demo-portal-service.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const assets = new Map([
  ['/portal.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/portal-login.js', ['login.js', 'text/javascript; charset=utf-8']],
  ['/portal-app.js', ['app.js', 'text/javascript; charset=utf-8']]
]);

export function createStagingPortalHandler({ env, runtime }) {
  const config = stagingPortalConfig(env, runtime);
  if (!config) return null;
  const auth = createPortalAuth(config);
  const service = createDemoPortalService();
  const expectedHost = new URL(config.origin).host.toLowerCase();
  const secure = config.origin.startsWith('https:');

  return async function portalHandler(req, res) {
    const url = new URL(req.url || '/', config.origin);
    const pathname = url.pathname;
    const matches = ['/', '/index.html', '/login'].includes(pathname) || assets.has(pathname) ||
      pathname.startsWith('/auth/') || pathname.startsWith('/api/portal/');
    if (!matches) return false;
    headers(res, secure);
    try {
      if (String(req.headers.host ?? '').toLowerCase() !== expectedHost) {
        throw coded('HOST_MISMATCH', 'عنوان الخدمة غير مطابق لإعداد البوابة', 421);
      }
      if (req.method === 'GET' && assets.has(pathname)) {
        const [filename, contentType] = assets.get(pathname);
        await file(res, filename, contentType);
        return true;
      }
      const session = auth.session(req);
      if (req.method === 'GET' && pathname === '/login') {
        if (session) redirect(res, '/');
        else await file(res, 'login.html', 'text/html; charset=utf-8');
        return true;
      }
      if (req.method === 'GET' && ['/', '/index.html'].includes(pathname)) {
        if (!session) redirect(res, '/login');
        else await file(res, 'index.html', 'text/html; charset=utf-8');
        return true;
      }
      if (req.method === 'POST' && pathname === '/auth/login') {
        auth.assertOrigin(req);
        const body = await readJson(req);
        json(res, 200, { ...await auth.login(req, res, body), mode: 'demo' });
        return true;
      }
      if (req.method === 'GET' && pathname === '/auth/session') {
        requireSession(session);
        json(res, 200, { ...session, mode: 'demo' });
        return true;
      }
      if (req.method === 'POST' && pathname === '/auth/logout') {
        auth.logout(req, res);
        json(res, 200, { ok: true });
        return true;
      }
      if (pathname.startsWith('/api/portal/')) {
        requireSession(session);
        const filters = Object.fromEntries(['search', 'page', 'limit'].map(key => [key, url.searchParams.get(key) ?? undefined]));
        if (req.method === 'GET') {
          const reads = new Map([
            ['/api/portal/overview', () => service.overview()],
            ['/api/portal/devices', () => service.listDevices(filters)],
            ['/api/portal/people', () => service.listPeople(filters)],
            ['/api/portal/events', () => service.listEvents(filters)]
          ]);
          if (reads.has(pathname)) {
            json(res, 200, await reads.get(pathname)());
            return true;
          }
        }
        if (req.method === 'POST' && pathname === '/api/portal/people') {
          auth.requireWrite(req, session);
          if (session.user.role !== 'admin') throw coded('FORBIDDEN', 'هذا الحساب مخصص للعرض فقط', 403);
          const body = await readJson(req);
          json(res, 201, { person: await service.createPerson({ personCode: body.personCode, displayName: body.displayName }) });
          return true;
        }
      }
      json(res, 404, { error: 'NOT_FOUND', message: 'المسار غير موجود' });
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) {
        const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
        if (status === 408 || status === 413) res.setHeader('Connection', 'close');
        json(res, status, { error: status === 500 ? 'INTERNAL_ERROR' : (error.code || 'INVALID_REQUEST'),
          message: message(error, status) });
      }
    }
    return true;
  };
}

function requireSession(session) {
  if (!session) throw coded('UNAUTHENTICATED', 'يرجى تسجيل الدخول', 401);
}

function headers(res, secure) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}

async function file(res, filename, contentType) {
  const body = await fs.readFile(path.join(publicDir, filename));
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length });
  res.end(body);
}

function redirect(res, location) { res.writeHead(302, { Location: location }); res.end(); }

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] ?? ''))) {
    throw coded('JSON_REQUIRED', 'المطلوب طلب JSON', 400);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => finish(coded('REQUEST_TIMEOUT', 'انتهت مهلة الطلب', 408)), 5000);
    timer.unref();
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > 4096) return finish(coded('BODY_TOO_LARGE', 'حجم الطلب أكبر من المسموح', 413));
      chunks.push(chunk);
    };
    const onEnd = () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return finish(coded('INVALID_JSON', 'صيغة الطلب غير صحيحة', 400)); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return finish(coded('INVALID_JSON', 'صيغة الطلب غير صحيحة', 400));
      finish(null, body);
    };
    const onError = () => finish(coded('INVALID_REQUEST', 'تعذر قراءة الطلب', 400));
    function finish(error, body) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onError);
      if (error) { req.resume(); reject(error); }
      else resolve(body);
    }
    req.on('data', onData); req.on('end', onEnd); req.on('error', onError); req.on('aborted', onError);
  });
}

function message(error, status) {
  if (status === 500) return 'تعذر إتمام الطلب';
  if (status === 401) return error.code === 'UNAUTHENTICATED' ? 'يرجى تسجيل الدخول' : 'اسم المستخدم أو كلمة المرور غير صحيحة';
  if (status === 429) return 'محاولات كثيرة، انتظر قليلًا ثم أعد المحاولة';
  if (['HOST_MISMATCH', 'FORBIDDEN', 'JSON_REQUIRED', 'BODY_TOO_LARGE', 'INVALID_JSON'].includes(error.code)) return error.message;
  if (status === 403) return 'تعذر التحقق من الطلب، حدّث الصفحة وأعد المحاولة';
  if (status === 409) return 'رمز الشخص التجريبي موجود مسبقًا أو تم بلوغ الحد التجريبي';
  return 'تحقق من القيم المدخلة';
}

function coded(code, text, status) { const error = new Error(text); error.code = code; error.status = status; return error; }
