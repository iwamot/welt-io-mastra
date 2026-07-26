import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { InterruptInput, InterruptOption } from "../src/index.ts";
import { interruptReason } from "../src/index.ts";

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
        { label: "Or tell me what to do instead", multiline: true },
      ),
      {
        message: "Deploy?",
        options: [
          { value: "y", label: "Deploy", style: "primary" },
          { value: "n", label: "Cancel" },
        ],
        input: { label: "Or tell me what to do instead", multiline: true },
      },
    );
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

  test("throws on an empty message", () => {
    assert.throws(() => interruptReason("", [{ value: "y" }]), TypeError);
  });

  test("throws when neither options nor input is given", () => {
    assert.throws(() => interruptReason("m"), TypeError);
  });

  test("throws on empty options", () => {
    assert.throws(() => interruptReason("m", []), TypeError);
  });

  test("throws on an unknown option key", () => {
    const options = [
      { value: "y", text: "Yes" },
    ] as unknown as InterruptOption[];
    assert.throws(() => interruptReason("m", options), TypeError);
  });

  const badOptions: unknown[] = [
    {},
    { value: "" },
    { value: 5 },
    { value: "y", label: "" },
    { value: "y", label: 5 },
    { value: "y", style: "default" },
    { value: "y", style: 5 },
  ];
  for (const option of badOptions) {
    test(`throws on an invalid option: ${JSON.stringify(option)}`, () => {
      const options = [option] as unknown as InterruptOption[];
      assert.throws(() => interruptReason("m", options), TypeError);
    });
  }

  test("throws on an unknown input key", () => {
    const input = { placeholder: "x" } as unknown as InterruptInput;
    assert.throws(() => interruptReason("m", undefined, input), TypeError);
  });

  for (const input of [{ label: "" }, { label: 5 }]) {
    test(`throws on an invalid input label: ${JSON.stringify(input)}`, () => {
      assert.throws(
        () => interruptReason("m", undefined, input as InterruptInput),
        TypeError,
      );
    });
  }

  test("throws on a non-boolean multiline", () => {
    const input = { multiline: "yes" } as unknown as InterruptInput;
    assert.throws(() => interruptReason("m", undefined, input), TypeError);
  });
});
