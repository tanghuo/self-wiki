// Lexical overlap only retrieves candidates. The organizer must compare full text
// before creating a relation, including negations, numbers and changed requirements.
export function textSimilarityCandidates(db, sourceId) {
  const source = db.prepare("SELECT body FROM elements WHERE id=? AND kind=1 AND deleted_at IS NULL AND local_only=0").get(sourceId);
  if (!source) return [];
  const normalize = (body) => body.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
  const grams = (body) => new Set(Array.from({ length: Math.max(0, body.length - 2) }, (_, i) => body.slice(i, i + 3)));
  const text = normalize(source.body), sourceGrams = grams(text), matches = [];
  if (text.length < 12) return matches;
  // Iterate rather than loading the entire library's bodies into memory.
  for (const row of db.prepare("SELECT id,body FROM elements WHERE kind=1 AND id<>? AND deleted_at IS NULL AND local_only=0").iterate(sourceId)) {
    const candidate = normalize(row.body);
    if (Math.min(text.length, candidate.length) / Math.max(text.length, candidate.length) < 0.55) continue;
    const candidateGrams = grams(candidate);
    let common = 0;
    for (const gram of candidateGrams) if (sourceGrams.has(gram)) common++;
    const score = 2 * common / (sourceGrams.size + candidateGrams.size);
    if (score < 0.5) continue;
    matches.push({ elementId: row.id, score });
    matches.sort((a, b) => b.score - a.score || a.elementId - b.elementId);
    if (matches.length > 8) matches.pop();
  }
  return matches;
}
