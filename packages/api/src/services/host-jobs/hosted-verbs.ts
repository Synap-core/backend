/**
 * Hosted verbs (plan b647769e §3.2, plan 64072312 U8): a recipe of a tool
 * INSTALLED on one of the person's computers, run there by the host runner
 * (`synap worker`) with nobody at the keyboard, asked through the pod: a
 * person's Run, an agent (through the capability gate), a playbook step.
 *
 *   queue   ← `computer.run_recipe` (builtin verb, post-gate): choose the
 *             computer (`chooseRecipeComputer`: where the tool is installed
 *             and checked), check the recipe and its values against the
 *             installation's APPROVED manifest, check each input file is one
 *             the person can read, then queue a host job of kind `verb` on
 *             that installation. Only that computer can lease it.
 *   lease   ← `leaseHostJob`: each input file becomes a signed GET minted at
 *             THIS lease for the job's owner (`leaseInputs`); a file gone or no
 *             longer readable fails the run with the reason.
 *   uploads ← `POST /host-jobs/:id/uploads`: each output through the box
 *             runs' lane (`requestAgentUpload`), minted for the REQUESTER.
 *   finish  ← `finishHostJob` → `storeVerbFiles`: each uploaded output is
 *             stored as the requester's file (`finalizeAgentUpload`), and the
 *             job's evidence names it. The asking session hears it.
 *
 * The host job IS the run's record: steps, masked log, files. The capability
 * call answers `{status: "queued", hostJobId}` (`isQueuedHostVerbResult`), so
 * nothing reads a queued run as done.
 */

import { and, desc, eq, inArray, lt, ne, type SQL } from "drizzle-orm";
import { db } from "@synap/database";
import {
  HOST_JOB_STATUSES,
  hostJobs,
  installations,
  users,
  type HostJobRow,
  type HostJobStatus,
} from "@synap/database/schema";
import type {
  HostJobFile,
  HostJobInputFile,
  HostJobStoredFile,
} from "@synap-core/types/host-jobs";
import { createLogger } from "@synap-core/core";
import { isUuid } from "@synap-core/types/property-render";
import { listPersonsComputers } from "../installations/request-installation.js";
import type { RunStatus, UnifiedRun } from "../runs/types.js";
import { hostJobReadStatus, installationHealth } from "./host-jobs.js";
import {
  chooseRecipeComputer,
  fileIdsOf,
  HOSTED_VERB_INPUT_URL_SECONDS,
  inputFileName,
  manifestRecipes,
  recipeValuesProblem,
  RUN_RECIPE_VERB,
  RUNNABLE_HEALTH,
  type RecipeRunCandidate,
} from "./hosted-verb-rules.js";
import { rankByTerms } from "../../utils/term-match.js";

const logger = createLogger({ module: "hosted-verbs" });

// ── The queued answer ───────────────────────────────────────────────────────

/** What a queued hosted verb run hands back as the capability run's result. */
export interface HostVerbQueuedResult {
  status: "queued";
  hostJobId: string;
  computer: { id: string; name: string };
  capabilityKey: string;
  recipe: string;
  message: string;
}

/** True for the result a queued hosted verb run hands back (not yet performed). */
export function isQueuedHostVerbResult(
  result: unknown
): result is HostVerbQueuedResult {
  return (
    !!result &&
    typeof result === "object" &&
    (result as { status?: unknown }).status === "queued" &&
    typeof (result as { hostJobId?: unknown }).hostJobId === "string"
  );
}

/** One room line in the asking session; never fails the run. */
async function roomNotice(
  sessionId: string | null,
  content: string,
  key: string
): Promise<void> {
  if (!sessionId) return;
  try {
    const { postSessionNotice } =
      await import("../agent-dispatch/binding-call.js");
    await postSessionNotice(sessionId, content, key);
  } catch (err) {
    logger.warn({ err, sessionId }, "hosted verb: room notice not posted");
  }
}

// ── Queue ───────────────────────────────────────────────────────────────────

export interface QueueRecipeRunInput {
  /** The person: owner of the computer, the files and the run. */
  userId: string;
  agentUserId?: string | null;
  sessionId?: string | null;
  workspaceId?: string | null;
  proposalId?: string | null;
  /** The verb that asked (`computer.run_recipe`'s skill row), when known. */
  skillId?: string | null;
  capabilityKey: string;
  recipe: string;
  values: Record<string, unknown>;
  /** A computer as the caller names it ("mac", its name or id). */
  computer?: string | null;
}

export type QueueRecipeRunResult =
  | { ok: true; job: HostJobRow; result: HostVerbQueuedResult }
  | { ok: false; code: string; error: string };

export async function queueRecipeRun(
  input: QueueRecipeRunInput
): Promise<QueueRecipeRunResult> {
  const rows = await db
    .select()
    .from(installations)
    .where(
      and(
        eq(installations.userId, input.userId),
        eq(installations.capabilityKey, input.capabilityKey),
        ne(installations.status, "removed")
      )
    );
  const now = new Date();
  const candidates: RecipeRunCandidate[] = rows.map((r) => {
    const h = installationHealth(r, now);
    return {
      installationId: r.id,
      machineUserId: r.machineUserId,
      status: r.status,
      health: h.health,
      healthDetail: h.detail,
      verifiedAt: r.verifiedAt,
      manifest: r.manifest ?? {},
    };
  });
  const computers = await listPersonsComputers(input.userId);
  const choice = chooseRecipeComputer({
    capabilityKey: input.capabilityKey,
    candidates,
    computers,
    ref: input.computer ?? null,
  });
  if (!choice.ok) return choice;
  const { candidate, computer } = choice;

  const recipes = manifestRecipes(candidate.manifest);
  const recipe = recipes.find((r) => r.name === input.recipe);
  if (!recipe) {
    // The recipes are the APPROVED version's (the manifest snapshot), never
    // the pod's today. A recipe the pod's current definition has needs that
    // update approved first (an update moves the snapshot, and asks); one it
    // does not have is not there to update to. The fix comes first, the list
    // last: an approval keeps ~180 characters of a reason.
    const { loadInstallableCapability } =
      await import("../installations/installations.js");
    const onPod = await loadInstallableCapability(input.capabilityKey);
    const podHasIt =
      !!onPod &&
      manifestRecipes(onPod.manifest).some((r) => r.name === input.recipe);
    const list =
      recipes.length > 0
        ? `Its recipes: ${recipes.map((r) => r.name).join(", ")}.`
        : "It declares no recipes.";
    return {
      ok: false,
      code: "UNKNOWN_RECIPE",
      error: podHasIt
        ? `${input.capabilityKey} on ${computer.name}: its approved version has no recipe "${input.recipe}", the pod's current one has it. Ask for the update (synap_request_installation, action "update") and approve it. ${list}`
        : `${input.capabilityKey} on ${computer.name} has no recipe "${input.recipe}", and neither has the pod's ${input.capabilityKey}. ${list}`,
    };
  }
  const problem = recipeValuesProblem(recipe, input.values);
  if (problem) return { ok: false, code: "BAD_PARAMS", error: problem };

  // The files a run makes land in a space (the upload door needs one): the
  // ask's, else the installation's.
  const workspaceId =
    input.workspaceId ??
    rows.find((r) => r.id === candidate.installationId)?.workspaceId ??
    null;
  const makesFiles = Object.values(recipe.params).some(
    (p) => p.type === "output"
  );
  if (makesFiles && !workspaceId) {
    return {
      ok: false,
      code: "NO_SPACE",
      error: `“${recipe.name}” makes files, and they need a space: pass workspaceId (the space the files go to).`,
    };
  }

  // Each input file must be one the person can read, with bytes, now; the
  // lease reads it again (it may be gone by then).
  const { readableFileEntity } = await import("../../routers/file-upload.js");
  for (const [param, ids] of Object.entries(fileIdsOf(recipe, input.values))) {
    for (const id of ids) {
      const readable = await readableFileEntity(input.userId, id);
      if (!readable.ok) {
        return {
          ok: false,
          code: "FILE_NOT_READABLE",
          error: `${param}: the file ${id} is ${readable.status === 404 ? "not found" : "not one you can read"}.`,
        };
      }
      if (!readable.entity.storageKey) {
        return {
          ok: false,
          code: "FILE_NOT_READABLE",
          error: `${param}: the file ${id} has no stored bytes.`,
        };
      }
    }
  }

  const [job] = await db
    .insert(hostJobs)
    .values({
      kind: "verb",
      installationId: candidate.installationId,
      userId: input.userId,
      machineUserId: candidate.machineUserId,
      agentUserId: input.agentUserId ?? null,
      sessionId: input.sessionId ?? null,
      workspaceId,
      proposalId: input.proposalId ?? null,
      skillId: input.skillId ?? null,
      spec: {
        op: "verb",
        capabilityKey: input.capabilityKey,
        recipe: recipe.name,
      },
      parameters: input.values,
    })
    .returning();
  const label = `“${recipe.name}” (${input.capabilityKey})`;
  await roomNotice(
    job!.sessionId,
    `Queued ${label} to run on ${computer.name}.`,
    `host-verb:${job!.id}:queued`
  );
  return {
    ok: true,
    job: job!,
    result: {
      status: "queued",
      hostJobId: job!.id,
      computer: { id: computer.id, name: computer.name },
      capabilityKey: input.capabilityKey,
      recipe: recipe.name,
      message: `Queued ${label} to run on ${computer.name}. It starts when ${computer.name} picks it up; its log and files come back on the run (host job ${job!.id}).`,
    },
  };
}

// ── Discovery: the recipes installed on the person's computers ─────────────

/** One recipe of a tool installed on one of the person's computers, ready to run. */
export interface InstalledRecipeMatch {
  /** "<recipe> on <computer>". */
  label: string;
  capability: string;
  recipe: string;
  description: string;
  computer: { id: string; name: string };
  /** The recipe's params as declared (type, required, default, description). */
  params: Record<string, unknown>;
  /** What to run: `synap_run_capability` with this verb and these parameters (fill `params`). */
  run: {
    verbId: typeof RUN_RECIPE_VERB;
    parameters: { capability: string; recipe: string; computer: string };
  };
  score: number;
}

/**
 * The recipes an intent's capabilities can run NOW on the person's computers.
 * `matches`: the recipes the query's words hit (name, then description),
 * ranked; `unmatched`: per tool and computer, the names of the other recipes
 * (an intent like edit_video holds 20 of them, and words are not the only way
 * to pick one). `error`: the read failed, never an empty answer.
 */
export type InstalledRecipes =
  | {
      matches: InstalledRecipeMatch[];
      unmatched: Array<{
        capability: string;
        computer: string;
        recipes: string[];
      }>;
    }
  | { error: string };

/**
 * The recipes each of these intents can run NOW on the person's computers.
 * Read from the person's INSTALLED and checked installations only (the same
 * runnable rule a run meets, `RUNNABLE_HEALTH`), never offered from the
 * catalog: a row here can run on that computer now.
 *
 * Which intents an installed tool serves is its capability's `provides`
 * (the intents of its skills, held equal by the catalog validator), read
 * from its catalog definition through the ONE reader (`declaredProvides`).
 * Not the intent index: a media tool's skills are instruction skills, which
 * the registry folds out of verbs on purpose (decision a739e6f6), so the
 * index never names them. A tool installed from a source other than Synap's
 * catalog is not read here (its definition is not in the official cache).
 *
 * Returns intent → recipes, only for the intents some installed tool serves;
 * a failed read answers `{error}` for every intent asked.
 */
export async function installedRecipesFor(input: {
  userId: string;
  intents: readonly string[];
  query: string;
  limit: number;
}): Promise<Map<string, InstalledRecipes>> {
  const out = new Map<string, InstalledRecipes>();
  if (input.intents.length === 0) return out;
  try {
    const rows = await db
      .select()
      .from(installations)
      .where(
        and(
          eq(installations.userId, input.userId),
          eq(installations.status, "installed")
        )
      );
    const now = new Date();
    const runnable = rows.filter((r) => {
      const h = installationHealth(r, now).health;
      return (
        h !== null &&
        RUNNABLE_HEALTH.includes(h) &&
        manifestRecipes(r.manifest ?? {}).length > 0
      );
    });
    if (runnable.length === 0) return out;
    const keys = new Set(runnable.map((r) => r.capabilityKey));
    const { queryCatalogCache } =
      await import("../capabilities/catalog-cache-query.js");
    const { declaredProvides } =
      await import("../capabilities/propose-intent-gap-install.js");
    const provides = new Map<string, string[]>();
    for (const entry of await queryCatalogCache({ kind: "capability" }))
      if (keys.has(entry.slug))
        provides.set(entry.slug, declaredProvides(entry) ?? []);
    const computers = await listPersonsComputers(input.userId);
    const nameOf = new Map(computers.map((c) => [c.id, c.name]));

    for (const intent of input.intents) {
      const candidates: Array<{
        row: (typeof runnable)[number];
        recipe: ReturnType<typeof manifestRecipes>[number];
        computer: string;
      }> = [];
      for (const row of runnable) {
        if (!(provides.get(row.capabilityKey) ?? []).includes(intent)) continue;
        const computer = nameOf.get(row.machineUserId);
        if (!computer) continue;
        for (const recipe of manifestRecipes(row.manifest ?? {}))
          candidates.push({ row, recipe, computer });
      }
      if (candidates.length === 0) continue;
      const ranked = rankByTerms(
        input.query,
        candidates,
        (c) => ({
          primary: c.recipe.name.replace(/-/g, " "),
          tertiary: c.recipe.description,
        }),
        { primary: "recipe", secondary: "-", tertiary: "description" }
      ).slice(0, input.limit);
      const hit = new Set(ranked.map((r) => r.item));
      const unmatched = new Map<
        string,
        { capability: string; computer: string; recipes: string[] }
      >();
      for (const c of candidates) {
        if (hit.has(c)) continue;
        const k = `${c.row.capabilityKey}@${c.row.machineUserId}`;
        const u = unmatched.get(k) ?? {
          capability: c.row.capabilityKey,
          computer: c.computer,
          recipes: [],
        };
        u.recipes.push(c.recipe.name);
        unmatched.set(k, u);
      }
      out.set(intent, {
        matches: ranked.map(({ item: c, score }) => ({
          label: `${c.recipe.name} on ${c.computer}`,
          capability: c.row.capabilityKey,
          recipe: c.recipe.name,
          description: c.recipe.description,
          computer: { id: c.row.machineUserId, name: c.computer },
          params: c.recipe.params,
          run: {
            verbId: RUN_RECIPE_VERB,
            parameters: {
              capability: c.row.capabilityKey,
              recipe: c.recipe.name,
              computer: c.computer,
            },
          },
          score,
        })),
        unmatched: [...unmatched.values()],
      });
    }
    return out;
  } catch (err) {
    logger.warn({ err }, "installed recipes not read");
    for (const intent of input.intents)
      out.set(intent, {
        error: "The recipes installed on your computers could not be read.",
      });
    return out;
  }
}

// ── Lease: the input files ──────────────────────────────────────────────────

/**
 * The input files of a leased `verb` job, as signed GETs minted now for the
 * job's owner. Refused (with the sentence the run fails with) when the recipe
 * is gone from the approved manifest or a file is no longer readable.
 */
export async function leaseInputs(
  job: Pick<HostJobRow, "userId" | "spec" | "parameters">,
  manifest: Record<string, unknown>
): Promise<
  | { ok: true; inputs: Record<string, HostJobInputFile[]> }
  | { ok: false; error: string }
> {
  const name = (job.spec as { recipe?: unknown }).recipe;
  const recipe = manifestRecipes(manifest).find((r) => r.name === name);
  if (!recipe) {
    return {
      ok: false,
      error: `The approved manifest no longer declares the recipe "${String(name)}".`,
    };
  }
  const { signFileEntityUrl } = await import("../../routers/file-upload.js");
  const inputs: Record<string, HostJobInputFile[]> = {};
  for (const [param, ids] of Object.entries(
    fileIdsOf(recipe, job.parameters)
  )) {
    inputs[param] = [];
    for (const [i, id] of ids.entries()) {
      const signed = await signFileEntityUrl(job.userId, id, {
        expiresInSeconds: HOSTED_VERB_INPUT_URL_SECONDS,
      });
      if (!signed.ok) {
        return {
          ok: false,
          error: `${param}: the file ${id} can no longer be read (${signed.error}).`,
        };
      }
      inputs[param]!.push({
        fileEntityId: id,
        url: signed.body.url,
        expiresAt: signed.body.expiresAt,
        name: inputFileName(signed.entity.title, param, i),
        mimeType: signed.body.mimeType,
        size: signed.entity.size ?? null,
      });
    }
  }
  return { ok: true, inputs };
}

// ── Finish: the output files ────────────────────────────────────────────────

/**
 * Store the files a `verb` job's runner uploaded, as the REQUESTER's files
 * (the token was minted for them, `requestAgentUpload`). A file the runner
 * could not upload, or the door refused, is recorded with why: the evidence
 * never says "stored" for a file that is not.
 */
export async function storeVerbFiles(
  job: Pick<HostJobRow, "userId" | "agentUserId" | "sessionId" | "workspaceId">,
  files: readonly HostJobFile[]
): Promise<HostJobStoredFile[]> {
  const out: HostJobStoredFile[] = [];
  if (files.length === 0) return out;
  const { finalizeAgentUpload } = await import("../files/agent-upload.js");
  for (const f of files) {
    if (!f.uploadToken) {
      out.push({
        param: f.param,
        name: f.name,
        status: "missing",
        error: f.error ?? "The runner did not upload this file.",
      });
      continue;
    }
    try {
      // The scopes a box run's files are stored with (box-runs.ts): the
      // requester's own write, governed as theirs (an agent's may propose).
      const fin = await finalizeAgentUpload({
        userId: job.userId,
        ...(job.agentUserId ? { agentUserId: job.agentUserId } : {}),
        scopes: ["hub-protocol.read", "hub-protocol.write"],
        uploadToken: f.uploadToken,
        ...(job.sessionId ? { sessionId: job.sessionId } : {}),
        title: f.name,
      });
      const base = { param: f.param, name: f.name };
      out.push(
        !fin.ok
          ? { ...base, status: "refused", error: fin.error }
          : fin.status === "created"
            ? {
                ...base,
                status: "stored",
                fileEntityId: fin.fileEntityId,
                documentId: fin.documentId,
              }
            : fin.status === "proposed"
              ? {
                  ...base,
                  status: "proposed",
                  documentId: fin.documentId,
                  ...(fin.proposalId ? { proposalId: fin.proposalId } : {}),
                }
              : {
                  ...base,
                  status: "stored",
                  fileEntityId: fin.entityId,
                  documentId: fin.documentId,
                }
      );
    } catch (err) {
      logger.warn({ err, file: f.name }, "hosted verb file not stored");
      out.push({
        param: f.param,
        name: f.name,
        status: "refused",
        error: "The file door failed to store this file.",
      });
    }
  }
  return out;
}

/** The asking session hears how the run ended, with the files it made. */
export async function noticeVerbFinished(
  job: HostJobRow,
  computerName: string | null,
  files: readonly HostJobStoredFile[]
): Promise<void> {
  const spec = job.spec as { recipe?: string; capabilityKey?: string };
  const label = `“${spec.recipe ?? "recipe"}” (${spec.capabilityKey ?? "tool"})`;
  const where = computerName ? ` on ${computerName}` : "";
  const made = files
    .map((f) =>
      f.status === "stored"
        ? `${f.name} (file ${f.fileEntityId})`
        : f.status === "proposed"
          ? `${f.name} (waiting for your review${f.proposalId ? `, proposal ${f.proposalId}` : ""})`
          : `${f.name} NOT stored: ${f.error ?? f.status}`
    )
    .join(", ");
  const content =
    job.status === "done"
      ? `${label} finished${where}${made ? `: ${made}` : ""}.`
      : job.status === "stopped"
        ? `${label} was stopped${where}.`
        : `${label} failed${where}: ${job.error ?? "see the run's log"}.`;
  await roomNotice(job.sessionId, content, `host-verb:${job.id}:finished`);
}

// ── Runs: the hosted verb runs in the ONE runs read layer ───────────────────

function unifiedStatus(
  status: ReturnType<typeof hostJobReadStatus>
): RunStatus {
  switch (status) {
    case "done":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
      return "cancelled";
    default:
      return "running";
  }
}

function storedStatusesFor(status: RunStatus): HostJobStatus[] {
  return HOST_JOB_STATUSES.filter((s) => unifiedStatus(s) === status);
}

/** Where a hosted verb run stands, in one sentence. */
export function hostVerbRunSummary(
  row: Pick<HostJobRow, "status" | "leaseExpiresAt" | "evidence" | "error">,
  computerName: string | null,
  now: Date = new Date()
): string {
  const computer = computerName ?? "your computer";
  const status = hostJobReadStatus(row, now);
  switch (status) {
    case "queued":
      return `Waiting for ${computer} to pick it up`;
    case "leased":
      return `Starting on ${computer}`;
    case "running":
      return `Running on ${computer}`;
    case "stalled":
      return `Stalled: ${computer} stopped answering while it ran`;
    case "stopped":
      return "Stopped";
    case "done": {
      const files = (row.evidence?.files ?? []).filter(
        (f) => f.status === "stored" || f.status === "proposed"
      ).length;
      return files > 0
        ? `Finished on ${computer} · ${files} file${files === 1 ? "" : "s"}`
        : `Finished on ${computer}`;
    }
    case "failed":
      return row.error ?? "Failed";
  }
}

export function hostVerbRunAsUnifiedRun(
  row: HostJobRow,
  computerName: string | null,
  now: Date = new Date()
): UnifiedRun {
  const spec = row.spec as { recipe?: string; capabilityKey?: string };
  return {
    id: row.id,
    flowType: "capability",
    flowId: null,
    flowName: `${spec.recipe ?? "recipe"} (${spec.capabilityKey ?? "tool"})`,
    status: unifiedStatus(hostJobReadStatus(row, now)),
    startedAt: row.queuedAt,
    completedAt: row.finishedAt,
    lastActivityAt:
      row.status === "leased" || row.status === "running"
        ? row.lastHeartbeatAt
        : null,
    workspaceId: row.workspaceId,
    projectId: null,
    subjectEntityId: null,
    channelId: null,
    correlationId: null,
    replayOf: null,
    summary: hostVerbRunSummary(row, computerName, now),
    error: row.status === "failed" ? row.error : null,
    triggeredBy: row.agentUserId ?? row.userId,
    stepsCompleted: null,
    stepsFailed: null,
    definitionVersion: null,
  };
}

async function computerNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.name ?? ""]));
}

export interface HostVerbRunLens {
  workspaceId?: string;
  projectId?: string;
  subjectEntityId?: string;
  sessionId?: string;
  skillIds?: readonly string[];
  startedBefore?: Date;
}

/**
 * The person's hosted verb runs under the feed's lens, newest first. Read
 * floor = the owner (`host_jobs.user_id`). A project or subject lens
 * contributes nothing (a host job carries neither); a skill lens matches the
 * verb that queued the run.
 */
export async function listHostVerbRunsForFeed(
  userId: string,
  lens: HostVerbRunLens,
  limit: number,
  status?: RunStatus,
  exactRunId?: string
): Promise<UnifiedRun[]> {
  if (lens.projectId || lens.subjectEntityId) return [];
  if (lens.skillIds && lens.skillIds.length === 0) return [];
  if (exactRunId !== undefined && !isUuid(exactRunId)) return [];
  const stored = status ? storedStatusesFor(status) : null;
  if (stored && stored.length === 0) return [];
  const where: Array<SQL | undefined> = [
    eq(hostJobs.userId, userId),
    eq(hostJobs.kind, "verb"),
    exactRunId ? eq(hostJobs.id, exactRunId) : undefined,
    lens.workspaceId ? eq(hostJobs.workspaceId, lens.workspaceId) : undefined,
    lens.sessionId ? eq(hostJobs.sessionId, lens.sessionId) : undefined,
    lens.skillIds ? inArray(hostJobs.skillId, [...lens.skillIds]) : undefined,
    lens.startedBefore ? lt(hostJobs.queuedAt, lens.startedBefore) : undefined,
    stored ? inArray(hostJobs.status, stored) : undefined,
  ];
  const rows = await db
    .select()
    .from(hostJobs)
    .where(and(...where))
    .orderBy(desc(hostJobs.queuedAt))
    .limit(limit);
  const names = await computerNames(rows.map((r) => r.machineUserId));
  const now = new Date();
  return rows.map((r) =>
    hostVerbRunAsUnifiedRun(r, names.get(r.machineUserId) ?? null, now)
  );
}

/** One hosted verb run for the run page, or null when it is not the reader's. */
export async function loadHostVerbRunDetail(
  userId: string,
  id: string
): Promise<{
  run: UnifiedRun;
  job: HostJobRow;
  computerName: string | null;
} | null> {
  if (!isUuid(id)) return null;
  const [row] = await db
    .select()
    .from(hostJobs)
    .where(
      and(
        eq(hostJobs.id, id),
        eq(hostJobs.userId, userId),
        eq(hostJobs.kind, "verb")
      )
    )
    .limit(1);
  if (!row) return null;
  const names = await computerNames([row.machineUserId]);
  const computerName = names.get(row.machineUserId) ?? null;
  return {
    run: hostVerbRunAsUnifiedRun(row, computerName),
    job: row,
    computerName,
  };
}
