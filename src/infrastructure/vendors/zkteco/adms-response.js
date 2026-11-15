const DEFAULT_TRANSFER_FLAGS = '1111000000';
const ATTENDANCE_AND_OPERATIONS_FLAGS = '1100000000';
// ZKTeco Attendance PUSH SDK initialization options, named transfer format.
const USER_PROFILE_TRANSFER_FLAGS = 'TransData AttLog\tOpLog\tEnrollUser\tChgUser';

export function buildHandshakeResponse(serialNumber, profile, { requestUserProfiles = false, directoryPreview = false } = {}) {
  // Intentionally centralized and provisional until validated against the real terminal/firmware.
  const transferFlags = directoryPreview === true ? ATTENDANCE_AND_OPERATIONS_FLAGS
    : requestUserProfiles === true ? USER_PROFILE_TRANSFER_FLAGS : DEFAULT_TRANSFER_FLAGS;
  return [
    `GET OPTION FROM: ${serialNumber}`,
    'Stamp=0',
    'OpStamp=0',
    `ErrorDelay=${profile.errorDelaySeconds}`,
    `Delay=${profile.delaySeconds}`,
    'TransTimes=00:00;14:05',
    'TransInterval=1',
    `TransFlag=${transferFlags}`,
    `Realtime=${profile.realtime}`,
    `Encrypt=${profile.encrypt}`
  ].join('\n');
}

export function buildAttlogAck(acceptedCount) {
  return `OK: ${acceptedCount}`;
}
