const normalize = (value) => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

// Parse the MODEL's command, never the user's task. A unique exact DOM label is
// required, so missing, invented or ambiguous targets cannot become a click.
export function resolveLocalCommand(raw, candidates) {
  const text = String(raw || '').trim();
  const stop = text.split(/[.!\n]/, 1)[0].trim();
  if (/^(?:done|stop|finish)$/i.test(stop)) return candidates.find((candidate) => candidate.kind === 'done')?.key || 'ask_user';
  if (/^(?:ask(?: the)? user|ask_user)\b/i.test(text)) return 'ask_user';
  const fixed = [
    [/^scroll down[.!]?$/i, 'scroll_down'], [/^scroll up[.!]?$/i, 'scroll_up'],
    [/^press enter[.!]?$/i, 'press_enter'], [/^press tab[.!]?$/i, 'press_tab'],
    [/^press escape[.!]?$/i, 'press_escape']
  ];
  for (const [pattern, key] of fixed) if (pattern.test(text) && candidates.some((candidate) => candidate.key === key)) return key;
  const kind = /^click\b/i.test(text) ? 'click' : /^type\b/i.test(text) ? 'type' : /^(?:hover|move pointer over)\b/i.test(text) ? 'move' : null;
  if (!kind) return 'ask_user';
  const quoted = [...text.matchAll(/["“]([^"”\n]+)["”]/g)].map((match) => normalize(match[1]));
  if (quoted.length !== 1) return 'ask_user';
  const matches = candidates.filter((candidate) => candidate.kind === kind && normalize(candidate.label) === quoted[0]);
  return matches.length === 1 ? matches[0].key : 'ask_user';
}
