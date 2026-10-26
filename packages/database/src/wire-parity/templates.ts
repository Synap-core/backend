/**
 * Compile-time contract: the `entity_templates` row
 * `@synap-core/types/templates/rows` declares is EXACTLY the row inferred from
 * this package's table (`schema/entity-templates.ts`). No runtime code.
 */
import type * as Wire from "@synap-core/types/templates/rows";
import type {
  EntityTemplate,
  NewEntityTemplate,
} from "../schema/entity-templates.js";
import type { Equal } from "./equal.js";

export const _entityTemplate: Equal<EntityTemplate, Wire.EntityTemplate> = true;
export const _newEntityTemplate: Equal<
  NewEntityTemplate,
  Wire.NewEntityTemplate
> = true;
