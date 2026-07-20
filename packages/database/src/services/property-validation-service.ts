/**
 * Property Validation Service
 *
 * Validates and casts entity properties against profile schemas.
 */

import {
  type ProfileResolutionService,
  type EffectiveProperty,
} from "./profile-resolution-service.js";
import { PropertyValueType } from "../schema/property-defs.js";
import { suggestClosest } from "./did-you-mean.js";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "property-validation-service" });

const VAULT_REF_RE =
  /^vault:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function isVaultReference(value: unknown): value is string {
  return typeof value === "string" && VAULT_REF_RE.test(value);
}

/**
 * Keys that live on the ENTITY ROW, not in the property bag. Callers
 * (EntityRepository.create, FacetRepository) merge `title` into the bag before
 * validating so a profile declaring a required `title` def is satisfied — it is
 * not an invented key, so it must never be reported as unmodeled (that would
 * warn on every create for the many profiles with no `title` def).
 */
const ENTITY_COLUMN_KEYS = new Set(["title"]);

/**
 * A property key the caller wrote that the profile does not model.
 * Reported, never rejected — see `ValidationResult.unmodeled`.
 */
export interface UnmodeledProperty {
  key: string;
  /** Closest VALID property slug, when one is close enough to be a likely typo. */
  didYouMean?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  normalized: Record<string, unknown>;
  /**
   * Keys present in the payload that the profile (through this workspace's
   * lens) does not define. They are still STORED verbatim — the flexible-schema
   * tolerance is load-bearing for historical clients — but they are no longer
   * silent: callers surface them on the write receipt as `unmodeled` so an
   * agent that invented a key learns it invented one instead of reading a 200
   * as "modelled and queryable".
   *
   * Always present (possibly empty) so callers can read it without a guard.
   */
  unmodeled: UnmodeledProperty[];
}

export class PropertyValidationService {
  constructor(private profileResolution: ProfileResolutionService) {}

  /**
   * Validate properties against a profile.
   *
   * When `workspaceId` is provided, validation runs through that workspace's
   * lens — overlay props owned by other workspaces are ignored, so writing
   * to them produces "unknown property" rather than a type error. This
   * matches the rendering contract: a workspace can only see/write its own
   * base+overlay set.
   */
  async validateProperties(
    properties: Record<string, unknown>,
    profileId: string,
    workspaceId?: string | null,
    opts?: {
      /**
       * When false, missing `required` properties are not errors — provided
       * values are still type-checked/cast, and defaults still apply. Used by
       * facet attach/update: a facet is progressive-enrichment territory
       * ("ask MINIMUM to exist"), and a converted role-profile can carry
       * vestigial kind-identity defs (e.g. a required `title`) that live on
       * the parent entity, never the facet.
       */
      enforceRequired?: boolean;
    }
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const unmodeled: UnmodeledProperty[] = [];
    const normalized: Record<string, unknown> = { ...properties };
    const enforceRequired = opts?.enforceRequired !== false;

    // Get effective properties (with inheritance + workspace filter)
    const effectiveProperties =
      await this.profileResolution.getEffectiveProperties(
        profileId,
        workspaceId
      );

    // Check required properties
    for (const prop of effectiveProperties) {
      if (prop.required && !(prop.slug in normalized)) {
        // Use default value if available
        if (prop.defaultValue !== null && prop.defaultValue !== undefined) {
          normalized[prop.slug] = prop.defaultValue;
        } else if (enforceRequired) {
          errors.push(`Property '${prop.slug}' is required`);
        }
      }
    }

    // Validate and cast each property
    for (const [key, value] of Object.entries(normalized)) {
      const prop = effectiveProperties.find((p) => p.slug === key);

      if (!prop) {
        // Unknown property — STILL ACCEPTED (flexible schema; historical
        // clients depend on the tolerance) but no longer silent. Before, this
        // `continue` carried a promise of a warning that did not exist, and the
        // key was stored verbatim in JSONB: an agent that invented a property
        // key got a 200 and believed it worked. Report it both ways — a server
        // log AND structured data on the result, so the caller can render it as
        // `unmodeled` on the write receipt with a recovery hint.
        if (ENTITY_COLUMN_KEYS.has(key)) continue;
        const didYouMean = suggestClosest(
          key,
          effectiveProperties.map((p) => p.slug)
        );
        unmodeled.push(didYouMean ? { key, didYouMean } : { key });
        logger.warn(
          { profileId, workspaceId, key, didYouMean },
          `Unknown property '${key}' is not modelled by this profile — stored verbatim, not queryable` +
            (didYouMean ? ` (did you mean '${didYouMean}'?)` : "")
        );
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
      // Unmodeled keys never make the result invalid — they are a receipt
      // signal, not a rejection.
      unmodeled,
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

      case PropertyValueType.NUMBER: {
        const num = Number(value);
        if (isNaN(num)) {
          throw new Error(`Cannot cast to number: ${value}`);
        }
        return num;
      }

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

      case PropertyValueType.SECRET: {
        const ref = String(value);
        if (!isVaultReference(ref)) {
          throw new Error(
            `Secret value must be a vault reference (vault://<uuid>), got: ${ref}`
          );
        }
        return ref;
      }

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
   * Normalize properties (cast and apply defaults) through a workspace lens.
   */
  async normalizeProperties(
    properties: Record<string, unknown>,
    profileId: string,
    workspaceId?: string | null
  ): Promise<Record<string, unknown>> {
    const result = await this.validateProperties(
      properties,
      profileId,
      workspaceId
    );
    return result.normalized;
  }
}
