// Chat and workflow share these in-process limits. Grok can run several
// requests together; each other key, such as one ComfyUI server, stays at one.
export const externalResourceLimits = Object.freeze({ total: 10, perKey: 1, keys: Object.freeze({ grok: 10 }), loopInFlight: 10 });
export const externalKeyLimit = (key) => externalResourceLimits.keys[key] ?? externalResourceLimits.perKey;
