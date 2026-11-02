/**
 * Every Hub REST 403 that carries a denial of the calling key's grant says so
 * in a field a client can read: `code` and `reasonCode` `"GRANT_DENIED"`, and
 * the refused `action` (`workspace.update`). Before this, the body was only
 * the sentence `grantWriteDenial` writes, so the CLI matched its prefix
 * (finding: "a computer's key cannot apply any market update, and the CLI
 * cannot say why", 1 Nov 2026).
 *
 * ONE place, not each route: the sentence reaches the wire through dozens of
 * doors (`{ error: perm.reason }`, `{ error: denial }`, thrown and mapped
 * errors), and a field added door by door would fork the shape again. The
 * producer records each denial it returns during the request
 * (`runCollectingGrantDenials`, `utils/grant-write-check.ts`); after the route
 * answered, a 403 JSON body whose words carry one of THOSE sentences gains the
 * fields. A 403 for any other reason is left as it is, and a field the route
 * already set is never overwritten.
 */
import type { Context, MiddlewareHandler, Next } from "hono";
import {
  GRANT_DENIED,
  runCollectingGrantDenials,
  type GrantDenialRecord,
} from "../../../utils/grant-write-check.js";

/** The words a refusal body may carry the denial in. */
function bodyTexts(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const v of [body.error, body.message, body.detail, body.reason])
    if (typeof v === "string") out.push(v);
  const nested = body.error;
  if (nested && typeof nested === "object") {
    const m = (nested as { message?: unknown }).message;
    if (typeof m === "string") out.push(m);
  }
  return out;
}

/**
 * `body` with the structured denial fields, when its words carry a denial
 * produced during this request; null otherwise (the body is not a grant
 * denial, or names none of this request's).
 */
export function withGrantDenialCode(
  body: unknown,
  denials: readonly GrantDenialRecord[]
): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const texts = bodyTexts(b);
  const match = denials.find((d) => texts.some((t) => t.includes(d.message)));
  if (!match) return null;
  return {
    ...b,
    code: b.code ?? GRANT_DENIED,
    reasonCode: b.reasonCode ?? GRANT_DENIED,
    ...(b.action !== undefined || match.action !== undefined
      ? { action: b.action ?? match.action }
      : {}),
  };
}

export const grantDenialCodeMiddleware: MiddlewareHandler = async (
  c: Context,
  next: Next
) => {
  const denials: GrantDenialRecord[] = [];
  await runCollectingGrantDenials(denials, () => next());
  if (denials.length === 0 || c.res.status !== 403) return;
  if (!(c.res.headers.get("content-type") ?? "").includes("application/json"))
    return;
  let body: unknown;
  try {
    body = await c.res.clone().json();
  } catch {
    return;
  }
  const tagged = withGrantDenialCode(body, denials);
  if (!tagged) return;
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  // Cleared first: Hono's `res` setter otherwise copies the old response's
  // headers onto the new one (a stale content-length among them).
  c.res = undefined;
  c.res = new Response(JSON.stringify(tagged), { status: 403, headers });
};
