/**
 * Property Validation Service
 *
 * Validates and casts entity properties against profile schemas.
 */

import {
  ProfileResolutionService,
  type EffectiveProperty,
} from "./profile-resolution-service.js";
import { PropertyValueType } from "../schema/property-defs.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  normalized: Record<string, unknown>;
}

export class PropertyValidationService {
  constructor(private profileResolution: ProfileResolutionService) {}

  /**
   * Validate properties against a profile
   */
  async validateProperties(
    properties: Record<string, unknown>,
    profileId: string
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const normalized: Record<string, unknown> = { ...properties };

    // Get effective properties (with inheritance)
    const effectiveProperties =
      await this.profileResolution.getEffectiveProperties(profileId);

    // Check required properties
    for (const prop of effectiveProperties) {
      if (prop.required && !(prop.slug in normalized)) {
        // Use default value if available
        if (prop.defaultValue !== null && prop.defaultValue !== undefined) {
          normalized[prop.slug] = prop.defaultValue;
        } else {
          errors.push(`Property '${prop.slug}' is required`);
        }
      }
    }

    // Validate and cast each property
    for (const [key, value] of Object.entries(normalized)) {
      const prop = effectiveProperties.find((p) => p.slug === key);

      if (!prop) {
        // Unknown property - allow it but warn (flexible schema)
        continue;
      }

      try {
        // Cast value to correct type
        const casted = await this.castPropertyValue(value, prop);
        normalized[key] = casted;

        // Validate constraints
        const constraintErrors = this.validateConstraints(casted, prop);
        errors.push(...constraintErrors);
      } catch (error) {
        errors.push(
          `Property '${key}': ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      normalized,
    };
  }

  /**
   * Cast property value to correct type
   */
  async castPropertyValue(
    value: unknown,
    propertyDef: EffectiveProperty
  ): Promise<unknown> {
    if (value === null || value === undefined) {
      return propertyDef.defaultValue !== null
        ? propertyDef.defaultValue
        : value;
    }

    switch (propertyDef.valueType) {
      case PropertyValueType.STRING:
        return String(value);

      case PropertyValueType.NUMBER:
        const num = Number(value);
        if (isNaN(num)) {
          throw new Error(`Cannot cast to number: ${value}`);
        }
        return num;

      case PropertyValueType.BOOLEAN:
        if (typeof value === "boolean") return value;
        if (typeof value === "string") {
          return value.toLowerCase() === "true" || value === "1";
        }
        return Boolean(value);

      case PropertyValueType.DATE:
        if (value instanceof Date) return value;
        if (typeof value === "string") {
          const date = new Date(value);
          if (isNaN(date.getTime())) {
            throw new Error(`Invalid date: ${value}`);
          }
          return date;
        }
        throw new Error(`Cannot cast to date: ${value}`);

      case PropertyValueType.ENTITY_ID:
        return String(value); // UUID as string

      case PropertyValueType.ARRAY:
        if (Array.isArray(value)) return value;
        if (typeof value === "string") {
          try {
            return JSON.parse(value);
          } catch {
            return [value]; // Single value as array
          }
        }
        return [value];

      case PropertyValueType.OBJECT:
        if (
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value)
        )
          return value;
        if (typeof value === "string") {
          try {
            return JSON.parse(value);
          } catch {
            throw new Error(`Cannot parse object: ${value}`);
          }
        }
        return { value }; // Wrap in object

      default:
        return value;
    }
  }

  /**
   * Validate property constraints
   */
  private validateConstraints(
    value: unknown,
    propertyDef: EffectiveProperty
  ): string[] {
    const errors: string[] = [];
    const constraints =
      (propertyDef.constraints as Record<string, unknown>) || {};

    // Enum constraint
    if (constraints.enum && Array.isArray(constraints.enum)) {
      if (!constraints.enum.includes(value)) {
        errors.push(
          `Value '${value}' not in enum: ${constraints.enum.join(", ")}`
        );
      }
    }

    // Min/Max for numbers
    if (propertyDef.valueType === PropertyValueType.NUMBER) {
      const num = value as number;
      if (constraints.min !== undefined && num < (constraints.min as number)) {
        errors.push(`Value ${num} is less than minimum ${constraints.min}`);
      }
      if (constraints.max !== undefined && num > (constraints.max as number)) {
        errors.push(`Value ${num} is greater than maximum ${constraints.max}`);
      }
    }

    // String length constraints
    if (propertyDef.valueType === PropertyValueType.STRING) {
      const str = value as string;
      if (
        constraints.minLength !== undefined &&
        str.length < (constraints.minLength as number)
      ) {
        errors.push(
          `String length ${str.length} is less than minimum ${constraints.minLength}`
        );
      }
      if (
        constraints.maxLength !== undefined &&
        str.length > (constraints.maxLength as number)
      ) {
        errors.push(
          `String length ${str.length} is greater than maximum ${constraints.maxLength}`
        );
      }

      // Format constraints
      if (constraints.format === "email") {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(str)) {
          errors.push(`Invalid email format: ${str}`);
        }
      }
      if (constraints.format === "uri") {
        try {
          new URL(str);
        } catch {
          errors.push(`Invalid URI format: ${str}`);
        }
      }
      if (constraints.format === "date-time") {
        const date = new Date(str);
        if (isNaN(date.getTime())) {
          errors.push(`Invalid date-time format: ${str}`);
        }
      }

      // Pattern (regex)
      if (constraints.pattern && typeof constraints.pattern === "string") {
        const regex = new RegExp(constraints.pattern);
        if (!regex.test(str)) {
          errors.push(`Value does not match pattern: ${constraints.pattern}`);
        }
      }
    }

    return errors;
  }

  /**
   * Normalize properties (cast and apply defaults)
   */
  async normalizeProperties(
    properties: Record<string, unknown>,
    profileId: string
  ): Promise<Record<string, unknown>> {
    const result = await this.validateProperties(properties, profileId);
    return result.normalized;
  }
}
