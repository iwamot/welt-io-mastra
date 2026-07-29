import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeInterruptResponses, WireContractError } from "../src/index.ts";

/** Assert that a payload is refused, and that the error names `path`. */
function rejects(responses: unknown, path: string) {
  assert.throws(
    () => decodeInterruptResponses(responses),
    (error: unknown) => {
      assert.ok(error instanceof WireContractError);
      assert.equal(error.path, path);
      return true;
    },
  );
}

describe("decodeInterruptResponses", () => {
  test("decodes answers in payload order", () => {
    const responses = {
      "tool-call-1": "y",
      "tool-call-2": "do it differently",
    };
    assert.deepEqual(decodeInterruptResponses(responses), [
      { toolCallId: "tool-call-1", answer: "y" },
      { toolCallId: "tool-call-2", answer: "do it differently" },
    ]);
  });

  test("refuses a payload that is not a mapping of answers", () => {
    rejects(undefined, "$");
    rejects("y", "$");
    rejects([["a", "y"]], "$");
  });

  test("refuses a payload that answers nothing", () => {
    rejects({}, "$");
  });

  test("refuses an answer that is not a string", () => {
    rejects({ a: 1 }, "$.a");
    rejects({ a: "ok", b: null }, "$.b");
  });
});
