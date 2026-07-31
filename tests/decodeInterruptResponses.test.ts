import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeInterruptResponses } from "../src/index.ts";

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

  test("decodes no answers into no resume inputs", () => {
    assert.deepEqual(decodeInterruptResponses({}), []);
  });
});
