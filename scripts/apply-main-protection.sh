#!/usr/bin/env bash
# Make the Synap Release GitHub App the only non-admin bypass on main, and
# require a pull request plus the CI checks for every other change.
# SECURITY-RELEASE-RUNBOOK.md §5.4 (when to run it) and §6 (what it writes).
#
#   scripts/apply-main-protection.sh <app-id> [--approvals N] [--apply]
#
# Without --apply it prints the ruleset it would write and changes nothing.
# Needs: gh logged in as an organization owner, jq.
set -euo pipefail

REPO="Synap-core/backend"
RULESET_ID=25542891            # "base branch security", target: the default branch
GITHUB_ACTIONS_APP_ID=15368    # the integration that posts the CI check runs
# The CI check run names, from ci.yml and reference-docs.yml. A renamed job must
# be renamed here too, or every pull request waits on a check that never runs.
REQUIRED_CHECKS=("Release gate" "Full suite" "API e2e" "Reference docs are current")

usage() { echo "usage: $0 <app-id> [--approvals N] [--apply]" >&2; exit 2; }

APP_ID=""
APPROVALS=0
APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --approvals) [ $# -ge 2 ] || usage; APPROVALS="$2"; shift ;;
    -h|--help) usage ;;
    *) [ -z "$APP_ID" ] || usage; APP_ID="$1" ;;
  esac
  shift
done
[[ "$APP_ID" =~ ^[0-9]+$ ]] || { echo "app id must be the numeric App ID (App settings page)" >&2; usage; }
[[ "$APPROVALS" =~ ^[0-9]+$ ]] || { echo "--approvals takes a number" >&2; usage; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

CURRENT=$(gh api "repos/$REPO/rulesets/$RULESET_ID")
NAME=$(jq -r .name <<<"$CURRENT")
[ "$NAME" = "base branch security" ] || { echo "ruleset $RULESET_ID is '$NAME', not 'base branch security': stop" >&2; exit 1; }

# Refuse a check name that main's latest CI commit did not report: requiring
# it would block every pull request. (Not main's head: the type publish's
# bump commit is [skip ci] and carries no check runs.)
MAIN_SHA=$(gh run list -R "$REPO" --branch main --workflow ci.yml --event push -L 1 --json headSha --jq '.[0].headSha')
[ -n "$MAIN_SHA" ] || { echo "no CI run on main found: stop" >&2; exit 1; }
SEEN=$(gh api "repos/$REPO/commits/$MAIN_SHA/check-runs?per_page=100" \
  --jq ".check_runs[] | select(.app.id == $GITHUB_ACTIONS_APP_ID) | .name")
for check in "${REQUIRED_CHECKS[@]}"; do
  grep -qxF "$check" <<<"$SEEN" || { echo "check '$check' has no run on main ($MAIN_SHA): stop" >&2; exit 1; }
done

CHECKS_JSON=$(printf '%s\n' "${REQUIRED_CHECKS[@]}" |
  jq -R --argjson app "$GITHUB_ACTIONS_APP_ID" '{context: ., integration_id: $app}' | jq -s .)

NEW=$(jq \
  --argjson appId "$APP_ID" \
  --argjson approvals "$APPROVALS" \
  --argjson checks "$CHECKS_JSON" '
  {
    name, target, enforcement, conditions,
    rules: (
      [.rules[] | select(.type != "pull_request" and .type != "required_status_checks")]
      + [
          { type: "pull_request", parameters: {
              required_approving_review_count: $approvals,
              dismiss_stale_reviews_on_push: false,
              require_code_owner_review: false,
              require_last_push_approval: false,
              required_review_thread_resolution: false } },
          { type: "required_status_checks", parameters: {
              strict_required_status_checks_policy: false,
              do_not_enforce_on_create: false,
              required_status_checks: $checks } }
        ]
    ),
    bypass_actors: [
      { actor_id: null,   actor_type: "OrganizationAdmin", bypass_mode: "always" },
      { actor_id: $appId, actor_type: "Integration",       bypass_mode: "always" }
    ]
  }' <<<"$CURRENT")

echo "== ruleset $RULESET_ID now"
jq '{rules, bypass_actors}' <<<"$CURRENT"
echo "== ruleset $RULESET_ID after"
jq '{rules, bypass_actors}' <<<"$NEW"

if [ "$APPLY" -ne 1 ]; then
  echo "dry run: nothing written. Re-run with --apply to write it."
  exit 0
fi

# Once only the App may push, a publish without the App would have npm accept
# the version and then fail to push its bump commit. So the App must already
# be what publish-types.yml mints (runbook §5.3).
REPO_APP_ID=$(gh api "repos/$REPO/actions/variables/SYNAP_RELEASE_APP_ID" --jq .value 2>/dev/null) || REPO_APP_ID=""
[ "$REPO_APP_ID" = "$APP_ID" ] || {
  echo "repo variable SYNAP_RELEASE_APP_ID is '${REPO_APP_ID:-unset}', not $APP_ID: set it (and SYNAP_RELEASE_APP_KEY) first" >&2
  exit 1
}

gh api -X PUT "repos/$REPO/rulesets/$RULESET_ID" --input - <<<"$NEW" \
  --jq '{id, enforcement, updated_at, bypass_actors, rules: [.rules[].type]}'
echo "written."
