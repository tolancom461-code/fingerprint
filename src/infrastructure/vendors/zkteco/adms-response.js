export function buildHandshakeResponse(serialNumber, profile) {
  // Intentionally centralized and provisional until validated against the real terminal/firmware.
  return [
    `GET OPTION FROM: ${serialNumber}`,
    'Stamp=0',
    'OpStamp=0',
    `ErrorDelay=${profile.errorDelaySeconds}`,
    `Delay=${profile.delaySeconds}`,
    'TransTimes=00:00;14:05',
    'TransInterval=1',
    'TransFlag=1111000000',
    `Realtime=${profile.realtime}`,
    `Encrypt=${profile.encrypt}`
  ].join('\n');
}

export function buildAttlogAck(acceptedCount) {
  return `OK: ${acceptedCount}`;
}
