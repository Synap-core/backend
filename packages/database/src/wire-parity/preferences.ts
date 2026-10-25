/**
 * Compile-time contract: the `user_preferences` row
 * `@synap-core/types/preferences` declares is EXACTLY the row inferred from
 * this package's table (`schema/user-preferences.ts`). No runtime code. (The
 * JSONB column shapes are not copied: the table imports them from
 * `@synap-core/types/preferences/model`.)
 */
import type {
  UserPreference as WireUserPreference,
  NewUserPreference as WireNewUserPreference,
} from "@synap-core/types/preferences";
import type {
  UserPreference,
  NewUserPreference,
} from "../schema/user-preferences.js";
import type { Equal } from "./equal.js";

export const _userPreference: Equal<UserPreference, WireUserPreference> = true;
export const _newUserPreference: Equal<
  NewUserPreference,
  WireNewUserPreference
> = true;
