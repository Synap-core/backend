# Public Suffix List: `pod.synap.live`

Synap's tenant pods live under `pod.synap.live` (`{name}.pod.synap.live`, with the console at
`admin.{name}.pod.synap.live`). Listing `pod.synap.live` as a private suffix makes browsers treat each
`{name}.pod.synap.live` as its own site. Tenants can't set or read each other's cookies, and SameSite
protects them from each other and from Synap's own hosts. `synap.live` itself is not listed, so Synap's
sign-in, landing and apps stay one site.

Synap's own code already applies this rule, so it doesn't wait for the list. The rule is stated once in the backend
(`@synap-core/types/tenancy`: `TENANT_ZONES`, `podHostsForName`, `consoleHostForPod`). The pod's CORS and realtime
use it directly. The installer (`synap_tenant_zones`, `shared_cookie_domain`) and desktop main
(`electron/main/connection/registrable-domain.ts`, `SYNAP_TENANT_DOMAINS`) keep copies, and a parity test pins each
one to the module. No pod scopes a cookie or a first-party base to `pod.synap.live` or `synap.live`.

## Before opening the pull request

Every item must be true first. Once a browser ships the entry it can't be rolled back on our schedule.

- [ ] Synap's own cookies are host-only: the Control Plane session, the hosted apps' session and
      `SYNAP_INSTANCE_URL` (wave 6 lane G7c). A `Domain=.synap.live` cookie is still sent to every pod host,
      so this matters whether or not the entry is accepted.
- [ ] Federated sign-in from the hosted apps runs as a top-level navigation on the pod, not a credentialed
      cross-site fetch (lane G7c).
- [ ] Every live pod has moved to `{name}.pod.synap.live` (Control Plane `pnpm ops:move-pod-names`), every move
      window has ended (`--end-windows`), and no pod is left under `synap.live`, nested or flat.
- [ ] A role mailbox exists and is watched, with replies within 30 days: `security@synap.live`.
- [ ] An abuse-report page is published on synap.live (for example `https://synap.live/abuse`), linked from the
      footer, naming that mailbox.
- [ ] `synap.live` has 2 or more years of registration left, kept above 1 year from then on.
- [ ] We can state the number of distinct users the pods serve. The guidelines say entries are considered from
      roughly 2,000–3,000 users; below that, expect the request to be declined, and keep relying on the cookie
      fixes and desktop's local rule.

## The entry

In `public_suffix_list.dat`, inside `===BEGIN PRIVATE DOMAINS===`, sorted by organisation name: after the
`// Surge` block and before `// Syncloud`. Check the neighbours again when you open the PR, since the file moves.

```
// Synap : https://synap.live
// Submitted by Synap Security <security@synap.live>
pod.synap.live
```

## DNS proof

Add a TXT record and leave it in place for as long as the entry exists:

```
_psl.pod.synap.live.  TXT  "https://github.com/publicsuffix/list/pull/NNNN"
```

The record sits on the name being listed (`pod.synap.live`). Check it with `dig +short TXT _psl.pod.synap.live`.

Staging names its pods under `pod.staging.synap.live`, and Synap's code treats that zone the same way. It isn't part
of this request, because no real users are on staging. Add it to the same entry only if that changes.

## Pull request text (fill in the bracketed parts)

**Description of organisation.** Synap makes a personal data pod: each person or team runs their own server, the
pod, which Synap hosts on request or the owner runs themselves. The submitter, [name], is [role] at Synap.

**Reason for PSL inclusion.** Every pod gets its own name under `pod.synap.live` (`alice.pod.synap.live`), with its
admin console at `admin.alice.pod.synap.live`. Each pod is operated for a different person, and some are run by
their owners on their own machines. So one pod must never read or set another pod's cookies, and must not count as
the same site as another pod or as Synap's own services on `synap.live`. Listing `pod.synap.live` gives every pod
that boundary in browsers. Synap's own services stay on `synap.live`, which we are not asking to list.

**DNS verification.** `dig +short TXT _psl.pod.synap.live` returns this PR's URL.

**Number of users.** [N] thousand distinct users across [M] pods.

**Abuse contact.** [https://synap.live/abuse]

**Primary domain.** `pod.synap.live` is a subdomain of our primary domain. We have checked that no cookie Synap
sets is scoped to `pod.synap.live` or set by a pod for the parent, and that Synap's own cookies on `synap.live`
are host-only. We understand that inclusion can't be rolled back quickly.

## After it merges

- Desktop and any server code that bundles the list (`tldts`) get it from the next release; bump `tldts` then.
  Keep `TENANT_ZONES` and its copies (`SYNAP_TENANT_DOMAINS` in desktop, `synap_tenant_zones` in the installer)
  either way: they are the rule Synap enforces itself.
- Chromium (and so Electron) carries the list compiled in, so expect months before every browser has it.
