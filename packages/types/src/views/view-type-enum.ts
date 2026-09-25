/**
 * View Type Enum Helper
 *
 * Runtime view-type list + validator. The list is the renderables catalog's
 * `VIEW_TYPE_KEYS` — the same tuple the browser's view picker, the MCP
 * `create_view` enum and the REST manifest derive from — never a local copy.
 */

import { z } from "zod";
import { VIEW_TYPE_KEYS } from "../renderables/index.js";
import type { ViewType } from "./index.js";

/**
 * Array of all view types (for iteration, validation, etc.)
 */
export const VIEW_TYPES: readonly ViewType[] = VIEW_TYPE_KEYS;

/**
 * Zod validator for view types (open string — accepts any non-empty type)
 * Known types are in VIEW_TYPES; unknown types are accepted and default to "structured" category.
 */
export const ViewTypeEnum = z.string().min(1);

/**
 * Type guard: Check if a string is a valid ViewType
 */
export function isViewType(value: string): value is ViewType {
  return (VIEW_TYPES as readonly string[]).includes(value);
}
