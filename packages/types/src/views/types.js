/**
 * View Content Types
 *
 * Defines the discriminated union for view content based on category.
 * Categories determine the structure and purpose of view content.
 */
/**
 * Map view types to their categories
 */
export const VIEW_TYPE_CATEGORIES = {
  // Structured (query-based, interchangeable layouts)
  table: "structured",
  kanban: "structured",
  list: "structured",
  grid: "structured",
  gallery: "structured",
  calendar: "structured",
  gantt: "structured",
  timeline: "structured",
  graph: "structured", // Graph is also query-based!
  // Composite (views that compose other views)
  bento: "composite",
  // Canvas (freeform drawing)
  whiteboard: "canvas",
  mindmap: "canvas",
};
/**
 * Get category for a view type
 *
 * @param type - The view type
 * @returns The category of the view type
 */
export function getViewCategory(type) {
  return VIEW_TYPE_CATEGORIES[type] || "structured"; // Default fallback
}
// =============================================================================
// Type Guards
// =============================================================================
/**
 * Type guard: Check if content is structured
 */
export function isStructuredContent(content) {
  return content.category === "structured";
}
/**
 * Type guard: Check if content is canvas
 */
export function isCanvasContent(content) {
  return content.category === "canvas";
}
/**
 * Get content type for view type
 */
export function getContentCategoryForViewType(type) {
  return VIEW_TYPE_CATEGORIES[type];
}
//# sourceMappingURL=types.js.map
