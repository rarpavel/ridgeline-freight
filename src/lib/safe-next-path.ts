const DEFAULT_PATH = '/chat';
const BASE = 'http://local.invalid';

/**
 * Where to go after login. `next` comes from the URL, so anything that resolves off-site falls back
 * to the default. Resolving it the way a browser does also catches `/\host` and `/<tab>/host`.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next?.startsWith('/')) return DEFAULT_PATH;
  // `//` and `/\` parse as a URL with an empty host, which is invalid rather than off-site.
  const url = URL.parse(next, BASE);
  if (url?.origin !== BASE) return DEFAULT_PATH;
  return `${url.pathname}${url.search}${url.hash}`;
}
