/**
 * A PROJECT'S INITIALS — the plate's fallback when it has no icon
 * (`parseProjectIcon` → null), one rule for every surface.
 *
 * The first letters of the first two words ("Launch The Architech" → "LT"),
 * else the first two letters of a single word, uppercased; "P" for a blank
 * name, so a plate is never empty. Moved verbatim from the browser rail
 * (`railProjects.ts`), so the rail plate reads exactly as before.
 *
 * Pure and dependency-free: the browser, relay and the CLI draw the same plate.
 */
export function projectInitials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const value =
    parts.length > 1
      ? `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`
      : (parts[0] ?? "").slice(0, 2);
  return value.toUpperCase() || "P";
}
