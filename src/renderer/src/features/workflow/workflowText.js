// Present editable text on both sides of each variable; leave bindings untouched.
export function editableTextParts(parts) {
  const result = [{ kind: 'text', text: '' }];
  for (const part of parts) {
    if (part.kind === 'text') result.at(-1).text += part.text;
    else result.push(part, { kind: 'text', text: '' });
  }
  return result;
}
