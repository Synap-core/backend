/**
 * ONE rule for privileged scopes: a key never carries authority its minter or
 * holder could not exercise themselves.
 *
 * WHAT IT CLOSES (pre-launch audit, 2026-10-28). `PRIVILEGED_MINT_SCOPES`
 * (`@synap/database/schema`) was consulted only by `/setup/agent` and
 * `/setup/service` for SURFACE keys. The tRPC mint doors (`apiKeys.create`,
 * `createForWorkspace`, `rotate`) accepted every scope in `API_KEY_SCOPES`, so
 * any signed-in member could mint `setup.agent` and then, through
 * `/setup/agent {linkedUserId: <another human>}`, an active agent key that
 * reads as that human; or `providers.write` and repoint the pod's AI provider,
 * a write whose tRPC door is pod-admin only.
 *
 * THE RULE. The privileged scopes are what a pod admin does. So:
 *  - a door that mints CALLER-DECLARED scopes refuses a privileged one unless
 *    the minter is a pod admin (`privilegedScopesBeyond`);
 *  - a door that honours a privileged scope on a PRESENTED key honours it only
 *    while the key's human is a pod admin (`mayExercisePrivilegedScopes`), so a
 *    key minted before this rule, or kept by a person no longer admin, confers
 *    nothing.
 *
 *  - a door that mints one for a PERSON SESSION also asks for a fresh
 *    credential, whatever the session kind (`assertFreshForPrivilegedMint`):
 *    the generic credential step-up (`utils/device-session.ts`) constrains
 *    only a phone's device session, so a stale or stolen browser session of a
 *    pod admin minted `setup.agent` with no prompt (audit F7 addendum).
 *
 * Doors whose scopes are SERVER-CHOSEN (the computer's `box.runner`, which its
 * person turns on for their own computer; the agent bundle) are not caller
 * declarations and do not come through here.
 */
import { TRPCError } from "@trpc/server";
import { isLocalModeEnabled } from "@synap/auth";
import { isPrivilegedMintScope } from "@synap/database/schema";
import { isPodAdmin } from "../utils/workspace-role.js";
import {
  assertFreshAuthentication,
  isDeviceSession,
  STEP_UP_REQUIRED,
  STEP_UP_WINDOW_MS,
  type SessionKindCarrier,
} from "../utils/device-session.js";

/**
 * May this human exercise a privileged scope? A pod admin may. A FAILED
 * membership read throws (from `isPodAdmin`), never reads as "no".
 */
export async function mayExercisePrivilegedScopes(
  userId: string | null | undefined
): Promise<boolean> {
  if (!userId) return false;
  return isPodAdmin(userId);
}

/**
 * The privileged scopes in `scopes` that `minterUserId` may NOT put on a key.
 * Empty = the mint may proceed. Reads the admin membership only when a
 * privileged scope is asked for.
 */
export async function privilegedScopesBeyond(
  minterUserId: string | null | undefined,
  scopes: readonly string[]
): Promise<string[]> {
  const privileged = scopes.filter((s) => isPrivilegedMintScope(s));
  if (privileged.length === 0) return [];
  return (await mayExercisePrivilegedScopes(minterUserId)) ? [] : privileged;
}

/** The refusal sentence every door uses. */
export function privilegedMintRefusal(privileged: readonly string[]): string {
  return (
    `Only a pod admin can create a key with ${privileged.join(", ")}. ` +
    `Ask a pod admin to create it, or leave ${privileged.length > 1 ? "these scopes" : "this scope"} out.`
  );
}

/** What a mint door knows about its caller's session (a tRPC context). */
export interface PrivilegedMintCaller extends SessionKindCarrier {
  session?:
    | ({ authenticated_at?: string | null } & NonNullable<
        SessionKindCarrier["session"]
      >)
    | null;
  /** Set on a context a KEY authenticated (Hub tRPC, MCP). */
  apiKeyId?: string | null;
  isHubProtocol?: boolean | null;
}

export const PRIVILEGED_MINT_STEP_UP_MESSAGE =
  "Sign in again to confirm it's you, then create this key: a key with these scopes needs a sign-in from the last 15 minutes.";

/**
 * A privileged mint needs a FRESH credential, for every session kind:
 *  - a Synap app's device session: its step-up clock (`assertFreshAuthentication`);
 *  - a browser (Kratos) session: signed in within `STEP_UP_WINDOW_MS`, the
 *    same 15 minutes as Kratos' own `privileged_session_max_age`. Local mode
 *    presents its operator token on every request, so it is always fresh;
 *  - a context a KEY authenticated: never. A key mints privileged scopes only
 *    through the operator doors of `/setup/*`, which hold their own rule.
 * A context with no session and no key is an approved proposal replayed in
 * process as its approver (`executors/workspace.ts` `apiKey/create`): the
 * approval is the person's act, judged at the approval door.
 * Refusal: FORBIDDEN, `reasonCode: STEP_UP_REQUIRED`.
 */
export function assertFreshForPrivilegedMint(
  ctx: PrivilegedMintCaller | null | undefined,
  now: number = Date.now()
): void {
  if (isDeviceSession(ctx)) {
    assertFreshAuthentication(ctx);
    return;
  }
  const refuse = (message: string): never => {
    throw new TRPCError({
      code: "FORBIDDEN",
      message,
      cause: { reasonCode: STEP_UP_REQUIRED },
    });
  };
  if (ctx?.session) {
    if (isLocalModeEnabled()) return;
    const at = ctx.session.authenticated_at
      ? Date.parse(ctx.session.authenticated_at)
      : NaN;
    const age = now - at;
    if (Number.isFinite(at) && age >= 0 && age <= STEP_UP_WINDOW_MS) return;
    refuse(PRIVILEGED_MINT_STEP_UP_MESSAGE);
  }
  if (ctx?.apiKeyId || ctx?.isHubProtocol) {
    refuse(
      "A key cannot create a key with these scopes. Create it from your signed-in session."
    );
  }
}
