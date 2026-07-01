/**
 * Provider-verb engine — Tier-1, in-process capability execution.
 *
 * Executes a DECLARATIVE `ProviderVerbSpec` (a `kind:'declarative'` skill) directly
 * on the pod via the existing `triggerProviderAction` dispatcher — NO Intelligence
 * Service, NO sandbox isolate. Reserved for deterministic, READ-ONLY provider
 * verbs; AI + untrusted code stay on the `kind:'code'` → `executeSkillViaIS` path.
 *
 * The single chokepoint `executeCapability` branches on `skill.kind` and calls
 * this for provider verbs AFTER the skill-level approval gate has already run.
 * `alreadyApproved:true` is therefore passed to `triggerProviderAction` so its
 * tool-level gate does not double-propose — the SAME contract `approve-executors`
 * uses on the governed Door-2 re-entry.
 *
 * Pipeline (per call): paramMapping (defaults/clamps/required/encode) →
 * interpolate path/query/body → triggerProviderAction → shape the response. An
 * optional `expand` runs a bounded per-id detail fan-out and merges each detail
 * into its list item.
 */

import type { ProviderVerbSpec } from "@synap/database/schema";
import {
  triggerProviderAction,
  type ConnectionSelector,
} from "../../connectors/external-dispatch.js";
import { interpolateString, interpolateDeep } from "../_shared/interpolate.js";

type DetailSpec = Omit<ProviderVerbSpec, "tool" | "expand">;

interface CallCtx {
  userId: string;
  workspaceId?: string;
  /** The provider tool name (detail specs inherit the parent's tool). */
  tool: string;
  /** Runtime 1-of-N connection selection (Wave 4), threaded to the dispatcher. */
  connectionSelector?: ConnectionSelector | null;
}

// ── dot-path getter ───────────────────────────────────────────────────────────

function getPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

// ── `{{param}}` interpolation that reports whether every token resolved ────────
//
// A query key whose value references a param that is empty/undefined is DROPPED
// (mirrors the hand-written skills that only append `&q=…` when `q` is present).
function interpolateTracked(
  template: string,
  params: Record<string, unknown>
): { value: string; allPresent: boolean } {
  let allPresent = true;
  const value = template.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
    const v = params[key];
    if (v === undefined || v === null || v === "") {
      allPresent = false;
      return "";
    }
    return String(v);
  });
  return { value, allPresent };
}

// ── paramMapping: defaults · @now · required · clamp (NO encode here) ──────────
//
// Encoding is applied per-call at PATH-interpolation time only, so a scalar echo
// of a param (e.g. `calendarId`) returns the RAW value, byte-identical to the
// hand-written skills.
function applyParamMapping(
  spec: { paramMapping?: ProviderVerbSpec["paramMapping"] },
  parameters: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...parameters };
  for (const [name, m] of Object.entries(spec.paramMapping ?? {})) {
    let v = out[name];
    if (v === undefined || v === null || v === "") v = m.default;
    if (v === "@now") v = new Date().toISOString();
    if (m.required && (v === undefined || v === null || v === "")) {
      throw new Error(`provider verb: required parameter "${name}" is missing`);
    }
    if (
      v !== undefined &&
      v !== null &&
      (m.clampMin !== undefined || m.clampMax !== undefined)
    ) {
      let n = Number(v);
      if (!Number.isFinite(n)) n = Number(m.default);
      if (m.clampMin !== undefined) n = Math.max(n, m.clampMin);
      if (m.clampMax !== undefined) n = Math.min(n, m.clampMax);
      v = n;
    }
    out[name] = v;
  }
  return out;
}

/** Path-only param map: encode `encode:"uri"` params for safe interpolation. */
function encodeForPath(
  spec: { paramMapping?: ProviderVerbSpec["paramMapping"] },
  mapped: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...mapped };
  for (const [name, m] of Object.entries(spec.paramMapping ?? {})) {
    if (m.encode === "uri" && out[name] !== undefined && out[name] !== null) {
      out[name] = encodeURIComponent(String(out[name]));
    }
  }
  return out;
}

/** Build `key=value&…`; arrays → repeated keys; drop keys with empty tokens. */
function buildQueryString(
  query: ProviderVerbSpec["query"],
  mapped: Record<string, unknown>
): string {
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(query ?? {})) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const tpl of values) {
      const { value, allPresent } = interpolateTracked(String(tpl), mapped);
      if (!allPresent) continue;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.join("&");
}

// ── response shaping ──────────────────────────────────────────────────────────

function mapItem(
  el: unknown,
  itemMap: Record<string, string> | undefined
): unknown {
  if (!itemMap) return el;
  const o: Record<string, unknown> = {};
  for (const [outField, srcPath] of Object.entries(itemMap)) {
    const v = getPath(el, srcPath);
    o[outField] = v === undefined ? null : v;
  }
  return o;
}

function resolveScalar(
  src: string,
  body: unknown,
  mapped: Record<string, unknown>,
  collectionLen: number | undefined
): unknown {
  if (src === "@count") return collectionLen ?? 0;
  const tok = src.match(/^\{\{(\w+)\}\}$/);
  if (tok) {
    const v = mapped[tok[1]!];
    return v === undefined ? null : v;
  }
  const v = getPath(body, src);
  return v === undefined ? null : v;
}

function applyResponseShape(
  body: unknown,
  shape: ProviderVerbSpec["responseShape"],
  mapped: Record<string, unknown>
): unknown {
  if (!shape) return body;
  const out: Record<string, unknown> = {};

  // Collection first so `@count` scalars can reference its length.
  let collection: unknown[] | undefined;
  if (shape.collectionPath !== undefined) {
    const arr = getPath(body, shape.collectionPath);
    collection = (Array.isArray(arr) ? arr : []).map((el) =>
      mapItem(el, shape.item)
    );
  }

  for (const [outField, src] of Object.entries(shape.scalar ?? {})) {
    out[outField] = resolveScalar(src, body, mapped, collection?.length);
  }

  if (shape.headers) {
    const headersArr =
      getPath(body, "payload.headers") ??
      (body && typeof body === "object"
        ? (body as Record<string, unknown>).headers
        : undefined);
    for (const [outField, headerName] of Object.entries(shape.headers)) {
      const found = Array.isArray(headersArr)
        ? headersArr.find(
            (h) =>
              String((h as { name?: unknown })?.name ?? "").toLowerCase() ===
              headerName.toLowerCase()
          )
        : undefined;
      out[outField] = found
        ? ((found as { value?: unknown }).value ?? null)
        : null;
    }
  }

  if (collection !== undefined) {
    out[shape.collectionAs ?? "results"] = collection;
  }

  return out;
}

// ── single provider call (used by the top-level verb AND each expand detail) ──

type SingleOutcome =
  | { kind: "shaped"; value: unknown }
  | { kind: "proposed"; result: unknown }
  | { kind: "error"; message: string; result: unknown };

async function executeSingleCall(
  spec: DetailSpec,
  parameters: Record<string, unknown>,
  ctx: CallCtx
): Promise<SingleOutcome> {
  const mapped = applyParamMapping(spec, parameters);
  const mappedForPath = encodeForPath(spec, mapped);

  let path = interpolateString(spec.pathTemplate, mappedForPath);
  const qs = buildQueryString(spec.query, mapped);
  if (qs) path += (path.includes("?") ? "&" : "?") + qs;

  const body = spec.body
    ? (interpolateDeep(spec.body, mapped) as Record<string, unknown>)
    : undefined;

  const result = await triggerProviderAction({
    userId: ctx.userId,
    provider: ctx.tool,
    method: spec.method,
    path,
    body,
    baseUrlOverride: spec.baseUrlOverride,
    headers: spec.headers,
    workspaceId: ctx.workspaceId,
    connectionSelector: ctx.connectionSelector,
    // Skill-level gate already ran in executeCapability → skip the tool gate so
    // this Tier-1 dispatch does not double-propose (same contract as Door-2).
    alreadyApproved: true,
  });

  if (result.proposed === true) return { kind: "proposed", result };
  if (!result.success) {
    return {
      kind: "error",
      message: result.error ?? `provider call failed (status ${result.status})`,
      result,
    };
  }
  return {
    kind: "shaped",
    value: applyResponseShape(result.body, spec.responseShape, mapped),
  };
}

// ── expand: bounded per-id detail fan-out, merged into list items ─────────────

async function runExpand(
  shaped: unknown,
  expand: NonNullable<ProviderVerbSpec["expand"]>,
  ctx: CallCtx
): Promise<unknown> {
  const arr = getPath(shaped, expand.forEachIdFrom);
  if (!Array.isArray(arr)) return shaped;

  const concurrency = Math.max(1, expand.concurrency ?? 5);
  for (let i = 0; i < arr.length; i += concurrency) {
    const chunk = arr.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (item) => {
        const isObj = item != null && typeof item === "object";
        try {
          const id = isObj
            ? ((item as Record<string, unknown>).id ?? item)
            : item;
          const outcome = await executeSingleCall(expand.detail, { id }, ctx);
          if (
            outcome.kind === "shaped" &&
            isObj &&
            outcome.value &&
            typeof outcome.value === "object"
          ) {
            Object.assign(item as Record<string, unknown>, outcome.value);
          } else if (outcome.kind === "error" && isObj) {
            (item as Record<string, unknown>).error = outcome.message;
          }
        } catch (e) {
          if (isObj) (item as Record<string, unknown>).error = String(e);
        }
      })
    );
  }
  return shaped;
}

// ── public entry ──────────────────────────────────────────────────────────────

export async function executeProviderVerb(
  spec: ProviderVerbSpec,
  parameters: Record<string, unknown> | undefined,
  opts: {
    userId: string;
    workspaceId?: string;
    connectionSelector?: ConnectionSelector | null;
  }
): Promise<unknown> {
  const ctx: CallCtx = {
    userId: opts.userId,
    workspaceId: opts.workspaceId,
    tool: spec.tool,
    connectionSelector: opts.connectionSelector ?? null,
  };

  const outcome = await executeSingleCall(spec, parameters ?? {}, ctx);
  // A proposal/error envelope is returned as-is so the caller sees it inline
  // (Tier-1 verbs are read-only + alreadyApproved, so neither is expected).
  if (outcome.kind === "proposed") return outcome.result;
  if (outcome.kind === "error") return outcome.result;

  let shaped = outcome.value;
  if (spec.expand) shaped = await runExpand(shaped, spec.expand, ctx);
  return shaped;
}
