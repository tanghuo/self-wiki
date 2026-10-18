export function chatMessageParts(answer, events) {
  const parts = [];
  function append(part) {
    if (part.type === "text" && !part.text) return;
    const previous = parts.at(-1);
    if (part.name === "wiki-tool" && previous?.name === part.name) previous.data.push(...part.data);
    else parts.push(part);
  }
  if (events.some((e) => Number.isFinite(e.appearedAt))) {
    const entries = events.flatMap((event) => [
      ...(event.type === "text" ? [{ ...event, part: { type: "text", text: answer.slice(event.startOffset, event.endOffset) } }] : []),
      ...(event.command ? [{ ...event, part: { type: "data", name: "wiki-tool", data: [event] } }] : []),
      ...(event.artifact ? [{ ...event.imageAppearance, part: { type: "image", artifact: event.artifact } }] : []),
    ]);
    entries.sort((a, b) => (a.appearedAt ?? 0) - (b.appearedAt ?? 0) || (a.sequence ?? 0) - (b.sequence ?? 0));
    for (const { part } of entries) append(part);
    return parts.length ? parts : [{ type: "text", text: answer }];
  }
  // Historical records have no common timestamps. Retain their existing order.
  const offset = (value) => Number.isInteger(value) ? Math.max(0, Math.min(answer.length, value)) : answer.length;
  const entries = events.flatMap((event) => [
    ...(event.command ? [{ offset: offset(event.startedAnswerOffset), part: { type: "data", name: "wiki-tool", data: [event] } }] : []),
    ...(event.artifact ? [{ offset: offset(event.answerOffset), part: { type: "image", artifact: event.artifact } }] : []),
  ]).sort((a, b) => a.offset - b.offset);
  let cursor = 0;
  for (const event of entries) {
    if (event.offset > cursor) append({ type: "text", text: answer.slice(cursor, event.offset) });
    append(event.part);
    cursor = event.offset;
  }
  if (cursor < answer.length) append({ type: "text", text: answer.slice(cursor) });
  return parts.length ? parts : [{ type: "text", text: answer }];
}
