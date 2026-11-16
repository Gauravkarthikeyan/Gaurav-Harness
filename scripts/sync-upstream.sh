#!/usr/bin/env bash
# Merge upstream oh-my-pi (main) into the current branch, then list the GK hook points (`// gk:`)
# to recheck. Exits non-zero when the merge conflicts or the working tree is dirty.
set -euo pipefail

UPSTREAM_URL="https://github.com/can1357/oh-my-pi"

cd "$(git rev-parse --show-toplevel)"

if ! git remote get-url upstream >/dev/null 2>&1; then
	echo "Adding remote upstream → $UPSTREAM_URL"
	git remote add upstream "$UPSTREAM_URL"
fi

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
	echo "Uncommitted changes in the working tree; commit or stash them before syncing." >&2
	exit 2
fi

git fetch upstream

before="$(git rev-parse HEAD)"
merge_status=0
git merge --no-edit upstream/main || merge_status=$?

echo
echo "GK hook points (// gk:):"
git grep -n "// gk:" -- ':!docs' || true

hook_files="$(git grep -l "// gk:" -- ':!docs' || true)"
if [ "$merge_status" -ne 0 ]; then
	changed="$(git diff --name-only --diff-filter=U)"
else
	changed="$(git diff --name-only "$before" HEAD)"
fi
touched="$(comm -12 <(printf '%s\n' "$hook_files" | sort) <(printf '%s\n' "$changed" | sort) | sed '/^$/d')"
if [ -n "$touched" ]; then
	echo
	echo "Hook files upstream changed (recheck these first):"
	printf '  %s\n' $touched
fi

if [ "$merge_status" -ne 0 ]; then
	echo
	echo "Merge conflicts in:" >&2
	git diff --name-only --diff-filter=U | sed 's/^/  /' >&2
	echo "Resolve them, keep every // gk: hook, then commit. Or abort with: git merge --abort" >&2
	exit 1
fi

echo
echo "Merged upstream/main cleanly. Run the checks before pushing: bun run check, then the gk tests."
