import test from 'node:test';
import assert from 'node:assert/strict';
import { focusLocalTask } from '../lib/local-workflow.js';
test('explicit sequential instructions advance after successful input of the required kind', () => {
  const goal = 'Open the menu, then click "Monthly report". Stop when opened.';
  assert.equal(focusLocalTask(goal, []).task, 'Open the menu');
  assert.equal(focusLocalTask(goal, [{ kind: 'scroll' }]).step, 1);
  assert.equal(focusLocalTask(goal, [{ kind: 'click' }]).task, 'click "Monthly report". Stop when opened.');
  assert.equal(focusLocalTask(goal, [{ kind: 'click' }, { kind: 'click' }]).step, 2);
});
test('quoted then and instructions requiring several actions are not split into single-action steps', () => {
  const quoted = 'Type "then click submit" into Search';
  assert.equal(focusLocalTask(quoted, []).task, quoted);
  const multi = 'Download all files, then open the menu';
  assert.equal(focusLocalTask(multi, []).total, 1);
});
