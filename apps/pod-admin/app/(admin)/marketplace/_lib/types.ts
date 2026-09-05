/**
 * Wire shapes Pod Admin reads back from the pod's install door.
 *
 * These mirror what the pod actually returns — `WorkspacePreflightReport`
 * (@synap/database) and the `/packages/apply` result — rather than an
 * idealised shape. In particular the apply result has NO `success` field:
 * reading one that the producer never writes is how a landed install once
 * reported "failed: Unknown error".
 */

export interface PreflightReport {
  dryRun: true;
  /** False ONLY on a structural failure. Advisory findings never flip it. */
  ok: boolean;
  validationErrors: string[];
  profiles: {
    create: string[];
    reused: string[];
    conflicts: { slug: string; existingKind: string; declaredKind: string }[];
    deferred: { slug: string; reason: string }[];
    scopeConflicts: {
      slug: string;
      existingScope: string;
      declaredScope: string;
      existingEntityScope: string;
      declaredEntityScope: "pod" | "workspace" | null;
    }[];
  };
  entityLinks: { unresolved: string[] };
  /**
   * The key is `wouldOrphan`, not `orphaned` — verified against a live report
   * from the pod, not guessed from the field's meaning. Reading the wrong key
   * renders `undefined` and silently drops a whole finding, which is the
   * "confident empty preview" failure this surface exists to prevent.
   */
  views: { wouldOrphan: string[] };
}

/**
 * What `workspaces.createFromDefinition` returns. FLAT — there is no `workspace`
 * wrapper and, notably, no `success` field: the discriminators are `status` and
 * `outcome`, and reading anything else would be inventing a promise the
 * producer never made.
 *
 * `outcome` is the one that matters on a re-install: `"unchanged"` means the
 * pod found the workspace already current and wrote nothing, `"reconciled"`
 * means it updated an existing one. Calling either "created" would be a lie the
 * response itself contradicts.
 *
 * `status: "pending"` means the workspace row exists but provisioning has not
 * finished — reported as in-progress, never as done.
 */
export interface AppliedResult {
  status?: "created" | "pending";
  outcome?: "created" | "reconciled" | "unchanged";
  workspaceId?: string;
  dependencies?: { slug: string; status?: string }[];
  [key: string]: unknown;
}

export interface InstallError {
  error: string;
  /** Set by our own forwarder when the pod rejected the browser session. */
  reason?: string;
  detail?: string;
  validationErrors?: string[];
  conflicts?: { slug: string; existingKind: string; declaredKind: string }[];
}
