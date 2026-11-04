/**
 * The `import-units` job's handler (filled into the @synap/jobs slot at boot):
 * stores every unit of a store-first import manifest through the ONE unit door
 * `/import/store-unit` uses (`storeImportUnit`).
 *
 * The submitting request's acting context is replayed for every unit: the hub
 * caller is built from the same fields `getCaller` reads off the request (the
 * key's scopes, type and workspace binding, the acting agent, the verified
 * session), and the write runs inside the key's grant, acting agent and calling
 * key, as the request's middleware enters them (the same replay
 * `services/governance/deferred-writes.ts` does). So a unit is governed exactly
 * as `/import/store-unit` would govern it, one unit at a time.
 *
 * Never throws for a unit: a unit whose create fails is `failed` with its
 * reason and the run goes on. Only an infrastructure fault fails the job.
 */

import {
  runWithActingAgent,
  runWithCallingKey,
  runWithGrant,
  type KeyGrant,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import type {
  ImportUnitOutcome,
  ImportUnitsPayload,
  ImportUnitsResult,
} from "@synap/jobs/workers/import-units-worker.js";
import type { HUB_WRITE_SOURCES } from "@synap-core/types/proposals";
import { createHubProtocolCallerContext } from "../../routers/hub-protocol/utils.js";
import { storeImportUnit, type ImportUnitCreateInput } from "./store-unit.js";

const logger = createLogger({ module: "import-units-job" });

type HubWriteSource = (typeof HUB_WRITE_SOURCES)[number];

/** The create door the units go through: the hub `entities.createEntity`. */
export type ImportUnitsCreateDoor = (
  input: ImportUnitCreateInput
) => Promise<unknown>;

/** Build the hub caller of the submitting request, from the job payload. */
async function hubCreateDoor(
  p: ImportUnitsPayload
): Promise<ImportUnitsCreateDoor> {
  const { hubProtocolRouter } =
    await import("../../routers/hub-protocol/index.js");
  const ctx = await createHubProtocolCallerContext(
    p.userId,
    p.scopes,
    p.workspaceId,
    null,
    p.sessionId ?? null,
    p.agentUserId ?? null,
    p.keyType ?? null,
    p.keyWorkspaceId ?? null
  );
  const caller = hubProtocolRouter.createCaller(ctx as any);
  return (input) => caller.entities.createEntity(input);
}

export async function runImportUnitsJob(
  p: ImportUnitsPayload,
  deps: { createDoor?: ImportUnitsCreateDoor } = {}
): Promise<ImportUnitsResult> {
  const createEntity = deps.createDoor ?? (await hubCreateDoor(p));
  const results: Record<string, ImportUnitOutcome> = {};
  let stored = 0;
  let proposed = 0;
  let failed = 0;

  for (const unit of p.units) {
    try {
      const r = await runWithActingAgent(p.agentUserId ?? undefined, () =>
        runWithCallingKey(p.apiKeyId ?? null, () =>
          runWithGrant(p.grant as KeyGrant | undefined, () =>
            storeImportUnit({
              createEntity,
              userId: p.userId,
              agentUserId: p.agentUserId ?? null,
              unit: {
                title: unit.title,
                profileSlug: unit.profileSlug,
                ...(unit.content ? { content: unit.content } : {}),
                ...(unit.description ? { description: unit.description } : {}),
                properties: unit.properties ?? {},
                source: p.source as HubWriteSource,
                workspaceId: p.workspaceId,
                // The unit key IS the create door's idempotency key, verbatim,
                // so the per-unit door (`/import/store-unit`, multipart
                // `idempotencyKey`) and this job land one unit on ONE entity.
                // The client namespaces it (`superwhisper:<recordingId>`).
                idempotencyKey: unit.key,
              },
              ...(unit.uploadToken
                ? {
                    file: {
                      kind: "upload" as const,
                      uploadToken: unit.uploadToken,
                    },
                  }
                : {}),
            })
          )
        )
      );
      if (r.status === "proposed") {
        proposed++;
        results[unit.key] = {
          status: "proposed",
          proposalId: r.proposalId ?? null,
          audioSkippedReason: r.audioSkippedReason,
        };
      } else {
        stored++;
        results[unit.key] = {
          status: "stored",
          entityId: r.entityId,
          audio: r.audio !== null,
          audioSkippedReason: r.audioSkippedReason,
        };
      }
    } catch (err) {
      failed++;
      const error = err instanceof Error ? err.message : String(err);
      results[unit.key] = { status: "failed", error: error.slice(0, 500) };
      logger.warn(
        { err, userId: p.userId, key: unit.key },
        "import unit failed (run continues)"
      );
    }
  }

  return { total: p.units.length, stored, proposed, failed, results };
}
