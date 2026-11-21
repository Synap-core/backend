/**
 * The wire shape of an AppAccess v2 a door accepts (app permissions W3d):
 * the consent's Allow (`apiKeys.decideOAuthAuthorization`) and the app page
 * (`apps.updateAccess`). Shape only: what it may hold is checked by the
 * service (`assertAccessWithinCeiling`). Writes are Select only: no "all".
 */
import { z } from "zod";

const ids = z.array(z.string().uuid()).max(256);

export const AppAccessInputSchema = z.object({
  version: z.literal(2),
  permissions: z.array(z.string().min(1).max(200)).max(512),
  read: z.object({
    spaces: z.union([z.literal("all"), ids]),
    projects: z.union([z.literal("all"), ids]),
  }),
  write: z.object({ spaces: ids, projects: ids }),
});

/** Q4: where a short ask's first write lands. */
export const AccessWritePlaceInputSchema = z.object({
  spaces: ids,
  projects: ids,
});
