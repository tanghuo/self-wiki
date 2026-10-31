import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityTitle } from '../../src/renderer/src/features/agentWorkbench/workbenchActivity.js';

test('operation summaries distinguish ACP and Codex commands and retain search terms', () => {
  assert.equal(activityTitle({ title: 'Execute `git status --short`' }), '运行命令 · git status --short');
  assert.equal(activityTitle({ kind: 'commandExecution', title: 'npm run build' }), '运行命令 · npm run build');
  assert.equal(activityTitle({ kind: 'execute' }), '运行命令');
  assert.equal(activityTitle({ title: 'Search tools: "approval"' }), '搜索工具 · "approval"');
});
