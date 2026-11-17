/**
 * TRIPWIRE — every door a scoped key can reach is classified, closed by
 * default (R1, 2 Nov 2026).
 *
 * MCP: the fence (`access/grant-door-fence.ts`) lets a fenced key through a
 * read tool only when MCP_READ_TOOL_DOORS says how the grant bounds it: SEAMED
 * (read through scopedDb / the grant hooks) or READS (an aggregate door that
 * declares its subjects; the key must read each one unnarrowed). Every OTHER
 * tool is in MCP_WRITE_TOOL_DOORS: a WRITE (bounded by the gate) or, when it
 * returns rows, the read door of what it returns. A tool in neither map is
 * refused to a fenced key. Both sets are DERIVED from the live tool list
 * (`tools.list()`, `readOnlyHint`), so a new tool fails here until someone
 * classifies it, and an entry for a tool that is gone or changed sides fails
 * too.
 *
 * HUB REST ROUTE CLASSES (plan-access A3): every served Hub route is `read`,
 * `write` or `owner-wide` (`hubRouteClass`, from the fence's declarations).
 * The route set is DERIVED from the served app (`hubProtocolRestApp.routes`,
 * method + path + handler source). Checked: a route declared `read` that is
 * not a GET reaches no write gate in its handler (a write declared a read
 * would let a scoped key through as a read door), and every fence declaration
 * names a served route of the method it governs (no stale entry).
 *
 * NON-GET ROUTES NAME THEIR GATE: every served POST/PUT/PATCH/DELETE route is
 * a declared read, owner-wide, a write whose handler names a write gate, a
 * write that calls a hub tRPC mutation the fence classifies `gated`
 * (TRPC_KEY_MUTATION_DOORS), a write gated by a named helper
 * (`GATED_ELSEWHERE`, whose own source must name a gate), a write only a
 * computer's own runner may make (`COMPUTER_RUNNER_WRITES`: a privileged
 * scope no grant carries, and a refusal of every principal that is not the
 * computer), a write that only FILES an ask its person decides
 * (`ASK_ONLY_WRITES`: its helper files a pending proposal and applies none of
 * what approving does), a write whose GRANT check sits deeper than one call
 * (`GRANT_CHECKED_DEEPER`: a call chain read from the code, ending in a check
 * of the key's grant), a decision only a signed-in person makes
 * (`PERSON_SESSION_WRITES`: the auth door skips it and the handler reads only
 * the person's Kratos session), or in the shrink-only baseline of routes
 * nobody has classified yet (`access/grant-door-write-baseline.ts`). A NEW
 * route in none of them fails, a baseline row that is now classified or gone
 * fails, and the baseline's cap only goes down. At run time the fence refuses
 * every baselined route to a person's app token (`appPersonWriteAllowed`, A1
 * step 1) and still lets every other key through: this check stops the class
 * from growing, it does not prove each baselined handler reaches a gate.
 *
 * GET ROUTES ARE CLASSIFIED (4 Nov 2026): every served GET route is a safe
 * read, a declared read door (`GRANT_REST_GET_READS`, REFUSED included) or
 * owner-wide, or sits in the shrink-only baseline of routes nobody has
 * classified yet (`grant-door-read-baseline.ts`). The fence refuses an
 * unclassified GET to a scoped key (closed by default), so this is not a leak
 * check: it stops a read door from shipping unusable to every scoped key
 * because nobody classified it (findings 3122ba42, cce86e6b, 7da9c21f).
 *
 * NOT COVERED (stated): whether a declared subject list is COMPLETE for its
 * door is a review question, not something this scan can see; a door that
 * reads one more subject than it declares is bounded too loosely. The
 * DECLARED subjects (`GRANT_REST_GET_READS`, `GRANT_REST_POST_READS`)
 * are checked against the read hook below. A gate named in a handler or a
 * helper is not proven to run on every branch, and that an MCP WRITE tool
 * reaches a gate is not checked.
 */
import { describe, expect, it } from "vitest";
import { tools } from "../routers/mcp/tools/index.js";
import { readFileSync } from "fs";
import { join } from "path";
import {
  appPersonWriteAllowed,
  GRANT_OWNER_WIDE_REST_DOORS,
  GRANT_OWNER_WIDE_REST_WRITES,
  GRANT_REST_GET_READS,
  GRANT_REST_POST_READS,
  GRANT_SAFE_REST_READS,
  MCP_READ_TOOL_DOORS,
  MCP_WRITE_TOOL_DOORS,
  TRPC_KEY_MUTATION_DOORS,
  hubRouteClass,
} from "../access/grant-door-fence.js";
import {
  UNCLASSIFIED_WRITE_ROUTES,
  UNCLASSIFIED_WRITE_ROUTES_CAP,
} from "../access/grant-door-write-baseline.js";
import { hubAuthSkipped } from "../routers/hub-protocol/_middleware/auth-skip.js";
import {
  UNCLASSIFIED_READ_ROUTES,
  UNCLASSIFIED_READ_ROUTES_CAP,
} from "./grant-door-read-baseline.js";
import { GRANT_READ_SPECS } from "../access/grant-read.js";
import {
  HOST_RUNNER_SCOPE,
  PRIVILEGED_MINT_SCOPES,
} from "@synap/database/schema";
import { KEY_SCOPES_NOT_DERIVED } from "@synap-core/types/grants";
import { hubProtocolRestApp } from "../routers/hub-protocol-rest.js";

describe("MCP read-tool classification (derived from the live tool list)", () => {
  it("classifies every read tool, and only read tools", async () => {
    const all = await tools.list();
    const reads = all
      .filter((t) => t.annotations?.readOnlyHint === true)
      .map((t) => t.name);
    // Non-vacuity: the scan sees the tool list and the doors it must cover.
    expect(all.length).toBeGreaterThan(60);
    expect(reads).toEqual(
      expect.arrayContaining(["synap_ask", "synap_orient", "synap_get_entity"])
    );
    expect(reads.length).toBeGreaterThanOrEqual(25);

    const classified = Object.keys(MCP_READ_TOOL_DOORS);
    expect(
      reads.filter((n) => !classified.includes(n)),
      "Classify the tool in MCP_READ_TOOL_DOORS (access/grant-door-fence.ts)."
    ).toEqual([]);
    expect(classified.filter((n) => !reads.includes(n))).toEqual([]);
  });

  it("classifies every other tool, and only those (closed by default)", async () => {
    const all = await tools.list();
    const others = all
      .filter((t) => t.annotations?.readOnlyHint !== true)
      .map((t) => t.name);
    // Non-vacuity: the scan sees the write tools, and the two that return
    // rows carry a read door, not WRITE.
    expect(others.length).toBeGreaterThanOrEqual(50);
    expect(others).toEqual(
      expect.arrayContaining(["synap_wait_for_answer", "synap_get_channel"])
    );
    expect(MCP_WRITE_TOOL_DOORS.synap_wait_for_answer?.bound).toBe("reads");
    expect(MCP_WRITE_TOOL_DOORS.synap_get_channel?.bound).toBe("reads");

    const classified = Object.keys(MCP_WRITE_TOOL_DOORS);
    expect(
      others.filter((n) => !classified.includes(n)),
      "Classify the tool in MCP_WRITE_TOOL_DOORS (access/grant-door-fence.ts): " +
        "WRITE when it only writes through the gate, else the read door of what it returns."
    ).toEqual([]);
    expect(classified.filter((n) => !others.includes(n))).toEqual([]);
  });

  it("declares only subjects the read hook knows (MCP tools and Hub REST doors)", () => {
    const known = new Set([...GRANT_READ_SPECS.values()].map((s) => s.subject));
    const doors = [
      ...Object.entries(MCP_READ_TOOL_DOORS),
      ...Object.entries(MCP_WRITE_TOOL_DOORS).flatMap(([n, d]) =>
        d.bound === "write" ? [] : [[n, d] as const]
      ),
      ...[...GRANT_REST_GET_READS, ...GRANT_REST_POST_READS].map(
        ([r, d]) => [String(r), d] as const
      ),
    ];
    // Non-vacuity: the REST declarations are in the scanned set.
    expect(GRANT_REST_GET_READS.length).toBeGreaterThanOrEqual(5);
    expect(known.has("session")).toBe(true);
    const declared = (d: (typeof doors)[number][1]): readonly string[] =>
      d.bound === "reads"
        ? d.subjects
        : d.bound === "person"
          ? [d.subject]
          : d.bound === "narrowed"
            ? // A door narrowed on a gate verb (`capability … run`, the intent
              // actions doors) is admitted by that verb, not by a read of its
              // subject; what it reads is still `full`.
              d.action === "read"
              ? [d.subject, ...d.full]
              : [...d.full]
            : [];
    const unknown = doors.flatMap(([n, d]) =>
      declared(d)
        .filter((s) => !known.has(s))
        .map((s) => `${n}:${s}`)
    );
    expect(unknown).toEqual([]);
  });
});

/**
 * The write gates a handler can name: the door's write checks, governance,
 * the gate's rung 0 itself (`grantWriteDenial`), the channel and facet
 * write checks that run it (`assertChannelWrite`, `canWriteFacet`), and the
 * revise core's key check (`assertMayReviseProposal`: a key revising a
 * proposal it did not file needs the approve right on that proposal's own
 * space, project or object), which `mergeProposalRevision` runs on every
 * revision; and the decision right (`assertMayDecideProposal`: a key that
 * drops or restores an item of a proposal needs `proposal.reject`, then the
 * procedure it calls bounds it to the proposal's own space, project or object
 * through `assertCanReviewProposal`, pinned by
 * `proposal-decision-grant.tripwire.test.ts`).
 */
const GATES = [
  "checkPermissionOrPropose",
  "assertCanWrite",
  "canWrite",
  "assertWorkspaceWrite",
  "grantWriteDenial",
  "assertChannelWrite",
  "canWriteFacet",
  "assertMayReviseProposal",
  "assertMayDecideProposal",
] as const;
type Gate = (typeof GATES)[number];

/**
 * A call of `gate` in a handler's SERVED source. The test transform rewrites a
 * statically imported call to `(0, __vi_import_n__.canWrite)(…)`, so the name
 * may be followed by `)` before the call's own `(`; a destructured dynamic
 * import keeps the bare `checkPermissionOrPropose(…)`.
 */
const callOf = (gate: string): RegExp => new RegExp(`\\b${gate}\\)?\\s*\\(`);
const WRITE_GATE = new RegExp(GATES.map((g) => callOf(g).source).join("|"));

/**
 * Write routes whose own handler names a gate, each with the door it goes
 * through (read from the code, 2026-10-27). Every row must stay served, a
 * `write`, and name its door: this is what proves the read check below sees
 * the handlers' code, statically imported calls included.
 */
const GATED_WRITE_ROUTES: Readonly<Record<string, Gate>> = {
  // rest/entities.ts — the presigned upload lane, the door's write floor.
  "POST /files/uploads": "canWrite",
  "POST /files/uploads/finalize": "canWrite",
  // rest/cells.ts — a person's define needs the write floor, an agent's the gate.
  "POST /cells/define": "canWrite",
  // rest/whiteboards.ts — a placement proposal: the write floor, then the gate.
  "POST /whiteboards/:viewId/placements/propose": "canWrite",
  // rest/capture.ts — drafting a process into a space: its write floor.
  "POST /capture/draft-process": "assertWorkspaceWrite",
  // rest/commands.ts — running a command is a governed write.
  "POST /commands/execute": "checkPermissionOrPropose",
  // rest/cell-instances.ts — create, create from HTML, reconfigure: governed.
  "POST /cell-instances": "checkPermissionOrPropose",
  "POST /cell-instances/html": "checkPermissionOrPropose",
  "PATCH /cell-instances/:id/config": "checkPermissionOrPropose",
};

const ID = "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8";
/** `/files/:entityId/url` → a path the fence's regexes can be asked about. */
function concrete(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+(\{[^}]*\})?\??/g, ID).replace(/\*/g, "x");
}

interface ServedRoute {
  method: string;
  path: string;
  /** Every handler registered for this method + path (validators included). */
  source: string;
}

/** The served Hub routes, one per method + path (ALL = middleware, skipped). */
function servedRoutes(): ServedRoute[] {
  const byKey = new Map<string, ServedRoute>();
  for (const r of hubProtocolRestApp.routes as Array<{
    method: string;
    path: string;
    handler: (...a: unknown[]) => unknown;
  }>) {
    if (r.method === "ALL") continue;
    const key = `${r.method} ${r.path}`;
    const prev = byKey.get(key);
    const source = String(r.handler);
    byKey.set(
      key,
      prev
        ? { ...prev, source: `${prev.source}\n${source}` }
        : { method: r.method, path: r.path, source }
    );
  }
  return [...byKey.values()];
}

/** Routes declared `read` that are not GET/HEAD but name a write gate. */
export function readsThatWrite(routes: readonly ServedRoute[]): string[] {
  return routes
    .filter(
      (r) =>
        r.method !== "GET" &&
        r.method !== "HEAD" &&
        hubRouteClass(r.method, concrete(r.path)) === "read" &&
        WRITE_GATE.test(r.source)
    )
    .map((r) => `${r.method} ${r.path}`);
}

describe("Hub REST route classes (derived from the served routes)", () => {
  const routes = servedRoutes();
  const classOf = (r: ServedRoute) => hubRouteClass(r.method, concrete(r.path));

  it("sees the served routes and every class (non-vacuity)", () => {
    expect(routes.length).toBeGreaterThan(300);
    const count = (c: string) => routes.filter((r) => classOf(r) === c).length;
    expect(count("read")).toBeGreaterThan(100);
    expect(count("write")).toBeGreaterThan(150);
    expect(count("owner-wide")).toBeGreaterThanOrEqual(5);
    // The read check sees the handlers' own code, statically imported calls
    // included: every known gated write route names its door.
    const byKey = new Map(routes.map((r) => [`${r.method} ${r.path}`, r]));
    const missing = Object.entries(GATED_WRITE_ROUTES)
      .filter(([key, gate]) => {
        const r = byKey.get(key);
        return !r || classOf(r) !== "write" || !callOf(gate).test(r.source);
      })
      .map(([key, gate]) => `${key} → ${gate}`);
    expect(missing).toEqual([]);
  });

  it("a route declared `read` (a POST read) reaches no write gate", () => {
    // Non-vacuity: the POST reads are in the scanned set.
    expect(
      routes.filter((r) => r.method === "POST" && classOf(r) === "read").length
    ).toBeGreaterThanOrEqual(5);
    expect(
      readsThatWrite(routes),
      "A route that writes is declared a read in GRANT_REST_POST_READS " +
        "(access/grant-door-fence.ts): a scoped key would pass it as a read door."
    ).toEqual([]);
  });

  it("self-check: a POST read that names a write gate is flagged", () => {
    const [readPattern] = GRANT_REST_POST_READS[0]!;
    const path = routes.find(
      (r) => r.method === "POST" && readPattern.test(concrete(r.path))
    )!.path;
    expect(
      readsThatWrite([
        { method: "POST", path, source: "await canWrite(p, { workspace: w })" },
        { method: "POST", path, source: "await canRead(p, { workspace: w })" },
        // The served (transformed) form of a statically imported call.
        {
          method: "POST",
          path,
          source: "await (0, __vi_import_3__.canWrite)(p, { workspace: w })",
        },
        { method: "GET", path, source: "await canWrite(p, { workspace: w })" },
      ])
    ).toEqual([`POST ${path}`, `POST ${path}`]);
  });

  it("every fence declaration names a served route of its method (no stale entry)", () => {
    const served = (methods: string[], r: RegExp) =>
      routes.some(
        (route) =>
          methods.includes(route.method) && r.test(concrete(route.path))
      );
    const NON_GET = ["POST", "PUT", "PATCH", "DELETE"];
    const stale = [
      ...GRANT_SAFE_REST_READS.filter((r) => !served(["GET"], r)),
      ...GRANT_REST_GET_READS.map(([r]) => r).filter(
        (r) => !served(["GET"], r)
      ),
      ...GRANT_REST_POST_READS.map(([r]) => r).filter(
        (r) => !served(["POST"], r)
      ),
      ...GRANT_OWNER_WIDE_REST_DOORS.filter(
        (r) => !served(["GET", ...NON_GET], r)
      ),
      ...GRANT_OWNER_WIDE_REST_WRITES.filter((r) => !served(NON_GET, r)),
    ].map(String);
    expect(stale).toEqual([]);
  });
});

/**
 * Writes gated by a helper their handler calls, read from the code (R1,
 * 2 Nov 2026). Each row is checked: the handler still names `via`, and `via`'s
 * own source names a write gate. A helper that gates only through a deeper
 * call does not qualify: that route stays in the baseline until its gate is
 * named one level down.
 */
const GATED_ELSEWHERE: Readonly<
  Record<
    string,
    {
      via: string;
      load: () => Promise<Record<string, unknown>>;
      why: string;
    }
  >
> = {
  "POST /installations/request": {
    via: "requestInstallation",
    load: () => import("../services/installations/request-installation.js"),
    why: "installation.request through checkPermissionOrPropose (an agent's install, update or removal is a proposal), shared with MCP synap_request_installation",
  },
  "PUT /playbooks/:id/run-choice": {
    via: "setPlaybookRunChoiceGoverned",
    load: () => import("../services/playbooks/set-run-choice.js"),
    why: "playbook.set_run_choice through checkPermissionOrPropose (an agent's choice is a proposal)",
  },
  "PUT /workspaces/:workspaceId/needs/:need": {
    via: "bindSpaceNeedThroughGate",
    load: () => import("../services/needs/space-need-door.js"),
    why: "workspace.bind_need through checkPermissionOrPropose (an agent's choice of provider is a proposal), shared with tRPC needs.bind",
  },
  "POST /projects": {
    via: "createProjectGoverned",
    load: () => import("../services/projects/create-project.js"),
    why: "project.create through checkPermissionOrPropose",
  },
  "PATCH /projects/:id": {
    via: "updateProjectGoverned",
    load: () => import("../services/projects/update-project.js"),
    why: "project.update through checkPermissionOrPropose",
  },
  "DELETE /projects/:id": {
    via: "deleteProjectGoverned",
    load: () => import("../services/projects/delete-project.js"),
    why: "project.delete through checkPermissionOrPropose",
  },
  "POST /tracks": {
    via: "startTrack",
    load: () => import("../services/tracks/tracks-service.js"),
    why: "track.create through checkPermissionOrPropose",
  },
  "POST /shares": {
    via: "shareResource",
    load: () => import("../services/sharing/share-service.js"),
    why: "a share is a governed write",
  },
  "POST /shares/publish": {
    via: "publishResource",
    load: () => import("../services/sharing/publish-service.js"),
    why: "share.create through checkPermissionOrPropose (an agent's publish is a proposal)",
  },
  "POST /shares/unpublish": {
    via: "unpublishResource",
    load: () => import("../services/sharing/publish-service.js"),
    why: "narrowing only, still within the key's grant (grantWriteDenial, share.update in the record's space)",
  },
  "POST /shares/publication/revoke": {
    via: "revokePublication",
    load: () => import("../services/sharing/publish-service.js"),
    why: "a permanent revoke within the key's grant (grantWriteDenial, share.delete in the record's space)",
  },
  "POST /shares/unshare": {
    via: "unshareResource",
    load: () => import("../services/sharing/share-service.js"),
    why: "narrowing only, still within the key's grant (grantWriteDenial, share.delete)",
  },
  "POST /shares/links/:id/revoke": {
    via: "revokeLink",
    load: () => import("../services/sharing/share-service.js"),
    why: "a link revoke within the key's grant (grantWriteDenial, share.delete on the anchor)",
  },
  "POST /shares/sites": {
    via: "configureSite",
    load: () => import("../services/sharing/site-service.js"),
    why: "share.create through checkPermissionOrPropose (an agent's configure is a proposal)",
  },
  "POST /shares/sites/:id/publish": {
    via: "publishToSite",
    load: () => import("../services/sharing/site-service.js"),
    why: "share.create through checkPermissionOrPropose (an agent's batch is one proposal)",
  },
  "POST /shares/sites/:id/unpublish": {
    via: "unpublishFromSite",
    load: () => import("../services/sharing/site-service.js"),
    why: "narrowing only, still within the key's grant (grantWriteDenial, share.update)",
  },
  "POST /shares/sites/:id/revoke": {
    via: "revokeSite",
    load: () => import("../services/sharing/site-service.js"),
    why: "a permanent revoke within the key's grant (grantWriteDenial, share.delete)",
  },
  "POST /shares/sites/:id/charts/publish": {
    via: "publishChartsToSite",
    load: () => import("../services/sharing/site-charts.js"),
    why: "share.create through checkPermissionOrPropose (an agent's batch is one proposal)",
  },
  "POST /shares/sites/:id/charts/unpublish": {
    via: "unpublishChartsFromSite",
    load: () => import("../services/sharing/site-charts.js"),
    why: "narrowing only, still within the key's grant (grantWriteDenial)",
  },
  "POST /channels/:channelId/bind": {
    via: "proposeChannelBind",
    load: () => import("../utils/propose-channel-bind.js"),
    why: "binding a channel is proposed through the gate",
  },
  "POST /focus-sessions/orchestrate": {
    via: "startOrchestrator",
    load: () => import("../services/focus-sessions/start-orchestrator.js"),
    why: "focus_session.orchestrate through checkPermissionOrPropose (an agent's orchestrator is a proposal; nothing is written before the gate), shared with tRPC focusSessions.startOrchestrator and MCP synap_start_orchestrator",
  },
  "POST /focus-sessions/:id/continue": {
    via: "continueStoppedRun",
    load: () => import("../services/focus-sessions/continue-run.js"),
    why: "a person continues a stopped run: the key's grant bounds it as a session update (grantWriteDenial); an agent key is refused",
  },
  "POST /focus-sessions": {
    via: "createFocusSession",
    load: () => import("../services/focus-sessions/create-session.js"),
    why: "focus_session.create through checkPermissionOrPropose",
  },
  "POST /focus-sessions/:id/complete": {
    via: "completeFocusSession",
    load: () => import("../services/focus-sessions/complete-session.js"),
    why: "closing a session passes the gate",
  },
  "POST /agent-skills": {
    via: "insertSkillGoverned",
    load: () => import("../routers/skills.js"),
    why: "skill.create through checkPermissionOrPropose",
  },
  "POST /rules": {
    via: "createRuleGoverned",
    load: () => import("../services/rules/create.js"),
    why: "rule.create through checkPermissionOrPropose",
  },
  "PATCH /rules/:id": {
    via: "updateRuleGoverned",
    load: () => import("../services/rules/update.js"),
    why: "rule.update through checkPermissionOrPropose",
  },
  "POST /messaging/conversations/:threadId/send": {
    via: "sendExternalMessage",
    load: () => import("../connectors/external-dispatch.js"),
    why: "messaging.send checked by grantWriteDenial in the conversation's space",
  },
  "POST /channels/:channelId/send": {
    via: "sendExternalMessage",
    load: () => import("../connectors/external-dispatch.js"),
    why: "the person's send: filed through the send door (grant verdict, gate), then the approve door",
  },
  "PUT /channels/:channelId/drafts/:draftId": {
    via: "mergeProposalRevision",
    load: () => import("../services/proposals/proposals-service.js"),
    why: "the person saves a draft's words: one revision through the revise core (review authority, the key's approve right on the draft's space, a space key rewords a message's body and subject only); nothing is sent",
  },
  "POST /packages/apply": {
    via: "proposeTemplateApply",
    load: () => import("../services/template-apply/propose.js"),
    why: "workspace.create / workspace.update through checkPermissionOrPropose; a key holding package.install proposes a fresh install",
  },
  "POST /proposals": {
    via: "fencedProposalVerdict",
    load: () => import("../access/fenced-proposal.js"),
    why: "the free-form proposal runs rung 0 itself (fenced-proposal.ts)",
  },
  "POST /proposals/dev-approval": {
    via: "createDevApprovalProposal",
    load: () => import("../services/proposals/dev-approval.js"),
    why: "a fenced key files a plan or deploy approval only for a session its grant may update (grantWriteDenial focus_session.update in the session's space), and files it there",
  },
  "POST /focus-sessions/:id/answers/relay": {
    via: "relaySessionAnswer",
    load: () => import("../services/focus-sessions/session-answer.js"),
    why: "only an agent relays (the handler refuses a person's key), and the key must hold the session's answer write (grantWriteDenial on answerGrantWrite)",
  },
};

/**
 * Writes only a computer's OWN runner may make: the host-job wire
 * (`rest/host-jobs.ts`). No grant bounds them, and none can open them: the
 * handler resolves its caller through `via`, whose source checks `scope` (a
 * scope privileged at mint and derived from no key use, so no preset, app or
 * agent key carries it) and refuses every principal that is not the computer
 * itself (`NOT_A_COMPUTER`, an agent hosted on it included). Each row is
 * checked below: served, its handler calls `via`, `via` names the scope's
 * constant and the refusal, and the scope is privileged and not derived.
 */
const COMPUTER_RUNNER_WRITES: Readonly<
  Record<
    string,
    {
      via: string;
      scope: { name: string; value: string };
      load: () => Promise<Record<string, unknown>>;
    }
  >
> = Object.fromEntries(
  [
    "POST /host-jobs/lease",
    "POST /host-jobs/:id/heartbeat",
    "POST /host-jobs/:id/report",
    "POST /host-jobs/:id/finish",
    // A hosted verb run's output files: tickets minted for the job's
    // requester, only while this computer holds the verb job's lease.
    "POST /host-jobs/:id/uploads",
  ].map((key) => [
    key,
    {
      via: "resolveHostRunner",
      scope: { name: "HOST_RUNNER_SCOPE", value: HOST_RUNNER_SCOPE },
      load: () => import("../routers/hub-protocol/rest/host-jobs.js"),
    },
  ])
);

/**
 * Writes that only FILE an ask its person decides (plan 647ebfd4 option C,
 * 16 Nov 2026). The handler calls `via`; `via` files a PENDING proposal
 * (`createPendingProposal`, never the gate ladder, which could answer
 * `granted`) and names none of `APPROVAL_EFFECTS`, what approving the ask
 * does. The gate is the approval itself: the person's tap, through the
 * approve door (the agent-approver floor, the executor's owner check and its
 * re-check of what may be given). Checked below.
 */
const ASK_ONLY_WRITES: Readonly<
  Record<
    string,
    {
      via: string;
      load: () => Promise<Record<string, unknown>>;
      why: string;
    }
  >
> = {
  "POST /apps/access-requests": {
    via: "fileAppAccessAsk",
    load: () => import("../services/app-access-ask.js"),
    why: "a pod app asks its person for one more thing: one pending app/connect of mode add, applied only by the person's approval (the executor re-checks the document, the offer and the person's reach)",
  },
  "POST /agents/access-requests": {
    via: "fileAgentAccessAsk",
    load: () => import("../services/agent-access-ask.js"),
    why: "an agent's key asks its person for one more thing: one pending agent/connect of mode add, applied only by the person's approval (the executor re-checks the key, the agent's limits and the person's reach, then clips to the computer)",
  },
};

/** What approving an ask does: an ask-only helper names none of them. */
const APPROVAL_EFFECTS = [
  "setApprovedRequests",
  "addApprovedRequests",
  "applyApprovedReach",
  "attachGrantsOrRevoke",
  "applyProposalApproval",
  // An agent's ask (`approveAgentAccessAsk`): the grant write and the clip.
  "approveAgentAccessAsk",
  "attachMany",
  "clipHostedAgentGrants",
] as const;

/**
 * The checks that read the calling KEY's grant: rung 0 itself
 * (`grantWriteDenial`), the gate that runs it first
 * (`checkPermissionOrPropose`), the decision right (`assertMayDecideProposal`)
 * and the revise core's key check (`assertMayReviseProposal`). NOT
 * `canWrite` / `assertCanWrite` / `assertWorkspaceWrite`: they check the
 * person's role in a space and read no key grant (knowledge 5ae551b2), so a
 * person's app token passes them wherever the person may write.
 */
const GRANT_CHECKS = [
  "checkPermissionOrPropose",
  "grantWriteDenial",
  "assertMayDecideProposal",
  "assertMayReviseProposal",
] as const;
const GRANT_CHECK = new RegExp(
  GRANT_CHECKS.map((g) => callOf(g).source).join("|")
);

const SRC = join(__dirname, "..");

/**
 * The definition of `name` in `file` (relative to src), read from the source:
 * a function, a `const`, or a tRPC procedure (`name: …Procedure`), from its
 * first line to the next line at its own indentation that does not close it.
 * `null` when the file defines no such name.
 */
export function definitionOf(file: string, name: string): string | null {
  const src = readFileSync(join(SRC, file), "utf8");
  const start = new RegExp(
    `^([ \\t]*)(?:export\\s+)?(?:async\\s+)?(?:function\\s+${name}\\b|const\\s+${name}\\s*=|${name}:\\s*\\w*[pP]rocedure\\b)`,
    "m"
  ).exec(src);
  if (!start) return null;
  const bodyFrom = src.indexOf("\n", start.index) + 1;
  const end = new RegExp(`^${start[1]}(?![\\s})\\]>])`, "gm");
  end.lastIndex = bodyFrom;
  const next = end.exec(src);
  return src.slice(start.index, next ? next.index : src.length);
}

/**
 * Writes whose check of the key's GRANT sits more than one call below the
 * handler, read from the code (plan a640c5bb A1, 18 Nov 2026: the approve
 * tier, and the doors the app SDK calls). Each row names the call chain: the
 * handler calls `chain[0]`, each link's definition calls the next one, and
 * the last one names a GRANT_CHECKS call. A role check alone (`canWrite`)
 * never qualifies. Checked below; a renamed link fails.
 */
const GRANT_CHECKED_DEEPER: Readonly<
  Record<
    string,
    {
      chain: ReadonlyArray<{ name: string; file: string }>;
      why: string;
    }
  >
> = {
  "POST /proposals/:id/approve": {
    chain: [{ name: "approve", file: "routers/proposals.ts" }],
    why: "proposals.approve asks the key's proposal.approve right on the proposal's own space, project and object first (assertMayDecideProposal); applyProposalApproval names the space to the grant again",
  },
  "POST /proposals/:id/reject": {
    chain: [{ name: "reject", file: "routers/proposals.ts" }],
    why: "proposals.reject asks the key's proposal.reject right first (assertMayDecideProposal), then the proposal's own space through assertCanReviewProposal",
  },
  "POST /proposals/:id/revert": {
    chain: [{ name: "revert", file: "routers/proposals.ts" }],
    why: "proposals.revert executes with the reviewer's authority, so it asks the key's approve right first (assertMayDecideProposal)",
  },
  "POST /focus-sessions/:id/revert": {
    chain: [
      {
        name: "revertSession",
        file: "services/focus-sessions/revert-session.ts",
      },
      {
        name: "defaultRevertOne",
        file: "services/focus-sessions/revert-session.ts",
      },
      { name: "revert", file: "routers/proposals.ts" },
    ],
    why: "each applied proposal of the session is reverted through proposals.revert, which asks the key's approve right on that proposal (assertMayDecideProposal)",
  },
  "POST /tracks/:id/participants/:pid/answer": {
    chain: [
      {
        name: "change",
        file: "routers/hub-protocol/rest/track-participants.ts",
      },
      {
        name: "changeTrackParticipants",
        file: "services/tracks/track-participants.ts",
      },
    ],
    why: "a participant's answer is track.update through checkPermissionOrPropose in the goal's project space (rung 0 checks the grant)",
  },
  "POST /focus-sessions/:id/cancel": {
    chain: [
      {
        name: "cancelSession",
        file: "services/focus-sessions/cancel-session.ts",
      },
      {
        name: "completeFocusSession",
        file: "services/focus-sessions/complete-session.ts",
      },
    ],
    why: "the one close door: focus_session.update through checkPermissionOrPropose in the session's space, before anything is stopped (the app SDK's cancelRun)",
  },
  "POST /playbooks/:id/run": {
    chain: [
      {
        name: "runPlaybookDoor",
        file: "routers/hub-protocol/playbook-doors.ts",
      },
      { name: "run", file: "routers/playbooks.ts" },
    ],
    why: "playbooks.run: playbook.run through checkPermissionOrPropose in the run's space (the app SDK's runPlaybook). Not covered: with a live run on the subject it returns before the gate and keeps a remembered run choice (rememberRunChoice)",
  },
};

/**
 * Decisions only a signed-in PERSON makes: the pending-agent approval doors.
 * The auth door skips them (`hubAuthSkipped`), so no key is ever their
 * principal and the fence never sees them; the handler resolves the decider
 * through `via`, which reads only the Kratos session (cookie or
 * `x-session-token`) and never an API key. Checked below.
 */
const PERSON_SESSION_WRITES: Readonly<
  Record<string, { via: string; file: string; why: string }>
> = Object.fromEntries(
  [
    "POST /setup/agent/pending/:keyId/approve",
    "POST /setup/agent/pending/:keyId/reject",
    "POST /setup/agent/pending/approve-batch",
  ].map((key) => [
    key,
    {
      via: "resolveKratosPodUserId",
      file: "routers/hub-protocol/rest/setup.ts",
      why: "only the connection's linked person or a pod admin, signed in to the pod (Kratos session), decides a pending agent key; no key reaches it",
    },
  ])
);

/** `router.procedure` names a handler calls (`caller.entities.createEntity(`). */
function trpcCallsOf(source: string): string[] {
  return [...source.matchAll(/\.([a-zA-Z]+)\.([a-zA-Z]+)\s*\(/g)].map(
    (m) => `${m[1]}.${m[2]}`
  );
}

type NonGetClass =
  | "read"
  | "owner-wide"
  | "gated"
  | "gated-trpc"
  | "gated-elsewhere"
  | "computer-runner"
  | "ask-only"
  | "grant-checked-deeper"
  | "person-session"
  | "unclassified";

/** How a served non-GET route is bounded, from the fence and its own code. */
export function nonGetRouteClass(r: ServedRoute): NonGetClass {
  const cls = hubRouteClass(r.method, concrete(r.path));
  if (cls !== "write") return cls;
  if (WRITE_GATE.test(r.source)) return "gated";
  if (
    trpcCallsOf(r.source).some(
      (p) => TRPC_KEY_MUTATION_DOORS[p]?.bound === "gated"
    )
  )
    return "gated-trpc";
  const elsewhere = GATED_ELSEWHERE[`${r.method} ${r.path}`];
  if (elsewhere && callOf(elsewhere.via).test(r.source))
    return "gated-elsewhere";
  const runner = COMPUTER_RUNNER_WRITES[`${r.method} ${r.path}`];
  if (runner && callOf(runner.via).test(r.source)) return "computer-runner";
  const ask = ASK_ONLY_WRITES[`${r.method} ${r.path}`];
  if (ask && callOf(ask.via).test(r.source)) return "ask-only";
  const deeper = GRANT_CHECKED_DEEPER[`${r.method} ${r.path}`];
  if (deeper && callOf(deeper.chain[0]!.name).test(r.source))
    return "grant-checked-deeper";
  const person = PERSON_SESSION_WRITES[`${r.method} ${r.path}`];
  if (person && callOf(person.via).test(r.source)) return "person-session";
  return "unclassified";
}

describe("Hub REST non-GET routes name their gate (closed by default)", () => {
  const nonGet = servedRoutes().filter(
    (r) => r.method !== "GET" && r.method !== "HEAD"
  );
  const keyOf = (r: ServedRoute) => `${r.method} ${r.path}`;
  const unclassified = nonGet
    .filter((r) => nonGetRouteClass(r) === "unclassified")
    .map(keyOf)
    .sort();

  it("sees every class (non-vacuity)", () => {
    expect(nonGet.length).toBeGreaterThan(250);
    const count = (c: NonGetClass) =>
      nonGet.filter((r) => nonGetRouteClass(r) === c).length;
    expect(count("read")).toBeGreaterThanOrEqual(15);
    expect(count("owner-wide")).toBeGreaterThanOrEqual(15);
    expect(count("gated")).toBeGreaterThanOrEqual(20);
    expect(count("gated-trpc")).toBeGreaterThanOrEqual(30);
    expect(count("gated-elsewhere")).toBe(Object.keys(GATED_ELSEWHERE).length);
    expect(count("computer-runner")).toBe(
      Object.keys(COMPUTER_RUNNER_WRITES).length
    );
    expect(count("ask-only")).toBe(Object.keys(ASK_ONLY_WRITES).length);
    expect(count("grant-checked-deeper")).toBe(
      Object.keys(GRANT_CHECKED_DEEPER).length
    );
    expect(count("person-session")).toBe(
      Object.keys(PERSON_SESSION_WRITES).length
    );
  });

  it("a new non-GET route is classified: a declared read or a named gate", () => {
    const baseline = new Set(UNCLASSIFIED_WRITE_ROUTES);
    expect(
      unclassified.filter((k) => !baseline.has(k)),
      "Name the write gate in the handler (checkPermissionOrPropose, canWrite, …), " +
        "call a `gated` hub tRPC mutation, add a GATED_ELSEWHERE row (its helper " +
        "must name a gate), a COMPUTER_RUNNER_WRITES row (a computer's own " +
        "runner only), or declare the route a read in GRANT_REST_POST_READS " +
        "(access/grant-door-fence.ts). Never add it to the baseline."
    ).toEqual([]);
  });

  it("the baseline only shrinks: no classified, gone or duplicate row, under its cap", () => {
    const now = new Set(unclassified);
    expect(
      UNCLASSIFIED_WRITE_ROUTES.filter((k) => !now.has(k)),
      "Classified or no longer served: remove it from grant-door-write-baseline.ts " +
        "and lower UNCLASSIFIED_WRITE_ROUTES_CAP."
    ).toEqual([]);
    expect(new Set(UNCLASSIFIED_WRITE_ROUTES).size).toBe(
      UNCLASSIFIED_WRITE_ROUTES.length
    );
    expect(UNCLASSIFIED_WRITE_ROUTES.length).toBeLessThanOrEqual(
      UNCLASSIFIED_WRITE_ROUTES_CAP
    );
  });

  it("every GATED_ELSEWHERE row is served, named by its handler, and its helper names a gate", async () => {
    const byKey = new Map(nonGet.map((r) => [keyOf(r), r]));
    const broken: string[] = [];
    for (const [key, row] of Object.entries(GATED_ELSEWHERE)) {
      const r = byKey.get(key);
      if (!r || !callOf(row.via).test(r.source)) {
        broken.push(`${key}: handler does not call ${row.via}`);
        continue;
      }
      const helper = (await row.load())[row.via];
      if (typeof helper !== "function" || !WRITE_GATE.test(String(helper)))
        broken.push(`${key}: ${row.via} names no write gate`);
    }
    expect(broken).toEqual([]);
  });

  it("every COMPUTER_RUNNER_WRITES row is served, resolves the computer, and its scope no grant carries", async () => {
    const byKey = new Map(nonGet.map((r) => [keyOf(r), r]));
    const broken: string[] = [];
    for (const [key, row] of Object.entries(COMPUTER_RUNNER_WRITES)) {
      const r = byKey.get(key);
      if (!r || !callOf(row.via).test(r.source)) {
        broken.push(`${key}: handler does not call ${row.via}`);
        continue;
      }
      const helper = (await row.load())[row.via];
      const src = typeof helper === "function" ? String(helper) : "";
      // The CHECK, not a mention (the refusal text names the scope too):
      // `hasScope(scopes, HOST_RUNNER_SCOPE)`, as the test transform writes
      // it: `(0,__vite_ssr_import_6__.hasScope)(scopes,
      // (0,__vite_ssr_import_3__.HOST_RUNNER_SCOPE))` (read 2026-11-08).
      if (
        !new RegExp(
          `\\bhasScope\\)?\\s*\\(\\s*[^,()]+,\\s*(?:\\(0,\\s*)?(?:[\\w$]+\\.)?${row.scope.name}\\b`
        ).test(src)
      )
        broken.push(`${key}: ${row.via} does not check ${row.scope.name}`);
      if (!src.includes('"NOT_A_COMPUTER"'))
        broken.push(`${key}: ${row.via} refuses no principal (NOT_A_COMPUTER)`);
      if (
        !(PRIVILEGED_MINT_SCOPES as readonly string[]).includes(row.scope.value)
      )
        broken.push(`${key}: ${row.scope.value} is not privileged at mint`);
      if (!(row.scope.value in KEY_SCOPES_NOT_DERIVED))
        broken.push(`${key}: ${row.scope.value} is derived from a key use`);
    }
    expect(broken).toEqual([]);
  });

  it("every ASK_ONLY_WRITES row is served, named by its handler, and its helper only files a pending ask", async () => {
    const byKey = new Map(nonGet.map((r) => [keyOf(r), r]));
    const broken: string[] = [];
    for (const [key, row] of Object.entries(ASK_ONLY_WRITES)) {
      const r = byKey.get(key);
      if (!r || !callOf(row.via).test(r.source)) {
        broken.push(`${key}: handler does not call ${row.via}`);
        continue;
      }
      const helper = (await row.load())[row.via];
      const src = typeof helper === "function" ? String(helper) : "";
      if (!callOf("createPendingProposal").test(src))
        broken.push(`${key}: ${row.via} files no pending proposal`);
      for (const effect of APPROVAL_EFFECTS)
        if (callOf(effect).test(src))
          broken.push(`${key}: ${row.via} applies ${effect} itself`);
    }
    expect(broken).toEqual([]);
  });

  it("every GRANT_CHECKED_DEEPER row is served, its chain holds, and it ends in a grant check", () => {
    const byKey = new Map(nonGet.map((r) => [keyOf(r), r]));
    const broken: string[] = [];
    for (const [key, row] of Object.entries(GRANT_CHECKED_DEEPER)) {
      const r = byKey.get(key);
      if (!r || !callOf(row.chain[0]!.name).test(r.source)) {
        broken.push(`${key}: handler does not call ${row.chain[0]!.name}`);
        continue;
      }
      if (!row.why.trim()) broken.push(`${key}: no reason`);
      row.chain.forEach((link, i) => {
        const def = definitionOf(link.file, link.name);
        const next = row.chain[i + 1];
        if (!def) broken.push(`${key}: ${link.file} defines no ${link.name}`);
        else if (next && !callOf(next.name).test(def))
          broken.push(`${key}: ${link.name} does not call ${next.name}`);
        else if (!next && !GRANT_CHECK.test(def))
          broken.push(`${key}: ${link.name} names no grant check`);
      });
    }
    expect(broken).toEqual([]);
  });

  it("every PERSON_SESSION_WRITES row is skipped by the auth door and reads only the person's session", () => {
    const byKey = new Map(nonGet.map((r) => [keyOf(r), r]));
    const broken: string[] = [];
    for (const [key, row] of Object.entries(PERSON_SESSION_WRITES)) {
      const r = byKey.get(key);
      if (!r || !callOf(row.via).test(r.source)) {
        broken.push(`${key}: handler does not call ${row.via}`);
        continue;
      }
      if (!hubAuthSkipped(`/api/hub${concrete(r.path)}`))
        broken.push(`${key}: the auth door does not skip it`);
      const def = definitionOf(row.file, row.via) ?? "";
      if (!/\bgetSession\)?\s*\(/.test(def))
        broken.push(`${key}: ${row.via} reads no Kratos session`);
      if (/authorization|validateApiKey|getApiKeyStatus/i.test(def))
        broken.push(`${key}: ${row.via} reads an API key`);
    }
    expect(broken).toEqual([]);
  });

  /**
   * The approve tier (R1 "T0 decide/approve", 13 routes): each one is
   * classified and checks the key's GRANT (a role check alone does not
   * count), or no key can reach it; one that is not bounded stays in the
   * baseline, named here with why (a person's app token is refused it).
   */
  const T0_APPROVE_TIER = [
    "POST /proposals/:id/approve",
    "POST /proposals/:id/reject",
    "POST /proposals/:id/revert",
    "POST /proposals/dev-approval",
    "POST /setup/agent/pending/:keyId/approve",
    "POST /setup/agent/pending/:keyId/reject",
    "POST /setup/agent/pending/approve-batch",
    "POST /skills/:id/approve",
    "POST /tools/:id/approve",
    "POST /focus-sessions/:id/revert",
    "POST /focus-sessions/:id/answers/relay",
    "POST /tracks/:id/criteria/:key/acceptance",
    "POST /tracks/:id/participants/:pid/answer",
  ];
  const T0_NOT_BOUNDED: Readonly<Record<string, string>> = {
    "POST /tracks/:id/criteria/:key/acceptance":
      "acceptGoalCriterion refuses an agent and anyone but the goal's judge, and reads no key grant: a person's app token is refused here until it does",
  };

  it("the approve tier: each route checks the key's grant, takes no key, or is named unbounded", async () => {
    const byKey = new Map(nonGet.map((r) => [keyOf(r), r]));
    const broken: string[] = [];
    for (const key of T0_APPROVE_TIER) {
      const r = byKey.get(key);
      if (!r) {
        broken.push(`${key}: not served`);
        continue;
      }
      const cls = nonGetRouteClass(r);
      if (key in T0_NOT_BOUNDED) {
        if (cls !== "unclassified")
          broken.push(
            `${key}: classified now (${cls}), drop it from T0_NOT_BOUNDED`
          );
        continue;
      }
      if (cls === "gated") {
        if (!GRANT_CHECK.test(r.source))
          broken.push(`${key}: its handler names no grant check`);
      } else if (cls === "gated-elsewhere") {
        const row = GATED_ELSEWHERE[key]!;
        const helper = (await row.load())[row.via];
        if (!GRANT_CHECK.test(String(helper)))
          broken.push(`${key}: ${row.via} names no grant check`);
      } else if (cls !== "grant-checked-deeper" && cls !== "person-session") {
        broken.push(`${key}: ${cls}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("self-check: the classifier sees gates, gated tRPC mutations and helpers", () => {
    const write = (source: string, path = "/zz-not-a-route"): ServedRoute => ({
      method: "POST",
      path,
      source,
    });
    expect(nonGetRouteClass(write("return c.json({ ok: true })"))).toBe(
      "unclassified"
    );
    expect(
      nonGetRouteClass(write("await (0, __vi_import_2__.canWrite)(p, t)"))
    ).toBe("gated");
    expect(
      nonGetRouteClass(write("await caller.entities.createEntity(input)"))
    ).toBe("gated-trpc");
    // An owner-wide or unknown tRPC mutation is not a gate.
    expect(
      nonGetRouteClass(write("await caller.channels.ensurePersonal(input)"))
    ).toBe("unclassified");
    expect(
      nonGetRouteClass(write("await caller.entities.noSuchProcedure(input)"))
    ).toBe("unclassified");
    // A GATED_ELSEWHERE row counts only while its handler calls the helper.
    expect(
      nonGetRouteClass(write("await createProjectGoverned(input)", "/projects"))
    ).toBe("gated-elsewhere");
    expect(
      nonGetRouteClass(write("await somethingElse(input)", "/projects"))
    ).toBe("unclassified");
    // A COMPUTER_RUNNER_WRITES row counts only while its handler resolves the computer.
    expect(
      nonGetRouteClass(
        write("const who = await resolveHostRunner(c)", "/host-jobs/lease")
      )
    ).toBe("computer-runner");
    expect(
      nonGetRouteClass(write("return c.json({ ok: true })", "/host-jobs/lease"))
    ).toBe("unclassified");
    // An ASK_ONLY_WRITES row counts only while its handler calls the helper.
    expect(
      nonGetRouteClass(
        write("await fileAppAccessAsk(input)", "/apps/access-requests")
      )
    ).toBe("ask-only");
    expect(
      nonGetRouteClass(write("return c.json({})", "/apps/access-requests"))
    ).toBe("unclassified");
    // A declared read is a read, whatever its source.
    expect(nonGetRouteClass(write("", "/packages/preflight"))).toBe("read");
    // A GRANT_CHECKED_DEEPER row counts only while its handler calls the chain's head.
    expect(
      nonGetRouteClass(
        write("await caller.approve({ proposalId })", "/proposals/:id/approve")
      )
    ).toBe("grant-checked-deeper");
    expect(
      nonGetRouteClass(write("return c.json({})", "/proposals/:id/approve"))
    ).toBe("unclassified");
    // A PERSON_SESSION_WRITES row counts only while its handler resolves the person.
    expect(
      nonGetRouteClass(
        write(
          "const id = await resolveKratosPodUserId(c)",
          "/setup/agent/pending/approve-batch"
        )
      )
    ).toBe("person-session");
    expect(
      nonGetRouteClass(
        write("return c.json({})", "/setup/agent/pending/approve-batch")
      )
    ).toBe("unclassified");
  });

  it("self-check: a chain link is read from its file, and a role check is not a grant check", () => {
    expect(definitionOf("routers/proposals.ts", "approve")).toMatch(
      /^ {2}approve: \w*[pP]rocedure/
    );
    expect(definitionOf("routers/proposals.ts", "noSuchProcedure")).toBeNull();
    // The definition stops at its end: approve's segment does not run into reject's.
    expect(definitionOf("routers/proposals.ts", "approve")).not.toMatch(
      /^ {2}reject: /m
    );
    expect(GRANT_CHECK.test("await grantWriteDenial({ subjectType })")).toBe(
      true
    );
    expect(
      GRANT_CHECK.test("await (0, __vi_import_1__.checkPermissionOrPropose)(p)")
    ).toBe(true);
    expect(GRANT_CHECK.test("await canWrite(p, { workspace })")).toBe(false);
    expect(GRANT_CHECK.test("await assertWorkspaceWrite(db, u, w)")).toBe(
      false
    );
  });
});

/**
 * A1 step 1 (plan a640c5bb, 18 Nov 2026): the Hub fence refuses a person's
 * app token (`app_person`) exactly the routes still in the write baseline,
 * derived from the served routes: every baselined route is refused (at its
 * concrete path), and no other served write is caught by a baseline pattern
 * (a param segment of a baselined route swallowing a classified static one).
 */
describe("the fence refuses a person's app token exactly the unclassified writes", () => {
  const nonGet = servedRoutes().filter(
    (r) => r.method !== "GET" && r.method !== "HEAD"
  );
  const baseline = new Set(UNCLASSIFIED_WRITE_ROUTES);
  const keyOf = (r: ServedRoute) => `${r.method} ${r.path}`;

  it("sees the baseline and the classified writes (non-vacuity)", () => {
    expect(nonGet.filter((r) => baseline.has(keyOf(r))).length).toBe(
      UNCLASSIFIED_WRITE_ROUTES.length
    );
    expect(
      nonGet.filter((r) => !baseline.has(keyOf(r))).length
    ).toBeGreaterThan(100);
  });

  it("refuses every baselined route", () => {
    expect(
      nonGet
        .filter((r) => baseline.has(keyOf(r)))
        .filter((r) => appPersonWriteAllowed(r.method, concrete(r.path)))
        .map(keyOf)
    ).toEqual([]);
  });

  it("lets every other served write through (no baseline pattern catches it)", () => {
    expect(
      nonGet
        .filter((r) => !baseline.has(keyOf(r)))
        .filter((r) => !appPersonWriteAllowed(r.method, concrete(r.path)))
        .map(keyOf)
    ).toEqual([]);
  });

  it("rules on the method and the whole path", () => {
    expect(appPersonWriteAllowed("POST", "/workspaces/ws-1/purge")).toBe(false);
    expect(appPersonWriteAllowed("post", "/workspaces/ws-1/purge/")).toBe(
      false
    );
    expect(appPersonWriteAllowed("GET", "/workspaces/ws-1/purge")).toBe(true);
    expect(appPersonWriteAllowed("POST", "/workspaces/ws-1/purge/x")).toBe(
      true
    );
    expect(appPersonWriteAllowed("POST", "/proposals/p-1/approve")).toBe(true);
  });
});

/** Is a served GET route classified by the fence (any bound, REFUSED too)? */
export function getRouteClassified(path: string): boolean {
  const p = concrete(path);
  return (
    GRANT_SAFE_REST_READS.some((r) => r.test(p)) ||
    GRANT_REST_GET_READS.some(([r]) => r.test(p)) ||
    GRANT_OWNER_WIDE_REST_DOORS.some((r) => r.test(p))
  );
}

describe("Hub REST GET routes are classified (derived from the served routes)", () => {
  const gets = servedRoutes().filter((r) => r.method === "GET");
  const keyOf = (r: ServedRoute) => `${r.method} ${r.path}`;
  const unclassified = gets
    .filter((r) => !getRouteClassified(r.path))
    .map(keyOf)
    .sort();

  it("sees the served GET routes, classified and not (non-vacuity)", () => {
    expect(gets.length).toBeGreaterThan(150);
    const keys = gets.map(keyOf);
    // The doors whose missing classification cost a finding are served and
    // now classified (3122ba42, cce86e6b, 7da9c21f, and the skill doors).
    for (const k of [
      "GET /capabilities/catalog",
      "GET /discover",
      "GET /memory",
      "GET /agent-skills/by-slug/:slug",
      "GET /cells",
    ]) {
      expect(keys, k).toContain(k);
      expect(unclassified, k).not.toContain(k);
    }
    expect(gets.length - unclassified.length).toBeGreaterThanOrEqual(50);
  });

  it("a new GET route is classified: a safe read, a declared read door, or owner-wide", () => {
    const baseline = new Set(UNCLASSIFIED_READ_ROUTES);
    expect(
      unclassified.filter((k) => !baseline.has(k)),
      "Classify the route in access/grant-door-fence.ts: GRANT_SAFE_REST_READS " +
        "when it reads only through a seam, else GRANT_REST_GET_READS with the " +
        "subjects it reads (READS), the narrowing its route does (NARROWED), the " +
        "person's own rows (PERSON), or REFUSED with the reason. Never add it to " +
        "the baseline."
    ).toEqual([]);
  });

  it("the read baseline only shrinks: no classified, gone or duplicate row, under its cap", () => {
    const now = new Set(unclassified);
    expect(
      UNCLASSIFIED_READ_ROUTES.filter((k) => !now.has(k)),
      "Classified or no longer served: remove it from grant-door-read-baseline.ts " +
        "and lower UNCLASSIFIED_READ_ROUTES_CAP."
    ).toEqual([]);
    expect(new Set(UNCLASSIFIED_READ_ROUTES).size).toBe(
      UNCLASSIFIED_READ_ROUTES.length
    );
    expect(UNCLASSIFIED_READ_ROUTES.length).toBeLessThanOrEqual(
      UNCLASSIFIED_READ_ROUTES_CAP
    );
  });

  it("self-check: the classifier tells a classified GET from an unclassified one", () => {
    expect(getRouteClassified("/entities/:id")).toBe(true); // safe read
    expect(getRouteClassified("/workspaces")).toBe(true); // declared READS
    expect(getRouteClassified("/errors/:requestId")).toBe(true); // REFUSED
    expect(getRouteClassified("/calendar/feed")).toBe(true); // owner-wide
    expect(getRouteClassified("/zz-not-a-route")).toBe(false);
    expect(getRouteClassified("/agent-skills/executable")).toBe(false);
  });
});
