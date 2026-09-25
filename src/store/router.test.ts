/* Which store each entry goes to, and what moves between them. What matters:
 * notes reach the metadata file and assumptions never do, a note held
 * privately is never dropped on its way into the file, and a file that
 * cannot be read costs nothing written. */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Assumption } from './format';
import { memoryAdapter } from './memory';
import { RepoStore } from './repo';
import { REPO_FILE } from './repoFormat';
import { StoreRouter, type RepoChange, type RepoLocator } from './router';
import { AssumptionStore } from './store';

const ROOT = 'file:///ws';
const A = `${ROOT}/src/a.ts`;
const B = `${ROOT}/src/b.ts`;
const OUTSIDE = 'file:///elsewhere/c.ts';

const locator: RepoLocator = {
  locate(uri) {
    return uri.startsWith(`${ROOT}/`) ? { root: ROOT, path: uri.slice(ROOT.length + 1) } : null;
  },
  uriOf(root, path) {
    return `${root}/${path}`;
  },
};

function entry(id: string, over: Partial<Assumption> = {}): Assumption {
  return {
    id,
    from: 0,
    to: 5,
    quote: 'const',
    claim: `about ${id}`,
    verdict: null,
    note: '',
    checkedQuote: null,
    ...over,
  };
}

const note = (id: string, over: Partial<Assumption> = {}) => entry(id, { kind: 'scratch', ...over });

function setup() {
  const privateDisk = memoryAdapter();
  const repoDisk = memoryAdapter();
  const personal = new AssumptionStore(privateDisk, 60_000);
  const router = new StoreRouter(personal, locator, () => new RepoStore(repoDisk), 60_000);
  const changes: RepoChange[] = [];
  router.onRepoChange((c) => changes.push(c));
  return { privateDisk, repoDisk, personal, router, changes };
}

function repoIds(disk: ReturnType<typeof memoryAdapter>): string[] {
  const raw = disk.files.get(REPO_FILE);
  return raw ? JSON.parse(raw).notes.map((n: { id: string }) => n.id) : [];
}

test('notes go to the metadata file, assumptions to private storage', async () => {
  const { router, repoDisk, personal } = setup();
  await router.load(A);
  router.queue(A, [entry('claim'), note('n1')]);
  await router.flush();

  assert.deepEqual(repoIds(repoDisk), ['n1']);
  assert.deepEqual((await personal.load(A)).map((a) => a.id), ['claim']);
  assert.deepEqual((await router.load(A)).map((a) => a.id), ['claim', 'n1']);
});

test('a note on a file outside every folder stays private', async () => {
  const { router, repoDisk, personal } = setup();
  router.queue(OUTSIDE, [note('n1')]);
  await router.flush();
  assert.equal(repoDisk.files.has(REPO_FILE), false);
  assert.deepEqual((await personal.load(OUTSIDE)).map((a) => a.id), ['n1']);
});

test('notes kept privately before the metadata file existed move into it at startup', async () => {
  const { router, repoDisk, personal } = setup();
  await personal.save(A, [entry('claim'), note('old')]);

  const { records } = await router.loadAll([ROOT]);
  assert.deepEqual(repoIds(repoDisk), ['old']);
  assert.deepEqual((await personal.load(A)).map((a) => a.id), ['claim']);
  assert.deepEqual(records.find((r) => r.uri === A)?.assumptions.map((a) => a.id), ['claim', 'old']);
});

test('startup lists files that have only notes, and reports a file it cannot read', async () => {
  const { router, repoDisk, personal } = setup();
  const seed = new StoreRouter(personal, locator, () => new RepoStore(repoDisk), 60_000);
  await seed.load(B);
  seed.queue(B, [note('b1')]);
  await seed.flush();

  const { records } = await router.loadAll([ROOT]);
  assert.deepEqual(records.map((r) => r.uri), [B]);

  const broken = setup();
  broken.repoDisk.files.set(REPO_FILE, '{');
  const { unreadable } = await broken.router.loadAll([ROOT]);
  assert.equal(unreadable.length, 1);
  assert.match(unreadable[0]!.what, /metadata\.json$/);
});

test('while the metadata file cannot be read, notes are kept privately, and move in once it is fixed', async () => {
  const { router, repoDisk, personal, changes } = setup();
  repoDisk.files.set(REPO_FILE, '<<<<<<< HEAD');
  await router.loadAll([ROOT]);

  router.queue(A, [note('meanwhile')]);
  await router.flush();
  assert.equal(repoDisk.files.get(REPO_FILE), '<<<<<<< HEAD', 'never written over');
  assert.deepEqual((await personal.load(A)).map((a) => a.id), ['meanwhile']);

  repoDisk.files.set(REPO_FILE, '{"version": 1}');
  await router.syncRepo(ROOT);
  assert.deepEqual(repoIds(repoDisk), ['meanwhile']);
  assert.deepEqual(await personal.load(A), []);
  assert.deepEqual(changes, []);
});

test('a note changed after the file became unreadable is kept privately rather than lost', async () => {
  const { router, repoDisk, personal, changes } = setup();
  await router.load(A);
  router.queue(A, [note('n1')]);
  await router.flush();

  router.queue(A, [note('n1', { claim: 'rewritten' })]);
  repoDisk.files.set(REPO_FILE, '<<<<<<< HEAD');
  await router.flush();
  assert.equal(repoDisk.files.get(REPO_FILE), '<<<<<<< HEAD');
  assert.deepEqual((await personal.load(A)).map((a) => a.claim), ['rewritten']);
  assert.equal(changes.length, 1);
  assert.match(changes[0]!.unreadable ?? '', /not valid JSON/);
});

test('a note held privately wins over the metadata file\'s copy', async () => {
  const { router, personal } = setup();
  await router.load(A);
  router.queue(A, [note('n1', { claim: 'old' })]);
  await router.flush();
  await personal.save(A, [note('n1', { claim: 'newer' })]);
  assert.deepEqual((await router.load(A)).map((a) => a.claim), ['newer']);
});

test('a change on disk is reported by file', async () => {
  const { router, repoDisk, changes } = setup();
  await router.load(A);
  router.queue(A, [note('n1')]);
  await router.flush();

  repoDisk.files.set(REPO_FILE, '{"version": 1, "notes": [{"path": "src/b.ts", "id": "b1", "text": "hi"}]}');
  await router.syncRepo(ROOT);
  assert.deepEqual(changes.map((c) => c.uris.sort()), [[A, B]]);
});

test('a renamed file takes its notes with it, into or out of the folder', async () => {
  const { router, repoDisk, personal } = setup();
  await router.load(A);
  router.queue(A, [entry('claim'), note('n1')]);
  await router.flush();

  await router.handleRename(A, B);
  assert.deepEqual((await router.load(B)).map((a) => a.id).sort(), ['claim', 'n1']);
  assert.deepEqual(await router.load(A), []);

  await router.handleRename(B, OUTSIDE);
  assert.deepEqual(repoIds(repoDisk), []);
  assert.deepEqual((await personal.load(OUTSIDE)).map((a) => a.id).sort(), ['claim', 'n1']);
});

test('pruning removes the notes of files that are not there', async () => {
  const { router, repoDisk } = setup();
  await router.load(A);
  router.queue(A, [note('a1')]);
  router.queue(B, [note('b1')]);
  await router.flush();

  const pruned = await router.prune(async (uri) => uri === A);
  assert.deepEqual(pruned, [B]);
  assert.deepEqual(repoIds(repoDisk), ['a1']);
});

test('a file with notes only in the metadata file counts as having entries when it reappears', async () => {
  const { router } = setup();
  await router.load(A);
  router.queue(A, [note('a1')]);
  await router.flush();
  assert.equal(await router.handleCreate(A), true);
  assert.equal(await router.handleCreate(B), false);
});

test('tag colours belong to the folder, and only palette colours count', async () => {
  const { router, repoDisk } = setup();
  await router.load(A);
  assert.equal(await router.setTagColor(A, 'perf', 'red'), null);
  assert.deepEqual([...router.tagColors(A)], [['perf', 'red']]);
  assert.deepEqual([...router.tagColors(OUTSIDE)], []);
  assert.match((await router.setTagColor(OUTSIDE, 'perf', 'red')) ?? '', /not in a workspace folder/);

  repoDisk.files.set(REPO_FILE, '{"version": 1, "tags": {"perf": {"color": "chartreuse"}}}');
  await router.syncRepo(ROOT);
  assert.deepEqual([...router.tagColors(A)], []);
});

test('known tags include those used in the file itself', async () => {
  const { router } = setup();
  await router.load(A);
  await router.setTagColor(A, 'perf', 'red');
  assert.deepEqual(router.knownTags(A, [note('n', { claim: '#draft' }), entry('x', { claim: '#notatag' })]), ['draft', 'perf']);
});
