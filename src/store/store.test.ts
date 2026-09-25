/* The store against a map for a disk. What matters is what is never lost: a
 * record that cannot be read is never written over, a renamed file keeps its
 * assumptions, and a deleted file's assumptions wait for it. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { kindOf, parseRecord, recordNameFor, isStale, isUnfinished, type Assumption } from './format';
import { memoryAdapter } from './memory';
import { AssumptionStore } from './store';

const A = 'file:///ws/a.ts';
const B = 'file:///ws/b.ts';

function assumption(id: string, over: Partial<Assumption> = {}): Assumption {
  return {
    id,
    from: 0,
    to: 5,
    quote: 'const',
    claim: 'Declares a constant.',
    verdict: null,
    note: '',
    checkedQuote: null,
    ...over,
  };
}

function pathOf(uri: string): string {
  return `assumptions/${recordNameFor(uri)}`;
}

test('saved assumptions load back', async () => {
  const store = new AssumptionStore(memoryAdapter());
  await store.save(A, [assumption('a1')]);
  assert.deepEqual(await store.load(A), [assumption('a1')]);
});

test('a queued write is what the next load sees, before it reaches disk', async () => {
  const disk = memoryAdapter();
  const store = new AssumptionStore(disk, 60_000);
  store.queue(A, [assumption('a1')]);
  assert.equal(disk.files.size, 0);
  assert.deepEqual(await store.load(A), [assumption('a1')]);
  await store.flush();
  assert.equal(disk.files.size, 1);
});

test('saving nothing removes the record rather than keeping an empty one', async () => {
  const disk = memoryAdapter();
  const store = new AssumptionStore(disk);
  await store.save(A, [assumption('a1')]);
  await store.save(A, []);
  assert.equal(disk.files.size, 0);
});

test('an unreadable record is reported and never written over', async () => {
  const disk = memoryAdapter();
  disk.files.set(pathOf(A), '{ not json');
  const store = new AssumptionStore(disk);
  assert.deepEqual(await store.load(A), []);
  assert.match(store.whyUnreadable(A)!, /not valid JSON/);
  await store.save(A, [assumption('a1')]);
  assert.equal(disk.files.get(pathOf(A)), '{ not json');
});

test('a record from a newer build is refused, not reinterpreted', () => {
  const result = parseRecord(JSON.stringify({ v: 2, uri: A, assumptions: [] }), A);
  assert.equal(result.kind, 'unreadable');
});

test('a record filed under another file is refused', () => {
  const result = parseRecord(JSON.stringify({ v: 1, uri: B, assumptions: [] }), A);
  assert.equal(result.kind, 'unreadable');
});

test('a scratch note round-trips, and a record without kinds reads as assumptions', async () => {
  const store = new AssumptionStore(memoryAdapter());
  await store.save(A, [assumption('a1'), assumption('n1', { kind: 'scratch' })]);
  assert.deepEqual((await store.load(A)).map(kindOf), ['assumption', 'scratch']);
});

test('a note title round-trips, and a title that is not text is refused', async () => {
  const store = new AssumptionStore(memoryAdapter());
  await store.save(A, [assumption('n1', { kind: 'scratch', title: 'Heap order' })]);
  assert.equal((await store.load(A))[0]?.title, 'Heap order');
  const bad = parseRecord(JSON.stringify({ v: 1, uri: A, assumptions: [assumption('n2', { title: 3 as unknown as string })] }), A);
  assert.equal(bad.kind, 'unreadable');
});

test('an entry of a kind this build does not know is refused, not reinterpreted', () => {
  const result = parseRecord(JSON.stringify({ v: 1, uri: A, assumptions: [assumption('x1', { kind: 'todo' as 'scratch' })] }), A);
  assert.equal(result.kind, 'unreadable');
});

test('loadAll finds every record and reports the bad ones', async () => {
  const disk = memoryAdapter();
  const store = new AssumptionStore(disk);
  await store.save(A, [assumption('a1')]);
  await store.save(B, [assumption('b1')]);
  disk.files.set('assumptions/0000000000000000.json', 'garbage');
  const { records, unreadable } = await store.loadAll();
  assert.deepEqual(records.map((r) => r.uri).sort(), [A, B]);
  assert.equal(unreadable.length, 1);
});

test('a rename moves the record and says where it now belongs', async () => {
  const disk = memoryAdapter();
  const store = new AssumptionStore(disk);
  await store.save(A, [assumption('a1')]);
  await store.handleRename(A, B);
  assert.deepEqual(await store.load(A), []);
  assert.deepEqual(await store.load(B), [assumption('a1')]);
  assert.equal(disk.files.size, 1);
});

test('a rename onto a file with assumptions merges rather than overwrites', async () => {
  const store = new AssumptionStore(memoryAdapter());
  await store.save(A, [assumption('a1')]);
  await store.save(B, [assumption('b1')]);
  await store.handleRename(A, B);
  assert.deepEqual((await store.load(B)).map((a) => a.id), ['b1', 'a1']);
});

test('an unreadable record moves as the bytes it was', async () => {
  const disk = memoryAdapter();
  disk.files.set(pathOf(A), '{ broken');
  const store = new AssumptionStore(disk);
  await store.handleRename(A, B);
  assert.equal(disk.files.get(pathOf(B)), '{ broken');
  assert.equal(disk.files.has(pathOf(A)), false);
});

test('a rename flushes pending writes first, so none land on the old name', async () => {
  const disk = memoryAdapter();
  const store = new AssumptionStore(disk, 60_000);
  store.queue(A, [assumption('a1')]);
  await store.handleRename(A, B);
  assert.deepEqual([...disk.files.keys()], [pathOf(B)]);
});

test('a deleted file keeps its assumptions, marked, until it comes back', async () => {
  const store = new AssumptionStore(memoryAdapter());
  await store.save(A, [assumption('a1')]);
  await store.handleDelete(A);
  let { records } = await store.loadAll();
  assert.equal(records[0]!.deleted, true);
  assert.equal(await store.handleCreate(A), true);
  ({ records } = await store.loadAll());
  assert.equal(records[0]!.deleted, false);
});

test('prune removes only records whose file is really gone', async () => {
  const store = new AssumptionStore(memoryAdapter());
  await store.save(A, [assumption('a1')]);
  await store.save(B, [assumption('b1')]);
  await store.handleDelete(A);
  await store.handleDelete(B);
  // B came back without anyone telling us.
  const pruned = await store.prune(async (uri) => uri === B);
  assert.deepEqual(pruned, [A]);
  const { records } = await store.loadAll();
  assert.deepEqual(records.map((r) => [r.uri, r.deleted]), [[B, false]]);
});

test('a verdict goes stale when its code changes, but not when it is reformatted', () => {
  const checked = assumption('a1', { verdict: 'solid', note: 'Yes.', checkedQuote: 'a + b' });
  assert.equal(isStale({ ...checked, quote: 'a + b' }), false);
  assert.equal(isStale({ ...checked, quote: 'a +\n    b' }), false);
  assert.equal(isStale({ ...checked, quote: 'a - b' }), true);
  assert.equal(isStale({ ...checked, verdict: null, quote: 'a - b' }), false);
});

test('an unfinished check is one with neither verdict nor note', () => {
  assert.equal(isUnfinished(assumption('a1')), true);
  assert.equal(isUnfinished(assumption('a1', { note: 'Demo mode is on.' })), false);
  assert.equal(isUnfinished(assumption('n1', { kind: 'scratch' })), false);
});
