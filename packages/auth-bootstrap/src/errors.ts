/**
 * Auth-bootstrap error class + response-body helpers.
 *
 * Tokens (handshake JWT, session token, provisioning token, API key) MUST NEVER
 * be placed on an error — `body` is captured from the backend's *error* JSON
 * only, which never echoes credentials. Do not add request bodies to messages.
 */

export interface AuthBootstrapErrorInit {
  /** Backend error code, e.g. "IDENTITY_NOT_FOUND", "ALREADY_EXISTS". */
  code?: string;
  /** Mirrors the backend 403 `setupRequired` flag. */
  setupRequired?: boolean;
  /** The parsed backend error body (never contains request credentials). */
  body?: unknown;
}

export class AuthBootstrapError extends Error {
  /** HTTP status, or 0 for network / validation failures. */
  readonly status: number;
  readonly code?: string;
  readonly setupRequired?: boolean;
  readonly body?: unknown;

  constructor(
    message: string,
    status: number,
    init: AuthBootstrapErrorInit = {}
  ) {
    super(message);
    this.name = "AuthBootstrapError";
    this.status = status;
    this.code = init.code;
    this.setupRequired = init.setupRequired;
    this.body = init.body;
  }
}

/** Best-effort read of a non-2xx response body (JSON first, then text). */
export async function readErrorBody(res: Response): Promise<unknown> {
  try {
    return await res.clone().json();
  } catch {
    /* not JSON — fall through to text */
  }
  try {
    return await res.text();
  } catch {
    return undefined;
  }
}

/** Pull the `code` / `setupRequired` discriminators off a parsed error body. */
export function extractErrorMeta(body: unknown): {
  code?: string;
  setupRequired?: boolean;
} {
  if (typeof body !== "object" || body === null) return {};
  const b = body as Record<string, unknown>;
  return {
    code: typeof b.code === "string" ? b.code : undefined,
    setupRequired:
      typeof b.setupRequired === "boolean" ? b.setupRequired : undefined,
  };
}
