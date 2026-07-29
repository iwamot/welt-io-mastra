import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { InterruptInput, InterruptOption } from "../src/index.ts";
import { interruptReason, WireContractError } from "../src/index.ts";

/** Assert that a reason is refused, and that the error names `path`. */
function rejects(build: () => unknown, path: string) {
  assert.throws(build, (error: unknown) => {
    assert.ok(error instanceof WireContractError);
    assert.equal(error.path, path);
    return true;
  });
}

describe("interruptReason", () => {
  test("builds a message with options", () => {
    assert.deepEqual(interruptReason("Deploy?", [{ value: "y" }]), {
      message: "Deploy?",
      options: [{ value: "y" }],
    });
  });

  test("builds a message with an input field", () => {
    assert.deepEqual(interruptReason("Name?", undefined, {}), {
      message: "Name?",
      input: {},
    });
  });

  test("builds a message with both widgets", () => {
    assert.deepEqual(
      interruptReason(
        "Deploy?",
        [
          { value: "y", label: "Deploy", style: "primary" },
          { value: "n", label: "Cancel" },
        ],
        { label: "Or type your answer", multiline: true },
      ),
      {
        message: "Deploy?",
        options: [
          { value: "y", label: "Deploy", style: "primary" },
          { value: "n", label: "Cancel" },
        ],
        input: { label: "Or type your answer", multiline: true },
      },
    );
  });

  test("copies the options it was handed", () => {
    const options: InterruptOption[] = [{ value: "y" }];
    const reason = interruptReason("m", options);
    assert.notEqual(reason.options, options);
    assert.deepEqual(reason.options, options);
  });

  for (const style of ["primary", "danger"] as const) {
    test(`accepts the ${style} style`, () => {
      assert.deepEqual(interruptReason("m", [{ value: "v", style }]), {
        message: "m",
        options: [{ value: "v", style }],
      });
    });
  }

  for (const multiline of [true, false]) {
    test(`accepts multiline ${multiline}`, () => {
      assert.deepEqual(interruptReason("m", undefined, { multiline }), {
        message: "m",
        input: { multiline },
      });
    });
  }

  test("accepts the 25 options one Slack actions block holds", () => {
    const options = Array.from({ length: 25 }, (_, i) => ({ value: `v${i}` }));
    assert.deepEqual(interruptReason("m", options).options, options);
  });

  test("refuses an empty message", () => {
    rejects(() => interruptReason("", [{ value: "y" }]), "$.message");
  });

  test("refuses a reason with neither widget", () => {
    rejects(() => interruptReason("m"), "$");
  });

  test("refuses empty options", () => {
    rejects(() => interruptReason("m", []), "$.options");
  });

  test("refuses more options than Welt renders", () => {
    const options = Array.from({ length: 26 }, (_, i) => ({ value: `v${i}` }));
    rejects(() => interruptReason("m", options), "$.options");
  });

  const badOptions: [unknown, string][] = [
    [{}, "$.options[0]"],
    [{ value: "" }, "$.options[0].value"],
    [{ value: 5 }, "$.options[0].value"],
    [{ value: "y".repeat(1801) }, "$.options[0].value"],
    [{ value: "y", label: "" }, "$.options[0].label"],
    [{ value: "y", label: 5 }, "$.options[0].label"],
    [{ value: "y", style: "default" }, "$.options[0].style"],
    [{ value: "y", text: "Yes" }, "$.options[0]"],
  ];
  for (const [option, path] of badOptions) {
    test(`refuses the option ${JSON.stringify(option)}`, () => {
      const options = [option] as InterruptOption[];
      rejects(() => interruptReason("m", options), path);
    });
  }

  const badInputs: [unknown, string][] = [
    [{ label: "" }, "$.input.label"],
    [{ label: 5 }, "$.input.label"],
    [{ multiline: "yes" }, "$.input.multiline"],
    [{ placeholder: "x" }, "$.input"],
  ];
  for (const [input, path] of badInputs) {
    test(`refuses the input ${JSON.stringify(input)}`, () => {
      rejects(
        () => interruptReason("m", undefined, input as InterruptInput),
        path,
      );
    });
  }
});
