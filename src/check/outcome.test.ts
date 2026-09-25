/* A check that did not happen never labels the code. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { CheckerError } from '../checker/protocol';
import { demoOutcome, failureOutcome, trim } from './outcome';

test('demo outcomes carry no verdict and say what to do', () => {
  assert.equal(demoOutcome('chosen').verdict, null);
  assert.match(demoOutcome('chosen').note, /monolog\.demoMode/);
  assert.match(demoOutcome('no-key').note, /Set Anthropic API Key/);
});

test('a missing key reads as demo mode, not as a failure', () => {
  assert.deepEqual(failureOutcome(CheckerError.notConnected()), demoOutcome('no-key'));
});

test('any other failure says what went wrong and that the assumption is safe', () => {
  const outcome = failureOutcome(new CheckerError('overloaded', 'The API is busy right now.'));
  assert.equal(outcome.verdict, null);
  assert.equal(outcome.note, 'The API is busy right now. Your assumption is saved.');
});

test('trim collapses whitespace and ellipsises', () => {
  assert.equal(trim('  a\n  b  ', 10), 'a b');
  assert.equal(trim('abcdefghijk', 5), 'abcd…');
});
