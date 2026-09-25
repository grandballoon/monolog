/* The join between the store and the document, against strings and a map for
 * a disk. Every assertion here is about the thing that is actually hard: where
 * an assumption sits after the code moves, what survives the code being
 * deleted, and which answer wins when checks overlap. */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { TextChange } from '../anchor/mapping';
import { AssumptionStore } from '../store/store';
import { memoryAdapter } from '../store/memory';
import { AssumptionSession, anchorAll } from './session';

const URI = 'file:///ws/total.ts';
const DOC = 'function total(xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n';
const SPAN = { from: DOC.indexOf('xs.reduce'), to: DOC.indexOf(';') };

function setup() {
  const disk = memoryAdapter();
  const store = new AssumptionStore(disk, 60_000);
  let n = 0;
  const session = new AssumptionSession(store, () => `a${++n}`);
  const changes: string[] = [];
  session.onChange((uri) => changes.push(uri));
  return { disk, store, session, changes };
}

function apply(doc: string, change: TextChange): string {
  return doc.slice(0, change.offset) + change.text + doc.slice(change.offset + change.length);
}

function covered(session: AssumptionSession, doc: string, id: string): string | null {
  const a = session.get(URI, id)!;
  return a.unanchored ? null : doc.slice(a.from, a.to);
}

function addOne(session: AssumptionSession) {
  return session.add(URI, { ...SPAN, quote: DOC.slice(SPAN.from, SPAN.to) }, 'Sums the array.');
}

test('a new assumption is pending, saved, and announced', async () => {
  const { session, store, changes } = setup();
  const a = addOne(session);
  assert.equal(a.verdict, null);
  assert.equal(a.note, '');
  assert.deepEqual(changes, [URI]);
  assert.deepEqual((await store.load(URI)).map((x) => x.claim), ['Sums the array.']);
});

test('the span follows its code as lines are added above it', () => {
  const { session } = setup();
  const a = addOne(session);
  const change = { offset: 0, length: 0, text: '// Adds things up.\n' };
  const doc = apply(DOC, change);
  session.edited(URI, [change], doc);
  assert.equal(covered(session, doc, a.id), 'xs.reduce((a, b) => a + b, 0)');
});

test('an edit inside the span updates the quote the assumption is about', () => {
  const { session } = setup();
  const a = addOne(session);
  const at = DOC.indexOf('a + b');
  const change = { offset: at, length: 5, text: 'a - b' };
  const doc = apply(DOC, change);
  session.edited(URI, [change], doc);
  assert.equal(session.get(URI, a.id)!.quote, 'xs.reduce((a, b) => a - b, 0)');
});

test('an edit that moves nothing announces nothing', () => {
  const { session, changes } = setup();
  addOne(session);
  changes.length = 0;
  const change = { offset: DOC.length, length: 0, text: '\n' };
  session.edited(URI, [change], apply(DOC, change));
  assert.deepEqual(changes, []);
});

test('deleting the code unanchors the assumption, and an undo puts it back', () => {
  const { session } = setup();
  const a = addOne(session);
  const cut = { offset: SPAN.from, length: SPAN.to - SPAN.from, text: '' };
  const without = apply(DOC, cut);
  session.edited(URI, [cut], without);
  assert.equal(session.get(URI, a.id)!.unanchored, true);
  assert.equal(session.get(URI, a.id)!.claim, 'Sums the array.');
  assert.equal(session.reanchor(URI, without), 0);

  const undo = { offset: SPAN.from, length: 0, text: DOC.slice(SPAN.from, SPAN.to) };
  session.edited(URI, [undo], DOC);
  assert.equal(session.reanchor(URI, DOC), 1);
  assert.equal(covered(session, DOC, a.id), 'xs.reduce((a, b) => a + b, 0)');
});

test('code pasted in two places is not guessed between', () => {
  const { session } = setup();
  const a = addOne(session);
  const cut = { offset: SPAN.from, length: SPAN.to - SPAN.from, text: '' };
  session.edited(URI, [cut], apply(DOC, cut));
  const code = DOC.slice(SPAN.from, SPAN.to);
  const twice = `${code};\n${code};\n`;
  assert.equal(session.reanchor(URI, twice), 0);
  assert.equal(session.get(URI, a.id)!.unanchored, true);
});

test('reopening a file edited while closed re-anchors by quote', async () => {
  const { session, store } = setup();
  const a = addOne(session);
  await store.flush();
  session.closed(URI);

  const edited = `// header\n// more header\n${DOC}`;
  await session.open(URI, edited);
  assert.equal(covered(session, edited, a.id), 'xs.reduce((a, b) => a + b, 0)');
});

test('a fresh session loads from the store when the file opens', async () => {
  const { session, store, disk } = setup();
  const a = addOne(session);
  await store.flush();

  const later = new AssumptionSession(new AssumptionStore(disk, 60_000));
  await later.open(URI, DOC);
  assert.equal(later.get(URI, a.id)!.claim, 'Sums the array.');
  assert.equal(later.isAnchored(URI), true);
});

test('edits are ignored for a file that was closed and not yet reopened', () => {
  const { session } = setup();
  const a = addOne(session);
  session.closed(URI);
  const change = { offset: 0, length: 0, text: 'x' };
  session.edited(URI, [change], apply(DOC, change));
  assert.equal(session.get(URI, a.id)!.from, SPAN.from);
});

test('a check records its verdict against the code it read', () => {
  const { session } = setup();
  const a = addOne(session);
  const ticket = session.begin(URI, a.id)!;
  assert.equal(session.isRunning(a.id), true);
  session.finish(URI, a.id, ticket, 'solid', 'It does.', a.quote);
  const done = session.get(URI, a.id)!;
  assert.equal(done.verdict, 'solid');
  assert.equal(done.checkedQuote, a.quote);
  assert.equal(session.isRunning(a.id), false);
});

test('an answer to an older check is dropped when a newer one has started', () => {
  const { session } = setup();
  const a = addOne(session);
  const first = session.begin(URI, a.id)!;
  const second = session.begin(URI, a.id)!;
  session.finish(URI, a.id, first, 'wrong', 'Old answer.', a.quote);
  assert.equal(session.get(URI, a.id)!.verdict, null);
  session.finish(URI, a.id, second, 'solid', 'New answer.', a.quote);
  assert.equal(session.get(URI, a.id)!.note, 'New answer.');
});

test('a failed check leaves no verdict and no checked code', () => {
  const { session } = setup();
  const a = addOne(session);
  const ticket = session.begin(URI, a.id)!;
  session.finish(URI, a.id, ticket, null, 'The API is busy.', a.quote);
  assert.equal(session.get(URI, a.id)!.checkedQuote, null);
});

test('rewriting the claim clears the verdict it no longer answers', () => {
  const { session } = setup();
  const a = addOne(session);
  const ticket = session.begin(URI, a.id)!;
  session.finish(URI, a.id, ticket, 'solid', 'Yes.', a.quote);
  session.setClaim(URI, a.id, 'Returns 0 for an empty array.');
  const now = session.get(URI, a.id)!;
  assert.equal(now.claim, 'Returns 0 for an empty array.');
  assert.equal(now.verdict, null);
});

test('a scratch note is kept like an assumption, and never checked', async () => {
  const { session, store } = setup();
  const n = session.add(URI, { ...SPAN, quote: DOC.slice(SPAN.from, SPAN.to) }, 'Why not Math.sumPrecise?', 'scratch');
  assert.equal(n.kind, 'scratch');
  assert.equal(session.begin(URI, n.id), null);
  assert.equal(session.isRunning(n.id), false);
  assert.deepEqual((await store.load(URI)).map((x) => x.kind), ['scratch']);

  const change = { offset: 0, length: 0, text: '// Adds things up.\n' };
  const doc = apply(DOC, change);
  session.edited(URI, [change], doc);
  assert.equal(covered(session, doc, n.id), 'xs.reduce((a, b) => a + b, 0)');
});

test('a note takes a title, trimmed, and a blank one takes it away', () => {
  const { session } = setup();
  const n = session.add(URI, { ...SPAN, quote: DOC.slice(SPAN.from, SPAN.to) }, 'Why reduce?', 'scratch');
  assert.equal(session.setTitle(URI, n.id, '  Folding  ')?.title, 'Folding');
  assert.equal('title' in session.setTitle(URI, n.id, '   ')!, false);
});

test('an assumption takes no title', () => {
  const { session } = setup();
  const a = addOne(session);
  assert.equal(session.setTitle(URI, a.id, 'Sum'), null);
  assert.equal(session.get(URI, a.id)!.title, undefined);
});

test('an assumption is written without a kind, as records always were', () => {
  const { session } = setup();
  assert.equal('kind' in addOne(session), false);
});

test('resolving and reopening keep the record', () => {
  const { session } = setup();
  const a = addOne(session);
  session.resolve(URI, a.id);
  assert.equal(session.get(URI, a.id)!.resolved, true);
  session.reopen(URI, a.id);
  assert.equal('resolved' in session.get(URI, a.id)!, false);
});

test('removing the last assumption removes the record', async () => {
  const { session, store, disk } = setup();
  const a = addOne(session);
  await store.flush();
  session.remove(URI, a.id);
  await store.flush();
  assert.equal(disk.files.size, 0);
});

test('a rename carries the assumptions to the new URI', () => {
  const { session } = setup();
  const a = addOne(session);
  session.renamed(URI, 'file:///ws/sum.ts');
  assert.equal(session.get(URI, a.id), null);
  assert.equal(session.get('file:///ws/sum.ts', a.id)!.claim, 'Sums the array.');
});

test('anchorAll marks only what it could not place', () => {
  const [kept, lost] = anchorAll(
    [
      { id: 'k', from: 999, to: 1005, quote: 'return', claim: '', verdict: null, note: '', checkedQuote: null },
      { id: 'l', from: 0, to: 4, quote: 'gone!', claim: '', verdict: null, note: '', checkedQuote: null },
    ],
    DOC,
  );
  assert.equal(DOC.slice(kept!.from, kept!.to), 'return');
  assert.equal(kept!.unanchored, undefined);
  assert.equal(lost!.unanchored, true);
});

test('a note about the whole file is never lost, however the file is edited', async () => {
  const { session } = setup();
  const n = session.add(URI, null, 'The entry point. #legacy', 'scratch');
  assert.equal(n.scope, 'file');
  await session.open(URI, DOC);
  const change = { offset: 0, length: DOC.length, text: '' };
  session.edited(URI, [change], '');
  assert.equal(session.get(URI, n.id)!.unanchored, undefined);
  assert.equal(session.hasUnanchored(URI), false);
});

test('only a note can be about the whole file', () => {
  const { session } = setup();
  assert.throws(() => session.add(URI, null, 'Claims something.'));
});

test('replacing notes from disk keeps the assumptions and places the new notes', async () => {
  const { session, changes } = setup();
  const a = addOne(session);
  const old = session.add(URI, { ...SPAN, quote: DOC.slice(SPAN.from, SPAN.to) }, 'mine', 'scratch');
  await session.open(URI, DOC);
  changes.length = 0;

  const quote = 'return';
  session.replaceNotes(
    URI,
    [{ id: 'theirs', kind: 'scratch', from: 0, to: 0, quote, claim: 'from a pull', verdict: null, note: '', checkedQuote: null }],
    DOC,
  );
  assert.ok(session.get(URI, a.id), 'the assumption is untouched');
  assert.equal(session.get(URI, old.id), null, 'the old note is gone');
  const theirs = session.get(URI, 'theirs')!;
  assert.equal(DOC.slice(theirs.from, theirs.to), quote);
  assert.deepEqual(changes, [URI]);
});

test('replacing the last notes of a file with none forgets the file', () => {
  const { session } = setup();
  session.add(URI, { ...SPAN, quote: DOC.slice(SPAN.from, SPAN.to) }, 'mine', 'scratch');
  session.replaceNotes(URI, [], undefined);
  assert.equal(session.isLoaded(URI), false);
});
