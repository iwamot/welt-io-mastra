import assert from "node:assert/strict";
import { test } from "node:test";
import type { InterruptAnswer } from "../src/index.ts";
import { decodeInterruptResponses } from "../src/index.ts";
import { sequences } from "./sequences.ts";

test("preserves every answer's id, JSON value, and payload order", () => {
  const values: InterruptAnswer["value"][] = [
    true,
    false,
    null,
    0,
    42,
    "",
    "do it differently",
    ["a"],
    { decision: "hold" },
  ];
  for (const chosen of sequences(values, 3)) {
    for (const source of ["option", "input"] as const) {
      const responses: Record<string, InterruptAnswer> = Object.fromEntries(
        chosen.map((value, i) => [
          "interrupt-" + (chosen.length - i),
          { value, source: typeof value === "string" ? source : "option" },
        ]),
      );
      const before = structuredClone(responses);
      assert.deepEqual(
        decodeInterruptResponses(responses),
        chosen.map((value, i) => ({
          toolCallId: "interrupt-" + (chosen.length - i),
          answer: value,
        })),
      );
      assert.deepEqual(responses, before);
    }
  }
});
