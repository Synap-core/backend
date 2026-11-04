/**
 * Tripwire (pod resilience plan P6): every background starter declares the
 * process roles it runs in.
 *
 * A split pod runs the same image twice (SYNAP_PROCESS_ROLE=api and =worker).
 * Something the entry point starts on its own (a timer, a LISTEN, a cron
 * registration, a boot backfill, a reactor) would run in BOTH processes: a
 * double notification, a second cron clock, a writer racing itself. So the
 * entry point starts nothing itself: every starter is a row of
 * `process-role/background-starters.ts`, which must name its roles.
 *
 * What it derives, from source (TypeScript's parser, not a regex):
 *  A. index.ts makes no STARTER-SHAPED call outside the table: a call to a
 *     function named start…, register…, warm…, backfill… or retire…, a `.start()`,
 *     `setInterval`/`setTimeout`, or a module-level `void <call>`. Allowed:
 *     a call whose first argument is the HTTP `app` (a route mount, e.g.
 *     registerInviteBounce(app)) and the runner `startBackground` itself.
 *  B. every side-effect reactor packages/api exports (`register*Reactor`) is
 *     registered by the table's reactors starter: a new reactor is wired once,
 *     in the starter that runs in both processes.
 * Non-vacuity: the scanner sees a literal sample of each starter shape, and
 * the scans found the runner call, the route mounts and ≥ 9 reactors.
 *
 * NOT covered: a starter hidden in a module index.ts imports (module-level
 * code of an imported file runs in every role: e.g. the per-process cache GC
 * intervals of hub-protocol-rate-limit.ts, ai-rate-limit.ts, ws-auth.ts; they
 * are per-process state, harmless in two processes), a starter called through
 * a renamed alias, and whether a row's roles are RIGHT (the role switch test,
 * process-role/background-starters.test.ts, pins those).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "..");
const PKG_API_SRC = resolve(__dirname, "../../../../packages/api/src");
const INDEX = join(SRC, "index.ts");
const STARTERS = join(SRC, "process-role/background-starters.ts");

const STARTER_NAME = /^(start|register|warm|backfill|retire)[A-Z]\w*$/;
const TIMERS = new Set(["setInterval", "setTimeout"]);
const ALLOWED_CALLEES = new Set(["startBackground"]);

interface Hit {
  line: number;
  text: string;
}

function calleeName(
  expr: ts.Expression
): { name: string; member: boolean } | null {
  if (ts.isIdentifier(expr)) return { name: expr.text, member: false };
  if (ts.isPropertyAccessExpression(expr))
    return { name: expr.name.text, member: true };
  return null;
}

/** Every starter-shaped call in `source` that is not an allowed one. */
function starterCalls(source: string, file = "x.ts"): Hit[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const hits: Hit[] = [];
  const at = (n: ts.Node) => ({
    line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
    text: n.getText(sf).split("\n")[0]!.slice(0, 120),
  });
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const c = calleeName(n.expression);
      const firstArg = n.arguments[0];
      const mountsApp =
        !!firstArg && ts.isIdentifier(firstArg) && firstArg.text === "app";
      if (c && !ALLOWED_CALLEES.has(c.name) && !mountsApp) {
        const shaped =
          (!c.member && (STARTER_NAME.test(c.name) || TIMERS.has(c.name))) ||
          (c.member && (c.name === "start" || STARTER_NAME.test(c.name)));
        if (shaped) hits.push(at(n));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  // A module-level fire-and-forget: `void <call>` as a top-level statement.
  for (const st of sf.statements) {
    if (!ts.isExpressionStatement(st) || !ts.isVoidExpression(st.expression))
      continue;
    const inner = st.expression.expression;
    const c = ts.isCallExpression(inner) ? calleeName(inner.expression) : null;
    if (c && ALLOWED_CALLEES.has(c.name)) continue;
    hits.push(at(st));
  }
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === "node_modules" || e === "__tests__" || e === "__tripwires__")
        continue;
      walk(p, out);
    } else if (p.endsWith(".ts") && !/\.(test|spec)\.ts$/.test(p)) out.push(p);
  }
  return out;
}

describe("background starters declare their process role", () => {
  it("the scanner sees each starter shape (non-vacuity)", () => {
    const sample = [
      "registerFooReactor();",
      "startThing().catch(() => undefined);",
      "void doLater();",
      "setInterval(() => undefined, 1000);",
      "watch.start();",
      "registerInviteBounce(app);",
      "void startBackground(ctx, 'boot');",
      "app.get('/health', () => undefined);",
    ].join("\n");
    const hits = starterCalls(sample).map((h) => h.text);
    expect(hits).toEqual([
      "registerFooReactor()",
      "startThing()",
      "setInterval(() => undefined, 1000)",
      "watch.start()",
      "void doLater();",
    ]);
  });

  it("A: index.ts starts nothing outside the starters table", () => {
    const src = readFileSync(INDEX, "utf8");
    expect(src).toMatch(/startBackground\(starterContext, "listening"\)/);
    expect(src).toMatch(/void startBackground\(starterContext, "boot"\)/);
    expect(src).toMatch(/registerInviteBounce\(app\)/); // a route mount the scan allows
    const hits = starterCalls(src, INDEX);
    expect(
      hits,
      "index.ts starts background work outside process-role/background-starters.ts — " +
        "add it to BACKGROUND_STARTERS with the roles it runs in:\n" +
        hits.map((h) => `  index.ts:${h.line} ${h.text}`).join("\n")
    ).toEqual([]);
  });

  it("B: every register*Reactor of packages/api is registered by the reactors starter", () => {
    const reactors = new Set<string>();
    for (const f of walk(PKG_API_SRC)) {
      for (const m of readFileSync(f, "utf8").matchAll(
        /^export (?:async )?function (register\w+Reactor)\s*\(/gm
      )) {
        reactors.add(m[1]!);
      }
    }
    expect(reactors.size).toBeGreaterThanOrEqual(9);
    const starters = readFileSync(STARTERS, "utf8");
    const block = starters.slice(
      starters.indexOf('key: "side-effect-reactors"'),
      starters.indexOf('key: "local-sync-driver"')
    );
    expect(block.length).toBeGreaterThan(100);
    const missing = [...reactors].filter((r) => !block.includes(`api.${r}()`));
    expect(
      missing,
      "reactors exported by packages/api but not registered by the side-effect-reactors starter"
    ).toEqual([]);
  });
});
