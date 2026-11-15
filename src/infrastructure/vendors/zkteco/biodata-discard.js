import { BodyTooLargeError } from '../../http/http-utils.js';

// Recognize the documented record envelope without collecting template data.
const recordHeader = /^BIODATA[ \t]+Pin=[0-9]{1,14}(?:[ \t]+(?:No|Index|Valid|Duress|Type|MajorVer|MinorVer|Format)=[0-9]{1,5})*[ \t]+Tmp=[A-Za-z0-9+/_-]/i;

export async function countDiscardedBiodata(req, maxBytes) {
  const header = Buffer.alloc(256);
  let bytes = 0;
  let headerLength = 0;
  let recordCount = 0;
  let invalid = false;

  function finishRecord() {
    if (headerLength !== 0 && !(headerLength === 1 && header[0] === 13)) {
      if (recordHeader.test(header.toString('latin1', 0, headerLength))) recordCount++;
      else invalid = true;
    }
    headerLength = 0;
  }

  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new BodyTooLargeError('BIODATA upload exceeded body limit');
      let start = 0;
      while (start < chunk.length) {
        const lf = chunk.indexOf(10, start);
        const end = lf < 0 ? chunk.length : lf;
        const headerBytes = Math.min(header.length - headerLength, end - start);
        if (headerBytes > 0) chunk.copy(header, headerLength, start, start + headerBytes);
        headerLength += headerBytes;
        if (lf < 0) break;
        finishRecord();
        start = lf + 1;
      }
    }
    finishRecord();
    return { bytes, recordCount: invalid ? 0 : recordCount };
  } finally {
    header.fill(0);
  }
}
