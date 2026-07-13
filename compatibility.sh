#!/bin/bash
set -euo pipefail

# mise
eval "$(mise activate bash)"
mise install

aube install --frozen-lockfile
aube run build

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
import { decodeMessages, fileEvent, renderableEvents } from "@welt-io/mastra";

assert.deepEqual(decodeMessages([{ role: "user", content: [{ text: "hi" }] }]), [
  { role: "user", content: [{ type: "text", text: "hi" }] },
]);
assert.deepEqual(fileEvent("hi.txt", new TextEncoder().encode("hi")), {
  file: { name: "hi.txt", bytes: "aGk=" },
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
