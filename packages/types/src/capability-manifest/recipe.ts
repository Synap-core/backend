/**
 * A RECIPE: one named media operation stored as config (plan b647769e §5.2).
 * A capability carries its official recipes in `spec.recipes`; a person's own
 * recipes have the same shape. A recipe is DATA, never a shell line:
 *
 *   name, description   kebab-case name; one line on what it is for
 *   params              typed variables, each required or with a default
 *   steps               argv templates: `program` (a bin the capability pins in
 *                       `install.<os>.bins`, or `python`) + `args`
 *   scripts             helper scripts the steps run, inlined and pinned by sha256
 *   needs               ffmpeg filters / encoders the computer must have (checked
 *                       against its verify record before a run)
 *   gotchas             what goes wrong, in plain words
 *
 * Placeholders in `args` are `{name}` (the agent-wake grammar): a declared param,
 * `{workdir}` (the run's scratch folder), `{script:<file>}` (the path the runner
 * wrote that script to) or `{bin:<program>}` (a pinned program's path, so a
 * helper script runs the same ffmpeg the steps do). `renderRecipe` is the ONE way a recipe becomes argv;
 * the runner and the catalog test both go through it.
 */

import { z } from "zod";

export const RECIPE_PARAM_TYPES = [
  "file",
  "files",
  "output",
  "string",
  "number",
  "integer",
  "enum",
  "color",
  "time",
] as const;
export type RecipeParamType = (typeof RECIPE_PARAM_TYPES)[number];
/** Placeholders the runner fills, never the caller. */
export const RECIPE_RESERVED = ["workdir"] as const;
export const RECIPE_PLACEHOLDER = /\{([^{}]*)\}/g;
const NAME = /^[a-z][a-z0-9-]*$/;
const PARAM_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const SCRIPT_NAME = /^[a-z0-9][a-z0-9_-]*\.(py|sh)$/;
/** A value spliced INTO a larger argument (an ffmpeg filter graph) may not carry the graph's syntax. */
const EMBEDDED_UNSAFE = /[\s'":\\;,[\]=]/;
const VALUE_RULES: Partial<Record<RecipeParamType, [RegExp, string]>> = {
  color: [
    /^(0x|#)?[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/,
    "a hex colour (1A2B3C, 0x1A2B3C or #1A2B3C)",
  ],
  time: [
    /^(\d+(\.\d+)?|\d{1,2}:\d{2}(:\d{2})?(\.\d+)?)$/,
    "a time in seconds (12.5) or [hh:]mm:ss",
  ],
};

const paramSchema = z
  .object({
    type: z.enum(RECIPE_PARAM_TYPES),
    description: z.string().min(1),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.number()]).optional(),
    options: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.type === "enum" && !p.options)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "an enum param lists its options",
      });
    if (p.type !== "enum" && p.options)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "options are for an enum param only",
      });
    if (p.required && p.default !== undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["default"],
        message: "a required param has no default",
      });
    if (!p.required && p.default === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["default"],
        message: "a param is required or has a default",
      });
    if ((p.type === "output" || p.type === "files") && p.default !== undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["default"],
        message: `a ${p.type} param is always given by the caller: make it required`,
      });
    if (p.default !== undefined && !(p.type === "enum" && !p.options)) {
      const bad = valueProblem(p as RecipeParam, p.default);
      if (bad)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["default"],
          message: bad,
        });
    }
  });
export type RecipeParam = z.infer<typeof paramSchema>;

export const recipeSchema = z
  .object({
    name: z.string().regex(NAME, "a recipe name is kebab-case"),
    description: z.string().min(1).max(300),
    params: z.record(
      z.string().regex(PARAM_NAME, "a param name is an identifier"),
      paramSchema
    ),
    steps: z
      .array(
        z
          .object({
            program: z
              .string()
              .regex(/^[A-Za-z0-9._-]+$/, "a program is a bare name"),
            args: z
              .array(z.string(), {
                message: "args is an argv array, never a shell line",
              })
              .min(1),
          })
          .strict()
      )
      .min(1),
    scripts: z
      .array(
        z
          .object({
            name: z
              .string()
              .regex(
                SCRIPT_NAME,
                "a script name is a file name ending in .py or .sh"
              ),
            sha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/, "sha256 is 64 lowercase hex characters"),
            source: z.string().min(1),
          })
          .strict()
      )
      .optional(),
    needs: z
      .object({
        filters: z.array(z.string().min(1)).optional(),
        encoders: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    gotchas: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .superRefine((r, ctx) => {
    const scripts = new Set((r.scripts ?? []).map((s) => s.name));
    const used = new Set<string>();
    r.steps.forEach((step, si) =>
      step.args.forEach((arg, ai) => {
        for (const m of arg.matchAll(RECIPE_PLACEHOLDER)) {
          const ref = m[1]!;
          const path = ["steps", si, "args", ai];
          if (ref.startsWith("script:")) {
            const s = ref.slice("script:".length);
            used.add(s);
            if (!scripts.has(s))
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path,
                message: `{${ref}} names no script of this recipe`,
              });
            continue;
          }
          if (ref.startsWith("bin:")) continue; // pinned per OS: checked by the capability (`capability.ts`)
          if ((RECIPE_RESERVED as readonly string[]).includes(ref)) continue;
          const param = r.params[ref];
          if (!param) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: `placeholder {${ref}} is not a declared param`,
            });
            continue;
          }
          if (param.type === "files" && arg !== m[0])
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path,
              message: `{${ref}} is a list of files: it stands alone as an argument`,
            });
        }
      })
    );
    for (const s of scripts)
      if (!used.has(s))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scripts"],
          message: `script ${s} is never run by a step`,
        });
    for (const name of Object.keys(r.params))
      if (!r.steps.some((st) => st.args.some((a) => a.includes(`{${name}}`))))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["params", name],
          message: `param ${name} is used by no step`,
        });
  });
export type Recipe = z.infer<typeof recipeSchema>;

function valueProblem(param: RecipeParam, value: unknown): string | null {
  switch (param.type) {
    case "files":
      return Array.isArray(value) &&
        value.length > 0 &&
        value.every((v) => typeof v === "string" && v.length > 0)
        ? null
        : "a non-empty list of file paths";
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? null
        : "a number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
        ? null
        : "an integer";
    case "enum":
      return typeof value === "string" && param.options!.includes(value)
        ? null
        : `one of ${param.options!.join(", ")}`;
    default: {
      if (typeof value !== "string") return "a string";
      const rule = VALUE_RULES[param.type];
      if (rule && !rule[0].test(value)) return rule[1];
      if (
        (param.type === "file" || param.type === "output") &&
        value.length === 0
      )
        return "a file path";
      return null;
    }
  }
}

export interface RecipeRunContext {
  /** The run's scratch folder. */
  workdir: string;
  /** Where the runner wrote each script (name → path). */
  scripts?: Record<string, string>;
  /** Pinned programs (`install.<os>.bins`); a program not listed is run by name. */
  bins?: Record<string, string>;
}

export interface RenderedStep {
  program: string;
  args: string[];
}

/**
 * Fill a recipe with typed values. Throws (naming the param) on a missing or
 * ill-typed value, and on a value that would break the ffmpeg graph it is
 * spliced into. A placeholder that is a whole argument takes any value: an
 * argv is never parsed by a shell.
 */
export function renderRecipe(
  recipe: Recipe,
  values: Record<string, unknown>,
  run: RecipeRunContext
): RenderedStep[] {
  const filled: Record<string, string | string[]> = {};
  for (const [name, param] of Object.entries(recipe.params)) {
    const value = values[name] ?? param.default;
    if (value === undefined)
      throw new Error(`recipe ${recipe.name}: ${name} is required`);
    const bad = valueProblem(param, value);
    if (bad) throw new Error(`recipe ${recipe.name}: ${name} must be ${bad}`);
    filled[name] = Array.isArray(value) ? value.map(String) : String(value);
  }
  for (const name of Object.keys(values))
    if (!(name in recipe.params))
      throw new Error(`recipe ${recipe.name}: unknown param ${name}`);
  const resolve = (ref: string, whole: boolean): string | string[] => {
    if (ref === "workdir") return run.workdir;
    if (ref.startsWith("bin:"))
      return run.bins?.[ref.slice("bin:".length)] ?? ref.slice("bin:".length);
    if (ref.startsWith("script:")) {
      const path = run.scripts?.[ref.slice("script:".length)];
      if (!path)
        throw new Error(
          `recipe ${recipe.name}: the runner wrote no ${ref.slice("script:".length)}`
        );
      return path;
    }
    const value = filled[ref]!;
    if (!whole && typeof value === "string" && EMBEDDED_UNSAFE.test(value))
      throw new Error(
        `recipe ${recipe.name}: ${ref} (${JSON.stringify(value)}) is spliced into a filter, so it cannot hold spaces, quotes or : , ; = [ ] \\. Copy the file to a simple name first.`
      );
    return value;
  };
  return recipe.steps.map((step) => ({
    program: run.bins?.[step.program] ?? step.program,
    args: step.args.flatMap((arg) => {
      const whole = /^\{([^{}]*)\}$/.exec(arg);
      if (whole) {
        const v = resolve(whole[1]!, true);
        return Array.isArray(v) ? v : [v];
      }
      return [
        arg.replace(
          RECIPE_PLACEHOLDER,
          (_m, ref: string) => resolve(ref, false) as string
        ),
      ];
    }),
  }));
}
