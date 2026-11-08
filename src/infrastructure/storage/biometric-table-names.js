export const BIOMETRIC_TABLES = Object.freeze({
  devices: 'biometric_svc_devices',
  ingestEvents: 'biometric_svc_ingest_events',
  eventProcessing: 'biometric_svc_event_processing',
  punches: 'biometric_svc_punches',
  deviceUsers: 'biometric_svc_device_users',
  people: 'biometric_svc_people',
  personDeviceUsers: 'biometric_svc_person_device_users',
  finalEvents: 'biometric_svc_final_events',
  finalizationIssues: 'biometric_svc_finalization_issues',
  auditLog: 'biometric_svc_audit_log'
});

export const REQUIRED_BIOMETRIC_COLUMNS = Object.freeze({
  [BIOMETRIC_TABLES.devices]: Object.freeze([
    'id', 'vendor', 'serial_number', 'display_name', 'manufacturer', 'model', 'protocol',
    'adapter_type', 'mode', 'status', 'timezone', 'accept_events_from', 'firmware_version',
    'platform', 'oem_vendor', 'first_seen_at', 'last_seen_at', 'last_event_at',
    'last_ip_address', 'safe_capabilities', 'notes', 'created_at', 'updated_at'
  ]),
  [BIOMETRIC_TABLES.ingestEvents]: Object.freeze([
    'id', 'ingest_key', 'storage_identity_version', 'device_id', 'vendor', 'serial_number',
    'event_family', 'vendor_event_type', 'vendor_event_id', 'dedupe_key', 'dedupe_strategy',
    'dedupe_version', 'wire_hash', 'capture_id', 'capture_index', 'adapter_version',
    'parser_version', 'parse_valid', 'safe_to_acknowledge', 'unsafe_reason', 'source_bytes',
    'source_field_count', 'payload_schema_version', 'safe_payload', 'source_ip',
    'received_at', 'created_at'
  ]),
  [BIOMETRIC_TABLES.eventProcessing]: Object.freeze([
    'ingest_event_id', 'status', 'attempt_count', 'next_attempt_at', 'last_attempt_at',
    'lease_owner', 'lease_token', 'lease_expires_at', 'last_error_code', 'last_error_message',
    'processed_at', 'created_at', 'updated_at'
  ]),
  [BIOMETRIC_TABLES.punches]: Object.freeze([
    'id', 'ingest_event_id', 'event_key', 'event_key_strategy', 'event_key_version',
    'vendor_dedupe_key', 'vendor_dedupe_strategy', 'vendor_dedupe_version', 'device_id',
    'vendor', 'serial_number', 'device_user_id', 'device_event_time_raw',
    'device_event_time_local', 'device_timezone', 'device_event_time_utc', 'raw_status',
    'punch_state', 'raw_verify', 'verification_method', 'work_code',
    'canonical_schema_version', 'vendor_metadata', 'wire_hash', 'parser_version',
    'received_at', 'created_at'
  ]),
  [BIOMETRIC_TABLES.deviceUsers]: Object.freeze([
    'id', 'device_id', 'device_user_id', 'display_name', 'status', 'metadata_schema_version',
    'safe_metadata', 'first_seen_at', 'last_seen_at', 'created_at', 'updated_at'
  ]),
  [BIOMETRIC_TABLES.people]: Object.freeze([
    'id', 'person_code', 'display_name', 'status', 'notes', 'created_at', 'updated_at'
  ]),
  [BIOMETRIC_TABLES.personDeviceUsers]: Object.freeze([
    'id', 'person_id', 'device_user_row_id', 'status', 'active_from', 'active_to',
    'created_at', 'updated_at'
  ]),
  [BIOMETRIC_TABLES.finalEvents]: Object.freeze([
    'id', 'final_event_uuid', 'person_id', 'person_code', 'source_punch_id', 'device_id',
    'device_reference', 'event_type', 'event_time_local', 'event_timezone', 'event_time_utc',
    'verification_method', 'finalization_version', 'status', 'safe_metadata', 'finalized_at',
    'created_at'
  ]),
  [BIOMETRIC_TABLES.finalizationIssues]: Object.freeze([
    'id', 'source_punch_id', 'issue_type', 'status', 'details', 'first_seen_at', 'last_seen_at',
    'resolved_at', 'resolution_note', 'created_at', 'updated_at'
  ]),
  [BIOMETRIC_TABLES.auditLog]: Object.freeze([
    'id', 'actor_type', 'actor_reference', 'action_type', 'entity_type', 'entity_id',
    'before_state', 'after_state', 'notes', 'occurred_at', 'created_at'
  ])
});


export const REQUIRED_BIOMETRIC_UNIQUE_INDEXES = Object.freeze({
  [BIOMETRIC_TABLES.devices]: Object.freeze({
    uq_biometric_svc_devices_vendor_serial: Object.freeze(['vendor', 'serial_number'])
  }),
  [BIOMETRIC_TABLES.ingestEvents]: Object.freeze({
    uq_biometric_svc_ingest_key: Object.freeze(['ingest_key']),
    uq_biometric_svc_ingest_vendor_identity: Object.freeze(['device_id', 'dedupe_strategy', 'dedupe_version', 'dedupe_key'])
  }),
  [BIOMETRIC_TABLES.eventProcessing]: Object.freeze({
    PRIMARY: Object.freeze(['ingest_event_id'])
  }),
  [BIOMETRIC_TABLES.punches]: Object.freeze({
    uq_biometric_svc_punch_ingest: Object.freeze(['ingest_event_id']),
    uq_biometric_svc_punch_event: Object.freeze(['event_key'])
  }),
  [BIOMETRIC_TABLES.deviceUsers]: Object.freeze({
    uq_biometric_svc_device_user: Object.freeze(['device_id', 'device_user_id'])
  }),
  [BIOMETRIC_TABLES.people]: Object.freeze({
    uq_biometric_svc_people_person_code: Object.freeze(['person_code'])
  }),
  [BIOMETRIC_TABLES.personDeviceUsers]: Object.freeze({
    uq_biometric_svc_person_device_users_device_user: Object.freeze(['device_user_row_id'])
  }),
  [BIOMETRIC_TABLES.finalEvents]: Object.freeze({
    uq_biometric_svc_final_events_uuid: Object.freeze(['final_event_uuid']),
    uq_biometric_svc_final_events_source_version: Object.freeze(['source_punch_id', 'finalization_version'])
  }),
  [BIOMETRIC_TABLES.finalizationIssues]: Object.freeze({
    uq_biometric_svc_finalization_issues_source_type: Object.freeze(['source_punch_id', 'issue_type'])
  })
});
