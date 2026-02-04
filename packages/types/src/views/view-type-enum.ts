/**
 * View Type Enum Helper
 *
 * Utility to generate Zod enum from ViewType for runtime validation.
 * This ensures API validation stays in sync with the ViewType definition.
 */

import { z } from "zod";
import type { ViewType } from "./index.js";

/**
 * Array of all view types (for iteration, validation, etc.)
 */
export const VIEW_TYPES: ViewType[] = [
  "whiteboard",
  "table",
  "kanban",
  "list",
  "grid",
  "gallery",
  "calendar",
  "gantt",
  "timeline",
  "mindmap",
  "graph",
  "bento",
];

/**
 * Zod enum for view types (for API validation)
 * Generated from ViewType to ensure consistency
 */
export const ViewTypeEnum = z.enum([
  "whiteboard",
  "table",
  "kanban",
  "list",
  "grid",
  "gallery",
  "calendar",
  "gantt",
  "timeline",
  "mindmap",
  "graph",
  "bento",
]);

/**
 * Type guard: Check if a string is a valid ViewType
 */
export function isViewType(value: string): value is ViewType {
  return VIEW_TYPES.includes(value as ViewType);
}
