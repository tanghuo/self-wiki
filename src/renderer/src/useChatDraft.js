import { useEffect, useRef, useState } from "react";
import { apiUrl, request } from "./api.js";
import { chatComposerDraft } from "../../shared/domain/chat.js";
import { markDraftPending, acknowledgeDraft } from "./chatDraftProtection.js";

function readBackup(key) {
  try { return chatComposerDraft(JSON.parse(localStorage.getItem(key))); }
  catch { return null; }
}

export default function useChatDraft(id, initial) {
  const key = `wikiChatDraft:${apiUrl(`/api/chat/sessions/${id}`)}`;
  const current = useRef(null);
  const [text, setValue] = useState(""), [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false), [error, setError] = useState("");

  function removeBackup(revision) {
    try { if ((readBackup(key)?.revision ?? 0) <= revision) localStorage.removeItem(key); }
    catch { /* Server persistence remains available without browser storage. */ }
  }
  async function persist(value) {
    // A never-edited session draft is already stored with revision zero.
    if (value.revision === 0 && value.text === "") return;
    markDraftPending(key, value.revision);
    setSaving(true); setError("");
    try {
      const saved = await request(`/api/chat/sessions/${id}/draft`, { method: "PUT", body: JSON.stringify(value) });
      if (current.current.revision !== value.revision) return;
      if (saved.revision !== value.revision || saved.text !== value.text) throw new Error("草稿已在其他窗口修改，请重新打开会话");
      acknowledgeDraft(key, saved.revision);
      removeBackup(saved.revision); setSaving(false);
    } catch (e) {
      if (current.current.revision === value.revision) { setSaving(false); setError(e.message); }
      throw e;
    }
  }
  useEffect(() => {
    if (!id || !initial || current.current) return;
    const backup = readBackup(key);
    const value = backup && backup.revision > initial.revision ? backup : initial;
    current.current = value; setValue(value.text); setReady(true);
    acknowledgeDraft(key, initial.revision);
    if (value === backup) void persist(value).catch(() => {});
    else removeBackup(initial.revision);
  }, [initial, key]);

  function setText(value) {
    if (!current.current || value === current.current.text) return;
    // Each edit is saved immediately; revisions also order requests arriving after a reload or send.
    const draft = { text: value, revision: Math.max(Date.now(), current.current.revision + 1) };
    current.current = draft; setValue(value);
    try { localStorage.setItem(key, JSON.stringify(draft)); }
    catch { /* The durable copy is saved by the local server below. */ }
    void persist(draft).catch(() => {});
  }
  function accept(saved) {
    if (saved.revision < current.current.revision) return;
    current.current = saved; setValue(saved.text); setSaving(false); setError(""); removeBackup(saved.revision); acknowledgeDraft(key, saved.revision);
  }
  return { text, ready, saving, error, setText, accept,
    flush: () => persist(current.current), retry: () => { void persist(current.current).catch(() => {}); } };
}
