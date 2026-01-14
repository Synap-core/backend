/**
 * Custom Assertions for E2E Tests
 */

import { expect } from "vitest";

/**
 * Assert that a response indicates a requested mutation
 */
export function expectRequested(response: any) {
  expect(response).toBeDefined();
  expect(response.status).toBe("requested");
}

/**
 * Assert that an event was validated
 */
export function expectValidated(validationResult: { status: string; event: any }) {
  expect(validationResult.status).toBe("validated");
  expect(validationResult.event).toBeDefined();
}

/**
 * Assert that an event was denied
 */
export function expectDenied(validationResult: { status: string; event: any }) {
  expect(validationResult.status).toBe("denied");
  expect(validationResult.event).toBeDefined();
}

/**
 * Assert that an array contains an object with specific properties
 */
export function expectToContainObject<T>(
  array: T[],
  properties: Partial<T>
) {
  expect(array).toContainEqual(expect.objectContaining(properties));
}

/**
 * Assert that a UUID is valid
 */
export function expectValidUUID(value: string) {
  expect(value).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  );
}
