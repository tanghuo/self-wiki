import { useEffect, useRef, useState } from "react";
import { apiUrl, request } from "./api.js";
import { randomUUID } from "./browserCrypto.js";
import { chatNewDraft } from "../../shared/domain/chat.js";
import { markDraftPending, acknowledgeDraft } from "./chatDraftProtection.js";

const empty = () => ({ text: "", revision: 1, sources: [], attachments: [] });
// Text is already stored in the draft. Every edit clears pending before it can be reused.
const pendingKey = ({ text, ...input }) => `input:${JSON.stringify(input)}`;

export default function useNewChatDraft() {
  const key = `wikiChatDraft:${apiUrl("/api/chat/sessions/new")}`;
  const url = "/api/chat/sessions/new/draft";
  const [value, setValue] = useState(empty), [ready, setReady] = useState(false);
  const current = useRef(value);
  const initialized = useRef(false);
  const clearAttempt = useRef(null);
  const [error, setError] = useState(""), [sending, setSending] = useState(false);
  function backup() {
    try {
      const saved = chatNewDraft(JSON.parse(localStorage.getItem(key)));
      if (saved.pending?.key.startsWith("{")) {
        const input = JSON.parse(saved.pending.key);
        if (input.text === (input.directImage ? saved.text : saved.text.trim())) saved.pending.key = pendingKey(input);
        else delete saved.pending;
      }
      return saved;
    } catch { return null; }
  }
  function removeBackup(revision) {
    try { if ((backup()?.revision || 0) <= revision) localStorage.removeItem(key); } catch { /* The server copy is durable. */ }
  }
  async function persist(next = current.current) {
    markDraftPending(key, next.revision);
    try {
      const saved = chatNewDraft(await request(url, { method: "PUT", body: JSON.stringify(next) }));
      if (JSON.stringify(saved) !== JSON.stringify(chatNewDraft(next)) && JSON.stringify(saved) !== JSON.stringify(clearAttempt.current && chatNewDraft(clearAttempt.current))) throw new Error("草稿已在其他窗口修改，请重新打开会话");
      acknowledgeDraft(key, saved.revision);
      removeBackup(saved.revision);
      if (current.current.revision === next.revision) setError("");
      return saved;
    } catch (e) {
      if (current.current.revision === next.revision) setError(`新会话草稿尚未保存：${e.message}`);
      throw e;
    }
  }
  async function load() {
    setError("");
    try {
      const saved = await request(url), local = backup();
      if (initialized.current) return;
      initialized.current = true;
      const next = local && local.revision > saved.revision ? local : saved;
      current.current = next; setValue(next); setReady(true);
      acknowledgeDraft(key, saved.revision);
      if (next === local) void persist(next).catch(() => {}); else removeBackup(saved.revision);
    } catch (e) { if (!initialized.current) setError(`无法恢复新会话草稿：${e.message}`); }
  }
  useEffect(() => { void load(); }, []);
  function change(patch) {
    if (!initialized.current) return;
    const next = chatNewDraft({ ...current.current, pending: undefined, ...patch, revision: Math.max(Date.now(), current.current.revision + 1) });
    current.current = next; setValue(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* The server saves each edit too. */ }
    void persist(next).catch(() => {});
  }
  return { ...value, ready, error, sending, setSending,
    setText: (text) => change({ text }),
    setSources: (sources) => change({ sources: typeof sources === "function" ? sources(current.current.sources) : sources }),
    setAttachments: (attachments) => change({ attachments: typeof attachments === "function" ? attachments(current.current.attachments) : attachments }),
    setModel: (model, effort) => change({ model, effort }),
    setDirectImage: (directImage) => change({ directImage }),
    setImageOptions: (imageOptions) => change({ imageOptions, directImage: imageOptions.direct }),
    flush: () => persist(), retry: () => { void (ready ? persist() : load()).catch(() => {}); },
    async prepare(payload) {
      const payloadKey = pendingKey(payload);
      if (current.current.pending?.key !== payloadKey) change({ model: payload.model, effort: payload.effort, imageOptions: payload.imageOptions, directImage: Boolean(payload.directImage), pending: { key: payloadKey, requestKey: randomUUID() } });
      await persist();
      return current.current.pending.requestKey;
    },
    async clear() {
      const next = { ...empty(), revision: Math.max(Date.now(), current.current.revision + 1) };
      clearAttempt.current = next;
      try { await persist(next); }
      catch (e) { acknowledgeDraft(key, next.revision); setError(`发送已接收，但清理草稿失败；重试不会重复发送：${e.message}`); throw e; }
      current.current = next; setValue(next); setError(""); removeBackup(next.revision);
    },
  };
}
