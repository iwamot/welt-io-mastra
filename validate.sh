#!/bin/bash
set -e

# mise
eval "$(mise activate bash)"
mise fmt
mise install

# TypeScript
aube install --frozen-lockfile
aube licenses
aube audit --fix update --ignore-unfixable
aube run check:write
aube run build
aube run typecheck
# Workspace packages (the example agent) typecheck against the built dist.
aube -r run typecheck
aube run test
# --no-git-checks lets the dry-run run on any branch (publish itself would still gate on main).
aube publish --dry-run --no-git-checks

# Run shared lint tasks
mise run gha-lint
mise run shell-lint

# Check for uncommitted changes
git diff --exit-code
