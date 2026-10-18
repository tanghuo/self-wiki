// A saved Wiki snapshot serves provenance and UI needs. Only its content is an attachment.
export function chatReference(source) {
  if (source.kind === "image") return { kind: "image", filename: source.label };
  return { kind: "text", body: source.body };
}
