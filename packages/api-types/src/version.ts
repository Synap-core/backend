/**
 * Version stamp + runtime drift guard for `@synap-core/api-types`.
 *
 * `API_TYPES_VERSION` is the published package version. It is the single
 * source of truth a client pins against, and the value a Synap pod reports
 * as `apiTypesVersion` in its `GET /health` payload.
 *
 * IMPORTANT: this constant is kept in lock-step with `package.json#version`
 * by `scripts/check-and-bump.mjs`. Do not hand-edit the number — run the
 * bump script (which also updates the pod's `/health` literal in
 * `apps/api/src/index.ts`).
 */
export const API_TYPES_VERSION = "1.25.1";

/** Parsed semver major of the locally-pinned `@synap-core/api-types`. */
export const API_TYPES_MAJOR = majorOf(API_TYPES_VERSION);

export interface ApiTypesCompatibility {
  /** `true` when the client major matches the pod-reported major. */
  compatible: boolean;
  /** Major version baked into this build of `@synap-core/api-types`. */
  clientMajor: number;
  /** Major version the pod reported, or `null` if it reported none. */
  podMajor: number | null;
  /** Human-readable explanation, present only when `compatible` is false. */
  reason?: string;
}

/**
 * Extract the semver major from a version string. Tolerates a leading `v`,
 * pre-release/build suffixes (`1.2.3-saas`, `2.0.0+abc`), and whitespace.
 * Returns `null` when no leading integer can be parsed.
 */
export function majorOf(version: string | null | undefined): number | null {
  if (typeof version !== "string") return null;
  const match = version
    .trim()
    .replace(/^v/i, "")
    .match(/^(\d+)/);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Compare the locally-pinned `@synap-core/api-types` major against the
 * version a pod reports (e.g. `apiTypesVersion` from `GET /health`).
 *
 * Pure + dependency-free. Returns a structured result; never throws and
 * never logs by itself — see {@link assertApiTypesCompatible} for the
 * warn/throw wrapper.
 */
export function checkApiTypesCompatible(
  podReportedVersion: string | null | undefined
): ApiTypesCompatibility {
  const clientMajor = API_TYPES_MAJOR ?? 0;
  const podMajor = majorOf(podReportedVersion);

  if (podMajor === null) {
    return {
      compatible: true,
      clientMajor,
      podMajor: null,
      reason:
        "Pod did not report an api-types version; skipping compatibility check.",
    };
  }

  if (podMajor === clientMajor) {
    return { compatible: true, clientMajor, podMajor };
  }

  return {
    compatible: false,
    clientMajor,
    podMajor,
    reason:
      `@synap-core/api-types major mismatch: client pinned v${clientMajor}.x ` +
      `but pod reports router types v${podMajor}.x. ` +
      `Run \`npm i @synap-core/api-types@^${podMajor}\` to realign.`,
  };
}

export interface AssertApiTypesOptions {
  /**
   * When `true` (default), a mismatch is logged via `console.warn` and the
   * function returns normally — types may still mostly work. When `false`,
   * a mismatch throws so the caller fails fast.
   */
  warnOnly?: boolean;
  /** Sink for the warning. Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

/**
 * Detect when a client's pinned `@synap-core/api-types` major diverges from
 * the pod's actual router version and react accordingly.
 *
 * @param podReportedVersion the pod's reported version (e.g. `data.apiTypesVersion`)
 * @param options `warnOnly` (default `true`) → log; `false` → throw on mismatch
 * @returns the structured {@link ApiTypesCompatibility} result
 * @throws when `compatible` is false and `warnOnly` is `false`
 */
export function assertApiTypesCompatible(
  podReportedVersion: string | null | undefined,
  options: AssertApiTypesOptions = {}
): ApiTypesCompatibility {
  const { warnOnly = true, warn } = options;
  const result = checkApiTypesCompatible(podReportedVersion);

  if (!result.compatible) {
    const message = result.reason ?? "api-types major mismatch.";
    if (warnOnly) {
      (warn ?? ((m: string) => console.warn(`[synap] ${m}`)))(message);
    } else {
      throw new Error(`[synap] ${message}`);
    }
  }

  return result;
}
