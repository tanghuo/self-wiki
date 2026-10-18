// Keep presentation and provenance metadata in the persisted snapshot, outside model input.
export function organizationMaterial(context) {
  return {
    sourceId: context.sourceId,
    tags: context.tags.map((tag) => tag.name),
    tagAliases: context.tagAliases,
    relationVocabulary: context.relationVocabulary,
    relations: context.relations.map(({ sourceId, targetId, name, direction, reverseName }) => ({ sourceId, targetId, name, direction, reverseName })),
    elements: context.elements.map((e) => ({ id: e.id, kind: e.kind, body: e.body, tags: e.tags,
      ...(e.image?.originalName ? { filename: e.image.originalName } : {}),
      ...(e.kind === "video" ? { filename: e.video?.originalName, visualScope: "first-frame-only" } : {}),
      ...(e.bodyExcerpts?.length ? { bodyExcerpts: e.bodyExcerpts } : {}),
      ...(e.semanticDescription ? { semanticDescription: e.semanticDescription } : {}) })),
    truncated: context.truncated,
  };
}

// Reordering the same candidates or changing retrieval scores is not new evidence.
export function organizationEvidence(material) {
  return JSON.stringify(material.elements.toSorted((a, b) => a.id - b.id));
}
