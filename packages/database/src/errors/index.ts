/**
 * Custom Error Classes for Dynamic Schema System
 */

export class ProfileNotFoundError extends Error {
  constructor(
    public readonly identifier: string,
    public readonly userId: string,
    public readonly workspaceId: string
  ) {
    super(
      `Profile not found or not accessible: ${identifier} (user: ${userId}, workspace: ${workspaceId})`
    );
    this.name = "ProfileNotFoundError";
  }
}

export class PropertyValidationError extends Error {
  constructor(
    public readonly errors: Array<{ field: string; message: string }>,
    public readonly profileId: string
  ) {
    const errorMessages = errors
      .map((e) => `${e.field}: ${e.message}`)
      .join(", ");
    super(
      `Property validation failed for profile ${profileId}: ${errorMessages}`
    );
    this.name = "PropertyValidationError";
    this.errors = errors;
  }
}

export class PropertyDefinitionNotFoundError extends Error {
  constructor(public readonly slug: string) {
    super(`Property definition not found: ${slug}`);
    this.name = "PropertyDefinitionNotFoundError";
  }
}

export class InheritanceCycleError extends Error {
  constructor(
    public readonly profileId: string,
    public readonly parentProfileId: string,
    public readonly cycle: string[]
  ) {
    super(
      `Inheritance cycle detected: ${cycle.join(" → ")} → ${profileId} (attempting to set parent: ${parentProfileId})`
    );
    this.name = "InheritanceCycleError";
  }
}

export class IndexingError extends Error {
  constructor(
    public readonly entityId: string,
    public readonly propertySlug: string,
    public readonly originalError: Error
  ) {
    super(
      `Failed to index property ${propertySlug} for entity ${entityId}: ${originalError.message}`
    );
    this.name = "IndexingError";
    this.cause = originalError;
  }
}

export class ProfileSlugConflictError extends Error {
  constructor(
    public readonly slug: string,
    public readonly scope: string
  ) {
    super(`Profile slug already exists: ${slug} (scope: ${scope})`);
    this.name = "ProfileSlugConflictError";
  }
}

export class PropertySlugConflictError extends Error {
  constructor(public readonly slug: string) {
    super(`Property definition slug already exists: ${slug}`);
    this.name = "PropertySlugConflictError";
  }
}
