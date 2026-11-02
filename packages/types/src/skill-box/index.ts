/**
 * The box declaration rule of a box skill (`skills.execution_mode = 'box'`,
 * `skills.metadata.box`) — decided ONE way for every door that writes or ships
 * one: the pod's skill create/edit doors, the capability applier, the run queue
 * (`@synap/api` services/box-runs/box-spec.ts re-exports this) and the catalog
 * validator (`synap catalog validate`, synap-app workspace-templates), so a box
 * skill the catalog passes is one the pod accepts at install.
 *
 * Phase 0 bounds (run box design C4): one language per script (python | node),
 * exact package pins, hostnames only (never an IP literal: the box's egress
 * proxy resolves and re-checks them), and limits capped at the per-box budget
 * of the reference host.
 */

import { z } from "zod";

export const BOX_LANGUAGES = ["python", "node"] as const;
export type BoxLanguage = (typeof BOX_LANGUAGES)[number];

const DEFAULT_ENTRYPOINT: Record<BoxLanguage, string> = {
  python: "main.py",
  node: "main.mjs",
};

const ENTRYPOINT_EXTENSIONS: Record<BoxLanguage, RegExp> = {
  python: /\.py$/,
  node: /\.(m?js|cjs)$/,
};

/** Phase 0 per-box limits: [default, min, max]. */
export const BOX_LIMITS = {
  wallSeconds: [900, 10, 3600],
  cpus: [2, 1, 2],
  memoryMb: [2048, 256, 2048],
  diskMb: [8192, 1024, 8192],
  outMb: [200, 1, 200],
} as const;

const limit = (key: keyof typeof BOX_LIMITS) => {
  const [def, min, max] = BOX_LIMITS[key];
  return z.number().int().min(min).max(max).default(def);
};

/** PyPI (PEP 508 names) and npm (optionally scoped) package names. */
const PACKAGE_NAME =
  /^(@[a-z0-9][a-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]{0,213}$/;
/** An exact pin (PEP 440 / semver characters) — never a range. */
const PACKAGE_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+!_-]{0,63}$/;
/** A DNS hostname with at least one dot, optionally `:port`. */
const HOST =
  /^(?=.{1,253}(:\d{1,5})?$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(:\d{1,5})?$/;

export const BoxDeclarationSchema = z
  .object({
    language: z.enum(BOX_LANGUAGES),
    entrypoint: z
      .string()
      .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/, {
        message: "entrypoint must be a plain file name, e.g. main.py",
      })
      .optional(),
    packages: z
      .array(
        z.object({
          name: z.string().regex(PACKAGE_NAME, {
            message: "a package name like pandas or @scope/name",
          }),
          version: z.string().regex(PACKAGE_VERSION, {
            message: "an exact version, e.g. 2.2.3 (no ranges)",
          }),
        })
      )
      .max(50)
      .default([]),
    hosts: z
      .array(
        z
          .string()
          .transform((h) => h.trim().toLowerCase())
          .pipe(
            z.string().regex(HOST, {
              message:
                "a hostname like api.example.com (optionally :port), never an IP address",
            })
          )
      )
      .max(20)
      .default([]),
    limits: z
      .object({
        wallSeconds: limit("wallSeconds"),
        cpus: limit("cpus"),
        memoryMb: limit("memoryMb"),
        diskMb: limit("diskMb"),
        outMb: limit("outMb"),
      })
      .default({
        wallSeconds: BOX_LIMITS.wallSeconds[0],
        cpus: BOX_LIMITS.cpus[0],
        memoryMb: BOX_LIMITS.memoryMb[0],
        diskMb: BOX_LIMITS.diskMb[0],
        outMb: BOX_LIMITS.outMb[0],
      }),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.entrypoint && !ENTRYPOINT_EXTENSIONS[d.language].test(d.entrypoint)) {
      ctx.addIssue({
        code: "custom",
        path: ["entrypoint"],
        message: `a ${d.language} entrypoint must end in ${d.language === "python" ? ".py" : ".mjs, .js or .cjs"}`,
      });
    }
    const names = d.packages.map((p) => p.name.toLowerCase());
    if (new Set(names).size !== names.length) {
      ctx.addIssue({
        code: "custom",
        path: ["packages"],
        message: "each package is declared once",
      });
    }
  });

/** The stored, normalised declaration (`skills.metadata.box`). */
export type BoxDeclaration = Omit<
  z.output<typeof BoxDeclarationSchema>,
  "entrypoint"
> & { entrypoint: string };

/**
 * Parse + normalise a declaration. Returns the stored shape (entrypoint
 * defaulted, hosts lowercased and de-duplicated, limits defaulted) or the
 * reason in words.
 */
export function parseBoxDeclaration(
  raw: unknown
): { ok: true; box: BoxDeclaration } | { ok: false; error: string } {
  const parsed = BoxDeclarationSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length
      ? `box.${issue.path.join(".")}: `
      : "box: ";
    return { ok: false, error: `${where}${issue?.message ?? "invalid"}` };
  }
  const d = parsed.data;
  return {
    ok: true,
    box: {
      ...d,
      entrypoint: d.entrypoint ?? DEFAULT_ENTRYPOINT[d.language],
      hosts: [...new Set(d.hosts)],
    },
  };
}
