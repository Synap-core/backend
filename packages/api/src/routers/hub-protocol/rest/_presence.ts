/**
 * Proof of presence at a Hub door (review of 6 Nov 2026, W3).
 *
 * A Hub REST or Hub tRPC route that is the TWIN of a sensitive tRPC action
 * (`SENSITIVE_ACTIONS`) asks the same gate, for the same act, with a proof
 * bound to THIS call: `action:<the tRPC path>:<digest of the twin's input>`.
 * The twin's input is its body plus the route's id under the tRPC input's
 * name (`{ publicId, ...body }` for `/apps/:id/…`): the same input the tRPC
 * door takes, so a client asks `presence.challenge({ action: { path, input } })`
 * with the input it sends and puts the proof in the body's `presence`.
 *
 * Without a proof: `enforce` refuses (403, `code: PRESENCE_REQUIRED`); a key
 * caller (the CLI, an AI, a script) is told the person does it in pod admin;
 * `report` lets it through and records `presence.missing`. The gate's pass is
 * what the service behind the act requires (`services/presence/pass.ts`), so
 * a twin that skips this has nothing to hand it.
 */
import type { Context } from "hono";
import {
  presenceProofSchema,
  type PresenceProof,
  type SensitiveActionPath,
} from "@synap-core/types/presence";
import type { PresencePass } from "../../../services/presence/pass.js";
import {
  httpStatusForTrpcError,
  logger,
  type HubVariables,
} from "./_shared.js";

type HubContext = Context<{ Variables: HubVariables }>;

/**
 * The typed refusal an error carries (`cause.reasonCode`, e.g.
 * PRESENCE_REQUIRED), walked down the `.cause` chain as `createCaller` wraps
 * it: a Hub client reads `code` and asks for the proof, never the sentence.
 */
export function refusalReasonCode(err: unknown): string | undefined {
  let cursor: unknown = err;
  for (
    let depth = 0;
    cursor && typeof cursor === "object" && depth < 5;
    depth++
  ) {
    const code = (cursor as { reasonCode?: unknown }).reasonCode;
    if (typeof code === "string") return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

/** A Hub refusal's body: the sentence, and the typed code when there is one. */
export function refusalBody(
  err: unknown,
  fallback = "Unknown error"
): { error: string; code?: string } {
  const code = refusalReasonCode(err);
  return {
    error: err instanceof Error ? err.message : fallback,
    ...(code ? { code } : {}),
  };
}

/** Did a key (Bearer) authenticate this request, rather than a person's session? */
export function isHubKeyCaller(c: HubContext): boolean {
  return typeof c.get("apiKeyId") === "string";
}

/**
 * Ask the gate for a Hub twin of `action`. Returns the pass the service
 * behind the act requires, or the Response to send (400 for a malformed
 * proof, 403 with the code for a refusal).
 */
export async function gateHubTwin(
  c: HubContext,
  args: {
    /** The tRPC path of the act this route is the twin of. */
    action: SensitiveActionPath;
    /** The twin's input: its body plus the route's id (`presence` may ride in it). */
    input: Record<string, unknown>;
    /** This route, for the audit line (`POST /apps/:id/key`). */
    door: string;
  }
): Promise<PresencePass | Response> {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Unauthenticated" }, 403);
  let proof: PresenceProof | null = null;
  const sent = args.input.presence;
  if (sent !== undefined && sent !== null) {
    const parsed = presenceProofSchema.safeParse(sent);
    if (!parsed.success) {
      return c.json({ error: "`presence` is not a proof of presence." }, 400);
    }
    proof = parsed.data;
  }
  try {
    const { passPresenceForAction } =
      await import("../../../services/presence/gate.js");
    const { pass } = await passPresenceForAction({
      userId,
      path: args.action,
      input: args.input,
      proof,
      keyCaller: isHubKeyCaller(c),
      door: args.door,
    });
    return pass;
  } catch (err) {
    const status = httpStatusForTrpcError(err);
    if (status === 500) logger.error({ err }, `${args.door}: presence gate`);
    return c.json(refusalBody(err), status);
  }
}
