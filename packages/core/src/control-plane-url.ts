/**
 * The ONE reading of this pod's Control Plane base URL from the environment.
 *
 * It used to be read in about fifteen places, three ways: some honoured
 * `CONTROL_PLANE_URL` only, some `CONTROL_PLANE_URL ?? CP_URL`, one
 * `CP_URL ?? CONTROL_PLANE_URL`; some trimmed, some stripped one trailing
 * slash, some all of them. A pod configured with `CP_URL` then ran half its
 * Control Plane features and silently skipped the rest.
 *
 * Rule: `CONTROL_PLANE_URL`, else `CP_URL` (the legacy spelling). Each is
 * trimmed; a blank value counts as unset (so a blank `CONTROL_PLANE_URL`
 * falls through to `CP_URL`); trailing slashes are stripped. Null when
 * neither is set: a self-hosted pod with no Control Plane.
 *
 * Its own subpath (`@synap-core/core/control-plane-url`), not the barrel:
 * many tests replace `@synap-core/core` wholesale with a logger stub, and a
 * module reading the URL through the barrel would break under every one.
 */
export function controlPlaneBaseUrl(
  env: Record<string, string | undefined> = process.env
): string | null {
  for (const key of ["CONTROL_PLANE_URL", "CP_URL"] as const) {
    const value = env[key]?.trim().replace(/\/+$/, "");
    if (value) return value;
  }
  return null;
}
