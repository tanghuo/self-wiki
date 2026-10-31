import RelationFields from "./RelationFields.jsx";
import { useState } from "react";
import { Save } from "lucide-react";
import { DialogFrame } from "./ui/ConfirmDialog.jsx";
import { request } from "./api.js";
import { Button } from "./ui/Button.jsx";

export default function RelationRenameDialog({ relation, relations, currentId, busy, onBusyChange, onClose, onSaved }) {
  const swapped = currentId !== undefined && Number(currentId) !== relation.sourceId;
  const relativeDirection = swapped && ["forward", "reverse"].includes(relation.direction) ? (relation.direction === "forward" ? "reverse" : "forward") : relation.direction || "symmetric";
  const [semantics, setSemantics] = useState({ name: relation.name || "", direction: relativeDirection, reverseName: relation.reverseName || "" });
  const { name } = semantics;
  const setName = (name) => setSemantics((previous) => ({ ...previous, name }));
  const [error, setError] = useState("");
  const batch = relations?.length > 1;
  const title = batch ? "批量重命名关联" : "重命名关联";
  const tags = [...new Set((relations || [relation]).map((entry) => entry.targetTag).filter(Boolean))];
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    onBusyChange(true); setError("");
    try {
      const path = batch ? "/api/relations/batch" : `/api/${relation.targetTag ? "tag-relations" : "relations"}/${relation.tagRelationId || relation.id}`;
      const body = batch ? { name,
        ids: relations.filter((entry) => !entry.tagRelationId).map((entry) => entry.id),
        tagRelationIds: [...new Set(relations.filter((entry) => entry.tagRelationId).map((entry) => entry.tagRelationId))],
      } : relation.type === "title" || semantics.direction === "unknown" ? { name } : { ...semantics,
        direction: swapped && ["forward", "reverse"].includes(semantics.direction) ? (semantics.direction === "forward" ? "reverse" : "forward") : semantics.direction,
      };
      await request(path, {
        method: "PATCH", body: JSON.stringify(body),
      });
      onSaved();
    } catch (failure) { setError(failure.message); }
    finally { onBusyChange(false); }
  }
  return <DialogFrame bare title={title} className="wiki-dialog" closeLabel="关闭重命名" busy={busy} onClose={onClose} onSubmit={submit}
    footer={<><button type="button" disabled={busy} onClick={onClose}>取消</button><Button variant="primary" type="submit" disabled={busy}><Save size={16} />{busy ? "正在保存…" : batch ? "保存全部" : "保存"}</Button></>}>
      <div className="wiki-form-fields">
        {batch && <p className="wiki-muted">将修改这组的 {relations.length} 条关联。</p>}
        {batch || relation.type === "title" ? <label>关联名称<input autoFocus value={name} maxLength={60} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
          : <RelationFields defaultSimple={false} nameLabel="关联名称" value={semantics} onChange={setSemantics} disabled={busy} currentLabel={currentId === undefined ? `内容 #${relation.sourceId}` : "当前内容"} targetLabel={relation.targetTag ? `#${relation.targetTag} 下的内容` : currentId === undefined ? `内容 #${relation.targetId}` : "对方内容"} />}
        <p className="wiki-muted">{batch ? "仅修改正向名称，每条关系的方向和反向名称保持不变。" : "双向同名关系可留空；有方向的关系需填写两端名称。"}</p>
        {tags.length > 0 && <p className="wiki-muted">此修改会应用到 {tags.map((tag) => `#${tag}`).join("、")} 下所有内容的对应标签关联，包括未在当前画布显示的内容及以后加入的内容。</p>}
        {error && <p className="wiki-error" role="alert">{error}</p>}
      </div>
  </DialogFrame>;
}
