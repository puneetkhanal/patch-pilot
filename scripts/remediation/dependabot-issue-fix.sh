#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
source "$script_dir/fix-common.sh"
[[ "${1:-}" == fix ]] || { echo "usage: $0 fix OWNER/REPO ALERT [options]" >&2; exit 2; }; shift; repo="$1"; alert="$2"; shift 2
repo_root="${DEPENDABOT_FIX_REPO_ROOT:-}"; push=0; open_pr=0; skip_fix=0; reuse=0; reset=0; skip_origin=0
while (($#)); do case "$1" in --repo-root) repo_root="$2";shift 2;;--push)push=1;shift;;--open-pr)open_pr=1;shift;;--skip-fix)skip_fix=1;shift;;--reuse-worktree)reuse=1;shift;;--reset-to-base)reset=1;shift;;--skip-origin)skip_origin=1;shift;;*)shift;;esac;done
json="$(gh api "repos/$repo/dependabot/alerts/$alert")"; eco="$(node -e 'let x=JSON.parse(process.argv[1]);console.log(x.dependency.package.ecosystem.toLowerCase())' "$json")"; [[ "$eco" == npm ]] || { echo "Expected npm alert, got $eco" >&2; exit 3; }
pkg="$(node -e 'let x=JSON.parse(process.argv[1]);console.log(x.dependency.package.name)' "$json")"; manifest="$(node -e 'let x=JSON.parse(process.argv[1]);console.log(x.dependency.manifest_path)' "$json")"; patched="$(node -e 'let x=JSON.parse(process.argv[1]);console.log(x.security_vulnerability.first_patched_version?.identifier||"")' "$json")"; [[ -n "$patched" ]] || { echo "No patched version" >&2; exit 4; }
root="$(resolve_repo "$repo" "$repo_root")"; parent="$(dirname "$root")/.dependabot-worktrees"; mkdir -p "$parent"; name="${repo#*/}"; wt="$parent/$(slugify "$name")-alert-$alert"; branch="security-fix/dependabot/$(slugify "$manifest")/npm/$(slugify "$pkg")-$(slugify "$patched")"; base="$(git -C "$root" remote show origin | sed -n '/HEAD branch/s/.*: //p')"; base="${base:-main}"; git -C "$root" fetch origin "$base" --prune
if [[ -d "$wt/.git" || -f "$wt/.git" ]]; then
  git -C "$wt" fetch origin "$branch" "$base" --prune 2>/dev/null || git -C "$wt" fetch origin --prune
  git -C "$wt" checkout "$branch" 2>/dev/null || git -C "$wt" checkout -B "$branch" "origin/$branch" 2>/dev/null || git -C "$wt" checkout -B "$branch" "origin/$base"
else
  git -C "$root" worktree add -B "$branch" "$wt" "origin/$base"
fi
cd "$wt"; [[ $reset == 1 ]] && git reset --hard "origin/$base"
if [[ $skip_fix == 0 ]]; then
  bump_manifest="$(resolve_npm_manifest "$manifest")"
  node "$script_dir/_npm_bump.mjs" "$bump_manifest" "$pkg" "$patched"
  run_hook "${REMEDIATION_PRE_INSTALL_SCRIPT:-}"
  mdir="$(dirname "$bump_manifest")"
  (cd "$mdir" && npm install)
  if [[ -n "${REMEDIATION_AGENT_PROVIDER:-}" ]]; then
    node "$script_dir/run-fix-agent.mjs" --provider "$REMEDIATION_AGENT_PROVIDER" --skill "$REMEDIATION_AGENT_SKILL" --skill-file "$REMEDIATION_AGENT_SKILL_FILE" --repo "$repo" --alert "$alert" --package "$pkg" --target "$patched" --manifest "$bump_manifest"
  fi
  [[ $skip_origin == 1 ]] || run_hook "${REMEDIATION_POST_BUMP_HOOK:-}"
  git add -A
  if git diff --cached --quiet; then
    ahead="$(git rev-list --count "origin/$base..HEAD")"
    [[ "$ahead" -gt 0 ]] || { echo "Fix produced no changes and the remediation branch has no commits beyond origin/$base" >&2; exit 5; }
    echo "No new changes; retaining $ahead existing remediation commit(s)"
  else
    git commit -m "security: bump $pkg to $patched"
  fi
fi
commit="$(git rev-parse HEAD)"
if [[ $push == 1 || $open_pr == 1 ]]; then
  ahead="$(git rev-list --count "origin/$base..HEAD")"
  [[ "$ahead" -gt 0 ]] || { echo "Cannot publish remediation: branch $branch has no commits beyond origin/$base. Run Fix again before Create PR." >&2; exit 6; }
fi
[[ $push == 1 ]] && git push --force-with-lease -u origin "$branch"
pr=""
if [[ $open_pr == 1 ]]; then
  pr="$(gh pr list --repo "$repo" --head "$branch" --state open --json url --jq '.[0].url // empty')"
  [[ -n "$pr" ]] || pr="$(gh pr create --repo "$repo" --head "$branch" --base "$base" --title "Security: bump $pkg to $patched" --body "Automated Dependabot remediation for alert #$alert")"
elif [[ $push == 1 ]]; then
  pr="$(gh pr list --repo "$repo" --head "$branch" --state open --json url --jq '.[0].url // empty')"
fi
echo "branch: $branch"; echo "commit: $commit"; echo "worktree_path: $wt"; [[ -n "$pr" ]] && echo "pr_url: $pr"
