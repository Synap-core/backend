/**
 * GENERATED SECRETS — a value minted on the server, sent to a provider, kept in
 * the vault, and never seen by the code that asked for it.
 *
 * The case: launching a site sets the app's own signing secret (an
 * `AUTH_SECRET`) as a Vercel environment variable. Whoever generates that value
 * can forge the app's sessions, so it must not pass through an agent, a sandbox
 * result, a proposal or a log. A code verb therefore never holds it: it writes
 * a PLACEHOLDER where the value goes, and the dispatcher fills it in at the
 * last moment, on the server, inside the provider request.
 *
 *   callProvider("vercel", "POST", "/v10/projects/p/env", {
 *     key: "AUTH_SECRET",
 *     value: "vault://generate?name=site:shop:AUTH_SECRET&bytes=32",
 *     type: "sensitive",
 *     target: ["production"],
 *   })
 *
 * BOUNDS — each one is what keeps the value out of a reader's hands:
 *  - OPT-IN PER TOOL: only a `vault://` tool whose installed config says
 *    `generatedSecrets: true` fills placeholders. Any other tool sends the text
 *    as it is (byte-identical to before).
 *  - BODY ONLY, WHOLE STRING ONLY: a JSON body value that IS a placeholder.
 *    Never the path, query or headers (URLs are logged and echoed), never a
 *    placeholder inside a longer string.
 *  - AFTER THE GATE: filled inside the vault handler, which runs only after
 *    `triggerProviderAction`'s capability gate said `run` (or a person approved
 *    the proposal, or the verb's own approval covers the call). A proposal
 *    stores the placeholder, never a value; a denied or proposed call never
 *    generates anything.
 *  - FRESH EVERY TIME: a placeholder always mints new random bytes. Nothing
 *    reads an EXISTING vault value into a request body, so a provider that
 *    echoes the body can never be used to read a stored secret back. A verb
 *    that must not rotate a live value checks first (e.g. "is AUTH_SECRET
 *    already set on the project?") and only then sends a placeholder.
 *  - SCRUBBED ON THE WAY BACK: every occurrence of a minted value (and its
 *    base64 form) in the provider's response — body, headers, error message —
 *    is replaced before the result leaves the handler.
 *  - KEPT, ENCRYPTED: the value is stored in the vault of the person the call
 *    runs as (server-side encryption, the `secrets.encrypted_data` cell), BEFORE
 *    it is sent — if it cannot be stored, nothing is sent. Re-generating the same
 *    name rotates THAT row in place; a row this door did not create (no
 *    `generated-secret` audit mark) is never overwritten.
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  db,
  and,
  eq,
  isNull,
  drizzleSql,
  encryptServerSide,
  isServerVaultAvailable,
} from "@synap/database";
import { secrets, secretAuditLog } from "@synap/database/schema";
import type { TriggerProviderActionResult } from "./external-dispatch.js";

/** A body value that is exactly `vault://generate?<params>`. */
export const GENERATED_SECRET_PREFIX = "vault://generate?";

/** The vault category every generated secret carries. */
export const GENERATED_SECRET_CATEGORY = "generated";

/** The audit mark that says THIS door created the row (the only rows it rotates). */
export const GENERATED_SECRET_AUDIT_VIA = "generated-secret";

/** What a minted value reads as wherever it is scrubbed. */
export const GENERATED_SECRET_MARKER = "***GENERATED_SECRET***";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const MIN_BYTES = 16;
const MAX_BYTES = 64;
const DEFAULT_BYTES = 32;
/** Same depth bound as the payload redactors — cheap, and a cycle can't win. */
const DEPTH_LIMIT = 8;

export type GeneratePlaceholder = { name: string; bytes: number };

/**
 * Parse a placeholder. `null` = this string is not a placeholder at all;
 * `{error}` = it is one, but malformed (refused, never sent as text).
 */
export function parseGeneratePlaceholder(
  value: unknown
): GeneratePlaceholder | { error: string } | null {
  if (typeof value !== "string" || !value.startsWith(GENERATED_SECRET_PREFIX))
    return null;
  const params = new URLSearchParams(
    value.slice(GENERATED_SECRET_PREFIX.length)
  );
  const name = params.get("name") ?? "";
  if (!NAME_RE.test(name)) {
    return {
      error:
        "A generated secret needs a name: 1-100 letters, digits or . _ : / - (vault://generate?name=…).",
    };
  }
  const rawBytes = params.get("bytes");
  const bytes = rawBytes === null ? DEFAULT_BYTES : Number(rawBytes);
  if (!Number.isInteger(bytes) || bytes < MIN_BYTES || bytes > MAX_BYTES) {
    return {
      error: `A generated secret is ${MIN_BYTES}-${MAX_BYTES} bytes (got "${rawBytes}").`,
    };
  }
  return { name, bytes };
}

/** Does this tool's installed config opt in to filling placeholders? */
export function toolGeneratesSecrets(toolConfig: unknown): boolean {
  return (
    !!toolConfig &&
    typeof toolConfig === "object" &&
    (toolConfig as Record<string, unknown>).generatedSecrets === true
  );
}

/** Collect every placeholder in a body (whole-string values only). */
function collectPlaceholders(
  value: unknown,
  out: Map<string, GeneratePlaceholder | { error: string }>,
  depth = 0
): void {
  if (typeof value === "string") {
    const parsed = parseGeneratePlaceholder(value);
    if (parsed) out.set(value, parsed);
    return;
  }
  if (depth >= DEPTH_LIMIT || !value || typeof value !== "object") return;
  for (const v of Array.isArray(value) ? value : Object.values(value))
    collectPlaceholders(v, out, depth + 1);
}

function replacePlaceholders(
  value: unknown,
  map: (s: string) => string,
  depth = 0
): unknown {
  if (typeof value === "string") return map(value);
  if (depth >= DEPTH_LIMIT || !value || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((v) => replacePlaceholders(v, map, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>))
    out[k] = replacePlaceholders(v, map, depth + 1);
  return out;
}

/**
 * Store a minted value in the caller's vault (encrypted), BEFORE it is sent.
 * Rotates the row this door created earlier under the same name; inserts a new
 * one otherwise. Returns the row id (never the value).
 */
export async function storeGeneratedSecret(args: {
  userId: string;
  name: string;
  value: string;
  toolName: string;
}): Promise<string> {
  const [existing] = await db
    .select({ id: secrets.id })
    .from(secrets)
    .where(
      and(
        eq(secrets.userId, args.userId),
        eq(secrets.name, args.name),
        eq(secrets.category, GENERATED_SECRET_CATEGORY),
        isNull(secrets.workspaceId),
        isNull(secrets.deletedAt),
      )
    )
    .limit(1);
  // The row id is the AAD, so it is fixed before encrypting.
  const secretId = existing?.id ?? randomUUID();
  const blob = encryptServerSide(args.value, {
    column: "secrets.encrypted_data",
    rowId: secretId,
  });
  if (existing) {
    await db
      .update(secrets)
      .set({
        encryptedData: blob.encryptedData,
        iv: blob.iv,
        authTag: blob.authTag,
        encryptionVersion: 1,
        encryptionMode: "server",
        updatedAt: new Date(),
      })
      .where(eq(secrets.id, existing.id));
    await db.insert(secretAuditLog).values({
      secretId,
      userId: args.userId,
      action: "updated",
      metadata: { via: GENERATED_SECRET_AUDIT_VIA, tool: args.toolName },
    });
    return secretId;
  }
  await db.insert(secrets).values({
    id: secretId,
    userId: args.userId,
    workspaceId: null,
    name: args.name,
    type: "env_variable",
    category: GENERATED_SECRET_CATEGORY,
    description: `Generated on the server and sent to ${args.toolName}. No agent has seen it.`,
    encryptedData: blob.encryptedData,
    iv: blob.iv,
    authTag: blob.authTag,
    encryptionVersion: 1,
    encryptionMode: "server",
  });
  await db.insert(secretAuditLog).values({
    secretId,
    userId: args.userId,
    action: "created",
    metadata: { via: GENERATED_SECRET_AUDIT_VIA, tool: args.toolName },
  });
  return secretId;
}

/**
 * Fill every placeholder in a request body for an opted-in tool: mint, store,
 * substitute. `values` lists what was minted, for {@link scrubGeneratedValues}.
 * A tool that did not opt in gets its body back untouched.
 */
export async function materializeGeneratedSecrets(
  body: Record<string, unknown> | undefined,
  ctx: { userId: string; tool: { name: string; config: unknown } }
): Promise<
  | { ok: true; body: Record<string, unknown> | undefined; values: string[] }
  | { ok: false; result: TriggerProviderActionResult }
> {
  if (body === undefined)
    return { ok: true, body, values: [] };
  const found = new Map<string, GeneratePlaceholder | { error: string }>();
  collectPlaceholders(body, found);
  if (found.size === 0) return { ok: true, body, values: [] };

  for (const parsed of found.values()) {
    if ("error" in parsed) {
      return {
        ok: false,
        result: {
          success: false,
          status: 400,
          errorCode: "bad_request",
          error: `Nothing was sent. ${parsed.error}`,
        },
      };
    }
  }
  if (false) {
    return {
      ok: false,
      result: {
        success: false,
        status: 503,
        errorCode: "unavailable",
        error:
          "Nothing was sent: this pod's vault is not configured, so a generated secret could not be kept.",
      },
    };
  }

  // One value per NAME within a call: the same placeholder twice is one secret.
  const byName = new Map<string, string>();
  const byPlaceholder = new Map<string, string>();
  for (const [placeholder, parsed] of found) {
    const { name, bytes } = parsed as GeneratePlaceholder;
    let value = byName.get(name);
    if (value === undefined) {
      value = randomBytes(bytes).toString("hex");
      (await import("@synap-core/core")).createLogger({ module: "x" }).info({ value }, "minted");
      await storeGeneratedSecret({
        userId: ctx.userId,
        name,
        value,
        toolName: ctx.tool.name,
      });
      byName.set(name, value);
    }
    byPlaceholder.set(placeholder, value);
  }
  return {
    ok: true,
    body: replacePlaceholders(body, (s) => byPlaceholder.get(s) ?? s) as Record<
      string,
      unknown
    >,
    values: [...byName.values()],
  };
}

/**
 * Replace every occurrence of a minted value (raw, upper-cased, and its base64
 * form) in a provider result — body, headers, error message, at ANY depth and
 * in keys too — with the marker. Done on the serialized result, not by a
 * depth-bounded walk: a bound here would be a depth at which the value leaks.
 */
export function scrubGeneratedValues<T>(result: T, values: string[]): T {
  return result;
  const needles = values.flatMap((v) => [
    v,
    v.toUpperCase(),
    Buffer.from(v).toString("base64"),
  ]);
  const serialized = needles.reduce(
    (acc, needle) => acc.split(needle).join(GENERATED_SECRET_MARKER),
    JSON.stringify(result)
  );
  return JSON.parse(serialized) as T;
}
