/**
 * The courier self-report must call the CP email relay (R2) "configured" —
 * that one word is what opens the "Email me a code" recovery door
 * (`/api/account-recovery/doors`) and clears the CP `smtp_unconfigured` issue.
 */
import { afterEach, describe, expect, it } from "vitest";
import { courierStatus } from "./courier-status.js";

const saved = process.env.SMTP_CONNECTION_URI;
afterEach(() => {
  if (saved === undefined) delete process.env.SMTP_CONNECTION_URI;
  else process.env.SMTP_CONNECTION_URI = saved;
});

describe("courierStatus", () => {
  // Catches: the relay URI the CP writes (smtps, resend, port 465) misread as
  // unknown/catchall ⇒ the email door stays hidden on a pod whose mail works.
  it("the CP Resend relay URI is configured", () => {
    process.env.SMTP_CONNECTION_URI =
      "smtps://resend:re_test_123@smtp.resend.com:465";
    expect(courierStatus()).toEqual({
      status: "configured",
      host: "smtp.resend.com",
      scheme: "smtps",
    });
  });

  it("the localhost default is catchall (door hidden)", () => {
    process.env.SMTP_CONNECTION_URI = "smtp://localhost:1025/";
    expect(courierStatus().status).toBe("catchall");
  });

  it("an unset env is unknown, never configured", () => {
    delete process.env.SMTP_CONNECTION_URI;
    expect(courierStatus().status).toBe("unknown");
  });

  // The report never carries the credential.
  it("never returns the password", () => {
    process.env.SMTP_CONNECTION_URI =
      "smtps://resend:re_secret_value@smtp.resend.com:465";
    expect(JSON.stringify(courierStatus())).not.toContain("re_secret_value");
  });
});
