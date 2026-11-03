/**
 * TEST-ONLY response validation for Hub REST (hub schema drift finder, R0).
 *
 * `registerOpenApi` documents a route's 2xx response with a zod schema but the
 * handler is a separate `app.get(...)`, so nothing ties the two together: a
 * handler can drop or add a field and the spec still looks right (`/work-release`
 * lost `pullRequests`, backend#656; entities dropped `status`, backend#667).
 *
 * Installed ONLY by `hub-response-drift.tripwire.test.ts`, on the app it builds
 * (no vitest setup file: a global check would make other sessions' tests red
 * on their hand-written mocks, which are not production bodies). For every
 * request that app serves, it looks the route up in the app's own OpenAPI
 * registry and, when a 2xx JSON response schema is registered for the status,
 * checks the body against it:
 *   - zod `safeParse` failures (missing / wrongly typed field), and
 *   - keys the body carries that the schema does not declare (zod strips them,
 *     so a bare `safeParse` would never see them).
 * Mismatches are recorded, never thrown; the tripwire compares them with the
 * shrink-only BASELINE (today's known drift, fixed one resource per PR).
 *
 * Production never loads this file; no handler or response changes.
 */

import { toOpenApiPath } from "../_codecs/_register.js";

type Definition = {
  type: string;
  route?: {
    method?: string;
    path?: string;
    responses?: Record<
      string,
      { content?: Record<string, { schema?: unknown }> } | undefined
    >;
  };
};

interface ZodLike {
  safeParse(v: unknown): {
    success: boolean;
    data?: unknown;
    error?: { issues: Array<{ path: PropertyKey[]; message: string }> };
  };
}

const isZod = (s: unknown): s is ZodLike =>
  !!s && typeof (s as ZodLike).safeParse === "function";

/** `{ method, path, regex, literals }` for one registered route. */
interface Matcher {
  method: string;
  path: string;
  regex: RegExp;
  literals: number;
  def: Definition;
}

export function buildMatchers(defs: Definition[]): Matcher[] {
  const out: Matcher[] = [];
  for (const def of defs) {
    if (def.type !== "route" || !def.route?.path || !def.route.method) continue;
    const path = toOpenApiPath(def.route.path);
    const pattern = path
      .split("/")
      .map((seg) =>
        /^\{[^}]+\}$/.test(seg)
          ? "[^/]+"
          : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      )
      .join("/");
    out.push({
      method: def.route.method.toLowerCase(),
      path,
      regex: new RegExp(`^${pattern}/?$`),
      literals: path.split("/").filter((s) => s && !/^\{/.test(s)).length,
      def,
    });
  }
  return out;
}

/** The registered route a request lands on: most literal segments wins. */
export function matchRoute(
  matchers: Matcher[],
  method: string,
  pathname: string
): Matcher | undefined {
  let best: Matcher | undefined;
  for (const m of matchers) {
    if (m.method !== method || !m.regex.test(pathname)) continue;
    if (!best || m.literals > best.literals) best = m;
  }
  return best;
}

/** Keys present in `input` objects that `parsed` (the zod output) dropped. */
export function unknownKeys(
  input: unknown,
  parsed: unknown,
  path = ""
): string[] {
  if (Array.isArray(input) && Array.isArray(parsed)) {
    return input.flatMap((v, i) => unknownKeys(v, parsed[i], `${path}[]`));
  }
  if (
    input &&
    parsed &&
    typeof input === "object" &&
    typeof parsed === "object" &&
    !Array.isArray(input) &&
    !Array.isArray(parsed)
  ) {
    const out: string[] = [];
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const here = path ? `${path}.${k}` : k;
      if (!(k in (parsed as Record<string, unknown>))) out.push(here);
      else
        out.push(
          ...unknownKeys(v, (parsed as Record<string, unknown>)[k], here)
        );
    }
    return out;
  }
  return [];
}

export interface DriftVerdict {
  key: string;
  status: number;
  issues: string[];
}

/** Pure check of one response body against the route's registered schema. */
export function checkBody(
  matchers: Matcher[],
  method: string,
  pathname: string,
  status: number,
  body: unknown
): DriftVerdict | "ok" | "skipped" {
  const m = matchRoute(matchers, method, pathname);
  if (!m) return "skipped";
  const schema =
    m.def.route?.responses?.[String(status)]?.content?.["application/json"]
      ?.schema;
  if (!isZod(schema)) return "skipped";
  let parsed: ReturnType<ZodLike["safeParse"]>;
  try {
    parsed = schema.safeParse(body);
  } catch {
    return "skipped"; // async refinements etc: not checkable synchronously
  }
  const issues: string[] = [];
  if (!parsed.success) {
    for (const i of parsed.error?.issues ?? [])
      issues.push(`${i.path.join(".") || "(root)"}: ${i.message}`);
  } else {
    for (const k of unknownKeys(body, parsed.data))
      issues.push(`${k}: not declared by the response schema`);
  }
  if (issues.length === 0) return "ok";
  return {
    key: `${method.toUpperCase()} ${m.path}`,
    status,
    issues: issues.slice(0, 8),
  };
}

const installed = new WeakSet<object>();

/**
 * Wrap `app.fetch` (which `app.request` calls) so every 2xx JSON response is
 * checked and each mismatch is pushed to `sink`. It never throws and never
 * changes a response: the verdicts are judged by the one tripwire that holds
 * them (hub-response-drift.tripwire.test.ts). Idempotent per app.
 */
export function installHubResponseCheck(
  app: {
    fetch: (...a: any[]) => Response | Promise<Response>;
    openAPIRegistry?: { definitions: Definition[] };
  },
  sink: DriftVerdict[]
): void {
  if (installed.has(app) || !app.openAPIRegistry) return;
  installed.add(app);
  const original = app.fetch.bind(app);
  let cache: { size: number; matchers: Matcher[] } | undefined;
  const matchersOf = () => {
    const defs = app.openAPIRegistry!.definitions;
    if (!cache || cache.size !== defs.length)
      cache = { size: defs.length, matchers: buildMatchers(defs) };
    return cache.matchers;
  };
  app.fetch = async (request: Request, ...rest: unknown[]) => {
    const res = await original(request, ...rest);
    if (res.status < 200 || res.status >= 300) return res;
    if (!(res.headers.get("content-type") ?? "").includes("json")) return res;
    let body: unknown;
    try {
      body = await res.clone().json();
    } catch {
      return res;
    }
    const verdict = checkBody(
      matchersOf(),
      request.method.toLowerCase(),
      new URL(request.url).pathname,
      res.status,
      body
    );
    if (verdict !== "ok" && verdict !== "skipped") sink.push(verdict);
    return res;
  };
}
