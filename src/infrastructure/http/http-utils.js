export class BodyTooLargeError extends Error {}

export async function readBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new BodyTooLargeError(`Request body exceeded ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function discardBody(req, maxBytes) {
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new BodyTooLargeError(`Request body exceeded ${maxBytes} bytes`);
  }
  return size;
}

export function discardWithoutCapture(req) {
  req.on('error', () => {});
  req.resume();
}

export function safeHeaders(headers) {
  const allow = ['user-agent', 'content-type', 'content-length', 'connection', 'accept', 'host'];
  const output = {};
  for (const name of allow) {
    const value = headers[name];
    if (value != null) output[name] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return output;
}

export function text(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(body);
}
