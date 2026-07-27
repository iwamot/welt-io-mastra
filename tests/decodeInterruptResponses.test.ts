import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeInterruptResponses } from "../src/index.ts";

const rejects = (responses: unknown) =>
  assert.throws(() => decodeInterruptResponses(responses), TypeError);

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

  test("decodes an empty payload to no responses", () => {
    assert.deepEqual(decodeInterruptResponses({}), []);
  });

  test("rejects a payload that is not an object", () => {
    rejects(undefined);
    rejects(null);
    rejects("y");
    rejects([["a", "y"]]);
  });

  test("rejects an answer that is not a string", () => {
    rejects({ a: 1 });
    rejects({ a: null });
    rejects({ a: "ok", b: 1 });
  });
});
