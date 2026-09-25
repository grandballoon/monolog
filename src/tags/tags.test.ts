/* The tag grammar. What matters is what is *not* a tag: an anchor in a URL,
 * an issue number and an HTML entity must never colour a note. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isTagColor, normaliseTag, tagBeingTyped, tagsOf } from './tags';

test('tags are found anywhere a word starts, lowercased, each once', () => {
  assert.deepEqual(tagsOf('#Perf: this loop is quadratic. See #perf and (#security).'), ['perf', 'security']);
});

test('a tag may carry digits, dashes, underscores and slashes after its first letter', () => {
  assert.deepEqual(tagsOf('#area/billing #needs-review #v2_api'), ['area/billing', 'needs-review', 'v2_api']);
});

test('punctuation after a tag is not part of it', () => {
  assert.deepEqual(tagsOf('Tagged #todo. Also #area/ and #wip-'), ['todo', 'area', 'wip']);
});

test('anchors, issue numbers, entities and a bare # are not tags', () => {
  assert.deepEqual(tagsOf('docs.html#usage, fixes #123, &#39;, ## heading, # alone, a##b'), []);
});

test('non-Latin letters make tags', () => {
  assert.deepEqual(tagsOf('#résumé #日本'), ['résumé', '日本']);
});

test('a typed tag is normalised with or without its #', () => {
  assert.equal(normaliseTag('#Perf'), 'perf');
  assert.equal(normaliseTag('  security '), 'security');
  assert.equal(normaliseTag('#123'), null);
  assert.equal(normaliseTag('two words'), null);
  assert.equal(normaliseTag(''), null);
});

test('the tag being typed is what follows its # up to the cursor', () => {
  assert.equal(tagBeingTyped('This is #pe'), 'pe');
  assert.equal(tagBeingTyped('#'), '');
  assert.equal(tagBeingTyped('see page#an'), null);
  assert.equal(tagBeingTyped('#perf done'), null);
});

test('only palette colours are colours', () => {
  assert.equal(isTagColor('red'), true);
  assert.equal(isTagColor('charts.red'), false);
  assert.equal(isTagColor(undefined), false);
});
