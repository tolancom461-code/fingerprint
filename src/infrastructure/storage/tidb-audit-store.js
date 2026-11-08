import { BIOMETRIC_TABLES } from './biometric-table-names.js';

const T = BIOMETRIC_TABLES.auditLog;

export class TiDbAuditStore {
  constructor(pool) { this.pool = pool; }

  async append({ actorType, actorReference = null, actionType, entityType, entityId = null, beforeState = null, afterState = null, notes = null }) {
    const [result] = await this.pool.execute(
      `INSERT INTO \`${T}\` (
         actor_type, actor_reference, action_type, entity_type, entity_id,
         before_state, after_state, notes, occurred_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(6))`,
      [
        requiredText(actorType, 'actorType', 32), optionalText(actorReference, 128),
        requiredText(actionType, 'actionType', 64), requiredText(entityType, 'entityType', 64),
        entityId == null ? null : normalizeId(entityId, 'entityId'), jsonOrNull(beforeState),
        jsonOrNull(afterState), optionalText(notes, 1000)
      ]
    );
    return { id: result.insertId };
  }
}

function jsonOrNull(value) { return value == null ? null : JSON.stringify(value); }
function normalizeId(value, name) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError(`${name} must be a positive integer`);
  return id;
}
function requiredText(value, name, max) {
  const text = String(value ?? '').trim();
  if (!text) throw new TypeError(`${name} is required`);
  if (text.length > max) throw new TypeError(`${name} is too long`);
  return text;
}
function optionalText(value, max) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) throw new TypeError('text is too long');
  return text;
}
