import { createHash } from 'node:crypto';
import path from 'node:path';

const displayVariables = {
  TERM: /^[\w.+-]{1,64}$/, COLORTERM: /^[\w.+-]{1,64}$/,
  FORCE_COLOR: /^(?:[0-3]|true|false)$/i, CLICOLOR: /^[01]$/, CLICOLOR_FORCE: /^[01]$/,
  NO_COLOR: /^(?:1|true)?$/i, CI: /^(?:[01]|true|false)$/i,
  NPM_CONFIG_PROGRESS: /^(?:[01]|true|false)$/i, PIP_PROGRESS_BAR: /^(?:on|off|raw|ascii|pretty|emoji)$/,
  CARGO_TERM_PROGRESS_WHEN: /^(?:auto|always|never)$/, CARGO_TERM_PROGRESS_WIDTH: /^\d{1,3}$/,
};
// Grok adds these to customize other runtimes. They are deliberately omitted
// from the effective operation; Java options can load code, not just color output.
const omittedVariables = new Set(['GRADLE_OPTS', 'MAVEN_OPTS', 'GROK_SESSION_ID']);
// Included in the displayed and hashed argv; avoids an opaque EncodedCommand.
export const powershellUtf8Prefix = '$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false);\n';

export function grokTerminalOperation(params, { shell, defaultCwd } = {}) {
  if (typeof params.command !== 'string' || !params.command.trim() || params.command.length > 32768 || params.command.includes('\0')) throw new Error('Invalid terminal command');
  if (params.args !== undefined && (!Array.isArray(params.args) || params.args.length > 256 || params.args.some(value => typeof value !== 'string' || value.length > 32768 || value.includes('\0')))) throw new Error('Invalid terminal arguments');
  const cwd = params.cwd ?? defaultCwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')) throw new Error('Terminal cwd must be absolute');
  if (params.env !== undefined && (!Array.isArray(params.env) || params.env.length > 64)) throw new Error('Invalid terminal environment');
  const environment = [], omittedEnvironment = [], names = new Set();
  for (const entry of params.env || []) {
    if (!entry || typeof entry.name !== 'string' || typeof entry.value !== 'string' || entry.value.length > 4096 || entry.value.includes('\0')) throw new Error('Invalid terminal environment');
    const name = entry.name.toUpperCase();
    if (names.has(name)) throw new Error('Duplicate terminal environment variable');
    names.add(name);
    if (omittedVariables.has(name)) { omittedEnvironment.push(name); continue; }
    if (!displayVariables[name]?.test(entry.value)) throw new Error(`Unsupported terminal environment variable: ${name.slice(0, 100)}`);
    environment.push(Object.freeze({ name, value: entry.value }));
  }
  environment.sort((a, b) => a.name.localeCompare(b.name)); omittedEnvironment.sort();
  // The caller explicitly chooses the interpretation. Never guess from spaces
  // in a program path and never attempt to split a shell language into argv.
  if (shell && (shell.dialect !== 'powershell' || !path.isAbsolute(shell.program) || (params.args?.length || 0) > 0)) throw new Error('Invalid explicit PowerShell operation');
  if (!shell && !path.isAbsolute(params.command)) throw new Error('Direct terminal program must be absolute');
  const operation = {
    mode: shell ? 'shell' : 'direct', dialect: shell ? 'powershell' : null,
    program: shell ? shell.program : params.command,
    args: Object.freeze(shell ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', powershellUtf8Prefix + params.command] : [...(params.args || [])]),
    cwd, environment: Object.freeze(environment), omittedEnvironment: Object.freeze(omittedEnvironment),
  };
  return Object.freeze({ ...operation, hash: createHash('sha256').update(JSON.stringify(operation)).digest('hex') });
}
