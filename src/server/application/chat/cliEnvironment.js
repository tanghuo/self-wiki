// The library CLI only talks to the loopback server, so it gets the OS basics and none of the user's secrets.
const cliEnvironmentKeys = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ"]);
export function cliBaseEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => cliEnvironmentKeys.has(key.toUpperCase())));
}
