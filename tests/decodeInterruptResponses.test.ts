import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { InterruptAnswer } from "../src/index.ts";
import { decodeInterruptResponses } from "../src/index.ts";

describe("decodeInterruptResponses", () => {
  test("decodes answers in payload order", () => {
    const responses: Record<string, InterruptAnswer> = {
      "tool-call-1": { value: "Approve", source: "option" },
      "tool-call-2": { value: "do it differently", source: "input" },
    };
    assert.deepEqual(decodeInterruptResponses(responses), [
      { toolCallId: "tool-call-1", answer: "Approve" },
      { toolCallId: "tool-call-2", answer: "do it differently" },
    ]);
  });

  test("carries an answer on as the value it was given", () => {
    const responses: Record<string, InterruptAnswer> = {
      "tool-call-1": { value: false, source: "option" },
      "tool-call-2": { value: null, source: "option" },
      "tool-call-3": { value: { decision: "hold" }, source: "option" },
    };

    assert.deepEqual(
      decodeInterruptResponses(responses).map((entry) => entry.answer),
      [false, null, { decision: "hold" }],
    );
  });

  test("decodes no answers into no resume inputs", () => {
    assert.deepEqual(decodeInterruptResponses({}), []);
  });
});
