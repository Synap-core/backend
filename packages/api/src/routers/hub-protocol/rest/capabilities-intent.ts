/**
 * Hub Protocol REST — the INTENT form of the two capability doors, for a key
 * the grant fence bounds (a pod app's agent key or a person's app token;
 * intent actions, decision 3A, founder 2026-10-28).
 *
 * Such a key reaches `GET /capabilities/actions` and `POST /capabilities/execute`
 * only for an intent its grant names (`capability.<intent>.run`, admitted by
 * `access/grant-door-fence.ts`), and only in a space its grant covers. It sees
 * the intent's actions in the pod's words (`services/capabilities/
 * intent-actions.ts`) and asks one to run with the intent's ONE input; it never
 * names a verb, a skill or a verb's parameters. A key the fence does not bound
 * (a signed-in session, an unbounded `*` key) keeps both doors as they were.
 *
 * Refusals carry a `code` an app can branch on: INTENT_REQUIRED, UNKNOWN_INTENT,
 * GRANT_DENIED, INTENT_MISMATCH, INVALID_INPUT, ACTION_NOT_FOUND, RATE_LIMITED.
 */
import { z } from "@hono/zod-openapi";
import { getRequestGrant } from "@synap/database";
import { INTENT_SLUG_RE } from "@synap/database/schema";
import { isFencedGrant } from "../../../access/grant-door-fence.js";
import { grantWriteDenial } from "../../../utils/grant-write-check.js";
import { assertUserRateLimit } from "../../../middleware/ai-rate-limit.js";
import {
  intentError,
  isKnownIntent,
} from "../../../services/capabilities/intent-registry.js";
import { errCode, resolveActingContext } from "./_shared.js";

/** Is this request's key bounded by the fence (so it takes the intent form)? */
export function takesIntentForm(): boolean {
  return isFencedGrant(getRequestGrant());
}

/** One action as a pod app reads it (`IntentActionView`). */
export const IntentActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  tool: z.string(),
  connection: z
    .object({ provider: z.string().nullable(), account: z.string().nullable() })
    .nullable(),
  governance: z.enum(["auto", "propose"]),
  intent: z.string(),
  input: z.record(z.string(), z.unknown()),
});

/** The run body of the intent form: nothing else is accepted from such a key. */
export const IntentRunRequestSchema = z
  .object({
    workspaceId: z.string().uuid(),
    intent: z.string().regex(INTENT_SLUG_RE),
    actionId: z.string().min(1).max(200),
    input: z.record(z.string(), z.unknown()),
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .strict();

/** An outward intent's runs per key per intent: every one files a review. */
export const INTENT_RUN_LIMIT = { max: 30, windowMs: 3_600_000 } as const;

type Refusal = { status: 400 | 403 | 404 | 429; body: Record<string, unknown> };

export const refusal = (
  status: Refusal["status"],
  code: string,
  error: string,
  extra: Record<string, unknown> = {}
): Refusal => ({ status, body: { error, code, ...extra } });

/**
 * The checks both doors make before anything is listed or run: an intent, a
 * known one, the grant's `capability.<intent>.run` in that space (named by the
 * door from the intent asked, never by the key), and the caller's own reach.
 */
export async function admitIntent(
  c: { get: (k: string) => unknown },
  workspaceId: string,
  intent: string | undefined
): Promise<
  | { ok: true; userId: string; workspaceId: string; intent: string }
  | ({ ok: false } & Refusal)
> {
  if (!intent)
    return {
      ok: false,
      ...refusal(
        400,
        "INTENT_REQUIRED",
        "This key may only ask for an intent's actions: pass `intent`."
      ),
    };
  if (!INTENT_SLUG_RE.test(intent) || !(await isKnownIntent(intent)))
    return {
      ok: false,
      ...refusal(400, "UNKNOWN_INTENT", intentError(intent)),
    };
  const denied = await grantWriteDenial({
    subjectType: "capability",
    action: "run",
    workspaceId,
    data: { intent },
  });
  if (denied) return { ok: false, ...refusal(403, "GRANT_DENIED", denied) };
  const acting = await resolveActingContext(c, { workspaceId });
  if (!acting.ok)
    return {
      ok: false,
      ...refusal(acting.status, "GRANT_DENIED", acting.error),
    };
  return {
    ok: true,
    userId: acting.userId,
    workspaceId: acting.workspaceId ?? workspaceId,
    intent,
  };
}

/**
 * Count one run of an outward intent for this key; a refusal once the key
 * passed {@link INTENT_RUN_LIMIT} for that intent. The shared per-door limiter
 * (`assertUserRateLimit`), keyed by the calling key and the intent.
 */
export function intentRunRateLimit(
  keyId: string,
  intent: string
): Refusal | null {
  try {
    assertUserRateLimit(`key:${keyId}`, {
      name: `intent-run:${intent}`,
      ...INTENT_RUN_LIMIT,
    });
    return null;
  } catch (err) {
    if (errCode(err) !== "TOO_MANY_REQUESTS") throw err;
    const retryAfter =
      (err as { cause?: { resetIn?: number } }).cause?.resetIn ??
      Math.ceil(INTENT_RUN_LIMIT.windowMs / 1000);
    return refusal(
      429,
      "RATE_LIMITED",
      `This app asked for "${intent}" too often. Try again in ${retryAfter} seconds.`,
      { retryAfter }
    );
  }
}
