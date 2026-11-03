/**
 * THE host rule for a frame: which declared `externalHosts` the frame's policy
 * may name. Its own file, importing nothing, so both the policy
 * (`buildCellModuleFrameCsp`, `./frame.ts`) and the define-time cell check
 * (`checkCellSource`, `@synap-core/types/renderables`, a dependency-free leaf)
 * read the same parse: a host one keeps, the other keeps.
 */

/**
 * The origins an approved "connected" cell declared (`externalHosts`), as the
 * policy may name them: well-formed http(s)/ws(s) ORIGINS only. A wildcard
 * (`https://*` is a valid CSP source meaning every https origin), credentials,
 * a path, a query or anything unparseable is dropped: the value is spliced
 * into a directive, and dropping is fail-closed. Parsed, never pattern-matched.
 */
export function frameExternalOrigins(hosts: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of hosts) {
    const h = raw.trim();
    if (h.includes("*")) continue;
    let u: URL;
    try {
      u = new URL(h);
    } catch {
      continue;
    }
    if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) continue;
    if (!u.hostname || u.username || u.password) continue;
    if (u.pathname !== "/" || u.search || u.hash) continue;
    if (/[\s'";]/.test(u.origin)) continue;
    if (!out.includes(u.origin)) out.push(u.origin);
  }
  return out;
}
