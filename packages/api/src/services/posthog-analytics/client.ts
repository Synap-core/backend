/**
 * posthog-analytics — the credentialed read client.
 *
 * ONE outbound chokepoint: `triggerProviderAction` (the pod's single
 * credentialed-provider dispatcher). It is reused rather than re-implemented so
 * this capability inherits, unchanged:
 *   - VAULT RESOLUTION. The secret is a `vault://<id>` ref on the installed
 *     `posthog_api` tool. It is decrypted under the ONE vault policy
 *     (owner/pod-wide → ungated, delegated → grant-gated) and never logged, never
 *     returned, and never placed in a result.
 *   - A FIXED DESTINATION. `config.baseUrl` is composed server-side and WINS over
 *     the path; an absolute path a caller somehow reached is stripped. The host
 *     and project id were fixed at install time from the package's params.
 *   - THE SSRF GUARD (`validateExternalUrl`) on the composed URL.
 *   - STRUCTURED FAILURE. A non-2xx comes back as `{success:false, status,
 *     errorCode, error}` with PostHog's own message, not a bare `success:false`.
 *
 * GOVERNANCE. `alreadyApproved: true` is passed deliberately.
 *
 * The capability gate in `executeCapability` has ALREADY decided this run: every
 * verb this client serves is registered in `READ_ONLY_BUILTIN_VERBS`, which is
 * the hand-audited "reading only, auto-run" registry, so an agent's analytics
 * READ must not be re-litigated into a human approval one frame down. This is
 * the SAME contract `execute-provider-verb.ts` applies to a GET read
 * (`alreadyApproved: isReadMethod`); a HogQL read is a POST because that is
 * PostHog's API shape, not because it mutates anything. The write verbs of the
 * capability — there are none — would NOT be in that set.
 *
 * FAILURE IS AN ERROR, NEVER AN EMPTY RESULT. Every non-success path throws
 * `PostHogReadError` carrying a message a human or an agent can act on. A 401 is
 * reported as a credential problem with the remedy named, not as "no data".
 */

import {
  triggerProviderAction,
  type FailureErrorClass,
  type TriggerProviderActionResult,
} from "../../connectors/external-dispatch.js";
import {
  POSTHOG_API_TOOL_NAME,
  PostHogQueryError,
  type PostHogRequest,
} from "./query-program.js";

/** The tRPC error codes the Hub REST door maps to HTTP (see `httpStatusForTrpcError`). */
export type PostHogTrpcCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "PRECONDITION_FAILED"
  | "CONFLICT"
  | "INTERNAL_SERVER_ERROR";

export interface PostHogReadContext {
  /** The acting operator. */
  userId: string;
  /** Acting workspace lens, or null for a pod-wide run. */
  workspaceId?: string | null;
  /** The acting agent, when the run is agent-initiated. */
  agentUserId?: string | null;
}

export class PostHogReadError extends Error {
  readonly trpcCode: PostHogTrpcCode;
  readonly status: number | undefined;
  readonly errorClass: FailureErrorClass | undefined;
  readonly providerRef: string | undefined;
  constructor(
    message: string,
    opts: {
      trpcCode: PostHogTrpcCode;
      status?: number | undefined;
      errorClass?: FailureErrorClass | undefined;
      providerRef?: string | undefined;
    }
  ) {
    super(message);
    this.name = "PostHogReadError";
    this.trpcCode = opts.trpcCode;
    this.status = opts.status;
    this.errorClass = opts.errorClass;
    this.providerRef = opts.providerRef;
  }
}

const MISSING_CONFIG =
  `The PostHog Analytics capability is not configured on this pod: no \`${POSTHOG_API_TOOL_NAME}\` tool ` +
  `exists. Install/enable the \`posthog-analytics\` capability and supply its params ` +
  `(personalApiKey, projectId, analyticsHost) — the tool row is what carries them.`;

const BAD_CREDENTIAL =
  `PostHog rejected the stored credential. The installed secret must be a PostHog PERSONAL API KEY ` +
  `with query:read (plus insight:read/event:read/person:read) scopes — the \`phc_…\` project token ` +
  `the client apps use is INGEST-ONLY and always 401s on a read. Re-install/re-apply the ` +
  `\`posthog-analytics\` capability with a Personal API Key.`;

/**
 * The dispatcher's OWN pre-dispatch failures (before any byte left the pod):
 * a missing tool row, an unwired credential, a refused vault grant, a tool kind
 * the scheme cannot execute. These are CONFIGURATION faults, and they are
 * matched by MESSAGE because the dispatcher reuses 404/400 for them — the same
 * statuses PostHog itself returns — so status alone cannot tell "we never
 * called PostHog" apart from "PostHog said not found".
 */
const PRE_DISPATCH_FAULTS: ReadonlyArray<{
  pattern: RegExp;
  trpcCode: PostHogTrpcCode;
  config?: boolean;
}> = [
  {
    pattern: /^Tool not found for (name|provider):/,
    trpcCode: "PRECONDITION_FAILED",
    config: true,
  },
  {
    pattern: /has no credentialRef and cannot be executed/,
    trpcCode: "PRECONDITION_FAILED",
    config: true,
  },
  {
    pattern:
      /could not be resolved \(missing, deleted, or not server-resolvable\)/,
    trpcCode: "PRECONDITION_FAILED",
  },
  {
    pattern: /could not be resolved \(missing or deleted\)/,
    trpcCode: "PRECONDITION_FAILED",
  },
  { pattern: /^Vault grant check failed/, trpcCode: "PRECONDITION_FAILED" },
  {
    pattern: /is not executable for [a-z]+:\/\//,
    trpcCode: "PRECONDITION_FAILED",
  },
  { pattern: /^Unsupported provider scheme/, trpcCode: "PRECONDITION_FAILED" },
];

/**
 * Classify a dispatcher failure. Exported for the unit tests: the mapping IS the
 * behaviour under test ("a broken lookup must never read as a calm empty").
 */
export function classifyPostHogFailure(result: {
  status?: number;
  error?: string;
  errorCode?: string;
}): { trpcCode: PostHogTrpcCode; message: string } {
  const status = result.status;
  const upstream = result.error?.trim();

  for (const fault of PRE_DISPATCH_FAULTS) {
    if (upstream && fault.pattern.test(upstream)) {
      return {
        trpcCode: fault.trpcCode,
        message: fault.config
          ? `${MISSING_CONFIG} Dispatcher said: ${upstream}`
          : `The PostHog credential could not be resolved. Dispatcher said: ${upstream}`,
      };
    }
  }

  if (status === 401 || status === 403) {
    return {
      trpcCode: "PRECONDITION_FAILED",
      message: `${BAD_CREDENTIAL}${upstream ? ` PostHog said: ${upstream}` : ""}`,
    };
  }
  if (status === 429) {
    return {
      trpcCode: "CONFLICT",
      message: `PostHog rate-limited the read (429). Retry later.${upstream ? ` PostHog said: ${upstream}` : ""}`,
    };
  }
  if (status === 404) {
    // A REAL 404 from PostHog (the dispatcher's own 404 was matched above by
    // message): the configured project/host does not exist.
    return {
      trpcCode: "NOT_FOUND",
      message: `PostHog returned 404 for the configured project/host — check the capability's projectId and analyticsHost.${upstream ? ` PostHog said: ${upstream}` : ""}`,
    };
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return {
      trpcCode: "BAD_REQUEST",
      // A 4xx on OUR query text is a defect in the fixed program, but the reason
      // still has to reach the caller verbatim — PostHog's message is the only
      // thing that says WHICH part of the read it disliked.
      message: `PostHog rejected the read (${status}): ${upstream ?? "no message"}`,
    };
  }
  return {
    trpcCode: "INTERNAL_SERVER_ERROR",
    message: `PostHog is unreachable or failing (${status ?? "no status"}): ${upstream ?? "no message"}`,
  };
}

/**
 * Perform ONE read and return PostHog's raw parsed body.
 *
 * Returns the raw body (not a shaped result) so the caller can distinguish
 * "read succeeded, nothing matched" from "read failed" with the readers in
 * `query-program.ts`.
 */
export async function callPostHog(
  request: PostHogRequest,
  ctx: PostHogReadContext
): Promise<unknown> {
  let result: TriggerProviderActionResult;
  try {
    result = await triggerProviderAction({
      userId: ctx.userId,
      provider: POSTHOG_API_TOOL_NAME,
      method: request.method,
      path: request.path,
      ...(request.body !== undefined ? { body: request.body } : {}),
      ...(ctx.workspaceId != null ? { workspaceId: ctx.workspaceId } : {}),
      agentUserId: ctx.agentUserId ?? null,
      // See the module header: the capability gate already decided this run.
      alreadyApproved: true,
    });
  } catch (err) {
    // The dispatcher itself threw (vault-grant resolution, a malformed ref, …).
    // Never swallowed: an unreadable credential is a FAILED read.
    throw new PostHogReadError(
      `PostHog read could not be dispatched: ${err instanceof Error ? err.message : String(err)}`,
      { trpcCode: "PRECONDITION_FAILED" }
    );
  }

  // Defensive: `alreadyApproved` means the tool gate cannot propose. If that
  // ever changes, a queued read must not be reported as a completed one.
  if (result.proposed === true) {
    throw new PostHogReadError(
      "The PostHog read was routed to a review proposal instead of running. A read-only analytics verb must auto-run — report this as a defect.",
      { trpcCode: "CONFLICT" }
    );
  }

  if (!result.success) {
    const { trpcCode, message } = classifyPostHogFailure({
      ...(result.status !== undefined ? { status: result.status } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.errorCode !== undefined
        ? { errorCode: result.errorCode }
        : {}),
    });
    throw new PostHogReadError(message, {
      trpcCode,
      status: result.status,
      errorClass: result.errorClass,
      providerRef: result.providerRef,
    });
  }

  if (result.body === undefined) {
    throw new PostHogReadError(
      "PostHog returned a successful response with no body, so no read result exists.",
      { trpcCode: "INTERNAL_SERVER_ERROR", status: result.status }
    );
  }
  return result.body;
}

/** True for the two error classes this capability raises — used by the verb layer. */
export function isPostHogReadFailure(
  err: unknown
): err is PostHogReadError | PostHogQueryError {
  return err instanceof PostHogReadError || err instanceof PostHogQueryError;
}

/**
 * `PostHogQueryError` is raised for a payload we cannot READ (a missing
 * `results`/`result` array, an unnamed table, a non-numeric cell) or for an
 * error PostHog embedded in a 200. All of those are a capability/upstream
 * defect, not a bad caller argument — the caller's arguments were already
 * validated by the verb's Zod schema (which throws its own error). Mapping them
 * to 400 would blame the caller for our broken parse.
 */
export function trpcCodeFor(
  err: PostHogReadError | PostHogQueryError
): PostHogTrpcCode {
  return err instanceof PostHogReadError
    ? err.trpcCode
    : "INTERNAL_SERVER_ERROR";
}
