/**
 * The IoC slots + dispatch helpers that reach the canonical @synap/api routers
 * (`executeCapability`, `runPlaybook`) from @synap/jobs, which cannot statically
 * import @synap/api (circular dep: api → jobs → database). apps/api fills these
 * slots at boot. Extracted as a leaf so every step-executor module that needs a
 * capability/verb/playbook dispatch (`steps/command-skill-capability.ts`,
 * `steps/output.ts`, `steps/playbook-run.ts`) can share ONE registration.
 */

/**
 * Discriminated result mirror of `@synap/api`'s `ExecuteCapabilityResult`. jobs
 * cannot import @synap/api (circular dep), so the shape is re-declared here.
 */
type CapabilityDispatchResult =
  | { kind: "run"; skillId: string; result: unknown }
  | { kind: "dry-run"; skillId: string }
  | { kind: "proposed"; proposalId: string }
  | { kind: "deny"; reason: string }
  // The verb RAN and its handler FAILED (code sandbox success:false / provider
  // error envelope). Inside an automation this is a node failure — the call-sites
  // THROW rather than storing the failure envelope as node output.
  | { kind: "error"; message: string }
  | { kind: "not_found"; message: string };

/**
 * IoC slot for the canonical capability router `executeCapability` (in @synap/api).
 *
 * The workers here run IN the backend (apps/api) process — pg-boss is started
 * in-process — but this package (@synap/jobs) cannot statically import @synap/api
 * (circular dep: api → jobs → database). So apps/api, the one place that may
 * import both, fills this slot at boot via `registerCapabilityExecutor()` — the
 * SAME IoC pattern as `registerImportCorpusHandler`. No HTTP, no shared secret.
 */
export type CapabilityExecutorInput = {
  verbId?: string;
  skillId?: string;
  parameters?: Record<string, unknown>;
  workspaceId: string | null;
  userId: string;
  connectionSelector?: {
    connectionId?: string;
    contextObjectId?: string;
  } | null;
  suppressProposal?: boolean;
};

type CapabilityExecutor = (
  input: CapabilityExecutorInput
) => Promise<CapabilityDispatchResult>;

let capabilityExecutor: CapabilityExecutor | null = null;

export function registerCapabilityExecutor(fn: CapabilityExecutor): void {
  capabilityExecutor = fn;
}

/**
 * IoC slot for the ONE playbook-run spine (`runPlaybook`, @synap/api). @synap/jobs
 * cannot statically import @synap/api (circular dep), so apps/api fills this slot
 * at boot via `registerPlaybookRunner()` — the SAME pattern as
 * `registerCapabilityExecutor`. `executePlaybookRun` (steps/playbook-run.ts) is a
 * thin shim that resolves the automation StepContext (goal/params) and delegates
 * here, so scheduled runs go through the executor spine (is-agent | external-agent
 * | hybrid) and the triggerAutoRespond ONE door — never a forked is-agent flow.
 *
 * Types mirror api's RunPlaybookInput/RunPlaybookResult structurally (not
 * imported — circular dep); the boot wiring `(input) => runPlaybook(input)`
 * type-checks against both.
 */
export interface PlaybookRunnerChainContext {
  automationRunId: string;
  automationId: string;
  chainDepth: number;
  rootRunId: string;
  chainAutomationIds: string[];
}

export interface PlaybookRunnerInput {
  playbookId?: string;
  playbookName?: string;
  workspaceId: string;
  userId: string;
  params?: Record<string, unknown>;
  subjectId?: string;
  idempotentBySubject?: boolean;
  goalResolver?: (goalTemplate: string) => string;
  chainContext?: PlaybookRunnerChainContext;
}

export interface PlaybookRunnerResult {
  run: { id: string; status: string } | null;
  session: { id: string; channelId: string | null };
  reused?: boolean;
}

type PlaybookRunner = (
  input: PlaybookRunnerInput
) => Promise<PlaybookRunnerResult>;

let playbookRunner: PlaybookRunner | null = null;

export function registerPlaybookRunner(fn: PlaybookRunner): void {
  playbookRunner = fn;
}

/** Accessor for `steps/playbook-run.ts` — mirrors the private-slot pattern
 * `dispatchViaCapabilityRouter` uses for `capabilityExecutor`. */
export function getPlaybookRunner(): PlaybookRunner | null {
  return playbookRunner;
}

/**
 * Dispatch a capability (verb or skill) through the CANONICAL router
 * `executeCapability` — which routes all 3 tiers (builtin / declarative / code)
 * + connectionSelector and gates internally. In-process via the IoC slot above.
 *
 * Intentionally THROWS if the slot is unregistered — unlike the cron/signal-router
 * slots (which warn+skip), a dropped automation step must not silently vanish; it
 * surfaces as a step failure (pg-boss retries) rather than a no-op.
 */
export async function dispatchViaCapabilityRouter(
  input: Omit<CapabilityExecutorInput, "suppressProposal">
): Promise<CapabilityDispatchResult> {
  if (!capabilityExecutor) {
    throw new Error(
      "Capability executor not registered — apps/api must call registerCapabilityExecutor() at boot"
    );
  }
  // Automations have NO interactive review surface — suppress proposal
  // persistence so a recurring run can't flood the proposal queue; an
  // unapproved verb returns a plain `deny` (fail-closed by the caller).
  return capabilityExecutor({ ...input, suppressProposal: true });
}

/**
 * Wave 4.V2 declarative output → verb bridge. The native facet/relation output
 * steps (facet_attach / facet_update / facet_detach / relation_create) never
 * hand-roll an insert — they dispatch the corresponding governed builtin verb
 * through the SAME canonical capability router a `capability` node uses, so the
 * facet one-door (FacetRepository, via entities.*Facet) and the relation door
 * (createLinks, via relations.create) stay the only write paths. Config is passed
 * as the verb's parameters (already template-resolved by executeOutputStep); the
 * verb's own Zod schema validates + strips. Maps the dispatch verdict to a node
 * output, failing CLOSED on a governance refusal exactly like the skill/capability
 * nodes (a mid-flow automation has no interactive review surface).
 */
export async function dispatchOutputVerb(
  verbId: string,
  config: Record<string, unknown>,
  workspaceId: string,
  actingUserId: string
): Promise<Record<string, unknown>> {
  const dispatch = await dispatchViaCapabilityRouter({
    verbId,
    parameters: config,
    workspaceId,
    userId: actingUserId,
  });
  if (dispatch.kind === "deny") {
    throw new Error(`${verbId} refused by capability gate: ${dispatch.reason}`);
  }
  if (dispatch.kind === "proposed") {
    throw new Error(
      `${verbId} requires human approval and cannot run inside an automation; output step refused.`
    );
  }
  if (dispatch.kind === "not_found") {
    throw new Error(`${verbId} could not be dispatched: ${dispatch.message}`);
  }
  if (dispatch.kind === "error") {
    // The verb ran and FAILED — the node fails (never store the failure as output).
    throw new Error(`${verbId} failed: ${dispatch.message}`);
  }
  if (dispatch.kind === "dry-run") {
    return { status: "dry_run", verbId };
  }
  // kind === "run": surface the verb's own return flat (ONE `.output` rule) when
  // it is an object (e.g. { status:'attached', facet } / { status:'updated', … }),
  // else wrap a scalar/array so downstream steps always read `output.result`.
  const result = dispatch.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return { result };
}
