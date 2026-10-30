const lines = text => text.match(/[^\n]*\n|[^\n]+$/g) || [];

// Bound quadratic work. Large divergent files remain viewable as full versions,
// but must not be assigned invented line counts.
export function textDiff(before, after) {
  const a = lines(before), b = lines(after);
  if (a.length + b.length > 50000) return { added: null, removed: null, rows: [], unavailable: '文件行数过多，请查看修改前后全文' };
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1]) end++;
  const n = a.length - start - end, m = b.length - start - end;
  if ((n + 1) * (m + 1) > 2000000) return { added: null, removed: null, rows: [], unavailable: '差异过大，请查看修改前后全文' };
  const width = m + 1, table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i * width + j] = a[start + i] === b[start + j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  const operations = [];
  for (let i = 0; i < start; i++) operations.push(['context', a[i]]);
  let i = 0, j = 0, added = 0, removed = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) { operations.push(['context', a[start + i++]]); j++; }
    else if (i < n && (j === m || table[(i + 1) * width + j] >= table[i * width + j + 1])) { operations.push(['remove', a[start + i++]]); removed++; }
    else { operations.push(['add', b[start + j++]]); added++; }
  }
  for (let k = end; k > 0; k--) operations.push(['context', a[a.length - k]]);
  const shown = new Set();
  operations.forEach(([type], index) => { if (type !== 'context') for (let k = Math.max(0, index - 3); k <= Math.min(operations.length - 1, index + 3); k++) shown.add(k); });
  const rows = []; let oldLine = 1, newLine = 1, previous = -2;
  operations.forEach(([type, text], index) => {
    if (shown.has(index)) {
      if (index !== previous + 1) rows.push({ type: 'hunk', text: `@@ -${oldLine} +${newLine} @@` });
      rows.push({ type, text: text.replace(/\r?\n$/, ''), oldLine: type === 'add' ? null : oldLine, newLine: type === 'remove' ? null : newLine, noNewline: !text.endsWith('\n') });
      previous = index;
    }
    if (type !== 'add') oldLine++;
    if (type !== 'remove') newLine++;
  });
  return { added, removed, rows };
}

export function unifiedFiles(diff) {
  const files = []; let file, inHunk = false, oldLine = 0, newLine = 0;
  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git ')) { file = { path: text.slice(11).replace(/^a\/.* b\//, ''), rows: [], added: 0, removed: 0 }; files.push(file); inHunk = false; }
    if (!file) continue;
    if (text.startsWith('Binary files ') || text === 'GIT binary patch') { file.added = null; file.removed = null; file.rawDiff = text; }
    if (!inHunk && text.startsWith('+++ ') && text !== '+++ /dev/null') file.path = text.slice(4).replace(/^b\//, '');
    if (!inHunk && text.startsWith('--- ') && text !== '--- /dev/null' && !file.path) file.path = text.slice(4).replace(/^a\//, '');
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) { oldLine = Number(header[1]); newLine = Number(header[2]); inHunk = true; file.rows.push({ type: 'hunk', text }); continue; }
    if (inHunk && text.startsWith('\\ No newline') && file.rows.length) { file.rows.at(-1).noNewline = true; continue; }
    if (!inHunk || !/^[ +\-]/.test(text)) continue;
    const type = text[0] === '+' ? 'add' : text[0] === '-' ? 'remove' : 'context';
    file.rows.push({ type, text: text.slice(1), oldLine: type === 'add' ? null : oldLine++, newLine: type === 'remove' ? null : newLine++ });
    if (type === 'add') file.added++;
    if (type === 'remove') file.removed++;
  }
  return files;
}
