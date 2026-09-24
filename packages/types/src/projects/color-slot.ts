/**
 * A PROJECT'S COLOUR — as a slot in the identity palette, one rule for every
 * surface.
 *
 * `projects.color_slot` (migration 0271) stores 1–12, an index into the design
 * system's `--synap-identity-1..12` palette, never a hex: the palette carries a
 * light and a dark value per slot, so only a slot is right on both themes.
 *
 * NULL means the person has not chosen one. The surface then shows a slot
 * DERIVED from the project id — stable across reloads, devices and surfaces —
 * and never writes it back: a stored value is only ever someone's choice, so a
 * later palette change or re-derivation cannot be mistaken for one.
 *
 * Pure and dependency-free, so the browser rail, the relay project card and the
 * CLI all agree on which colour a project is.
 */

export const PROJECT_COLOR_SLOTS = 12;

/** A valid stored slot: an integer 1–12. */
export function isProjectColorSlot(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= PROJECT_COLOR_SLOTS
  );
}

/**
 * The slot to paint a project with: the stored choice, else one derived from
 * the id (FNV-1a over the id's UTF-16 code units, mod 12, 1-based).
 */
export function resolveProjectColorSlot(project: {
  id: string;
  colorSlot?: number | null;
}): number {
  if (isProjectColorSlot(project.colorSlot)) return project.colorSlot;
  let hash = 0x811c9dc5;
  for (let i = 0; i < project.id.length; i++) {
    hash ^= project.id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % PROJECT_COLOR_SLOTS) + 1;
}
