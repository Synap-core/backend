/**
 * synap_create_automation — capability-step validation.
 *
 * The MCP create door used to accept ANY `flowDefinition` whose `nodes`/`edges`
 * were arrays. A `capability` node names a VERB (`data.verbId`), and nothing
 * checked that the verb actually exists: an agent could emit a step calling a
 * verb that was never installed and the automation would be created happily,
 * only to blow up (or silently do nothing) at run time.
 *
 * This module answers "does this flow's every capability step name something
 * this caller can actually run?" — and, when it does not, says which verb and
 * what would fix it.
 *
 * Split out of adapter.ts's switch case (same reason as `validate-create-verb.ts`)
 * so it is unit-testable without the DB/tRPC module graph. The two real reads —
 * the capability registry and the marketplace catalog cache — are injected by
 * the adapter as `deps`, so this file stays pure.
 *
 * Resolution mirrors the RUN-TIME resolver, it does not invent a second one:
 * `executeCapability` resolves `verbId` against `skills.name` under
 * `visibleSkillsWhere` (services/capabilities/execute-capability.ts:176), and the
 * process builder picks verbs out of a tool's verb catalog
 * (`ToolVerbCatalogEntry.id`, itself the requiring skill's NAME). The adapter
 * feeds both of those, read through the SAME access-scoped `listCapabilities`
 * door, so an agent can never validate against a capability it cannot see.
 */

/** What the caller can resolve, read through the access-scoped registry door. */
export interface ResolvableCapabilityIndex {
  /** Every runnable verb id visible to this caller (tool verb ids + skill names). */
  verbIds: Set<string>;
  /** Every visible capability (tool) row id — what a node's `capabilityId` points at. */
  capabilityIds: Set<string>;
}

/** A marketplace entry that might provide a missing verb. Identity only — never invented. */
export interface MarketplaceCandidate {
  slug: string;
  name: string;
  kind: string;
}

export interface ValidateFlowCapabilitiesDeps {
  /** Access-scoped registry read. */
  loadIndex: () => Promise<ResolvableCapabilityIndex>;
  /**
   * Best-effort marketplace lookup for a verb that did not resolve. MAY reject or
   * hang — the caller wraps it; a failure never blocks the validation verdict.
   */
  searchMarketplace?: (verbId: string) => Promise<MarketplaceCandidate[]>;
  /** Budget for the whole (best-effort) marketplace phase. Defaults to 3s. */
  marketplaceTimeoutMs?: number;
}

export type ValidateFlowCapabilitiesResult =
  { ok: true } | { ok: false; error: string };

interface CapabilityStepRef {
  nodeId: string;
  verbId: string | null;
  capabilityId: string | null;
}

/**
 * Pull the `capability` steps out of a raw flow node list. Tolerant by design:
 * a malformed node is simply not a capability step to validate (the array-shape
 * checks in the adapter, and the executor itself, own that failure mode).
 */
export function collectCapabilitySteps(nodes: unknown[]): CapabilityStepRef[] {
  const refs: CapabilityStepRef[] = [];
  nodes.forEach((node, i) => {
    if (!node || typeof node !== "object") return;
    const n = node as { id?: unknown; type?: unknown; data?: unknown };
    if (n.type !== "capability") return;
    const data = (n.data && typeof n.data === "object" ? n.data : {}) as {
      verbId?: unknown;
      capabilityId?: unknown;
    };
    refs.push({
      nodeId: typeof n.id === "string" && n.id ? n.id : `#${i}`,
      verbId:
        typeof data.verbId === "string" && data.verbId.trim() !== ""
          ? data.verbId
          : null,
      // Genuinely optional and absent in the wild — first-party report
      // automations emit verb-only capability nodes (ensure-report-automation.ts).
      // Absence is NORMAL, never a validation failure.
      capabilityId:
        typeof data.capabilityId === "string" && data.capabilityId.trim() !== ""
          ? data.capabilityId
          : null,
    });
  });
  return refs;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("marketplace lookup timeout")),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/**
 * Validate every `capability` step in a flow against what this caller can run.
 *
 * FAILS CLOSED on an unresolvable verb (the automation is not created) and OPEN
 * on the marketplace lookup (a lookup that errors, times out, or returns nothing
 * leaves the validation error standing on its own, unweakened).
 *
 * Runs BEFORE the governance gate, so a bad flow is rejected on its merits — it
 * never turns a `status:"proposed"` outcome (a SUCCESS: the write is queued for
 * review) into an error.
 */
export async function validateFlowCapabilities(
  nodes: unknown[],
  deps: ValidateFlowCapabilitiesDeps
): Promise<ValidateFlowCapabilitiesResult> {
  const steps = collectCapabilitySteps(nodes);
  if (steps.length === 0) return { ok: true };

  let index: ResolvableCapabilityIndex;
  try {
    index = await deps.loadIndex();
  } catch {
    // The registry read is the FLOOR of this check — if it cannot be performed
    // we cannot honestly claim a verb is missing, so we do not block (behaviour
    // is exactly what it was before this check existed). Contrast the
    // marketplace lookup, which is a suggestion, not the verdict.
    return { ok: true };
  }

  const problems: Array<{ ref: CapabilityStepRef; reason: string }> = [];
  for (const ref of steps) {
    if (!ref.verbId) {
      problems.push({
        ref,
        reason:
          "has no verbId. A capability step must name the verb it runs " +
          '(e.g. { type: "capability", data: { verbId: "ai.generate" } }).',
      });
      continue;
    }
    if (!index.verbIds.has(ref.verbId)) {
      problems.push({
        ref,
        reason: `names verb "${ref.verbId}", which is not installed or not visible in this workspace.`,
      });
      continue;
    }
    if (ref.capabilityId && !index.capabilityIds.has(ref.capabilityId)) {
      problems.push({
        ref,
        reason:
          `names capability "${ref.capabilityId}", which is not a capability visible in this workspace. ` +
          "(capabilityId is a TOOL row id and is optional — omit it and the verb alone resolves.)",
      });
    }
  }

  if (problems.length === 0) return { ok: true };

  // ── Best-effort: what in the marketplace could PROVIDE the missing verb ─────
  // Suggestion only. Never auto-installs, never invents a candidate, and any
  // failure/timeout/empty result degrades to silence — the error below stands.
  const missingVerbs = [
    ...new Set(
      problems
        .filter((p) => p.ref.verbId && !index.verbIds.has(p.ref.verbId))
        .map((p) => p.ref.verbId as string)
    ),
  ];
  const candidatesByVerb = new Map<string, MarketplaceCandidate[]>();
  if (deps.searchMarketplace && missingVerbs.length > 0) {
    try {
      await withTimeout(
        Promise.all(
          missingVerbs.map(async (v) => {
            try {
              const found = await deps.searchMarketplace!(v);
              if (Array.isArray(found) && found.length > 0) {
                candidatesByVerb.set(v, found.slice(0, 3));
              }
            } catch {
              /* per-verb failure: this verb simply gets no suggestion */
            }
          })
        ),
        deps.marketplaceTimeoutMs ?? 3000
      );
    } catch {
      /* whole-phase failure/timeout: no suggestions at all, verdict unchanged */
    }
  }

  const lines = problems.map((p) => {
    let line = ` · step "${p.ref.nodeId}" ${p.reason}`;
    const cands = p.ref.verbId ? candidatesByVerb.get(p.ref.verbId) : undefined;
    if (cands && cands.length > 0) {
      line +=
        `\n   Marketplace entries that may provide it: ` +
        cands
          .map((c) => `"${c.name}" (${c.kind}, slug: ${c.slug})`)
          .join(", ") +
        `\n   Install one with: synap_run_capability({ verbId: "market.install", parameters: { slug: "${cands[0].slug}", kind: "${cands[0].kind}" } })`;
    } else if (p.ref.verbId && !index.verbIds.has(p.ref.verbId)) {
      // Absent facts render nothing — say the search came back empty, never
      // fabricate a package that might provide the verb.
      line += `\n   No marketplace entry was found that provides this verb.`;
    }
    return line;
  });

  return {
    ok: false,
    error:
      `Automation not created: ${problems.length} capability step(s) in flowDefinition could not be resolved.\n` +
      lines.join("\n") +
      `\nA verbId is the backing skill's NAME (e.g. "ai.generate"), not a UUID. ` +
      `See what this workspace can actually run with synap_list_capabilities({ query: "…" }), ` +
      `then re-send create_automation with a verbId from that list.`,
  };
}
