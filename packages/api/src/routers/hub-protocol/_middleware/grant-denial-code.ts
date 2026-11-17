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
 *
 * A refusal says when it can be ASKED for (plan 647ebfd4 rule 6): when the
 * refused key is a pod app's and its document declares a permission covering
 * the refused write in that space (`askableDenial`), the body also carries
 * `askable: true` and `ask: { permission, workspaceId }`, the pair to send to
 * `POST /apps/access-requests`. The same for an agent's own key whose limits
 * include the refused permission (`askableAgentDenial`): the pair to send to
 * `POST /agents/access-requests`. Nothing else changes: an empty list read
 * stays an empty list, and no other refusal gains the field.
 */
import type { Context, MiddlewareHandler, Next } from "hono";
import { createLogger } from "@synap-core/core";
import {
  GRANT_DENIED,
  runCollectingGrantDenials,
  type GrantDenialRecord,
} from "../../../utils/grant-write-check.js";

const logger = createLogger({ module: "grant-denial-code" });

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
  denials: readonly GrantDenialRecord[],
  /** The askable pair for a denial (`askableDenial`); none when omitted. */
  ask?: (
    denial: GrantDenialRecord
  ) => { permission: string; workspaceId: string } | null
): Record<string, unknown> | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const texts = bodyTexts(b);
  const match = denials.find((d) => texts.some((t) => t.includes(d.message)));
  if (!match) return null;
  const pair = ask?.(match) ?? null;
  return {
    ...b,
    code: b.code ?? GRANT_DENIED,
    reasonCode: b.reasonCode ?? GRANT_DENIED,
    ...(b.action !== undefined || match.action !== undefined
      ? { action: b.action ?? match.action }
      : {}),
    ...(pair && b.askable === undefined ? { askable: true, ask: pair } : {}),
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
  // Askable only with a space named, for an app's key (one read of the app's
  // document) or an agent's own key (one read of the key and the agent's
  // limits), never for any other refusal.
  const asks = new Map<
    GrantDenialRecord,
    { permission: string; workspaceId: string } | null
  >();
  const apiKeyId = c.get("apiKeyId" as never) as string | undefined;
  const callerUserId = c.get("userId" as never) as string | undefined;
  for (const d of denials) {
    if (!d.workspaceId) continue;
    let hint: Promise<{ permission: string; workspaceId: string } | null>;
    if (d.clientId) {
      const { askableDenial } =
        await import("../../../services/app-access-ask.js");
      hint = askableDenial(d);
    } else if (apiKeyId && callerUserId) {
      const { askableAgentDenial } =
        await import("../../../services/agent-access-ask.js");
      hint = askableAgentDenial({ ...d, apiKeyId, callerUserId });
    } else continue;
    // The hint failing must not turn the refusal into a 500: the refusal is
    // still sent, without `askable`, and the failure is logged.
    asks.set(
      d,
      await hint.catch((err: unknown) => {
        logger.warn({ err }, "askable hint unavailable for a grant denial");
        return null;
      })
    );
  }
  const tagged = withGrantDenialCode(body, denials, (d) => asks.get(d) ?? null);
  if (!tagged) return;
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  // Cleared first: Hono's `res` setter otherwise copies the old response's
  // headers onto the new one (a stale content-length among them).
  c.res = undefined;
  c.res = new Response(JSON.stringify(tagged), { status: 403, headers });
};
