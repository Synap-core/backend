/**
 * Capabilities that run on a COMPUTER (plan b647769e §2.1, founder decision
 * 168f34db). Six optional `spec` siblings say where a capability can run and how
 * a computer installs, checks and removes its tool:
 *
 *   placement    runsOn (pod | computer), prefer, platforms, labels, requires
 *   install      per OS: package-manager steps; a script only pinned by sha256
 *                with its elevation declared. `elevation: never` in v1.
 *   verify       per OS: an argv (never a shell line), what it must print, the
 *                regex group that becomes the observed tool version; an optional
 *                smoke run; how often to check again (ISO 8601 duration)
 *   uninstall    per OS steps, and whether downloaded models are kept
 *   permissions  folders, network hosts and devices the tool may touch
 *   licence      an SPDX expression; REQUIRED when runsOn includes computer
 *   services     containers by digest (a `service`); with install.<os> it would
 *                be a `tool` too, which is refused (`installKind`)
 *
 * Platform values are Node's `process.platform` / `process.arch`: what each
 * computer reports at enrolment. The UI says Mac, Linux, Windows. Windows may
 * be listed (decision 5: the picker hides it until tried on a real machine).
 *
 * Every command is DATA: an argv whose `{name}` placeholders the runner fills
 * (the same grammar as an agent's wake, `agent.ts`). The rules that span fields
 * (an OS listed needs install + verify; a GPL tool is never bundled) live in
 * `computerPlacementProblems`, which the capability schema runs.
 */

import { z } from "zod";

export const COMPUTER_OSES = ["darwin", "linux", "win32"] as const;
export type ComputerOs = (typeof COMPUTER_OSES)[number];
export const COMPUTER_ARCHES = ["arm64", "x64"] as const;
export const RUNS_ON = ["pod", "computer"] as const;
export const INSTALL_STEP_KINDS = [
  "brew",
  "apt",
  "dnf",
  "winget",
  "uv",
  "pip",
  "npm",
  "download",
  "script",
] as const;
export const INSTALL_ELEVATIONS = ["never"] as const;
/**
 * The placeholders a computer fills in a path or a command: `{home}` (the
 * person's home), `{brewPrefix}` (`brew --prefix`), `{tools}` (the folder Synap
 * keeps this capability's tool files in), `{models}` (its model cache),
 * `{workdir}` (one run's scratch folder), `{fixture}` (a sample file the runner
 * ships for a smoke run). Anything else in braces is a typo.
 */
export const COMPUTER_PLACEHOLDERS = [
  "home",
  "brewPrefix",
  "tools",
  "models",
  "workdir",
  "fixture",
] as const;
const PLACEHOLDER = /\{([^{}]*)\}/g;

/** The `spec` keys this file adds to a capability (classified in `capability.ts`). */
export const COMPUTER_CAPABILITY_FIELDS = [
  "placement",
  "install",
  "verify",
  "uninstall",
  "permissions",
  "licence",
  "services",
] as const;

/**
 * What an installation of this capability is (reconciliation f75fbb48 §3.5),
 * DERIVED, never declared: `services` makes it a `service` (containers the
 * computer runs), `install.<os>` a `tool` (a program installed by per-OS
 * steps), neither a pod capability. Both at once is refused.
 */
export const INSTALL_KINDS = ["tool", "service"] as const;
export type InstallKind = (typeof INSTALL_KINDS)[number];

/** An SPDX license expression: ids (`MIT`, `GPL-3.0-only`, `LicenseRef-x`) joined by AND / OR / WITH. */
export const SPDX_EXPRESSION =
  /^\(?[A-Za-z0-9.+-]+\)?( (AND|OR|WITH) \(?[A-Za-z0-9.+-]+\)?)*$/;
/** GPL or AGPL (any version), but not LGPL: a tool under it is installed, never bundled (decision 4). */
export const GPL_LICENCE = /(?<![A-Za-z])A?GPL-/;
/** ISO 8601 duration, days or time (`P7D`, `PT12H`). */
export const ISO_DURATION = /^P(?!$)(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?$/;
const SHA256 = /^[a-f0-9]{64}$/;

const nonEmpty = z.string().min(1);
const argv = z
  .array(nonEmpty, {
    invalid_type_error: "a command is an argv array, never a shell line",
  })
  .min(1);
const pkg = nonEmpty.regex(
  /^[^\s;&|`$]+$/,
  "a package name has no spaces or shell characters"
);

const installStepSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("brew"),
        package: pkg,
        tap: pkg.optional(),
        cask: z.boolean().optional(),
        action: z.enum(["install", "uninstall"]).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("apt"),
        package: pkg,
        action: z.enum(["install", "uninstall"]).optional(),
        fallback: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("dnf"),
        package: pkg,
        action: z.enum(["install", "uninstall"]).optional(),
        fallback: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("winget"),
        id: pkg,
        action: z.enum(["install", "uninstall"]).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("uv"),
        action: z.enum(["tool-install", "tool-uninstall"]),
        package: pkg,
        /** Extra packages installed into the same tool environment (`uv tool install --with`). */
        with: z.array(pkg).optional(),
        python: z.string().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("pip"),
        package: pkg,
        action: z.enum(["install", "uninstall"]).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("npm"),
        package: pkg,
        action: z.enum(["install", "uninstall"]).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("download"),
        /** What is fetched: a model (weights), a binary, an archive to unpack, a file. */
        what: z.enum(["model", "binary", "archive", "file"]),
        /** A model id on its hub (`mlx-community/whisper-large-v3-turbo`), or… */
        id: nonEmpty.optional(),
        /** …an https URL. */
        url: z
          .string()
          .regex(/^https:\/\/\S+$/, "a download url is https")
          .optional(),
        sha256: z
          .string()
          .regex(SHA256, "sha256 is 64 lowercase hex characters")
          .optional(),
        sizeMb: z.number().positive().optional(),
        resumable: z.boolean().optional(),
        /** Where it lands, a `{placeholder}` path (`{tools}/ffmpeg`). */
        dest: nonEmpty.optional(),
        /** An archive: drop this many leading folders when unpacking. */
        stripComponents: z.number().int().min(0).optional(),
        /** Only on these CPU types (a release built per arch). */
        arch: z.array(z.enum(COMPUTER_ARCHES)).min(1).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("script"),
        /**
         * The script's file name; its extension says what runs it (.sh: sh,
         * .py: python, .ps1: PowerShell). It is shown to the person before it runs.
         */
        name: nonEmpty.regex(
          /^[a-z0-9][a-z0-9_-]*\.(sh|py|ps1)$/,
          "a script name is a file name ending in .sh, .py or .ps1"
        ),
        /** Its arguments (`{placeholder}` paths allowed). */
        args: z.array(z.string()).optional(),
        /** Pins the script's content: a changed script is refused. */
        sha256: z
          .string({ required_error: "a script step is pinned by its sha256" })
          .regex(SHA256, "sha256 is 64 lowercase hex characters"),
        elevation: z.enum(INSTALL_ELEVATIONS, {
          required_error: "a script step declares its elevation (never, in v1)",
        }),
        /** The script itself, inlined (or fetched from `url`); either way its sha256 must match. */
        source: z.string().min(1).optional(),
        url: z
          .string()
          .regex(/^https:\/\/\S+$/, "a script url is https")
          .optional(),
      })
      .strict(),
  ])
  .superRefine((s, ctx) => {
    if (s.kind === "download" && Boolean(s.id) === Boolean(s.url))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a download names exactly one of id or url",
      });
    if (s.kind === "download" && s.url && !s.sha256)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sha256"],
        message:
          "a download by url is pinned by its sha256: the computer refuses a file it cannot check",
      });
    if (s.kind === "script" && Boolean(s.source) === Boolean(s.url))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a script step carries its source or its url, exactly one",
      });
  });
export type InstallStep = z.infer<typeof installStepSchema>;

const stepsSchema = z.array(installStepSchema).min(1);

/** Output check of a command: every given condition must hold. */
const expectSchema = z
  .object({
    exitCode: z.number().int().optional(),
    stdoutMatches: nonEmpty.optional(),
    stdoutContains: nonEmpty.optional(),
    stderrMatches: nonEmpty.optional(),
  })
  .strict();

const osInstallSchema = z
  .object({
    steps: stepsSchema,
    /** The programs this capability runs, pinned to a path (`{brewPrefix}/opt/ffmpeg-full/bin/ffmpeg`), so PATH order never decides. */
    bins: z
      .record(
        nonEmpty.regex(
          /^[A-Za-z0-9._-]+$/,
          "a bin name is a bare program name"
        ),
        nonEmpty
      )
      .optional(),
    /** This OS's tool licence when it differs from `spec.licence` (an SPDX expression). */
    licence: z
      .string()
      .regex(
        SPDX_EXPRESSION,
        "licence is an SPDX expression (MIT, GPL-3.0-only, MIT AND Apache-2.0)"
      )
      .optional(),
    /** Synap ships the tool's own files here (not a package manager or the author's release). Never for a GPL tool. */
    bundled: z.boolean().optional(),
  })
  .strict();

const osVerifySchema = z
  .object({
    command: argv,
    expect: expectSchema,
    /** The regex group of `stdoutMatches` that becomes the observed tool version. */
    captureVersion: z.number().int().min(1).optional(),
    /** A run proving the tool works (a version flag only proves it is there); recorded apart. */
    smoke: z
      .object({
        command: argv,
        expect: expectSchema,
        fixture: nonEmpty.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    for (const key of ["stdoutMatches", "stderrMatches"] as const) {
      const src = v.expect[key];
      if (!src) continue;
      try {
        new RegExp(src);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["expect", key],
          message: `not a valid regex: ${(err as Error).message}`,
        });
      }
    }
    if (v.captureVersion !== undefined && !v.expect.stdoutMatches)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["captureVersion"],
        message:
          "captureVersion names a group of expect.stdoutMatches: add the pattern",
      });
  });

const perOs = <T extends z.ZodTypeAny>(schema: T) =>
  Object.fromEntries(
    COMPUTER_OSES.map((os) => [os, schema.optional()])
  ) as Record<ComputerOs, z.ZodOptional<T>>;

export const placementSchema = z
  .object({
    runsOn: z.array(z.enum(RUNS_ON)).min(1),
    prefer: z.array(z.enum(RUNS_ON)).optional(),
    /** A hard filter: a missing list means any computer. */
    platforms: z
      .array(
        z
          .object({
            os: z.enum(COMPUTER_OSES),
            arch: z.array(z.enum(COMPUTER_ARCHES)).min(1).optional(),
          })
          .strict()
      )
      .min(1)
      .optional(),
    /** All must match the computer; a trailing `?` only ranks (`gpu?`). */
    labels: z
      .array(
        z
          .string()
          .regex(
            /^[a-z][a-z0-9-]*\??$/,
            "a label is kebab-case, with an optional trailing ?"
          )
      )
      .optional(),
    requires: z
      .object({
        capabilities: z
          .array(
            z
              .object({ slug: nonEmpty, os: z.enum(COMPUTER_OSES).optional() })
              .strict()
          )
          .optional(),
        runtimes: z.record(nonEmpty, nonEmpty).optional(),
      })
      .strict()
      .optional(),
    /**
     * A pod capability that can do the job when no computer has the tool. Only
     * ever offered, per tool, with its price, never used silently (decision 6).
     */
    fallback: z
      .object({ capability: nonEmpty, price: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();

export const installSchema = z
  .object({
    ...perOs(osInstallSchema),
    elevation: z.enum(INSTALL_ELEVATIONS).optional(),
    diskFreeMb: z.number().positive().optional(),
  })
  .strict();

export const verifySchema = z
  .object({
    ...perOs(osVerifySchema),
    timeoutSec: z.number().int().positive().optional(),
    reverifyEvery: z
      .string()
      .regex(ISO_DURATION, "reverifyEvery is an ISO 8601 duration (P7D, PT12H)")
      .optional(),
  })
  .strict();

export const uninstallSchema = z
  .object({
    ...perOs(z.object({ steps: stepsSchema }).strict()),
    keepUserData: z.boolean().optional(),
  })
  .strict();

export const permissionsSchema = z
  .object({
    filesystem: z
      .array(z.object({ path: nonEmpty, access: z.enum(["r", "rw"]) }).strict())
      .optional(),
    /** Host names; `*` = any host (a downloader), shown as such on the install card. */
    network: z
      .array(
        z
          .string()
          .regex(
            /^(\*|[a-z0-9.-]+(:\d+)?)$/,
            "a network entry is a host name (huggingface.co) or *"
          )
      )
      .optional(),
    devices: z
      .array(z.enum(["camera", "microphone", "gpu", "screen"]))
      .optional(),
  })
  .strict();

/** An image pinned by digest, never a bare tag. */
export const IMAGE_BY_DIGEST =
  /^[a-z0-9]+([._/-][a-z0-9]+)*(:[A-Za-z0-9._-]{1,128})?@sha256:[a-f0-9]{64}$/;
const SERVICE_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const port = z.number().int().min(1).max(65535);

/**
 * One container a `service` capability runs on a computer: the backend leaf's
 * `HostServiceSchema` (`@synap-core/types/capability-manifest`), mirrored. A
 * strict subset of Docker Compose: an image by digest, ports bound to
 * 127.0.0.1 only, a health check, hard limits, named volumes only. `.strict()`
 * is the guard: `privileged`, host networking or a host path are keys it does
 * not know, so they are refused, never ignored.
 */
export const hostServiceSchema = z
  .object({
    id: z
      .string()
      .regex(SERVICE_ID, "a service id: lowercase letters, digits, - and _"),
    image: z
      .string()
      .regex(
        IMAGE_BY_DIGEST,
        "an image pinned by digest: <name>[:tag]@sha256:<64 hex>"
      ),
    ports: z
      .array(
        z
          .object({
            container: port,
            host: port,
            /** Always the loopback: Docker-published ports bypass the firewall. */
            bind: z.literal("127.0.0.1").optional(),
            protocol: z.enum(["tcp", "udp"]).optional(),
          })
          .strict()
      )
      .max(16)
      .optional(),
    health: z
      .object({
        http: z
          .string()
          .regex(/^\/[^\s]{0,511}$/, "an HTTP path starting with /"),
        port,
      })
      .strict()
      .optional(),
    env: z
      .record(
        z
          .string()
          .regex(
            /^[A-Z_][A-Z0-9_]{0,127}$/,
            "an environment name like NO_TELEMETRY"
          ),
        z.string().max(4096)
      )
      .optional(),
    limits: z
      .object({
        cpus: z.number().positive().max(64),
        memoryMb: z.number().int().min(64).max(262144),
        diskMb: z.number().int().min(64).max(2097152),
      })
      .strict(),
    /** A named volume inside the installation's folder, never a host path. */
    volumes: z
      .array(
        z
          .object({
            name: z.string().regex(SERVICE_ID),
            path: z.string().regex(/^\/[^\s]{0,511}$/),
          })
          .strict()
      )
      .max(8)
      .optional(),
    /** Outside hosts the service may reach. Default none. */
    egress: z.array(z.string().min(1).max(253)).max(32).optional(),
  })
  .strict();
export const servicesSchema = z.array(hostServiceSchema).min(1).max(16);

export const licenceSchema = z
  .string()
  .regex(
    SPDX_EXPRESSION,
    "licence is an SPDX expression (MIT, GPL-3.0-only, MIT AND Apache-2.0)"
  );

type ComputerFields = {
  permissions?: z.infer<typeof permissionsSchema>;
  placement?: z.infer<typeof placementSchema>;
  install?: z.infer<typeof installSchema>;
  verify?: z.infer<typeof verifySchema>;
  uninstall?: z.infer<typeof uninstallSchema>;
  licence?: string;
  services?: z.infer<typeof servicesSchema>;
};

/** `service`, `tool`, or null for a capability that installs nothing (it runs on the pod). */
export function installKind(spec: ComputerFields): InstallKind | null {
  if (spec.services?.length) return "service";
  if (spec.install && COMPUTER_OSES.some((os) => spec.install?.[os]))
    return "tool";
  return null;
}

/** The OSes a computer capability must be installable on: its platforms, or all three when it lists none. */
export function computerOses(spec: ComputerFields): ComputerOs[] {
  const listed = spec.placement?.platforms?.map((p) => p.os);
  return listed?.length ? [...new Set(listed)] : [...COMPUTER_OSES];
}

/**
 * The cross-field rules, as `[path, message]` pairs (the capability schema
 * turns them into issues):
 *  - install / verify / uninstall belong to a computer capability only;
 *  - a computer capability has a licence, and install + verify for every OS it lists;
 *  - install / verify for an OS it does not list is refused (it would never run);
 *  - a GPL tool is never bundled (decision 4).
 */
export function computerPlacementProblems(
  spec: ComputerFields
): Array<[Array<string | number>, string]> {
  const out: Array<[Array<string | number>, string]> = [];
  const onComputer = spec.placement?.runsOn.includes("computer") ?? false;
  if (!onComputer) {
    for (const key of ["install", "verify", "uninstall", "services"] as const)
      if (spec[key])
        out.push([
          [key],
          `${key} is for a capability that runs on a computer: add placement.runsOn ["computer"]`,
        ]);
    return out;
  }
  if (!spec.licence)
    out.push([
      ["licence"],
      "a capability that runs on a computer names its licence (an SPDX id): it is shown on the install card",
    ]);
  if (spec.services) {
    for (const key of ["install", "verify", "uninstall"] as const)
      if (spec[key])
        out.push([
          [key],
          `a capability is a tool (install.<os>) or a service (services), never both: drop ${key} or services`,
        ]);
    const platforms = spec.placement?.platforms;
    if (!platforms || platforms.some((p) => p.os !== "linux"))
      out.push([
        ["placement", "platforms"],
        "a service runs in containers on Linux: placement.platforms lists linux only",
      ]);
    if (!spec.placement?.requires?.runtimes?.docker)
      out.push([
        ["placement", "requires", "runtimes", "docker"],
        "a service needs Docker on the computer: add placement.requires.runtimes.docker",
      ]);
    const ids = new Set<string>();
    const hostPorts = new Set<number>();
    spec.services.forEach((svc, i) => {
      if (ids.has(svc.id))
        out.push([
          ["services", i, "id"],
          `the service id "${svc.id}" is declared twice`,
        ]);
      ids.add(svc.id);
      for (const p of svc.ports ?? []) {
        if (hostPorts.has(p.host))
          out.push([
            ["services", i, "ports"],
            `the host port ${p.host} is used twice`,
          ]);
        hostPorts.add(p.host);
      }
    });
    return out;
  }
  const oses = computerOses(spec);
  for (const os of oses) {
    if (!spec.install?.[os])
      out.push([
        ["install", os],
        `placement lists ${os}: say how to install the tool there (install.${os}.steps)`,
      ]);
    if (!spec.verify?.[os])
      out.push([
        ["verify", os],
        `placement lists ${os}: say how to check the tool there (verify.${os})`,
      ]);
  }
  for (const key of ["install", "verify", "uninstall"] as const)
    for (const os of COMPUTER_OSES)
      if (spec[key]?.[os] && !oses.includes(os))
        out.push([
          [key, os],
          `${key}.${os} is never used: placement.platforms does not list ${os}`,
        ]);
  const walk = (v: unknown, path: Array<string | number>): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(PLACEHOLDER))
        if (!(COMPUTER_PLACEHOLDERS as readonly string[]).includes(m[1]!))
          out.push([
            path,
            `{${m[1]}} is not a placeholder a computer fills (${COMPUTER_PLACEHOLDERS.map((p) => `{${p}}`).join(", ")})`,
          ]);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...path, i]));
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v))
        if (k !== "source" && k !== "expect") walk(x, [...path, k]);
  };
  for (const key of ["install", "verify", "uninstall", "permissions"] as const)
    walk((spec as Record<string, unknown>)[key], [key]);
  for (const os of COMPUTER_OSES) {
    const inst = spec.install?.[os];
    if (!inst?.bundled) continue;
    const licence = inst.licence ?? spec.licence ?? "";
    if (GPL_LICENCE.test(licence))
      out.push([
        ["install", os, "bundled"],
        `a GPL tool (${licence}) is installed from its source, never bundled with Synap`,
      ]);
  }
  return out;
}
