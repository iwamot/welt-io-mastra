import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { InputSpec, OptionSpec } from "../src/index.ts";
import { interruptReason } from "../src/index.ts";

/** Assert that a value of the wrong type is refused, and why. */
function rejectsType(build: () => unknown, reason: RegExp) {
  assert.throws(build, (error: unknown) => {
    assert.ok(error instanceof TypeError);
    assert.match(error.message, reason);
    return true;
  });
}

/** Assert that a value Welt would not render is refused, and why. */
function rejectsValue(build: () => unknown, reason: RegExp) {
  assert.throws(build, (error: unknown) => {
    assert.ok(error instanceof Error);
    // A structural problem is not a type problem; the two are told apart
    // the way the standard library tells them apart.
    assert.ok(!(error instanceof TypeError));
    assert.match(error.message, reason);
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
    const options: OptionSpec[] = [{ value: "y" }];
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

  // Welt's own rendering caps — how many buttons one Slack actions block
  // holds, how long a value or a message may be — are Welt's to enforce.
  // A copy of them here would be four copies of a number only Welt knows.
  test("leaves Welt's own rendering caps to Welt", () => {
    const options = Array.from({ length: 26 }, (_, i) => ({ value: `v${i}` }));
    assert.equal(interruptReason("m", options).options?.length, 26);
    assert.ok(interruptReason("m", [{ value: "v".repeat(1801) }]));
    assert.ok(interruptReason("m".repeat(12_001), [{ value: "y" }]));
  });

  test("refuses an empty message", () => {
    rejectsValue(
      () => interruptReason("", [{ value: "y" }]),
      /message must not be empty/,
    );
  });

  test("refuses a reason with neither widget", () => {
    rejectsValue(() => interruptReason("m"), /needs options, input, or both/);
  });

  test("refuses empty options", () => {
    rejectsValue(() => interruptReason("m", []), /options must not be empty/);
  });

  test("refuses an option without a value", () => {
    rejectsValue(
      () => interruptReason("m", [{} as OptionSpec]),
      /an option needs a value/,
    );
  });

  test("refuses an empty option value", () => {
    rejectsValue(
      () => interruptReason("m", [{ value: "" }]),
      /an option's value must not be empty/,
    );
  });

  test("refuses an empty label", () => {
    rejectsValue(
      () => interruptReason("m", [{ value: "y", label: "" }]),
      /an option's label must not be empty/,
    );
    rejectsValue(
      () => interruptReason("m", undefined, { label: "" }),
      /input's label must not be empty/,
    );
  });

  for (const style of ["warning", null]) {
    test(`refuses the style ${JSON.stringify(style)}, which Welt does not render`, () => {
      const option = { value: "y", style } as unknown as OptionSpec;
      rejectsValue(
        () => interruptReason("m", [option]),
        /must be "primary" or "danger"/,
      );
    });
  }

  // --- what the type checker cannot reach ------------------------------
  //
  // TypeScript's excess-property check fires on an object literal written
  // at the call site, and not on one that reached it through a variable —
  // which is how a misspelled key gets this far. These cases go through
  // `unknown`, since a wrong value written against the typed signature
  // would not survive `tsc` either.

  test("refuses a key the wire contract does not name", () => {
    const option = { value: "y", labl: "Yes" } as unknown as OptionSpec;
    rejectsValue(
      () => interruptReason("m", [option]),
      /an option carries unknown key\(s\): labl \(known: value, label, style\)/,
    );
    const input = { placeholder: "Type here" } as unknown as InputSpec;
    rejectsValue(
      () => interruptReason("m", undefined, input),
      /input carries unknown key\(s\): placeholder \(known: label, multiline\)/,
    );
  });

  const badMessages: [unknown, string][] = [
    [42, "a number"],
    [null, "null"],
    [undefined, "undefined"],
    [["Deploy?"], "an array"],
    [{ text: "Deploy?" }, "an object"],
  ];
  for (const [message, named] of badMessages) {
    test(`refuses a message that is ${named}`, () => {
      rejectsType(
        () => interruptReason(message as string, [{ value: "y" }]),
        new RegExp(`message must be a string, not ${named}`),
      );
    });
  }

  const badOptionLists: unknown[] = [{ value: "y" }, "y", 42, null];
  for (const options of badOptionLists) {
    test(`refuses options that are ${JSON.stringify(options)}`, () => {
      rejectsType(
        () => interruptReason("m", options as OptionSpec[]),
        /options must be an array/,
      );
    });
  }

  const badOptions: unknown[] = ["y", null, [["value", "y"]]];
  for (const option of badOptions) {
    test(`refuses the option ${JSON.stringify(option)}`, () => {
      rejectsType(
        () => interruptReason("m", [option] as OptionSpec[]),
        /an option must be an object/,
      );
    });
  }

  const badOptionValues: [unknown, RegExp][] = [
    [{ value: 42 }, /an option's value must be a string, not a number/],
    [{ value: "y", label: 42 }, /an option's label must be a string/],
    [
      { value: "y", label: null },
      /an option's label must be a string, not null/,
    ],
  ];
  for (const [option, reason] of badOptionValues) {
    test(`refuses the option ${JSON.stringify(option)}`, () => {
      rejectsType(() => interruptReason("m", [option] as OptionSpec[]), reason);
    });
  }

  const badInputs: unknown[] = ["City", null, 42];
  for (const input of badInputs) {
    test(`refuses the input ${JSON.stringify(input)}`, () => {
      rejectsType(
        () => interruptReason("m", undefined, input as InputSpec),
        /input must be an object/,
      );
    });
  }

  const badInputValues: [unknown, RegExp][] = [
    [{ label: 42 }, /input's label must be a string/],
    [{ label: null }, /input's label must be a string, not null/],
    [{ multiline: "yes" }, /input's multiline must be a boolean, not a string/],
    [{ multiline: null }, /input's multiline must be a boolean, not null/],
  ];
  for (const [input, reason] of badInputValues) {
    test(`refuses the input ${JSON.stringify(input)}`, () => {
      rejectsType(
        () => interruptReason("m", undefined, input as InputSpec),
        reason,
      );
    });
  }
});
