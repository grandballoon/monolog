/* The span follows its code through edits — the part Obsidian's CodeMirror did
 * for Recall and VS Code leaves to us. Each case is written against a real
 * string so the assertion is about which characters are covered, not about
 * offset arithmetic. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mapSpan, mapSpanThrough, type Span, type TextChange } from './mapping';

const DOC = 'const total = items.reduce(sum, 0);';
const SPAN: Span = { from: DOC.indexOf('items'), to: DOC.indexOf(';') };

function apply(doc: string, change: TextChange): string {
  return doc.slice(0, change.offset) + change.text + doc.slice(change.offset + change.length);
}

function covered(doc: string, span: Span | null): string | null {
  return span === null ? null : doc.slice(span.from, span.to);
}

function after(change: TextChange, span: Span = SPAN): string | null {
  return covered(apply(DOC, change), mapSpan(span, change));
}

test('an edit before the span moves it along', () => {
  assert.equal(after({ offset: 0, length: 5, text: 'let' }), 'items.reduce(sum, 0)');
});

test('an edit after the span leaves it alone', () => {
  assert.equal(after({ offset: DOC.length, length: 0, text: ' // done' }), 'items.reduce(sum, 0)');
});

test('an edit inside the span grows or shrinks it', () => {
  const at = DOC.indexOf('sum');
  assert.equal(after({ offset: at, length: 3, text: 'add' }), 'items.reduce(add, 0)');
  assert.equal(after({ offset: at, length: 5, text: '' }), 'items.reduce(0)');
});

test('text typed against either boundary falls outside', () => {
  assert.equal(after({ offset: SPAN.from, length: 0, text: 'these.' }), 'items.reduce(sum, 0)');
  assert.equal(after({ offset: SPAN.to, length: 0, text: '.toFixed(2)' }), 'items.reduce(sum, 0)');
});

test('replacing exactly the span keeps it, over the new code', () => {
  // Selecting the code an assumption is about and rewriting it: the
  // assumption follows, and staleness is what flags the verdict.
  const change = { offset: SPAN.from, length: SPAN.to - SPAN.from, text: 'sumAll(items)' };
  assert.equal(after(change), 'sumAll(items)');
});

test('a replacement straddling the start is excluded from the span', () => {
  const start = DOC.indexOf('= items');
  const change = { offset: start, length: '= items'.length, text: '= rows' };
  assert.equal(after(change), '.reduce(sum, 0)');
});

test('a replacement straddling the end is excluded from the span', () => {
  const start = DOC.indexOf('0);');
  const change = { offset: start, length: 3, text: '1);' };
  assert.equal(after(change), 'items.reduce(sum, ');
});

test('deleting the whole span collapses it', () => {
  assert.equal(after({ offset: SPAN.from, length: SPAN.to - SPAN.from, text: '' }), null);
});

test('deleting a stretch that contains the span collapses it', () => {
  assert.equal(after({ offset: 0, length: DOC.length, text: 'let x = 1;' }), null);
});

test('a deletion that runs from before the span to its end collapses it', () => {
  assert.equal(after({ offset: 0, length: SPAN.to, text: 'x' }), null);
});

test('several changes in one event are mapped in order', () => {
  // VS Code emits a multi-cursor edit last-to-first, so each change's offsets
  // hold against the document as it was before the whole event.
  const changes: TextChange[] = [
    { offset: DOC.length, length: 0, text: ' // tail' },
    { offset: DOC.indexOf('sum'), length: 3, text: 'add' },
    { offset: 0, length: 5, text: 'let' },
  ];
  const doc = changes.reduce(apply, DOC);
  assert.equal(covered(doc, mapSpanThrough(SPAN, changes)), 'items.reduce(add, 0)');
});

test('a span collapsed by an earlier change stays gone', () => {
  const changes: TextChange[] = [
    { offset: SPAN.from, length: SPAN.to - SPAN.from, text: '' },
    { offset: 0, length: 0, text: 'x' },
  ];
  assert.equal(mapSpanThrough(SPAN, changes), null);
});
