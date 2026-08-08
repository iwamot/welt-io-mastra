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
# README's Supported Versions table restates what package.json declares. Read
# both and compare, so an edit to one cannot leave the other behind.
node --input-type=module - <<'JS'
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const readme = read("README.md");
const { peerDependencies = {} } = JSON.parse(read("package.json"));
for (const [name, range] of Object.entries(peerDependencies)) {
  const row = `| \`${name}\` | \`${range}\` |`;
  if (!readme.includes(row)) {
    throw new Error(`validate.sh: README.md has no row ${row}`);
  }
  console.log(`validate.sh: README.md states ${name} ${range}`);
}
JS

# --no-git-checks lets the dry-run run on any branch (publish itself would still gate on main).
aube publish --dry-run --no-git-checks

# Run shared lint tasks
mise run gha-lint
mise run shell-lint

# Check for uncommitted changes
git diff --exit-code
