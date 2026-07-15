/**
 * Human-readable labels for the generic Pod-side application connection
 * capabilities. These describe an issuer/app admission boundary; they never
 * describe membership or data permissions.
 */
const CAPABILITY_LABELS: Record<string, string> = {
  "auth:exchange-user": "Allow sign-in through this issuer",
  "identity:link-user": "Confirm a person’s existing Pod identity",
};

export function applicationConnectionCapabilities(
  scopes: readonly string[]
): string {
  const labels = scopes.map(
    (scope) => CAPABILITY_LABELS[scope] ?? `Additional: ${scope}`
  );
  return labels.join(" · ") || "No additional connection capabilities";
}
