const DEFAULT_TRANSFER_FLAGS = '1111000000';
// ZKTeco Attendance PUSH SDK initialization options, named transfer format.
const USER_PROFILE_TRANSFER_FLAGS = 'TransData AttLog\tOpLog\tEnrollUser\tChgUser';

export function buildHandshakeResponse(serialNumber, profile, { requestUserProfiles = false } = {}) {
  // Intentionally centralized and provisional until validated against the real terminal/firmware.
  return [
    `GET OPTION FROM: ${serialNumber}`,
    'Stamp=0',
    'OpStamp=0',
    `ErrorDelay=${profile.errorDelaySeconds}`,
    `Delay=${profile.delaySeconds}`,
    'TransTimes=00:00;14:05',
    'TransInterval=1',
    `TransFlag=${requestUserProfiles === true ? USER_PROFILE_TRANSFER_FLAGS : DEFAULT_TRANSFER_FLAGS}`,
    `Realtime=${profile.realtime}`,
    `Encrypt=${profile.encrypt}`
  ].join('\n');
}

export function buildAttlogAck(acceptedCount) {
  return `OK: ${acceptedCount}`;
}
