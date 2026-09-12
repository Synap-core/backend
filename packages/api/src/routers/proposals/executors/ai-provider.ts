import { TRPCError } from "@trpc/server";
import { db, proposals, eq } from "@synap/database";
import { aiProviders } from "@synap/database/schema";
import { ProposalStatus } from "@synap/database/schema";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";
import {
  AiProviderProposalPayload,
  type AiProviderProposalPayloadInput,
} from "../../ai-providers.schema.js";
import { pushProvidersToIS } from "../../../utils/push-providers-to-is.js";

/**
 * Approve-executors for `aiProvider` doors.
 *
 * WHY THESE EXIST AT ALL: an `ai_providers` row carries the `baseUrl` the
 * Intelligence Service sends every prompt to. Writing one was previously
 * reachable over Hub REST with nothing but `hub-protocol.write` — the scope
 * every agent key is minted with — so any agent could silently redirect pod-wide
 * LLM traffic. That door is now gated (`providers.write`) AND governed, which
 * means an agent-initiated write files a proposal instead of executing. These
 * executors are the other half: without them, a human could approve a provider
 * change and NOTHING would happen — a receipt for work never done, which is
 * strictly worse than no governance at all.
 *
 * REPLAY, never reconstruct. The gate stores the FULL validated upsert payload
 * (minus the plaintext key — see below) and the executor re-parses it with the
 * same schema the door used. Rebuilding the row field-by-field here is exactly
 * how `session-outputs` silently dropped `delegatedTo`/`returnedReason`: a
 * second, hand-maintained projection of one shape. `AiProviderProposalPayload`
 * is derived from `ProviderUpsertSchema`, so a field added to the door arrives
 * here by existing.
 *
 * SECRET HANDLING: the plaintext `apiKey` is NEVER written to `proposals.data`
 * — a pending proposal is a broadly-readable row, and a provider key sitting in
 * it would outlive the approval. The door encrypts at propose time and stores
 * only `encryptedApiKey`; `keepExistingKey` covers "update everything except the
 * key", so an edit that omits the key does not silently blank a working one.
 */
export function registerAiProviderExecutors(): void {
  const applyUpsert = async (
    payload: AiProviderProposalPayloadInput
  ): Promise<void> => {
    const { encryptedApiKey, keepExistingKey, ...rest } = payload;

    const existing = await db.query.aiProviders.findFirst({
      where: eq(aiProviders.providerId, rest.providerId),
    });

    // An omitted key must not blank an existing one. Explicit precedence:
    // a new ciphertext wins; otherwise keep what is already stored.
    const resolvedKey = encryptedApiKey ?? existing?.encryptedApiKey ?? null;
    void keepExistingKey;

    const now = new Date();
    if (existing) {
      await db
        .update(aiProviders)
        .set({ ...rest, encryptedApiKey: resolvedKey, updatedAt: now })
        .where(eq(aiProviders.providerId, rest.providerId));
    } else {
      await db.insert(aiProviders).values({
        ...rest,
        encryptedApiKey: resolvedKey,
        createdAt: now,
        updatedAt: now,
      });
    }
  };

  /**
   * Re-approve guard. The IS push is not status-guarded, so without this an
   * approval retry would re-write and re-push on every attempt.
   */
  const alreadyApproved = async (proposalId: string): Promise<boolean> => {
    const [row] = await db
      .select({ status: proposals.status })
      .from(proposals)
      .where(eq(proposals.id, proposalId));
    return row?.status === ProposalStatus.APPROVED;
  };

  /**
   * Mark the proposal APPROVED — the executor's job, by the convention every
   * other executor in this folder follows (the registry path does not flip
   * status for you). This was missing: an approved provider change was APPLIED
   * and pushed to the IS while the proposal stayed `pending` forever, so it sat
   * in the review queue as undone work, and approving it again re-ran the write.
   */
  const markApproved = async (
    proposal: { workspaceId: string | null },
    proposalId: string,
    userId: string,
    deps: { emitProposalReviewed: (...a: never[]) => unknown }
  ): Promise<void> => {
    await db
      .update(proposals)
      .set({
        status: ProposalStatus.APPROVED,
        reviewedBy: userId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(proposals.id, proposalId));
    (
      deps.emitProposalReviewed as (
        id: string,
        ws: string | null,
        d: "approved",
        by: string
      ) => void
    )(proposalId, proposal.workspaceId, "approved", userId);
  };

  const parsePayload = (
    proposal: { data: unknown },
    what: string
  ): AiProviderProposalPayloadInput => {
    const raw = (proposal.data ?? {}) as Record<string, unknown>;
    // Gate payloads are stored either flat or nested under `data` depending on
    // the door; accept both rather than depending on one caller's shape.
    const inner = (raw.data ?? raw) as Record<string, unknown>;
    const parsed = AiProviderProposalPayload.safeParse(inner);
    if (!parsed.success) {
      // Refuse loudly. Seating a partial provider row would leave the pod
      // pointing somewhere nobody chose.
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `${what} proposal payload is invalid or incomplete — refusing to apply a partial provider config. Re-file the proposal. (${parsed.error.issues
          .map((i) => i.path.join("."))
          .join(", ")})`,
      });
    }
    return parsed.data;
  };

  for (const key of ["aiProvider/create", "aiProvider/update"] as const) {
    registerProposalExecutor({
      key,
      async execute({ proposal, input, deps, userId }) {
        if (await alreadyApproved(input.proposalId)) {
          return { success: true, alreadyApproved: true };
        }
        const payload = parsePayload(proposal, "AI provider");
        await applyUpsert(payload);

        // Best-effort, deliberately: the DB write has committed and this human
        // has already approved it. An IS that is down must not turn an applied
        // approval into a failed one — the row is the source of truth and
        // `POST /ai-providers/sync` re-pushes.
        await pushProvidersToIS().catch(() => undefined);

        await markApproved(proposal, input.proposalId, userId, deps);
        reportApproved(deps, proposal, input.proposalId);
        return { success: true };
      },
    });
  }

  registerProposalExecutor({
    key: "aiProvider/delete",
    async execute({ proposal, input, deps, userId }) {
      if (await alreadyApproved(input.proposalId)) {
        return { success: true, alreadyApproved: true };
      }
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? raw) as Record<string, unknown>;
      const providerId = inner.providerId;
      if (typeof providerId !== "string" || providerId.trim() === "") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "AI provider delete proposal is missing providerId",
        });
      }

      await db
        .delete(aiProviders)
        .where(eq(aiProviders.providerId, providerId));
      await pushProvidersToIS().catch(() => undefined);

      await markApproved(proposal, input.proposalId, userId, deps);
      reportApproved(deps, proposal, input.proposalId);
      return { success: true };
    },
  });
}
