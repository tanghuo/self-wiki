import { relationLabel } from "../../shared/domain/elements.js";
import { useState } from "react";
import { request } from "./api.js";

export default function TagRelations({ relations = [], busy, readOnly, onChanged }) {
  const [removing, setRemoving] = useState(null);
  const [error, setError] = useState("");
  async function remove(id) {
    if (removing !== null || busy) return;
    setRemoving(id); setError("");
    try { await request(`/api/tag-relations/${id}`, { method: "DELETE" }); onChanged(); }
    catch (failure) { setError(failure.message); }
    finally { setRemoving(null); }
  }
  if (!relations.length) return null;
  return <div className="wiki-tag-relations" aria-label="作用于 tag 的关联">
    <p className="wiki-muted">当前内容作用于以下 tag 的所有成员（排除自己）：</p>
    {relations.map((relation) => <div key={relation.id}><span>{relationLabel(relation, relation.sourceId)}</span>
      {!readOnly && <button className="text-button" disabled={busy || removing !== null} onClick={() => remove(relation.id)} aria-label={`解除标签关联：${relation.targetTag}：${relation.name || "普通关联"}`}>解除整个 tag 的关联</button>}
    </div>)}
    {error && <p className="wiki-error" role="alert">{error}</p>}
  </div>;
}
