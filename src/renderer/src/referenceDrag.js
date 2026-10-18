export const REFERENCE_DRAG_TYPE = "application/x-self-wiki-reference";

export function readReferenceDrag(dataTransfer) {
  try {
    const source = JSON.parse(dataTransfer.getData(REFERENCE_DRAG_TYPE));
    if (Number.isSafeInteger(source?.id) && source.id > 0 && ["image", "text"].includes(source.kind) && typeof source.label === "string") return source;
  } catch { /* Ignore unrelated or malformed drag payloads. */ }
  return null;
}
