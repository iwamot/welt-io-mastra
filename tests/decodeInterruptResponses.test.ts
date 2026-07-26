import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeInterruptResponses } from "../src/index.ts";

describe("decodeInterruptResponses", () => {
  test("returns no responses for a non-object payload", () => {
    assert.deepEqual(decodeInterruptResponses(undefined), []);
    assert.deepEqual(decodeInterruptResponses(null), []);
    assert.deepEqual(decodeInterruptResponses("y"), []);
    assert.deepEqual(decodeInterruptResponses([["a", "y"]]), []);
  });

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

  test("skips non-string answers", () => {
    const responses = { a: 1, b: "ok", c: null };
    assert.deepEqual(decodeInterruptResponses(responses), [
      { toolCallId: "b", answer: "ok" },
    ]);
  });
});
