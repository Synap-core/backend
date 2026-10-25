/**
 * One field def as it rides a proposed kind (ticket a375443d):
 * `profiles.create` `deferredFields` → the gate's `fields` → the
 * `profile/create` executor, which re-parses each one at approval.
 *
 * A LEAF module on purpose: the hub door and the executor import it, and
 * suites that replace `routers/profiles.js` with a total `vi.mock` must not
 * have to know about it (a schema exported from that router broke three of
 * them and moved the total-mock ratchet).
 *
 * The slug is already normalised by the caller (`slugifyPropertyKey`), which
 * is why the pattern is the stored-slug one.
 */
import { z } from "zod";
import { PropertyValueType } from "@synap/database";

export const ProposedKindFieldSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/),
  valueType: z
    .string()
    .refine((t) => (Object.values(PropertyValueType) as string[]).includes(t), {
      message: `valueType must be one of ${Object.values(PropertyValueType).join(", ")}`,
    }),
  constraints: z.record(z.string(), z.unknown()).optional(),
  uiHints: z.record(z.string(), z.unknown()).optional(),
  required: z.boolean().optional(),
  defaultValue: z.unknown().optional(),
  displayOrder: z.number().optional(),
  overlay: z.boolean().optional(),
});
export type ProposedKindField = z.infer<typeof ProposedKindFieldSchema>;
