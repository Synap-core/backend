/**
 * failure-empty-detector.mjs — THE detector of a failure that becomes empty.
 * =========================================================================
 *
 * The product rule (`rules/start-here`, "An EMPTY result and a FAILED read are
 * different facts"): a reader that cannot tell a failed read from an empty one
 * guesses "empty", and a broken lookup renders as a calm, wrong screen. This
 * module finds the code shape that does it: a failure handler whose only
 * outcome is an empty value or nothing.
 *
 * ONE copy, mirrored byte for byte (decision F12, plan 87ebac54):
 *   - source: synap-app `packages/design-tokens/scripts/failure-empty-detector.mjs`
 *   - mirror: synap-intelligence-service
 *     `apps/intelligence-hub/src/failure-empty-detector.mjs`
 * A mirror tripwire in each repo fails on any difference. Edit the source,
 * copy it, commit both. Self-contained on purpose: it imports `typescript`
 * only, and every repo-specific choice (roots, baseline) stays in the caller.
 *
 * A SITE is one of:
 *   - `<x>.catch(handler)` where the handler is a swallow (below);
 *   - `try { … } catch { … }` whose catch block is a swallow.
 * A handler or catch block is a SWALLOW when every top-level statement is a
 * log call or `return` with nothing or an EMPTY value: `undefined`, `null`,
 * `void 0`, `[]`, `{}`, `false`, `0`, `""`, ``. A LOG call is a method on a
 * logger receiver (`console`, `log`, `logger`, `Sentry`, a camelCase `…Log` /
 * `…Logger` anywhere on the chain: `this.logger.warn`, `agentLogger.error`)
 * or a bare `captureException(…)`. `toast.error`, `observer.error`,
 * `ctrl.error`, `haptic.error` are NOT logs: they tell someone, so the site is
 * handled. Any other statement (set an error state, rethrow, an `if`) means
 * the failure is handled, and the site is not counted. `.catch(noop)` and
 * `.catch(console.error)` (a named no-op or a bare logger) are swallows too.
 * Both classes count (decision F10): a SILENT swallow and a LOGGED one, since
 * a log does not change what the person sees. `logged` tells them apart.
 *
 * NOT COUNTED:
 *   - a site justified by `// empty-ok: <reason>` on the line above the swallow
 *     itself (decision F11): above its `catch` line, or above the first line of
 *     the `.catch` call or the `try`. Never above an enclosing statement: a
 *     marker over `create((set) => ({…}))` or `useQuery({…})` does not cover a
 *     swallow inside it on another line. One marker justifies ONE site; a
 *     second swallow on the same line still counts. An empty reason justifies
 *     nothing: the site counts, and the marker is reported in `emptyReasons`;
 *   - a parse / storage / URL site: the guarded code (try block, or the
 *     receiver of `.catch`) reads JSON.parse, local/session/AsyncStorage,
 *     `new URL`, URI or base64 coding, or `fs`, and nothing network-like
 *     (fetch, trpc, hub, client, api, sdk, axios, `.query(`, `.mutate`, `db.`).
 *     Inside a react-query `queryFn` this filter never applies.
 *
 * DOES NOT SEE (pinned at 0 by the self-check's "blind spot" entry below, so
 * closing one shows there):
 *   - `?? []` / `?? fallback` on a read, or `data ?? []` while `isError`;
 *   - a catch that SETS an empty state (`catch { setItems([]) }`), or any
 *     statement other than a log or a return;
 *   - a handler returning a non-empty default (`{ items: [] }`, `DEFAULTS`)
 *     or `continue` in a loop;
 *   - a parse/storage site whose network call has a name the filter does not
 *     know (`JSON.parse(await request(u))`): filtered out as a parse;
 *   - a swallow inside a helper (`safeFetch`, `tryOr`) or a named handler
 *     other than `noop`;
 *   - whether a justification is true: only that one was written.
 */

import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Compared with whitespace removed (`void 0` reads `void0`). */
const EMPTY_TEXT = new Set([
  "undefined",
  "null",
  "void0",
  "[]",
  "{}",
  "false",
  "0",
  '""',
  "''",
  "``",
]);

const LOG_METHODS = new Set([
  "log",
  "warn",
  "error",
  "info",
  "debug",
  "trace",
  "captureException",
]);
/** A receiver name that reads as a logger: `console`, `log`, `logger`,
 * `Sentry`, or a camelCase `…Log` / `…Logger` (`agentLogger`, `authLog`; not
 * `dialog`). `toast.error`, `observer.error`, `haptic.error` are not logs. */
const isLoggerName = (s) =>
  /^(console|log|logger|sentry)$/i.test(s) || /[a-z0-9_]Log(?:ger)?$/.test(s);

const NETWORK_RE =
  /\bfetch\s*\(|trpc|\bhub\w*\s*[.(]|\.query\s*\(|\.mutate|\.fetch\s*\(|\bclient\.|\bapi\.|[a-z]Fetch\s*\(|\bdb\.|\baxios\b|\bsdk\./i;
const LOCAL_RE =
  /JSON\.parse|localStorage|sessionStorage|AsyncStorage|\bnew URL\s*\(|decodeURI|encodeURI|\batob\s*\(|\bbtoa\s*\(|\bfs\.|readFileSync|statSync|existsSync|readdirSync/;

const EMPTY_OK_RE = /^\s*\/\/\s*empty-ok:(.*)$/;

/** True when an expression is one of the EMPTY values. */
function isEmptyValue(e) {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x))
    x = x.expression;
  return EMPTY_TEXT.has(x.getText().replace(/\s+/g, ""));
}

/** True when `x.y.z` (the receiver of a method) names a logger anywhere. */
function isLoggerReceiver(r) {
  while (ts.isPropertyAccessExpression(r)) {
    if (isLoggerName(r.name.text)) return true;
    r = r.expression;
  }
  return ts.isIdentifier(r) && isLoggerName(r.text);
}

/** `console.warn(…)`, `log.error(…)`, `this.logger.info(…)`, `Sentry.captureException(…)`. */
function isLogCall(e) {
  if (!ts.isCallExpression(e)) return false;
  const c = e.expression;
  if (ts.isIdentifier(c)) return c.text === "captureException";
  return ts.isPropertyAccessExpression(c) && isLoggerReceiver(c.expression);
}

/**
 * A block is a swallow when it only logs and returns nothing or empty.
 * @returns {{logged: boolean} | null}
 */
function blockSwallow(block) {
  let logged = false;
  for (const s of block.statements) {
    if (ts.isEmptyStatement(s)) continue;
    if (ts.isExpressionStatement(s)) {
      let e = s.expression;
      if (ts.isVoidExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
      if (isLogCall(e)) {
        logged = true;
        continue;
      }
      return null;
    }
    if (ts.isReturnStatement(s)) {
      if (!s.expression || isEmptyValue(s.expression)) continue;
      return null;
    }
    return null;
  }
  return { logged };
}

/** The `.catch(…)` argument as a swallow, or null. */
function handlerSwallow(fn) {
  if (ts.isIdentifier(fn)) return fn.text === "noop" ? { logged: false } : null;
  if (ts.isPropertyAccessExpression(fn))
    return LOG_METHODS.has(fn.name.text) && isLoggerReceiver(fn.expression)
      ? { logged: true }
      : null;
  if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return null;
  const b = fn.body;
  if (ts.isBlock(b)) return blockSwallow(b);
  if (isLogCall(b)) return { logged: true };
  return isEmptyValue(b) ? { logged: false } : null;
}

function isQueryFnProperty(n) {
  return (
    (ts.isPropertyAssignment(n) || ts.isMethodDeclaration(n)) &&
    n.name &&
    ts.isIdentifier(n.name) &&
    n.name.text === "queryFn"
  );
}

/**
 * Every failure-as-empty site in one source file.
 * @param {string} fileName - decides TS vs TSX parsing by its extension
 * @param {string} text
 * @returns {{sites: Array<{line: number, kind: "catch-call" | "try-catch", logged: boolean, queryFn: boolean, justified: boolean}>, emptyReasons: number[]}}
 */
export function findFailureEmptySites(fileName, text) {
  // A file with no `catch` has no site: skip the parse (most files).
  if (!text.includes("catch")) return { sites: [], emptyReasons: [] };
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const lines = text.split("\n");
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  /** Reason on the line above 1-based `line`: string, "" (empty), or null. */
  const reasonAbove = (line) => {
    const m = line >= 2 ? EMPTY_OK_RE.exec(lines[line - 2]) : null;
    return m ? m[1].trim() : null;
  };
  const sites = [];
  const emptyReasons = new Set();
  /** Marker lines already spent: one marker justifies ONE site. */
  const spent = new Set();

  const record = (kind, swallow, guarded, inQueryFn, candidateLines) => {
    const guardedText = guarded.getText(sf);
    if (
      !inQueryFn &&
      LOCAL_RE.test(guardedText) &&
      !NETWORK_RE.test(guardedText)
    )
      return;
    let justified = false;
    for (const l of candidateLines) {
      const r = reasonAbove(l);
      if (r === null) continue;
      if (r === "") emptyReasons.add(l - 1);
      else if (!justified && !spent.has(l - 1)) {
        spent.add(l - 1);
        justified = true;
      }
    }
    sites.push({
      line: candidateLines[0],
      kind,
      logged: swallow.logged,
      queryFn: inQueryFn,
      justified,
    });
  };

  const visit = (n, inQueryFn) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "catch" &&
      n.arguments.length === 1
    ) {
      const swallow = handlerSwallow(n.arguments[0]);
      if (swallow)
        // The `.catch` line and the call's own first line, never the line
        // of an enclosing statement: a marker above `create((set) => ({…}))`
        // or `useQuery({…})` must not cover a swallow inside it.
        record("catch-call", swallow, n.expression.expression, inQueryFn, [
          lineOf(n.expression.name.getStart(sf)),
          lineOf(n.getStart(sf)),
        ]);
    }
    if (ts.isTryStatement(n) && n.catchClause) {
      const swallow = blockSwallow(n.catchClause.block);
      if (swallow)
        record("try-catch", swallow, n.tryBlock, inQueryFn, [
          lineOf(n.catchClause.getStart(sf)),
          lineOf(n.getStart(sf)),
        ]);
    }
    const nextInQueryFn = inQueryFn || isQueryFnProperty(n);
    ts.forEachChild(n, (c) => visit(c, nextInQueryFn));
  };
  visit(sf, false);
  return { sites, emptyReasons: [...emptyReasons].sort((a, b) => a - b) };
}

/** Unjustified sites in one file: the number a ratchet counts. */
export function countFailureEmpty(fileName, text) {
  return findFailureEmptySites(fileName, text).sites.filter((s) => !s.justified)
    .length;
}

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "storybook-static",
  ".next",
  ".turbo",
  ".git",
  ".pnpm-store",
  "scripts",
  "test",
  "tests",
  "__tests__",
  "__tripwires__",
  "__mocks__",
  "__fixtures__",
  "__screenshots__",
]);
const SKIP_FILE_RE =
  /\.(test|spec|stories)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$|\.generated\.[cm]?[jt]sx?$/;

/**
 * Non-test `.ts`/`.tsx` source under each root (a new file is scanned by
 * existing). Skips tests, stories, fixtures, scripts, declarations,
 * generated output and build folders.
 * @param {string[]} roots - absolute directories
 * @returns {string[]}
 */
export function listSourceFiles(roots) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (
        e.isFile() &&
        /\.tsx?$/.test(e.name) &&
        !SKIP_FILE_RE.test(e.name)
      ) {
        out.push(p);
      }
    }
  };
  for (const r of roots) walk(r);
  return out.sort();
}

/**
 * Count every file: the `Map<file, count>` a per-file ratchet takes.
 * @param {string[]} files - absolute paths
 * @returns {{counts: Map<string, number>, emptyReasons: string[], total: number}}
 */
export function scanFailureEmpty(files) {
  const counts = new Map();
  const emptyReasons = [];
  let total = 0;
  for (const f of files) {
    const { sites, emptyReasons: er } = findFailureEmptySites(
      f,
      readFileSync(f, "utf8")
    );
    const n = sites.filter((s) => !s.justified).length;
    if (n > 0) counts.set(f, n);
    total += n;
    for (const l of er) emptyReasons.push(`${f}:${l}`);
  }
  return { counts, emptyReasons, total };
}

/**
 * Self-check: one literal sample per shape, each with the count it must give.
 * A caller asserts every entry, so the detector going blind to ONE shape fails.
 */
export const SELF_CHECK = [
  { shape: "silent .catch(() => {})", n: 1, src: "hub.x().catch(() => {});" },
  {
    shape: "empty value .catch(() => [] | null | undefined | void 0 | {})",
    n: 5,
    src: "a().catch(() => []); b().catch(() => null); c().catch(() => undefined); d().catch(() => void 0); e().catch(() => ({}));",
  },
  {
    shape: "logged then empty .catch",
    n: 1,
    src: "f().catch((e) => { log.warn('x', e); return []; });",
  },
  {
    shape: "named no-op or bare logger handler",
    n: 2,
    src: "g().catch(noop); h().catch(console.error);",
  },
  {
    shape: "silent try/catch",
    n: 1,
    src: "async function a() { try { await api.get(); } catch {} }",
  },
  {
    shape: "logged then empty try/catch",
    n: 1,
    src: "async function a() { try { return await client.list(); } catch (e) { console.error(e); return null; } }",
  },
  {
    shape: "a storage read inside a queryFn still counts",
    n: 1,
    src: "useQuery({ queryFn: () => { try { return JSON.parse(localStorage.x); } catch { return []; } } });",
  },
  {
    shape: "an empty `// empty-ok:` reason justifies nothing",
    n: 1,
    src: "// empty-ok:\nm().catch(() => {});",
  },
  {
    shape:
      "one marker justifies ONE site (a second swallow on its line counts)",
    n: 1,
    src: "// empty-ok: presence ping\na().catch(() => {}); b().catch(() => {});",
  },
  {
    shape:
      "a marker above an enclosing statement does not cover a swallow inside it",
    n: 3,
    src: [
      "// empty-ok: store init",
      "export const useS = create((set) => ({",
      "  load: () => api.list().catch(() => []),",
      "  more: () => api.more().catch(() => null),",
      "}));",
      "// empty-ok: the list is optional",
      "const q = useQuery({",
      "  queryFn: () => api.list().catch(() => []),",
      "});",
    ].join("\n"),
  },
  {
    shape: "a parse next to an sdk or axios call is not filtered as a parse",
    n: 2,
    src: [
      "async function a() { try { return JSON.parse(await sdk.get(u)); } catch { return null; } }",
      "async function b() { try { return JSON.parse((await axios.get(u)).data); } catch { return null; } }",
    ].join("\n"),
  },
  {
    shape:
      "blind spot (DOES NOT SEE): set-empty, ?? [], non-empty default, unknown network name",
    n: 0,
    src: [
      "async function a() { try { setItems(await api.list()); } catch { setItems([]); } }",
      "const d = data ?? [];",
      "x().catch(() => ({ items: [] }));",
      "async function b() { try { return JSON.parse(await request(u)); } catch { return null; } }",
    ].join("\n"),
  },
  {
    shape:
      "NOT counted: justified, parse/storage, handled, rethrown, non-empty default, told someone",
    n: 0,
    src: [
      "// empty-ok: presence ping, cosmetic",
      "hub.ping().catch(() => {});",
      "try { v = JSON.parse(raw); } catch { v = null; }",
      "function p() { try { return JSON.parse(localStorage.k); } catch { return null; } }",
      "q().catch((e) => setError(e));",
      "async function r() { try { await fetch(u); } catch (e) { log.warn(e); throw e; } }",
      "s().catch(() => DEFAULTS);",
      "t().catch((e) => { toast(e); return []; });",
      "u().catch((e) => { toast.error(e); return []; });",
      "w().catch(observer.error);",
    ].join("\n"),
  },
];
