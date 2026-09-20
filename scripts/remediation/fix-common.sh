#!/usr/bin/env bash
set -euo pipefail
slugify(){ printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/\.lock([^-]|$)/lock\1/g;s/[^a-z0-9]+/-/g;s/^-+|-+$//g'; }
run_hook(){ local p="$1"; [[ -z "$p" ]] && return 0; [[ -x "$p" ]] || { echo "Hook is not executable: $p" >&2; return 2; }; "$p"; }
resolve_repo(){ local repo="$1" root="$2"; if [[ -n "$root" && -d "$root/.git" ]]; then echo "$root"; return; fi; local cache="${DEPENDABOT_FIX_CACHE_ROOT:-$HOME/.cache/dependabot-orchestrator}"; mkdir -p "$cache"; local name="${repo#*/}" dst="$cache/$name"; if [[ ! -d "$dst/.git" ]]; then gh repo clone "$repo" "$dst"; else git -C "$dst" fetch origin --prune; fi; echo "$dst"; }
resolve_npm_manifest(){
  local reported="$1" candidate
  case "$(basename "$reported")" in
    package-lock.json|npm-shrinkwrap.json)
      candidate="$(dirname "$reported")/package.json"
      [[ -f "$candidate" ]] || { echo "No package.json found beside reported lockfile $reported" >&2; return 5; }
      printf '%s\n' "$candidate"
      ;;
    *) printf '%s\n' "$reported" ;;
  esac
}
