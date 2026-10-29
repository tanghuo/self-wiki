import { createAdapterRegistry } from './registry.js';
import { grokTextAdapter, grokAgentAdapter, grokImageAdapter } from './grok.js';
import { comfyuiAdapter } from './comfyui.js';

export const modelAdapters = createAdapterRegistry([grokTextAdapter, grokAgentAdapter, grokImageAdapter, comfyuiAdapter]);
export { createAdapterRegistry, rejectSecrets } from './registry.js';
