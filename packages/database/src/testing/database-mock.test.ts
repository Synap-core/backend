import { describe, expect, it } from "vitest";
import { databaseMock } from "./database-mock.js";

describe("databaseMock", () => {
  const actual = async () => ({ getDb: () => "real", eq: () => "real-eq" });

  it("keeps every export it does not override", async () => {
    const m = await databaseMock(actual, { getDb: () => "fake" });
    expect(m.eq()).toBe("real-eq");
  });

  it("replaces the exports it is given", async () => {
    const m = await databaseMock(actual, { getDb: () => "fake" });
    expect(m.getDb()).toBe("fake");
  });
});
