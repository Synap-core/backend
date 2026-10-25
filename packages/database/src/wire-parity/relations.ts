/**
 * Compile-time contract: the relation row `@synap-core/types/relations`
 * declares is EXACTLY the row inferred from this package's table
 * (`schema/relations.ts`). No runtime code.
 */
import type * as Wire from "@synap-core/types/relations";
import type { Relation, NewRelation } from "../schema/relations.js";
import type { Equal } from "./equal.js";

export const _relation: Equal<Relation, Wire.Relation> = true;
export const _newRelation: Equal<NewRelation, Wire.NewRelation> = true;
