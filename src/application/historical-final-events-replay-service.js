import { randomUUID } from 'node:crypto';
import { HISTORICAL_REPLAY_VERSION_PREFIX, HISTORICAL_REPLAY_LIMIT, HISTORICAL_REPLAY_MAX_DAYS } from '../domain/historical-replay.js';

export class HistoricalFinalEventsReplayService {
  constructor({ replayStore, uuidFactory = randomUUID, nowFactory = () => new Date() }) {
    this.replayStore = replayStore;
    this.uuidFactory = uuidFactory;
    this.nowFactory = nowFactory;
  }

  async preview({ personId, from, to }) {
    const person = await this.#activePerson(personId);
    const range = normalizeRange(from, to);
    const summary = await this.replayStore.summarizeOriginalFinalEvents({
      personId: person.id,
      from: range.from,
      toExclusive: range.toExclusive
    });
    return publicPreview(person, range, summary);
  }

  async reprocess({ personId, from, to, confirmed = false, actor = localAdminActor() }) {
    if (confirmed !== true) throw codedError('HISTORICAL_CONFIRMATION_REQUIRED', 'Explicit confirmation is required');

    const person = await this.#activePerson(personId);
    const range = normalizeRange(from, to);
    const summary = await this.replayStore.summarizeOriginalFinalEvents({
      personId: person.id,
      from: range.from,
      toExclusive: range.toExclusive
    });
    const count = Number(summary?.count ?? 0);
    if (count > HISTORICAL_REPLAY_LIMIT) {
      throw codedError('HISTORICAL_REPLAY_LIMIT', `Select a smaller period; at most ${HISTORICAL_REPLAY_LIMIT} events can be reprocessed at once`);
    }
    if (count === 0) {
      return {
        person: safePerson(person),
        range: { from: range.from, to: range.to },
        candidateCount: 0,
        reissuedCount: 0,
        batchReference: null
      };
    }

    const originals = await this.replayStore.listOriginalFinalEvents({
      personId: person.id,
      from: range.from,
      toExclusive: range.toExclusive,
      limit: HISTORICAL_REPLAY_LIMIT
    });
    if (originals.length !== count) {
      throw codedError('HISTORICAL_REPLAY_CHANGED', 'Historical event set changed; preview again before reprocessing');
    }

    const batchReference = this.uuidFactory();
    const finalizationVersion = historicalVersion(this.nowFactory(), batchReference);
    const events = originals.map((row) => ({
      finalEventUuid: this.uuidFactory(),
      personId: Number(row.person_id),
      personCode: String(row.person_code),
      sourcePunchId: Number(row.source_punch_id),
      deviceId: Number(row.device_id),
      deviceReference: String(row.device_reference),
      eventType: String(row.event_type),
      eventTimeLocal: row.event_time_local,
      eventTimezone: String(row.event_timezone),
      eventTimeUtc: row.event_time_utc,
      verificationMethod: row.verification_method == null ? null : String(row.verification_method),
      finalizationVersion,
      safeMetadata: {
        historicalReplay: {
          kind: 'manual_historical_reprocess',
          batchReference,
          originalFinalEventUuid: String(row.final_event_uuid),
          requestedFrom: range.from,
          requestedTo: range.to
        }
      }
    }));

    const result = await this.replayStore.reissueFinalEvents({
      events,
      auditEntry: {
        actorType: actor.actorType,
        actorReference: actor.actorReference ?? null,
        actionType: 'historical_final_events_reissued',
        entityType: 'person',
        entityId: person.id,
        beforeState: null,
        afterState: {
          personCode: person.person_code,
          from: range.from,
          to: range.to,
          candidateCount: count,
          reissuedCount: events.length,
          batchReference
        },
        notes: 'Manual historical biometric event reprocessing from local admin UI'
      }
    });

    return {
      person: safePerson(person),
      range: { from: range.from, to: range.to },
      candidateCount: count,
      reissuedCount: Number(result?.reissuedCount ?? events.length),
      batchReference
    };
  }

  async #activePerson(personId) {
    const id = normalizeId(personId, 'personId');
    const person = await this.replayStore.getPersonById(id);
    if (!person) throw codedError('PERSON_NOT_FOUND', 'Person not found');
    if (String(person.status ?? '').toLowerCase() !== 'active') throw codedError('PERSON_INACTIVE', 'Person is inactive');
    return person;
  }
}

function normalizeRange(from, to) {
  const start = isoDay(from, 'from');
  const end = isoDay(to, 'to');
  if (!start || !end) throw codedError('HISTORICAL_RANGE_REQUIRED', 'Both from and to dates are required');
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
    throw codedError('HISTORICAL_RANGE_INVALID', 'Historical date range is invalid');
  }
  const days = Math.floor((endMs - startMs) / 86400000) + 1;
  if (days > HISTORICAL_REPLAY_MAX_DAYS) {
    throw codedError('HISTORICAL_RANGE_TOO_LARGE', `Historical date range cannot exceed ${HISTORICAL_REPLAY_MAX_DAYS} days`);
  }
  const next = new Date(endMs + 86400000);
  return { from: start, to: end, toExclusive: next.toISOString().slice(0, 10) };
}

function isoDay(value, name) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw codedError('HISTORICAL_RANGE_INVALID', `${name} must use YYYY-MM-DD`);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw codedError('HISTORICAL_RANGE_INVALID', `${name} is not a valid date`);
  }
  return text;
}

function publicPreview(person, range, summary) {
  return {
    person: safePerson(person),
    range: { from: range.from, to: range.to },
    count: Number(summary?.count ?? 0),
    earliestEventTimeLocal: summary?.earliest_event_time_local ?? null,
    latestEventTimeLocal: summary?.latest_event_time_local ?? null,
    limit: HISTORICAL_REPLAY_LIMIT,
    maxDays: HISTORICAL_REPLAY_MAX_DAYS
  };
}

function safePerson(person) {
  return {
    id: Number(person.id),
    personCode: String(person.person_code),
    displayName: String(person.display_name),
    status: String(person.status)
  };
}

function historicalVersion(now, batchReference) {
  const stamp = new Date(now).toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const token = String(batchReference).replaceAll('-', '').slice(0, 8).toLowerCase();
  return `${HISTORICAL_REPLAY_VERSION_PREFIX}${stamp}-${token}`;
}

function normalizeId(value, name) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError(`${name} must be a positive integer`);
  return id;
}

function localAdminActor() { return { actorType: 'admin', actorReference: 'local-ui' }; }
function codedError(code, message) { const error = new Error(message); error.code = code; return error; }
