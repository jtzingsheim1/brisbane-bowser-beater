# Sourced by wait-checks.sh and wait-deploy.sh: repository detection and
# GitHub REST GETs that report failures instead of hiding them.
REPO="${REPO:-$(git remote get-url origin 2>/dev/null | sed -E 's#/$##; s#\.git$##; s#.*[:/]([^/]+/[^/]+)$#\1#')}"
[ -n "$REPO" ] || { echo "set REPO=owner/name (no origin remote found)"; exit 2; }
API="https://api.github.com/repos/$REPO"
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"   # anonymous calls are limited to 60 an hour
LAST_HTTP=""

# gh_get PATH: sets BODY and HTTP. Returns 0 on success and 1 on a transient
# failure (network error or 5xx), so the caller polls again. Exits 2 with
# GitHub's own message when polling cannot help: not found, invalid, auth or
# rate limit. The token is passed on stdin so it never appears in `ps`.
gh_get() {
  local out
  if [ -n "$TOKEN" ]; then
    out=$(curl -sS -w $'\n%{http_code}' -H @- -H "Accept: application/vnd.github+json" \
          "$API/$1" 2>/dev/null <<<"Authorization: Bearer $TOKEN") || out=$'\n000'
  else
    out=$(curl -sS -w $'\n%{http_code}' -H "Accept: application/vnd.github+json" \
          "$API/$1" 2>/dev/null) || out=$'\n000'
  fi
  HTTP=${out##*$'\n'}; BODY=${out%$'\n'*}; LAST_HTTP=$HTTP
  case "$HTTP" in
    2??) return 0 ;;
    401|403|404|422|429)
      echo "GitHub API returned $HTTP for $1: $(python3 -c '
import sys, json
try:
    print(json.loads(sys.stdin.read()).get("message", "(no message)"))
except ValueError:
    print("(non-JSON response)")' <<<"$BODY")"
      exit 2 ;;
    *) return 1 ;;
  esac
}

# gh_get_all PATH KEY DIR [PREFIX]: fetches every page of a list endpoint
# (PATH already contains "?") into DIR/<PREFIX>-<n>.json, PREFIX defaulting to
# KEY. Returns 1 on a transient failure.
gh_get_all() {
  local page=1 n prefix="${4:-$2}"
  rm -f "$3/$prefix"-*.json
  while :; do
    gh_get "$1&per_page=100&page=$page" || return 1
    printf '%s' "$BODY" > "$3/$prefix-$page.json"
    n=$(python3 -c 'import sys, json; print(len(json.load(sys.stdin).get(sys.argv[1], [])))' "$2" <<<"$BODY")
    [ "$n" -lt 100 ] && return 0
    page=$((page + 1))
  done
}
