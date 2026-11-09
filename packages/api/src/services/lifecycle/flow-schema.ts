/**
 * THE SHAPE OF `flow.of` — one zod schema per part, the SOURCE of the types
 * `readFlowOf` returns and of the Hub `GET /flow` response (OpenAPI, the
 * generated REST clients). The types are inferred from it, never written
 * beside it. Prose on each field lives in `flow-read.ts`'s header.
 *
 * `thingBlockerSchema` is the one mirror: `ThingBlocker` is owned by
 * `@synap-core/types/units` (the pure derivation), so the schema is held to
 * it by a compile-time parity check, not restated.
 */
import { z } from "zod";
import type { PlaybookStageCategory } from "@synap/playbooks";
import {
  WAIT_BALLS,
  WAIT_KINDS,
  WAITING_ON_REASONS,
  type ThingBlocker,
} from "@synap-core/types/units";
import { WORKER_SCOPES } from "@synap-core/types/workers";

const STAGE_CATEGORIES = [
  "backlog",
  "planned",
  "started",
  "paused",
  "completed",
  "canceled",
] as const satisfies readonly PlaybookStageCategory[];

export const flowStageRefSchema = z.object({
  playbookId: z.string(),
  playbookName: z.string(),
  stageKey: z.string(),
  stageName: z.string(),
  category: z.enum(STAGE_CATEGORIES),
  /** The stage's entry gate; null = none. */
  gate: z.enum(["human", "check", "awaits"]).nullable(),
  /** Who runs the flow (`playbooks.executor`). */
  executor: z.string(),
});

export const flowStageSchema = z.object({
  key: z.string(),
  name: z.string(),
  category: z.enum(STAGE_CATEGORIES),
  /** The status this stage writes / follows; null = not tied to the lifecycle. */
  subjectStatus: z.string().nullable(),
  gate: flowStageRefSchema.shape.gate,
});

export const flowWorkerSchema = z.object({
  ruleId: z.string(),
  activatorKey: z.string(),
  mode: z.enum(["run", "propose"]),
  scope: z.enum(WORKER_SCOPES),
  projectId: z.string().nullable(),
  state: z.enum(["running", "paused"]),
});

export const flowOfFlowSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Null = pod-wide. */
  workspaceId: z.string().nullable(),
  /** The live definition's version; runs snapshot theirs. */
  version: z.number(),
  executor: z.string(),
  stages: z.array(flowStageSchema),
  /** Declared states a stage of this flow owns, in stage order. */
  owns: z.array(z.string()),
  /** Stage statuses the lifecycle does not declare (a renamed state). */
  undeclaredStatuses: z.array(z.string()),
  /** Open runs, and how many run a frozen copy older than `version`. */
  runs: z.object({ open: z.number(), onOlderVersion: z.number() }),
  /** Its enabled workers (empty when `workers` is withheld). */
  workers: z.array(flowWorkerSchema),
});

export const flowNextStepSchema = z.object({
  /** The state a move targets. */
  to: z.string(),
  label: z.string(),
  /** Only a person may move it there. */
  humanOnly: z.boolean(),
  /** The stage(s) that own that state; [] = no flow moves it there. */
  owners: z.array(flowStageRefSchema),
});

/** What `deriveThingBlocker` returns (held to `ThingBlocker` below). */
export const thingBlockerSchema = z.object({
  blocked: z.boolean(),
  count: z.number(),
  why: z
    .object({
      reason: z.enum(WAITING_ON_REASONS),
      waitKind: z.enum(WAIT_KINDS),
      blockedReason: z.string().nullable(),
      blockerKey: z.string().nullable(),
    })
    .nullable(),
  ball: z.enum(WAIT_BALLS).nullable(),
  unlocks: z.object({ to: z.string(), label: z.string() }).nullable(),
  clearedBy: z
    .union([
      z.object({ answer: z.literal(true) }),
      z.object({ intent: z.string() }),
      z.object({ playbookId: z.string() }),
      z.object({ capability: z.string() }),
    ])
    .nullable(),
  ref: z
    .object({
      kind: z.enum([
        "session",
        "pull_request",
        "person",
        "decision",
        "proposal",
        "slot",
        "thing",
      ]),
      id: z.string().optional(),
      url: z.string().optional(),
      label: z.string(),
      waitKind: z.enum(WAIT_KINDS).optional(),
    })
    .nullable(),
});

// Parity with the owner of the type, both ways: a field added to
// `ThingBlocker` that the schema lacks (or the reverse) fails the typecheck.
type SchemaBlocker = z.infer<typeof thingBlockerSchema>;
const _blockerParity: [ThingBlocker] extends [SchemaBlocker]
  ? [SchemaBlocker] extends [ThingBlocker]
    ? true
    : never
  : never = true;
void _blockerParity;

/** A blocker that could not be read: `unavailable`, never "not blocked". */
export const unavailableSchema = z.object({ status: z.literal("unavailable") });

export const flowCardSchema = z.object({
  id: z.string(),
  /** A role's facet (what a role move targets); null on a kind. */
  facetId: z.string().nullable(),
  name: z.string().nullable(),
  /** The thing's own kind (a role holds people and companies). */
  profileSlug: z.string().nullable(),
  status: z.string().nullable(),
  since: z.string(),
  enteredAt: z.string().nullable(),
  stuck: z.boolean(),
  workedBy: z.array(
    z.object({
      sessionId: z.string(),
      kind: z.enum(["session", "worker"]),
      live: z.boolean(),
    })
  ),
  /** On `properties: true` only. */
  properties: z.record(z.string(), z.unknown()).optional(),
  /**
   * Its next main-path step; null when it has ended, is paused or lost, or
   * stands in a status the lifecycle does not declare.
   */
  next: flowNextStepSchema.nullable(),
  /**
   * What stands between it and its next status: the SAME value `statusOf`
   * returns for the thing (`deriveThingBlocker`); `unavailable` when it could
   * not be read.
   */
  blocker: z.union([thingBlockerSchema, unavailableSchema]),
});

export const flowStateSchema = z.object({
  key: z.string(),
  label: z.string(),
  category: z.string(),
  tone: z.string(),
  humanOnly: z.boolean(),
  /** Declared order, from 0. */
  order: z.number(),
  owners: z.array(flowStageRefSchema),
  count: z.number(),
  /** Things past its stuck rule; null = it declares none. */
  stuck: z.number().nullable(),
  /** done/lost count only what entered within the window. */
  windowed: z.boolean(),
  cards: z.array(flowCardSchema),
});

export const flowOfSchema = z.object({
  profileSlug: z.string(),
  profileKind: z.enum(["kind", "role"]),
  property: z.string(),
  /** The space lens; null = pod-wide only; undefined lens reads as null. */
  workspaceId: z.string().nullable(),
  states: z.array(flowStateSchema),
  /** Things in no declared state (never dropped); null when none. */
  unclassified: z
    .object({
      count: z.number(),
      unset: z.number(),
      cards: z.array(flowCardSchema),
    })
    .nullable(),
  flows: z.array(flowOfFlowSchema),
  /** The space's declared outputs; null without a space lens. */
  space: z
    .object({
      primaryOutput: z.string().nullable(),
      produces: z.array(z.string()),
    })
    .nullable(),
  totals: z.object({
    total: z.number(),
    live: z.number(),
    doneWindowed: z.number(),
    lostWindowed: z.number(),
  }),
  window: z.object({ days: z.number(), since: z.string() }),
  /** A live worker covers this read; null when `workers` is withheld. */
  hasWorker: z.boolean().nullable(),
  /** Parts this caller's grant does not reach: not read, never "none". */
  withheld: z.array(z.enum(["flows", "workers"])),
});

export type FlowStageRef = z.infer<typeof flowStageRefSchema>;
export type FlowStage = z.infer<typeof flowStageSchema>;
export type FlowWorker = z.infer<typeof flowWorkerSchema>;
export type FlowOfFlow = z.infer<typeof flowOfFlowSchema>;
export type FlowNextStep = z.infer<typeof flowNextStepSchema>;
export type FlowCardBlocker = z.infer<typeof flowCardSchema>["blocker"];
export type FlowCard = z.infer<typeof flowCardSchema>;
export type FlowState = z.infer<typeof flowStateSchema>;
export type FlowOf = z.infer<typeof flowOfSchema>;
