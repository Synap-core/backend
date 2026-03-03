/**
 * View Type Enum Helper
 *
 * Utility to generate Zod enum from ViewType for runtime validation.
 * This ensures API validation stays in sync with the ViewType definition.
 */
import { z } from "zod";
/**
 * Array of all view types (for iteration, validation, etc.)
 */
export const VIEW_TYPES = [
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
    "flow",
    "bento",
    "branch_tree",
];
/**
 * Zod validator for view types (open string — accepts any non-empty type)
 * Known types are in VIEW_TYPES; unknown types are accepted and default to "structured" category.
 */
export const ViewTypeEnum = z.string().min(1);
/**
 * Type guard: Check if a string is a valid ViewType
 */
export function isViewType(value) {
    return VIEW_TYPES.includes(value);
}
