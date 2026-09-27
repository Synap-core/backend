/**
 * The path-secret redactor lives in `@synap/api`
 * (`packages/api/src/middleware/redact-secret-path.ts`) so the 5xx error-egress
 * sanitizer there shares the one copy with this app's request logger and error
 * handler. Re-exported here (through the zero-import subpath, so importing it
 * pulls in nothing else) so those sinks keep their import.
 */
export { redactSecretPath } from "@synap/api/redact-secret-path";
