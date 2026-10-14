/**
 * Agent upload — the two-step large-file lane for MCP agents (decision D10/L1,
 * Slack's `getUploadURLExternal` → PUT → `completeUploadExternal` shape).
 *
 *   1. `requestAgentUpload`  → the EXISTING presigned lane
 *      (`requestPresignedUpload`): a signed PUT URL + an upload token.
 *   2. the agent PUTs the bytes straight to object storage.
 *   3. `finalizeAgentUpload` → the EXISTING finalize
 *      (`storeDocumentFromPresignedUpload`), then the SAME governed doors
 *      `synap_store_file` uses for inline bytes: a new `file` entity through
 *      `createGovernedFileEntityForStoredDocument`, or a source-file attach
 *      through `gateAndAttachStagedSourceBlob` — never a second lane.
 *
 * The presign lane's own token is the storage key: unguessable (a random UUID
 * segment) and bound to the uploading USER. An agent token adds what that key
 * cannot carry — the requesting AGENT, the session, and an expiry — in an
 * HMAC-sealed envelope around the key. Finalize refuses a token minted for
 * another user or another agent, a tampered one, an expired one, and a raw key
 * (an agent never finalizes a person's REST upload).
 */

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { TRPCError } from "@trpc/server";
import { db } from "@synap/database";
import {
  requestPresignedUpload,
  storeDocumentFromPresignedUpload,
  parsePresignedUploadKey,
  type PresignRefusal,
} from "../../routers/file-upload-presign.js";
import { canWriteWorkspace } from "../../routers/file-upload.js";
import { createGovernedFileEntityForStoredDocument } from "../../routers/create-governed-file-entity.js";
import { gateAndAttachStagedSourceBlob } from "../../utils/store-entity-source-blob.js";
import { checkHubRateLimit } from "../../utils/hub-protocol-rate-limit.js";
import { resolveConfinedWorkspace } from "../../routers/hub-protocol/confine-workspace.js";
import { recordSessionArtifact } from "../focus-sessions/record-session-artifact.js";

/** How long an agent upload token can be finalized (the PUT URL lives 15 min). */
export const AGENT_UPLOAD_TOKEN_TTL_SECONDS = 3600;

const TOKEN_PREFIX = "sau1";

/**
 * Derived from JWT_SECRET (every pod has one — `hub-utils.ts` refuses to boot
 * in production without it), the same derivation the hub JWT secret uses. With
 * no JWT_SECRET (dev/test) a per-process key: tokens then die on restart.
 */
const TOKEN_KEY = process.env.JWT_SECRET
  ? createHmac("sha256", process.env.JWT_SECRET)
      .update("agent-upload-token")
      .digest()
  : randomBytes(32);

interface TokenClaims {
  /** The presign lane's storage key (its own token). */
  k: string;
  /** The requesting user. */
  u: string;
  /** The requesting agent, or null for a key with no agent identity. */
  a: string | null;
  /** The session the request was made in, if any. */
  s?: string;
  /** Expiry, epoch ms. */
  e: number;
}

const mac = (payload: string) =>
  createHmac("sha256", TOKEN_KEY).update(payload).digest("base64url");

function sealToken(claims: TokenClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${TOKEN_PREFIX}.${payload}.${mac(payload)}`;
}

function openToken(token: string): TokenClaims | null {
  const [prefix, payload, sig, ...rest] = token.split(".");
  if (prefix !== TOKEN_PREFIX || !payload || !sig || rest.length) return null;
  const expected = Buffer.from(mac(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** A refusal the MCP handler turns into a tool error (status = HTTP meaning). */
export interface AgentUploadRefusal {
  ok: false;
  status: PresignRefusal["status"] | 410 | 429;
  code: string;
  error: string;
}

const refuse = (
  status: AgentUploadRefusal["status"],
  code: string,
  error: string
): AgentUploadRefusal => ({ ok: false, status, code, error });

/** Same limiter bucket as `synap_store_file` and the Hub `/files` doors. */
function rateLimited(actorId: string): AgentUploadRefusal | null {
  try {
    checkHubRateLimit(actorId, "files");
    return null;
  } catch {
    return refuse(
      429,
      "RATE_LIMITED",
      "Rate limit exceeded for file storage (30/min). Retry shortly."
    );
  }
}

export interface AgentUploadTicket {
  ok: true;
  uploadUrl: string;
  method: "PUT";
  /** Send exactly these headers with the PUT (they are signed). */
  headers: { "Content-Type": string };
  /** Pass to `finalizeAgentUpload` (MCP: `synap_store_file({uploadToken})`). */
  uploadToken: string;
  /** The PUT URL's deadline. Finalize within {@link AGENT_UPLOAD_TOKEN_TTL_SECONDS}. */
  expiresAt: string;
  maxBytes: number;
}

/**
 * Step 1. `workspaceId` is the caller's CONFINED workspace (the MCP adapter's
 * service-key clamp); it is write-checked here with the same gate as the REST
 * request door.
 */
export async function requestAgentUpload(params: {
  userId: string;
  agentUserId?: string;
  workspaceId: string | undefined;
  filename: string;
  mimeType: string;
  size: number;
  sessionId?: string;
}): Promise<AgentUploadTicket | AgentUploadRefusal> {
  const { userId, agentUserId, workspaceId } = params;
  const limited = rateLimited(agentUserId ?? userId);
  if (limited) return limited;
  if (!workspaceId) {
    return refuse(
      400,
      "WORKSPACE_REQUIRED",
      "workspaceId is required (none was supplied or accessible to your key)."
    );
  }
  if (!(await canWriteWorkspace(userId, workspaceId))) {
    return refuse(403, "FORBIDDEN", "You cannot write to this workspace.");
  }
  const ticket = await requestPresignedUpload({
    userId,
    workspaceId,
    filename: params.filename,
    mimeType: params.mimeType,
    size: params.size,
  });
  if (!ticket.ok) return ticket;
  return {
    ...ticket,
    uploadToken: sealToken({
      k: ticket.uploadToken,
      u: userId,
      a: agentUserId ?? null,
      ...(params.sessionId ? { s: params.sessionId } : {}),
      e: Date.now() + AGENT_UPLOAD_TOKEN_TTL_SECONDS * 1000,
    }),
  };
}

export type AgentUploadFinalized =
  | { ok: true; status: "created"; fileEntityId: string; documentId: string }
  | {
      ok: true;
      status: "proposed";
      documentId: string;
      proposalId?: string;
      reviewUrl?: string;
      /** Attach mode only. */
      entityId?: string;
      proposalType?: string;
    }
  | { ok: true; status: "attached"; entityId: string; documentId: string };

/**
 * Step 3. Mirrors `synap_store_file`'s governance exactly: attach mode goes
 * through the source-file gate (`entity.update`), otherwise a `file` entity is
 * minted through the governed `entities.create`; `proposed` is a normal
 * outcome; a non-proposed write records the session artifact.
 */
export async function finalizeAgentUpload(params: {
  userId: string;
  agentUserId?: string;
  scopes: string[];
  keyType?: string | null;
  keyWorkspaceId?: string | null;
  uploadToken: string;
  title?: string;
  attachToEntityId?: string;
  /** Defaults to the session the upload was requested in. */
  sessionId?: string;
  expectedLabel?: string;
}): Promise<AgentUploadFinalized | AgentUploadRefusal> {
  const { userId, agentUserId } = params;
  const limited = rateLimited(agentUserId ?? userId);
  if (limited) return limited;

  const claims = openToken(params.uploadToken);
  if (!claims) {
    return refuse(
      400,
      "INVALID_UPLOAD_TOKEN",
      "uploadToken is not valid — get one from synap_request_upload"
    );
  }
  if (claims.e <= Date.now()) {
    return refuse(
      410,
      "UPLOAD_TOKEN_EXPIRED",
      "uploadToken expired — request a new upload"
    );
  }
  if (claims.u !== userId || claims.a !== (agentUserId ?? null)) {
    return refuse(
      403,
      "UPLOAD_NOT_YOURS",
      "uploadToken was issued to another caller"
    );
  }

  // The workspace was bound into the key at request time; re-check key
  // confinement and the write floor now (membership may have changed).
  const bound = parsePresignedUploadKey(claims.k);
  if (!bound) {
    return refuse(400, "INVALID_UPLOAD_TOKEN", "uploadToken is not valid");
  }
  try {
    resolveConfinedWorkspace(
      params.keyType,
      params.keyWorkspaceId,
      bound.workspaceId
    );
  } catch (err) {
    if (err instanceof TRPCError && err.code === "FORBIDDEN") {
      return refuse(403, "FORBIDDEN", err.message);
    }
    throw err;
  }
  if (!(await canWriteWorkspace(userId, bound.workspaceId))) {
    return refuse(403, "FORBIDDEN", "You cannot write to this workspace.");
  }

  const fin = await storeDocumentFromPresignedUpload({
    userId,
    uploadToken: claims.k,
    title: params.title,
    actorAgentUserId: agentUserId,
  });
  if (!fin.ok) return fin;

  const sessionId = params.sessionId ?? claims.s;
  const workspaceId = fin.workspaceId;
  const title = params.title ?? fin.filename;

  if (params.attachToEntityId) {
    const attached = await gateAndAttachStagedSourceBlob({
      database: db,
      userId,
      entityId: params.attachToEntityId,
      staged: {
        documentId: fin.stored.documentId,
        storageKey: fin.stored.storageKey,
        storageUrl: fin.stored.storageUrl,
        size: fin.stored.size,
        mimeType: fin.mimeType,
        filename: fin.filename,
      },
      workspaceId,
      ...(sessionId ? { sessionId } : {}),
      ...(params.expectedLabel ? { expectedLabel: params.expectedLabel } : {}),
    });
    if (attached.status === "proposed") {
      return {
        ok: true,
        status: "proposed",
        entityId: params.attachToEntityId,
        documentId: attached.staged.documentId,
        proposalId: attached.proposalId,
        proposalType: attached.proposalType,
        reviewUrl: attached.reviewUrl,
      };
    }
    await recordSessionArtifact({
      sessionId,
      workspaceId,
      userId,
      kind: "document",
      refId: attached.documentId,
      title,
      agentUserId,
      expectedLabel: params.expectedLabel,
    });
    return {
      ok: true,
      status: "attached",
      entityId: params.attachToEntityId,
      documentId: attached.documentId,
    };
  }

  const stored = await createGovernedFileEntityForStoredDocument(fin.stored, {
    mimeType: fin.mimeType,
    filename: fin.filename,
    title: params.title,
    userId,
    workspaceId,
    agentUserId,
    scopes: params.scopes,
    sessionId,
    keyType: params.keyType,
    keyWorkspaceId: params.keyWorkspaceId,
    expectedLabel: params.expectedLabel,
  });
  if (stored.status === "proposed") {
    return {
      ok: true,
      status: "proposed",
      documentId: stored.documentId,
      proposalId: stored.proposalId,
      reviewUrl: stored.reviewUrl,
    };
  }
  await recordSessionArtifact({
    sessionId,
    workspaceId,
    userId,
    kind: "entity",
    refId: stored.fileEntityId,
    title,
    agentUserId,
    expectedLabel: params.expectedLabel,
  });
  return {
    ok: true,
    status: "created",
    fileEntityId: stored.fileEntityId,
    documentId: stored.documentId,
  };
}
