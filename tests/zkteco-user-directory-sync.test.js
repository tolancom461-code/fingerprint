import assert from 'node:assert/strict';
import test from 'node:test';
import { createZktecoUserDirectorySync } from '../src/infrastructure/vendors/zkteco/user-directory-sync.js';
import { observeOperlogBody } from '../src/infrastructure/vendors/zkteco/operlog-observer.js';

const device = { vendor: 'zkteco', serialNumber: 'ROSTER_FIXTURE' };
const other = { vendor: 'zkteco', serialNumber: 'OTHER' };

function fixture(mode = 'active') {
  let timestamp = Date.parse('2026-11-15T13:00:00Z');
  let nextId = 100;
  const commits = [];
  const logs = [];
  const sync = createZktecoUserDirectorySync({ deviceKey: 'zkteco:ROSTER_FIXTURE', mode,
    now: () => timestamp, commandId: () => String(++nextId), write: async event => { logs.push(event); },
    async onComplete(roster) { commits.push(roster); return { addedCount: 1 }; } });
  const count = (id, count, givenDevice = device) => sync.observeReply(givenDevice,
    `ID=${id}&Return=0&CMD=INFO\nMaxUserCount=10000\nUserCount=${count}`);
  const profiles = body => sync.observeProfile(device, body, observeOperlogBody(body));
  return { sync, commits, logs, count, profiles, tick: milliseconds => { timestamp += milliseconds; } };
}

test('observe mode checks a correlated device count and leaves USER storage enabled', async () => {
  const { sync, commits, logs, count } = fixture('observe');
  assert.equal(await sync.takeCommand(other), null);
  assert.equal(sync.ownsProfiles(device), false);
  assert.equal(await sync.takeCommand(device), 'C:101:INFO\n');
  await count(88, 9);
  await count(101, 9, other);
  assert.equal(logs.length, 1);
  await count(101, 173);
  assert.deepEqual(logs.at(-1), { type: 'user_directory_sync_count_verified', recordCount: 173 });
  assert.equal(await sync.takeCommand(device), null);
  assert.deepEqual(commits, []);
});

test('active mode brackets a complete roster with counts and excludes sensitive profile fields', async () => {
  const { sync, commits, count, profiles, tick } = fixture();
  assert.equal(sync.ownsProfiles(device), true);
  assert.equal(sync.ownsProfiles(other), false);
  assert.equal(await sync.takeCommand(device), 'C:101:INFO\n');
  await count(101, 2);
  assert.equal(await sync.takeCommand(device), 'C:102:DATA QUERY USERINFO\n');
  tick(1000);
  profiles('USER PIN=1\tName=New Person\tGrp=7\tPasswd=secret\tCard=012\nUSER PIN=8\tPri=0');
  assert.equal(await sync.takeCommand(device), null);
  tick(15000);
  assert.equal(await sync.takeCommand(device), 'C:103:INFO\n');
  assert.equal(commits.length, 0);
  await count(103, 2);
  await count(103, 2);
  assert.deepEqual(commits, [{ device, userCount: 2, observedAtUtc: '2026-11-15T13:00:01.000Z', profiles: [
    { deviceUserId: '1', nameReported: true, displayName: 'New Person', metadata: { Grp: '7' } },
    { deviceUserId: '8', nameReported: false, displayName: null, metadata: { Pri: '0' } }
  ] }]);
});

test('a partial list, duplicated count, conflicts, explicit failure or changing count never commits', async t => {
  await t.test('partial list expires', async () => {
    const { sync, commits, count, profiles, tick } = fixture();
    await sync.takeCommand(device);
    await count(101, 2);
    await sync.takeCommand(device);
    profiles('USER PIN=1\tName=One');
    tick(300000);
    assert.equal(await sync.takeCommand(device), null);
    assert.equal(commits.length, 0);
  });
  await t.test('duplicate count field is unusable', async () => {
    const { sync, commits, logs } = fixture();
    await sync.takeCommand(device);
    await sync.observeReply(device, 'ID=101&Return=0&CMD=INFO\nUserCount=1\n~USERCOUNT=1');
    assert.equal(logs.at(-1).type, 'user_directory_sync_count_unavailable');
    assert.equal(commits.length, 0);
  });
  await t.test('conflicting profile is unusable', async () => {
    const { sync, commits, count, profiles, tick } = fixture();
    await sync.takeCommand(device);
    await count(101, 1);
    await sync.takeCommand(device);
    profiles('USER PIN=1\tName=One\nUSER PIN=1\tName=Different');
    tick(15000);
    assert.equal(await sync.takeCommand(device), null);
    assert.equal(commits.length, 0);
  });
  await t.test('explicit command rejection cancels the cycle', async () => {
    const { sync, commits, count, profiles, tick } = fixture();
    await sync.takeCommand(device);
    await count(101, 1);
    await sync.takeCommand(device);
    profiles('USER PIN=1\tName=One');
    await sync.observeReply(device, 'ID=102&Return=-10&CMD=DATA');
    tick(15000);
    assert.equal(await sync.takeCommand(device), null);
    assert.equal(commits.length, 0);
  });
  await t.test('different count invalidates otherwise complete list', async () => {
    const { sync, commits, count, profiles, tick } = fixture();
    await sync.takeCommand(device);
    await count(101, 1);
    await sync.takeCommand(device);
    profiles('USER PIN=1\tName=One');
    tick(15000);
    assert.equal(await sync.takeCommand(device), 'C:103:INFO\n');
    await count(103, 2);
    assert.equal(commits.length, 0);
  });
});
