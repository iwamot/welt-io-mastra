#!/bin/bash
set -euo pipefail

# mise
eval "$(mise activate bash)"
mise install

aube install --frozen-lockfile
aube run build

# The whole suite, on this Node version — the tests run on the runtime the
# package is used from, so a version's own behavior is what they check. The
# coverage thresholds live in validate.sh; what matters here is that it passes.
run_tests() {
  node --test 'tests/*.test.ts'
}

run_tests

# Pack the package and install it in an isolated directory to exercise the
# publish path (validates "files" globs, the exports map, deps resolution).
TARBALL="$PWD/$(npm pack --silent)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; rm -f "$TARBALL"' EXIT

(cd "$TMP" && npm init --silent --yes >/dev/null &&
  npm install --silent --no-audit --no-fund "$TARBALL")

# Exercise the installed package end to end on this Node version.
(cd "$TMP" && node --input-type=module -e '
import assert from "node:assert/strict";
import { decodeMessages, interruptReason, renderableEvents } from "@welt-io/mastra";

assert.deepEqual(decodeMessages([{ role: "user", content: [{ text: "hi" }] }]), [
  { role: "user", content: [{ type: "text", text: "hi" }] },
]);
assert.deepEqual(interruptReason({ message: "Deploy?", approve: {}, reject: {} }), {
  message: "Deploy?",
  approve: {},
  reject: {},
});
const events = [];
for await (const event of renderableEvents(
  (async function* () {
    yield { type: "text-delta", payload: { text: "hello" } };
  })(),
)) {
  events.push(event);
}
assert.deepEqual(events, [{ data: "hello" }]);
')

# The suite again with every declared peer dependency at the floor of its
# range, so the `>=` in package.json stays a tested claim. The floors are read
# from the manifest rather than repeated here.
mapfile -t floors < <(node -e '
const { peerDependencies = {} } = require("./package.json");
for (const [name, range] of Object.entries(peerDependencies)) {
  if (range.startsWith(">=")) console.log(name + "@" + range.slice(2));
}
')
# --no-save snapshots package.json and the lockfile, links the requested
# versions, and restores both files, so the working tree stays clean. It cannot
# do that if it is killed mid-install, though, and this script is meant to be
# run locally, where Ctrl-C happens — an interrupted run would otherwise leave a
# manifest that the next --frozen-lockfile install refuses. So keep a copy of
# the files as they are (not as git has them, so uncommitted edits survive) and
# put them back on the way out. -W says the swap belongs to the workspace root.
SNAP=$(mktemp -d)
cp package.json pnpm-lock.yaml "$SNAP/"
trap 'cp "$SNAP"/package.json "$SNAP"/pnpm-lock.yaml .; rm -rf "$TMP" "$SNAP"; rm -f "$TARBALL"' EXIT
aube add -D -W --no-save "${floors[@]}"

# --no-install because `aube run` otherwise reinstalls first, which would put
# the pinned version back and leave the floor untested.
aube run --no-install typecheck

# What is actually linked, checked after the first step that could have undone
# the swap: a range read wrong, an install that resolves higher, or a command
# that reinstalls would each leave the floor untested while the run stays green.
for floor in "${floors[@]}"; do
  name="${floor%@*}"
  want="${floor##*@}"
  got="$(node -p "require('./node_modules/$name/package.json').version")"
  if [[ "$got" != "$want" ]]; then
    echo "compatibility.sh: expected $name@$want, found $got" >&2
    exit 1
  fi
  echo "compatibility.sh: testing against $name@$got"
done

run_tests

# Put the pinned versions back, so a local run leaves node_modules as it found
# it. A failed run never reaches this line, and node_modules keeps the floor —
# which is what you want while investigating, so reach for `aube run
# --no-install <script>`. Anything else auto-installs and takes the failure with
# it. `aube install --frozen-lockfile` when done.
aube install --frozen-lockfile
