import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — `channels.agentConfig` is a PROMPT SURFACE, so every door that
 * accepts it is either human-only or proposal-governed.
 *
 * The IS concatenates this JSONB into the agent SYSTEM PROMPT
 * (`agents/base/agent.ts`, the `agentConfig` overlay in both the buffered and
 * streaming paths): `name` rewrites the identity line, `personality` becomes a
 * personality section, and `instructions` is appended verbatim as "Additional
 * instructions". Durable text that reaches a system prompt is a persistent
 * prompt-injection sink — the same class as a `kind:'instruction'` skill, which
 * is why the skill path is proposal-gated and had its born-APPROVED hole closed.
 *
 * The safety property today is the WRITE SURFACE, and it is currently an
 * accident of transport rather than a stated rule. This test states it:
 *
 *   • `routers/channels/crud.ts` (createChannel / updateChannel) is the only
 *     place that persists the column. tRPC authenticates by Kratos session ONLY
 *     (`context.ts` has no API-key branch), so these are human writes. Therefore
 *     crud.ts must never start using an api-key procedure.
 *   • Any OTHER file declaring an `agentConfig` input must route it through
 *     `checkPermissionOrPropose` — that is what Hub `branches.createBranch`
 *     does, so an agent-supplied overlay lands only after a human approves.
 *
 * If this fails: do NOT add your file to the allowlist. Either keep the door on
 * a Kratos-only tRPC procedure, or call `checkPermissionOrPropose` before the
 * value can reach the channels row.
 */

/** The single Kratos-only persister. Exempt from the governance-call rule. */
const KRATOS_ONLY_WRITER = "routers/channels/crud.ts";

/** Procedure builders that accept a non-Kratos (API key) identity. */
const AGENT_REACHABLE_PROCEDURES = ["scopedProcedure", "apiKeyProcedure"];

/** A zod declaration of an `agentConfig` input on some door. */
const AGENT_CONFIG_INPUT = /agentConfig:\s*z\./;

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      tsFiles(p, acc);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
  return acc;
}

function doorsAcceptingAgentConfig(): string[] {
  const srcRoot = join(process.cwd(), "src");
  return tsFiles(srcRoot)
    .filter((f) => AGENT_CONFIG_INPUT.test(readFileSync(f, "utf8")))
    .map((f) => relative(srcRoot, f).split("\\").join("/"))
    .sort();
}

describe("tripwire: channels.agentConfig is a governed prompt surface", () => {
  it("the Kratos-only persister stays Kratos-only (no api-key procedure)", () => {
    const src = readFileSync(
      join(process.cwd(), "src", KRATOS_ONLY_WRITER),
      "utf8"
    );
    // Sanity: we are looking at the file we think we are.
    expect(src).toMatch(AGENT_CONFIG_INPUT);

    const leaked = AGENT_REACHABLE_PROCEDURES.filter((p) => src.includes(p));
    expect(
      leaked,
      `${KRATOS_ONLY_WRITER} persists channels.agentConfig — the prompt-overlay ` +
        `column — and is safe only because tRPC is Kratos-session-only. It now ` +
        `references an API-key procedure builder (${leaked.join(", ")}), which ` +
        `would let an agent write a system-prompt fragment with no proposal. ` +
        `Route the agent path through checkPermissionOrPropose instead.`
    ).toEqual([]);
  });

  it("every other door accepting agentConfig routes it through checkPermissionOrPropose", () => {
    const offenders = doorsAcceptingAgentConfig()
      .filter((f) => f !== KRATOS_ONLY_WRITER)
      .filter(
        (f) =>
          !readFileSync(join(process.cwd(), "src", f), "utf8").includes(
            "checkPermissionOrPropose"
          )
      );

    expect(
      offenders,
      `These doors accept an \`agentConfig\` input but never call ` +
        `checkPermissionOrPropose: ${offenders.join(", ")}. That JSONB is ` +
        `concatenated into the agent SYSTEM PROMPT by the IS, so an ungoverned ` +
        `writer is a durable prompt-injection sink. Gate the write (mirror ` +
        `hub-protocol/branches.ts) — do not allowlist the file.`
    ).toEqual([]);
  });

  it("at least one governed agent-facing door exists (the check is not vacuous)", () => {
    // Guards against the counted-tripwire failure mode where the scan silently
    // matches nothing and the test passes over a hole.
    const doors = doorsAcceptingAgentConfig();
    expect(doors).toContain(KRATOS_ONLY_WRITER);
    expect(doors.length).toBeGreaterThan(1);
  });
});
