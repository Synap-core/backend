/**
 * @synap/governance-policy
 *
 * SINGLE SOURCE OF TRUTH for AI governance POLICY — the pure, I/O-free decision
 * core shared by the two governance gates:
 *   - checkPermissionOrPropose()       (packages/api/src/utils/permission-check.ts)
 *   - checkAutomationWriteOrPropose()   (packages/jobs/src/utils/automation-governance.ts)
 *
 * Both previously hand-copied these constants and the agent-policy precedence
 * ladder. Because `@synap/api` depends on `@synap/jobs`, the jobs side could not
 * import the canonical gate without a cycle, so it kept a forked MIRROR with an
 * explicit "DRIFT RISK" TODO. This package is that lower, dependency-free home —
 * it removes the fork.
 *
 * It contains NO database / event / proposal side effects — ONLY the decision.
 * Each caller still: runs RBAC, fetches the agent + workspace rows, then calls
 * `decideAgentPolicy()` and maps the verdict onto its own
 * execute / propose / deny side effects (createProposal, audit insert, etc.).
 *
 * Precedence ladder (applied only after RBAC passes and the actor is confirmed
 * to be an agent user):
 *   1. CBAC capability allowlist  → deny if the agent lacks the capability
 *   2. ADMIN_ACTIONS              → always propose (even for owned workspace)
 *   2.05 HUMAN_GATE_EVENT_KEYS   → always propose; unwidenable by any rung below
 *   2.06 ARBITRARY_EXECUTION_EVENT_KEYS → always propose; a shell inside the API
 *                                    container (`command.execute`) is floored on
 *                                    the EVENT KEY, never on the bare verb —
 *                                    `automation.execute` must stay runnable.
 *   2.5 DESTRUCTIVE_ACTIONS hard floor → always propose (delete/archive/purge/
 *                                    merge), regardless of ANY override rung
 *                                    below (ownership, explicit autoApproveFor,
 *                                     DEFAULT_AUTO_APPROVE, capability
 *                                     governance). EXCEPTION: caller opts in
 *                                     via `allowDestructiveAutoApprove` (the
 *                                     future "Crazy" mode) — see below.
 *   2.55 UNTRUSTED ORIGIN         → propose (tighten-only): a write whose acting
 *                                    channel origin is not owner-trusted
 *                                    (EXTERNAL / bridge / `source`-produced) is
 *                                    downgraded execute→propose. Sits BELOW the
 *                                    three floors (2/2.1/2.5) and ABOVE every
 *                                    auto path (2.6/2.7/2.8/3/4/8). Never denies.
 *   2.56 DAILY WRITE CEILING      → propose (tighten-only): the acting agent has
 *                                    reached its resolved per-UTC-day
 *                                    auto-execute write limit (governance_ceilings
 *                                    axis daily_write_count), so a would-be-auto
 *                                    write is downgraded execute→propose. Same
 *                                    placement class as 2.55 — below the floors,
 *                                    above every auto path. Never denies.
 *   2.6 user_observation by KIND  → INFERENCE propose / EXPLICIT execute
 *                                    (governs by the observation's nature, NOT
 *                                     the routing workspace — see below)
 *   2.7 per-capability governance → auto execute / propose / block deny
 *                                    (capability RUNS only; no-ops for data
 *                                     writes; a channel grant may still tighten
 *                                     an "auto" capability — see below)
 *   2.8 governance_rules store    → additive: auto execute / propose (fires
 *                                    ONLY when the caller resolved a matching
 *                                    rule; undefined = no-op, falls through
 *                                    byte-identical — see below)
 *   3. isAgentOwnedWorkspace      → execute (non-destructive) / propose (destructive)
 *   4. explicit autoApproveFor    → execute (overrides writesRequireProposal)
 *   5. writesRequireProposal      → propose on non-pure-read writes
 *   6. agent-owned mode + destructive → propose
 *   7. per-channel capability gate → block / propose / (act → fall through)
 *   8. DEFAULT_AUTO_APPROVE       → execute
 *   9. default                    → propose
 */

// ---------------------------------------------------------------------------
// Constants — the policy values (formerly duplicated in both gates)
// ---------------------------------------------------------------------------

/**
 * Default whitelist: agent actions that bypass proposal review.
 * Workspaces override via `settings.aiGovernance.autoApproveFor`.
 * When `governanceMode === "agent-owned"`, destructive actions always propose.
 * Format: "<subjectType>.<action>" or "<subjectType>.*" glob.
 */
export const DEFAULT_AUTO_APPROVE: readonly string[] = [
  "search.*",
  "memory.recall",
  "entity.read",
  "bento.arrange",
  "document.read",
  "context.*",
  "filesystem.read",
  "filesystem.write_workspace",
  // `view.create` STAYS auto-approved. A view is a saved query + render config
  // over data that already exists — it mints no new identity, changes nothing
  // about what the pod IS, and is per-workspace. It is also the highest-volume
  // agent surface here (one dashboard build = many views), so gating it would
  // flood review for a purely presentational, reversible act. Contrast the
  // META-MODEL keys removed just below.
  "view.create",
  // NOTE — the META-MODEL keys `profile.create`, `profile.update`,
  // `property_def.create` and `property_def.update` were DELIBERATELY REMOVED
  // (containment-asymmetry pass). Kinds, roles and property defs define what the
  // pod IS: a profile row is pod-wide (`entityScope` defaults to 'pod', so its
  // entities surface in EVERY workspace) and a base property def (workspace_id
  // NULL) extends a shared kind for every workspace at once. Unlike
  // `automation.create` — which auto-approves BUT lands INERT (automations.ts
  // forces `status:'draft'` for agent callers, so a human must activate it) —
  // `profiles` / `property_defs` / `views` have NO inert state to land in
  // (`profiles.is_active` is the SOFT-DELETE tombstone that
  // `ProfileRepository.delete()` sets, not a draft flag), so "auto-approve +
  // contain" is not available without a schema change. That leaves rung 9
  // (propose) as the correct default for a structural, pod-wide write.
  //   • Volume is small by construction: `synap_define_kind` is slug-idempotent
  //     and documented as an L3 escalation ("only after list_profiles shows no
  //     fit"), and when the KIND proposes its FIELDS are deferred rather than
  //     filed (mcp/handlers/capability.ts:143 tells the agent to re-call the
  //     slug-idempotent tool after approval) — so a new kind costs ONE
  //     proposal, not 1+N. Field batches on an ALREADY-approved kind collapse
  //     to one click under `proposals.batchApprove`: both approve doors share
  //     `dispatchProposalApproval` (execution-registry.ts), so every registered
  //     executor — `property_def/create` included — batch-approves.
  //   • Package/template apply does NOT go through this gate at all: the
  //     definition engine (workspaces/definition-engine.ts:2032) and the
  //     materializer (jobs/materializer.ts:603) call `ProfileRepository.create`
  //     DIRECTLY, ungoverned. So an install that mints 20 profiles files ZERO
  //     proposals — the flood path people fear is structurally absent here.
  //     (That bypass is a SEPARATE pre-existing governance gap, untouched by
  //     this change.)
  //   • Executors already exist for every removed create key —
  //     `profile/create`, `property_def/create` — so approval materializes
  //     through the same helper as the direct-apply branch.
  //   • Widening back is USER-EDITABLE without a code change: a
  //     `governance_rules` row at action granularity (rung 2.8) can say `auto`
  //     for a trusted agent. That is the project's own answer for case-by-case
  //     widening — which is why this stays a platform DEFAULT of propose rather
  //     than a rung-2.1 `forcePropose` floor (a floor no rule could widen).
  //   • `profile.update` / `property_def.update` were additionally DEAD keys:
  //     no call site passes those (subjectType, action) pairs to
  //     `checkPermissionOrPropose` today, so removing them changes no live
  //     behavior — it removes a latent default-allow that would silently apply
  //     the moment someone wires those gates.
  "entity.create",
  "entity.update",
  "document.create",
  "relation.create",
  "terminal.read_logs",
  // NOTE — `channel.create` and `playbook.create` are DELIBERATELY NOT here.
  // A channel and a playbook are SURFACES, not data: creating one changes what
  // exists in the operator's world (a new room, a new process) in a way they must
  // be able to SEE and ACCEPT — the proposal system is visibility + acceptance,
  // not only governance. So create-NEW of these should route to a proposal even in
  // the permissive tiers ("don't spin up a channel I don't know exists"). RESOLVE
  // of an EXISTING channel is a different action (channel.resolve/ensure/bind) and
  // must stay instant — agent reply / proactive flows that reuse a channel never
  // block.
  //   • playbook.create — ENFORCED: playbooks.ts calls checkPermissionOrPropose
  //     ({subjectType:"playbook", action:"create"}), which reads this list.
  //   • channel.create  — POLICY-ONLY for now: the agent channel-create door (Hub
  //     `resolveOrCreateChannel`) has no governance gate and the builtin verb is
  //     grant-gated (action="run"), so this key isn't consulted yet. Wiring the
  //     create-new→proposal gate on the Hub route (create-vs-resolve + a channel
  //     proposal executor) is a tracked follow-up — see policy.test.ts.
  // Automation/link creates stay instant (they wire existing capabilities, no new
  // durable surface). `tool.create` / `skill.create` were already excluded (they
  // define new EGRESS abilities).
  "automation.create",
  "link.create",
  // Focus-session lifecycle = non-destructive work-orchestration (open a
  // session, advance its stage, update progress), less sensitive than the data
  // creates above. Auto-approving lets an agent open/advance an event-mode
  // session in the capture channel without a proposal ("capture channel = no
  // proposals"). `focus_session.grant_capability` is DELIBERATELY excluded — it
  // widens a session's egress abilities, so it still routes to a proposal.
  // delete/archive remain destructive → proposal.
  "focus_session.create",
  "focus_session.update",
  "focus_session.stage_changed",
  "playbook.read",
  "tool.read",
  "link.read",
  "capability.read",
  // Kind + Facets (Wave 1B): attaching/updating a role-profile facet on an
  // entity is additive and non-destructive — same trust tier as
  // entity.create/update above. `facet.detach` is ALSO auto-approved here:
  // it is a soft-delete (FacetRepository.detach() never hard-deletes), so a
  // re-attach after an unwanted detach is a normal, idempotent-friendly
  // recovery — no different in reversibility from the entity edits already
  // whitelisted. (Contrast with entity/document DELETE, which stays
  // proposal-gated via DESTRUCTIVE_ACTIONS.)
  "facet.attach",
  "facet.update",
  "facet.detach",
];

/**
 * Actions that always require a proposal — hard floor in decideAgentPolicy
 * (rung 2.5), regardless of ownership / autoApproveFor / DEFAULT_AUTO_APPROVE.
 *
 * Includes `merge` so entity near-duplicate merges (pod hygiene) and channel
 * branch merges can never auto-execute. Format used by the floor is the bare
 * action verb; event keys are `${subjectType}.${action}` (e.g. `entity.merge`).
 */
export const DESTRUCTIVE_ACTIONS: readonly string[] = [
  "delete",
  "archive",
  "purge",
  "merge",
];

/**
 * The ONE SOURCE of the default daily auto-execute write ceiling (rung 2.56 —
 * governance_ceilings axis `daily_write_count`). Consulted by the resolver
 * (`resolveDailyWriteCeiling` in @synap/database) when NO `governance_ceilings`
 * row matches the acting (agent, scope) tuple — the same "absence → code floor"
 * shape `DEFAULT_AUTO_APPROVE` (rung 8) uses. A stored ceiling row always sets
 * its own `limit_value`; this is only the fallback. The DB column deliberately
 * carries NO default so this constant stays the single source (see the 0236
 * migration + governance-ceilings.ts header).
 *
 * NOTE — distinct from the pod-hygiene near-dup scanner's
 * `MAX_PROPOSALS_PER_USER_PER_DAY` (packages/jobs): that caps how many MERGE
 * PROPOSALS one HUMAN user's nightly scan may FILE; this caps how many WRITES one
 * AGENT may AUTO-EXECUTE. Different population (proposals filed vs writes
 * executed), principal (user vs agent), and axis — NOT the same concept, so they
 * are deliberately NOT consolidated.
 */
export const DEFAULT_DAILY_WRITE_CEILING = 500;

/**
 * The ONE canonical reader of `workspaces.settings.governanceMode`. Both
 * `resolveAgentGovernanceDecision` (@synap/database) and
 * `getEffectiveGovernance` (@synap/api's permission-check.ts) used to read
 * this field with their own inline cast — this collapses them to one typed
 * accessor. Structurally typed (not `WorkspaceSettings`) so this
 * dependency-free package never has to import a database schema type.
 * Unrecognized/absent values normalize to "standard" (the canonical default),
 * matching both callers' prior behavior.
 */
export function getWorkspaceGovernanceMode(
  settings: { governanceMode?: unknown } | null | undefined
): "standard" | "agent-owned" {
  return settings?.governanceMode === "agent-owned"
    ? "agent-owned"
    : "standard";
}

/**
 * Administrative actions that ALWAYS require a proposal, regardless of
 * auto-approve overrides, the writesRequireProposal flag, or the whitelist.
 * Even a twin agent (writesRequireProposal=false) must propose these.
 */
/**
 * ⚠️ THE INVARIANT — READ BEFORE EDITING EITHER LIST BELOW.
 *
 * Every entry is an `${subjectType}.${action}` EVENT KEY, matched by EXACT
 * EQUALITY at rung 2 (`ADMIN_ACTIONS.includes(eventKey)`). The key is composed
 * from the RAW gate arguments — `permission-check.ts:1186` builds
 * `${subjectType}.${action}` BEFORE the trailing-`s` singularization at
 * `:1764`, so the raw spelling a call site passes is the spelling that must
 * appear here.
 *
 * `matchesActionPattern` / `findMatchingPattern` (the `subject.*` glob helpers)
 * are a DIFFERENT function and are NOT used at rung 2. There is no globbing and
 * no pluralization forgiveness here.
 *
 * ⇒ A wrong string is INVISIBLE. It does not error, does not warn, does not
 * log — it simply never fires, and the admin hard floor silently does not apply
 * to that write. That is exactly what happened: `member.updateRole`,
 * `member.remove`, `member.invite` and `apiKey.revoke` named doors that do not
 * exist (the real gates pass `workspaceMember` + `add`/`remove`/`updateRole`
 * and `apiKey` + `delete`), and `workspace.delete` missed because
 * `routers/workspaces.ts` passes the PLURAL `"workspaces"`. Four admin writes —
 * adding a member, removing one, changing a role, deleting an API key — were
 * not floored at all.
 *
 * The fix is structural, not just textual: {@link ADMIN_ACTIONS_LIVE} is typed
 * as {@link GateEventKey}, derived from `GATE_WRITE_DOORS`, so an entry naming
 * no real gate door is now a COMPILE ERROR. Anything that cannot be typed that
 * way goes in {@link ADMIN_ACTIONS_RESERVED} with a reason — never silently
 * into the live list.
 */

/**
 * Admin floors that correspond to a REAL gate door. Type-checked against
 * `GATE_WRITE_DOORS`: a typo, a renamed subject, or a singular/plural slip is a
 * compile error rather than a floor that quietly stops firing.
 *
 * BOTH SPELLINGS are listed wherever a subject could reasonably be passed
 * either way. Listing both is free and strictly tightening; listing one is how
 * `workspace.delete` came to miss a door that has existed all along.
 */
export const ADMIN_ACTIONS_LIVE: readonly GateEventKey[] = [
  // `routers/workspaces.ts` passes the PLURAL; the MCP + hub-protocol doors
  // pass the singular. Both reach rung 2 with their own raw spelling.
  // `workspaces` (plural) is the ONLY plural subjectType any gate actually
  // passes (`routers/workspaces.ts:75,467,776`) — verified by enumerating
  // every `subjectType: "<...>s"` in the routers. The eventKey is composed
  // from the RAW subjectType (`permission-check.ts:1156,1224`); the
  // singularization at `:1794` applies only to the proposal's `targetType`,
  // NOT to this match. So every other plural spelling would be a dead entry
  // naming a door that does not exist — which is the exact defect this list
  // was just corrected for. Add a spelling ONLY after grepping for its gate.
  "workspace.update",
  "workspaces.update",
  "workspace.delete",
  "workspaces.delete",
  // Membership. Real gates: `routers/workspaces/invites.ts` — `workspaceMember`
  // + add / remove / updateRole. (The old `member.*` spellings never matched;
  // they are retained in ADMIN_ACTIONS_RESERVED below.)
  "workspaceMember.add",
  "workspaceMember.remove",
  "workspaceMember.updateRole",
  // Agent capability grants — `routers/agent-users.ts`.
  "agent.updateCapabilities",
  // API keys. `apiKey.create` was already correct; the DELETE door is spelled
  // `delete`, never `revoke` (`routers/api-keys.ts`).
  "apiKey.create",
  "apiKey.delete",
];

/**
 * Admin floors for doors that DO NOT EXIST as gate call sites today.
 *
 * They are deliberately kept: removing a floor is the one direction this list
 * must never move, and if such a door ever ships it inherits the floor on day
 * one instead of arriving ungoverned. They are OUT of the typed list because
 * they cannot be typed — and being out of it is the honest signal that they
 * currently match nothing.
 *
 * Verified 2026-08-19 against every `checkPermissionOrPropose` call site: none
 * of these keys is produced by any live gate.
 */
export const ADMIN_ACTIONS_RESERVED: readonly string[] = [
  // Superseded spellings — the real doors are the `workspaceMember.*` entries
  // above. Kept only so a future `member`-subject door cannot slip through.
  "member.updateRole",
  "member.remove",
  "member.invite",
  // No agent lifecycle door goes through the gate today (only
  // `agent.updateCapabilities`, which IS live above).
  "agent.create",
  "agent.delete",
  "agent.updateRole",
  "agent.update",
  // The api-keys router exposes create / update / delete — never revoke or
  // rotate. NOTE: `apiKey.update` IS a real door and is NOT floored; whether it
  // should be is a policy decision, not a drift fix, so it is left alone here.
  "apiKey.revoke",
  "apiKey.rotate",
  // No gate door for any of these subjects exists yet.
  "intelligence.connect",
  "intelligence.disconnect",
  "trustedIssuer.create",
  "trustedIssuer.delete",
  "connector.connect",
  "connector.disconnect",
];

/**
 * Administrative actions that ALWAYS require a proposal, regardless of
 * auto-approve overrides, the writesRequireProposal flag, or the whitelist.
 * Even a twin agent (writesRequireProposal=false) must propose these.
 *
 * The concatenation of {@link ADMIN_ACTIONS_LIVE} and
 * {@link ADMIN_ACTIONS_RESERVED} — consumers are unchanged.
 */
export const ADMIN_ACTIONS: readonly string[] = [
  ...ADMIN_ACTIONS_LIVE,
  ...ADMIN_ACTIONS_RESERVED,
];

/**
 * HUMAN GATES — writes whose ENTIRE PURPOSE is that a person says yes.
 *
 * These are not "sensitive writes that should usually be reviewed". They are
 * writes that carry NO value at all unless a human made the call: the server-side
 * dev loop files `dev.plan_approval` before it writes code and
 * `dev.deploy_approval` before it ships, and an agent that could auto-approve
 * either one has simply deleted the gate while leaving the paperwork behind.
 *
 * WHY A SEPARATE LIST FROM {@link ADMIN_ACTIONS}. Both floor at "always propose",
 * but they answer different questions and must be readable apart: ADMIN names
 * writes that change WHO CAN DO WHAT (membership, keys, capabilities), and a
 * future policy could reasonably argue about one of its entries. A human gate is
 * definitionally unwidenable — the day one of these auto-approves, the feature it
 * belongs to is broken, not merely loosened. Merging the two lists would let a
 * later "relax an admin floor" edit silently take a dev gate with it.
 *
 * SAME MATCHING CONTRACT AS ADMIN_ACTIONS — exact equality on the
 * `${subjectType}.${action}` event key composed from the RAW gate arguments. No
 * globbing, no pluralization forgiveness. A wrong string here is INVISIBLE.
 *
 * HONEST LIMIT — these keys name NO gate call site today, the same status as
 * {@link ADMIN_ACTIONS_RESERVED}: the dev-approval doors file their proposal
 * DIRECTLY (`createDevApprovalProposal` → `createEventBackedProposal`), so they
 * never reach `decideAgentPolicy` and this floor is defence in depth, not the
 * live protection. It is here so that the day someone routes a dev approval
 * through the gate — or through `checkAutomationWriteOrPropose` — it arrives
 * floored on day one instead of inheriting rung 8's auto-execute. That is the
 * exact failure mode `workspace.delete` had for months.
 */
export const HUMAN_GATE_EVENT_KEYS: readonly string[] = [
  "dev.plan_approval",
  "dev.deploy_approval",
  "focus_session.plan_approval",
  "focus_session.deploy_approval",
];

/**
 * ARBITRARY CODE EXECUTION — doors that hand an agent a shell, not a record.
 *
 * `POST /api/hub/commands/execute` runs `execFileSync("/bin/sh", ["-c", cmd])`
 * INSIDE the API container, guarded only by a regex denylist. That is not a
 * write to a row: it is the SUPERSET of every other door in this file. Anything
 * that can run a shell there can read the database, mint an API key, edit
 * membership and rewrite the governance rules that were supposed to constrain
 * it — so no rung below may ever resolve it to "execute".
 *
 * WHY ITS OWN LIST, not `DESTRUCTIVE_ACTIONS`. That floor (rung 2.5) matches the
 * BARE ACTION VERB (`DESTRUCTIVE_ACTIONS.includes(action)`). Adding `"execute"`
 * there would also floor `automation.execute` and `capability.execute` — two
 * real, high-traffic gate doors (`GATE_WRITE_DOORS["automation/execute"]`;
 * `guardProducerEffect` in packages/jobs) — forcing every automation run to a
 * human proposal. The dangerous thing here is the SUBJECT (a shell), not the
 * verb, so the floor must be keyed on the EVENT KEY.
 *
 * WHY ITS OWN LIST, not {@link ADMIN_ACTIONS_LIVE} or {@link HUMAN_GATE_EVENT_KEYS}.
 * Same reasoning that already split those two apart: ADMIN names writes that
 * change WHO CAN DO WHAT, and its own docblock concedes "a future policy could
 * reasonably argue about one of its entries" — this is not an entry anyone may
 * argue about. A human gate is paperwork whose value IS the yes; a shell is a
 * capability escape. Keeping them separate means a later "relax an admin floor"
 * edit cannot take arbitrary code execution with it, and the review UI gets a
 * distinct `reasonCode` to render.
 *
 * SAME MATCHING CONTRACT as the two lists above — exact equality on the
 * `${subjectType}.${action}` event key composed from the RAW gate arguments. No
 * globbing, no pluralization forgiveness. Typed as {@link GateEventKey} so a
 * string naming no real door is a COMPILE ERROR rather than a floor that
 * silently never fires.
 */
export const ARBITRARY_EXECUTION_EVENT_KEYS: readonly GateEventKey[] = [
  "command.execute",
];

/**
 * Filesystem paths ALWAYS blocked for external agent writes, regardless of user
 * approval or workspace settings. Backend enforcement layer (the synap-os skill
 * also enforces these on the OpenClaw side as the first line of defence).
 */
export const BLOCKED_FILESYSTEM_PATHS: readonly RegExp[] = [
  /synap[-_]backend/i,
  /synap[-_]intelligence/i,
  /synap[-_]realtime/i,
  /docker-compose/i,
  /\.env(?:\.|$)/,
  /\.env\.local/,
  /\.env\.production/,
  /^\/etc\//,
  /^\/usr\//,
  /^\/bin\//,
  /^\/sbin\//,
  /^\/root\//,
  /^\/sys\//,
  /^\/proc\//,
  /^\/dev\//,
  /private\.key/i,
  /\.pem$/i,
  /id_rsa/i,
  /authorized_keys/i,
];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export type RequiredPermission = "read" | "write" | "delete" | "manage";

/**
 * Read-only action verbs actually passed into `requiredPermissionFor` across
 * the codebase (search.entities, memory.recall, entity.read, and the explicit
 * "read" verb used by filesystem.read-style checks). Kept as an exported list
 * so the read set and the fail-closed fallback below are provably exhaustive
 * against the same inventory the tests assert on.
 */
const READ_ACTIONS: readonly string[] = ["read", "recall", "entities"];

/**
 * The complete inventoried action-verb vocabulary (see policy.test.ts's
 * INVENTORIED_VERBS for the regenerate recipe). The soft-union parameter type
 * on requiredPermissionFor gives call sites autocomplete + typo detection
 * without breaking dynamic (string-typed) callers — a new verb still compiles,
 * still fail-closes to "write", and should then be added here + to the
 * explicit mapping + the test fixture.
 */
export type KnownGovernanceAction =
  | "read"
  | "recall"
  | "entities"
  | "delete"
  | "purge"
  | "create"
  | "update"
  | "archive"
  | "restore"
  | "add"
  | "place"
  | "remove"
  | "updateRole"
  | "renderer.set"
  | "attach"
  | "detach"
  | "updateCapabilities"
  | "merge"
  | "create_branch"
  | "create_external"
  | "join"
  | "link"
  | "setState"
  | "execute"
  | "run"
  | "grant_capability"
  | "register"
  | "arrange"
  | "invite"
  | "recap"
  | "declare_source"
  | "configure_public_projection"
  | "write";

/**
 * Map an action verb → the RBAC permission it requires.
 *
 * NOTE: this is the CANONICAL gate's mapping (it includes "place"). The old
 * jobs fork omitted "place" — a silent divergence this consolidation removes by
 * adopting the canonical superset. Automations only emit create/update, so the
 * fork's effective behavior is unchanged.
 *
 * Wave 2F hardening: this used to fall through unmatched verbs to "read" —
 * under-gating any write verb nobody had thought to enumerate yet (RBAC would
 * only require read permission for it). The fallback below now returns
 * "write" instead: a full inventory of every `action` string passed to
 * checkPermissionOrPropose / checkAutomationWriteOrPropose across
 * packages/api and packages/jobs was taken (see policy.test.ts's
 * `INVENTORIED_VERBS` fixture for the regenerate recipe) and every verb found
 * is now listed explicitly below, so the fallback should be unreachable for
 * known call sites — it exists purely as a fail-closed floor for a future verb
 * nobody has enumerated yet. Conservative-by-design: an unrecognized verb now
 * demands "write" (propose/deny for under-privileged agents) rather than
 * silently passing as a read.
 */
export function requiredPermissionFor(
  action: KnownGovernanceAction | (string & {})
): RequiredPermission {
  if (action === "delete" || action === "purge") return "delete";
  if (READ_ACTIONS.includes(action)) return "read";
  if (
    action === "create" ||
    action === "update" ||
    action === "archive" ||
    action === "restore" ||
    action === "add" ||
    action === "place" ||
    action === "remove" ||
    action === "updateRole" ||
    action === "renderer.set" ||
    // Kind + Facets (Wave 1B): facet.attach / facet.update / facet.detach.
    // "detach" is a soft-delete (reversible), so it maps to "write" here, not
    // "delete" — the DESTRUCTIVE_ACTIONS floor in decideAgentPolicy only
    // checks for the literal verbs "delete"/"archive"/"purge", so detach is
    // correctly NOT hard-floored to always-propose.
    action === "attach" ||
    action === "detach" ||
    // Wave 2F additions — every other mutating verb found in the inventory.
    action === "updateCapabilities" ||
    action === "merge" ||
    action === "create_branch" ||
    action === "create_external" ||
    action === "join" ||
    action === "link" ||
    action === "setState" ||
    action === "execute" ||
    action === "run" ||
    action === "grant_capability" ||
    action === "register" ||
    action === "arrange" ||
    action === "invite" ||
    // run-session-recap.ts gates the recap write under this verb.
    action === "recap" ||
    // Enterprise-OS Wave 0: declaring a workspace data edge
    // (synap_declare_workspace_source / Hub source-edges) is a governed write.
    action === "declare_source" ||
    // Setting a workspace's public-projection config (Hub
    // public-projection door) is a governed write — same editor+ floor.
    action === "configure_public_projection" ||
    action === "write"
  ) {
    return "write";
  }
  // Fail-closed floor: an unrecognized verb demands "write" rather than
  // silently under-gating as "read". See the doc comment above.
  return "write";
}

/** True if the path matches any always-blocked filesystem pattern. */
export function isBlockedFilesystemPath(path: string): boolean {
  return BLOCKED_FILESYSTEM_PATHS.some((re) => re.test(path));
}

/** Glob match for action patterns: exact, or "<subject>.*" prefix. */
export function matchesActionPattern(
  eventKey: string,
  patterns: readonly string[]
): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith(".*")
      ? eventKey.startsWith(pattern.slice(0, -1))
      : eventKey === pattern
  );
}

/**
 * Which whitelist pattern matched this event key (for audit attribution), or
 * undefined if none. Same glob rule as {@link matchesActionPattern} — this is
 * the "which one" companion to that function's "any". Use it instead of
 * re-deriving the glob inline so the matcher lives in exactly one place.
 */
export function findMatchingPattern(
  eventKey: string,
  patterns: readonly string[]
): string | undefined {
  return patterns.find((pattern) =>
    pattern.endsWith(".*")
      ? eventKey.startsWith(pattern.slice(0, -1))
      : eventKey === pattern
  );
}

/**
 * Validate a caller-supplied `autoApproveFor` list for entries that EXPLICITLY
 * name a DESTRUCTIVE action (delete/archive/purge/merge). Used by the write-side
 * gates (agent-users governance PATCH, workspace settings writer) to reject a
 * grant BEFORE it is persisted.
 *
 * Only explicit destructive verbs are rejected — e.g. "delete", "purge",
 * "entity.delete", "document.archive", "entity.merge". Wildcards ("*", "*.*",
 * "entity.*") are ALLOWED: the `decideAgentPolicy` DESTRUCTIVE_ACTIONS hard
 * floor (rung 2.5) is the real backstop — it blocks destructive auto-approval
 * regardless of the whitelist, so no wildcard can ever auto-approve a
 * delete/merge. Rejecting wildcards here (an earlier iteration did) would break
 * the built-in "Crazy" governance preset, whose value is literally `["*"]`. This
 * validator therefore only stops an operator from EXPLICITLY listing a
 * destructive verb — a setting the floor would silently override anyway, so
 * blocking it keeps the config honest.
 *
 * Entries are trimmed + lower-cased before matching. Returns the (original)
 * entries that failed validation (empty = all OK).
 */
export function findUnsafeAutoApproveEntries(
  entries: readonly string[]
): string[] {
  return entries.filter((raw) => {
    const entry = raw.trim().toLowerCase();
    const action = entry.includes(".")
      ? entry.slice(entry.lastIndexOf(".") + 1)
      : entry;
    return (DESTRUCTIVE_ACTIONS as readonly string[]).includes(action);
  });
}

/** True if the event key is auto-approved by the (possibly overridden) whitelist. */
export function isAutoApproved(
  eventKey: string,
  autoApproveFor: readonly string[] = DEFAULT_AUTO_APPROVE
): boolean {
  return matchesActionPattern(eventKey, autoApproveFor);
}

/**
 * CBAC: does the agent's capability allowlist permit this event key?
 * Supports exact ("entity.create"), subject wildcard ("entity.*"), and "*.*".
 */
export function agentHasCapability(
  eventKey: string,
  subjectType: string,
  capabilities: readonly string[]
): boolean {
  return (
    capabilities.includes(eventKey) ||
    capabilities.includes(`${subjectType}.*`) ||
    capabilities.includes("*.*")
  );
}

/** Pure-read actions are exempt from write-governance (capabilities/proposal). */
export function isPureReadAction(
  subjectType: string,
  action: string,
  eventKey: string = `${subjectType}.${action}`
): boolean {
  return (
    action.endsWith(".read") ||
    subjectType === "search" ||
    subjectType === "context" ||
    subjectType === "memory" ||
    eventKey.endsWith(".read") ||
    eventKey === "memory.recall" ||
    /^search\./.test(eventKey) ||
    /^context\./.test(eventKey) ||
    /^memory\./.test(eventKey)
  );
}

// ---------------------------------------------------------------------------
// Per-channel capability grant (multiplayer rooms)
// ---------------------------------------------------------------------------

/**
 * Per-channel capability grant for an AI teammate writing in a multiplayer room.
 * These can only TIGHTEN a teammate's effective grant for this channel, never
 * widen its workspace RBAC.
 */
export interface ChannelCapabilityGrant {
  canDraft: boolean;
  canPropose: boolean;
  canAct: boolean;
}

/** The three outcomes a channel capability grant can force for a write. */
export type ChannelCapabilityDecision = "act" | "propose" | "block";

/**
 * Collapse a per-channel capability grant into a single governance decision.
 * CONSERVATIVE BY DESIGN: absent or all-false grant → "propose", never "act".
 * `canAct` is the only path to "act"; draft-only (no propose, no act) → "block".
 */
export function resolveChannelCapabilityDecision(
  grant: Partial<ChannelCapabilityGrant> | null | undefined
): ChannelCapabilityDecision {
  if (!grant) return "propose";
  if (grant.canAct === true) return "act";
  if (grant.canPropose === true) return "propose";
  return "block";
}

// ---------------------------------------------------------------------------
// The decision ladder
// ---------------------------------------------------------------------------

export interface AgentPolicyInput {
  subjectType: string;
  /** The write action verb (create / update / delete / …). */
  action: string;
  /** The agent's explicit capability allowlist. Empty/absent → unrestricted. */
  agentCapabilities?: readonly string[] | null;
  /** From the agent's metadata — assistant-template agents propose on writes. */
  writesRequireProposal?: boolean;
  /** Workspace governanceMode — "agent-owned" forces destructive → propose. */
  governanceMode?: string | null;
  /** Workspace override; defaults to DEFAULT_AUTO_APPROVE when undefined. */
  autoApproveFor?: readonly string[];
  /**
   * True when the acting agent is the owner of the target workspace
   * (workspace.linkedAgentId === agentUserId && workspaceType === "agent").
   * Ownership bypasses writesRequireProposal for non-destructive writes.
   * Destructive actions (delete/archive/purge/merge) still propose even for the owner.
   * ADMIN_ACTIONS always propose regardless of ownership.
   */
  isAgentOwnedWorkspace?: boolean;
  /**
   * Effective per-channel capability grant when the write is evaluated inside a
   * multiplayer channel. Absent/undefined → no per-channel tightening.
   */
  channelCapabilities?: Partial<ChannelCapabilityGrant> | null;
  /**
   * The entity profile slug of the write SUBJECT (e.g. "user_observation"),
   * when the write targets an entity. Used by the governance-by-KIND rule:
   * a `user_observation` is governed by the nature of the observation, not by
   * the routing workspace. Absent/undefined → rule does not fire.
   */
  subjectProfileSlug?: string | null;
  /**
   * The `uo_validated` property of a `user_observation` subject. Distinguishes
   * an EXPLICIT observation (user-stated, validated === true → auto-approve)
   * from an INFERENCE (AI-inferred, anything else → propose). Only consulted
   * when `subjectProfileSlug === "user_observation"`.
   */
  subjectUoValidated?: boolean | null;
  /**
   * The capability's resolved approval-state, when this gate call governs a
   * CAPABILITY EXECUTION (tool/skill/command run) rather than a data write.
   * Sourced from the capability read-model's `governance` field (today derived
   * from the tool/skill `approved` column) once it is backed by persisted state.
   * Absent → not a capability run → rung 2.7 no-ops (data-write paths unchanged).
   */
  capabilityGovernance?: "auto" | "propose" | "block" | null;
  /**
   * The GRANT's exec-mode (the `grant_exec_mode` enum / `@synap/playbooks
   * ExecMode` — the PERSISTABLE truth: `auto | propose`). Narrows the
   * capability's own approval-state for THIS grant: "propose" forces a reviewable
   * per-run proposal even if the capability is "auto". When present it takes
   * precedence over capabilityGovernance in rung 2.7.
   *
   * NOTE: exec-mode lives in TWO layers. `dry-run` is the third persistable
   * grant_exec_mode value but is a GATE-level concern — `gateCapabilityExecution`
   * short-circuits it to a preview BEFORE calling `decideAgentPolicy`, so it never
   * reaches this policy union. The retired `propose-each`/`block` values were
   * orphaned (never persistable in the grant column); `propose` already covers
   * what `propose-each` meant, and deny comes from no-grant / not-approved, not a
   * `block` mode.
   */
  capabilityExecMode?: "auto" | "propose" | null;
  /**
   * Force a PROPOSAL even when the action would otherwise auto-approve. Set by a
   * caller for a scope/identity-bearing write that must always be reviewed
   * (e.g. promoting an entity workspace→pod-wide, or changing its profile TYPE).
   * Honored AFTER the CBAC deny (rung 1) and ADMIN (rung 2) rungs, so a
   * capability-denied or admin action is unaffected, but BEFORE every execute
   * path below. Absent/false → no effect (all existing verdicts unchanged).
   */
  forcePropose?: boolean;
  /**
   * Explicit opt-in that lets a DESTRUCTIVE action (delete/archive/purge/merge)
   * be resolved to "execute" by a downstream override rung (ownership, explicit
   * autoApproveFor, DEFAULT_AUTO_APPROVE, capability governance). Absent/false
   * (the default) → destructive actions ALWAYS propose, mirroring the
   * ADMIN_ACTIONS hard floor. This is the raw escape hatch for a future
   * "Crazy" mode, which is not yet first-class on the agent/workspace record.
   * TODO: wire to a first-class Crazy mode instead of a raw boolean once one
   * becomes a persisted, resolvable setting.
   */
  allowDestructiveAutoApprove?: boolean;
  /**
   * The resolved `governance_rules` store verdict for this
   * (principal, scope, target) tuple — rung 2.8. Resolved by the caller
   * (`resolveGovernanceRule` in @synap/database, which has `db`; this engine
   * stays pure). `"auto"` executes, `"propose"` proposes; absent/undefined
   * means no rule matched and the rung no-ops, falling through
   * byte-identical to every rung below. NEVER `"deny"` — a rule can only
   * widen or keep-reviewable, never close a door a floor already opened.
   */
  governanceRuleVerdict?: "auto" | "propose";
  /**
   * Server-resolved TRUST of the acting channel's ORIGIN — the #4
   * instruction-provenance signal, consumed at rung 2.55. `"untrusted"` for an
   * EXTERNAL / bridge / `source`-produced channel (a message authored outside
   * the pod owner's direct control); `"trusted"` for a PERSONAL/THREAD
   * owner-authored channel, or when an operator's `config_settings` posture
   * explicitly restores auto for a specific bridge/channel. Resolved by the
   * I/O half (`resolveOriginTrust` in @synap/database — this engine stays pure)
   * from the acting channelId, NEVER from the request body (like `IssuerTrust`).
   * Absent/undefined (the common case — no channel context) → rung 2.55 no-ops,
   * falling through byte-identical to every rung below. TIGHTEN-ONLY: it can
   * only ever downgrade a would-be-auto write to `propose`, never widen, never
   * deny — so it cannot weaken a floor (all three floors return above it) and
   * cannot open a door a floor already closed.
   */
  originTrust?: "trusted" | "untrusted";
  /**
   * The resolved DAILY-WRITE-CEILING verdict for the acting agent — rung 2.56
   * (governance_ceilings axis `daily_write_count`). `"propose"` when the agent
   * has already reached its resolved per-UTC-day auto-execute write limit; the
   * next would-be-auto write is then downgraded to a reviewable proposal.
   * Resolved LAZILY by the I/O half (`resolveAgentGovernanceDecision` in
   * @synap/database — this engine stays pure): it counts the agent's writes for
   * the day ONLY when the base verdict would otherwise be `execute`, so absent/
   * undefined (the common case) → rung 2.56 no-ops, falling through
   * byte-identical to every rung below. TIGHTEN-ONLY, exactly like `originTrust`:
   * the ONLY value the engine ever receives is `"propose"` — it can never widen,
   * never deny, and (sitting below all three floors) can never weaken a floor.
   */
  ceilingVerdict?: "propose";
}

/**
 * The verdict. For `propose`, `reason` is the DEFAULT reasoning to use when the
 * caller has no explicit reasoning (caller pattern: `opts.reasoning ?? reason`).
 * `reason` is absent for the plain default-propose case, matching the gates'
 * prior behavior of passing through the caller's reasoning unchanged.
 *
 * `reasonCode` is the STRUCTURED companion to `reason`: the `PROPOSE_REASON` KEY
 * (e.g. `"UNTRUSTED_ORIGIN"`, `"DAILY_WRITE_CEILING"`) the human sentence came
 * from. Additive/optional — a machine-readable discriminator the review UI can
 * branch on (e.g. render a distinct "why this needs you" treatment for a
 * force-propose rung) without string-matching the prose. Absent for the plain
 * default-propose case, exactly like `reason`. Distinct from the proposal
 * `reason_code` column, which carries REJECTION semantics.
 */
export type AgentPolicyVerdict =
  | { verdict: "execute" }
  | { verdict: "propose"; reason?: string; reasonCode?: string }
  | { verdict: "deny"; reason: string };

/** Default reasoning strings (kept identical to the prior inline gate strings). */
export const PROPOSE_REASON = {
  ADMIN: "Administrative action requires human approval.",
  WRITES_REQUIRE_PROPOSAL: "Agent requires proposal for all write operations.",
  AGENT_OWNED_DESTRUCTIVE:
    "Destructive action in agent-owned workspace requires human approval.",
  CHANNEL_PROPOSE:
    "Teammate may propose in this channel; write requires human approval.",
  USER_OBSERVATION_INFERENCE:
    "AI-inferred observation about the user requires human validation before it is stored.",
  CAPABILITY_PROPOSE: "Capability execution requires human approval.",
  SCOPE_IDENTITY_CHANGE:
    "This change alters the record's scope or identity and requires human approval.",
  DESTRUCTIVE_HARD_FLOOR:
    "Destructive action (delete/archive/purge/merge) always requires human approval.",
  GOVERNANCE_RULE: "Matched a governance rule requiring human approval.",
  UNTRUSTED_ORIGIN:
    "This write originates from an untrusted channel (external / bridge) and requires human approval before it is applied.",
  DAILY_WRITE_CEILING:
    "This agent has reached its daily auto-execute write ceiling; further writes require human approval today.",
  HUMAN_GATE:
    "This is a human gate — a person must approve it, and no governance rule can widen it.",
  ARBITRARY_EXECUTION:
    "This runs an arbitrary shell command inside the pod's API container and always requires human approval; no governance rule can widen it.",
} as const;

const CHANNEL_BLOCK_REASON =
  "Teammate is draft-only in this channel and may not commit writes (can_act and can_propose are both off).";

const CAPABILITY_BLOCKED_REASON =
  "Capability is present but disabled (governance/exec-mode resolved to block).";

/**
 * Decide the agent governance verdict. PURE — no I/O. Apply ONLY after RBAC has
 * passed and the actor is confirmed to be an agent user.
 */
export function decideAgentPolicy(input: AgentPolicyInput): AgentPolicyVerdict {
  const { subjectType, action } = input;
  const eventKey = `${subjectType}.${action}`;

  // 1. CBAC capability allowlist (empty/absent = unrestricted).
  const caps = input.agentCapabilities;
  if (
    caps &&
    caps.length > 0 &&
    !agentHasCapability(eventKey, subjectType, caps)
  ) {
    return {
      verdict: "deny",
      reason: `Agent capability check failed for "${eventKey}". Allowed: ${caps.join(", ")}.`,
    };
  }

  // 2. ADMIN_ACTIONS → always propose (even for owned workspace).
  if (ADMIN_ACTIONS.includes(eventKey)) {
    return {
      verdict: "propose",
      reason: PROPOSE_REASON.ADMIN,
      reasonCode: "ADMIN",
    };
  }

  // 2.05 HUMAN GATES → always propose, and no rung below can ever widen them.
  // Placed immediately under ADMIN (rung 2) and ABOVE the governance_rules store
  // (rung 2.8), ownership (3), explicit autoApproveFor (4) and DEFAULT_AUTO_APPROVE
  // (8) — which is the whole point: a `dev.plan_approval` that a trusted-lane rule
  // could flip to "auto" is a plan gate that approves its own plan.
  if (HUMAN_GATE_EVENT_KEYS.includes(eventKey)) {
    return {
      verdict: "propose",
      reason: PROPOSE_REASON.HUMAN_GATE,
      reasonCode: "HUMAN_GATE",
    };
  }

  // 2.06 ARBITRARY CODE EXECUTION → always propose. A shell inside the API
  // container is the superset of every other door here, so it is floored ABOVE
  // the governance_rules store (rung 2.8), ownership (3), autoApproveFor incl.
  // wildcards (4) and DEFAULT_AUTO_APPROVE (8). Keyed on the EVENT KEY, not the
  // bare verb: flooring `"execute"` at rung 2.5 would also catch
  // `automation.execute` / `capability.execute`, which are ordinary runs.
  if (
    (ARBITRARY_EXECUTION_EVENT_KEYS as readonly string[]).includes(eventKey)
  ) {
    return {
      verdict: "propose",
      reason: PROPOSE_REASON.ARBITRARY_EXECUTION,
      reasonCode: "ARBITRARY_EXECUTION",
    };
  }

  // 2.1 CALLER-FORCED PROPOSAL — a scope/identity-bearing write.
  // The caller signalled that this edit changes the record's SCOPE or IDENTITY
  // (not a field patch), e.g. promoting a workspace entity to pod-wide, or
  // changing its profile TYPE. Such a change must always be reviewed even when
  // the action would otherwise auto-approve. Sits after CBAC (rung 1) and ADMIN
  // (rung 2) so a capability-denied action still denies and admin actions are
  // unaffected, but BEFORE every execute path below.
  if (input.forcePropose === true) {
    return {
      verdict: "propose",
      reason: PROPOSE_REASON.SCOPE_IDENTITY_CHANGE,
      reasonCode: "SCOPE_IDENTITY_CHANGE",
    };
  }

  // 2.5 DESTRUCTIVE_ACTIONS hard floor — mirrors ADMIN_ACTIONS: a destructive
  // action (delete/archive/purge/merge) can NEVER be resolved to "execute" by
  // ANY override rung below — ownership (rung 3), explicit autoApproveFor
  // (rung 4), capability governance (rung 2.7), or DEFAULT_AUTO_APPROVE
  // (rung 8). Without this floor, an operator whitelisting a broad pattern
  // like "entity.*" or "*" via autoApproveFor would silently auto-approve
  // deletes/merges (rung 4 had no destructive check, unlike rungs 3 and 6).
  // EXCEPTION: `allowDestructiveAutoApprove` is the raw opt-in for the future
  // "Crazy" mode. Default (absent/false) → always propose.
  // TODO: wire to a first-class Crazy mode instead of a raw boolean.
  if (
    DESTRUCTIVE_ACTIONS.includes(action) &&
    input.allowDestructiveAutoApprove !== true
  ) {
    return {
      verdict: "propose",
      reason: PROPOSE_REASON.DESTRUCTIVE_HARD_FLOOR,
      reasonCode: "DESTRUCTIVE_HARD_FLOOR",
    };
  }

  // 2.55 UNTRUSTED ORIGIN → propose (TIGHTEN-ONLY; #4 instruction-provenance).
  // When the acting channel's origin is not owner-trusted — an EXTERNAL /
  // bridge / `source`-produced channel, i.e. a message authored by a third
  // party outside the pod owner's direct control — a write that WOULD otherwise
  // auto-execute is downgraded to a reviewable proposal. Untrusted-origin
  // content must be REVIEWED before it mutates the pod, never silently applied.
  //
  // PLACEMENT (proof it never weakens a floor and only downgrades auto→propose):
  //   • BELOW the three floors — 2 ADMIN, 2.1 forcePropose, 2.5 DESTRUCTIVE —
  //     which have already returned above, so this rung can NEVER open a door a
  //     floor closed (a floor's proposal/deny stands).
  //   • ABOVE every auto path below — 2.6 by-kind (its EXPLICIT-observation
  //     execute), 2.7 per-capability governance, 2.8 governance_rules, 3
  //     ownership, 4 explicit autoApproveFor, 8 DEFAULT_AUTO_APPROVE — so an
  //     untrusted origin's would-be-auto write resolves to `propose` HERE before
  //     any of those can execute it (an untrusted origin therefore beats even a
  //     stored `verdict:"auto"` rule or an "auto" capability grant).
  // It NEVER denies (untrusted ≠ blocked — the write is reviewed, no data loss)
  // and NEVER executes. `originTrust` is resolved server-side from the acting
  // channel (never the request body); absent/undefined → this rung no-ops.
  if (input.originTrust === "untrusted") {
    return {
      verdict: "propose",
      reason: PROPOSE_REASON.UNTRUSTED_ORIGIN,
      reasonCode: "UNTRUSTED_ORIGIN",
    };
  }

  // 2.56 DAILY WRITE CEILING → propose (TIGHTEN-ONLY; governance_ceilings axis
  // daily_write_count). When the acting agent has already reached its resolved
  // per-UTC-day auto-execute write limit, the next would-be-auto write is
  // downgraded to a reviewable proposal — daily backpressure against a runaway
  // agent (a stuck loop, a fan-out cron) silently auto-writing all day.
  //
  // PLACEMENT (same class as 2.55 — proof it never weakens a floor):
  //   • BELOW the three floors (2 ADMIN, 2.1 forcePropose, 2.5 DESTRUCTIVE),
  //     which have already returned above → can NEVER open a door a floor closed.
  //   • ABOVE every auto path (2.6/2.7/2.8/3/4/8) → a would-be-auto write
  //     resolves to `propose` HERE before any of them can execute it.
  // NEVER denies (over-ceiling ≠ blocked — the write is reviewed, no data loss)
  // and NEVER executes. `ceilingVerdict` is resolved LAZILY server-side — only
  // counted when the base verdict would be `execute` (so the field is `"propose"`
  // ONLY in the over-limit case); absent/undefined → this rung no-ops.
  if (input.ceilingVerdict === "propose") {
    return {
      verdict: "propose",
      reason: PROPOSE_REASON.DAILY_WRITE_CEILING,
      reasonCode: "DAILY_WRITE_CEILING",
    };
  }

  // 2.6 GOVERNANCE BY KIND — user_observation.
  // A `user_observation` entity is governed by the NATURE of the observation,
  // not by the routing workspace: an INFERENCE (AI-inferred about the user) is
  // always proposed for human validation; an EXPLICIT observation (user-stated,
  // uo_validated === true) auto-approves. This precedes ownership / autoApprove /
  // writesRequireProposal precisely BECAUSE the routing workspace must not change
  // the verdict — an inference must never silently land just because it routed
  // through an agent-owned workspace, and an explicit one must not be forced into
  // a proposal there either. Pure-read actions on the profile are exempt (a
  // `user_observation.read` is just a read). Only fires for write actions.
  if (
    input.subjectProfileSlug === "user_observation" &&
    !isPureReadAction(subjectType, action, eventKey)
  ) {
    return input.subjectUoValidated === true
      ? { verdict: "execute" }
      : {
          verdict: "propose",
          reason: PROPOSE_REASON.USER_OBSERVATION_INFERENCE,
          reasonCode: "USER_OBSERVATION_INFERENCE",
        };
  }

  // 2.7 PER-CAPABILITY GOVERNANCE (capability runs only).
  // Fires ONLY when `capabilityGovernance` is present — i.e. the gate resolved a
  // tool/skill/command RUN. Orthogonal to DATA writes: a plain entity.create
  // carries no `capabilityGovernance`, so this rung no-ops for every data write
  // (the two new fields absent → byte-identical to the prior verdict). Sits after
  // CBAC (rung 1) and ADMIN_ACTIONS (rung 2) — a capability the agent isn't
  // allowed must still deny first, and admin actions are non-negotiable — but
  // BEFORE ownership/autoApprove/writesRequireProposal, because the per-grant
  // exec-mode is the most specific, operator-authored signal about THIS run and
  // must not be silently overridden by the routing workspace.
  if (input.capabilityGovernance) {
    const mode = input.capabilityExecMode ?? input.capabilityGovernance;
    //   "auto"    → execute (operator pre-approved this capability)
    //   "propose" → propose  (reviewable capability.run proposal)
    //   "block"   → deny     (capability present but disabled — reachable only via
    //                         capabilityGovernance; the grant exec-mode is just
    //                         auto|propose, dry-run handled at the gate)
    if (mode === "block") {
      return { verdict: "deny", reason: CAPABILITY_BLOCKED_REASON };
    }
    if (mode !== "auto") {
      return {
        verdict: "propose",
        reason: PROPOSE_REASON.CAPABILITY_PROPOSE,
        reasonCode: "CAPABILITY_PROPOSE",
      };
    }
    // mode === "auto": a per-channel grant (rung 7) can only TIGHTEN, never
    // widen. If this run is inside a channel and the channel resolves stricter
    // (propose/block), the stricter wins — so we do NOT short-circuit to execute
    // here; we fall through to let the channel layer (rung 7) tighten. Only when
    // there is no channel context does an "auto" capability execute outright.
    if (
      input.channelCapabilities === undefined ||
      input.channelCapabilities === null
    ) {
      return { verdict: "execute" };
    }
    const channelDecision = resolveChannelCapabilityDecision(
      input.channelCapabilities
    );
    if (channelDecision === "act") {
      // Channel also permits acting → the capability's "auto" stands.
      return { verdict: "execute" };
    }
    if (channelDecision === "block") {
      return { verdict: "deny", reason: CHANNEL_BLOCK_REASON };
    }
    return {
      verdict: "propose",
      reason: PROPOSE_REASON.CHANNEL_PROPOSE,
      reasonCode: "CHANNEL_PROPOSE",
    };
  }

  // 2.8 GOVERNANCE_RULES store — additive; fires ONLY when the caller resolved
  // a matching rule (`resolveGovernanceRule`, @synap/database — has `db`; this
  // engine stays pure). Sits after every floor (2 ADMIN, 2.1 forcePropose, 2.5
  // DESTRUCTIVE, 2.6 by-kind) and after 2.7 (capability governance), but BEFORE
  // ownership (rung 3) and autoApproveFor (rungs 4/8): a stored rule is a more
  // specific, operator-authored signal than the routing workspace's ownership
  // or blanket whitelist, so it should win over them — but it can never
  // override a floor (all four floors already returned above) and can never
  // deny (the store's verdict enum is auto|propose only, never deny). When no
  // rule matched, `governanceRuleVerdict` is undefined and this rung no-ops,
  // falling through byte-identical to every rung below.
  if (input.governanceRuleVerdict) {
    return input.governanceRuleVerdict === "auto"
      ? { verdict: "execute" }
      : {
          verdict: "propose",
          reason: PROPOSE_REASON.GOVERNANCE_RULE,
          reasonCode: "GOVERNANCE_RULE",
        };
  }

  // 3. Agent owns this workspace (linkedAgentId === agentUserId, workspaceType="agent").
  // Ownership is the cleanest trust signal: the agent's memory workspace is its domain.
  // Non-destructive writes execute directly; destructive still propose.
  if (input.isAgentOwnedWorkspace === true) {
    if (DESTRUCTIVE_ACTIONS.includes(action)) {
      return {
        verdict: "propose",
        reason: PROPOSE_REASON.AGENT_OWNED_DESTRUCTIVE,
        reasonCode: "AGENT_OWNED_DESTRUCTIVE",
      };
    }
    return { verdict: "execute" };
  }

  // 4. Explicit workspace autoApproveFor → execute (overrides writesRequireProposal).
  // Only fires when the workspace has an explicit list (not undefined).
  // DEFAULT_AUTO_APPROVE fallback is checked after writesRequireProposal (step 8).
  if (
    input.autoApproveFor !== undefined &&
    isAutoApproved(eventKey, input.autoApproveFor)
  ) {
    return { verdict: "execute" };
  }

  // 5. writesRequireProposal → propose on non-pure-read writes.
  if (
    input.writesRequireProposal === true &&
    !isPureReadAction(subjectType, action, eventKey)
  ) {
    return {
      verdict: "propose",
      reason: PROPOSE_REASON.WRITES_REQUIRE_PROPOSAL,
      reasonCode: "WRITES_REQUIRE_PROPOSAL",
    };
  }

  // 6. agent-owned workspace mode + destructive → propose.
  // (Distinct from step 3: covers workspaces with governanceMode="agent-owned"
  // where the acting agent is NOT necessarily the owner.)
  if (
    input.governanceMode === "agent-owned" &&
    DESTRUCTIVE_ACTIONS.includes(action)
  ) {
    return {
      verdict: "propose",
      reason: PROPOSE_REASON.AGENT_OWNED_DESTRUCTIVE,
      reasonCode: "AGENT_OWNED_DESTRUCTIVE",
    };
  }

  // 7. Per-channel capability gate (writes only; reads exempt).
  if (
    input.channelCapabilities !== undefined &&
    input.channelCapabilities !== null &&
    !isPureReadAction(subjectType, action, eventKey)
  ) {
    const decision = resolveChannelCapabilityDecision(
      input.channelCapabilities
    );
    if (decision === "block") {
      return { verdict: "deny", reason: CHANNEL_BLOCK_REASON };
    }
    if (decision === "propose") {
      return {
        verdict: "propose",
        reason: PROPOSE_REASON.CHANNEL_PROPOSE,
        reasonCode: "CHANNEL_PROPOSE",
      };
    }
    // decision === "act" → fall through to default autoApproveFor.
  }

  // 8. DEFAULT_AUTO_APPROVE whitelist → execute.
  // Uses DEFAULT_AUTO_APPROVE when input.autoApproveFor is undefined.
  // Explicit list was already checked at step 4.
  if (isAutoApproved(eventKey, input.autoApproveFor)) {
    return { verdict: "execute" };
  }

  // 9. Default → propose (caller supplies its own reasoning).
  return { verdict: "propose" };
}

// ═══════════════════════════════════════════════════════════════════════════
// GOVERNED-WRITE DOOR VOCABULARY
// ═══════════════════════════════════════════════════════════════════════════
/**
 * The `${targetType}/${proposalType}` keys a governed write can file a proposal
 * under. This is the TYPE-LEVEL half of the "every governed write door has an
 * approval half" contract:
 *
 *   • LEFT  (this file)  — the set of keys a proposal can be CREATED under.
 *   • RIGHT (runtime)    — `proposalExecRegistry` + the materializer's action
 *                          guards + the inline `apply-approval.ts` branches.
 *
 * The tripwire `packages/api/src/__tripwires__/governed-writes-have-approval-half.test.ts`
 * asserts LEFT ⊆ RIGHT ∪ ACKNOWLEDGED_GAPS. It reads the RIGHT side LIVE; the
 * LEFT side is these two maps. That is the whole point of putting the
 * vocabulary in the type system: a hand-typed list in the test could only ever
 * find what someone remembered to add.
 *
 * WHY A PAIR-KEYED MAP, and not two unions (`SubjectType` × `Action`):
 * two independent unions accept their full CARTESIAN PRODUCT — with ~45
 * subjects and ~30 actions that is ~1350 accepted combinations for ~90 real
 * doors. `channel/merge` would typecheck perfectly even though the only real
 * door is `channel/merge_branch`, which is exactly the silent miss this
 * contract exists to catch. Only a map keyed on the PAIR pins the pairs that
 * actually exist. The `subjectType`/`action` unions below are DERIVED from the
 * pairs (see {@link GovernedWritePair}) so there is one source, not three.
 *
 * This package is the right home: it has zero Synap dependencies, is already a
 * dependency of `@synap/api`, `@synap/jobs` and `@synap/database` (no new edge,
 * no cycle), and already owns `DEFAULT_AUTO_APPROVE` / `DESTRUCTIVE_ACTIONS`.
 */

/** Which creation door files a proposal under this key. */
export type GovernedWriteCreator =
  /** `checkPermissionOrPropose` (packages/api/src/utils/permission-check.ts). */
  | "gate"
  /** ...and also `checkAutomationWriteOrPropose` (packages/jobs). */
  | "gate+automation"
  /** Filed directly via `insertPendingProposal` / a bespoke proposal insert. */
  | "direct";

/**
 * Doors reachable through the `checkPermissionOrPropose` GATE.
 *
 * `PermissionCheckOpts` is typed as an intersection with the pair union derived
 * from these keys, so a call site CANNOT introduce a new `(subjectType, action)`
 * pair without adding it here — which is what keeps the LEFT side complete
 * without a regex that rots.
 */
export const GATE_WRITE_DOORS = {
  "a2ai/join": "gate",
  "agent/updateCapabilities": "gate",
  "apiKey/create": "gate",
  "apiKey/delete": "gate",
  "apiKey/update": "gate",
  "artifact/create": "gate",
  "artifact/setState": "gate",
  "automation/create": "gate",
  "automation/execute": "gate",
  "bento/arrange": "gate",
  "capability/attach": "gate",
  "capability/create": "gate",
  "capability/renderer.set": "gate",
  "cell/create": "gate",
  "cell/define": "gate",
  "cell/update": "gate",
  "channel/bind": "gate",
  "channel/create_branch": "gate",
  "channel/create_external": "gate",
  "channel/merge_branch": "gate",
  "channel/unbind": "gate",
  "command/execute": "gate",
  "context/link": "gate",
  "document/create": "gate",
  "entity/create": "gate+automation",
  "entity/delete": "gate",
  "entity/renderer.set": "gate",
  "entity/update": "gate+automation",
  "facet/attach": "gate",
  "facet/detach": "gate",
  "facet/update": "gate",
  "focus_session/create": "gate",
  "focus_session/grant_capability": "gate",
  "focus_session/update": "gate+automation",
  "link/create": "gate",
  "playbook/archive": "gate",
  "playbook/create": "gate",
  "playbook/promote": "gate",
  "playbook/run": "gate",
  "playbook/update": "gate",
  "playbook_run/update": "gate",
  "proactive/recap": "gate",
  "profile/create": "gate",
  "profile/renderer.set": "gate",
  "project/create": "gate",
  "project/delete": "gate",
  "project/instantiate_from_playbook": "gate",
  // Session → project. Its OWN door, not `project/create`: the two are
  // materialized by different executors (create takes a name; this takes a
  // sessionId and carries the field mapping, the source rename and the
  // `session --promoted_to--> project` lineage edge), and one proposalType
  // cannot materialize both. Same split `playbook/promote` made off
  // `playbook/create`. RBAC is identical — `requiredPermissionFor` fail-closes
  // an unrecognized verb to "write".
  "project/spawn_from_session": "gate",
  "project/update": "gate",
  "projectMember/create": "gate",
  "property_def/create": "gate",
  "relation/create": "gate",
  "relation/delete": "gate",
  "relation/update": "gate",
  "relation_def/create": "gate",
  // The RULE object (NS1 Rule Loop). A rule is persisted as a `skills` row
  // (see packages/api/src/services/rules), but it is its OWN governed door:
  // approving one materializes the rule row AND its lineage edges to the
  // fact/behaviour halves, which `skill/create` knows nothing about.
  "rule/create": "gate",
  "role/create": "gate",
  "role/delete": "gate",
  "role/update": "gate",
  "skill/create": "gate",
  "skill/delete": "gate",
  "skill/update": "gate",
  "tool/create": "gate",
  "tool/delete": "gate",
  "tool/update": "gate",
  "view/create": "gate",
  "view/update": "gate",
  "whiteboard/place": "gate",
  "widget/register": "gate",
  "workspace/adopt": "gate",
  "workspace/configure_public_projection": "gate",
  "workspace/create": "gate",
  "workspace/declare_source": "gate",
  "workspace/delete": "gate",
  "workspace/update": "gate",
  "workspaceMember/add": "gate",
  "workspaceMember/remove": "gate",
  "workspaceMember/updateRole": "gate",
} as const satisfies Record<string, GovernedWriteCreator>;

/**
 * Doors whose proposals are filed WITHOUT the gate — `insertPendingProposal`
 * directly, or a bespoke insert that stamps `targetType`/`proposalType`.
 *
 * These cannot be type-enforced from the creation side (the inserts live in
 * `@synap/database`, below this package's consumers), so the tripwire's source
 * scan cross-checks them instead: every literal `targetType`/`proposalType`
 * pair it finds must appear in one of these two maps.
 */
export const DIRECT_PROPOSAL_DOORS = {
  "capability/capability.install": "direct",
  "capability/capability.run": "direct",
  "capability/run": "direct",
  "document/user_edit": "direct",
  // Server-side dev loop human gates. Filed directly by
  // `createDevApprovalProposal` (packages/api/src/services/proposals/dev-approval.ts);
  // approved by the executors in `routers/proposals/executors/dev-approval.ts`,
  // which ONLY stamp the session — the agent polling the pod is what acts.
  "focus_session/dev.deploy_approval": "direct",
  // Playbook STAGE gate. Filed by `openStageGate`
  // (packages/api/src/services/playbooks/stage-gate.ts) when a run advances into
  // a stage whose definition carries `gate: { kind: "human" }`; approved by
  // `routers/proposals/executors/playbook-stage-gate.ts`, which only flips the
  // paused session back to active. The SUBJECT is the session — same reasoning
  // as the two dev gates above.
  "focus_session/playbook.stage_gate": "direct",
  "focus_session/dev.plan_approval": "direct",
  "entity/capture.graph": "direct",
  "entity/import.graph": "direct",
  "entity/merge": "direct",
  "governance/governance.advisory": "direct",
  "governance/governance.raise_ceiling": "direct",
  "governance/governance.tighten_lane": "direct",
  "governance/governance.tighten_posture": "direct",
  "governance/governance.widen_lane": "direct",
  "messaging/messaging.external.send": "direct",
  "project/archive": "direct",
  "vault/vault.request": "direct",
  "workspace/join": "direct",
} as const satisfies Record<string, GovernedWriteCreator>;

/** Every governed-write door — the tripwire's LEFT side. */
export const GOVERNED_WRITE_DOORS = {
  ...GATE_WRITE_DOORS,
  ...DIRECT_PROPOSAL_DOORS,
} as const;

/** A door reachable through `checkPermissionOrPropose`. */
export type GateWriteDoor = keyof typeof GATE_WRITE_DOORS;
/** A door whose proposal is filed without the gate. */
export type DirectProposalDoor = keyof typeof DIRECT_PROPOSAL_DOORS;
/** Any `${targetType}/${proposalType}` key a proposal can be filed under. */
export type GovernedWriteDoor = GateWriteDoor | DirectProposalDoor;

/**
 * The gate's `(subjectType, action)` pair, DERIVED from {@link GATE_WRITE_DOORS}
 * so the two can never disagree.
 *
 * `subjectType` also accepts the naive PLURAL (`workspaces` alongside
 * `workspace`): the gate singularizes a trailing `s` before building the
 * proposal key (`permission-check.ts` `singularType`), and several live call
 * sites pass the plural (`routers/workspaces.ts` uses `"workspaces"` while
 * `routers/mcp/handlers/workspace.ts` uses `"workspace"` — both land on
 * `workspace/...`). Accepting both keeps this a zero-edit narrowing instead of
 * a rename wave.
 */
export type GovernedWritePair<K extends GateWriteDoor = GateWriteDoor> =
  K extends `${infer S}/${infer A}`
    ? { subjectType: S | `${S}s`; action: A }
    : never;

/**
 * ── DERIVE THE GATE PAIR FROM THE OPERATIONS ────────────────────────────────
 *
 * MEASURED DEFECT: `routers/capture.ts` called `checkPermissionOrPropose` with
 * HARDCODED `subjectType: "entity", action: "create"` while passing the real
 * work as an opaque `data.operations` composite batch. Every governance floor
 * is a pure function of exactly those two literals — rung 2
 * (`ADMIN_ACTIONS.includes(eventKey)`, strict equality, no globbing), rung 2.5
 * (`DESTRUCTIVE_ACTIONS.includes(action)`), rung 2.6 (by-kind) — so the floors
 * were evaluating a DECLARATION, not the write. It was safe only by
 * coincidence: capture can emit `create_entity` / `create_relation` and nothing
 * else, so `entity`/`create` happened to be true. The instant a producer emits
 * another arm, the gate would still say `entity`/`create` and a floor could
 * never fire on the arm that needed it. A DESTRUCTIVE floor cannot fire on a
 * door that says "create".
 *
 * THE RULE: the gate's `(subjectType, action)` pair is DERIVED from the
 * operations, never declared alongside them. A batch gates at its STRICTEST
 * member. Over-gating is safe; under-gating is the bug — so this never returns
 * a pair less strict than any member of the batch.
 *
 * HONEST LIMIT: one pair cannot fully represent a heterogeneous batch. The
 * per-op evaluation (`captureGraphEventKeys` → `resolveAgentGovernanceDecision`
 * in `@synap/api`) is the finer instrument and stays the all-or-nothing
 * decision for capture graphs. This function exists so the ONE pair the gate
 * does carry is the strictest true one instead of a constant.
 */

/**
 * Composite-op arm → the governed write door that arm actually performs.
 *
 * `satisfies Record<..., GovernedWritePair>` is the enforcement: a pair that is
 * not declared in {@link GATE_WRITE_DOORS} does not compile here, so a new op
 * arm cannot be mapped to a door that governance has never heard of.
 */
export const COMPOSITE_OP_GATE_PAIRS = {
  create_entity: { subjectType: "entity", action: "create" },
  create_relation: { subjectType: "relation", action: "create" },
  create_skill: { subjectType: "skill", action: "create" },
  create_automation: { subjectType: "automation", action: "create" },
  create_rule: { subjectType: "rule", action: "create" },
} as const satisfies Record<string, GovernedWritePair>;

/** The composite operation arms this module knows how to gate. */
export type CompositeOpName = keyof typeof COMPOSITE_OP_GATE_PAIRS;

/**
 * SECONDARY strictness ordering — BLAST RADIUS of the object the arm creates.
 * Explicit and hand-ordered ON PURPOSE (the deliverable forbids an implicit or
 * array-order ordering), and consulted only to break a tie in the PRIMARY,
 * floor-derived rank below.
 *
 * The ordering is config-over-data: a rule, a skill and an automation are
 * CONFIGURATION that changes what agents do in the future (durable, and it
 * compounds — a bad skill mis-steers every later turn), while an entity and a
 * relation are DATA (inspectable, revertible, inert). A rule outranks its own
 * halves because it BINDS them: approving the rule is what makes the fact and
 * the behaviour act together.
 */
const COMPOSITE_OP_BLAST_RADIUS: Record<CompositeOpName, number> = {
  create_rule: 4,
  create_skill: 3,
  create_automation: 2,
  create_entity: 1,
  create_relation: 0,
};

/**
 * PRIMARY strictness rank — derived from the STRUCTURAL floors (admin,
 * destructive), which are absolute and caller-independent.
 *
 * ⚠️ HONEST BOUND, do not overstate it. The third tier reads an auto-approve
 * list, and the caller's EFFECTIVE list may differ from the shipped default.
 * Every composite pair is absent from the shipped default, so they tie there
 * and the winner falls to `COMPOSITE_OP_BLAST_RADIUS` — which is an ordering of
 * consequence, NOT of policy. A caller that legitimately holds the effective
 * list may pass it; a caller that would have to READ it to do so must not
 * (`autoapprovefor-decision-ssot` forbids a second policy reader, and it is
 * right to). For those callers the correct instrument is per-member evaluation
 * through the resolver, not a smarter single pair. Mirrors the rung order
 * in {@link decideAgentPolicy}: admin (rung 2) is stricter than destructive
 * (2.5), which is stricter than "not on the default auto-approve whitelist"
 * (rung 8), which is stricter than a whitelisted write.
 */
function gatePairFloorRank(
  pair: {
    subjectType: string;
    action: string;
  },
  /**
   * The auto-approve list ACTUALLY IN FORCE for this write — the workspace's
   * effective `autoApproveFor`, not the shipped default.
   *
   * WHY THIS IS A PARAMETER. Ranking against the shipped `DEFAULT_AUTO_APPROVE`
   * silently UNDER-GATES, and it is reachable in ordinary configuration. None of
   * the five composite pairs is in the shipped default, so every one collapsed
   * into tier 1 and the winner fell through to `COMPOSITE_OP_BLAST_RADIUS` — an
   * ordering with no relationship to the policy in force. Measured:
   *
   *   ops [create_entity, create_relation], workspace autoApproveFor
   *   widened to ["entity.create"] (the ordinary CRM/capture setup):
   *     derived pair  entity/create   -> execute
   *     member        relation/create -> propose   <-- written ungoverned
   *
   * Rung 2.8 makes it likelier, not rarer: the widen-lane scanner mints
   * PER-ACTION rules, and `entity.create` is exactly the one it mints. Rung 4
   * (`autoApproveFor`) and rung 2.8 both feed the real decision, so a rank that
   * reads only the constant is ranking against a policy nobody is running.
   *
   * Omit it and you get the shipped-default behaviour — correct only when the
   * workspace has not widened anything.
   */
  autoApproveFor: readonly string[] = DEFAULT_AUTO_APPROVE
): number {
  const eventKey = `${pair.subjectType}.${pair.action}`;
  if (ADMIN_ACTIONS.includes(eventKey)) return 3;
  if (DESTRUCTIVE_ACTIONS.includes(pair.action)) return 2;
  // `isAutoApproved` is the SAME predicate rung 8 runs (it wraps
  // `matchesActionPattern`, so `entity.*` and `*.*` behave identically here and
  // there). Re-implementing the glob would be a second matcher that can drift
  // from the rung it exists to mirror.
  if (!isAutoApproved(eventKey, autoApproveFor)) return 1;
  return 0;
}

/**
 * The strictest `(subjectType, action)` pair among a composite batch's ops.
 *
 * FAILS CLOSED, never silently: an empty batch or an unrecognized op arm
 * THROWS. Defaulting to `entity`/`create` here would re-create the exact defect
 * this function exists to remove — a gate declaring a write nobody verified.
 */
export function deriveGatePairFromOperations(
  operations: ReadonlyArray<{ op?: unknown }>,
  /**
   * The workspace's EFFECTIVE auto-approve list. Pass it wherever it is known —
   * without it the rank is computed against the shipped defaults and a widened
   * workspace can under-gate (see `gatePairFloorRank`).
   */
  autoApproveFor: readonly string[] = DEFAULT_AUTO_APPROVE
): GovernedWritePair {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error(
      "deriveGatePairFromOperations: refusing to gate an empty operation batch — " +
        "there is no write to derive a (subjectType, action) pair from."
    );
  }
  let strictest: CompositeOpName | null = null;
  for (const operation of operations) {
    const arm = typeof operation?.op === "string" ? operation.op : undefined;
    if (!arm || !(arm in COMPOSITE_OP_GATE_PAIRS)) {
      throw new Error(
        `deriveGatePairFromOperations: unrecognized composite operation "${String(
          arm
        )}". Map it to a door in COMPOSITE_OP_GATE_PAIRS before it can be gated — ` +
          "gating it as something else would evaluate the floors against a write that never happens."
      );
    }
    const name = arm as CompositeOpName;
    if (strictest === null) {
      strictest = name;
      continue;
    }
    const candidate = gatePairFloorRank(
      COMPOSITE_OP_GATE_PAIRS[name],
      autoApproveFor
    );
    const incumbent = gatePairFloorRank(
      COMPOSITE_OP_GATE_PAIRS[strictest],
      autoApproveFor
    );
    if (
      candidate > incumbent ||
      (candidate === incumbent &&
        COMPOSITE_OP_BLAST_RADIUS[name] > COMPOSITE_OP_BLAST_RADIUS[strictest])
    ) {
      strictest = name;
    }
  }
  // `strictest` is non-null: the empty-batch guard above already returned.
  return COMPOSITE_OP_GATE_PAIRS[strictest as CompositeOpName];
}

/**
 * Executor keys that match on `proposalType` ALONE (no `targetType` segment) —
 * `proposalExecRegistry.resolve()` tries these AFTER the exact composite key and
 * BEFORE the wildcard. They are a real, deliberate second key space, so
 * `ProposalExecutor.key` must accept them alongside the composite doors.
 */
export const PROPOSAL_TYPE_ONLY_EXECUTOR_KEYS = [
  "capability.enable",
  "capability.install",
  "capability.run",
  "messaging.external.send",
  "provider.action",
] as const;

export type ProposalTypeOnlyExecutorKey =
  (typeof PROPOSAL_TYPE_ONLY_EXECUTOR_KEYS)[number];

/**
 * Every key `proposalExecRegistry.register()` accepts: a composite door, a
 * proposalType-only key, or the star-slash-star catch-all. Typing BOTH ends of the
 * contract with the same vocabulary is what turns a typo like `channel/merge`
 * (the real door is `channel/merge_branch`) from a silent runtime miss into a
 * compile error.
 */
export type ProposalExecutorKey =
  GovernedWriteDoor | ProposalTypeOnlyExecutorKey | "*/*";

/**
 * The `${subjectType}.${action}` EVENT KEY a gate call site produces — derived
 * from {@link GATE_WRITE_DOORS}, the same source as {@link GovernedWritePair}.
 *
 * Both the singular and the naive plural spelling are admitted, because both
 * genuinely reach rung 2: `permission-check.ts` composes the event key from the
 * RAW `subjectType` and only singularizes later, when it builds the proposal
 * row. `routers/workspaces.ts` passes `"workspaces"` while
 * `routers/mcp/handlers/workspace.ts` passes `"workspace"` — same door, two
 * event keys, and a floor must name the one the caller actually emits.
 *
 * This is what makes {@link ADMIN_ACTIONS_LIVE} checkable: an entry that names
 * no real door no longer compiles.
 */
export type GateEventKey<K extends GateWriteDoor = GateWriteDoor> =
  K extends `${infer S}/${infer A}` ? `${S}.${A}` | `${S}s.${A}` : never;
