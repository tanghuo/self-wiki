// Only explicitly inserted references are tokens. Arbitrary {{...}} in literal
// text and in model answers is never evaluated as a second template.
export function textDocument(parts, name) {
  const references = [], byBinding = new Map();
  let text = '';
  for (const part of parts) {
    if (part.kind === 'text') { text += part.text; continue; }
    const key = JSON.stringify(part.ref);
    let entry = byBinding.get(key);
    if (!entry) {
      const label = name(part.ref), base = `{{${label}}}`;
      let token = base, suffix = 2;
      while (references.some((r) => r.token === token) || parts.some((p) => p.kind === 'text' && p.text.includes(token))) token = `{{${label} ${suffix++}}}`;
      entry = { token, ref: part.ref }; references.push(entry); byBinding.set(key, entry);
    }
    text += entry.token;
  }
  return { text, references };
}

export function parseTextDocument(text, references) {
  const parts = [];
  let cursor = 0;
  while (cursor < text.length) {
    const next = references.map((r) => ({ ...r, at: text.indexOf(r.token, cursor) })).filter((r) => r.at >= 0).sort((a, b) => a.at - b.at)[0];
    if (!next) { parts.push({ kind: 'text', text: text.slice(cursor) }); break; }
    if (next.at > cursor) parts.push({ kind: 'text', text: text.slice(cursor, next.at) });
    parts.push({ kind: 'ref', ref: next.ref }); cursor = next.at + next.token.length;
  }
  return parts.length ? parts : [{ kind: 'text', text: '' }];
}
