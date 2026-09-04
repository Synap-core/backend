import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
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
