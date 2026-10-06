import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalCommand } from '../lib/local-command.js';
const candidates = [
  { key: 'click_0', kind: 'click', label: 'Annual report' },
  { key: 'click_1', kind: 'click', label: 'Monthly report' },
  { key: 'done', kind: 'done' }, { key: 'scroll_down', kind: 'scroll' }
];
test('the model command resolves an exact named control, independent of candidate order', () => {
  assert.equal(resolveLocalCommand('Click the button labeled "Monthly report".', candidates), 'click_1');
  assert.equal(resolveLocalCommand('Click “Monthly report”.', [...candidates].reverse()), 'click_1');
});
test('invented, ambiguous and multiple model targets never become a click', () => {
  assert.equal(resolveLocalCommand('Click "Invented button".', candidates), 'ask_user');
  assert.equal(resolveLocalCommand('Click "Monthly report" then "Annual report".', candidates), 'ask_user');
  assert.equal(resolveLocalCommand('Click "Monthly report".', [...candidates, { key: 'click_2', kind: 'click', label: 'Monthly report' }]), 'ask_user');
  assert.equal(resolveLocalCommand('Do not click "Monthly report".', candidates), 'ask_user');
});
test('completion must be a current command, not a future condition', () => {
  assert.equal(resolveLocalCommand('Done', candidates), 'done');
  assert.equal(resolveLocalCommand('Stop. The task is complete.', candidates), 'done');
  assert.equal(resolveLocalCommand('Stop when the task is complete.', candidates), 'ask_user');
  assert.equal(resolveLocalCommand('Scroll down', candidates), 'scroll_down');
});
