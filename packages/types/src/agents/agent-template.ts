/**
 * Agent TEMPLATES: the catalog kind `agent` (founder decisions D8-D10,
 * proposal 3649da4d; plan v2, pod document 66d229dc).
 *
 * An agent template is ONE AI program a person connects (Claude Code, Codex,
 * Hermes, Cursor…). The catalog authors it in
 * `synap-app/packages/workspace-templates/agents/*.agent.yaml` and publishes it
 * as CP category `agent`, with the program under `definition.agent`. The pod
 * installs every OFFICIAL one (D8) into `agent_templates`; an agent is linked
 * to its template by `users.agent_template_slug`.
 *
 * This file is the pod's reading of `definition.agent`. It mirrors the
 * catalog's `schema/agent.ts` refusals on the fields the pod relies on: a
 * catalog row is data from outside the pod, so the pod checks it again before
 * it stores it. Pure, no zod (the types package keeps zod a peer).
 */

/** Kebab-case, the way `users.agent_type` is stored. */
export const AGENT_TEMPLATE_SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
/** A bare program name found on PATH: no path separator, no whitespace. */
const BARE_PROGRAM = /^[^/\\\s]+$/;
const PLACEHOLDER = /\{([^{}]*)\}/g;
const PARAM_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export const AGENT_WAKE_PARAM_TYPES = ["text", "model", "path"] as const;
export type AgentWakeParamType = (typeof AGENT_WAKE_PARAM_TYPES)[number];

/** How a computer starts the program on handed work: data, never a shell line. */
export interface AgentTemplateWake {
  program: string;
  args: string[];
  params?: Record<string, { type: AgentWakeParamType; required?: boolean }>;
  env?: { strip?: string[] };
}

export interface AgentTemplateDetect {
  bins?: string[];
  homePaths?: string[];
}

/** `definition.agent` as the pod stores it (one column per field). */
export interface AgentTemplateSpec {
  /** = `users.agent_type` of this program's agents (the join key). */
  harness: string;
  /** Other `agent_type` spellings that clearly mean this program. */
  aliases: string[];
  /** Can it run handed work headless (be a worker). */
  worker: boolean;
  /** false = its wake was never run on a real computer (a stub). */
  tried: boolean;
  detect: AgentTemplateDetect | null;
  wake: AgentTemplateWake | null;
  /** Base practices: the skill slugs its agents get. */
  practices: { skills: string[] };
}

export type AgentTemplateParse =
  { ok: true; spec: AgentTemplateSpec } | { ok: false; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

function parseWake(raw: unknown): AgentTemplateWake | string {
  if (!isRecord(raw)) {
    return "wake is data ({ program, args, params }), never a shell line";
  }
  const { program, args, params, env } = raw;
  if (typeof program !== "string" || !BARE_PROGRAM.test(program)) {
    return "wake.program is a bare program name: no path separator, no whitespace";
  }
  if (!isStringArray(args)) return "wake.args is a list of strings";
  const declared: AgentTemplateWake["params"] = {};
  if (params !== undefined) {
    if (!isRecord(params)) return "wake.params is an object";
    for (const [name, p] of Object.entries(params)) {
      if (!PARAM_NAME.test(name))
        return `wake.params "${name}" is not an identifier`;
      if (
        !isRecord(p) ||
        !(AGENT_WAKE_PARAM_TYPES as readonly unknown[]).includes(p.type) ||
        (p.required !== undefined && typeof p.required !== "boolean")
      ) {
        return `wake.params "${name}" needs a type (${AGENT_WAKE_PARAM_TYPES.join(", ")})`;
      }
      declared[name] = {
        type: p.type as AgentWakeParamType,
        ...(p.required !== undefined
          ? { required: p.required as boolean }
          : {}),
      };
    }
  }
  for (const arg of args) {
    for (const m of arg.matchAll(PLACEHOLDER)) {
      if (!(m[1]! in declared)) {
        return `wake placeholder {${m[1]}} is not declared in wake.params`;
      }
    }
  }
  let strip: string[] | undefined;
  if (env !== undefined) {
    if (!isRecord(env)) return "wake.env is an object";
    if (env.strip !== undefined) {
      if (
        !isStringArray(env.strip) ||
        !env.strip.every((e) => ENV_NAME.test(e))
      ) {
        return "wake.env.strip is a list of environment variable names";
      }
      strip = env.strip;
    }
  }
  return {
    program,
    args: [...args],
    ...(params !== undefined ? { params: declared } : {}),
    ...(strip ? { env: { strip: [...strip] } } : {}),
  };
}

/**
 * Read `definition.agent` (or a definition whose `agent` slot holds it).
 * Refuses, with one sentence, anything the pod would have to guess about.
 */
export function parseAgentTemplateSpec(raw: unknown): AgentTemplateParse {
  const no = (reason: string): AgentTemplateParse => ({ ok: false, reason });
  if (!isRecord(raw)) return no("an agent template is an object");
  const { harness, aliases, worker, tried, detect, wake, practices } = raw;
  if (typeof harness !== "string" || !AGENT_TEMPLATE_SLUG.test(harness)) {
    return no("harness must be a kebab-case slug (the agent_type spelling)");
  }
  if (
    aliases !== undefined &&
    (!isStringArray(aliases) ||
      !aliases.every((a) => AGENT_TEMPLATE_SLUG.test(a)))
  ) {
    return no("aliases must be kebab-case slugs");
  }
  if (typeof worker !== "boolean") return no("worker must be true or false");
  if (typeof tried !== "boolean") return no("tried must be true or false");
  let parsedDetect: AgentTemplateDetect | null = null;
  if (detect !== undefined) {
    if (!isRecord(detect)) return no("detect is an object");
    const bins = detect.bins;
    const homePaths = detect.homePaths;
    if (
      bins !== undefined &&
      (!isStringArray(bins) || !bins.every((b) => BARE_PROGRAM.test(b)))
    ) {
      return no("detect.bins are bare program names");
    }
    if (
      homePaths !== undefined &&
      (!isStringArray(homePaths) ||
        !homePaths.every(
          (p) =>
            p.length > 0 &&
            !p.startsWith("/") &&
            !p.split(/[\\/]/).includes("..")
        ))
    ) {
      return no("detect.homePaths are relative to $HOME, without ..");
    }
    parsedDetect = {
      ...(bins !== undefined ? { bins: [...bins] } : {}),
      ...(homePaths !== undefined ? { homePaths: [...homePaths] } : {}),
    };
  }
  let parsedWake: AgentTemplateWake | null = null;
  if (wake !== undefined && wake !== null) {
    const w = parseWake(wake);
    if (typeof w === "string") return no(w);
    parsedWake = w;
  }
  if (worker && !parsedWake) return no("a worker (worker: true) needs a wake");
  if (!worker && parsedWake)
    return no("wake is for a worker only (worker: false here)");
  let skills: string[] = [];
  if (practices !== undefined) {
    if (!isRecord(practices) || !isStringArray(practices.skills)) {
      return no("practices.skills is a list of skill slugs");
    }
    skills = [...practices.skills];
  }
  return {
    ok: true,
    spec: {
      harness,
      aliases: aliases ? [...aliases] : [],
      worker,
      tried,
      detect: parsedDetect,
      wake: parsedWake,
      practices: { skills },
    },
  };
}
