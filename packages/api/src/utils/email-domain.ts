/**
 * Email-domain → organization identity helpers (PURE; no I/O).
 *
 * The ONE place that decides "does this email address imply a company?". Lifted
 * out of the Cal.com mapper so every source that sees an address — Cal.com
 * bookings, Google Calendar attendees, Gmail thread participants — mints (or
 * declines to mint) the SAME company for the same domain. Two copies of the
 * consumer-mailbox list is how one source would file `gmail.com` as a company
 * while another did not.
 */

// Consumer mailbox domains — an address on one of these is an individual, NOT a
// company, so no company entity is minted from its domain.
export const CONSUMER_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.net",
  "aol.com",
  "zoho.com",
  "yandex.com",
  "mail.com",
]);

/** Domain part of an email, lowercased; null when absent/malformed. */
export function emailDomain(email: string | undefined | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain.includes(".") ? domain : null;
}

/** A corporate domain is any real domain that isn't a known consumer mailbox. */
export function isCorporateDomain(domain: string | null): boolean {
  return !!domain && !CONSUMER_EMAIL_DOMAINS.has(domain);
}

/** "acme-corp.io" → "Acme Corp" (best-effort display name from a domain). */
export function companyNameFromDomain(domain: string): string {
  const base = domain.split(".")[0] || domain;
  return base
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
