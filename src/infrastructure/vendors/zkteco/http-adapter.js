import {
  looksLikeBiometricTemplateTable,
  parseAdmsRequestUrl,
  parseAttlogBody
} from './adms-parser.js';
import { buildAttlogAck, buildHandshakeResponse } from './adms-response.js';
import { observeDeviceOptionsBody, toZktecoDeviceMetadata } from './device-options.js';
import { observeOperlogBody } from './operlog-observer.js';
import { createZktecoAttlogObservations } from './attlog-observation.js';
import { evaluateDeviceRequestPolicy } from '../../../domain/device-policy.js';
import {
  discardBody,
  discardWithoutCapture,
  readBody,
  safeHeaders,
  text
} from '../../http/http-utils.js';

const VENDOR = 'zkteco';
const PARSER_VERSION = 'zkteco-attlog-observer-v6';

export class ZktecoAdmsAdapter {
  constructor({ config, deviceRegistry, receivePunchBatch, diagnosticLog, deviceStore = null }) {
    this.vendor = VENDOR;
    this.config = config;
    this.deviceRegistry = deviceRegistry;
    this.receivePunchBatch = receivePunchBatch;
    this.diagnosticLog = diagnosticLog;
    this.deviceStore = deviceStore;
  }

  matches(req) {
    const url = new URL(req.url || '/', 'http://biometric.local');
    return url.pathname.startsWith('/iclock/');
  }

  async handle(req, res) {
    const request = parseAdmsRequestUrl(req.url || '/');
    const remoteAddress = req.socket.remoteAddress || null;
    const device = { vendor: VENDOR, serialNumber: request.serialNumber };

    // Fail closed before any ADMS body is buffered or interpreted.
    if (!request.serialNumber) {
      discardWithoutCapture(req);
      return text(res, 400, 'ERROR: missing SN');
    }
    if (!this.deviceRegistry.isAllowed(device)) {
      discardWithoutCapture(req);
      await this.diagnosticLog.write({
        type: 'device_rejected',
        vendor: VENDOR,
        serialNumber: request.serialNumber,
        method: req.method,
        pathname: request.pathname,
        remoteAddress,
        occurredAt: new Date().toISOString()
      });
      return text(res, 403, 'DENIED');
    }

    const requestObservedAt = new Date().toISOString();
    if (this.deviceStore) {
      const storedDevice = await this.deviceStore.observe({
        device,
        remoteAddress,
        observedAt: toSqlDateTime(requestObservedAt)
      });
      const policy = evaluateDeviceRequestPolicy(storedDevice);
      if (!policy.allowed) {
        discardWithoutCapture(req);
        await this.diagnosticLog.write({
          type: 'device_policy_rejected',
          vendor: VENDOR,
          serialNumber: request.serialNumber,
          reason: policy.reason,
          remoteAddress,
          occurredAt: new Date().toISOString()
        });
        return text(res, 403, 'DENIED');
      }
    }

    await this.diagnosticLog.write({
      type: 'device_request',
      vendor: VENDOR,
      serialNumber: request.serialNumber,
      method: req.method,
      pathname: request.pathname,
      table: request.table || null,
      query: request.query,
      headers: safeHeaders(req.headers),
      remoteAddress,
      occurredAt: new Date().toISOString()
    });

    if (req.method === 'GET' && request.pathname === '/iclock/cdata') {
      return text(res, 200, buildHandshakeResponse(request.serialNumber, this.config.adms));
    }

    if (req.method === 'POST' && request.pathname === '/iclock/cdata') {
      if (request.table === 'OPTIONS') {
        const body = await readBody(req, Math.min(this.config.maxBodyBytes, 64 * 1024));
        const observation = observeDeviceOptionsBody(body);
        if (this.deviceStore) {
          await this.deviceStore.observe({
            device,
            remoteAddress,
            observedAt: toSqlDateTime(new Date().toISOString()),
            metadata: toZktecoDeviceMetadata(observation.fields)
          });
        }
        await this.diagnosticLog.write({
          type: 'device_options_observed',
          vendor: VENDOR,
          serialNumber: request.serialNumber,
          ...observation,
          remoteAddress,
          occurredAt: new Date().toISOString()
        });

        // OPTIONS is control-plane negotiation, not an attendance event.
        // Once it has been sanitized and logged successfully, acknowledge it so
        // the terminal can continue its protocol flow. This is intentionally
        // independent from the ATTLOG acknowledgement policy.
        return text(res, 200, 'OK');
      }

      if (request.table === 'OPERLOG') {
        const body = await readBody(req, this.config.maxBodyBytes);
        const observation = observeOperlogBody(body);
        if (this.deviceStore && observation.safeToAcknowledge) {
          await this.deviceStore.upsertSafeUsers({
            device,
            records: observation.records,
            observedAt: toSqlDateTime(new Date().toISOString())
          });
        }
        await this.diagnosticLog.write({
          type: 'device_operlog_observed',
          vendor: VENDOR,
          serialNumber: request.serialNumber,
          ...observation,
          remoteAddress,
          occurredAt: new Date().toISOString()
        });

        // OPERLOG can contain user profile changes and biometric templates.
        // We acknowledge only when every record was recognized and sensitive
        // biometric/credential values were discarded before persistence.
        if (observation.safeToAcknowledge) return text(res, 200, 'OK');
        return text(res, 503, 'OPERLOG_OBSERVED_NOT_ACKNOWLEDGED');
      }

      if (request.table === 'ATTLOG') {
        const body = await readBody(req, this.config.maxBodyBytes);
        const parsedLines = parseAttlogBody(body);
        const observations = createZktecoAttlogObservations({
          device,
          parsedLines,
          parserVersion: PARSER_VERSION
        });
        const result = await this.receivePunchBatch.execute({
          device,
          observations,
          remoteAddress
        });

        if (!result.allowed) return text(res, 403, 'DENIED');
        if (this.config.attlogAckMode === 'ack' && result.safeToAcknowledge) {
          return text(res, 200, buildAttlogAck(result.parsedCount));
        }
        return text(res, 503, result.safeToAcknowledge ? 'OBSERVED_NOT_ACKNOWLEDGED' : 'UNSAFE_ATTLOG_NOT_ACKNOWLEDGED');
      }

      const bytes = await discardBody(req, this.config.maxBodyBytes);
      await this.diagnosticLog.write({
        type: looksLikeBiometricTemplateTable(request.table)
          ? 'biometric_payload_discarded'
          : 'unsupported_cdata_discarded',
        vendor: VENDOR,
        serialNumber: request.serialNumber,
        table: request.table || null,
        bytes,
        remoteAddress,
        occurredAt: new Date().toISOString()
      });

      // Unsupported/template tables are never acknowledged implicitly by
      // ATTLOG mode. Each table needs an explicit safe handler before ACK.
      return text(res, 503, 'DISCARDED_NOT_ACKNOWLEDGED');
    }

    if (req.method === 'GET' && request.pathname === '/iclock/getrequest') {
      return text(res, 200, 'OK');
    }

    if (req.method === 'POST' && request.pathname === '/iclock/devicecmd') {
      const bytes = await discardBody(req, this.config.maxBodyBytes);
      await this.diagnosticLog.write({
        type: 'devicecmd_result_observed',
        vendor: VENDOR,
        serialNumber: request.serialNumber,
        bytes,
        remoteAddress,
        occurredAt: new Date().toISOString()
      });
      return text(res, 200, 'OK');
    }

    return text(res, 404, 'NOT_FOUND');
  }
}


function toSqlDateTime(value) {
  return new Date(value).toISOString().replace('T', ' ').replace('Z', '');
}
