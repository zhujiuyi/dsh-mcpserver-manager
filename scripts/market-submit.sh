#!/usr/bin/env bash
#
# Submit the plugin to awesome-dsh-plugin once the repository is old enough.
#
# The market requires the repo to be at least one day old. Rather than leaving
# that to memory, this script re-checks the age from the API, then pushes the
# prepared entry branch to the fork and opens the PR. It is safe to run more
# than once: it refuses to open a second PR for the same branch.
#
# Usage:  bash scripts/market-submit.sh
#         bash scripts/market-submit.sh --dry-run    # check only, change nothing
set -uo pipefail

# ── configuration ──────────────────────────────────────────────────────────
OWNER="zhujiuyi"
REPO="dsh-mcpserver-manager"
MARKET="awesome-dsh-plugin/awesome-dsh-plugin"
BRANCH="add-mcpserver-manager"
ENTRY="data/plugins/${OWNER}__${REPO}.yml"
MARKET_DIR="${MARKET_DIR:-$LOCALAPPDATA/Temp/awesome-dsh}"
MIN_AGE_SECONDS=$((24 * 60 * 60))
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

say()  { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# ── 1. is the repo old enough? ─────────────────────────────────────────────
say "Checking the age of ${OWNER}/${REPO}…"
created=$(gh api "repos/${OWNER}/${REPO}" --jq .created_at) \
  || fail "cannot read the repository; is gh authenticated?"

# Convert the ISO timestamp with node so this works without GNU date.
age=$(node -e '
const created = new Date(process.argv[1]).getTime()
console.log(Math.floor((Date.now() - created) / 1000))
' "$created")

say "  created: $created"
say "  age:     $((age / 3600))h $(((age % 3600) / 60))m"

if [ "$age" -lt "$MIN_AGE_SECONDS" ]; then
  remaining=$((MIN_AGE_SECONDS - age))
  say "  too young by $((remaining / 3600))h $(((remaining % 3600) / 60))m — not submitting yet."
  exit 0
fi

# ── 2. is the entry prepared? ──────────────────────────────────────────────
[ -d "$MARKET_DIR" ] || fail "market checkout not found at $MARKET_DIR"
cd "$MARKET_DIR" || fail "cannot enter $MARKET_DIR"

git fetch origin main --quiet || fail "cannot fetch upstream"
if ! git show "origin/main:${ENTRY}" >/dev/null 2>&1; then
  # Our entry is local-only until it is pushed.
  if [ ! -f "$ENTRY" ]; then
    fail "entry file ${ENTRY} is missing; nothing to submit"
  fi
  say "  entry: ${ENTRY} (not yet upstream)"
else
  say "  entry already upstream — the plugin is listed; nothing to do."
  exit 0
fi

# ── 3. is there already an open PR for this branch? ────────────────────────
existing=$(gh pr list --repo "$MARKET" --head "${OWNER}:${BRANCH}" --state open --json number --jq '.[].number' 2>/dev/null)
if [ -n "${existing:-}" ]; then
  say "  an open PR already exists: #${existing}"
  exit 0
fi

# ── 4. build the branch on a fresh upstream base ───────────────────────────
# A stale base is the usual reason a market PR fails CI, so the branch is
# rebuilt from origin/main every time and the single entry file re-applied.
say "Rebuilding ${BRANCH} on origin/main…"
if [ "$DRY_RUN" = "1" ]; then
  say "  [dry-run] would rebase onto origin/main, keep ${ENTRY}, push and open the PR."
  exit 0
fi

git checkout -q -B "$BRANCH" origin/main || fail "cannot create the branch"
# The entry file survived the branch switch only if it was staged or tracked;
# restore it from the previous head when necessary.
if [ ! -f "$ENTRY" ]; then
  git show "ORIG_HEAD:${ENTRY}" > "$ENTRY" 2>/dev/null \
    || fail "entry file ${ENTRY} was lost; restore it before running this script"
fi

git add "$ENTRY" || fail "cannot stage the entry"
if git diff --cached --quiet; then
  say "  nothing to commit — is the entry already on origin/main?"
  exit 0
fi
git commit -q -m "Add ${OWNER}/${REPO} (tools)" || fail "cannot commit"

# ── 5. push to the fork and open the PR ────────────────────────────────────
say "Pushing to the fork…"
git push -q fork "$BRANCH" --force-with-lease || fail "cannot push to the fork"

body_file=$(mktemp)
trap 'rm -f "$body_file"' EXIT
cat > "$body_file" <<'BODY'
Adds an MCP server manager for the DeepSeek Harness.

- Lists every MCP server configured in the profile with its connection state and
  the tools it registers, grouped by the `mcp__<server>__` namespace.
- Preflights a configuration before saving it: a missing executable, an npm
  package name used where a command belongs, an unexpanded `${VAR}` that would
  reach the child literally, a working directory that is a file, a URL with no
  path segment. Errors block the write and can be overridden; warnings do not.
  The check is purely static — it spawns nothing and never evaluates pasted text.
- Adds servers from a dsh patch fragment or a Claude Code `mcpServers` block,
  normalized to the dsh row shape; edits, disables or removes one server at a
  time without touching the rest.

Writes go to the profile's `cordis.patch.yml`. An existing row is replaced in
place; `!!js` expressions and comments elsewhere in the file survive byte for
byte, verified by a round-trip test. Published to npm as
`@zhujiuyi/dsh-mcpserver-manager`; the package declares `dsh.bundle` and
`dsh.client`, and its `repository` points back at this repo.
BODY

say "Opening the PR…"
gh pr create --repo "$MARKET" --base main --head "${OWNER}:${BRANCH}" \
  --title "Add ${OWNER}/${REPO} (tools)" \
  --body-file "$body_file" || fail "cannot open the PR"

say "Done."
