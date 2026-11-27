/**
 * The one way a test replaces part of `@synap/database`.
 *
 * A wholesale factory (`vi.mock("@synap/database", () => ({ getDb }))`) hides
 * every other export: the day a module under test imports one more name from
 * the package, vitest throws "No 'x' export is defined on the mock" in dozens
 * of files at once, none of which touched that module. Spread the real module
 * and override only what the test fakes:
 *
 *   vi.mock("@synap/database", (importOriginal) =>
 *     databaseMock(importOriginal, { getDb: async () => fakeDb }),
 *   );
 *
 * Guarded by scripts/ci/database-mock-wholesale.tripwire.test.ts.
 */
export async function databaseMock<T extends object>(
  importOriginal: () => Promise<T>,
  overrides: Record<string, unknown> = {}
): Promise<T & Record<string, unknown>> {
  return { ...(await importOriginal()), ...overrides };
}
