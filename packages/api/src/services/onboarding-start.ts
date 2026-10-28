/**
 * Onboarding start — the pod's server reads (plan v1 §1 Gate, §2.1, §2.2; A5).
 *
 * Four jobs, each one door:
 *   - `listBundledStarts`   the starts, read from the BUNDLED templates package
 *                           (`meta.start`): no network, so a self-hosted pod
 *                           lists them offline.
 *   - `isStartDue`          when onboarding is due (the pure rule).
 *   - `readCloudAnswers`    the cloud pull of the person's answers. Four states
 *                           that are never folded together: an EMPTY answer
 *                           and a FAILED read are different facts.
 *   - `gatherStartFacts`    what the server observed, for the pure model
 *                           (`@synap-core/types/onboarding/start`) to decide.
 */

import { z } from "zod";
import {
  and,
  apiKeys,
  desc,
  drizzleSql,
  eq,
  getDb,
  inArray,
  isNull,
  podCpAuthHeaders,
  proposals,
  readControlPlaneLink,
  workspaces,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { listWorkspaceTemplates } from "@synap-core/workspace-templates";
import { resolveAgentConnection } from "@synap-core/types/agents";
import type {
  StartFacts,
  StartValues,
} from "@synap-core/types/onboarding/start";
import { loadAgentPresence } from "./agent-presence.js";

const logger = createLogger({ module: "onboarding-start" });

// ── Starts (bundled, offline) ──────────────────────────────────────────────

/** `meta.start` (plan §2.0). Read defensively: older bundles carry none. */
const startDeclarationSchema = z.object({
  order: z.number().int(),
  label: z.string().min(1),
  promise: z.string().min(1),
  suggestFor: z.array(z.string()).default([]),
  profile: z.string().min(1),
  views: z.array(z.string().min(1)).min(1).max(3),
  example: z.array(z.record(z.string(), z.unknown())).default([]),
  firstSession: z.object({ title: z.string(), goal: z.string() }).optional(),
  starters: z.array(z.string()).default([]),
});

export interface StartCard extends z.infer<typeof startDeclarationSchema> {
  /** The template slug: the start's identity. */
  slug: string;
  icon: string;
}

export function listBundledStarts(): StartCard[] {
  const out: StartCard[] = [];
  for (const template of listWorkspaceTemplates()) {
    const raw = (template.meta as { start?: unknown }).start;
    if (raw === undefined) continue;
    const parsed = startDeclarationSchema.safeParse(raw);
    if (!parsed.success) {
      // A declared-but-broken start is a catalog defect: say so, never offer it.
      logger.warn(
        { slug: template.meta.slug },
        "meta.start is invalid — not offered"
      );
      continue;
    }
    out.push({
      ...parsed.data,
      slug: template.meta.slug,
      icon: template.meta.icon,
    });
  }
  return out.sort((a, b) => a.order - b.order);
}

// ── When onboarding is due (§1 Gate) ───────────────────────────────────────

export function isStartDue(input: {
  isPodAdmin: boolean;
  journeyStatus: string | null;
  hasStartValues: boolean;
  nonSystemSpaceCount: number;
}): boolean {
  if (!input.isPodAdmin) return false;
  const open =
    input.journeyStatus === "offered" ||
    input.journeyStatus === "active" ||
    input.journeyStatus === "paused";
  // "Existing pods with spaces never see onboarding": an `offered` row can be
  // made by an unrelated values write, so an open journey only counts once it
  // is a start journey (`values.start`) or the pod is still empty.
  if (open) return input.hasStartValues || input.nonSystemSpaceCount === 0;
  if (input.journeyStatus === null) return input.nonSystemSpaceCount === 0;
  return false; // completed, dismissed
}

export async function countNonSystemSpaces(): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ n: drizzleSql<number>`count(*)::int` })
    .from(workspaces)
    .where(
      and(
        isNull(workspaces.archivedAt),
        isNull(workspaces.systemSlug),
        drizzleSql`${workspaces.settings}->>'systemSlug' is null`
      )
    );
  return row?.n ?? 0;
}

// ── The cloud pull (§2.1) ──────────────────────────────────────────────────

const answersSchema = z
  .object({
    start: z.string().optional(),
    workingOn: z.string().optional(),
    identity: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
    answeredAt: z.string().optional(),
  })
  .strip();

const cpAnswersSchema = z.object({
  v: z.literal(1),
  owner: z.object({
    email: z.string().nullable(),
    adminEmail: z.string().nullable().optional(),
  }),
  answers: answersSchema.nullable(),
  experiments: z.record(z.string(), z.string()).nullable().optional(),
});

export type CloudAnswers = z.infer<typeof answersSchema>;

export type CloudState =
  | {
      status: "ok";
      answers: CloudAnswers;
      experiments: Record<string, string> | null;
    }
  | { status: "empty" }
  | { status: "not-linked" }
  | { status: "failed"; reason: CloudFailure };

export type CloudFailure =
  | "link-unreadable"
  | "not-enrolled"
  | "credential"
  | "unreachable"
  | "refused"
  | "unknown-pod"
  | "server-error"
  | "invalid";

const failed = (reason: CloudFailure): CloudState => ({
  status: "failed",
  reason,
});

const sameEmail = (a: string | null | undefined, b: string) =>
  !!a && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Pull the owner's answers from this pod's Control Plane. Pure read: safe to
 * repeat. Answers apply ONLY to the pod's owner (`owner.email` or
 * `owner.adminEmail`, case-insensitive): any other viewer reads `empty`.
 */
export async function readCloudAnswers(
  viewerEmail: string
): Promise<CloudState> {
  let link: Awaited<ReturnType<typeof readControlPlaneLink>>;
  try {
    link = await readControlPlaneLink();
  } catch (err) {
    logger.warn({ err }, "control-plane link unreadable");
    return failed("link-unreadable");
  }
  if (!link) return { status: "not-linked" };

  const cpUrl = (link.url ?? process.env.CONTROL_PLANE_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!cpUrl) return { status: "not-linked" };

  let auth: Awaited<ReturnType<typeof podCpAuthHeaders>>;
  try {
    auth = await podCpAuthHeaders({
      purpose: "onboarding",
      legacy: "internal-key",
      controlPlaneUrl: cpUrl,
    });
  } catch (err) {
    logger.warn({ err }, "pod credential unusable for the onboarding pull");
    return failed("credential");
  }
  // The CP refuses the legacy key on this endpoint (403): only a pod JWT works.
  if (!auth || auth.via !== "pod-jwt") return failed("not-enrolled");

  let res: Response;
  try {
    res = await fetch(`${cpUrl}/internal/onboarding-answers`, {
      headers: auth.headers,
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    logger.warn({ err }, "CP unreachable for the onboarding pull");
    return failed("unreachable");
  }
  if (!res.ok) {
    return failed(
      res.status === 401 || res.status === 403
        ? "refused"
        : res.status === 404
          ? "unknown-pod"
          : "server-error"
    );
  }

  const parsed = cpAnswersSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return failed("invalid");

  const { owner, answers, experiments } = parsed.data;
  const isOwner =
    sameEmail(owner.email, viewerEmail) ||
    sameEmail(owner.adminEmail, viewerEmail);
  if (!isOwner || !answers) return { status: "empty" };
  return { status: "ok", answers, experiments: experiments ?? null };
}

// ── Facts for the pure model (§2.2) ────────────────────────────────────────

export async function gatherStartFacts(input: {
  userId: string;
  values: StartValues | null;
  journeyStatus: string | null;
}): Promise<StartFacts> {
  const db = await getDb();
  const { userId, values } = input;

  const slug = values?.intent?.slug;
  const startViewCount = slug
    ? (listBundledStarts().find((s) => s.slug === slug)?.views.length ?? null)
    : null;

  let setupProposal: StartFacts["setupProposal"] = null;
  const proposalId = values?.setup?.proposalId;
  if (proposalId) {
    const [row] = await db
      .select({
        status: proposals.status,
        reviewedAt: proposals.reviewedAt,
        data: proposals.data,
      })
      .from(proposals)
      .where(eq(proposals.id, proposalId))
      .limit(1);
    if (row) {
      const spaceId = (row.data as { materializedWorkspaceId?: unknown } | null)
        ?.materializedWorkspaceId;
      let activeSpaceCount = 0;
      if (typeof spaceId === "string") {
        const [ws] = await db
          .select({ n: drizzleSql<number>`count(*)::int` })
          .from(workspaces)
          .where(
            and(eq(workspaces.id, spaceId), isNull(workspaces.archivedAt))
          );
        activeSpaceCount = ws?.n ?? 0;
      }
      setupProposal = {
        status: row.status,
        activeSpaceCount,
        approvedAt: row.reviewedAt?.toISOString() ?? null,
      };
    }
  }

  // The agents the viewer operates: an unrevoked hub key acting as them.
  const keys = await db
    .selectDistinct({ userId: apiKeys.userId })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.keyType, "hub_inbound"),
        eq(apiKeys.linkedUserId, userId),
        isNull(apiKeys.revokedAt)
      )
    );
  const agentIds = keys.map((k) => k.userId);
  const presence = await loadAgentPresence(agentIds);
  const roster = agentIds.map((id) => ({
    id,
    name: null,
    lastSeenAt: presence.get(id)?.lastSeenAt ?? null,
  }));
  const connection = resolveAgentConnection(roster);
  const agentConnection: StartFacts["agentConnection"] =
    connection.kind === "seen"
      ? "seen"
      : [...presence.values()].some((p) => p.pendingKeys > 0)
        ? "pending"
        : "none";

  let externalAgentApprovalReviewedAt: string | null = null;
  if (agentIds.length > 0) {
    const [latest] = await db
      .select({ reviewedAt: proposals.reviewedAt })
      .from(proposals)
      .where(
        and(
          inArray(proposals.agentUserId, agentIds),
          eq(proposals.status, "approved")
        )
      )
      .orderBy(desc(proposals.reviewedAt))
      .limit(1);
    externalAgentApprovalReviewedAt = latest?.reviewedAt?.toISOString() ?? null;
  }

  return {
    values,
    startViewCount,
    setupProposal,
    agentConnection,
    externalAgentApprovalReviewedAt,
    journeyStatus: input.journeyStatus,
  };
}

// ── The write: deep merge (§2.2) ───────────────────────────────────────────

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Objects merge key by key, recursively; arrays and scalars are replaced. */
export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] =
      isPlain(v) && isPlain(out[k])
        ? deepMerge(out[k] as Record<string, unknown>, v)
        : v;
  }
  return out;
}
