/**
 * POD FILES TO TOOLS (plan e7c3c98e, decision 7d42be8c): by URL (phase 1) and
 * as bytes (phase 2b).
 *
 * A verb DECLARES which of its parameters are pod files, in the type map its
 * `parameters` are written in: `"media": "file[]:url?"`, `"video": "file:url"`,
 * `"attachments": "file[]:bytes?"`. The caller passes file ENTITY ids (the id
 * `signFileEntityUrl` signs). A `:url` skill receives a URL it can hand to its
 * tool; a `:bytes` skill receives an opaque HANDLE (`podfile:…`) that only the
 * host turns into bytes, in a `callProvider` body sent to one of the verb's own
 * tools (`run-skill-in-sandbox.ts`, through `provider-file-body.ts`). Three
 * moments, three doors:
 *
 *   1. INSTALL — `fileParameterDeclarationProblems`: the delivery must be said
 *      (`:url` or `:bytes`); `:bytes` only on a code verb that runs in the pod
 *      (not a declarative verb, not a box script); a verb with a file
 *      parameter is never `readOnly` (a file sent out is an outward act, and
 *      `readOnly` auto-runs at the gate).
 *   2. ASK — `checkPodFilesAtAsk`, before the gate: each id must be a file the
 *      CALLER can read (`readableFileEntity`, through `scopedDb`, so an app
 *      key's grant narrows it), with stored bytes, under the size cap. A
 *      refusal files nothing. A proposal stores the ids (they ARE the
 *      parameters) and the files' names and sizes, never a URL: a URL minted
 *      here would be dead by the time a person approves.
 *   3. RUN — `resolvePodFilesAtRun`, first thing in the post-gate runner: each
 *      file is read again as the run's identity (it may be gone, or no longer
 *      readable), a FRESH signed GET is minted with the verb's lifetime (15 min
 *      sync, 6 h async), the id is swapped for the URL, and one `file.sent`
 *      event per file records who sent which file to which tool, and for how
 *      long the link lives. A `:bytes` file gets a handle valid for THIS run
 *      only, toward the verb's own required tools only (`PodFileHandles`).
 *
 * An agent run carrying a pod file always proposes (`carriesPodFiles`, the
 * gate's POD_FILE_OUTWARD floor in `@synap/capability-gate`).
 *
 * The bytes never enter the skill isolate: the tool fetches the URL, or the
 * host streams them from storage into the provider request.
 */

import { randomBytes, randomUUID } from "crypto";
import {
  and,
  db,
  eq,
  eventRepository,
  inArray,
  links,
  tools,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { resolveServiceName } from "@synap-core/types/service-marks";

/**
 * The file doors' read floor and signer, loaded on first use: every capability
 * run imports this module, and only a verb that declares a file parameter
 * needs the upload router's dependencies (storage, sessions).
 */
const fileDoors = () => import("../../routers/file-upload.js");
import {
  MULTIPART_FILE_MAX_BYTES,
  type ProviderFileRef,
} from "../../connectors/provider-file-body.js";
import { declaredReadOnly } from "./capability-drift.js";
import { looksLikeJsonSchema } from "./parameter-dialect.js";
import type {
  ParameterRepair,
  PodFileProblem,
} from "./validate-verb-parameters.js";

const logger = createLogger({ module: "file-parameters" });

/** How a tool takes a pod file. Only `url` is wired (phase 1). */
export type PodFileDelivery = "url" | "bytes";

/** One declared file parameter of a verb. */
export interface PodFileParameter {
  field: string;
  /** `file[]`: a list of file ids; `file`: one. */
  many: boolean;
  /** As declared after the `:` — null when the declaration names none. */
  delivery: string | null;
  optional: boolean;
}

/** A file named by a call, as the ask check read it. Ids only, never a URL. */
export interface PodFileRef {
  field: string;
  id: string;
  name: string | null;
  mimeType: string | null;
  size: number | null;
}

/** Most bytes a tool may be sent by URL (Instagram reels top out at 300 MB). */
export const POD_FILE_URL_MAX_BYTES = 300 * 1024 * 1024;
/** Most files one `file[]` parameter may carry (an Instagram carousel's 20). */
export const POD_FILES_PER_PARAMETER_MAX = 20;
/** The signed URL's lifetime: a sync verb fetches during its request. */
export const POD_FILE_URL_TTL_SYNC_SECONDS = 15 * 60;
/** A queued provider (async verb, box script) may fetch it hours later. */
export const POD_FILE_URL_TTL_ASYNC_SECONDS = 6 * 60 * 60;

/** Most bytes one file may be sent as bytes (the multipart part cap). */
export const POD_FILE_BYTES_MAX_BYTES = MULTIPART_FILE_MAX_BYTES;

/** The cap a file is held to, by how its verb takes it. */
function maxBytesFor(delivery: string | null): number {
  return delivery === "bytes"
    ? POD_FILE_BYTES_MAX_BYTES
    : POD_FILE_URL_MAX_BYTES;
}

/**
 * What a `:bytes` skill receives in place of a file id: `podfile:` and a random
 * token. Not a secret and not a capability on its own: only the bridges of the
 * run that minted it can turn it into bytes (`PodFileHandles`).
 */
export const POD_FILE_HANDLE_PREFIX = "podfile:";

/**
 * The `:bytes` files of ONE run: each handle the skill received, the file it
 * names, and the only tools those files may be sent to (the verb's `requires`
 * edges). Held in the run's closure, never stored, never in a proposal.
 */
export interface PodFileHandles {
  files: ReadonlyMap<string, ProviderFileRef>;
  toolIds: readonly string[];
}

/** The event one file handed to a tool writes. */
export const FILE_SENT_EVENT = "file.sent";

const FILE_TYPE = /^file(\[\])?(?::([a-z]+))?(\?)?$/;
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read one type-map entry as a file parameter, or null when it is not one.
 * `file`, `file[]`, each with an optional `:<delivery>` and an optional `?`.
 */
export function parseFileParameterType(
  raw: unknown
): Omit<PodFileParameter, "field"> | null {
  if (typeof raw !== "string") return null;
  const m = FILE_TYPE.exec(raw);
  if (!m) return null;
  return { many: !!m[1], delivery: m[2] ?? null, optional: !!m[3] };
}

/** The file parameters a verb's `parameters` declare (type-map dialect only). */
export function declaredFileParameters(
  parameters: unknown
): PodFileParameter[] {
  if (
    !parameters ||
    typeof parameters !== "object" ||
    Array.isArray(parameters) ||
    looksLikeJsonSchema(parameters as Record<string, unknown>)
  ) {
    return [];
  }
  const out: PodFileParameter[] = [];
  for (const [field, raw] of Object.entries(
    parameters as Record<string, unknown>
  )) {
    const parsed = parseFileParameterType(raw);
    if (parsed) out.push({ field, ...parsed });
  }
  return out;
}

/**
 * Why a verb's file declaration cannot be installed, one sentence per problem
 * (empty = installable). Read by the install door (`createCapabilityFromDefinition`).
 */
export function fileParameterDeclarationProblems(skill: {
  parameters?: unknown;
  metadata?: unknown;
  /** Absent = a code verb (a definition's default). */
  kind?: string | null;
  executionMode?: string | null;
}): string[] {
  // Bytes are turned into a provider body by the pod's sandbox bridge: only a
  // code verb run in the pod reaches it.
  const sendsBytes =
    (skill.kind ?? "code") === "code" && skill.executionMode !== "box";
  const declared = declaredFileParameters(skill.parameters);
  const problems: string[] = [];
  for (const p of declared) {
    const shape = p.many ? "file[]" : "file";
    if (p.delivery === null) {
      problems.push(
        `"${p.field}" is a file parameter that does not say how the tool takes the file: declare it "${shape}:url"`
      );
    } else if (p.delivery === "bytes" && !sendsBytes) {
      problems.push(
        `"${p.field}" asks for the file as bytes, which only a code verb run in the pod can send (not a declarative verb or a box script): declare it "${shape}:url"`
      );
    } else if (p.delivery !== "url" && p.delivery !== "bytes") {
      problems.push(
        `"${p.field}" names an unknown file delivery ":${p.delivery}": declare it "${shape}:url" or "${shape}:bytes"`
      );
    }
  }
  const metadata =
    skill.metadata && typeof skill.metadata === "object"
      ? (skill.metadata as Record<string, unknown>)
      : null;
  if (declared.length > 0 && declaredReadOnly(metadata) === true) {
    problems.push(
      "a verb with a file parameter sends a pod file out of the pod, so it cannot be read-only: remove metadata.readOnly"
    );
  }
  return problems;
}

/** The signed URL's lifetime for a verb, by its execution mode. */
export function podFileUrlTtlSeconds(
  executionMode: string | null | undefined
): number {
  return !executionMode || executionMode === "sync"
    ? POD_FILE_URL_TTL_SYNC_SECONDS
    : POD_FILE_URL_TTL_ASYNC_SECONDS;
}

type FileProblem = NonNullable<ParameterRepair["files"]>[number];

/** The ids a call gives one declared parameter, or the shape problem. */
function idsOf(
  p: PodFileParameter,
  value: unknown
): { ids: string[] } | { problem: FileProblem } {
  const list = p.many ? value : [value];
  if (
    !Array.isArray(list) ||
    list.some((v) => typeof v !== "string" || !UUID_SHAPE.test(v))
  ) {
    return { problem: { field: p.field, problem: "not_a_file_id" } };
  }
  if (list.length > POD_FILES_PER_PARAMETER_MAX) {
    return { problem: { field: p.field, problem: "too_many" } };
  }
  return { ids: list as string[] };
}

function refusal(problems: FileProblem[]): {
  ok: false;
  repair: ParameterRepair;
} {
  return {
    ok: false,
    repair: { missing: [], wrongType: {}, unknown: [], files: problems },
  };
}

/** The declared parameters a call actually fills (absent/null = not sent). */
function filled(
  declared: PodFileParameter[],
  parameters: Record<string, unknown> | undefined
): Array<[PodFileParameter, unknown]> {
  return declared.flatMap((p) => {
    const value = parameters?.[p.field];
    return value === undefined || value === null ? [] : [[p, value]];
  });
}

/**
 * ASK TIME: may this caller send these files? Runs before the gate, for every
 * door into `executeCapability` and the person's own Run. `userId` reads
 * through `scopedDb`, so the request's key grant (an app's spaces) narrows it.
 */
export async function checkPodFilesAtAsk(
  skill: { parameters?: unknown },
  parameters: Record<string, unknown> | undefined,
  userId: string
): Promise<
  { ok: true; files: PodFileRef[] } | { ok: false; repair: ParameterRepair }
> {
  const declared = declaredFileParameters(skill.parameters);
  if (declared.length === 0) return { ok: true, files: [] };

  const problems: FileProblem[] = [];
  const files: PodFileRef[] = [];
  for (const [p, value] of filled(declared, parameters)) {
    if (p.delivery !== "url" && p.delivery !== "bytes") {
      problems.push({ field: p.field, problem: "delivery_not_supported" });
      continue;
    }
    const shape = idsOf(p, value);
    if ("problem" in shape) {
      problems.push(shape.problem);
      continue;
    }
    for (const id of shape.ids) {
      const readable = await (await fileDoors()).readableFileEntity(userId, id);
      if (!readable.ok) {
        problems.push({
          field: p.field,
          fileId: id,
          problem: readable.status === 404 ? "not_found" : "forbidden",
        });
        continue;
      }
      const { entity } = readable;
      if (entity.deletedAt) {
        problems.push({ field: p.field, fileId: id, problem: "not_found" });
        continue;
      }
      if (!entity.storageKey) {
        problems.push({
          field: p.field,
          fileId: id,
          problem: "no_stored_bytes",
        });
        continue;
      }
      if (entity.size !== null && entity.size > maxBytesFor(p.delivery)) {
        problems.push({ field: p.field, fileId: id, problem: "too_large" });
        continue;
      }
      files.push({
        field: p.field,
        id,
        name: entity.title,
        mimeType: entity.mimeType,
        size: entity.size,
      });
    }
  }
  return problems.length > 0 ? refusal(problems) : { ok: true, files };
}

/** The tools a verb DECLARES (`skill → requires → tool` links). */
export async function requiredToolIdsOf(skillId: string): Promise<string[]> {
  const rows = await db
    .select({ toolId: links.toId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "skill"),
        eq(links.fromId, skillId),
        eq(links.toType, "tool"),
        eq(links.linkType, "requires")
      )
    );
  return rows.map((r) => r.toolId);
}

/** What a tool's name reads as: its service's name, never the raw tool id. */
export async function verbToolLabel(skillId: string): Promise<string | null> {
  // Two reads, not a join: `links.to_id` is text, `tools.id` a uuid.
  const required = await requiredToolIdsOf(skillId);
  if (required.length === 0) return null;
  const rows = await db
    .select({ name: tools.name })
    .from(tools)
    .where(inArray(tools.id, required));
  const names = [...new Set(rows.map((r) => resolveServiceName(r.name)))];
  return names.length > 0 ? names.join(", ") : null;
}

/**
 * A byte count for a person: "2.1 MB". Value formatting, not vocabulary
 * (`rules/vocabulary` keeps byte sizes out of the vocabulary door).
 */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)} ${units[unit]}`;
}

const MAX_NAMED_FILES = 3;

/**
 * The proposal's one line when a run sends pod files: what leaves the pod, how
 * big, and to which tool. "Sends photo.jpg (2.1 MB) to Postiz". A file with no
 * stored name reads as "a file"; an unknown size is left out.
 */
export function describePodFileSend(
  files: readonly PodFileRef[],
  toolLabel: string | null
): string {
  const to = toolLabel ? `to ${toolLabel}` : "out of your pod";
  const nameOf = (f: PodFileRef) => f.name?.trim() || "a file";
  const sized = files.filter((f) => f.size !== null && f.size > 0);
  const total = sized.reduce((n, f) => n + (f.size ?? 0), 0);
  if (files.length === 1) {
    const f = files[0]!;
    const size = f.size ? ` (${formatByteSize(f.size)})` : "";
    return `Sends ${nameOf(f)}${size} ${to}`;
  }
  const named = files.slice(0, MAX_NAMED_FILES).map(nameOf).join(", ");
  const more =
    files.length > MAX_NAMED_FILES
      ? ` and ${files.length - MAX_NAMED_FILES} more`
      : "";
  const size = total > 0 ? ` (${formatByteSize(total)})` : "";
  return `Sends ${files.length} files${size} ${to}: ${named}${more}`;
}

/**
 * RUN TIME, after the gate (a `run` verdict or an approved proposal): read
 * each file again as the run's identity and hand the skill, in place of the
 * id, what its declaration asks for:
 *   - `:url`   — a fresh signed GET with the verb's lifetime;
 *   - `:bytes` — a handle (`podfile:…`) this run's bridges resolve, toward the
 *                verb's own required tools only (`podFiles`).
 * All or nothing: one file that cannot be sent refuses the run before anything
 * leaves (a definite not-delivered, so an approval's claim is released and
 * Retry stays possible). One `file.sent` event per file is written before the
 * parameters are returned: an audit that cannot be written sends nothing.
 *
 * A verb that declares no file parameter returns its parameters untouched.
 */
export async function resolvePodFilesAtRun(
  skill: {
    id: string;
    name: string;
    kind: string | null;
    parameters: unknown;
    executionMode: string | null;
  },
  parameters: Record<string, unknown> | undefined,
  ctx: {
    userId: string;
    workspaceId: string | null;
    sessionId?: string | null;
    agentUserId?: string | null;
    proposalId?: string | null;
  }
): Promise<
  | {
      ok: true;
      parameters: Record<string, unknown> | undefined;
      /** Present when the run carries `:bytes` files. */
      podFiles?: PodFileHandles;
    }
  | { ok: false; message: string }
> {
  const declared = declaredFileParameters(skill.parameters);
  const toSend = filled(declared, parameters);
  if (toSend.length === 0) return { ok: true, parameters };

  const ttl = podFileUrlTtlSeconds(skill.executionMode);
  const doors = await fileDoors();
  const out: Record<string, unknown> = { ...parameters };
  const handles = new Map<string, ProviderFileRef>();
  const sent: Array<{
    field: string;
    id: string;
    delivery: PodFileDelivery;
    /** The URL's expiry (`:url` only). */
    expiresAt: string | null;
    documentId: string | null;
    name: string | null;
    mimeType: string | null;
    size: number | null;
  }> = [];
  const gone = (id: string, field: string) => ({
    ok: false as const,
    message: `The file ${id} in "${field}" can no longer be sent: it was deleted or is no longer readable. Nothing was sent.`,
  });
  const tooLarge = (id: string, field: string, cap: number) => ({
    ok: false as const,
    message: `The file ${id} in "${field}" is larger than ${formatByteSize(cap)}. Nothing was sent.`,
  });
  for (const [p, value] of toSend) {
    if (p.delivery !== "url" && p.delivery !== "bytes") {
      return {
        ok: false,
        message: `"${p.field}" names an unknown file delivery. Nothing was sent.`,
      };
    }
    if (
      p.delivery === "bytes" &&
      (skill.kind !== "code" || skill.executionMode === "box")
    ) {
      return {
        ok: false,
        message: `"${p.field}" asks for files as bytes, which only a code verb run in the pod can send. Nothing was sent.`,
      };
    }
    const shape = idsOf(p, value);
    if ("problem" in shape) {
      return {
        ok: false,
        message: `"${p.field}" must be ${p.many ? "a list of pod file ids" : "a pod file id"}. Nothing was sent.`,
      };
    }
    const cap = maxBytesFor(p.delivery);
    const given: string[] = [];
    for (const id of shape.ids) {
      if (p.delivery === "url") {
        const signed = await doors.signFileEntityUrl(ctx.userId, id, {
          expiresInSeconds: ttl,
        });
        // A trashed file still signs at the URL door (a trash view draws it);
        // the URL minted for it here is dropped, never handed out.
        if (!signed.ok || signed.entity.deletedAt) return gone(id, p.field);
        if (!/^https?:\/\//i.test(signed.body.url)) {
          return {
            ok: false,
            message:
              "This pod's storage has no public address, so a tool cannot fetch a pod file by URL. Nothing was sent.",
          };
        }
        const size = signed.entity.size;
        if (size !== null && size > cap) return tooLarge(id, p.field, cap);
        given.push(signed.body.url);
        sent.push({
          field: p.field,
          id,
          delivery: "url",
          expiresAt: signed.body.expiresAt,
          documentId: signed.entity.documentId ?? null,
          name: signed.entity.title,
          mimeType: signed.entity.mimeType,
          size,
        });
        continue;
      }
      // `:bytes`: the same read floor as the URL door, and a handle in place
      // of a URL. The storage key stays on the host.
      const readable = await doors.readableFileEntity(ctx.userId, id);
      if (
        !readable.ok ||
        readable.entity.deletedAt ||
        !readable.entity.storageKey
      ) {
        return gone(id, p.field);
      }
      const { entity } = readable;
      if (entity.size !== null && entity.size > cap) {
        return tooLarge(id, p.field, cap);
      }
      const handle =
        POD_FILE_HANDLE_PREFIX + randomBytes(18).toString("base64url");
      handles.set(handle, {
        storageKey: entity.storageKey!,
        filename: entity.title?.trim() || "file",
        contentType: entity.mimeType || "application/octet-stream",
        size: entity.size ?? 0,
      });
      given.push(handle);
      sent.push({
        field: p.field,
        id,
        delivery: "bytes",
        expiresAt: null,
        documentId: entity.documentId ?? null,
        name: entity.title,
        mimeType: entity.mimeType,
        size: entity.size,
      });
    }
    out[p.field] = p.many ? given : given[0];
  }

  const tool = await verbToolLabel(skill.id);
  for (const f of sent) {
    // A URL is a bearer link and a handle names a storage key: neither is
    // ever written to the event.
    await eventRepository.append({
      id: randomUUID(),
      version: "v1",
      type: FILE_SENT_EVENT,
      subjectType: "entity",
      subjectId: f.id,
      userId: ctx.userId,
      source: "api",
      timestamp: new Date(),
      ...(ctx.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx.proposalId ? { proposalId: ctx.proposalId } : {}),
      data: {
        fileId: f.id,
        documentId: f.documentId,
        name: f.name,
        mimeType: f.mimeType,
        size: f.size,
        field: f.field,
        skillId: skill.id,
        verb: skill.name,
        tool,
        delivery: f.delivery,
        urlTtlSeconds: f.delivery === "url" ? ttl : null,
        urlExpiresAt: f.expiresAt,
        agentUserId: ctx.agentUserId ?? null,
        proposalId: ctx.proposalId ?? null,
      },
    });
  }
  logger.info(
    { skillId: skill.id, files: sent.length, bytes: handles.size, ttl },
    "pod files handed to a verb"
  );
  return {
    ok: true,
    parameters: out,
    ...(handles.size > 0
      ? {
          podFiles: {
            files: handles,
            toolIds: await requiredToolIdsOf(skill.id),
          },
        }
      : {}),
  };
}

export type { PodFileProblem };
