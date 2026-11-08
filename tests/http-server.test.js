import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpServer } from '../src/infrastructure/http/server.js';
import { EnvDeviceRegistry } from '../src/infrastructure/storage/env-device-registry.js';
import { ReceivePunchBatch } from '../src/application/receive-punch-batch.js';
import { VendorAdapterRegistry } from '../src/infrastructure/vendors/vendor-adapter-registry.js';
import { ZktecoAdmsAdapter } from '../src/infrastructure/vendors/zkteco/http-adapter.js';

class MemoryIngestStore {
  constructor() { this.items = new Map(); }
  async putIfAbsent(item) {
    const existing = this.items.get(item.dedupeKey);
    if (existing) return { status: 'duplicate', record: existing };
    this.items.set(item.dedupeKey, item);
    return { status: 'inserted', record: item };
  }
}
class MemoryPunchStore {
  constructor() { this.keys = new Set(); this.items = []; }
  async putIfAbsent(item) {
    if (this.keys.has(item.eventKey)) return { status: 'duplicate' };
    this.keys.add(item.eventKey); this.items.push(item); return { status: 'inserted' };
  }
}
class MemoryLog { constructor() { this.items = []; } async write(item) { this.items.push(item); } }

async function start(attlogAckMode = 'observe', maxBodyBytes = 512 * 1024, allowed = ['zkteco:KNOWN'], deviceStore = null) {
  const deviceRegistry = new EnvDeviceRegistry(allowed);
  const ingestStore = new MemoryIngestStore();
  const store = new MemoryPunchStore();
  const log = new MemoryLog();
  const receivePunchBatch = new ReceivePunchBatch({ deviceRegistry, ingestStore, punchStore: store, diagnosticLog: log });
  const config = {
    attlogAckMode,
    maxBodyBytes,
    adms: { errorDelaySeconds: 60, delaySeconds: 10, realtime: 1, encrypt: 0 }
  };
  const zkteco = new ZktecoAdmsAdapter({ config, deviceRegistry, receivePunchBatch, diagnosticLog: log, deviceStore });
  const adapterRegistry = new VendorAdapterRegistry([zkteco]);
  const server = createHttpServer({ adapterRegistry, diagnosticLog: log });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, ingestStore, store, log, base: `http://127.0.0.1:${address.port}` };
}

test('health endpoint is independent of device authorization', async (t) => {
  const lab = await start();
  t.after(() => lab.server.close());
  const response = await fetch(`${lab.base}/health`);
  assert.equal(response.status, 200);
});

test('unknown terminal is denied at handshake', async (t) => {
  const lab = await start();
  t.after(() => lab.server.close());
  const response = await fetch(`${lab.base}/iclock/cdata?SN=UNKNOWN&options=all`);
  assert.equal(response.status, 403);
});

test('unknown terminal is denied before a template payload can be processed', async (t) => {
  const lab = await start();
  t.after(() => lab.server.close());
  const secretTemplate = 'DO_NOT_STORE_TEMPLATE_BYTES';
  const response = await fetch(`${lab.base}/iclock/cdata?SN=UNKNOWN&table=BIODATA`, {
    method: 'POST', body: secretTemplate
  });
  assert.equal(response.status, 403);
  assert.equal(lab.store.items.length, 0);
  assert.equal(JSON.stringify(lab.log.items).includes(secretTemplate), false);
});

test('authorized GET cdata returns isolated ADMS handshake profile', async (t) => {
  const lab = await start();
  t.after(() => lab.server.close());
  const response = await fetch(`${lab.base}/iclock/cdata?sn=KNOWN&options=all&FWVersion=TESTFW`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /GET OPTION FROM: KNOWN/);
  assert.match(body, /Realtime=1/);
});

test('observation mode captures ATTLOG but does not acknowledge acceptance', async (t) => {
  const lab = await start('observe');
  t.after(() => lab.server.close());
  const response = await fetch(`${lab.base}/iclock/cdata?SN=KNOWN&table=ATTLOG`, {
    method: 'POST',
    body: '125\t2026-08-23 08:01:30\t0\t1'
  });
  assert.equal(response.status, 503);
  assert.equal(lab.store.items.length, 1);
  assert.equal(lab.store.items[0].vendor, 'zkteco');
  assert.equal(lab.store.items[0].rawStatus, '0');
});

test('two allow-listed ZKTeco devices can use the same service independently', async (t) => {
  const lab = await start('observe', 512 * 1024, ['zkteco:DEVICE-A', 'zkteco:DEVICE-B']);
  t.after(() => lab.server.close());
  const payload = '125\t2026-08-23 08:01:30\t0\t1';

  const [a, b] = await Promise.all([
    fetch(`${lab.base}/iclock/cdata?SN=DEVICE-A&table=ATTLOG`, { method: 'POST', body: payload }),
    fetch(`${lab.base}/iclock/cdata?SN=DEVICE-B&table=ATTLOG`, { method: 'POST', body: payload })
  ]);

  assert.equal(a.status, 503);
  assert.equal(b.status, 503);
  assert.equal(lab.store.items.length, 2);
  assert.deepEqual(new Set(lab.store.items.map((item) => item.deviceKey)), new Set(['zkteco:DEVICE-A', 'zkteco:DEVICE-B']));
});

test('ack mode acknowledges only after ATTLOG capture path succeeds', async (t) => {
  const lab = await start('ack');
  t.after(() => lab.server.close());
  const response = await fetch(`${lab.base}/iclock/cdata?SN=KNOWN&table=ATTLOG`, {
    method: 'POST', body: '125\t2026-08-23 08:01:30\t0\t1'
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'OK: 1');
  assert.equal(lab.store.items.length, 1);
});

test('authorized template-like payload content is discarded and not acknowledged in observe mode', async (t) => {
  const lab = await start('observe');
  t.after(() => lab.server.close());
  const secretTemplate = 'DO_NOT_STORE_TEMPLATE_BYTES';
  const response = await fetch(`${lab.base}/iclock/cdata?SN=KNOWN&table=BIODATA`, {
    method: 'POST', body: secretTemplate
  });
  assert.equal(response.status, 503);
  assert.equal(lab.store.items.length, 0);
  assert.equal(JSON.stringify(lab.log.items).includes(secretTemplate), false);
});

test('all operational iclock endpoints require an allow-listed serial', async (t) => {
  const lab = await start();
  t.after(() => lab.server.close());
  const getRequest = await fetch(`${lab.base}/iclock/getrequest?SN=UNKNOWN`);
  assert.equal(getRequest.status, 403);
  const deviceCmd = await fetch(`${lab.base}/iclock/devicecmd?SN=UNKNOWN`, { method: 'POST', body: 'x' });
  assert.equal(deviceCmd.status, 403);
});

test('oversized ATTLOG body is rejected', async (t) => {
  const lab = await start('observe', 1024);
  t.after(() => lab.server.close());
  const response = await fetch(`${lab.base}/iclock/cdata?SN=KNOWN&table=ATTLOG`, {
    method: 'POST', body: 'x'.repeat(2048)
  });
  assert.equal(response.status, 413);
  assert.equal(lab.store.items.length, 0);
});


test('authorized OPTIONS profile is sanitized, observed, and acknowledged independently from ATTLOG mode', async (t) => {
  const lab = await start('observe');
  t.after(() => lab.server.close());
  const secret = 'DO_NOT_PERSIST_ME';
  const body = `~SerialNumber=KNOWN,PushVersion=2.4.1,FirmwareVersion=FW-TEST,CommKey=${secret},FPData=${secret}`;
  const response = await fetch(`${lab.base}/iclock/cdata?SN=KNOWN&table=OPTIONS`, {
    method: 'POST', body
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'OK');
  const observed = lab.log.items.find((item) => item.type === 'device_options_observed');
  assert.ok(observed);
  assert.equal(observed.fields.PushVersion, '2.4.1');
  assert.equal(observed.fields.FirmwareVersion, 'FW-TEST');
  assert.equal(observed.fields.CommKey, '[REDACTED]');
  assert.equal(observed.fields.FPData, '[REDACTED]');
  assert.equal(JSON.stringify(lab.log.items).includes(secret), false);
  assert.equal(lab.store.items.length, 0);
});



test('acknowledging OPTIONS does not implicitly acknowledge a later ATTLOG', async (t) => {
  const lab = await start('observe');
  t.after(() => lab.server.close());

  const options = await fetch(`${lab.base}/iclock/cdata?SN=KNOWN&table=OPTIONS`, {
    method: 'POST',
    body: '~SerialNumber=KNOWN,DeviceName=SpeedFace-V5L,PushVersion=2.4.1'
  });
  assert.equal(options.status, 200);
  assert.equal(await options.text(), 'OK');

  const attlog = await fetch(`${lab.base}/iclock/cdata?SN=KNOWN&table=ATTLOG`, {
    method: 'POST',
    body: '900001\t2026-08-29 15:10:00\t0\t1'
  });
  assert.equal(attlog.status, 503);
  assert.equal(lab.store.items.length, 1);
  assert.equal(lab.store.items[0].deviceUserId, '900001');
});

test('OPTIONS body for an unknown terminal is rejected before observation', async (t) => {
  const lab = await start('observe');
  t.after(() => lab.server.close());
  const response = await fetch(`${lab.base}/iclock/cdata?SN=UNKNOWN&table=OPTIONS`, {
    method: 'POST', body: '~SerialNumber=UNKNOWN,FirmwareVersion=SHOULD_NOT_BE_PARSED'
  });
  assert.equal(response.status, 403);
  assert.equal(lab.log.items.some((item) => item.type === 'device_options_observed'), false);
});

test('authorized OPERLOG is sanitized and acknowledged while ATTLOG remains observe-only', async (t) => {
  const lab = await start('observe');
  t.after(() => lab.server.close());
  const secretTemplate = 'SECRET_FP_TEMPLATE_ABC123';
  const operlogBody = [
    'USER PIN=900001\tName=TEST\tPri=0\tPasswd=hiddenpass\tCard=998877\tGrp=1\tTZ=',
    `FP PIN=900001\tFID=1\tSize=${secretTemplate.length}\tValid=1\tTMP=${secretTemplate}`
  ].join('\n');

  const operlog = await fetch(`${lab.base}/iclock/cdata?SN=KNOWN&table=OPERLOG&OpStamp=9999`, {
    method: 'POST', body: operlogBody
  });
  assert.equal(operlog.status, 200);
  assert.equal(await operlog.text(), 'OK');

  const observed = lab.log.items.find((item) => item.type === 'device_operlog_observed');
  assert.ok(observed);
  assert.equal(observed.safeToAcknowledge, true);
  assert.equal(observed.records[0].fields.PIN, '900001');
  assert.equal(observed.records[0].fields.Passwd, '[REDACTED]');
  assert.equal(observed.records[1].templateDiscarded, true);
  assert.equal(JSON.stringify(lab.log.items).includes(secretTemplate), false);
  assert.equal(JSON.stringify(lab.log.items).includes('hiddenpass'), false);
  assert.equal(JSON.stringify(lab.log.items).includes('998877'), false);

  const attlog = await fetch(`${lab.base}/iclock/cdata?SN=KNOWN&table=ATTLOG`, {
    method: 'POST', body: '900001\t2026-08-29 15:20:00\t0\t1'
  });
  assert.equal(attlog.status, 503);
  assert.equal(lab.store.items.length, 1);
});

test('unknown OPERLOG shape is observed without raw content and is not acknowledged', async (t) => {
  const lab = await start('observe');
  t.after(() => lab.server.close());
  const unknownSensitiveText = 'UNKNOWN_PRIVATE_PAYLOAD_SHOULD_NOT_BE_PERSISTED';
  const response = await fetch(`${lab.base}/iclock/cdata?SN=KNOWN&table=OPERLOG&OpStamp=9999`, {
    method: 'POST', body: `NEWKIND ${unknownSensitiveText}`
  });
  assert.equal(response.status, 503);
  const observed = lab.log.items.find((item) => item.type === 'device_operlog_observed');
  assert.ok(observed);
  assert.equal(observed.safeToAcknowledge, false);
  assert.equal(JSON.stringify(lab.log.items).includes(unknownSensitiveText), false);
});

test('OPERLOG from an unknown terminal is rejected before parsing sensitive body', async (t) => {
  const lab = await start('observe');
  t.after(() => lab.server.close());
  const secretTemplate = 'DO_NOT_PARSE_THIS_FP_TEMPLATE';
  const response = await fetch(`${lab.base}/iclock/cdata?SN=UNKNOWN&table=OPERLOG`, {
    method: 'POST', body: `FP PIN=1\tFID=1\tTMP=${secretTemplate}`
  });
  assert.equal(response.status, 403);
  assert.equal(lab.log.items.some((item) => item.type === 'device_operlog_observed'), false);
  assert.equal(JSON.stringify(lab.log.items).includes(secretTemplate), false);
});

test('ATTLOG ack mode never implicitly acknowledges unsupported or template cdata tables', async (t) => {
  const lab = await start('ack');
  t.after(() => lab.server.close());

  const template = await fetch(`${lab.base}/iclock/cdata?SN=KNOWN&table=BIODATA`, {
    method: 'POST', body: 'SENSITIVE_TEMPLATE_BYTES'
  });
  assert.equal(template.status, 503);

  const unsupported = await fetch(`${lab.base}/iclock/cdata?SN=KNOWN&table=SOMENEWTABLE`, {
    method: 'POST', body: 'UNKNOWN_DATA'
  });
  assert.equal(unsupported.status, 503);
});

test('ack mode refuses an unrecognized ATTLOG shape even after safe metadata capture', async (t) => {
  const lab = await start('ack');
  t.after(() => lab.server.close());
  const secret = 'UNKNOWN_PRIVATE_ATTLOG_CONTENT';
  const response = await fetch(`${lab.base}/iclock/cdata?SN=KNOWN&table=ATTLOG`, {
    method: 'POST', body: secret
  });
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'UNSAFE_ATTLOG_NOT_ACKNOWLEDGED');
  assert.equal(lab.store.items.length, 0);
  assert.equal(lab.ingestStore.items.size, 1);
  assert.equal(JSON.stringify([...lab.ingestStore.items.values()]).includes(secret), false);
});


test('database device mode policy fails closed before ATTLOG body processing', async (t) => {
  const deviceStore = {
    async observe() { return { id: 7, status: 'active', mode: 'paused', timezone: 'Asia/Riyadh', accept_events_from: null }; }
  };
  const lab = await start('ack', 512 * 1024, ['zkteco:KNOWN'], deviceStore);
  t.after(() => lab.server.close());
  const response = await fetch(`${lab.base}/iclock/cdata?SN=KNOWN&table=ATTLOG`, {
    method: 'POST', body: '900001\t2026-08-30 16:00:00\t0\t1'
  });
  assert.equal(response.status, 403);
  assert.equal(lab.ingestStore.items.size, 0);
  assert.equal(lab.log.items.some((item) => item.type === 'device_policy_rejected' && item.reason === 'mode:paused'), true);
});
