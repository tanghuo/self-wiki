// CLIs load authentication from their own user directory. Keep application
// management credentials, unrelated provider keys and proxy passwords out.
const keys = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'USERNAME', 'USERDOMAIN', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'GROK_HOME', 'CODEX_HOME']);
export function childEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => keys.has(key.toUpperCase())));
}
