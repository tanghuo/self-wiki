const KEY = 'workbenchLastModel';

function storageOf(storage) {
  return storage || globalThis.localStorage;
}

export function readLastModels(storage) {
  try {
    const parsed = JSON.parse(storageOf(storage).getItem(KEY) || '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([engine, model]) => {
      if (typeof engine !== 'string' || !engine.trim() || typeof model !== 'string' || !model.trim()) return [];
      return [[engine, model.trim().slice(0, 120)]];
    }));
  } catch {
    return {};
  }
}

export function rememberedModel(engine, storage) {
  if (typeof engine !== 'string' || !engine) return '';
  return readLastModels(storage)[engine] || '';
}

export function rememberModel(engine, model, storage) {
  if (typeof engine !== 'string' || !engine.trim() || typeof model !== 'string' || !model.trim()) return;
  const target = storageOf(storage);
  if (!target) return;
  const next = { ...readLastModels(target), [engine]: model.trim().slice(0, 120) };
  try { target.setItem(KEY, JSON.stringify(next)); } catch { /* keep the in-memory choice when storage is unavailable */ }
}

export function preferredModel(engine, { current = '', models = [], sessionModel = '', defaultModel = '' } = {}, storage) {
  if (typeof current === 'string' && current) return current;
  const remembered = rememberedModel(engine, storage);
  if (remembered) return remembered;
  if (typeof sessionModel === 'string' && sessionModel.trim()) return sessionModel.trim();
  if (typeof defaultModel === 'string' && defaultModel) return defaultModel;
  return models[0]?.id || '';
}
