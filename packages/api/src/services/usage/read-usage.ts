/**
 * The ONE usage read door (0364 `api_usage_buckets`), behind the pod-admin
 * floor: usage is pod-wide (every key, every client), so only the pod's owner
 * and admins read it. Called by `synap_diagnose` type `usage` and Hub
 * `GET /api/hub/usage`. Never on the public `/metrics`.
 */

import { TRPCError } from "@trpc/server";
import {
  API_USAGE_GROUP_BY,
  API_USAGE_RETENTION_DAYS,
  db,
  readApiUsage,
  type ApiUsageGroupBy,
  type ApiUsageQuery,
} from "@synap/database";
import { isPodAdmin } from "../../utils/workspace-role.js";

export const USAGE_FORBIDDEN_MESSAGE =
  "Usage telemetry is pod-wide: only the pod's owner and admins can read it.";

/** What a caller may send, as strings (query string or tool args). */
export interface UsageRequest {
  /** ISO time, or a span back from now: `30m`, `24h`, `7d` (default `24h`). */
  since?: string;
  until?: string;
  /** Comma-separated or a list, from `API_USAGE_GROUP_BY`. */
  groupBy?: string | readonly string[];
  apiKeyId?: string;
  client?: string;
  limit?: number | string;
}

/** A `since`/`until` value → a Date, or an error naming the accepted forms. */
function parseTime(raw: string, field: string, now: number): Date {
  const span = /^(\d{1,4})([mhd])$/.exec(raw.trim());
  if (span) {
    const n = Number(span[1]);
    const unit =
      span[2] === "m" ? 60_000 : span[2] === "h" ? 3_600_000 : 86_400_000;
    return new Date(now - n * unit);
  }
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `${field} must be an ISO time or a span like 30m, 24h, 7d (got "${raw}").`,
    });
  }
  return at;
}

/** Validate a request into the database query (unknown group-bys are refused, not dropped). */
export function parseUsageRequest(
  req: UsageRequest,
  now: number = Date.now()
): ApiUsageQuery {
  const groups = (
    typeof req.groupBy === "string"
      ? req.groupBy.split(",")
      : (req.groupBy ?? [])
  )
    .map((g) => g.trim())
    .filter(Boolean);
  const unknown = groups.filter(
    (g) => !(API_USAGE_GROUP_BY as readonly string[]).includes(g)
  );
  if (unknown.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Unknown groupBy ${unknown.join(", ")}. Expected any of: ${API_USAGE_GROUP_BY.join(", ")}.`,
    });
  }
  const since = req.since ? parseTime(req.since, "since", now) : undefined;
  const limit = req.limit === undefined ? undefined : Number(req.limit);
  return {
    since,
    until: req.until ? parseTime(req.until, "until", now) : undefined,
    groupBy: groups.length ? (groups as ApiUsageGroupBy[]) : undefined,
    apiKeyId: req.apiKeyId || undefined,
    client: req.client || undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  };
}

/** Usage grouped as asked, for a pod admin; FORBIDDEN for anyone else. */
export async function readUsageForCaller(userId: string, req: UsageRequest) {
  if (!(await isPodAdmin(userId))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: USAGE_FORBIDDEN_MESSAGE,
    });
  }
  const query = parseUsageRequest(req);
  const result = await readApiUsage(db, query);
  return { ...result, retentionDays: API_USAGE_RETENTION_DAYS };
}
