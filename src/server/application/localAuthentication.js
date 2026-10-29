import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const localCookieName = 'self_wiki_local';
const secret = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest();
function matches(candidate, expected) {
  return typeof candidate === 'string' && candidate.length <= 200 && timingSafeEqual(hash(candidate), hash(expected));
}
function cookieValue(req, name) {
  const pair = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  return pair?.slice(name.length + 1);
}
const authError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

// Per-process authority. Neither a bootstrap code nor a tool token is a management bearer.
export function createLocalAuthentication({ now = Date.now } = {}) {
  const managementToken = secret(), cookieToken = secret(), codes = new Map(), workers = new Set();
  // Cookies are scoped by host rather than port; separate local instances must coexist.
  const cookieName = `${localCookieName}_${randomBytes(8).toString('hex')}`;
  return {
    managementHeaders: () => ({ authorization: `Bearer ${managementToken}` }),
    credential: () => managementToken,
    createBootstrapCode() {
      for (const [key, deadline] of codes) if (deadline <= now()) codes.delete(key);
      if (codes.size >= 16) codes.delete(codes.keys().next().value);
      const code = secret(); codes.set(hash(code).toString('hex'), now() + 60000); return code;
    },
    redeem(code) {
      if (typeof code !== 'string' || code.length > 200) throw authError(401, '本机配对码无效或已过期');
      const key = hash(code).toString('hex'), deadline = codes.get(key);
      codes.delete(key);
      if (!deadline || deadline <= now()) throw authError(401, '本机配对码无效或已过期');
      return `${cookieName}=${cookieToken}; Path=/; HttpOnly; SameSite=Strict`;
    },
    isManagement(req) {
      return matches(req.headers.authorization, `Bearer ${managementToken}`) || matches(cookieValue(req, cookieName), cookieToken);
    },
    createWorkerCredential() { const token = secret(); workers.add(token); return token; },
    revokeWorkerCredential(token) { workers.delete(token); },
    isWorker(req, url) {
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      if (!token || !workers.has(token)) return false;
      // The organizer worker gets its lease protocol and read-only media, never settings or adoption.
      return req.method === 'POST' && (/^\/api\/organization\/(claim|worker-state)$/.test(url.pathname)
        || /^\/api\/organization\/jobs\/[1-9]\d*\/(heartbeat|context|submit|fail)$/.test(url.pathname))
        || req.method === 'GET' && (url.pathname === '/api/organization/status'
          || /^\/api\/elements\/[1-9]\d*\/(thumbnail|video-first-frame)$/.test(url.pathname));
    },
  };
}
