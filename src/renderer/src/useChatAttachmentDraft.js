import { useEffect, useRef, useState } from "react";
import { apiUrl, request } from "./api.js";
import { chatAttachmentDrafts, chatImageDraft } from "../../shared/domain/chat.js";
import { markDraftPending, acknowledgeDraft } from "./chatDraftProtection.js";

export default function useChatAttachmentDraft(id, initial) {
  const key = `wikiChatAttachments:${apiUrl(`/api/chat/sessions/${id}`)}`;
  const [attachments, setValue] = useState([]), [ready, setReady] = useState(false);
  const current = useRef(null), [error, setError] = useState("");
  function backup() {
    try {
      const local = JSON.parse(localStorage.getItem(key));
      // Legacy arrays have no revision; import them only before a server draft exists.
      return Array.isArray(local) ? initial?.revision ? null : { attachments: chatAttachmentDrafts(local), revision: Date.now() } : chatImageDraft(local);
    } catch { return null; }
  }
  function removeBackup(revision) {
    try { if ((backup()?.revision || 0) <= revision) localStorage.removeItem(key); } catch { /* The server copy remains available. */ }
  }
  async function persist(value = current.current) {
    if (!value) throw new Error("图片附件草稿正在恢复，请稍候");
    if (value.revision === 0) return;
    markDraftPending(key, value.revision);
    try {
      const saved = chatImageDraft(await request(`/api/chat/sessions/${id}/image-draft`, { method: "PUT", body: JSON.stringify(value) }));
      if (JSON.stringify(saved) !== JSON.stringify(chatImageDraft(value))) throw new Error("图片草稿已在其他窗口修改，请重新打开会话");
      acknowledgeDraft(key, saved.revision);
      removeBackup(saved.revision);
      if (current.current.revision === value.revision) setError("");
    } catch (e) { if (current.current.revision === value.revision) setError(`图片附件草稿尚未保存：${e.message}`); throw e; }
  }
  useEffect(() => {
    if (!id || !initial || current.current) return;
    const local = backup(), value = local && local.revision > initial.revision ? local : initial;
    current.current = value; setValue(value.attachments); setReady(true);
    acknowledgeDraft(key, initial.revision);
    if (value === local) void persist(value).catch(() => {}); else removeBackup(initial.revision);
  }, [id, initial]);
  return { attachments, ready: !id || ready, error, flush: () => persist(), retry: () => { if (current.current) void persist().catch(() => {}); },
    accept(value) {
      if (value.revision < current.current.revision) return;
      current.current = value; setValue(value.attachments); setError(""); removeBackup(value.revision); acknowledgeDraft(key, value.revision);
    }, setAttachments(value) {
    if (!current.current) return;
    const next = { attachments: typeof value === "function" ? value(current.current.attachments) : value, revision: Math.max(Date.now(), current.current.revision + 1) };
    current.current = next; setValue(next.attachments);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* Server persistence remains available. */ }
    void persist(next).catch(() => {});
  } };
}
