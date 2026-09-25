/* One state, one reading, everywhere it is shown. */
import test from 'node:test';
import assert from 'node:assert/strict';

import type { Assumption } from '../store/format';
import {
  PAINTS,
  fileNotesTooltip,
  hoverTitle,
  isDrawn,
  noteText,
  paintFor,
  paintOf,
  statusOf,
  summaryText,
  tagPaint,
  threadLabel,
} from './present';

const BASE: Assumption = {
  id: 'a1',
  from: 0,
  to: 10,
  quote: 'xs.length',
  claim: 'Counts the items.',
  verdict: null,
  note: '',
  checkedQuote: null,
};

const SOLID: Assumption = { ...BASE, verdict: 'solid', note: '`length` is the count.', checkedQuote: 'xs.length' };

test('a running check is checking, whatever was there before', () => {
  assert.equal(statusOf(SOLID, true).kind, 'checking');
  assert.equal(paintOf(statusOf(SOLID, true)), 'pending');
});

test('a current verdict paints its own colour', () => {
  assert.equal(paintOf(statusOf(SOLID, false)), 'solid');
  assert.equal(threadLabel(SOLID, false), 'Solid');
});

test('a stale verdict keeps its word but loses its colour', () => {
  const stale = { ...SOLID, quote: 'xs.size' };
  assert.equal(paintOf(statusOf(stale, false)), 'pending');
  assert.equal(threadLabel(stale, false), 'Solid · code changed since');
  assert.match(noteText(stale, false), /code has changed/);
});

test('no verdict and no note is an interrupted check', () => {
  assert.equal(threadLabel(BASE, false), 'Check interrupted');
  assert.match(noteText(BASE, false), /Check Again/);
});

test('no verdict with a note is unchecked, and the note is shown as written', () => {
  const demo = { ...BASE, note: 'Demo mode is on.' };
  assert.equal(threadLabel(demo, false), 'Not checked');
  assert.equal(noteText(demo, false), 'Demo mode is on.');
});

test('resolved and lost assumptions say so in the heading and are not drawn', () => {
  assert.equal(threadLabel({ ...SOLID, resolved: true }, false), 'Resolved · Solid');
  assert.equal(threadLabel({ ...SOLID, unanchored: true }, false), 'Code not found · Solid');
  assert.equal(isDrawn({ ...SOLID, resolved: true }), false);
  assert.equal(isDrawn({ ...SOLID, unanchored: true }), false);
  assert.equal(isDrawn(SOLID), true);
});

test('the line-end summary is the state and a trimmed claim', () => {
  const long = { ...SOLID, claim: 'x'.repeat(100) };
  assert.equal(summaryText(SOLID, false), 'Solid — Counts the items.');
  assert.equal(summaryText(long, false).length, 'Solid — '.length + 60);
});

test('a scratch note has its own word and colour, and nothing below it', () => {
  const scratch: Assumption = { ...BASE, kind: 'scratch', claim: 'Ask Sam why this is not a loop.' };
  assert.equal(statusOf(scratch, false).kind, 'scratch');
  assert.equal(paintOf(statusOf(scratch, false)), 'scratch');
  assert.equal(threadLabel(scratch, false), 'Note');
  assert.equal(threadLabel({ ...scratch, unanchored: true }, false), 'Code not found · Note');
  assert.equal(noteText(scratch, false), '');
  assert.equal(summaryText(scratch, false), 'Note — Ask Sam why this is not a loop.');
});

test('a titled note is headed and hovered by its title; nothing else hovers', () => {
  const scratch: Assumption = { ...BASE, kind: 'scratch', claim: 'Check the heap order.', title: 'Heap' };
  assert.equal(threadLabel(scratch, false), 'Heap');
  assert.equal(threadLabel({ ...scratch, resolved: true }, false), 'Resolved · Heap');
  assert.equal(summaryText(scratch, false), 'Heap — Check the heap order.');
  assert.equal(hoverTitle(scratch), 'Heap');
  assert.equal(hoverTitle({ ...scratch, title: undefined }), null);
  assert.equal(hoverTitle({ ...SOLID, title: 'Stray' }), null);
});

const NOTE: Assumption = { ...BASE, kind: 'scratch', claim: 'Hot path. #perf #security' };
const COLORS = new Map([
  ['security', 'purple'],
  ['perf', 'red'],
] as const);

test('a note takes the colour of the first tag it mentions that has one', () => {
  assert.equal(paintFor(NOTE, false, COLORS), 'tagRed');
  assert.equal(paintFor({ ...NOTE, claim: '#unknown then #security' }, false, COLORS), 'tagPurple');
});

test('with tag colours hidden, or no coloured tag, a note is a note', () => {
  assert.equal(paintFor(NOTE, false, null), 'scratch');
  assert.equal(paintFor({ ...NOTE, claim: '#other' }, false, COLORS), 'scratch');
});

test('an assumption is never painted by a tag', () => {
  assert.equal(paintFor({ ...SOLID, claim: '#perf' }, false, COLORS), 'solid');
});

test('every tag colour is a paint', () => {
  assert.ok(PAINTS.includes(tagPaint('magenta')));
});

test('a note about the whole file is headed as one, never drawn on code, and listed for the Explorer', () => {
  const file: Assumption = { ...NOTE, scope: 'file', from: 0, to: 0, quote: '' };
  assert.equal(threadLabel(file, false), 'File note');
  assert.equal(threadLabel({ ...file, title: 'Entry point' }, false), 'Entry point');
  assert.equal(isDrawn(file), false);
  assert.equal(fileNotesTooltip([NOTE, file, { ...file, id: 'x', title: 'Titled' }]), 'Hot path. #perf #security\nTitled');
  assert.equal(fileNotesTooltip([NOTE, { ...file, resolved: true }]), null);
});
