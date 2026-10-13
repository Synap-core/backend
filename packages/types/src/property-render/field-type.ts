/**
 * Field type detection — reads a value with NO schema (a payload key, an
 * undeclared property) as the kind of thing it holds, for dynamic rendering.
 * With a schema, `classifyPropertyKind` is the door instead.
 */

export type FieldType =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "email"
  | "url"
  | "phone"
  | "array"
  | "object"
  | "empty";

/**
 * Detect field type from value
 */
export function detectFieldType(value: unknown, fieldName?: string): FieldType {
  if (value === null || value === undefined) return "empty";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";

  if (typeof value === "string") {
    const str = value.trim();
    if (str === "") return "empty";
    if (
      str.match(
        /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/
      )
    )
      return str.includes("T") ? "datetime" : "date";
    if (str.includes("@") && str.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/))
      return "email";
    if (
      str.startsWith("http://") ||
      str.startsWith("https://") ||
      str.startsWith("www.")
    )
      return "url";
    if (
      str.match(
        /^[+]?[(]?[0-9]{1,4}[)]?[-\s.]?[(]?[0-9]{1,4}[)]?[-\s.]?[0-9]{1,9}$/
      )
    )
      return "phone";
    if (fieldName) {
      const lowerName = fieldName.toLowerCase();
      if (lowerName.includes("email")) return "email";
      if (
        lowerName.includes("url") ||
        lowerName.includes("website") ||
        lowerName.includes("link")
      )
        return "url";
      if (lowerName.includes("phone") || lowerName.includes("tel"))
        return "phone";
      if (lowerName.includes("date") || lowerName.includes("time"))
        return str.includes("T") ? "datetime" : "date";
    }
    return "text";
  }

  return "text";
}

/**
 * Format field value for display
 */
export function formatFieldValue(value: unknown, type: FieldType): string {
  if (value === null || value === undefined) return "";
  switch (type) {
    case "array":
      return Array.isArray(value) ? value.join(", ") : String(value);
    case "object":
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return String(value);
      }
    case "number":
      return typeof value === "number" ? value.toLocaleString() : String(value);
    case "boolean":
      return value ? "Yes" : "No";
    default:
      return String(value);
  }
}
