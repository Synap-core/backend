/**
 * W1 — the door fence for SCOPED keys.
 *
 * A grant is enforced on reads by two seams (scopedDb, accessScopeWhere) and on
 * writes by the governed-write gate. The 2026-10-06 inventory found 101
 * key-reachable READ doors that read through neither seam, so a grant would
 * not bound them. Until each is migrated, a key whose grant is not the
 * explicit full-access `*` may only READ through doors known to be seamed;
 * every other read door answers 403 GRANT_DOOR_UNSUPPORTED. Fail closed: a
 * new read door is refused until someone verifies it and lists it here.
 *
 * Writes on Hub REST and MCP pass to the gate, whose rung 0 denies an
 * out-of-grant write. Closed by default (R1, 2 Nov 2026): an MCP tool that is
 * not read-only passes only when `MCP_WRITE_TOOL_DOORS` classifies it, and
 * every served non-GET Hub route is a declared read, names its gate, or sits
 * in a shrink-only baseline (the classification tripwire). The free-form
 * `POST /proposals` passes no gate, so it runs rung 0 itself on an allowlist
 * (`fenced-proposal.ts`, 2026-10-28). On the Bearer tRPC door (S7,
 * 2026-10-20) a mutation passes only when `TRPC_KEY_MUTATION_DOORS` says the
 * gate really bounds it; every other one needs an unbounded `*` key.
 *
 * P2b — an AGGREGATE read door (ask, orient, find, …) cannot narrow its
 * results row by row yet, so it DECLARES the grant subjects it reads
 * (`READS`). A fenced key passes it when one of its scopes reads EVERY
 * declared subject with no narrowing (every kind, every workspace, project
 * and object) — then the grant would remove no row the door returns, so the
 * door is bounded by it exactly. A door read through the seams is `SEAMED`.
 * Every MCP read tool must be classified (`__tripwires__/
 * grant-door-classification.tripwire.test.ts` derives the set from the live
 * tool list); an unclassified one stays refused.
 *
 * Inventory + migration order: the W1 grants design of 2026-10-06 (team pod).
 */

import { isFullAccessGrant, type KeyGrant } from "@synap/database";
import {
  allowedQualifiers,
  patternMatches,
  QUALIFIED_GRANT_SUBJECTS,
  type GrantScope,
} from "@synap/governance-policy/grants";
import {
  WORK_RELEASE_SOURCE_STATES,
  type WorkReleasePart,
} from "@synap-core/types/work-release";

/** How a fenced read door is bounded by a grant. */
export type FencedReadDoor =
  | { readonly bound: "seamed" }
  | { readonly bound: "reads"; readonly subjects: readonly string[] }
  | { readonly bound: "person"; readonly subject: string }
  | {
      readonly bound: "narrowed";
      readonly subject: string;
      readonly full: readonly string[];
      readonly action: string;
      /**
       * Also admit a key that reads every `full` subject unbounded (it gets
       * the whole answer), when the door served such keys before it was
       * narrowed for one that holds `<subject>.<action>` only.
       */
      readonly orReadsFull?: boolean;
    }
  | { readonly bound: "refused"; readonly reason: string };

const SEAMED: FencedReadDoor = { bound: "seamed" };
const READS = (...subjects: string[]): FencedReadDoor => ({
  bound: "reads",
  subjects,
});
/**
 * A door that reads the PERSON's own account-level rows, which no space,
 * project or object holds (which accounts are connected) — so no pin can
 * narrow it, and `READS` (which a pinned key never passes) would refuse every
 * app, whose grant is always pinned to spaces. Bounded when one live scope's
 * permissions grant `<subject>.read`, whatever that scope is pinned to: an app
 * asks for it and the person ticks it like any permission (founder decision
 * 3, 2026-10-26). A deny-all scope grants nothing.
 */
const PERSON = (subject: string): FencedReadDoor => ({
  bound: "person",
  subject,
});
/**
 * A door whose ROUTE narrows its own answer to the key's grant. The row is
 * read through the grant-aware predicate of `subject` (a row the grant does
 * not reach is a 404), and the parts that read `full` are added only when one
 * scope reads every one of them unbounded (`READS(...full)`); otherwise the
 * route says they were withheld, never an empty section. Admitted when one
 * live scope grants `<subject>.<action>` (`read` unless named), pinned or not:
 * an app, whose grant is always pinned to spaces, reads the row the list door
 * already gives it. For a QUALIFIED subject any one qualifier suffices
 * (`capability.publish_post.run` admits a `capability … run` door): the route
 * then checks the qualifier and the space it was asked about.
 */
const NARROWED = (
  subject: string,
  full: readonly string[],
  action = "read",
  opts: { orReadsFull?: boolean } = {}
): FencedReadDoor => ({
  bound: "narrowed",
  subject,
  full,
  action,
  ...(opts.orReadsFull ? { orReadsFull: true } : {}),
});
const REFUSED = (reason: string): FencedReadDoor => ({
  bound: "refused",
  reason,
});

/**
 * The flow read (`flow.of`): Hub `GET /flow` and MCP `synap_get_flow` call the
 * same `readFlowOf`, which narrows a fenced key itself
 * (`readProfileUnderGrant`), so they share this one declaration. Admitted
 * when one live scope grants `entity.<some kind>.read`, as `/lifecycle`.
 */
const FLOW_OF = NARROWED("entity", []);

/**
 * ONE proposal by id: tRPC `proposals.get`, the row on the person's
 * visibility floor (`assertProposalVisibleTo`, no grant clause) with the names
 * of the objects it touches. MCP `synap_get_proposal` and Hub
 * `GET /proposals/:id` call that same procedure, so they share this one
 * declaration: a key that reads a proposal over MCP can also wait on it over
 * REST (`synap proposals await`, `synap app connect`), where it was refused
 * as undeclared (finding 9a415c59).
 */
const PROPOSAL_GET = READS("proposal", "entity");

/**
 * Load an instruction skill: MCP `synap_load_skill` and its REST twins
 * (`GET /agent-skills`, `/agent-skills/by-slug/:slug`, `/agent-skills/:id`,
 * the CLI's `synap skill get|suggest`). Each reads only ACTIVE, APPROVED
 * instruction skills on the person's floor (`visibleSkillsWhere`): system
 * runbooks and the person's own. Skills have no read subject in the read hook,
 * so any key that holds a live permission may load one; one declaration, so
 * REST and MCP answer the same for every key (the CLI's own key was refused
 * `synap skill get` while it could load the same skill over MCP).
 */
const LOAD_SKILL = READS();

/**
 * Recall the person's remembered facts (`knowledge_facts`, owner-pinned):
 * `POST /memory/search` (by embedding) and its full-text twin `GET /memory`
 * (`knowledgeRepository.searchFacts`), which the Raycast extension's recall
 * calls. The same rows, so one declaration.
 */
const MEMORY_RECALL = READS("entity", "preference");

/*
 * MCP read tools whose Hub REST twin calls the SAME reader, so one
 * declaration rules on both doors (as PROPOSAL_GET): a key that may call the
 * tool over MCP may call its route over REST, and no other. The Raycast
 * extension calls the REST twins with its own scoped key, which was refused
 * every one of them while the same key could call the MCP tools.
 */
/** The lens map: MCP `synap_orient` and Hub `GET /orient` both call `discover()`. */
const ORIENT = READS("entity", "project", "session", "proposal", "track");
/** The kinds and roles: both call tRPC `profiles.listProfiles`. */
const LIST_PROFILES = READS("entity");
/** A space's automations: both call tRPC `automations.listAutomations`. */
const LIST_AUTOMATIONS = READS("automation");
/** One thread's context: both call tRPC `context.getThreadContext`. */
const THREAD_CONTEXT = READS("channel", "entity", "document");
/**
 * The person's own personal channel, GET-OR-CREATE: MCP `synap_get_channel`
 * (`channels.ensurePersonal`) and Hub `GET /channels/personal` resolve or
 * create it through the same `resolveOrCreateChannel(…, PERSONAL,
 * orchestrator)`. The door of what it returns: a channel row.
 */
const GET_CHANNEL = READS("channel");

/** Does one live scope grant `<subject>.read`, whatever it is pinned to? */
function grantReadsSubject(grant: KeyGrant, subject: string): boolean {
  return grant.scopes.some((scope) =>
    scope.permissions.some((p) =>
      patternMatches(p, { subject, action: "read" })
    )
  );
}

/**
 * Does one live scope grant `<subject>.<action>`, whatever it is pinned to?
 * For a qualified subject, on at least one qualifier (an intent, a kind).
 */
export function grantHoldsAction(
  grant: KeyGrant,
  subject: string,
  action: string
): boolean {
  const qualified = (QUALIFIED_GRANT_SUBJECTS as readonly string[]).includes(
    subject
  );
  return grant.scopes.some((scope) => {
    if (!qualified)
      return scope.permissions.some((p) =>
        patternMatches(p, { subject, action })
      );
    const allowed = allowedQualifiers(scope, subject, action);
    return allowed === "all" || allowed.length > 0;
  });
}

/** Does ONE scope read `subject` everywhere (every kind, no narrowing)? */
function scopeReadsUnbounded(scope: GrantScope, subject: string): boolean {
  if (scope.workspaceIds || scope.projectIds || scope.entityIds) return false;
  if ((QUALIFIED_GRANT_SUBJECTS as readonly string[]).includes(subject))
    return allowedQualifiers(scope, subject, "read") === "all";
  return scope.permissions.some((p) =>
    patternMatches(p, { subject, action: "read" })
  );
}

/** Is a key bounded on this door by its grant? */
export function grantBoundsDoor(
  door: FencedReadDoor | undefined,
  grant: KeyGrant
): boolean {
  if (!door || door.bound === "refused") return false;
  if (door.bound === "seamed") return true;
  if (door.bound === "person") return grantReadsSubject(grant, door.subject);
  if (door.bound === "narrowed")
    return (
      grantHoldsAction(grant, door.subject, door.action) ||
      (door.orReadsFull === true &&
        door.full.length > 0 &&
        grantBoundsDoor(READS(...door.full), grant))
    );
  // A deny-all scope (`permissions: []`) reads nothing — `every` over a door
  // that declares no subject would otherwise let it through.
  return grant.scopes.some(
    (scope) =>
      scope.permissions.length > 0 &&
      door.subjects.every((s) => scopeReadsUnbounded(scope, s))
  );
}

/**
 * A grant that bounds nothing beyond the human floor needs no fence. ANY limit
 * counts as narrowing — a `*` pinned to a space, project or object is fenced
 * like any scoped key (S1, 2026-10-20; `isFullAccessGrant` sees the pin).
 */
export function isFencedGrant(grant: KeyGrant | null | undefined): boolean {
  return Boolean(grant) && !isFullAccessGrant(grant!);
}

/**
 * May this request's key read a session's HOLDER (`session-holder.ts`) beside
 * the row, when the packet is withheld? The holder names the agent on the
 * session, its computer and whether anything runs it: the person's agent
 * roster, what GET /agent-users serves. Every unfenced caller may; a fenced
 * key when it reads `agent`, bounded as that door (PERSON).
 */
export function sessionHolderReadable(
  grant: KeyGrant | null | undefined
): boolean {
  return !isFencedGrant(grant) || grantBoundsDoor(PERSON("agent"), grant!);
}

/**
 * An id in a REST path: uuid-shaped, so a future static sibling
 * (`/projects/summary`, `/focus-sessions/<word>`) is NOT admitted by a
 * declaration that names an id. Every id below is a uuid; a door whose id is
 * not one names its own pattern (`/users/me`, `/package-updates/<slug>`).
 */
const ID = "[0-9a-fA-F-]{36}";
/** A declared path, `:id` standing for one uuid, an optional trailing `/`. */
const route = (path: string): RegExp =>
  new RegExp(`^${path.replace(/:id/g, ID)}/?$`);

/** Hub REST GET routes that read only through a seam (relative to /api/hub). */
export const GRANT_SAFE_REST_READS: readonly RegExp[] = [
  // Self-introspection: the caller's own identity and key, from the request
  // context — no row a grant bounds. Every key must be able to ask "who am I"
  // (the CLI's agent installers do, right after a device-flow approval).
  /^\/users\/me\/?$/,
  /^\/auth\/status\/?$/,
  // `userId` is the caller's own id or `me` (rest/entities.ts).
  new RegExp(`^/users/(?:me|${ID})/entities/?$`),
  // The list door. Every branch reads through `entities.getEntities` (the
  // seamed `entities.list` floor), and full-text `q` ranks in Typesense, then
  // `search.search` re-reads its hits through that same floor for a fenced
  // grant (`withinGrantSearchHits`, services/retrieval/). `filters` are
  // ANDed inside that floor (only narrow); `includeWorkspace` names only the
  // spaces of the rows returned (entities.filters-space-names.pglite.test.ts).
  /^\/entities\/?$/,
  route("/entities/:id"),
  route("/entities/:id/connections"),
  route("/entities/:id/facets"),
  route("/documents/:id"),
  route("/documents/:id/raw"),
  // A file entity's signed GET: `signFileEntityUrl` → `loadSignableFileEntity`
  // reads the entity through `scopedDb` (grant ANDed), then only the document
  // that entity's OWNER owns — no row beyond the granted entity is reached.
  route("/files/:id/url"),
  /^\/relations\/?$/,
  route("/projects/:id/outputs"),
  /^\/tracks\/?$/,
  route("/tracks/:id"),
  /^\/artifacts\/?$/,
  /^\/commands\/?$/,
  route("/commands/:id"),
  // `listPlaybooksDoor` / `getPlaybookDoor` → `playbooks.listAllPage` /
  // `playbooks.get`: `scopedDb(...).predicate(playbooks)` / `findFirst`
  // (subject `playbook`), and the method's project count reads tracks and
  // projects with their grant clauses (`countProjectsUsingMethods`).
  /^\/playbooks\/?$/,
  route("/playbooks/:id"),
  /^\/brand\/kit\/?$/,
  // Read only through the grant-aware channel / session helpers
  // (utils/channel-visibility.ts, access/session-visibility.ts):
  /^\/channels\/?$/,
  /^\/threads\/?$/,
  route("/threads/:id/messages"),
  route("/threads/:id/branches"),
  /^\/messaging\/channels\/?$/,
  /^\/messaging\/linked-unread\/?$/,
  /^\/focus-sessions\/?$/,
  // What waits on the caller (`listNeedsYouOwed`): focus_sessions floored by
  // `sessionReadableWhere` (owner + the key's grant, `session` subject); an
  // ask's `lookedAt` titles through `scopedDb`; and the display name of each
  // returned session's first roster agent (the `agentIds` the list door above
  // already returns, named).
  /^\/focus-sessions\/owed\/?$/,
  // Read only through ownerPrivateVisibleWhere (grant hook, `project` subject)
  // plus seamed entity reads:
  /^\/projects\/?$/,
  route("/projects/:id"),
  route("/projects/:id/digest"),
  // The caller's own webhook subscriptions: a key lists only those it
  // created (S2) — no row a grant bounds.
  /^\/webhooks\/?$/,
  // Key requests (keys plan Decision 4): the keys THIS caller requested
  // (`key_requests.requester_user_id`) and the templates it may request from
  // (built-ins + the person's own roles) — no row a grant bounds. A computer's
  // key is fenced, and `synap keys list|templates` must still answer.
  /^\/keys\/requested\/?$/,
  /^\/keys\/templates\/?$/,
  /^\/views\/?$/, // hub views.listViews: owner + grantReadPredicate(views)
  /^\/proposals\/?$/, // hub proposals.listProposals: proposalUserFloor (+ grant)
  // The built-in skill packages' SKILL.md files, read from the image's
  // `skills/` folder (`getSkillPackages`): no pod row at all. The CLI's
  // skills installer reads them with the computer's key.
  /^\/skills\/system\/?$/,
];

/**
 * What GET /focus-sessions/:id reads beyond the row: the continuation packet
 * (continuation-packet.ts: proposals, links, sessions, projects, room
 * messages, playbook runs) and the outcomes (session-outputs.ts: artifacts,
 * links, proposals, entities, documents, views, automations, playbooks,
 * tracks, projects). The same projection as MCP `synap_get_session`.
 */
export const SESSION_PACKET_SUBJECTS: readonly string[] = [
  "session",
  "channel",
  "proposal",
  "document",
  "entity",
  "artifact",
  "link",
  "view",
  "automation",
  "playbook",
  "track",
  "project",
];

/** What the package preview reads from the pod (POST /packages/preflight). */
export const PACKAGE_PREFLIGHT_SUBJECTS: readonly string[] = [
  "entity",
  "project",
  "proposal",
];

/**
 * May this request's key read the pod's parts of a package preview (the
 * target space, the kinds it would reuse, the rows an update would change)?
 * Every unfenced caller may; a fenced key only when one scope reads every
 * subject unbounded. Otherwise POST /packages/preflight answers what the
 * package brings and says the rest was withheld.
 */
export function packagePreflightReadable(
  grant: KeyGrant | null | undefined
): boolean {
  return (
    !isFencedGrant(grant) ||
    grantBoundsDoor(READS(...PACKAGE_PREFLIGHT_SUBJECTS), grant!)
  );
}

/**
 * May this request's key read a session's whole packet? Every unfenced
 * caller may (a person, a full-access key); a fenced key only when one scope
 * reads every subject of it unbounded. Otherwise GET /focus-sessions/:id
 * answers the row alone and says the packet was withheld.
 */
export function sessionPacketReadable(
  grant: KeyGrant | null | undefined
): boolean {
  return (
    !isFencedGrant(grant) ||
    grantBoundsDoor(READS(...SESSION_PACKET_SUBJECTS), grant!)
  );
}

/**
 * What `readWorkRelease` (services/dev-loop/work-release.ts) reads: the
 * `dev.repo_snapshot` events, the sessions the PRs belong to, and their
 * liveness (chat turns, events, proposals, room notes).
 */
export const WORK_RELEASE_SUBJECTS: readonly string[] = [
  "event",
  "session",
  "channel",
  "proposal",
];

/** What one key's grant lets the release read draw. */
export interface WorkReleaseReach {
  /**
   * Nothing narrowed: a person, an unfenced key, or a key with one scope
   * that reads every subject unbounded (the door's rule before it was
   * narrowed).
   */
  full: boolean;
  /**
   * The spaces whose snapshots it reads: the pins of every scope that reads
   * `event` on the `dev` family (or every family); `"all"` when one such
   * scope has no space pin, or when `full`. Empty = none (withheld).
   */
  snapshotSpaces: "all" | readonly string[];
  /** The parts it does not reach. Empty when `full`. */
  withheld: readonly WorkReleasePart[];
}

/**
 * Does this scope read the `dev.*` events (the snapshots)? Its `event` read
 * names the `dev` family or every family, and it is pinned to nothing an
 * event row cannot be matched on: an event has a space but no project path
 * and no object id a project or object pin could name.
 */
function scopeReadsDevEvents(scope: GrantScope): boolean {
  if (scope.projectIds || scope.entityIds) return false;
  const families = allowedQualifiers(scope, "event", "read");
  return families === "all" || families.includes("dev");
}

/**
 * THE release read's rule for a key (founder finding 4d14ce47, 2026-10-30).
 * A key that reads every subject unbounded keeps the whole read. Any other
 * key the fence admitted (`NARROWED("event", …)`) reads:
 *  - SNAPSHOTS stamped in the spaces of a scope that reads `dev` events. A
 *    snapshot posted pod-wide (no space) is a personal event, which no pinned
 *    grant reaches, as for every event: the producer stamps a space
 *    (`SNAPSHOT_WORKSPACE_ID`) for that space's apps to read it. A scope
 *    reading `dev` events with no space pin reads every snapshot.
 *  - SESSIONS through their grant clause (`sessionReadableWhere`), when a
 *    scope reads `session`.
 *  - the recorded PR FACTS (`dev.pr_*`, `ci.finished`) only with a scope that
 *    reads every dev event (no space pin): they are recorded anywhere in the
 *    pod, so a pinned key reads each PR as its space's snapshot says.
 *  - never the HOLDERS: "working now" is measured from activity anywhere in
 *    the pod (events, proposals, room turns of the session), which a narrowed
 *    key cannot all see, and a partial measure would read "quiet" while an
 *    agent works. Withheld, never guessed.
 */
export function workReleaseReach(
  grant: KeyGrant | null | undefined
): WorkReleaseReach {
  if (
    !isFencedGrant(grant) ||
    grantBoundsDoor(READS(...WORK_RELEASE_SUBJECTS), grant!)
  ) {
    return { full: true, snapshotSpaces: "all", withheld: [] };
  }
  const snapshotScopes = grant!.scopes.filter(scopeReadsDevEvents);
  const snapshotSpaces = snapshotScopes.some((s) => !s.workspaceIds)
    ? "all"
    : [...new Set(snapshotScopes.flatMap((s) => [...s.workspaceIds!]))];
  // DEFAULT-CLOSED: every part is classified here, and `satisfies` makes a
  // part added to `WORK_RELEASE_SOURCE_STATES` without a line below a BUILD
  // error. A part is withheld unless its predicate says the grant reads it.
  const mayRead = {
    snapshots: () => !(snapshotSpaces !== "all" && snapshotSpaces.length === 0),
    sessions: () => grantReadsSubject(grant!, "session"),
    // Never for a narrowed key (see the rule above).
    holders: () => false,
    // The recorded PR facts are `dev.*` events from anywhere in the pod: read
    // only by a scope that reads every dev event; else the rows stay the
    // snapshot's own.
    pullRequests: () => snapshotSpaces === "all",
  } satisfies Record<WorkReleasePart, () => boolean>;
  // Derived from the parts themselves, so a part with no predicate at runtime
  // (a stale build) is withheld, never served.
  const readable: Partial<Record<WorkReleasePart, () => boolean>> = mayRead;
  const withheld = (
    Object.keys(WORK_RELEASE_SOURCE_STATES) as WorkReleasePart[]
  ).filter((part) => !readable[part]?.());
  return { full: false, snapshotSpaces, withheld };
}

/**
 * Hub REST GET routes that are AGGREGATE reads (P2b): each DECLARES the grant
 * subjects it reads, like `GRANT_REST_POST_READS` and `MCP_READ_TOOL_DOORS`. A
 * fenced key passes when one of its scopes reads EVERY declared subject with
 * no narrowing — then the grant would remove no row the route returns. A key
 * pinned to a space / project / object, or missing one subject, is refused.
 *
 * These are the routes a scoped AGENT key needs to read the session it works
 * on over REST (the CLI's `session get` / `session wait`), as it already can
 * over MCP (`synap_get_session`). Each route stays owner-floored on the key's
 * LINKED HUMAN (`effectiveUserId`): a declaration bounds WHICH subjects a key
 * reads, never WHOSE rows — no agent reads another person's session here.
 *
 * Subjects were read from the code (2026-10-23); completeness is a review
 * question the classification tripwire cannot see.
 */
export const GRANT_REST_GET_READS: ReadonlyArray<
  readonly [RegExp, FencedReadDoor]
> = [
  // Which messaging accounts the person connected (provider, name, status;
  // never a credential — messaging.accounts-read.pglite.test.ts pins the key
  // set). `messaging` is the subject `messaging_accounts` already reads under
  // (grant-read.ts); the send through one is `messaging.send`.
  [/^\/messaging\/accounts\/?$/, PERSON("messaging")],
  // Which agents the person has (id, name, agent type, presence; never a
  // key): an app that hands a run to one of them (`handToAgentId` on
  // POST /playbooks/:id/run) must name it. The person's own roster, which no
  // space holds, so it is a PERSON door: the app asks for `agent.read` and the
  // person ticks it. `agent` is the subject `agent_configs` reads under.
  [/^\/agent-users\/?$/, PERSON("agent")],
  // What is installed on the person's computers (installations, 0409): the
  // person's own rows, which no space holds, read through the access layer's
  // owner floor. Read under `installation`, the subject a grant names.
  [/^\/installations\/?$/, PERSON("installation")],
  // Which of those agents the person assigned to one target (a playbook, a
  // kind, a project, a space): the person's own `assigned_to` row on a target
  // they can see (`readAgentAssignment`), the read half of
  // PUT /agent-users/:id/assignment. Same subject, same PERSON door.
  [/^\/agent-users\/assignments\/?$/, PERSON("agent")],
  // One host job's log (`rest/host-jobs.ts`), the log a computer sent on
  // request: the person's own job of an installation on one of their
  // computers, which no space holds, read through the owner floor. Read under
  // `installation`, the subject `host_jobs` reads under (grant-read.ts).
  [/^\/host-jobs\/[^/]+\/logs\/?$/, PERSON("installation")],
  // Who runs a playbook for the person (`playbooks.runChoice`, slice 5a): the
  // playbook through `scopedDb` (its own grant ANDed, `playbook`), plus the
  // person's remembered choice (their `assigned_to` row) and their agents
  // with each one's wake mark — the roster GET /agent-users serves. Same
  // subject, same PERSON door: an app that asks "who runs this" before a
  // run asks for `agent.read`.
  [route("/playbooks/:id/run-choice"), PERSON("agent")],
  // The person's spaces with their template health (`synap market update`,
  // `market installed`, `orient`): the spaces the person can open, each one's
  // live entity count and the pod-wide count (entities, through
  // `readWorkspaceEntityStats`), the projects using it
  // (`listProjectsUsingWorkspaces`) and where its last template apply stands,
  // with the proposals it waits on (`templateStepsByWorkspace`). The same
  // rule as MCP `synap_list_workspaces`, plus `proposal` for the steps. A
  // space carries no grant subject of its own, so the route cannot narrow
  // its list to a pin: a key pinned to a space, project or object stays
  // refused (finding de33a075: a computer's key, unpinned, was refused).
  [/^\/workspaces\/?$/, READS("entity", "project", "proposal")],
  // What is installed, every kind (`installed.ts`): the spaces' template
  // state and steps (proposals), capabilities (subject `tool`, as MCP
  // `synap_list_capabilities`), views, skills, automations and cells
  // (`widget`), in the person's spaces and pod-wide. `?drift=true` adds the
  // write-free reconcile preview, which reads the same views, skills and
  // automations.
  [
    /^\/installed\/?$/,
    READS("proposal", "tool", "view", "skill", "automation", "widget"),
  ],
  // The one verdict of "this installed package has an update"
  // (`services/package-updates/`, `synap market update`, pod admin's
  // Updates): the spaces' template state (read under `proposal`, as
  // `/installed`), capability containers (`tool`), and the source-linked
  // views, skills and automations; `/:slug` plans one of them over the same
  // rows. Without it a computer's key (finding de33a075) could not run
  // `synap market update`, which reads this list.
  [
    /^\/package-updates\/?$/,
    READS("proposal", "tool", "view", "skill", "automation"),
  ],
  [
    /^\/package-updates\/[^/]+\/?$/,
    READS("proposal", "tool", "view", "skill", "automation"),
  ],
  // The session row, narrowed by the route (`sessionPacketReadable`): the
  // packet is added only for a key that reads all of it.
  [route("/focus-sessions/:id"), NARROWED("session", SESSION_PACKET_SUBJECTS)],
  // The row + its `session_evaluations` (subject `session`, grant-read.ts).
  [route("/focus-sessions/:id/evaluations"), READS("session")],
  // `listSessionAnswers`: the row (sessionReadableWhere) + the room's messages.
  [route("/focus-sessions/:id/answers"), READS("session", "channel")],
  // `waitForSessionAnswers` / `listSessionChanges`: answers + room messages +
  // proposals filed under the session (`proposal_decided`), the dev facts of
  // its PRs and jobs (`pr_*`, `checks_finished`: events) and the ends of the
  // sessions it waits on (`blocker_ended`: its `blocked_by` links).
  [
    route("/focus-sessions/:id/answers/wait"),
    READS("session", "channel", "proposal", "event", "link"),
  ],
  // `readSessionDocument`: the row, the designating artifact, the document.
  [
    route("/focus-sessions/:id/document"),
    READS("session", "artifact", "document"),
  ],
  // `buildWorkGraph` (work-graph.ts): session rows (sessionListConditions),
  // links (blocked_by, spawned_from, targets/produced), the next move's reads
  // (proposals, room inboxes, cross-kind blockers on entities and tracks),
  // liveness (chat turns, events, proposals) and the derived interactions
  // (events, automation runs). Same projection as MCP `synap_get_work_graph`.
  [
    /^\/focus-sessions\/graph\/?$/,
    READS(
      "session",
      "link",
      "proposal",
      "channel",
      "event",
      "automation",
      "entity",
      "track"
    ),
  ],
  // Intent actions (decision 3A, 2026-10-28): which of the person's tools can
  // do ONE intent, for a key holding `capability.<intent>.run`. The route
  // narrows itself (`capabilities-intent.ts`): `intent` and `workspaceId`
  // are required, the grant must permit that intent in that space, and only
  // that intent's actions come back, each with the intent's input — never a
  // verb's raw parameters. The labels are the pod's own.
  [/^\/capabilities\/actions\/?$/, NARROWED("capability", [], "run")],
  // A kind's or role's DECLARED stages (`lifecycle.get`): the profile's
  // lifecycle (key, label, category, tone, humanOnly), definition data with no
  // entity row. The route narrows itself: a fenced key must name `workspaceId`
  // and hold `entity.<profileSlug>.read` (`facet.read` for a role) there, so an app reads the stages of
  // the kinds it may already read, never another kind's. Admitted when one live
  // scope grants `entity.<some kind>.read`.
  [/^\/lifecycle\/?$/, NARROWED("entity", [])],
  // THE FLOW READ (`readFlowOf`, services/lifecycle/flow-read.ts): a kind's
  // or role's states, the stages owning them, its things by state and the
  // flows working it. The read narrows itself through the SAME check as
  // `/lifecycle` (`readProfileUnderGrant`): a fenced key names `workspaceId`
  // and holds `entity.<profileSlug>.read` (`facet.read` for a role) there.
  // Its rows go through the seams (things: `accessScopeWhere`; flows and
  // runs: `scopedDb`, subject `playbook`); flows without `playbook.read`
  // and the workers (no seam) come back `withheld`. Same as MCP `synap_get_flow`.
  [/^\/flow\/?$/, FLOW_OF],
  // `readWorkRelease` (services/dev-loop/work-release.ts), narrowed by the
  // read itself (`workReleaseReach`): a key reading every subject unbounded
  // gets it whole; one pinned to spaces gets the snapshots and sessions its
  // grant reaches and the rest said withheld. Admitted when one scope reads
  // some `event` family. Same as MCP `synap_get_work_release`.
  [/^\/work-release\/?$/, NARROWED("event", WORK_RELEASE_SUBJECTS)],
  // `readTimeline` (services/timeline/read-timeline.ts): a goal's history (the
  // track, its sessions, their proposals and evaluations), a session's
  // transition log, dev facts and proposals, or a PR's dev facts. Same as MCP
  // `synap_get_timeline`.
  [/^\/timeline\/?$/, READS("track", "session", "event", "proposal")],
  // One proposal: the same door as MCP `synap_get_proposal` (PROPOSAL_GET).
  [route("/proposals/:id"), PROPOSAL_GET],
  // The capability catalog of one space (`synap connect <tool>`, `synap
  // capability`; finding 3122ba42): `buildCapabilityCatalog` reads the
  // capability containers (subject `tool`, as `/installed`), their
  // `member_of` links, the member tools and skills, and the connection state
  // of each card: which of the person's own (or pod-wide) vault credentials a
  // container names exists, its name and service, and whether it needs
  // reauth — never a secret's value; `buildAutomationCatalog` reads the
  // space's automations. Every read is on the person's floor
  // (`userVisibleWhere`), none through a grant clause, so a pinned key is
  // refused.
  [
    /^\/capabilities\/catalog\/?$/,
    READS("tool", "skill", "link", "automation"),
  ],
  // Runtime discovery (finding cce86e6b: Raycast's Search Synap, agents'
  // session bootstrap): the kinds and roles with their property schemas
  // (`profiles.listProfiles`), the relation types of the lens
  // (`listEffectiveRelationTypes`) and each kind's usage, counted over its
  // entities (`loadProfileFill`). The same rule as MCP `synap_list_profiles`,
  // plus the relation vocabulary.
  [/^\/discover\/?$/, READS("entity", "relation_def")],
  // Full-text recall of remembered facts: the twin of POST /memory/search.
  // GET only: every other /memory route is an owner-wide write
  // (GRANT_OWNER_WIDE_REST_WRITES).
  [/^\/memory\/?$/, MEMORY_RECALL],
  // Load a skill over REST: the same door as MCP `synap_load_skill`.
  [/^\/agent-skills\/?$/, LOAD_SKILL],
  // A slug may hold `/`; the client encodes it (`%2F`), and the fence sees
  // the path undecoded (`decodeURI` leaves `%2F`), so one segment.
  [/^\/agent-skills\/by-slug\/[^/]+\/?$/, LOAD_SKILL],
  [route("/agent-skills/:id"), LOAD_SKILL],
  // The pod's stored cell sources (finding 7da9c21f): `GET /cells` reads the
  // active frame / iframe `widget_definitions` of one space (person's
  // membership checked) and pod-wide; `GET /widget-definitions` the built-in
  // catalog plus the installed rows (`listRenderables`). Subject `widget`,
  // read on no grant clause, so a pinned key is refused.
  [/^\/cells\/?$/, READS("widget")],
  [/^\/widget-definitions\/?$/, READS("widget")],
  // Poll a bulk import (`rest/import-units.ts`): the pg-boss job the caller
  // enqueued, its state and per-unit outcome (`entityId` | `proposalId` |
  // `error`), never the payload; another person's job is the same 404 as a
  // missing one. Admitted to the keys that can enqueue one, which
  // POST /import/enqueue-units checks as `entity.<kind>.create`: a key that
  // could not start an import has nothing to poll.
  [route("/import/units-job/:id"), NARROWED("entity", [], "create")],
  // Server faults (0392, `services/server-faults/read.ts`): the exact cause of
  // every 5xx on the pod, whoever met it. Pod owner or admin only, like
  // `/usage`; no grant can narrow it, so a scoped key is refused.
  // A computer's waker poll (`rest/computer-wakes.ts`). The computer's own
  // device-flow key IS a scoped key: `machine-connect.ts` mints it as a
  // `user_pat` carrying the "AI — read & propose" grant
  // (`aiDefaultCapabilities()`), so refusing the door here refused every real
  // computer. The ROUTE admits only that caller: a computer principal
  // (`agentType` machine) of its own person, holding `hub-protocol.read`, on
  // a device session that is not stale (`refuseStaleDeviceSession`). Any
  // other key (a person's, an agent's, an app's) is refused there before a
  // row is read, so no grant makes a key a computer's waker.
  [/^\/computers\/me\/wakes\/?$/, SEAMED],
  [
    /^\/errors\/[^/]+\/?$/,
    REFUSED("Pod internals: the cause of every server error on the pod."),
  ],
  // A person's channels (`listPersonChannels`, services/channels/
  // person-channels.ts): the record through `entityReadVisibleWhere`, its
  // channels through `channelVisibilityWhere` (a channel follows its person,
  // grant-read.ts), their last messages through the one history door, the
  // pending proposed-message counts through `proposalUserFloor`: each read
  // carries the key's grant, so the answer is what the grant reaches. An app
  // asks for `channel.read` (consent for the person's DMs), so a key without
  // it is refused here rather than told "no conversation".
  [/^\/entities\/[0-9a-fA-F-]{36}\/channels\/?$/, NARROWED("channel", [])],
  // A channel's proposed messages (`listProposedMessages`): the channel under
  // `channelVisibilityWhere` (404 when the grant does not reach it), the
  // pending send proposals under `proposalUserFloor`. Admitted for a key
  // holding `proposal.read`; the channel check asks `channel.read` too.
  [
    /^\/channels\/[0-9a-fA-F-]{36}\/proposed-messages\/?$/,
    NARROWED("proposal", []),
  ],
  // A space's conversations (`listSpaceConversations`, services/channels/
  // space-conversations.ts, CRM Messages contract A): the people through
  // `entityReadVisibleWhere` + `roleInWorkspaceLensWhere`, their channels
  // through `channelVisibilityWhere`, their drafts through
  // `proposalUserFloor`, each carrying the key's grant (a key without
  // `proposal.read` sees no drafts). Admitted for `channel.read`; the route
  // then requires it in the space asked about.
  [/^\/channels\/conversations\/?$/, NARROWED("channel", [])],
  // The REST twins of MCP read tools, one declaration each (see ORIENT):
  [/^\/orient\/?$/, ORIENT],
  [/^\/profiles\/?$/, LIST_PROFILES],
  [/^\/automations\/?$/, LIST_AUTOMATIONS],
  [route("/threads/:id/context"), THREAD_CONTEXT],
  [/^\/channels\/personal\/?$/, GET_CHANNEL],
];

/**
 * Hub REST POST routes that READ. Every other POST is a write, bounded by the
 * gate; the classification tripwire (`grant-door-classification`) checks that
 * each served non-GET route is a declared read, names its write gate, or sits
 * in its shrink-only baseline. Matched in order; the first match classifies
 * the route.
 */
export const GRANT_REST_POST_READS: ReadonlyArray<
  readonly [RegExp, FencedReadDoor]
> = [
  // POST /chat/stream (an app's chat turn). It is not a read: it reserves a
  // chat turn and runs the IS turn, whose hub calls are bounded by the
  // turn's own grant (the `app_grant` claim, `hub-protocol/_middleware/auth.ts`).
  // The route itself checks `chat.stream` in the workspace the turn runs in
  // (`permits`, rest/chat.ts), so it is NARROWED on that gate verb, not READS.
  [/^\/chat\/stream\/?$/, NARROWED("chat", [], "stream")],
  [
    /^\/knowledge\/(search|ask|answer)\/?$/,
    READS(
      "entity",
      "document",
      "relation",
      "proposal",
      "preference",
      "project"
    ),
  ],
  [/^\/entities\/retrieve\/?$/, READS("entity", "document", "relation")],
  // `hybridRecall` ranks ids, then the rows are read under
  // `ownerPrivateVisibleWhere`, which ANDs the key's grant (`grantReadClauseFor`):
  // only rows the grant reads come back.
  [/^\/entities\/recall\/?$/, SEAMED],
  // `resolveIdentity` reads candidates under `accessScopeWhere` (the grant
  // seam), as MCP `synap_resolve_identity` (SEAMED) does.
  [/^\/identity\/resolve\/?$/, SEAMED],
  // No pod row: the static routing rules, the text sent classified, the tabs
  // sent clustered by the intelligence service.
  [/^\/routing\/resolve\/?$/, SEAMED],
  [/^\/rules\/classify\/?$/, SEAMED],
  [/^\/capture\/cluster-tabs\/?$/, SEAMED],
  // Writes nothing: reads one file entity through `scopedDb` (grant ANDed,
  // `readableFileEntity`) and that entity's owner-locked document, then calls
  // the transcription provider (rate class `ai_interactive`).
  [route("/files/:id/transcribe"), SEAMED],
  [/^\/memory\/search\/?$/, MEMORY_RECALL],
  // A read (no `install`) and a governed install (TEMPLATE-LIFECYCLE B). The
  // standing names a space only when the person's floor AND the key's grant
  // reach it (`readTemplateStanding`); a holder it hides is answered as absent
  // and never installed over (fence1).
  [/^\/workspaces\/ensure-template\/?$/, SEAMED],
  // The write-free preview of `/packages/apply` (finding 634bbbfc): the target
  // space and its template state (`resolvePreflightComposeTarget`,
  // `previewTemplateApply`: proposals), the pod's kinds, and the rows an update
  // would change (`pendingTemplateDataChanges`, every entity of the package's
  // kinds, read with no floor). No pin narrows those, so a key gets them only
  // when it reads them unbounded (`packagePreflightReadable`). A key that may
  // ask to install (`package.install`, an app: its grant is always pinned) is
  // admitted too and gets what the package itself brings, the pod's parts
  // said withheld (L7 "Add to my pod").
  [
    /^\/packages\/preflight\/?$/,
    NARROWED("package", PACKAGE_PREFLIGHT_SUBJECTS, "install", {
      orReadsFull: true,
    }),
  ],
  // "Recall again" (`recallSessionAgain`): runs the session's recall as its
  // OWNER, pod-wide (`retrieve()`, the engine behind `synap_ask`), and writes
  // what it found into the session and its room, which the key then reads. So
  // the key must read the session, its room and every subject recall reads,
  // unnarrowed.
  [
    route("/focus-sessions/:id/recall"),
    READS(
      "session",
      "channel",
      "entity",
      "document",
      "relation",
      "proposal",
      "preference",
      "project"
    ),
  ],
  // Writes nothing (a dry run), but a code skill runs as the PERSON
  // (`runSkill`), its reads bounded by no grant; the skill row itself is read
  // on the person's floor (`visibleSkillsAnyWorkspaceWhere`).
  [
    route("/skills/:id/dry-run"),
    REFUSED("Runs the skill as you: what it reads is not bounded by a grant."),
  ],
  [/^\/diagnose\/?$/, REFUSED("Pod internals across every subject.")],
  // Writes no person's row and returns none: it re-reads the public official
  // catalog into the pod's mirror (`cp_catalog_cache`), the run the 10-min
  // schedule makes anyway, single-flight with a 20 s floor. Pod admins only
  // (the route checks `assertPodAdmin`).
  [/^\/catalog\/refresh\/?$/, SEAMED],
  // Runs a capability. A key the fence bounds may only run an INTENT action
  // (decision 3A, 2026-10-28): the route refuses any other body for it, checks
  // `capability.<intent>.run` on the verb's own intent in the named space, and
  // an app's outward run always files a proposal (the capability gate). So it
  // is admitted only for a key holding some `capability … run`.
  [/^\/capabilities\/execute\/?$/, NARROWED("capability", [], "run")],
  // Measure one person's LinkedIn reach (`readLinkedinReach`, services/
  // channels/linkedin-reach-read.ts, finding 491ba787). It writes, but only
  // machine-written system facts no editor or agent writes (the reach fact,
  // an empty `linkedinProviderId`, the `linkedin:<id>` identity signal), from
  // one provider read: the daily sweep's writes, for one person, now. The
  // person is read through `entityReadVisibleWhere` (the key's grant ANDed;
  // a person it does not reach is a 404) and must be the caller's own; the
  // read spends the owner's LinkedIn lookup budget. Admitted for a key
  // holding `channel.read` (the person's messaging consent, as the
  // conversations door that shows reach).
  [route("/channels/linkedin-reach/:id"), NARROWED("channel", [])],
];

/**
 * Every MCP READ tool (`readOnlyHint: true`), classified. The tripwire derives
 * the live read-tool set and fails on an unclassified or stale entry.
 */
export const MCP_READ_TOOL_DOORS: Readonly<Record<string, FencedReadDoor>> = {
  synap_get_entities: SEAMED,
  synap_get_document: SEAMED,
  synap_get_relations: SEAMED,
  synap_list_tracks: SEAMED,
  synap_resolve_identity: SEAMED,
  synap_get_project: SEAMED,
  synap_list_projects: SEAMED,
  synap_list_views: SEAMED,
  // Same door as `GET /flow` (FLOW_OF): the read narrows itself.
  synap_get_flow: FLOW_OF,
  // Aggregate doors: the subjects they read.
  synap_ask: READS(
    "entity",
    "document",
    "relation",
    "proposal",
    "preference",
    "project"
  ),
  synap_orient: ORIENT,
  synap_find: READS("tool", "command", "playbook", "automation"),
  synap_get_entity: READS("entity", "relation", "facet", "document"),
  synap_get_graph: READS(
    "entity",
    "relation",
    "link",
    "document",
    "session",
    "project"
  ),
  synap_list_profiles: LIST_PROFILES,
  synap_list_workspaces: READS("entity", "project"),
  synap_get_thread_context: THREAD_CONTEXT,
  synap_list_proposals: READS("proposal", "entity"),
  synap_get_proposal: PROPOSAL_GET,
  synap_list_sessions: READS("session", "project"),
  synap_needs_you: READS("session", "proposal", "channel", "entity"),
  // Same subjects as `GET /focus-sessions/graph` (GRANT_REST_GET_READS).
  synap_get_work_graph: READS(
    "session",
    "link",
    "proposal",
    "channel",
    "event",
    "automation",
    "entity",
    "track"
  ),
  synap_get_session: READS(
    "session",
    "channel",
    "proposal",
    "document",
    "entity"
  ),
  synap_revert_session: READS("session", "proposal"),
  synap_list_playbooks: READS("playbook"),
  synap_match_playbooks: READS("playbook"),
  synap_list_capabilities: READS("tool", "command", "playbook", "automation"),
  // What is installed on the person's computers (`listInstallations`, the
  // owner floor), as `GET /installations`.
  synap_list_installations: PERSON("installation"),
  synap_list_automations: LIST_AUTOMATIONS,
  // A goal's workers (`listWorkerViews`): the goal, its playbooks, the
  // worker rules and their automation runs, and the approvals they wait on.
  synap_list_workers: READS("track", "playbook", "automation", "proposal"),
  synap_list_widgets: READS("widget", "view"),
  synap_template_health: READS("tool", "playbook", "automation", "view"),
  synap_governance: READS("proposal", "agent", "tool"),
  // The roster of agents (+ their computers and dispatch tool) for hand-off.
  synap_list_agents: READS("agent", "tool"),
  // Same door as `GET /work-release` (GRANT_REST_GET_READS): the read
  // narrows itself (`workReleaseReach`).
  synap_get_work_release: NARROWED("event", WORK_RELEASE_SUBJECTS),
  // Same subjects as `GET /timeline` (GRANT_REST_GET_READS).
  synap_get_timeline: READS("track", "session", "event", "proposal"),
  synap_export_project_pack: READS(
    "project",
    "entity",
    "document",
    "relation",
    "playbook",
    "view",
    "track"
  ),
  // Skills have no read subject in the read hook (system + the person's own
  // runbooks): any key that holds a live permission may load one (LOAD_SKILL).
  synap_load_skill: LOAD_SKILL,
  synap_diagnose: REFUSED("Pod internals across every subject."),
};

/** How a non-read-only MCP tool is bounded for a fenced key. */
export type McpWriteToolDoor = { readonly bound: "write" } | FencedReadDoor;
/** A write: it reaches the governed-write gate, whose rung 0 bounds it. */
const WRITE: McpWriteToolDoor = { bound: "write" };

/**
 * Every MCP tool that is NOT read-only, classified (R1, 2 Nov 2026): a WRITE
 * (bounded by the gate) or, when it returns rows, the read door of what it
 * returns, checked like a read tool's. A tool in neither map is refused to a
 * fenced key (`mcpToolAllowed`, closed by default), and the classification
 * tripwire derives the live tool list and fails on an unclassified or stale
 * entry. That a WRITE tool reaches a gate is not checked here.
 */
export const MCP_WRITE_TOOL_DOORS: Readonly<Record<string, McpWriteToolDoor>> =
  {
    synap_create_entity: WRITE,
    synap_update_entity: WRITE,
    synap_update_entities: WRITE,
    synap_delete_entity: WRITE,
    synap_create_document: WRITE,
    synap_update_document: WRITE,
    synap_request_upload: WRITE,
    synap_store_file: WRITE,
    synap_remember_fact: WRITE,
    synap_link_entities: WRITE,
    synap_attach_facet: WRITE,
    synap_detach_facet: WRITE,
    synap_update_facet: WRITE,
    synap_define_role: WRITE,
    synap_define_kind: WRITE,
    synap_start_session: WRITE,
    synap_update_session: WRITE,
    synap_evaluate_session: WRITE,
    synap_complete_session: WRITE,
    synap_rerun_session: WRITE,
    // Not read-only only because an agent's read stamps the "Picked up"
    // receipt: it RETURNS the person's answers and the session's changes. The
    // same door as its REST twin, GET /focus-sessions/:id/answers/wait
    // (`waitForSessionAnswers` / `waitForSessionChanges`).
    synap_wait_for_answer: READS(
      "session",
      "channel",
      "proposal",
      "event",
      "link"
    ),
    synap_relay_answer: WRITE,
    synap_ask_person: WRITE,
    synap_create_cell: WRITE,
    synap_promote_cell_to_renderer: WRITE,
    synap_promote_session_to_playbook: WRITE,
    synap_create_playbook: WRITE,
    synap_update_playbook: WRITE,
    synap_set_workspace_focus: WRITE,
    synap_set_project_focus: WRITE,
    synap_organize_library: WRITE,
    synap_capture: WRITE,
    synap_create_workspace: WRITE,
    synap_declare_workspace_source: WRITE,
    synap_create_project: WRITE,
    synap_start_track: WRITE,
    synap_start_stage_session: WRITE,
    synap_advance_track: WRITE,
    synap_set_track_status: WRITE,
    synap_reopen_track: WRITE,
    synap_convert_to_goal: WRITE,
    synap_enable_worker: WRITE,
    synap_pause_worker: WRITE,
    synap_run_worker: WRITE,
    synap_set_track_participant: WRITE,
    synap_set_track_params: WRITE,
    synap_update_track: WRITE,
    synap_add_track_stage: WRITE,
    synap_update_project: WRITE,
    synap_project_use_workspace: WRITE,
    synap_file_into_project: WRITE,
    synap_archive_workspace: WRITE,
    synap_retire_workspace: WRITE,
    synap_update_workspace: WRITE,
    synap_update_space_brief: WRITE,
    synap_move_entities: WRITE,
    synap_retire_field: WRITE,
    synap_grant_profile_access: WRITE,
    synap_change_kind_scope: WRITE,
    // Always files a profile/declare_lifecycle proposal and returns its receipt,
    // never rows (backend#689).
    synap_declare_lifecycle: WRITE,
    synap_create_view: WRITE,
    synap_update_view_content: WRITE,
    // Get-OR-create: it RETURNS a channel row, the person's personal channel
    // (tRPC `channels.ensurePersonal`, owner-wide) or one bound to an object
    // (`channels.resolveOrCreateChannel`). The door of what it reads.
    synap_get_channel: GET_CHANNEL,
    synap_post_message: WRITE,
    synap_revise_proposal: WRITE,
    synap_reject_proposal: WRITE,
    synap_request_deploy_approval: WRITE,
    synap_run_capability: WRITE,
    synap_create_verb: WRITE,
    synap_trigger_automation: WRITE,
    synap_create_automation: WRITE,
    synap_create_rule: WRITE,
    synap_update_rule: WRITE,
    synap_run_playbook: WRITE,
    synap_create_skill: WRITE,
    synap_update_skill: WRITE,
  };

/** tRPC QUERIES (by procedure path) that read only through a seam. */
export const GRANT_SAFE_TRPC_QUERIES: ReadonlySet<string> = new Set([
  "entities.getEntities",
  "documents.getDocument",
  "relations.listRelations",
  "relations.listRelationsPodWide",
  "automations.listRuns",
  "automations.getRun",
  "commands.listCommands",
  "commands.getCommand",
  "views.listViews",
  "proposals.listProposals",
]);

export const GRANT_DOOR_UNSUPPORTED =
  "This door does not support scoped keys yet: its reads are not bounded by a grant. Use a door listed in the API keys guide, or a key with the full-access '*' grant.";

/**
 * Hub REST doors (every method, relative to /api/hub) whose EFFECT spans the
 * whole owner and that no grant can narrow — so neither the fence's "writes
 * are bounded by the gate" rule nor a workspace/project/object pin applies.
 *
 *  - `/webhooks/:id/<anything>` (the delivery log): read by owner only
 *    (tRPC `deliveries`), not by the subscription's key. `/webhooks` and
 *    `/webhooks/:id` themselves are NOT owner-wide since S2/D7 (2026-10-20):
 *    a key's subscription is bound to that key (it lists / deletes only its
 *    own, `rest/webhooks.ts`) and delivers only what the key's grant reads
 *    while the key lives (`utils/webhook-delivery.ts`, jobs
 *    `webhook-worker.ts`). Creating one still needs `hub-protocol.write`.
 *  - `/calendar/feed` (+ `/rotate`): mints a bearer URL whose `.ics` read
 *    carries NO key and so no grant — it serves every calendar entity the
 *    person can read (`calendar-feed.ts` `loadOwnedCalendarEntities`), every
 *    workspace. The credentialless `/calendar/feed/<token>.ics` read is not
 *    matched (it skips auth; no grant reaches it).
 *  - `/agents/sync`: rewrites the pod's agent roster for an intelligence
 *    service and creates agent users owned by the pod owner — direct writes,
 *    no gate. Its caller is the IS's `is_internal` key (full, unbounded `*`).
 *
 * Only a key whose grant is UNBOUNDED full access (`*`, no narrowing) may use
 * them — exactly the keys `isFencedGrant` does not fence (S1: a pinned `*` is
 * fenced, so it is refused here too).
 */
export const GRANT_OWNER_WIDE_REST_DOORS: readonly RegExp[] = [
  /^\/webhooks\/[^/]+\/.+$/,
  /^\/calendar\/feed(?:\/rotate)?\/?$/,
  /^\/agents\/sync\/?$/,
];

/**
 * Owner-wide WRITES (non-GET/HEAD only — the same paths carry reads the generic
 * fence already rules on). Each handler writes directly, never passes the
 * gate, and its effect is not narrowed by any grant (lane/sec-w3, 2026-10-19):
 *
 *  - `/capabilities/:id/credentials[/:id]` POST/PATCH/DELETE: the credential
 *    row is the owner's for EVERY workspace (`workspaceId: null`); a pod-wide
 *    one needs pod admin but no grant check.
 *  - `DELETE /vault/secrets/:id`: any secret the person can write, in any
 *    workspace (`assertWorkspaceWrite`, no grant). `POST /vault/secrets` is
 *    NOT here — agents store credentials they hold, bounded by the key's
 *    grant (`secret.create` in the row's workspace, S4; the AI preset holds
 *    it). `/vault/secrets/:id/grant` is gated (`checkPermissionOrPropose` →
 *    `grantWriteDenial`).
 *  - `DELETE /connectors/connections/:id`, `POST /connectors/disconnect`:
 *    revokes the account at the provider and detaches it from every
 *    capability (`detachNangoConnectionRegistry`).
 *  - `POST /connectors/connect`, `POST /connectors/session` (2026-10-26, task
 *    d890410b): start an OAuth session that connects an account to the
 *    PERSON, usable in every space; `onBehalfOfUserId` binds it to another
 *    member.
 *  - `DELETE /messaging/accounts/:id` (disconnects the person's messaging
 *    account at the provider; since 2026-11-04 it also passes the gate,
 *    `messaging/delete_account`, so an unbounded agent key's call is a
 *    proposal), `POST /messaging/accounts/sync` (rewrites the person's
 *    account mirror, registers provider webhooks). The send through
 *    an account is NOT here: it checks `messaging.send` in the conversation's
 *    space (`sendExternalMessage`). Neither is `POST
 *    /messaging/accounts/:id/import-history` (founder, 2026-11-03): its
 *    handler names the gate (`messaging/import_history`), so an agent's ask
 *    becomes a proposal the person approves, and a narrowed key that is not an
 *    agent's is refused there — no grant narrows what the import reads.
 *  - `/memory` writes (`POST /memory`, `/memory/turns|sessions|writes`,
 *    `DELETE /memory/:id`; S5 2026-10-20): `knowledge_facts` about the
 *    person, recalled in EVERY workspace, written directly — no grant narrows
 *    them. `POST /memory/search` is a read (GRANT_REST_POST_READS). Agents
 *    remember a fact through MCP `synap_remember_fact` (a governed write).
 *  - `PUT` / `DELETE /knowledge/:key` (S6 2026-10-20): rewrite or archive a
 *    pod-wide `knowledge_keys` runbook BY KEY — no owner check, recalled by
 *    every agent everywhere. `/knowledge/(search|ask|answer)` are reads;
 *    `POST /knowledge` (create) is governed (`checkPermissionOrPropose`).
 *
 * Callers checked: the IS (unbounded keys), the browser/app (tRPC session),
 * the CLI cap flows (reach these only after a fenced read, so only with an
 * unbounded key today). No narrowed-grant caller works today.
 */
export const GRANT_OWNER_WIDE_REST_WRITES: readonly RegExp[] = [
  /^\/capabilities\/[^/]+\/credentials(?:\/[^/]+)?\/?$/,
  /^\/vault\/secrets\/[^/]+\/?$/,
  /^\/connectors\/connections\/[^/]+\/?$/,
  /^\/connectors\/disconnect\/?$/,
  /^\/connectors\/(?:connect|session)\/?$/,
  /^\/messaging\/accounts\/[^/]+\/?$/,
  /^\/memory(?:\/(?!search\/?$)[^/]+)?\/?$/,
  /^\/knowledge\/(?!(?:search|ask|answer)\/?$)[^/]+\/?$/,
];

export const GRANT_OWNER_WIDE_UNSUPPORTED =
  "This door acts on everything you own (it cannot be limited to a space, project or kind), so it needs a key with unrestricted full access ('*' with no space, project or object limit).";

/**
 * Every scope is `*` and none is narrowed to a workspace, project or object.
 * Since S1 this IS `isFullAccessGrant` (the one predicate); the name stays for
 * the owner-wide doors that read as "unbounded".
 */
export function isUnboundedFullAccess(grant: KeyGrant): boolean {
  return isFullAccessGrant(grant);
}

/**
 * What a Hub REST route does, for the access door (plan-access A3). Every
 * route is exactly one:
 *  - `read`: GET / HEAD, and the POSTs declared in `GRANT_REST_POST_READS`.
 *    It writes nothing: a declared read reaches no write gate (tripwire
 *    `grant-door-classification`, derived from the served routes).
 *  - `write`: every other route. Bounded by the governed-write gate (the
 *    door's `assertCanWrite` / `canWrite`, `checkPermissionOrPropose`).
 *  - `owner-wide`: acts for the whole owner, no grant can narrow it
 *    (`GRANT_OWNER_WIDE_REST_DOORS`, `GRANT_OWNER_WIDE_REST_WRITES`).
 */
export type HubRouteClass = "read" | "write" | "owner-wide";

/**
 * The class of `method path` (path relative to /api/hub), from the fence's
 * own declarations: the ONE classification `ownerWideDoorAllowed` rules on.
 */
export function hubRouteClass(method: string, path: string): HubRouteClass {
  const m = method.toUpperCase();
  const isRead = m === "GET" || m === "HEAD";
  if (
    GRANT_OWNER_WIDE_REST_DOORS.some((r) => r.test(path)) ||
    (!isRead && GRANT_OWNER_WIDE_REST_WRITES.some((r) => r.test(path)))
  )
    return "owner-wide";
  if (isRead) return "read";
  return m === "POST" && GRANT_REST_POST_READS.some(([r]) => r.test(path))
    ? "read"
    : "write";
}

/**
 * Hub REST: may a key holding `grant` use an owner-wide door? `true` for any
 * path that is not one, and for a request with no grant (a signed-in session).
 * `method` selects the write-only class (`GRANT_OWNER_WIDE_REST_WRITES`); when
 * omitted the request is treated as a write (fail closed).
 */
export function ownerWideDoorAllowed(
  path: string,
  grant: KeyGrant | null | undefined,
  method?: string
): boolean {
  if (!grant) return true;
  if (hubRouteClass(method ?? "POST", path) !== "owner-wide") return true;
  return isUnboundedFullAccess(grant);
}

/** Hub REST: may a scoped key use `method path` (path relative to /api/hub)? */
export function restDoorAllowed(
  method: string,
  path: string,
  grant: KeyGrant
): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") {
    if (GRANT_SAFE_REST_READS.some((r) => r.test(path))) return true;
    const read = GRANT_REST_GET_READS.find(([r]) => r.test(path));
    return Boolean(read) && grantBoundsDoor(read![1], grant);
  }
  if (m === "POST") {
    const read = GRANT_REST_POST_READS.find(([r]) => r.test(path));
    return !read || grantBoundsDoor(read[1], grant);
  }
  return true; // PUT / PATCH / DELETE — writes, bounded by the gate
}

/**
 * MCP: may a scoped key call this listed tool? A read tool through its door
 * (`MCP_READ_TOOL_DOORS`); any other tool as `MCP_WRITE_TOOL_DOORS` classifies
 * it: a write passes to the gate, a row-returning one through its door, and an
 * unclassified one is refused (closed by default). A name no tool carries is
 * never asked: the caller lets MCP answer it.
 */
export function mcpToolAllowed(
  toolName: string,
  readOnly: boolean | undefined,
  grant: KeyGrant
): boolean {
  if (readOnly === true)
    return grantBoundsDoor(MCP_READ_TOOL_DOORS[toolName], grant);
  const door = MCP_WRITE_TOOL_DOORS[toolName];
  if (!door) return false;
  return door.bound === "write" || grantBoundsDoor(door, grant);
}

/**
 * How a key-reachable tRPC MUTATION is bounded by a grant (S7).
 *
 *  - `gated`: every write reaches the governed-write gate with the REAL
 *    target (stored row or validated input) and nothing is written before
 *    it, so rung 0 (`grantWriteDenial`) bounds it by the key's grant.
 *  - `owner_wide`: acts for the whole owner; no grant can narrow it.
 *  - `refused`: the gate does not bound it yet (gates a workspace the caller
 *    picked, writes before the gate, or no grant check at all), or it waits
 *    on a product decision. Refused for a scoped key until fixed / decided.
 */
export type TrpcWriteDoor =
  | { readonly bound: "gated" }
  | { readonly bound: "owner_wide"; readonly reason: string }
  | { readonly bound: "refused"; readonly reason: string };

const GATED: TrpcWriteDoor = { bound: "gated" };
const OWNER_WIDE = (reason: string): TrpcWriteDoor => ({
  bound: "owner_wide",
  reason,
});

/**
 * Every key-reachable tRPC MUTATION, by procedure path: the hub router
 * (`/api/hub/trpc`) and the core-router procedures built on
 * `apiKeyMiddleware`. The set is DERIVED from the live routers by
 * `__tripwires__/trpc-mutation-classification.tripwire.test.ts`; an
 * unclassified mutation is refused for every scoped key (fail closed).
 *
 * Plan + evidence (file:line per row):
 * lanes/wf-w1/_docs/13-trpc-mutation-fence-plan.md §1.2 / §2. A `refused` row
 * moves to `gated` only with its root fix (W2) and a test proving the gate
 * sees the real target.
 */
export const TRPC_KEY_MUTATION_DOORS: Readonly<Record<string, TrpcWriteDoor>> =
  {
    // (a) GATED — the gate bounds them with the grant.
    "channels.createExternalChannel": GATED,
    "skills.createSkill": GATED,
    "views.updateView": GATED,
    "views.arrangeBento": GATED,
    "views.updateContent": GATED,
    "widgetDefinitions.upsertWidgetDef": GATED,
    "automations.pauseAutomation": GATED,
    "automations.deleteAutomation": GATED,
    "signals.classify": GATED, // writes nothing
    "playbooks.promote": GATED,
    "playbooks.update": GATED,
    "entities.deleteEntity": GATED,
    "documents.createDocument": GATED,
    "documents.patchDocument": GATED,
    "documents.createDocumentProposal": GATED,
    "branches.createBranch": GATED,
    "branches.mergeBranch": GATED,
    "relationDefs.create": GATED,
    "n8nActions.analyzeContent": GATED, // writes nothing

    // (c)/(d) → GATED by their W2 root fix: the gate now sees the REAL target.
    // Each group is proven through the real Bearer door on PGlite by the test
    // named beside it.
    // W2a — routers/hub-protocol/gate-on-target.entities.pglite.test.ts
    "entities.createEntity": GATED,
    "entities.updateEntities": GATED,
    "entities.updateEntity": GATED,
    // W2a — routers/hub-protocol/gate-on-target.schema.pglite.test.ts
    "relations.createRelation": GATED,
    "relations.deleteRelation": GATED,
    "profiles.createProfile": GATED,
    "profiles.setRenderer": GATED,
    "profiles.createPropertyDef": GATED,
    // The batch (ticket a375443d): one gate, pod-wide unless every field is an
    // overlay — the same target rule as one def.
    "profiles.createPropertyDefs": GATED,
    "profiles.updatePropertyDef": GATED,
    // D2 (founder 2026-10-20): the parent's workspace; a pod-wide role is pod
    // scope — routers/hub-protocol/gate-on-target.schema.pglite.test.ts
    "entities.attachFacet": GATED,
    "entities.updateFacet": GATED,
    "entities.detachFacet": GATED,
    // W2b — every channel/session/memory write passes `assertChannelWrite` on
    // the CHANNEL's workspace (D4: an AI turn is a message.create there) —
    // routers/hub-protocol/gate-on-target.channels.pglite.test.ts
    "channels.resolveOrCreateChannel": GATED,
    "channels.bindChannel": GATED,
    "channels.sendExternalMessage": GATED,
    "channels.postToA2AIChannel": GATED,
    "channels.triggerAI": GATED,
    "context.updateThreadContext": GATED,
    "sessions.getOrCreate": GATED,
    "sessions.update": GATED,
    "sessions.close": GATED,
    "compactedStates.create": GATED,
    // W2c — the rest of class (c): linking returns the proposal instead of
    // inserting; the pre-gate writes (pod-wide view, session document) are
    // grant-checked; propertyDefs.create is gated (migration.migrate's last
    // ungated sub-write); signals check the grant and the relay route —
    // routers/hub-protocol/gate-on-target.misc.pglite.test.ts
    "linking.linkEntity": GATED,
    "linking.linkDocument": GATED,
    "views.createView": GATED,
    "documents.upsertSessionSection": GATED,
    "migration.migrate": GATED,
    "signals.fetch": GATED,
    "signals.subscriptions": GATED,
    "signals.batch": GATED,
    "signals.capture": GATED,
    "n8nActions.createEntity": GATED,

    // (b) OWNER-WIDE — need an unbounded `*` key.
    "channels.ensurePersonal": OWNER_WIDE(
      "The owner's pod-wide personal channel; ignores the workspace."
    ),
    "services.register": OWNER_WIDE(
      "Rewrites a pod-global intelligence service (pod admin / is_internal)."
    ),
    "intelligenceRegistry.storeServiceSecret": OWNER_WIDE(
      "Upserts the key principal's vault secret for a free-form serviceId; no gate."
    ),

    // (c) REFUSED until the W2 root fix — none left: W2a–W2c fixed every one
    // and flipped it to GATED above. A new refused row needs its reason.

    // (d) PRODUCT DECISIONS (founder 2026-10-20, plan §2 D1–D5), applied in
    // W2d — routers/hub-protocol/gate-on-target.decisions.pglite.test.ts.
    // D1: arming/running a flow is owner authority — a person's key needs
    // unbounded `*` inside the door; an agent key keeps its proposal path.
    "automations.createAutomation": GATED,
    "automations.updateAutomation": GATED,
    "automations.activateAutomation": GATED,
    "automations.triggerAutomation": GATED,
    // D3: revising honours the key's space / project / object pins, and a
    // fenced key never changes the payload or the space (issue 314a6554).
    "proposals.updateProposal": GATED,
    // D5: an observation is `event.create` where it lands; never widened.
    "observations.append": GATED,
  };

export const GRANT_WRITE_DOOR_UNSUPPORTED =
  "This door does not support scoped keys yet: its writes are not bounded by a grant. Use a door listed in the API keys guide, or a key with unrestricted full access ('*' with no space, project or object limit).";

/**
 * tRPC (the Bearer door): may a key holding `grant` call this procedure?
 *
 *  - no grant (legacy key, session): always — unchanged;
 *  - query: an unfenced key always; a scoped key only a seamed one;
 *  - anything else (mutation, subscription): a `gated` mutation for any
 *    grant (rung 0 bounds it); owner-wide, refused AND unclassified ones only
 *    for an unbounded `*` key (a pinned `*` is scoped — S1).
 */
export function trpcProcedureAllowed(
  type: string,
  path: string,
  grant: KeyGrant | null | undefined
): boolean {
  if (!grant) return true;
  if (type === "query")
    return !isFencedGrant(grant) || GRANT_SAFE_TRPC_QUERIES.has(path);
  if (TRPC_KEY_MUTATION_DOORS[path]?.bound === "gated") return true;
  return isUnboundedFullAccess(grant);
}

/** The 403 message for a procedure `trpcProcedureAllowed` refused. */
export function trpcRefusalMessage(type: string, path: string): string {
  if (type === "query") return GRANT_DOOR_UNSUPPORTED;
  return TRPC_KEY_MUTATION_DOORS[path]?.bound === "owner_wide"
    ? GRANT_OWNER_WIDE_UNSUPPORTED
    : GRANT_WRITE_DOOR_UNSUPPORTED;
}
