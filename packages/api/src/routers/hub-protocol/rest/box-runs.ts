/**
 * Hub Protocol REST — box runs, the provisioner side (code-runtime B0; the
 * wire contract is lanes/code-runtime/BOX-CONTRACT.md).
 *
 *   POST /box-runs/lease            {capacity?}                 → {run | null}
 *   POST /box-runs/:id/heartbeat    {leaseId, phase}            → {leaseExpiresAt, stopRequested}
 *   POST /box-runs/:id/uploads      {leaseId, filename, mimeType, size} → presigned ticket
 *   POST /box-runs/:id/finish       {leaseId, status, exitCode, …}      → {id, status, files}
 *
 * WHO MAY CALL: a COMPUTER (`users.agent_type = 'machine'`, the device-flow
 * key) whose key holds `box.runner` — the scope the person turns on for that
 * computer (`machines.setRunsScripts`). Any other caller is refused before a
 * row is read. A computer acts only on runs of ITS OWN person (the approver
 * who connected it); the person floor is read off the computer row, never the
 * request.
 *
 * Static `/box-runs/lease` is registered BEFORE the `/:id` routes (Hono).
 * Not in the OpenAPI registry, like the device door: a machine protocol whose
 * spec is the contract file, not an agent-facing tool.
 */

import { z } from "zod";
import { and, db, eq } from "@synap/database";
import { BOX_RUNNER_SCOPE, users } from "@synap/database/schema";
import { MACHINE_AGENT_TYPE } from "@synap-core/types/agents";
import { hasScope, logger, requireUuidParam, type HubHono } from "./_shared.js";
import {
  finishBoxRun,
  heartbeatBoxRun,
  leaseBoxRun,
  loadLeasedBoxRun,
  boxStatusForVerdict,
  BOX_MAX_FILES,
  type BoxRunner,
  type LeaseRefusal,
} from "../../../services/box-runs/box-runs.js";

const LeaseBody = z
  .object({
    capacity: z
      .object({
        memoryMb: z.number().nonnegative().optional(),
        diskGb: z.number().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const LeaseId = z.string().uuid();

const HeartbeatBody = z.object({
  leaseId: LeaseId,
  phase: z.enum(["setup", "running"]),
});

const UploadBody = z.object({
  leaseId: LeaseId,
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(255),
  size: z.number().int().positive(),
});

const FinishBody = z
  .object({
    leaseId: LeaseId,
    status: z.enum(["done", "failed", "stopped", "timeout", "infra"]),
    exitCode: z.number().int().nullable().optional(),
    durationMs: z.number().int().nonnegative().nullable().optional(),
    infraReason: z.string().max(1000).optional(),
    log: z
      .object({
        head: z.string().optional(),
        tail: z.string().optional(),
        totalBytes: z.number().int().nonnegative().nullable().optional(),
        truncated: z.boolean().optional(),
      })
      .optional(),
    files: z
      .array(
        z.object({
          path: z.string().min(1).max(500),
          size: z.number().int().nonnegative().optional(),
          sha256: z.string().max(128).optional(),
          title: z.string().max(255).optional(),
          uploadToken: z.string().min(1).max(4096).optional(),
        })
      )
      .max(BOX_MAX_FILES)
      .optional(),
    blockedEgress: z
      .array(
        z.object({
          host: z.string().min(1).max(300),
          port: z.number().int().min(0).max(65535).optional(),
          phase: z.enum(["setup", "run"]).optional(),
          reason: z.string().max(500).optional(),
          at: z.string().max(64).optional(),
        })
      )
      .max(500)
      .optional(),
    installedPackages: z
      .array(
        z.object({
          name: z.string().min(1).max(214),
          version: z.string().min(1).max(64),
          manager: z.string().max(32).optional(),
        })
      )
      .max(500)
      .optional(),
  })
  .refine((b) => b.status !== "infra" || !!b.infraReason?.trim(), {
    message: "infraReason is required when status is infra",
    path: ["infraReason"],
  });

/**
 * The computer behind this request, or the refusal. Scope first (cheap, no
 * read), then the principal: the acting agent must be a computer, and the
 * request's person must be the computer's own person.
 */
async function resolveRunner(c: {
  get: (k: "scopes" | "agentUserId" | "userId") => unknown;
}): Promise<
  | { ok: true; runner: BoxRunner }
  | { ok: false; status: 401 | 403; code: string; error: string }
> {
  const scopes = (c.get("scopes") as string[] | undefined) ?? [];
  if (!hasScope(scopes, BOX_RUNNER_SCOPE)) {
    return {
      ok: false,
      status: 403,
      code: "SCOPE_REQUIRED",
      error: `Insufficient scope: ${BOX_RUNNER_SCOPE} required. Turn on "Runs scripts" for this computer.`,
    };
  }
  const agentUserId = c.get("agentUserId") as string | undefined;
  const userId = c.get("userId") as string | undefined;
  if (!userId) {
    return {
      ok: false,
      status: 401,
      code: "UNAUTHORIZED",
      error: "Unauthorized",
    };
  }
  const [machine] = agentUserId
    ? await db
        .select({ id: users.id, owner: users.createdByUserId })
        .from(users)
        .where(
          and(
            eq(users.id, agentUserId),
            eq(users.agentType, MACHINE_AGENT_TYPE)
          )
        )
        .limit(1)
    : [];
  if (!machine || !machine.owner || machine.owner !== userId) {
    return {
      ok: false,
      status: 403,
      code: "NOT_A_COMPUTER",
      error: "Only a connected computer's own key can run box runs.",
    };
  }
  return {
    ok: true,
    runner: { machineUserId: machine.id, ownerUserId: machine.owner },
  };
}

const REFUSAL_HTTP = { NOT_FOUND: 404, LEASE_LOST: 409 } as const;
const REFUSAL_TEXT = {
  NOT_FOUND: "No such box run for this computer's person.",
  LEASE_LOST:
    "This lease is no longer held (expired and re-leased, stale lease id, or the run finished). Destroy the box; do not finish.",
} as const;

export function registerBoxRunsRoutes(app: HubHono): void {
  const refused = (
    c: Parameters<Parameters<HubHono["post"]>[1]>[0],
    r: LeaseRefusal
  ) =>
    c.json({ code: r.code, error: REFUSAL_TEXT[r.code] }, REFUSAL_HTTP[r.code]);

  async function body<T extends z.ZodTypeAny>(
    c: { req: { json: () => Promise<unknown> } },
    schema: T
  ): Promise<{ ok: true; data: z.output<T> } | { ok: false; error: string }> {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      raw = {};
    }
    const parsed = schema.safeParse(raw ?? {});
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      return {
        ok: false,
        error: `${i?.path.join(".") || "body"}: ${i?.message ?? "invalid"}`,
      };
    }
    return { ok: true, data: parsed.data };
  }

  // ── POST /box-runs/lease (static, BEFORE /:id) ──────────────────────────
  app.post("/box-runs/lease", async (c) => {
    const who = await resolveRunner(c);
    if (!who.ok)
      return c.json({ code: who.code, error: who.error }, who.status);
    const parsed = await body(c, LeaseBody);
    if (!parsed.ok)
      return c.json({ code: "BAD_REQUEST", error: parsed.error }, 400);
    try {
      const run = await leaseBoxRun(who.runner);
      return c.json({ run });
    } catch (err) {
      logger.error({ err }, "box-runs lease failed");
      return c.json({ code: "INTERNAL", error: "Lease failed" }, 500);
    }
  });

  // ── POST /box-runs/:id/heartbeat ─────────────────────────────────────────
  app.post("/box-runs/:id/heartbeat", async (c) => {
    const who = await resolveRunner(c);
    if (!who.ok)
      return c.json({ code: who.code, error: who.error }, who.status);
    const runId = requireUuidParam(c, "id");
    if (runId instanceof Response) return runId;
    const parsed = await body(c, HeartbeatBody);
    if (!parsed.ok)
      return c.json({ code: "BAD_REQUEST", error: parsed.error }, 400);
    const out = await heartbeatBoxRun({
      runId,
      leaseId: parsed.data.leaseId,
      phase: parsed.data.phase,
      runner: who.runner,
    });
    if (!out.ok) return refused(c, out);
    return c.json({
      leaseExpiresAt: out.leaseExpiresAt,
      stopRequested: out.stopRequested,
    });
  });

  // ── POST /box-runs/:id/uploads ───────────────────────────────────────────
  // One `/out` file: the EXISTING presigned upload lane, minted for the run's
  // REQUESTER (person, agent, session, workspace) — never for the computer, so
  // the file lands as the work of whoever asked, in their session.
  app.post("/box-runs/:id/uploads", async (c) => {
    const who = await resolveRunner(c);
    if (!who.ok)
      return c.json({ code: who.code, error: who.error }, who.status);
    const runId = requireUuidParam(c, "id");
    if (runId instanceof Response) return runId;
    const parsed = await body(c, UploadBody);
    if (!parsed.ok)
      return c.json({ code: "BAD_REQUEST", error: parsed.error }, 400);
    const held = await loadLeasedBoxRun({
      runId,
      leaseId: parsed.data.leaseId,
      runner: who.runner,
    });
    if (!held.ok) return refused(c, held);
    const { requestAgentUpload } =
      await import("../../../services/files/agent-upload.js");
    const ticket = await requestAgentUpload({
      userId: held.run.userId,
      ...(held.run.agentUserId ? { agentUserId: held.run.agentUserId } : {}),
      workspaceId: held.run.workspaceId ?? undefined,
      filename: parsed.data.filename,
      mimeType: parsed.data.mimeType,
      size: parsed.data.size,
      ...(held.run.sessionId ? { sessionId: held.run.sessionId } : {}),
    });
    if (!ticket.ok) {
      return c.json({ code: ticket.code, error: ticket.error }, ticket.status);
    }
    const { ok: _ok, ...rest } = ticket;
    return c.json(rest);
  });

  // ── POST /box-runs/:id/finish ────────────────────────────────────────────
  app.post("/box-runs/:id/finish", async (c) => {
    const who = await resolveRunner(c);
    if (!who.ok)
      return c.json({ code: who.code, error: who.error }, who.status);
    const runId = requireUuidParam(c, "id");
    if (runId instanceof Response) return runId;
    const parsed = await body(c, FinishBody);
    if (!parsed.ok)
      return c.json({ code: "BAD_REQUEST", error: parsed.error }, 400);
    const b = parsed.data;
    const out = await finishBoxRun({
      runId,
      leaseId: b.leaseId,
      runner: who.runner,
      verdict: b.status,
      exitCode: b.exitCode ?? null,
      durationMs: b.durationMs ?? null,
      ...(b.infraReason ? { infraReason: b.infraReason.trim() } : {}),
      ...(b.log ? { log: b.log } : {}),
      ...(b.files ? { files: b.files } : {}),
      ...(b.blockedEgress ? { blockedEgress: b.blockedEgress } : {}),
      ...(b.installedPackages
        ? { installedPackages: b.installedPackages }
        : {}),
    });
    if (!out.ok) return refused(c, out);
    return c.json({
      id: out.run.id,
      status: boxStatusForVerdict(b.status),
      files: (out.run.evidence?.files ?? []).map((f) => ({
        path: f.path,
        status: f.status,
        ...(f.fileEntityId ? { fileEntityId: f.fileEntityId } : {}),
        ...(f.documentId ? { documentId: f.documentId } : {}),
        ...(f.proposalId ? { proposalId: f.proposalId } : {}),
        ...(f.error ? { error: f.error } : {}),
      })),
    });
  });
}
