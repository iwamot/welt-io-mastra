import { describe, expect, test } from "bun:test";
import { decodeInterruptResponses } from "../src/index.ts";

describe("decodeInterruptResponses", () => {
  test("returns no responses for a non-object payload", () => {
    expect(decodeInterruptResponses(undefined)).toEqual([]);
    expect(decodeInterruptResponses(null)).toEqual([]);
    expect(decodeInterruptResponses("y")).toEqual([]);
    expect(decodeInterruptResponses([["a", "y"]])).toEqual([]);
  });

  test("decodes answers in payload order", () => {
    const responses = {
      "tool-call-1": "y",
      "tool-call-2": "do it differently",
    };
    expect(decodeInterruptResponses(responses)).toEqual([
      { toolCallId: "tool-call-1", answer: "y" },
      { toolCallId: "tool-call-2", answer: "do it differently" },
    ]);
  });

  test("skips non-string answers", () => {
    const responses = { a: 1, b: "ok", c: null };
    expect(decodeInterruptResponses(responses)).toEqual([
      { toolCallId: "b", answer: "ok" },
    ]);
  });
});
