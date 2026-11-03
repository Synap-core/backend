/**
 * The ONE reading of this pod's Control Plane base URL from the environment.
 *
 * Every reader goes through it, so a pod configured with either spelling
 * runs every Control Plane feature, and no reader trims or orders the two
 * variables differently from the others.
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
