#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "$0")" && pwd)"
source "$script_dir/fix-common.sh"

[[ "${1:-}" =~ ^(fix|refresh-github)$ ]] || { echo "usage: $0 fix|refresh-github OWNER/REPO --manifest PATH --package NAME --target VERSION [options]" >&2; exit 2; }
mode="$1"; shift
repo="${1:-}"; shift || true
manifest="package.json"; package_name=""; target=""; repo_root="${DEPENDABOT_FIX_REPO_ROOT:-}"; push=0; open_pr=0; skip_origin=0
while (($#)); do
  case "$1" in
    --manifest) manifest="$2"; shift 2 ;;
    --package) package_name="$2"; shift 2 ;;
    --target) target="$2"; shift 2 ;;
    --repo-root) repo_root="$2"; shift 2 ;;
    --push) push=1; shift ;;
    --open-pr) open_pr=1; shift ;;
    --skip-origin) skip_origin=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$repo" && -n "$package_name" && -n "$target" ]] || { echo "repo, --package, and --target are required" >&2; exit 2; }

root="$(resolve_repo "$repo" "$repo_root")"
parent="$(dirname "$root")/.dependabot-worktrees"; mkdir -p "$parent"
branch="security-fix/package-update/$(slugify "$manifest")/$(slugify "$package_name")-$(slugify "$target")"
wt="$parent/$(slugify "${repo#*/}")-package-$(slugify "$package_name")-$(slugify "$target")"
base="$(git -C "$root" remote show origin | sed -n '/HEAD branch/s/.*: //p')"; base="${base:-main}"
git -C "$root" fetch origin "$base" --prune
[[ -e "$wt/.git" ]] || git -C "$root" worktree add -B "$branch" "$wt" "origin/$base"
cd "$wt"
node "$script_dir/_npm_bump.mjs" --direct-bump "$manifest" "$package_name" "$target"
run_hook "${REMEDIATION_PRE_INSTALL_SCRIPT:-}"
(cd "$(dirname "$manifest")" && npm install)
[[ $skip_origin == 1 ]] || run_hook "${REMEDIATION_POST_BUMP_HOOK:-}"
git add -A
if git diff --cached --quiet; then echo "No new commit (fix already applied)"; else git commit -m "build: update $package_name to $target"; fi
commit="$(git rev-parse HEAD)"
[[ $push == 1 ]] && git push --force-with-lease -u origin "$branch"
pr=""
if [[ $open_pr == 1 ]]; then
  pr="$(gh pr list --repo "$repo" --head "$branch" --state open --json url --jq '.[0].url // empty')"
  [[ -n "$pr" ]] || pr="$(gh pr create --repo "$repo" --head "$branch" --base "$base" --title "Update $package_name to $target" --body "Automated JavaScript package update")"
fi
emit_remediation_result "$branch" "$commit" "$wt" "$pr"
