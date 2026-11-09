/**
 * The title of an `installation/request` from its payload
 * (`request-installation.ts`: computerName, capabilityKey, action, and
 * `catalog` when approving adds the capability from the marketplace), through
 * the vocabulary door. ONE derivation, used where the proposal is filed (its
 * stored summary, which activity, session titles and notifications read) and
 * where a card is drawn (`proposals/display.ts`, for rows stored before).
 * Null for a payload that names no capability or action.
 */
import { buildInstallationTitle } from "@synap-core/types/vocabulary";

export function installationTitleOf(
  payload: Record<string, unknown> | undefined
): string | null {
  if (!payload) return null;
  const text = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  const catalog =
    payload.catalog && typeof payload.catalog === "object"
      ? (payload.catalog as Record<string, unknown>)
      : null;
  const name = text(catalog?.name) ?? text(payload.capabilityKey);
  const action = text(payload.action);
  if (!name || !action) return null;
  return buildInstallationTitle({
    action,
    name,
    computer: text(payload.computerName),
    addsFromCatalog: !!catalog,
  });
}
