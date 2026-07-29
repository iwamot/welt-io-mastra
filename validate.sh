#!/bin/bash
set -e

# mise
eval "$(mise activate bash)"
mise fmt
mise install

# TypeScript
aube install --frozen-lockfile
aube licenses
# 1119676 is @ai-sdk/provider-utils (GHSA-866g-f22w-33x8, low), reached through
# the @mastra/core devDependency: Mastra pins several AI SDK majors side by side,
# so none of its slots can take the patched version. The registry reports this
# advisory under its numeric id only. Drop the ignore once Mastra's pins move on.
aube audit --fix update --ignore-unfixable --ignore 1119676
# Checks the vendored wire schemas and compiles them into the package.
node scripts/generate-schema.ts
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
