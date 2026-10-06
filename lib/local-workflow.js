// Small models receive one explicit sequential instruction at a time. This
// schedules user instructions; it never selects a DOM target for the model.
export function focusLocalTask(task, history) {
  const pieces = [];
  let start = 0;
  let quote = '';
  for (let index = 0; index < task.length; index++) {
    const char = task[index];
    if (quote) { if (char === quote || (quote === '“' && char === '”')) quote = ''; continue; }
    if (char === '"' || char === '“') { quote = char; continue; }
    const match = task.slice(index).match(/^\bthen\b/i);
    if (!match || (index > 0 && /\w/.test(task[index - 1]))) continue;
    pieces.push(task.slice(start, index).trim().replace(/[,;]\s*$/, ''));
    start = index + match[0].length;
    index = start - 1;
  }
  pieces.push(task.slice(start).trim());
  const kinds = pieces.map((piece) => {
    if (/\b(?:all|each|every|multiple)\b/i.test(piece)) return null;
    if (/^(?:click|open|download)\b/i.test(piece)) return 'click';
    if (/^(?:type|enter|fill)\b/i.test(piece)) return 'type';
    if (/^(?:hover|move pointer)\b/i.test(piece)) return 'move';
    if (/^press\b/i.test(piece)) return 'key';
    if (/^scroll\b/i.test(piece)) return 'scroll';
    return null;
  });
  if (pieces.length < 2 || pieces.length > 8 || kinds.some((kind) => !kind)) return { task, step: 1, total: 1 };
  let completed = 0;
  for (const action of history) {
    if (completed < pieces.length && action.kind === kinds[completed]) completed++;
  }
  const index = Math.min(completed, pieces.length - 1);
  return { task: pieces[index], step: index + 1, total: pieces.length, finished: completed === pieces.length };
}
