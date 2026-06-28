/**
 * ConfigFieldSpec — headless field descriptor.
 *
 * Shaped as a PropertyDef-aligned subset so it can align with the backend
 * PropertyValueType if promoted to a shared package later.
 *
 * ZERO UI imports — this file must stay extractable.
 */

export interface ConfigFieldSpec {
  /** Settings key. Dotted keys address nested objects: "navigationPermissions.autoApprove" */
  key: string;
  label: string;
  description?: string;
  valueType: "string" | "boolean" | "number" | "enum" | "string-list" | "json";
  /** Required when valueType === "enum" */
  enumValues?: string[];
  required?: boolean;
  /** When true the field lives under a collapsed "Advanced" section */
  advanced?: boolean;
  placeholder?: string;
}
