/**
 * Skill Runtime Stdlib — the DEFINED, VERSIONED contract for the code-skill
 * sandbox (BACKEND-CO-LOCATED COPY).
 *
 * This is a VERBATIM port of the Intelligence Service SSOT
 * (`synap-intelligence-service/apps/intelligence-hub/src/executors/skill-stdlib.ts`).
 * It exists so the backend can run the code-skill isolate IN-PROCESS
 * (`run-skill-in-sandbox.ts`) WITHOUT round-tripping to the IS, and so the
 * backend save-time global-reference scan (`routers/skills.ts`
 * `assertSkillGlobalsAllowed`) imports its allow-list from ONE backend source
 * instead of hand-maintaining a second copy. The cross-repo drift tripwire
 * (`__tripwires__/skill-runtime-globals.test.ts`) still asserts byte-equality of
 * this allow-list against the IS sibling until the IS copy is retired.
 *
 * DO NOT hand-edit the bootstrap or the arrays without mirroring the IS SSOT —
 * this is the exact module whose duplication caused the URLSearchParams/regex
 * drift. It is `String.raw`; preserve the escaping.
 *
 * ── Original IS module doc (unchanged) ──────────────────────────────────────
 * An isolated-vm isolate exposes ONLY pure-ECMAScript built-ins natively (see
 * `SKILL_ECMASCRIPT_GLOBALS`) — no WHATWG URL/encoding APIs, and no Node globals.
 * Every non-ECMAScript symbol a skill can use is therefore installed by ONE
 * bootstrap (`SKILL_STDLIB_BOOTSTRAP`), evaluated once per execution by the
 * skills executor. This module is the SINGLE SOURCE OF TRUTH for:
 *   1. What the bootstrap installs (host bridges + web-standard polyfills).
 *   2. The complete allow-list of globals a skill may reference
 *      (`SKILL_ALLOWED_GLOBALS`) — consumed by the backend save-time scan so an
 *      author learns at create time that e.g. `fetch`/`crypto` are NOT provided.
 *   3. The runtime version (`SKILL_RUNTIME_VERSION`) stamped on every run.
 */

/** Bumped when the installed surface changes in a way skills can observe. */
export const SKILL_RUNTIME_VERSION = 1 as const;

/**
 * Pure-ECMAScript globals an isolated-vm isolate exposes natively (verified by
 * enumerating `Object.getOwnPropertyNames(globalThis)` in a fresh isolate — see
 * the tripwire). These need no polyfill; they are allow-listed because a skill
 * may legitimately reference them. NOT a security boundary — the isolate itself
 * is the boundary; this list only tells the save-time scan which references
 * resolve at runtime.
 */
export const SKILL_ECMASCRIPT_GLOBALS = [
  "globalThis",
  "undefined",
  "NaN",
  "Infinity",
  "eval",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "unescape",
  "Object",
  "Function",
  "Boolean",
  "Symbol",
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "Number",
  "BigInt",
  "Math",
  "Date",
  "String",
  "RegExp",
  "Array",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "BigInt64Array",
  "BigUint64Array",
  "Float32Array",
  "Float64Array",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "FinalizationRegistry",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Atomics",
  "JSON",
  "Promise",
  "Reflect",
  "Proxy",
  "Intl",
  "Iterator",
  "WebAssembly",
] as const;

/**
 * Web-standard globals the bootstrap polyfills in pure JS (host objects can't
 * cross the isolate boundary, so these are spec-close JS re-implementations,
 * each smoke-tested for native parity). Ordered as installed.
 */
export const SKILL_WEB_GLOBALS = [
  "URLSearchParams",
  "URL",
  "TextEncoder",
  "TextDecoder",
  "btoa",
  "atob",
  "structuredClone",
] as const;

/**
 * Host bridges the bootstrap installs (backed by `ivm.Reference` callbacks the
 * executor sets before eval). These are the governed doors into the pod/host.
 */
export const SKILL_HOST_BRIDGES = [
  "console",
  "hubProtocol",
  "secrets",
  "host",
  "callProvider",
  "propose",
] as const;

/**
 * The two parameters the skill wrapper injects: `execute(args, context)`. They
 * are lexical parameters (not globals) but are allow-listed so a save-time scan
 * of the wrapped body never flags them.
 */
export const SKILL_WRAPPER_PARAMS = ["args", "context"] as const;

/**
 * THE allow-list: every identifier a skill may reference and have resolve at
 * runtime. The backend save-time global-reference scan rejects any free global
 * reference NOT in this set. Derived — never hand-maintained as a flat list.
 */
export const SKILL_ALLOWED_GLOBALS: readonly string[] = Object.freeze([
  ...SKILL_ECMASCRIPT_GLOBALS,
  ...SKILL_WEB_GLOBALS,
  ...SKILL_HOST_BRIDGES,
  ...SKILL_WRAPPER_PARAMS,
]);

/**
 * The ONE bootstrap. Evaluated once per skill execution inside the isolate,
 * AFTER the executor has set the `__log`, `__search`, `__getEntities`,
 * `__getDocument`, `__redeemSecret`, `__hostFetch`, `__callProvider`,
 * `__proposeEntity` references on the isolate global. Installs host bridges
 * first, then the web-standard polyfills.
 */
export const SKILL_STDLIB_BOOTSTRAP = String.raw`
  // ── Host bridges ─────────────────────────────────────────────────────────
  // copy:true so logging an object (console.log({...})) doesn't throw
  // "non-transferable" — plain objects can't cross the isolate boundary raw.
  const __LOGCOPY = { arguments: { copy: true } };
  const console = {
    log:   (...a) => __log.applySync(undefined, a, __LOGCOPY),
    warn:  (...a) => __log.applySync(undefined, a, __LOGCOPY),
    error: (...a) => __log.applySync(undefined, a, __LOGCOPY),
    info:  (...a) => __log.applySync(undefined, a, __LOGCOPY),
  };

  // { arguments: { copy: true } } deep-copies object args across the isolate
  // boundary — plain objects are NOT transferable by default, so any bridge
  // that takes an object (opts/body/input) needs it or throws
  // "A non-transferable value was passed". (host.fetch sidesteps this by
  // JSON-stringifying instead.)
  const __COPY = { arguments: { copy: true } };
  const hubProtocol = {
    search:      (query, opts) => __search.applySyncPromise(undefined, [query, opts ?? {}], __COPY),
    getEntities: (opts)        => __getEntities.applySyncPromise(undefined, [opts ?? {}], __COPY),
    getDocument: (documentId)  => __getDocument.applySyncPromise(undefined, [documentId]),
  };

  // Grant-gated vault access. secrets.get(ref) resolves a vault:// the agent was
  // granted; returns null for anything it isn't granted.
  const secrets = {
    get: (ref) => __redeemSecret.applySyncPromise(undefined, [ref]),
  };

  // External HTTP fetch (domain-gated). Returns { ok, status, headers, body } or
  // { error, message }.
  const host = {
    fetch: (url, opts) => __hostFetch.applySyncPromise(undefined, [url, opts ? JSON.stringify(opts) : undefined]),
  };

  const callProvider = (...args) => __callProvider.applySyncPromise(undefined, args, __COPY);

  // Governed write-back. propose.entity({ profileSlug, title, properties })
  // creates a PROPOSAL (never a direct write) via the propose-gated backend
  // endpoint and returns { status, proposalId, proposedEntityId }.
  const propose = {
    entity: (input) => __proposeEntity.applySyncPromise(undefined, [input ?? {}], __COPY),
  };

  // ── Web-standard globals the isolated-vm sandbox lacks ────────────────────
  // Pure-JS, native-parity polyfills. An isolate exposes ONLY ECMAScript
  // built-ins — no WHATWG URL/encoding APIs — so a skill calling e.g.
  // new URLSearchParams(...) would throw "URLSearchParams is not defined".
  globalThis.URLSearchParams = class URLSearchParams {
    constructor(init) {
      this._e = []; this._onChange = null;
      if (init == null) return;
      if (init instanceof URLSearchParams) { this._e = init._e.map((p) => [p[0], p[1]]); }
      else if (typeof init === 'string') {
        var s = init.charAt(0) === '?' ? init.slice(1) : init;
        if (s) s.split('&').forEach((pair) => {
          if (!pair) return;
          var i = pair.indexOf('=');
          var k = i < 0 ? pair : pair.slice(0, i);
          var v = i < 0 ? '' : pair.slice(i + 1);
          this._e.push([decodeURIComponent(k.replace(/\+/g, ' ')), decodeURIComponent(v.replace(/\+/g, ' '))]);
        });
      } else if (Array.isArray(init)) { init.forEach((p) => this._e.push([String(p[0]), String(p[1])])); }
      else if (typeof init === 'object') { Object.keys(init).forEach((k) => this._e.push([k, String(init[k])])); }
    }
    _changed() { if (this._onChange) this._onChange(); }
    append(k, v) { this._e.push([String(k), String(v)]); this._changed(); }
    set(k, v) {
      k = String(k); v = String(v);
      var idx = this._e.findIndex((p) => p[0] === k);
      if (idx < 0) { this._e.push([k, v]); }
      else { this._e[idx] = [k, v]; this._e = this._e.filter((p, i) => i === idx || p[0] !== k); }
      this._changed();
    }
    get(k) { var f = this._e.find((p) => p[0] === String(k)); return f ? f[1] : null; }
    getAll(k) { return this._e.filter((p) => p[0] === String(k)).map((p) => p[1]); }
    has(k) { return this._e.some((p) => p[0] === String(k)); }
    delete(k) { this._e = this._e.filter((p) => p[0] !== String(k)); this._changed(); }
    forEach(cb, thisArg) { this._e.forEach((p) => cb.call(thisArg, p[1], p[0], this)); }
    keys() { return this._e.map((p) => p[0])[Symbol.iterator](); }
    values() { return this._e.map((p) => p[1])[Symbol.iterator](); }
    entries() { return this._e.map((p) => [p[0], p[1]])[Symbol.iterator](); }
    [Symbol.iterator]() { return this._e.map((p) => [p[0], p[1]])[Symbol.iterator](); }
    sort() { this._e.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); this._changed(); }
    get size() { return this._e.length; }
    toString() { var enc = (x) => encodeURIComponent(x).replace(/%20/g, '+'); return this._e.map((p) => enc(p[0]) + '=' + enc(p[1])).join('&'); }
  };

  globalThis.URL = class URL {
    constructor(input, base) {
      input = String(input);
      var RE = /^([a-zA-Z][a-zA-Z0-9+.-]*:)\/\/([^\/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/;
      var m = input.match(RE);
      if (!m && base !== undefined) {
        var b = new URL(base);
        if (input.charAt(0) === '/') { input = b.protocol + '//' + b.host + input; }
        else if (input.charAt(0) === '?') { input = b.protocol + '//' + b.host + b.pathname + input; }
        else if (input.charAt(0) === '#') { input = b.protocol + '//' + b.host + b.pathname + b.search + input; }
        else { var basePath = b.pathname.replace(/[^\/]*$/, ''); input = b.protocol + '//' + b.host + basePath + input; }
        m = input.match(RE);
      }
      if (!m) throw new TypeError('Invalid URL: ' + input);
      this.protocol = m[1];
      var auth = m[2]; var host = auth; var at = auth.indexOf('@');
      this.username = ''; this.password = '';
      if (at >= 0) { var cred = auth.slice(0, at); host = auth.slice(at + 1); var ci = cred.indexOf(':'); this.username = ci < 0 ? cred : cred.slice(0, ci); this.password = ci < 0 ? '' : cred.slice(ci + 1); }
      this.host = host;
      var ci2 = host.indexOf(':');
      this.hostname = ci2 < 0 ? host : host.slice(0, ci2);
      this.port = ci2 < 0 ? '' : host.slice(ci2 + 1);
      this.pathname = m[3] || '/';
      this._search = m[4] || '';
      this.hash = m[5] || '';
      var self = this;
      this._sp = new URLSearchParams(this._search);
      this._sp._onChange = function () { var q = self._sp.toString(); self._search = q ? '?' + q : ''; };
    }
    get search() { return this._search; }
    set search(v) { v = String(v); this._search = v ? (v.charAt(0) === '?' ? v : '?' + v) : ''; var self = this; this._sp = new URLSearchParams(this._search); this._sp._onChange = function () { var q = self._sp.toString(); self._search = q ? '?' + q : ''; }; }
    get searchParams() { return this._sp; }
    get origin() { return this.protocol + '//' + this.host; }
    get href() { return this.protocol + '//' + (this.username ? this.username + (this.password ? ':' + this.password : '') + '@' : '') + this.host + this.pathname + this.search + this.hash; }
    toString() { return this.href; }
    toJSON() { return this.href; }
  };

  globalThis.TextEncoder = class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(str) {
      str = str === undefined ? '' : String(str);
      var utf8 = unescape(encodeURIComponent(str));
      var arr = new Uint8Array(utf8.length);
      for (var i = 0; i < utf8.length; i++) arr[i] = utf8.charCodeAt(i);
      return arr;
    }
  };
  globalThis.TextDecoder = class TextDecoder {
    constructor(label) { this._enc = label ? String(label).toLowerCase() : 'utf-8'; }
    get encoding() { return 'utf-8'; }
    decode(input) {
      if (input == null) return '';
      var bytes = input instanceof Uint8Array ? input : new Uint8Array(input.buffer || input);
      var bin = '';
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return decodeURIComponent(escape(bin));
    }
  };

  globalThis.btoa = function btoa(str) {
    str = String(str);
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    var out = '';
    for (var i = 0; i < str.length; i += 3) {
      var c1 = str.charCodeAt(i), c2 = str.charCodeAt(i + 1), c3 = str.charCodeAt(i + 2);
      if (c1 > 255 || (!isNaN(c2) && c2 > 255) || (!isNaN(c3) && c3 > 255)) throw new Error('btoa: invalid character');
      var e1 = c1 >> 2;
      var e2 = ((c1 & 3) << 4) | ((isNaN(c2) ? 0 : c2) >> 4);
      var e3 = isNaN(c2) ? 64 : (((c2 & 15) << 2) | ((isNaN(c3) ? 0 : c3) >> 6));
      var e4 = isNaN(c3) ? 64 : (c3 & 63);
      out += chars.charAt(e1) + chars.charAt(e2) + chars.charAt(e3) + chars.charAt(e4);
    }
    return out;
  };
  globalThis.atob = function atob(b64) {
    b64 = String(b64).replace(/[ \t\n\f\r]/g, '').replace(/=+$/, '');
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var out = '', bits = 0, acc = 0;
    for (var i = 0; i < b64.length; i++) {
      var idx = chars.indexOf(b64.charAt(i));
      if (idx < 0) continue;
      acc = (acc << 6) | idx; bits += 6;
      if (bits >= 8) { bits -= 8; out += String.fromCharCode((acc >> bits) & 0xff); }
    }
    return out;
  };

  globalThis.structuredClone = function structuredClone(value) {
    var seen = new WeakMap();
    function clone(v) {
      if (v === null || typeof v !== 'object') return v;
      if (seen.has(v)) return seen.get(v);
      if (v instanceof Date) return new Date(v.getTime());
      if (v instanceof RegExp) return new RegExp(v.source, v.flags);
      if (Array.isArray(v)) { var a = []; seen.set(v, a); for (var i = 0; i < v.length; i++) a[i] = clone(v[i]); return a; }
      if (v instanceof Map) { var m = new Map(); seen.set(v, m); v.forEach((val, key) => m.set(clone(key), clone(val))); return m; }
      if (v instanceof Set) { var s = new Set(); seen.set(v, s); v.forEach((val) => s.add(clone(val))); return s; }
      if (ArrayBuffer.isView(v)) { return new v.constructor(v); }
      if (v instanceof ArrayBuffer) { return v.slice(0); }
      var o = {}; seen.set(v, o); for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = clone(v[k]); return o;
    }
    return clone(value);
  };
`;
