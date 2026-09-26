import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { diesWithSession } from "./expire-lapsed-proposals.js";
import {
  classifyProposal,
  proposalLifetimeHours,
  CLASS_LIFETIME_HOURS,
  PROPOSAL_CLASSES,
  CAPABILITY_RUN_PROPOSAL_TYPE,
} from "./proposal-class.js";

const API_SRC = fileURLToPath(new URL("../..", import.meta.url));

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__tests__")
      continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (name.endsWith(".ts") && !name.includes(".test.")) yield full;
  }
}

/**
 * Every `createPendingProposal(` / `insertPendingProposal(` call in
 * packages/api/src whose argument object names `targetType: "capability"`,
 * paired with the `proposalType:` expression that call passes.
 *
 * Deliberately a SOURCE scan, not a type-level check: the defect being pinned
 * is a string literal disagreeing across files, which typechecks perfectly.
 */
function scanCapabilityProposalSites(): {
  file: string;
  proposalType: string;
}[] {
  const out: { file: string; proposalType: string }[] = [];
  for (const full of walk(API_SRC)) {
    const src = readFileSync(full, "utf8");
    const re = /(?:createPendingProposal|insertPendingProposal)\s*\(\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      // Take the call's argument object by brace matching from the `{`.
      let depth = 0;
      let end = m.index + m[0].length - 1;
      for (let i = end; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) {
          end = i;
          break;
        }
      }
      const body = src.slice(m.index, end + 1);
      if (!/targetType:\s*"capability"/.test(body)) continue;
      const pt = /proposalType:\s*([^,\n]+)/.exec(body);
      if (!pt) continue;
      out.push({
        file: full.slice(API_SRC.length).replace(/\\/g, "/"),
        proposalType: pt[1].trim(),
      });
    }
  }
  return out;
}

/**
 * The class rule decides what can be EXPIRED, so its failure mode is losing a
 * decision a human still owed. Every test here is about that direction.
 */
describe("classifyProposal", () => {
  it("classifies the four shapes present in the live queue", () => {
    // Counts measured on the team pod 2026-09-02 (660 pending).
    expect(classifyProposal("capability.run", "capability")).toBe("ephemeral"); // 441
    expect(classifyProposal("merge", "entity")).toBe("curatorial"); //  143
    expect(classifyProposal("create", "entity")).toBe("objectWork"); //  56
    expect(classifyProposal("import.graph", "entity")).toBe("objectWork"); // 12
    expect(classifyProposal("ai_edit", "document")).toBe("objectWork"); //  1
    expect(classifyProposal("governance.tighten_lane", "governance")).toBe(
      "governance"
    ); // 2
  });

  it("FAILS CLOSED — an unknown pair gets the class that never expires", () => {
    // The whole safety property. A proposal type this function has not been
    // taught must never be silently deleted by the sweeper.
    expect(classifyProposal("some_future_type", "some_future_target")).toBe(
      "objectWork"
    );
    expect(
      proposalLifetimeHours("some_future_type", "some_future_target"),
      "an unrecognised proposal must be un-expirable"
    ).toBeNull();
  });

  it("a run on something OTHER than a capability is not ephemeral", () => {
    // `proposalType === "capability.run"` alone is not enough — the pair is the key. A
    // future `run` against a different target must not inherit a 24h fuse.
    expect(classifyProposal("capability.run", "playbook")).toBe("objectWork");
    expect(proposalLifetimeHours("capability.run", "playbook")).toBeNull();
  });

  it("ONLY ephemeral has a lifetime", () => {
    const withLifetime = PROPOSAL_CLASSES.filter(
      (c) => CLASS_LIFETIME_HOURS[c] !== null
    );
    expect(
      withLifetime,
      "a class that can expire is a class that can lose a human's decision — " +
        "adding one is a product decision, not a refactor"
    ).toEqual(["ephemeral"]);
  });

  it("the ephemeral backstop outlives a working day plus a night", () => {
    // A run proposed at 6pm must still be answerable the next morning. 158 of
    // the 441 ephemeral rows carry no session, so this is their ONLY trigger.
    const h = CLASS_LIFETIME_HOURS.ephemeral!;
    expect(h).toBeGreaterThanOrEqual(16);
    expect(
      h,
      "long enough to survive a night, short enough to never become archaeology"
    ).toBeLessThanOrEqual(48);
  });

  it("classification reads only the two columns, never the payload", () => {
    // Pinned as behaviour: the same pair must classify identically regardless
    // of anything an agent could write. An agent that could nominate its own
    // class would nominate the quiet one (ATR-2026-00118, approval fatigue).
    expect(classifyProposal("merge", "entity")).toBe(
      classifyProposal("merge", "entity")
    );
    expect(
      classifyProposal.length,
      "arity is (proposalType, targetType) only"
    ).toBe(2);
  });

  it("classifies the literal EVERY capability-proposal producer writes (source scan)", () => {
    // Dogfood 2026-09-02 → review 2026-09-04. The first version of this
    // tripwire scanned ONE file (`execute-capability.ts`) and therefore
    // certified coverage it never checked: `routers/skills.ts` and
    // `connectors/external-dispatch.ts` still wrote `proposalType: "run"`, so
    // skill runs and external-dispatch runs classified `objectWork` and no
    // sweeper could ever expire them. The scan now walks EVERY
    // `createPendingProposal(` / `insertPendingProposal(` call site in
    // packages/api/src that names `targetType: "capability"`, so a fourth
    // producer cannot be added without this test seeing it.
    const sites = scanCapabilityProposalSites();

    // The producers that exist today. A NEW file appearing here is not a
    // failure by itself — but its proposalType must be classified below, and
    // an unlisted RUN producer is exactly the defect this test exists for.
    expect(
      sites.map((s) => s.file).sort(),
      "capability-proposal producers"
    ).toEqual([
      "connectors/external-dispatch.ts",
      "routers/skills.ts",
      "services/capabilities/execute-capability.ts",
      "services/capabilities/marketplace-install.ts",
    ]);

    for (const site of sites) {
      // A bare literal is the drift vector — every RUN producer must reference
      // the exported constant, not retype it.
      if (site.proposalType === "CAPABILITY_RUN_PROPOSAL_TYPE") {
        expect(
          classifyProposal(CAPABILITY_RUN_PROPOSAL_TYPE, "capability"),
          `${site.file} writes the run constant, which must be ephemeral`
        ).toBe("ephemeral");
        continue;
      }
      // Anything else must be a NON-run capability proposal. `capability.install`
      // is object work: it changes what is installed, and stays answerable.
      expect(
        site.proposalType,
        `${site.file} writes a bare proposalType literal on a capability ` +
          `proposal — if it is a RUN, import CAPABILITY_RUN_PROPOSAL_TYPE; ` +
          `"run" was the literal that made three producers disagree`
      ).toBe('"capability.install"');
      expect(classifyProposal("capability.install", "capability")).toBe(
        "objectWork"
      );
    }
  });

  it("the two producers that carried the WRONG literal now classify ephemeral", () => {
    // Regression pins, named. Both wrote `"run"` until 2026-09-04.
    // routers/skills.ts — skills.execute propose verdict.
    expect(classifyProposal(CAPABILITY_RUN_PROPOSAL_TYPE, "capability")).toBe(
      "ephemeral"
    );
    // connectors/external-dispatch.ts — Door 2 propose verdict.
    expect(
      proposalLifetimeHours(CAPABILITY_RUN_PROPOSAL_TYPE, "capability")
    ).toBe(24);
    // And the literal they USED TO write still classifies as un-expirable, so
    // rows already in the table are never retro-expired by this change.
    expect(classifyProposal("run", "capability")).toBe("objectWork");
    expect(proposalLifetimeHours("run", "capability")).toBeNull();
  });
});

/**
 * `access` — the class added 2026-09-08, after the founder's pod filed the
 * first one on 09-04 and nothing was watching the "0 instances" reading that
 * had ruled it out two days earlier.
 */
describe("classifyProposal — access", () => {
  it("the live row that forced the class: an agent asking to JOIN a workspace", () => {
    // `{ proposalType: "join", targetType: "workspace" }` — the pending row on
    // the founder's pod since 2026-09-04, "Agent Claude (Web) requests to join
    // workspace Builder as editor". It classified `objectWork` until today.
    expect(classifyProposal("join", "workspace")).toBe("access");
  });

  it("covers every membership / permission / credential / exposure door", () => {
    // Derived door-by-door from GOVERNED_WRITE_DOORS (@synap/governance-policy).
    // Listed explicitly rather than looped over the private set: a test that
    // reads the implementation's own table proves only that the table equals
    // itself.
    const accessPairs: [string, string][] = [
      ["join", "workspace"],
      ["join", "a2ai"],
      ["add", "workspaceMember"],
      ["remove", "workspaceMember"],
      ["updateRole", "workspaceMember"],
      ["create", "projectMember"],
      ["remove", "projectMember"],
      ["updateRole", "projectMember"],
      ["create", "role"],
      ["update", "role"],
      ["delete", "role"],
      ["create", "apiKey"],
      ["update", "apiKey"],
      ["delete", "apiKey"],
      ["updateCapabilities", "agent"],
      ["grant_capability", "focus_session"],
      ["vault.request", "vault"],
      ["configure_public_projection", "workspace"],
      ["expose", "relation"],
      ["create", "share"],
    ];
    for (const [proposalType, targetType] of accessPairs) {
      expect(
        classifyProposal(proposalType, targetType),
        `${targetType}/${proposalType} hands a principal a right it did not have`
      ).toBe("access");
    }
  });

  it("NEVER expires — the whole point of giving it a lane", () => {
    // An access request that silently expires deletes the only record that
    // anyone was ever asked; the agent stays blocked either way.
    expect(CLASS_LIFETIME_HOURS.access).toBeNull();
    expect(proposalLifetimeHours("join", "workspace")).toBeNull();
    expect(
      proposalLifetimeHours("grant_capability", "focus_session")
    ).toBeNull();
    // And therefore `diesWithSession`'s first arm ("a class WITH a lifetime")
    // can never select it: closing the session an agent asked from must not
    // retire the question of whether it may join at all.
    expect(diesWithSession("join", "workspace")).toBe(false);
    expect(diesWithSession("grant_capability", "focus_session")).toBe(false);
  });

  it("still reads ONLY the two columns — an agent cannot nominate the lane", () => {
    // The security property, restated for the new rule: `access` is matched on
    // the PAIR, like every rule above it. `join` alone is not enough, and a
    // payload cannot reach this function at all.
    expect(classifyProposal("join", "entity")).toBe("objectWork");
    expect(classifyProposal("create", "entity")).toBe("objectWork");
    expect(classifyProposal("updateRole", "entity")).toBe("objectWork");
    // An exposure edge is `access` only under its own verb. The same edge
    // filed as `relation/create` stays objectWork — the payload's `type`
    // (`visible_to`) is never read.
    expect(classifyProposal("expose", "relation")).toBe("access");
    expect(classifyProposal("create", "relation")).toBe("objectWork");
    expect(
      classifyProposal.length,
      "arity is still (proposalType, targetType)"
    ).toBe(2);
  });

  it("does NOT swallow the governance lane", () => {
    // `governance.widen_lane` genuinely changes who may act, and is checked
    // FIRST on purpose: it is a change to the RULE, not a grant to one
    // principal. Reclassifying it would empty a lane that already renders.
    expect(classifyProposal("governance.widen_lane", "governance")).toBe(
      "governance"
    );
    expect(classifyProposal("governance.tighten_lane", "governance")).toBe(
      "governance"
    );
  });

  it("does NOT reclassify anything that classified before it", () => {
    // The regression that matters: every pair the 09-02 measurement covered,
    // plus the sensitive-but-not-access doors deliberately left out. A silent
    // reclassification of a live row is how a lane empties without anyone
    // noticing.
    const unchanged: [string, string, string][] = [
      ["capability.run", "capability", "ephemeral"],
      ["merge", "entity", "curatorial"],
      ["create", "entity", "objectWork"],
      ["import.graph", "entity", "objectWork"],
      ["capture.graph", "entity", "objectWork"],
      ["ai_edit", "document", "objectWork"],
      ["user_edit", "document", "objectWork"],
      ["governance.tighten_posture", "governance", "governance"],
      ["run", "capability", "objectWork"],
      ["capability.install", "capability", "objectWork"],
      // EXCLUDED ON PURPOSE — destructive and admin-floored, but approving one
      // grants nobody anything. "Sensitive" is not the test; "hands a principal
      // a right" is.
      ["delete", "workspace", "objectWork"],
      ["update", "workspace", "objectWork"],
      ["delete", "entity", "objectWork"],
      ["delete", "project", "objectWork"],
      // Tool/skill provisioning changes what the workspace CAN do, not who may.
      ["create", "tool", "objectWork"],
      ["attach", "capability", "objectWork"],
      ["create", "skill", "objectWork"],
      // Human gates about WORK, not access.
      ["dev.plan_approval", "focus_session", "objectWork"],
      ["dev.deploy_approval", "focus_session", "objectWork"],
      ["playbook.stage_gate", "focus_session", "objectWork"],
    ];
    for (const [proposalType, targetType, expected] of unchanged) {
      expect(
        classifyProposal(proposalType, targetType),
        `${targetType}/${proposalType} must keep the class it had before access existed`
      ).toBe(expected);
    }
  });

  it("adding access did not give a second class a lifetime", () => {
    // Mirrors the pre-existing "ONLY ephemeral has a lifetime" pin, re-asserted
    // because a new class is exactly when that invariant would break.
    expect(
      PROPOSAL_CLASSES.filter((c) => CLASS_LIFETIME_HOURS[c] !== null)
    ).toEqual(["ephemeral"]);
    expect(PROPOSAL_CLASSES).toContain("access");
  });
});
