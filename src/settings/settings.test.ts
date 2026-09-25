/* Settings are a hand-editable JSON file; these are the shapes it takes. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { normaliseSettings } from './settings';

test('defaults come out of nothing', () => {
  assert.deepEqual(normaliseSettings({}), {
    model: 'claude-sonnet-5',
    effort: null,
    demoMode: false,
    inlineSummary: true,
  });
});

test('known values are kept', () => {
  const settings = normaliseSettings({ model: 'claude-opus-5', effort: 'low', demoMode: true, inlineSummary: false });
  assert.deepEqual(settings, { model: 'claude-opus-5', effort: 'low', demoMode: true, inlineSummary: false });
});

test('an unknown model or effort falls back rather than failing every check', () => {
  const settings = normaliseSettings({ model: 'claude-3-opus', effort: 'default' });
  assert.equal(settings.model, 'claude-sonnet-5');
  assert.equal(settings.effort, null);
});

test('only a real true turns demo mode on', () => {
  assert.equal(normaliseSettings({ demoMode: 'yes' }).demoMode, false);
});
