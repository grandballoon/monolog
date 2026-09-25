/* The metadata file, against a map for a disk. What matters: it is written
 * one way only, a file that cannot be read is never written over, and a
 * change on disk is neither lost nor overwritten by a stale one of ours. */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Assumption } from './format';
import { memoryAdapter } from './memory';
import { RepoStore } from './repo';
import { REPO_FILE, parseRepoDocument, serialiseRepoDocument } from './repoFormat';

function note(id: string, over: Partial<Assumption> = {}): Assumption {
  return {
    id,
    kind: 'scratch',
    from: 10,
    to: 15,
    quote: 'const',
    claim: `#perf note ${id}`,
    verdict: null,
    note: '',
    checkedQuote: null,
    ...over,
  };
}

function fileNote(id: string, claim = 'About the whole file #legacy'): Assumption {
  return note(id, { scope: 'file', from: 0, to: 0, quote: '', claim });
}

function onDisk(disk: ReturnType<typeof memoryAdapter>): { tags: Record<string, unknown>; notes: Record<string, unknown>[] } {
  return JSON.parse(disk.files.get(REPO_FILE)!);
}

test('notes round-trip through the file, spans and whole-file alike', () => {
  const doc = {
    tags: new Map([['perf', { color: 'red' }]]),
    notes: new Map([['src/a.ts', [note('n1', { title: 'Hot', resolved: true }), fileNote('n2')]]]),
  };
  const parsed = parseRepoDocument(serialiseRepoDocument(doc));
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind !== 'ok') return;
  assert.deepEqual(parsed.doc.tags, doc.tags);
  const back = parsed.doc.notes.get('src/a.ts')!;
  assert.deepEqual(
    back.find((a) => a.id === 'n1'),
    note('n1', { title: 'Hot', resolved: true }),
  );
  assert.deepEqual(
    back.find((a) => a.id === 'n2'),
    fileNote('n2'),
  );
});

test('the file is written sorted and carries each note\'s tags beside its text', () => {
  const out = serialiseRepoDocument({
    tags: new Map([
      ['zeta', {}],
      ['alpha', { color: 'blue' }],
    ]),
    notes: new Map([
      ['b.ts', [note('late', { from: 40, to: 45 }), note('early', { from: 2, to: 5 })]],
      ['a.ts', [note('x', { claim: 'plain' }), fileNote('f')]],
    ]),
  });
  const json = JSON.parse(out);
  assert.deepEqual(Object.keys(json.tags), ['alpha', 'zeta']);
  assert.deepEqual(
    json.notes.map((n: { path: string; id: string }) => `${n.path}:${n.id}`),
    ['a.ts:f', 'a.ts:x', 'b.ts:early', 'b.ts:late'],
  );
  assert.deepEqual(json.notes[0].tags, ['legacy']);
  assert.equal(json.notes[0].span, undefined, 'a whole-file note has no span');
  assert.deepEqual(json.notes[1].tags, []);
  assert.ok(out.endsWith('}\n'));
});

test('what only this machine knows is not written', () => {
  const json = JSON.parse(
    serialiseRepoDocument({ tags: new Map(), notes: new Map([['a.ts', [note('n', { unanchored: true })]]]) }),
  );
  assert.deepEqual(Object.keys(json.notes[0]).sort(), ['id', 'path', 'span', 'tags', 'text']);
});

test('a file that is not a metadata file says why', () => {
  const why = (raw: string) => {
    const r = parseRepoDocument(raw);
    return r.kind === 'unreadable' ? r.why : r.kind;
  };
  assert.equal(why(''), 'empty');
  assert.match(why('<<<<<<< HEAD\n{}'), /not valid JSON/);
  assert.match(why('{"version": 2}'), /format version 2/);
  assert.match(why('{"version": 1, "notes": {}}'), /not a list/);
  assert.match(why('{"version": 1, "notes": [{"path": "../x", "id": "a", "text": ""}]}'), /not a relative path/);
  assert.match(why('{"version": 1, "notes": [{"path": "/etc/x", "id": "a", "text": ""}]}'), /not a relative path/);
  assert.match(why('{"version": 1, "notes": [{"path": "a", "id": "a", "text": "", "span": {"from": 5, "to": 1, "quote": ""}}]}'), /ends before/);
  assert.match(why('{"version": 1, "notes": [{"path": "a", "id": "a", "text": ""}, {"path": "a", "id": "a", "text": ""}]}'), /twice/);
  assert.match(why('{"version": 1, "tags": {"x": {"color": 3}}}'), /tag x/);
});

test('fields it does not know are ignored', () => {
  const r = parseRepoDocument('{"version": 1, "extra": 1, "notes": [{"path": "a.ts", "id": "n", "text": "hi", "who": "me"}]}');
  assert.equal(r.kind, 'ok');
});

test('notes set here are written, and a fresh store reads them back', async () => {
  const disk = memoryAdapter();
  const repo = new RepoStore(disk);
  await repo.ensureRead();
  repo.setNotes('src/a.ts', [note('n1')]);
  await repo.write();

  const again = new RepoStore(disk);
  await again.ensureRead();
  assert.deepEqual(again.notesAt('src/a.ts'), [note('n1')]);
  assert.deepEqual(again.paths(), ['src/a.ts']);
});

test('no file is made for a folder that never had a note kept', async () => {
  const disk = memoryAdapter();
  const repo = new RepoStore(disk);
  await repo.ensureRead();
  repo.setNotes('a.ts', [note('n')]);
  repo.setNotes('a.ts', []);
  await repo.write();
  assert.equal(disk.files.has(REPO_FILE), false);
});

test('an unreadable file is never written over, and is written once it is fixed', async () => {
  const disk = memoryAdapter();
  disk.files.set(REPO_FILE, '<<<<<<< HEAD');
  const repo = new RepoStore(disk);
  const first = await repo.sync();
  assert.match(first.unreadable ?? '', /not valid JSON/);

  repo.setNotes('a.ts', [note('n')]);
  const second = await repo.write();
  assert.equal(second.unreadable, null, 'the same trouble is reported once');
  assert.equal(disk.files.get(REPO_FILE), '<<<<<<< HEAD');

  disk.files.set(REPO_FILE, '{"version": 1}');
  const fixed = await repo.write();
  assert.equal(fixed.recovered, true);
  assert.deepEqual(onDisk(disk).notes.map((n) => n.id), ['n']);
});

test('a path the disk changed takes the disk\'s notes, and says so', async () => {
  const disk = memoryAdapter();
  const repo = new RepoStore(disk);
  await repo.ensureRead();
  repo.setNotes('a.ts', [note('mine')]);
  await repo.write();

  disk.files.set(
    REPO_FILE,
    serialiseRepoDocument({ tags: new Map(), notes: new Map([['a.ts', [note('theirs')]]]) }),
  );
  const result = await repo.sync();
  assert.deepEqual(result.paths, ['a.ts']);
  assert.deepEqual(repo.notesAt('a.ts').map((a) => a.id), ['theirs']);
});

test('an unwritten change to a path the disk left alone survives a change elsewhere', async () => {
  const disk = memoryAdapter();
  const repo = new RepoStore(disk);
  await repo.ensureRead();
  repo.setNotes('a.ts', [note('a1')]);
  repo.setNotes('b.ts', [note('b1')]);
  await repo.write();

  // Ours, not yet written.
  repo.setNotes('a.ts', [note('a1'), note('a2')]);
  // Theirs, to another path.
  disk.files.set(
    REPO_FILE,
    serialiseRepoDocument({
      tags: new Map(),
      notes: new Map([
        ['a.ts', [note('a1')]],
        ['b.ts', [note('b1'), note('b2')]],
      ]),
    }),
  );
  const result = await repo.write();
  assert.deepEqual(result.paths, ['b.ts']);
  const written = onDisk(disk).notes.map((n) => `${n.path}:${n.id}`);
  assert.deepEqual(written, ['a.ts:a1', 'a.ts:a2', 'b.ts:b1', 'b.ts:b2']);
});

test('the disk wins over an unwritten change to the same path — a checkout shows what was checked out', async () => {
  const disk = memoryAdapter();
  const repo = new RepoStore(disk);
  await repo.ensureRead();
  repo.setNotes('a.ts', [note('a1')]);
  await repo.write();

  repo.setNotes('a.ts', [note('a1', { from: 99, to: 104 })]);
  disk.files.set(
    REPO_FILE,
    serialiseRepoDocument({ tags: new Map(), notes: new Map([['a.ts', [note('other-branch')]]]) }),
  );
  await repo.write();
  assert.deepEqual(onDisk(disk).notes.map((n) => n.id), ['other-branch']);
  assert.equal(repo.isDirty(), false);
});

test('a file deleted on disk takes its notes with it', async () => {
  const disk = memoryAdapter();
  const repo = new RepoStore(disk);
  await repo.ensureRead();
  repo.setNotes('a.ts', [note('a1')]);
  await repo.write();

  disk.files.delete(REPO_FILE);
  const result = await repo.sync();
  assert.deepEqual(result.paths, ['a.ts']);
  assert.deepEqual(repo.paths(), []);
});

test('reading back what was just written reports nothing', async () => {
  const disk = memoryAdapter();
  const repo = new RepoStore(disk);
  await repo.ensureRead();
  repo.setNotes('a.ts', [note('a1')]);
  await repo.write();
  const result = await repo.sync();
  assert.deepEqual(result, { paths: [], tagsChanged: false, unreadable: null, recovered: false });
});

test('a change made while a write is in flight is still written', async () => {
  const disk = memoryAdapter();
  let release: () => void = () => {};
  const slow = {
    ...disk,
    async write(path: string, data: string) {
      await new Promise<void>((resolve) => (release = resolve));
      await disk.write(path, data);
    },
  };
  const repo = new RepoStore(slow);
  await repo.ensureRead();
  repo.setNotes('a.ts', [note('a1')]);
  const writing = repo.write();
  await new Promise((resolve) => setImmediate(resolve));
  repo.setNotes('a.ts', [note('a1'), note('a2')]);
  release();
  await writing;
  assert.equal(repo.isDirty(), true);

  const second = repo.write();
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await second;
  assert.deepEqual(onDisk(disk).notes.map((n) => n.id), ['a1', 'a2']);
});

test('tag colours are kept, cleared, and taken from the disk when it changes them', async () => {
  const disk = memoryAdapter();
  const repo = new RepoStore(disk);
  await repo.ensureRead();
  repo.setTagColor('perf', 'red');
  await repo.write();
  assert.deepEqual(onDisk(disk).tags, { perf: { color: 'red' } });

  repo.setTagColor('perf', null);
  await repo.write();
  assert.deepEqual(onDisk(disk).tags, {});

  disk.files.set(REPO_FILE, '{"version": 1, "tags": {"sec": {"color": "purple"}}}');
  const result = await repo.sync();
  assert.equal(result.tagsChanged, true);
  assert.deepEqual([...repo.tagDefinitions()], [['sec', { color: 'purple' }]]);
});

test('the known tags are those defined and those used', async () => {
  const repo = new RepoStore(memoryAdapter());
  await repo.ensureRead();
  repo.setTagColor('zeta', 'blue');
  repo.setNotes('a.ts', [note('n', { claim: '#alpha and #perf' })]);
  assert.deepEqual(repo.knownTags(), ['alpha', 'perf', 'zeta']);
});
