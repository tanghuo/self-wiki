// Summaries describe the observed action. Keep the original text in the disclosure.
export function activityTitle(value) {
  const title = value.title || '';
  if (/^Search tools\s*:/i.test(title)) return '搜索工具';
  if (/^Execute\b/i.test(title) || ['execute', 'commandExecution'].includes(value.kind)) return '运行命令';
  if (value.kind === 'fileChange') return '修改文件';
  if (value.kind === 'dynamicToolCall' || value.kind === 'mcpToolCall') return title && title !== value.kind ? title : '调用工具';
  return title || '工具调用';
}

export function commandState(value) {
  return Number.isInteger(value.exitCode) ? value.exitCode === 0 ? 'completed' : 'failed' : 'unknown';
}
