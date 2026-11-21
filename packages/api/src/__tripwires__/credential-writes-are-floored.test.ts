/**
 * TRIPWIRE `credential-writes-are-floored` — no governance rule may execute a
 * write whose approval WIDENS A CREDENTIAL.
 *
 * WHY (ticket 370ee329): a proposal executor that declares `widensCredential`
 * makes its approval a person's act on the console, after a fresh sign-in
 * (`dispatchProposalApproval` → `assertFreshAuthentication`). When the gate
 * GRANTS such a write instead (a broad `auto` rule: `*`, a glob, an
 * `installation.*`), the door applies it itself and neither the executor nor
 * the sign-in ever runs. An agent's install ask went through exactly that way
 * under a global "always approve" rule.
 *
 * HOW (derived — nothing below lists a write):
 *  1. Parse every non-test source file of packages/api with the TypeScript
 *     compiler; every `registerProposalExecutor({ key, widensCredential: true })`
 *     is a credential write. Its key is a string, or a template of exported
 *     string constants resolved from the same sources.
 *  2. The key names the write's event key: `S/A` → `S.A`; a proposalType-only
 *     key (`capability.install`) names every governed door filed under that
 *     proposalType (`GOVERNED_WRITE_DOORS`).
 *  3. Each event key must be a non-widenable floor (`nonWidenableFloorFor`,
 *     which asks the engine itself with a rule-`auto` verdict).
 *
 * ACKNOWLEDGED GAPS are written down with the reason they are open, and the
 * test fails the day one is floored (delete it from the list then) or stops
 * being a credential write.
 *
 * WHAT IT DOES NOT SEE (stated): an executor registered through a variable
 * key (the scan fails loudly on one it cannot resolve), and a door that
 * applies a credential write WITHOUT the gate (the device-session tripwire
 * `credential-doors-refuse-device-session` owns the doors themselves).
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  GOVERNED_WRITE_DOORS,
  PROPOSAL_TYPE_ONLY_EXECUTOR_KEYS,
  decideAgentPolicy,
  nonWidenableFloorFor,
} from "@synap/governance-policy";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SRC = resolve(HERE, "..");
const SKIP = new Set(["node_modules", "dist", "__tests__", "__tripwires__"]);

/**
 * Credential writes a broad rule can still execute, each with why it is open.
 * Flooring them changes a live behaviour that needs the founder's call.
 */
const ACKNOWLEDGED_GAPS: Readonly<Record<string, string>> = {
  "tool.create":
    "The CLI `normal` preset auto-approves `tool.create` for an agent (rung 4); a floor would end that. Finding cdc41c35.",
  "workspace.adopt":
    "Classified `widenable` on purpose in AGENT_STRUCTURE_DOOR_CLASS (open question, door-g report). Finding 61ed6cb5.",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts")
    )
      out.push(full);
  }
  return out;
}

interface CredentialExecutor {
  file: string;
  key: string;
}

function scan(): { files: number; executors: CredentialExecutor[] } {
  const sources = walk(API_SRC).map((full) => ({
    rel: relative(API_SRC, full),
    sf: ts.createSourceFile(
      full,
      readFileSync(full, "utf8"),
      ts.ScriptTarget.Latest,
      true
    ),
  }));

  // Exported string constants, by name: what a template key is built from.
  const constants = new Map<string, string>();
  for (const { sf } of sources) {
    for (const stmt of sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          ts.isStringLiteralLike(decl.initializer)
        )
          constants.set(decl.name.text, decl.initializer.text);
      }
    }
  }
  const keyText = (node: ts.Expression, where: string): string => {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      let out = node.head.text;
      for (const span of node.templateSpans) {
        const id = span.expression;
        const value = ts.isIdentifier(id) ? constants.get(id.text) : undefined;
        if (value === undefined)
          throw new Error(
            `${where}: cannot resolve \`${span.expression.getText()}\` in an executor key`
          );
        out += value + span.literal.text;
      }
      return out;
    }
    throw new Error(`${where}: an executor key that is not a string`);
  };

  const executors: CredentialExecutor[] = [];
  for (const { rel, sf } of sources) {
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText() === "registerProposalExecutor" &&
        node.arguments[0] &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        const props = node.arguments[0].properties.filter(
          ts.isPropertyAssignment
        );
        const prop = (n: string) =>
          props.find((p) => ts.isIdentifier(p.name) && p.name.text === n);
        const widens =
          prop("widensCredential")?.initializer.kind ===
          ts.SyntaxKind.TrueKeyword;
        const key = prop("key");
        if (widens) {
          if (!key)
            throw new Error(`${rel}: a credential executor with no key`);
          executors.push({ file: rel, key: keyText(key.initializer, rel) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { files: sources.length, executors };
}

/** The gate event keys an executor key approves. */
function eventKeysOf(key: string): string[] {
  const slash = key.indexOf("/");
  if (slash > 0) return [`${key.slice(0, slash)}.${key.slice(slash + 1)}`];
  if (!(PROPOSAL_TYPE_ONLY_EXECUTOR_KEYS as readonly string[]).includes(key))
    throw new Error(`executor key ${key} names no door`);
  return Object.keys(GOVERNED_WRITE_DOORS)
    .filter((door) => door.slice(door.indexOf("/") + 1) === key)
    .map((door) => door.replace("/", "."));
}

const { files, executors } = scan();
const credentialKeys = [
  ...new Set(executors.flatMap((e) => eventKeysOf(e.key))),
].sort();

describe("tripwire: a write that widens a credential is a floor no rule can widen", () => {
  it("non-vacuity: the scan reads the api sources and finds the known credential executors", () => {
    expect(files).toBeGreaterThan(400);
    expect(executors.length).toBeGreaterThan(10);
    for (const known of [
      "installation.request",
      "vault.grant",
      "capability.capability.install",
      "trusted_issuer.trusted_issuer.widen_scopes",
    ])
      expect(credentialKeys).toContain(known);
  });

  it("every credential write is floored (or an acknowledged gap)", () => {
    const open = credentialKeys.filter(
      (key) => nonWidenableFloorFor(key) === null && !(key in ACKNOWLEDGED_GAPS)
    );
    expect(
      open,
      "approving these widens a credential (the executor declares `widensCredential`), " +
        "yet a governance rule could execute them and skip the executor's fresh sign-in. " +
        "Floor each in @synap/governance-policy (HUMAN_GATE_EVENT_KEYS or ADMIN_ACTIONS_LIVE)."
    ).toEqual([]);
  });

  it("a global `auto` rule never executes one (the engine, not only the predicate)", () => {
    for (const key of credentialKeys) {
      if (key in ACKNOWLEDGED_GAPS) continue;
      const dot = key.lastIndexOf(".");
      const decided = decideAgentPolicy({
        subjectType: key.slice(0, dot),
        action: key.slice(dot + 1),
        governanceRuleVerdict: "auto",
      });
      expect({ key, verdict: decided.verdict }).toEqual({
        key,
        verdict: "propose",
      });
    }
  });

  it("each acknowledged gap is still a credential write that is still open", () => {
    for (const key of Object.keys(ACKNOWLEDGED_GAPS)) {
      expect(credentialKeys, key).toContain(key);
      expect(
        nonWidenableFloorFor(key),
        `${key} is floored now: drop it from ACKNOWLEDGED_GAPS`
      ).toBeNull();
    }
  });
});
