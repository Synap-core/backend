/**
 * The universal first-party defaults of every space — the `base` template's
 * report automation, default commands and relation defs — reconciled through
 * the ONE additive door (`reconcileWorkspaceFromDefinition`).
 *
 * Runs at BIRTH (layer one's create, tRPC `workspaces.create`) and at BOOT
 * (every space, every deploy: a prompt change to base reaches every space —
 * the automation step is version-aware over base's flow). It used to run on
 * every `workspaces.get`, i.e. a write on each READ (founder decision 2,
 * 2026-10-13: moved to boot); birth keeps a space created after boot whole
 * until the next one.
 *
 * Only base's operational carriers cross into a space — never its shell:
 * base declares `workspaceVisibility: "pod_visible"` (+ name "Base") and the
 * door's settings step overwrites visibility/subtype, so its full definition
 * would flip every space pod-visible and clobber a domain space's stamp. No
 * packageSlug either: base is no space's template identity.
 */
import { unfilteredAiFanoutError } from "@synap-core/types/automations";
import {
  reconcileWorkspaceFromDefinition,
  type WorkspaceDefinitionInput,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import {
  resolveWorkspaceTemplate,
  type ResolvedWorkspaceTemplate,
} from "../capabilities/resolve-workspace-template.js";

const logger = createLogger({ module: "template-apply/base-defaults" });

/** base's operational carriers only (see the module doc). */
export function baseOperationalDefinition(
  base: ResolvedWorkspaceTemplate
): WorkspaceDefinitionInput {
  const bd = base.workspaceDefinition;
  return {
    flowAutomations: bd.flowAutomations ?? [],
    commands: bd.commands ?? [],
    relationDefs: bd.relationDefs ?? [],
  } as unknown as WorkspaceDefinitionInput;
}

/**
 * Reconcile one space to `base`. `base` is the caller's pre-resolved template
 * (the boot pass resolves it once); omitted, it is resolved here. Non-fatal:
 * the outcome is returned and a failure logged, never thrown — the defaults
 * converge on the next boot.
 */
export async function reconcileBaseDefaults(input: {
  workspaceId: string;
  userId: string;
  base?: ResolvedWorkspaceTemplate | null;
}): Promise<"reconciled" | "unresolved" | "failed"> {
  const { workspaceId, userId } = input;
  try {
    const base =
      input.base === undefined
        ? await resolveWorkspaceTemplate("base")
        : input.base;
    if (!base) return "unresolved";
    await reconcileWorkspaceFromDefinition({
      validateFlow: unfilteredAiFanoutError,
      workspaceId,
      userId,
      definition: baseOperationalDefinition(base),
    });
    return "reconciled";
  } catch (err) {
    logger.warn(
      { err, workspaceId },
      "base defaults: reconcile failed (non-fatal; converges on the next boot)"
    );
    return "failed";
  }
}
