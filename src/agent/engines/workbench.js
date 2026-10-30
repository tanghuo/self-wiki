import { openGrokWorkbench } from './grokWorkbench.js';
import { openCodexWorkbench } from './codexWorkbench.js';
import { openAntigravityWorkbench } from './antigravityWorkbench.js';

export function openWorkbenchEngine(settings, options) {
  if (options.engine === 'codex-cli') return openCodexWorkbench(settings, options);
  if (options.engine === 'antigravity-acp') return openAntigravityWorkbench(settings, options);
  if (!options.engine || options.engine === 'grok-build') return openGrokWorkbench(settings, options);
  throw new Error('未注册的工作台引擎');
}
