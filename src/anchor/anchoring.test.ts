/* The reopen path: an anchor whose offsets no longer fit, put back by quote.
 * The rules are the ones Recall arrived at against a real library — exactly
 * one match, whitespace normalised on both sides, and silence rather than a
 * guess. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { findQuote, normaliseQuote, resolveAnchor } from './anchoring';

const DOC = 'Encapsulation hides state behind an interface.\nInheritance shares code.';

test('a quote that appears once is found', () => {
  const found = findQuote(DOC, 'hides state');
  assert.equal(found.count, 1);
  assert.equal(DOC.slice(found.from, found.to), 'hides state');
});

test('a quote that appears twice is reported and not placed', () => {
  const doc = 'state and more state';
  const found = findQuote(doc, 'state');
  assert.equal(found.count, 2);
  assert.equal(found.from, -1);
});

test('a quote that is gone is reported as absent', () => {
  assert.equal(findQuote(DOC, 'polymorphism').count, 0);
});

test('a quote shorter than three characters is never matched', () => {
  // Too little to be sure of, and the cost of being wrong is an assumption
  // shown against the wrong code.
  assert.equal(findQuote(DOC, 'is').count, 0);
  assert.equal(findQuote(DOC, '  ').count, 0);
});

test('whitespace is normalised on both sides', () => {
  // Re-indenting or reflowing code changes whitespace and nothing else.
  const found = findQuote(DOC, 'interface.   Inheritance');
  assert.equal(found.count, 1);
  assert.equal(DOC.slice(found.from, found.to), 'interface.\nInheritance');
});

test('normalising collapses runs and trims the edges', () => {
  assert.equal(normaliseQuote('  a \n\t b  '), 'a b');
  assert.equal(normaliseQuote(''), '');
});

test('offsets that still hold are trusted as they are', () => {
  const resolution = resolveAnchor(DOC, { from: 0, to: 13, quote: 'Encapsulation' });
  assert.deepEqual(resolution, { kind: 'exact', from: 0, to: 13 });
});

test('offsets that have shifted are re-anchored by quote', () => {
  const doc = `A new first line.\n${DOC}`;
  const resolution = resolveAnchor(doc, { from: 0, to: 13, quote: 'Encapsulation' });
  assert.equal(resolution.kind, 'quote');
  assert.ok(resolution.kind === 'quote' && doc.slice(resolution.from, resolution.to) === 'Encapsulation');
});

test('an ambiguous quote is left alone and reported', () => {
  const doc = 'state and more state';
  // Offsets that no longer hold, so it falls through to the quote — which
  // appears twice, and so is not placed at all.
  const resolution = resolveAnchor(doc, { from: 6, to: 9, quote: 'state' });
  assert.deepEqual(resolution, { kind: 'ambiguous', count: 2 });
});

test('offsets that still hold win even when the quote appears elsewhere', () => {
  // The offsets are the stronger evidence: the quote search exists for when
  // they have stopped fitting, not to second-guess them when they still do.
  const doc = 'state and more state';
  const resolution = resolveAnchor(doc, { from: 0, to: 5, quote: 'state' });
  assert.deepEqual(resolution, { kind: 'exact', from: 0, to: 5 });
});

test('an absent quote is left alone and reported', () => {
  const resolution = resolveAnchor(DOC, { from: 0, to: 5, quote: 'polymorphism' });
  assert.deepEqual(resolution, { kind: 'absent' });
});

test('offsets past the end of the document do not throw', () => {
  const resolution = resolveAnchor('short', { from: 90, to: 120, quote: 'short' });
  assert.deepEqual(resolution, { kind: 'quote', from: 0, to: 5 });
});
