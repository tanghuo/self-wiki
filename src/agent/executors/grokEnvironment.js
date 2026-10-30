import { childEnvironment } from '../../shared/runtime/childEnvironment.js';

// Grok uses the local Clash listener independently of Windows system proxy/TUN.
// Keep proxy credentials and unrelated parent environment variables filtered.
export function grokEnvironment(env = process.env) {
  const proxy = 'http://127.0.0.1:7890';
  return {
    ...childEnvironment(env),
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy,
    http_proxy: proxy, https_proxy: proxy, all_proxy: proxy,
  };
}
