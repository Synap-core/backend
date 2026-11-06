/**
 * `application/x-www-form-urlencoded` with bracket nesting — the request format
 * of APIs that take form bodies, not JSON (Stripe v1: "accepts form-encoded
 * request bodies", https://docs.stripe.com/api; a JSON body there is refused or
 * ignored).
 *
 * The nesting convention is the Rack / Stripe one, the same the official SDKs
 * send:
 *   { a: 1 }                         → a=1
 *   { defaults: { tax_behavior: x } } → defaults[tax_behavior]=x
 *   { items: [{ price: p }] }         → items[0][price]=p
 *   { expand: ["a", "b"] }            → expand[0]=a&expand[1]=b
 *   { description: null }             → description=   (an empty value unsets a field)
 *   { metadata: {} }                  → metadata=      (an empty object clears it)
 * `undefined` is left out. Booleans and numbers are sent as their string form.
 * Keys and values are percent-encoded (`encodeURIComponent`), brackets
 * included, which every form decoder reads back.
 *
 * Used by the vault:// handler when a tool's `config.bodyEncoding` is "form",
 * and by the provider-verb engine to put a whole-object parameter into a GET's
 * query string.
 */

function walk(prefix: string, value: unknown, out: string[]): void {
  if (value === undefined) return;
  if (value === null) {
    out.push(`${encodeURIComponent(prefix)}=`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${encodeURIComponent(prefix)}=`);
      return;
    }
    value.forEach((v, i) => walk(`${prefix}[${i}]`, v, out));
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      out.push(`${encodeURIComponent(prefix)}=`);
      return;
    }
    for (const [k, v] of entries) walk(`${prefix}[${k}]`, v, out);
    return;
  }
  out.push(
    `${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`
  );
}

/** Encode a plain object as a bracket-nested form string (no leading `?`). */
export function encodeFormBody(body: Record<string, unknown>): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(body)) walk(k, v, out);
  return out.join("&");
}
