import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const rejectedTokens = new Map();
export const codexAuthError = () => Object.assign(new Error("Codex 登录已失效，任务已暂停；请在本机 Codex 中恢复登录，后台将自动继续。独立认证目录需在该目录重新登录。"), { code: "AUTH_REQUIRED", retryable: false });
export const isCodexAuthError = (message) => /refresh_token_reused|token_expired|refresh token (?:was |has )?already (?:been )?used|access token.*could not be refreshed|authentication token is expired|please (?:log out and )?sign in again|401 Unauthorized|unauthorized|authentication required/i.test(String(message || ""));
const fingerprint = (token) => createHash("sha256").update(token).digest("hex");

async function authFile(home) {
  try { return JSON.parse(await readFile(path.join(home, "auth.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw codexAuthError(); }
}

// Desktop owns refresh tokens. Wiki receives only a short-lived access token,
// via app-server's external-auth protocol; it must never refresh a copied login.
export async function localCodexAuth(config) {
  const home = config.codexCli.codexHome;
  const source = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  if (!home || !config.codexCli.reuseLocalAuth || path.resolve(home) === source) return null;
  const [auth, previous] = await Promise.all([authFile(source), authFile(home)]);
  if (previous?.auth_mode === "chatgpt" && previous.tokens?.account_id !== auth?.tokens?.account_id) throw codexAuthError();
  if (auth?.auth_mode !== "chatgpt") return null;
  const token = auth.tokens?.access_token, account = auth.tokens?.account_id;
  let claims;
  try { claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")); } catch { throw codexAuthError(); }
  if (!account || !Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now() + 60000 || rejectedTokens.get(source) === fingerprint(token)) throw codexAuthError();
  return { accessToken: token, chatgptAccountId: account };
}

export function rejectLocalCodexAuth(auth) {
  if (auth) rejectedTokens.set(path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex")), fingerprint(auth.accessToken));
}
