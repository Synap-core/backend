import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * GUARD: every message that leaves the pod through a messaging connector
 * passes the do-not-contact check first (founder, 2026-11-09).
 *
 * The check lives once, in the send door (`sendExternalMessage`,
 * `connectors/external-dispatch.ts`, `readRecipientDoNotContact`). The
 * behaviour is proven on PGlite (`connectors/channel-send.pglite.test.ts`,
 * "do not contact"). This guard proves no send can go around it:
 *
 *   1. The SENDING methods are derived from the `MessagingConnector` interface
 *      (every method that takes a `body`), never hand-listed: a new outward
 *      method joins the scan by existing.
 *   2. Every call of one of them in the api and app sources (a call with the
 *      interface's argument count; the intelligence client's one-object
 *      `sendMessage(req)` is another method) must sit in
 *      `connectors/external-dispatch.ts`, in code that runs only AFTER the
 *      check: inside `sendExternalMessage` past the check, or in a helper
 *      every caller of which is (followed through helpers, recursively).
 *
 * Does NOT cover: a connector method called through a computed name or an
 * alias (`const f = connector.sendMessage`), and capability verbs that send
 * through a provider action or a skill sandbox (`gmail_send`), which never
 * reach a messaging connector (see the lane's finding).
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const API_SRC = resolve(here, "..");
const REPO = resolve(API_SRC, "..", "..", "..");
const ROOTS = [API_SRC, join(REPO, "apps", "api", "src")];
const INTERFACE_FILE = join(API_SRC, "connectors", "MessagingConnector.ts");
const DOOR_FILE = join(API_SRC, "connectors", "external-dispatch.ts");
const DOOR_FN = "sendExternalMessage";
const CHECK_CALL = "readRecipientDoNotContact";

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

/** method name → parameter count, for each interface method that takes a `body`. */
function sendingMethods(): Map<string, number> {
  const sf = parse(INTERFACE_FILE);
  const out = new Map<string, number>();
  walk(sf, (n) => {
    if (ts.isInterfaceDeclaration(n) && n.name.text === "MessagingConnector") {
      for (const m of n.members) {
        if (!ts.isMethodSignature(m) || !ts.isIdentifier(m.name)) continue;
        const names = m.parameters.map((p) => p.name.getText(sf));
        if (names.includes("body")) out.set(m.name.text, names.length);
      }
    }
  });
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      out.push(...sourceFiles(p));
    } else if (
      e.name.endsWith(".ts") &&
      !e.name.endsWith(".d.ts") &&
      !/\.(test|spec)\.ts$/.test(e.name) &&
      !p.includes("__tripwires__") &&
      !p.includes("__tests__")
    ) {
      out.push(p);
    }
  }
  return out;
}

/** The called method's name when the call is `x.m(...)` or `x.m!(...)`. */
function calledMethod(call: ts.CallExpression): string | null {
  let e: ts.Expression = call.expression;
  if (ts.isNonNullExpression(e)) e = e.expression;
  return ts.isPropertyAccessExpression(e) ? e.name.text : null;
}

/** The top-level function declaration a node sits in, or null. */
function enclosingTopFunction(node: ts.Node): ts.FunctionDeclaration | null {
  let fn: ts.FunctionDeclaration | null = null;
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && ts.isSourceFile(n.parent)) fn = n;
  }
  return fn;
}

interface Site {
  file: string;
  line: number;
  node: ts.Node;
  sf: ts.SourceFile;
}

function connectorSendSites(methods: Map<string, number>): Site[] {
  const sites: Site[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      // Parse only a file that names a sending method at all (speed); the
      // AST then decides what is a call of it.
      const raw = readFileSync(file, "utf8");
      if (![...methods.keys()].some((m) => raw.includes(m))) continue;
      const sf = parse(file);
      walk(sf, (n) => {
        if (!ts.isCallExpression(n)) return;
        const m = calledMethod(n);
        if (!m || !methods.has(m)) return;
        if (n.arguments.length !== methods.get(m)) return;
        sites.push({
          file,
          line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          node: n,
          sf,
        });
      });
    }
  }
  return sites;
}

/** Position of the do-not-contact check inside the door, or -1. */
function checkPosition(door: ts.SourceFile): number {
  let pos = -1;
  walk(door, (n) => {
    if (
      pos === -1 &&
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === CHECK_CALL &&
      enclosingTopFunction(n)?.name?.text === DOOR_FN
    ) {
      pos = n.getStart(door);
    }
  });
  return pos;
}

/**
 * Does code at `node` run only after the check? In the door past the check,
 * or in a helper every call of which does (recursively; a helper with no
 * caller in the file, or exported, is NOT covered).
 */
function runsAfterCheck(
  door: ts.SourceFile,
  node: ts.Node,
  checkPos: number,
  seen = new Set<string>()
): boolean {
  const fn = enclosingTopFunction(node);
  const name = fn?.name?.text;
  if (!fn || !name) return false;
  if (name === DOOR_FN) return checkPos >= 0 && node.getStart(door) > checkPos;
  if (fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
    return false;
  }
  if (seen.has(name)) return true;
  seen.add(name);
  const callers: ts.Node[] = [];
  walk(door, (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === name
    ) {
      callers.push(n);
    }
  });
  return (
    callers.length > 0 &&
    callers.every((c) => runsAfterCheck(door, c, checkPos, seen))
  );
}

describe("guard: every messaging-connector send passes the do-not-contact check", () => {
  const methods = sendingMethods();
  const sites = connectorSendSites(methods);
  const door = parse(DOOR_FILE);
  const checkPos = checkPosition(door);

  it("derives the sending methods from the connector interface (non-vacuous)", () => {
    expect(methods.get("sendMessage")).toBe(3);
    expect(methods.get("startChat")).toBe(3);
  });

  it("finds the door's own sends and the check (non-vacuous)", () => {
    expect(checkPos).toBeGreaterThan(-1);
    const inDoor = sites.filter((s) => s.file === DOOR_FILE);
    // The thread send, the channel send into a chat, the chat start.
    expect(inDoor.length).toBeGreaterThanOrEqual(3);
    expect(
      sites.some(
        (s) =>
          s.file === DOOR_FILE && s.node.getText(s.sf).includes("startChat")
      )
    ).toBe(true);
  });

  it("no connector send outside the send door", () => {
    const outside = sites
      .filter((s) => s.file !== DOOR_FILE)
      .map((s) => `${relative(REPO, s.file)}:${s.line}`);
    expect(outside).toEqual([]);
  });

  it("every send in the door runs after the check", () => {
    const before = sites
      .filter((s) => s.file === DOOR_FILE)
      .filter((s) => !runsAfterCheck(door, s.node, checkPos))
      .map((s) => `${relative(REPO, s.file)}:${s.line}`);
    expect(before).toEqual([]);
  });
});
