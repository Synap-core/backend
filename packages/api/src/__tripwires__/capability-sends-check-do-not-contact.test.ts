import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  capabilityRecipientAddresses,
  recipientSignals,
} from "../services/capabilities/send-recipient-consent.js";
import {
  RECIPIENT_ADDRESSES,
  type RecipientAddress,
} from "../services/capabilities/intent-input.js";
import {
  PERSON_CONTACT_INTENTS,
  isPersonContactIntent,
} from "../services/channels/do-not-contact.js";

/**
 * GUARD: every capability verb whose intent reaches a person passes the
 * do-not-contact check (founder, 2026-11-09; finding 44a7cfb5).
 *
 * The check lives once (`services/capabilities/send-recipient-consent.ts`,
 * `refuseFlaggedCapabilityRecipient`, reading the ONE flag through
 * `readPersonDoNotContact`). Its behaviour is proven on PGlite
 * (`send-recipient-consent.pglite.test.ts`). This guard proves no send verb
 * can go around it:
 *
 *   1. The SEND VERBS are derived, never listed: every shipped catalog skill
 *      (`synap-app/packages/workspace-templates/capabilities`) and every Synap
 *      Core builtin (`ensure-synap-core.ts`) whose declared `intent` is in
 *      `PERSON_CONTACT_INTENTS`. A new send verb joins by declaring its intent.
 *   2. REACHABILITY per verb: its declared recipient parameters (`inputMap`
 *      `$to.<address>`) carry a probe value, and the REAL reader turns it into
 *      a recipient address and identity atoms the identity door looks up. A
 *      send verb whose recipient is not in its parameters must be classified
 *      in `RECIPIENT_NOT_IN_PARAMETERS` with the reason, asserted exactly (both
 *      directions).
 *   3. PLACEMENT: in `execute-capability.ts` the check runs before the gate
 *      and before a proposal is filed (`executeCapability`), and before any
 *      tier runs in the one post-gate runner (`runResolvedSkillInner`); every
 *      other real run of a skill in the api sources (`runSkill`,
 *      `executeProviderVerb`, outside a dry run) is preceded by the check in
 *      the same function.
 *
 * The loaders of the runner's row must select `intent` and `inputMap`: that
 * is a compile-time floor (`ResolvedSkillRow` declares both REQUIRED), not
 * this test.
 *
 * Does NOT cover: a code skill whose sandbox calls a provider directly
 * (`callProvider`, a raw tool call with no verb and so no intent), a raw
 * `tool` proposal replay, and the three Unipile verbs that send to a person
 * but declare no intent (`unipile_send_message`, `unipile_start_chat`,
 * `linkedin_send_first_message`): a verb with no send intent is invisible to
 * this rule by construction (see the lane's report).
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const API_SRC = resolve(here, "..");
const REPO = resolve(API_SRC, "..", "..", "..");
const MONOREPO = resolve(REPO, "..");
const CATALOG = join(
  MONOREPO,
  "synap-app",
  "packages",
  "workspace-templates",
  "capabilities"
);
const CORE_DEF = join(
  API_SRC,
  "services",
  "capabilities",
  "ensure-synap-core.ts"
);
const RUNNER = join(
  API_SRC,
  "services",
  "capabilities",
  "execute-capability.ts"
);
const CHECK = "refuseFlaggedCapabilityRecipient";

/**
 * Send verbs whose recipient is NOT named in their parameters, so the
 * capability door cannot read it; each says where the rule holds instead.
 */
const RECIPIENT_NOT_IN_PARAMETERS: Readonly<Record<string, string>> = {
  "messaging.send":
    "names the person by entity id or channel; the messaging send door (sendExternalMessage → readRecipientDoNotContact) refuses a flagged one",
  slack_send_message:
    "a Slack channel or member id, which the pod stores on no person: unresolvable, so it goes on as the send door does",
};

/** A probe value per recipient address. */
const PROBE: Readonly<Record<RecipientAddress, string>> = {
  email: "probe@example.test",
  phone: "+33600000000",
  "linkedin.providerId": "ACoProbe",
  "linkedin.publicIdentifier": "probe-slug",
  chat: "chat-probe",
  attendee: "attendee-probe",
};

interface SendVerb {
  name: string;
  intent: string;
  inputMap: unknown;
  source: string;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((c) => walk(c, visit));
}

/** A literal's value; anything else is refused, never skipped. */
function literal(e: ts.Expression, sf: ts.SourceFile): unknown {
  if (ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) {
    return literal(e.expression, sf);
  }
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    return e.text;
  }
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (e.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(e)) {
    return e.elements.map((x) => literal(x, sf));
  }
  if (ts.isObjectLiteralExpression(e)) {
    const out: Record<string, unknown> = {};
    for (const p of e.properties) {
      if (!ts.isPropertyAssignment(p)) {
        throw new Error(`unreadable member: ${p.getText(sf)}`);
      }
      const key = ts.isIdentifier(p.name)
        ? p.name.text
        : ts.isStringLiteral(p.name)
          ? p.name.text
          : null;
      if (key === null) throw new Error(`unreadable key: ${p.getText(sf)}`);
      out[key] = literal(p.initializer, sf);
    }
    return out;
  }
  throw new Error(`not a literal: ${e.getText(sf)}`);
}

function prop(
  o: ts.ObjectLiteralExpression,
  name: string
): ts.PropertyAssignment | undefined {
  return o.properties.find(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) &&
      ts.isIdentifier(p.name) &&
      p.name.text === name
  );
}

/** Synap Core builtins (`kind: "builtin"`, a literal name) declaring a send intent. */
function builtinSendVerbs(): { verbs: SendVerb[]; builtins: number } {
  const sf = parse(CORE_DEF);
  const verbs: SendVerb[] = [];
  let builtins = 0;
  walk(sf, (n) => {
    if (!ts.isObjectLiteralExpression(n)) return;
    const kind = prop(n, "kind");
    const name = prop(n, "name");
    if (
      !kind ||
      !name ||
      !ts.isStringLiteral(kind.initializer) ||
      kind.initializer.text !== "builtin" ||
      !ts.isStringLiteral(name.initializer)
    ) {
      return;
    }
    builtins += 1;
    const intent = prop(n, "intent");
    const value = intent ? literal(intent.initializer, sf) : null;
    if (!isPersonContactIntent(value)) return;
    const map = prop(n, "inputMap");
    verbs.push({
      name: name.initializer.text,
      intent: value as string,
      inputMap: map ? literal(map.initializer, sf) : null,
      source: relative(REPO, CORE_DEF),
    });
  });
  return { verbs, builtins };
}

function catalogFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...catalogFiles(full));
    else if (name.endsWith(".capability.json")) out.push(full);
  }
  return out;
}

/** Shipped catalog skills declaring a send intent. */
function catalogSendVerbs(): { verbs: SendVerb[]; skills: number } {
  const verbs: SendVerb[] = [];
  let skills = 0;
  for (const file of catalogFiles(CATALOG)) {
    const manifest = JSON.parse(readFileSync(file, "utf8")) as {
      spec?: { skills?: Array<Record<string, unknown>> };
    };
    for (const s of manifest.spec?.skills ?? []) {
      skills += 1;
      if (!isPersonContactIntent(s.intent)) continue;
      verbs.push({
        name: String(s.name),
        intent: s.intent as string,
        inputMap: s.inputMap ?? null,
        source: relative(MONOREPO, file),
      });
    }
  }
  return { verbs, skills };
}

/** Probe parameters for a verb: each declared `$to.<address>` parameter. */
function probeParameters(inputMap: unknown): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const map = (inputMap ?? {}) as { params?: Record<string, unknown> };
  for (const [param, source] of Object.entries(map.params ?? {})) {
    if (typeof source === "string" && source.startsWith("$to.")) {
      params[param] = PROBE[source.slice(4) as RecipientAddress] ?? "probe";
    }
  }
  return params;
}

/** Does a verb's run reach the check with a recipient it can look up? */
function recipientReachable(v: SendVerb): boolean {
  const addresses = capabilityRecipientAddresses(
    { intent: v.intent, inputMap: v.inputMap },
    probeParameters(v.inputMap)
  );
  return (
    addresses.length > 0 &&
    addresses.every(
      (a) => a.address === "chat" || recipientSignals(a).length > 0
    )
  );
}

/** The top-level function declaration named `name`. */
function topFunction(sf: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const fn = sf.statements.find(
    (s): s is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(s) && s.name?.text === name
  );
  if (!fn) throw new Error(`no function ${name} in ${sf.fileName}`);
  return fn;
}

/** Start of the first call of `callee` (an identifier or `x.callee`) inside `node`, or -1. */
function firstCall(node: ts.Node, sf: ts.SourceFile, callee: string): number {
  let pos = -1;
  walk(node, (n) => {
    if (pos !== -1 || !ts.isCallExpression(n)) return;
    const e = n.expression;
    const name = ts.isIdentifier(e)
      ? e.text
      : ts.isPropertyAccessExpression(e)
        ? e.name.text
        : null;
    if (name === callee) pos = n.getStart(sf);
  });
  return pos;
}

function apiSources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (
        ["node_modules", "dist", "__tests__", "__tripwires__"].includes(e.name)
      )
        continue;
      out.push(...apiSources(p));
    } else if (
      e.name.endsWith(".ts") &&
      !e.name.endsWith(".d.ts") &&
      !/\.(test|spec)\.ts$/.test(e.name)
    ) {
      out.push(p);
    }
  }
  return out;
}

/** The nearest function-like node around `node`. */
function enclosingFunction(node: ts.Node): ts.Node | null {
  for (let n = node.parent; n; n = n.parent) {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n)
    ) {
      return n;
    }
  }
  return null;
}

/** `runSkill({ …, dryRun: true })`: a preview, nothing is sent. */
function isDryRun(call: ts.CallExpression): boolean {
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
  const p = prop(arg, "dryRun");
  return !!p && p.initializer.kind === ts.SyntaxKind.TrueKeyword;
}

const RUN_DOORS = new Set(["runSkill", "executeProviderVerb"]);

describe("guard: every capability send verb passes the do-not-contact check", () => {
  const catalogSeen = existsSync(CATALOG);
  const catalog = catalogSeen ? catalogSendVerbs() : { verbs: [], skills: 0 };
  const core = builtinSendVerbs();
  const sendVerbs = [...catalog.verbs, ...core.verbs];

  it("can see the catalog it derives the send verbs from", () => {
    expect(
      catalogSeen,
      `Cannot find ${CATALOG}: this guard derives the shipped send verbs from the catalog, so it needs synap-app checked out BESIDE synap-backend.`
    ).toBe(true);
  });

  it("derives the send verbs (non-vacuous, with a literal sample)", () => {
    expect(PERSON_CONTACT_INTENTS).toEqual([
      "send_message",
      "request_connection",
    ]);
    expect(catalog.skills).toBeGreaterThan(100);
    expect(core.builtins).toBeGreaterThan(30);
    const names = sendVerbs.map((v) => v.name);
    for (const sample of [
      "gmail_send",
      "linkedin_send_invite",
      "slack_send_message",
      "messaging.send",
    ]) {
      expect(names).toContain(sample);
    }
  });

  it("every send verb's recipient reaches the check, or is classified with its reason", () => {
    const unreachable = sendVerbs
      .filter((v) => !recipientReachable(v))
      .map((v) => v.name)
      .sort();
    expect(unreachable).toEqual(
      Object.keys(RECIPIENT_NOT_IN_PARAMETERS).sort()
    );
  });

  it("every recipient address but a chat becomes an identity atom", () => {
    for (const address of RECIPIENT_ADDRESSES) {
      const signals = recipientSignals({ address, value: PROBE[address] });
      if (address === "chat") expect(signals).toEqual([]);
      else expect(signals.length, address).toBeGreaterThan(0);
    }
  });

  it("a verb whose intent is not a send carries no recipient, even with a $to map", () => {
    const gmail = sendVerbs.find((v) => v.name === "gmail_send")!;
    expect(
      capabilityRecipientAddresses(
        { intent: "fetch_record", inputMap: gmail.inputMap },
        probeParameters(gmail.inputMap)
      )
    ).toEqual([]);
  });

  it("the run core checks before the gate and before a proposal is filed", () => {
    const sf = parse(RUNNER);
    const fn = topFunction(sf, "executeCapability");
    const check = firstCall(fn, sf, CHECK);
    expect(check).toBeGreaterThan(-1);
    for (const after of ["gateCapabilityExecution", "createPendingProposal"]) {
      const pos = firstCall(fn, sf, after);
      expect(pos, after).toBeGreaterThan(-1);
      expect(check, `${CHECK} must run before ${after}`).toBeLessThan(pos);
    }
  });

  it("the one post-gate runner checks before any tier runs", () => {
    const sf = parse(RUNNER);
    const fn = topFunction(sf, "runResolvedSkillInner");
    const check = firstCall(fn, sf, CHECK);
    expect(check).toBeGreaterThan(-1);
    for (const after of [
      "resolvePodFilesAtRun",
      "handler",
      "executeProviderVerb",
      "runSkill",
    ]) {
      const pos = firstCall(fn, sf, after);
      expect(pos, after).toBeGreaterThan(-1);
      expect(check, `${CHECK} must run before ${after}`).toBeLessThan(pos);
    }
  });

  it("every other real run of a skill is preceded by the check in its function", () => {
    const unchecked: string[] = [];
    let sites = 0;
    for (const file of apiSources(API_SRC)) {
      const raw = readFileSync(file, "utf8");
      if (![...RUN_DOORS].some((d) => raw.includes(`${d}(`))) continue;
      const sf = parse(file);
      walk(sf, (n) => {
        if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression)) return;
        if (!RUN_DOORS.has(n.expression.text) || isDryRun(n)) return;
        sites += 1;
        const fn = enclosingFunction(n);
        const check = fn ? firstCall(fn, sf, CHECK) : -1;
        if (check === -1 || check > n.getStart(sf)) {
          const line =
            sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
          unchecked.push(`${relative(REPO, file)}:${line}`);
        }
      });
    }
    // The runner's two tiers and the skills router's own run.
    expect(sites).toBeGreaterThanOrEqual(3);
    expect(unchecked).toEqual([]);
  });
});
