import { describe, it, expect } from "vitest";
import {
  emailDomain,
  isCorporateDomain,
  companyNameFromDomain,
} from "./email-domain.js";

describe("emailDomain", () => {
  it("extracts the lowercased domain", () => {
    expect(emailDomain("Jelle@ACME-corp.io")).toBe("acme-corp.io");
  });

  it("returns null for absent or malformed addresses", () => {
    expect(emailDomain("no-at-sign")).toBeNull();
    expect(emailDomain("user@localhost")).toBeNull();
    expect(emailDomain(undefined)).toBeNull();
    expect(emailDomain(null)).toBeNull();
  });
});

describe("isCorporateDomain", () => {
  it("treats consumer mailboxes as individuals", () => {
    expect(isCorporateDomain("gmail.com")).toBe(false);
    expect(isCorporateDomain("icloud.com")).toBe(false);
  });

  it("treats any other real domain as a company", () => {
    expect(isCorporateDomain("acme-corp.io")).toBe(true);
    expect(isCorporateDomain(null)).toBe(false);
  });
});

describe("companyNameFromDomain", () => {
  it("title-cases the first label", () => {
    expect(companyNameFromDomain("acme-corp.io")).toBe("Acme Corp");
    expect(companyNameFromDomain("weexbusiness.com")).toBe("Weexbusiness");
  });
});
