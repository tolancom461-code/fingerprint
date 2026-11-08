import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_JSON_BYTES = 32 * 1024;

export function createAdminServer({ adminService, diagnosticLog }) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      setSecurityHeaders(res);

      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/api/overview') {
        return json(res, 200, await adminService.overview());
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        return json(res, 200, await adminService.listEvents(readFilters(url)));
      }
      if (req.method === 'GET' && url.pathname === '/api/events/export.csv') {
        const rows = await adminService.exportEvents(readFilters(url));
        return csv(res, rows, url.searchParams.get('lang') === 'en' ? 'en' : 'ar');
      }
      const eventMatch = url.pathname.match(/^\/api\/events\/([0-9A-Fa-f-]+)$/);
      if (req.method === 'GET' && eventMatch) {
        const event = await adminService.getEvent(eventMatch[1]);
        if (!event) return json(res, 404, { error: 'EVENT_NOT_FOUND', message: 'Final event not found' });
        return json(res, 200, { event });
      }

      const historicalPreviewMatch = url.pathname.match(/^\/api\/people\/(\d+)\/historical-events\/preview$/);
      if (req.method === 'GET' && historicalPreviewMatch) {
        return json(res, 200, await adminService.previewHistoricalEvents({
          personId: Number(historicalPreviewMatch[1]),
          from: url.searchParams.get('from'),
          to: url.searchParams.get('to')
        }));
      }

      if (req.method === 'GET' && url.pathname === '/api/people') {
        return json(res, 200, await adminService.listPeople(readFilters(url)));
      }
      if (req.method === 'GET' && url.pathname === '/api/unmapped-device-users') {
        return json(res, 200, await adminService.listUnmappedDeviceUsers(readFilters(url)));
      }
      if (req.method === 'GET' && url.pathname === '/api/issues') {
        return json(res, 200, await adminService.listIssues(readFilters(url)));
      }
      if (req.method === 'GET' && url.pathname === '/api/devices') {
        return json(res, 200, await adminService.listDevices(readFilters(url)));
      }
      if (req.method === 'GET' && url.pathname === '/api/reports/operational') {
        return json(res, 200, await adminService.operationalReports(readFilters(url)));
      }


      const historicalReprocessMatch = url.pathname.match(/^\/api\/people\/(\d+)\/historical-events\/reprocess$/);
      if (req.method === 'POST' && historicalReprocessMatch) {
        enforceLocalUiWrite(req);
        const body = await readJson(req);
        const result = await adminService.reprocessHistoricalEvents({
          personId: Number(historicalReprocessMatch[1]),
          from: body.from,
          to: body.to,
          confirmed: body.confirmed === true
        });
        return json(res, 200, result);
      }

      if (req.method === 'POST' && url.pathname === '/api/people') {
        enforceLocalUiWrite(req);
        const body = await readJson(req);
        const person = await adminService.createPerson({
          personCode: body.personCode,
          displayName: body.displayName,
          notes: body.notes ?? null
        });
        return json(res, 201, { person });
      }

      const onboardMatch = url.pathname.match(/^\/api\/device-users\/(\d+)\/onboard$/);
      if (req.method === 'POST' && onboardMatch) {
        enforceLocalUiWrite(req);
        const body = await readJson(req);
        const result = await adminService.onboardDeviceUser({
          deviceUserRowId: Number(onboardMatch[1]),
          displayName: body.displayName ?? null
        });
        return json(res, 200, result);
      }

      const mapMatch = url.pathname.match(/^\/api\/device-users\/(\d+)\/map$/);
      if (req.method === 'POST' && mapMatch) {
        enforceLocalUiWrite(req);
        const body = await readJson(req);
        const result = await adminService.mapDeviceUser({
          deviceUserRowId: Number(mapMatch[1]),
          personId: body.personId
        });
        return json(res, 200, result);
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return file(res, path.join(publicDir, 'index.html'), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/app.js') {
        return file(res, path.join(publicDir, 'app.js'), 'text/javascript; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/styles.css') {
        return file(res, path.join(publicDir, 'styles.css'), 'text/css; charset=utf-8');
      }

      return json(res, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      const status = httpStatus(error);
      try {
        await diagnosticLog?.write?.({
          type: 'admin_request_error',
          errorCode: error?.code ?? 'ADMIN_ERROR',
          message: error instanceof Error ? error.message : String(error),
          occurredAt: new Date().toISOString()
        });
      } catch {
        // The admin response must not fail because diagnostic logging failed.
      }
      return json(res, status, {
        error: error?.code ?? 'ADMIN_ERROR',
        message: safeMessage(error)
      });
    }
  });
}

function readFilters(url) {
  const get = (name) => url.searchParams.get(name) ?? undefined;
  return {
    page: get('page'),
    limit: get('limit'),
    search: get('search'),
    from: get('from'),
    to: get('to'),
    eventType: get('event_type'),
    verificationMethod: get('verification_method'),
    deviceId: get('device_id'),
    status: get('status'),
    mapping: get('mapping'),
    issueType: get('issue_type'),
    mode: get('mode'),
    vendor: get('vendor')
  };
}

function enforceLocalUiWrite(req) {
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  if (!contentType.startsWith('application/json')) throw codedError('JSON_REQUIRED', 'JSON request required');
  if (req.headers['x-biometric-admin'] !== 'local-ui') throw codedError('LOCAL_UI_HEADER_REQUIRED', 'Local admin UI request required');
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw codedError('ADMIN_BODY_TOO_LARGE', 'Request is too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw codedError('INVALID_JSON', 'Invalid JSON');
  }
}

async function file(res, filename, contentType) {
  const body = await fs.readFile(filename);
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-store'
  });
  res.end(body);
}

function csv(res, rows, language) {
  const ar = language === 'ar';
  const headers = ar
    ? ['معرف الحركة', 'رقم الشخص', 'الاسم', 'الحركة', 'الوقت المحلي', 'المنطقة الزمنية', 'الوقت UTC', 'الجهاز', 'التحقق', 'الحالة']
    : ['Event ID', 'Person Code', 'Name', 'Event', 'Local Time', 'Timezone', 'UTC Time', 'Device', 'Verification', 'Status'];
  const values = (rows ?? []).map((row) => [
    row.final_event_uuid,
    row.person_code,
    row.person_name ?? '',
    row.event_type,
    row.event_time_local,
    row.event_timezone,
    row.event_time_utc,
    row.device_display_name || row.device_model || '',
    row.verification_method ?? '',
    row.status
  ]);
  const body = Buffer.from(`\uFEFF${[headers, ...values].map((line) => line.map(csvCell).join(',')).join('\r\n')}\r\n`, 'utf8');
  const day = new Date().toISOString().slice(0, 10);
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-length': body.length,
    'content-disposition': `attachment; filename="biometric-final-events-${day}.csv"`,
    'cache-control': 'no-store',
    'x-export-limit': '10000'
  });
  res.end(body);
}

function csvCell(value) {
  let text = String(value ?? '');
  // Prevent spreadsheet formula execution when exported user/device text is opened in Excel.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store'
  });
  res.end(body);
}

function setSecurityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
}

function httpStatus(error) {
  if (error?.code === 'PERSON_NOT_FOUND' || error?.code === 'DEVICE_USER_NOT_FOUND') return 404;
  if (['PERSON_CODE_CONFLICT', 'DEVICE_USER_MAPPING_CONFLICT', 'PERSON_INACTIVE', 'HISTORICAL_REPLAY_LIMIT', 'HISTORICAL_REPLAY_CHANGED'].includes(error?.code)) return 409;
  if (['DISPLAY_NAME_REQUIRED', 'JSON_REQUIRED', 'LOCAL_UI_HEADER_REQUIRED', 'INVALID_JSON',
    'HISTORICAL_CONFIRMATION_REQUIRED', 'HISTORICAL_RANGE_REQUIRED', 'HISTORICAL_RANGE_INVALID', 'HISTORICAL_RANGE_TOO_LARGE'].includes(error?.code)) return 400;
  if (error?.code === 'ADMIN_BODY_TOO_LARGE') return 413;
  if (error instanceof TypeError) return 400;
  return 500;
}

function safeMessage(error) {
  const known = new Set([
    'PERSON_NOT_FOUND', 'DEVICE_USER_NOT_FOUND', 'PERSON_CODE_CONFLICT',
    'DEVICE_USER_MAPPING_CONFLICT', 'PERSON_INACTIVE', 'DISPLAY_NAME_REQUIRED',
    'JSON_REQUIRED', 'LOCAL_UI_HEADER_REQUIRED', 'INVALID_JSON', 'ADMIN_BODY_TOO_LARGE',
    'HISTORICAL_CONFIRMATION_REQUIRED', 'HISTORICAL_RANGE_REQUIRED', 'HISTORICAL_RANGE_INVALID',
    'HISTORICAL_RANGE_TOO_LARGE', 'HISTORICAL_REPLAY_LIMIT', 'HISTORICAL_REPLAY_CHANGED'
  ]);
  if (known.has(error?.code) || error instanceof TypeError) return error.message;
  return 'حدث خطأ غير متوقع';
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
