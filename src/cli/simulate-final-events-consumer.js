import { loadConfig } from '../config/env.js';

const config = loadConfig(process.cwd());
if (!config.finalEventsApi.enabled) {
  console.error('Final Events API is disabled. Enable it before running the consumer simulator.');
  process.exitCode = 2;
} else {
  const baseUrl = `http://${config.finalEventsApi.host}:${config.finalEventsApi.port}`;
  const headers = { authorization: `Bearer ${config.finalEventsApi.token}` };
  const seen = new Set();

  const first = await consumeSnapshot({ baseUrl, headers, seen });
  const replay = await consumeSnapshot({ baseUrl, headers, seen, stopAfterId: first.lastAfterId });

  const result = {
    apiVersion: 'v1',
    firstPassFetched: first.fetched,
    firstPassUnique: first.newEvents,
    snapshotLastAfterId: first.lastAfterId,
    replayFetched: replay.fetched,
    replayNewEvents: replay.newEvents,
    replayDuplicatesSuppressed: replay.duplicates,
    idempotentReplay: replay.newEvents === 0
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.idempotentReplay) process.exitCode = 1;
}

async function consumeSnapshot({ baseUrl, headers, seen, stopAfterId = null }) {
  let afterId = '0';
  let fetched = 0;
  let newEvents = 0;
  let duplicates = 0;

  do {
    const response = await fetch(`${baseUrl}/api/v1/final-events?after_id=${encodeURIComponent(afterId)}&limit=500`, { headers });
    if (!response.ok) throw new Error(`Final Events API returned HTTP ${response.status}`);
    const page = await response.json();
    for (const event of page.items ?? []) {
      fetched += 1;
      if (seen.has(event.eventId)) duplicates += 1;
      else { seen.add(event.eventId); newEvents += 1; }
    }
    afterId = String(page.page?.nextAfterId ?? afterId);
    if (stopAfterId != null && BigInt(afterId) >= BigInt(stopAfterId)) break;
    if (!page.page?.hasMore) break;
  } while (true);

  return { fetched, newEvents, duplicates, lastAfterId: afterId };
}
