/**
 * SESSION KIND fixtures — ONE set, run through BOTH halves: the TypeScript
 * half in `session-kind.test.ts`, the SQL half executed on PGlite in
 * `session-kind.pglite.test.ts`. A row added here joins both by existing.
 */
import {
  AGENT_PROPOSAL_PACKAGE_KIND,
  type SessionKind,
} from "../session-kind.js";

/** One fixture set, classified by the TypeScript half. */
export const FIXTURES: Array<{
  name: string;
  row: {
    origin?: string | null;
    playbookId?: string | null;
    metadata?: unknown;
    /** REQUIRED by `SessionKindProjectable` — see why, there. */
    status: string | null;
  };
  kind: SessionKind;
}> = [
  {
    name: "a person's own session",
    row: { status: "active", origin: "human", playbookId: null, metadata: {} },
    kind: "work",
  },
  {
    name: "NULL origin (un-migrated row) — work, never lost",
    row: { status: "active", origin: null, playbookId: null, metadata: null },
    kind: "work",
  },
  {
    name: "an agent session a person accepted",
    row: {
      status: "active",
      origin: "agent",
      playbookId: null,
      metadata: { triage: { acceptedAt: "2026-09-05T00:00:00.000Z" } },
    },
    kind: "work",
  },
  {
    name: "an agent-origin run source with no run ids (digest, import) — work",
    row: {
      status: "active",
      origin: "agent",
      playbookId: null,
      metadata: { source: "digest" },
    },
    kind: "work",
  },
  {
    name: "an automation-drafted session a person ACCEPTED from triage — work",
    row: {
      status: "active",
      origin: "automation",
      playbookId: null,
      metadata: {
        automationId: "auto-1",
        triage: { acceptedAt: "2026-09-05T00:00:00.000Z" },
      },
    },
    kind: "work",
  },
  {
    name: "playbook origin",
    row: {
      status: "active",
      origin: "playbook",
      playbookId: null,
      metadata: {},
    },
    kind: "run",
  },
  {
    name: "automation origin",
    row: {
      status: "active",
      origin: "automation",
      playbookId: null,
      metadata: {},
    },
    kind: "run",
  },
  {
    name: "playbookId set, agent origin (openRunSession stamps origin=agent)",
    row: {
      status: "active",
      origin: "agent",
      playbookId: "pb-1",
      metadata: { source: "playbook-run" },
    },
    kind: "run",
  },
  {
    name: "metadata.automationRunId set",
    row: {
      status: "active",
      origin: "agent",
      playbookId: null,
      metadata: { automationRunId: "ar-1" },
    },
    kind: "run",
  },
  {
    name: "metadata.automationId set, no run id (a producer that stamps only the definition)",
    row: {
      status: "active",
      origin: "agent",
      playbookId: null,
      metadata: { automationId: "au-1" },
    },
    kind: "run",
  },
  {
    name: "automation origin, chain-context-only metadata (no top-level automationId/automationRunId) — still run, via origin, never work",
    // `buildRunSessionMetadata` (run-playbook.ts) now ALSO stamps the
    // top-level keys, but classification must not depend on that: `origin`
    // alone (RUN_ORIGINS) already carries this, so a producer that regresses
    // to chain-context-only metadata must not silently reclassify as `work`.
    row: {
      status: "active",
      origin: "automation",
      playbookId: null,
      metadata: {
        automationChainContext: {
          automationId: "au-9",
          automationRunId: "ar-9",
        },
      },
    },
    kind: "run",
  },
  {
    name: "a MINTED intake run (ensureIntakeSession stamps metadata.intake) — run",
    // openRunSession writes origin "agent" + metadata.source for it, which is
    // `work` on its own — so this row is only a run through the intake key.
    row: {
      status: "active",
      origin: "agent",
      playbookId: null,
      metadata: {
        source: "intake:capture",
        intake: { door: "capture", mintedAt: "2026-09-13T00:00:00.000Z" },
      },
    },
    kind: "run",
  },
  {
    name: "a person's work session that only RECEIVED a run manifest — still work",
    row: {
      status: "active",
      origin: "human",
      playbookId: null,
      metadata: { run: { version: 1, sourceDocumentIds: ["d1"] } },
    },
    kind: "work",
  },
  {
    name: "a person's session that FOLLOWS a playbook — work (follow ≠ run, 2026-10-12)",
    // `followPlaybook` writes `playbookId` and stamps `followedVia`. The
    // person opened it; attaching a method does not make it a machine run.
    row: {
      status: "active",
      origin: "human",
      playbookId: "pb-1",
      metadata: { followedVia: "attach", followedAt: "2026-10-12T09:00:00Z" },
    },
    kind: "work",
  },
  {
    name: "a FOLLOWED NULL-origin (un-migrated) session — work",
    row: {
      status: "active",
      origin: null,
      playbookId: "pb-1",
      metadata: { followedVia: "attach" },
    },
    kind: "work",
  },
  {
    name: "the attach mark cannot launder a PLAYBOOK-origin run — run",
    row: {
      status: "active",
      origin: "playbook",
      playbookId: "pb-1",
      metadata: { followedVia: "attach" },
    },
    kind: "run",
  },
  {
    name: "the attach mark cannot launder an AUTOMATION run (agent origin) — run",
    row: {
      status: "active",
      origin: "agent",
      playbookId: "pb-1",
      metadata: { followedVia: "attach", automationRunId: "ar-7" },
    },
    kind: "run",
  },
  {
    name: "receipt — the agent-write container",
    row: {
      status: "active",
      origin: "agent",
      playbookId: null,
      metadata: { source: "agent-write", kind: AGENT_PROPOSAL_PACKAGE_KIND },
    },
    kind: "receipt",
  },
  {
    name: "receipt BEATS run — a receipt is also agent-minted by openRunSession",
    row: {
      status: "active",
      origin: "automation",
      playbookId: "pb-2",
      metadata: {
        kind: AGENT_PROPOSAL_PACKAGE_KIND,
        automationId: "au-2",
        automationRunId: "ar-2",
      },
    },
    kind: "receipt",
  },
];
