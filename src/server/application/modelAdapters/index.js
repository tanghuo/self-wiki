import { createAdapterRegistry } from './registry.js';
import { grokTextAdapter, grokImageAdapter } from './grok.js';
import { comfyuiAdapter } from './comfyui.js';

export const modelAdapters = createAdapterRegistry([grokTextAdapter, grokImageAdapter, comfyuiAdapter]);
export { createAdapterRegistry, rejectSecrets } from './registry.js';
