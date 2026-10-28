// Executables are launched by the local app, so they must resolve on this
// machine. UNC/network paths (\\server\share\tool.exe, //server/share) would
// let a configuration change run a program fetched from another host.
export function isNetworkPath(value) {
  return /^[\\/]{2}/.test(String(value).trim());
}

export function validExecutable(value, maxLength = 1000) {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= maxLength && !/[\r\n\0]/.test(value) && !isNetworkPath(value);
}
