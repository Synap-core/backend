/**
 * Constrain `/login?return=` to a path on this origin, so a crafted link can't
 * bounce a freshly signed-in operator to an attacker's site.
 *
 * Prefix checks alone are not enough: browsers read `\` as `/` and drop tabs
 * and newlines inside a URL, so `/\evil.com` or `/<tab>/evil.com` start with a
 * single `/` and still leave the origin. The raw value is refused if it holds
 * either, then resolved against a fixed origin — anything that resolves
 * elsewhere is refused, and what is kept is the resolved path, never the raw
 * string.
 */
const BASE = "http://x";

export function safeReturnTo(raw: string | undefined): string {
  if (!raw || !raw.startsWith("/")) return "/";
  // eslint-disable-next-line no-control-regex -- control characters are the attack
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return "/";
  let url: URL;
  try {
    url = new URL(raw, BASE);
  } catch {
    return "/";
  }
  if (url.origin !== BASE) return "/";
  // `/login` itself would loop — send to the root instead.
  if (url.pathname === "/login") return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
