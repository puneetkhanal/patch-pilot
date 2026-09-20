#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
source "$script_dir/fix-common.sh"

[[ "${1:-}" == fix ]] || { echo "usage: $0 fix OWNER/REPO --alerts N,N --batch-id ID [options]" >&2; exit 2; }
shift
repo="${1:-}"; shift || true
[[ -n "$repo" ]] || { echo "OWNER/REPO required" >&2; exit 2; }

alerts=""; batch_id=""; repo_root="${DEPENDABOT_FIX_REPO_ROOT:-}"; push=0; open_pr=0; skip_fix=0; reset=0; continue_on_error=0
while (($#)); do
  case "$1" in
    --alerts) alerts="$2"; shift 2 ;;
    --batch-id) batch_id="$2"; shift 2 ;;
    --repo-root) repo_root="$2"; shift 2 ;;
    --push) push=1; shift ;;
    --open-pr) open_pr=1; shift ;;
    --skip-fix) skip_fix=1; shift ;;
    --reuse-worktree) shift ;;
    --reset-to-base) reset=1; shift ;;
    --skip-origin) export SKIP_POST_BUMP_HOOK=1; shift ;;
    --continue-on-error) continue_on_error=1; shift ;;
    --fail-fast) continue_on_error=0; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$alerts" && -n "$batch_id" ]] || { echo "--alerts and --batch-id are required" >&2; exit 2; }

root="$(resolve_repo "$repo" "$repo_root")"
parent="$(dirname "$root")/.dependabot-worktrees"
mkdir -p "$parent"
wt="$parent/$(slugify "${repo#*/}")-batch-$(slugify "$batch_id")"
branch="security-fix/dependabot/batch/$(slugify "$batch_id")"
base="$(git -C "$root" remote show origin | sed -n '/HEAD branch/s/.*: //p')"
base="${base:-main}"
git -C "$root" fetch origin "$base" --prune
if [[ -e "$wt/.git" ]]; then
  git -C "$wt" fetch origin "$branch" "$base" --prune 2>/dev/null || git -C "$wt" fetch origin --prune
  git -C "$wt" checkout "$branch" 2>/dev/null || git -C "$wt" checkout -B "$branch" "origin/$branch" 2>/dev/null || git -C "$wt" checkout -B "$branch" "origin/$base"
else
  git -C "$root" worktree add -B "$branch" "$wt" "origin/$base"
fi
cd "$wt"
[[ $reset == 1 ]] && git reset --hard "origin/$base"

failures=0
manifest_dirs=()
if [[ $skip_fix == 0 ]]; then
  IFS=',' read -r -a alert_list <<< "$alerts"
  for alert in "${alert_list[@]}"; do
    json="$(gh api "repos/$repo/dependabot/alerts/$alert")"
    ecosystem="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.dependency.package.ecosystem.toLowerCase())' "$json")"
    if [[ "$ecosystem" != npm ]]; then
      echo "Alert $alert is not an npm alert" >&2
      failures=$((failures + 1)); [[ $continue_on_error == 1 ]] && continue || exit 3
    fi
    package_name="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.dependency.package.name)' "$json")"
    manifest="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.dependency.manifest_path)' "$json")"
    patched="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.security_vulnerability.first_patched_version?.identifier || "")' "$json")"
    if [[ -z "$patched" ]]; then
      echo "Alert $alert has no patched version" >&2
      failures=$((failures + 1)); [[ $continue_on_error == 1 ]] && continue || exit 4
    fi
    bump_manifest="$(resolve_npm_manifest "$manifest")"
    if ! node "$script_dir/_npm_bump.mjs" "$bump_manifest" "$package_name" "$patched"; then
      failures=$((failures + 1)); [[ $continue_on_error == 1 ]] && continue || exit 5
    fi
    dir="$(dirname "$bump_manifest")"
    found=0; for existing in "${manifest_dirs[@]:-}"; do [[ "$existing" == "$dir" ]] && found=1; done
    [[ $found == 1 ]] || manifest_dirs+=("$dir")
  done
  run_hook "${REMEDIATION_PRE_INSTALL_SCRIPT:-}"
  for dir in "${manifest_dirs[@]}"; do (cd "$dir" && npm install); done
  if [[ -n "${REMEDIATION_AGENT_PROVIDER:-}" ]]; then
    for alert in "${alert_list[@]}"; do
      json="$(gh api "repos/$repo/dependabot/alerts/$alert")"
      package_name="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.dependency.package.name)' "$json")"
      manifest="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.dependency.manifest_path)' "$json")"
      patched="$(node -e 'const x=JSON.parse(process.argv[1]); console.log(x.security_vulnerability.first_patched_version?.identifier || "")' "$json")"
      bump_manifest="$(resolve_npm_manifest "$manifest")"
      analysis_json="$(node -e 'const map=JSON.parse(process.env.REMEDIATION_BATCH_UPGRADE_ANALYSES_JSON||"{}");const entry=map[process.argv[1]];if(entry)process.stdout.write(JSON.stringify(entry));' "$alert")"
      REMEDIATION_DEPENDENCY_ANALYSIS_JSON="${analysis_json:-No dependency-engine result was supplied.}" \
        node "$script_dir/run-fix-agent.mjs" --provider "$REMEDIATION_AGENT_PROVIDER" --skill "$REMEDIATION_AGENT_SKILL" --skill-file "$REMEDIATION_AGENT_SKILL_FILE" --repo "$repo" --alert "$alert" --package "$package_name" --target "$patched" --manifest "$bump_manifest"
    done
  fi
  [[ "${SKIP_POST_BUMP_HOOK:-0}" == 1 ]] || run_hook "${REMEDIATION_POST_BUMP_HOOK:-}"
  git add -A
  if git diff --cached --quiet; then
    ahead="$(git rev-list --count "origin/$base..HEAD")"
    [[ "$ahead" -gt 0 ]] || { echo "Batch fix produced no changes and the remediation branch has no commits beyond origin/$base" >&2; exit 5; }
    echo "No new changes; retaining $ahead existing remediation commit(s)"
  else
    git commit -m "security: batch Dependabot updates"
  fi
fi

commit="$(git rev-parse HEAD)"
if [[ $push == 1 || $open_pr == 1 ]]; then
  ahead="$(git rev-list --count "origin/$base..HEAD")"
  [[ "$ahead" -gt 0 ]] || { echo "Cannot publish remediation: branch $branch has no commits beyond origin/$base. Run the batch fix again before Create PR." >&2; exit 7; }
fi
[[ $push == 1 ]] && git push --force-with-lease -u origin "$branch"
pr=""
if [[ $open_pr == 1 ]]; then
  pr="$(gh pr list --repo "$repo" --head "$branch" --state open --json url --jq '.[0].url // empty')"
  [[ -n "$pr" ]] || pr="$(gh pr create --repo "$repo" --head "$branch" --base "$base" --title "Security: batch Dependabot updates" --body "Automated JavaScript Dependabot remediation batch $batch_id")"
elif [[ $push == 1 ]]; then
  pr="$(gh pr list --repo "$repo" --head "$branch" --state open --json url --jq '.[0].url // empty')"
fi
echo "branch: $branch"
echo "commit: $commit"
echo "worktree_path: $wt"
[[ -n "$pr" ]] && echo "pr_url: $pr"
[[ $failures == 0 ]] || { echo "$failures alert(s) failed" >&2; exit 6; }
