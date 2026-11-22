import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  DecisionSpec,
  InputSpec,
  JsonValue,
  OptionSpec,
  ReasonSpec,
} from "../src/index.ts";
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

test("preserves all requested widget combinations and their JSON values", () => {
  const decisions: (DecisionSpec | undefined)[] = [
    undefined,
    {},
    { label: "Deploy" },
    { label: "Cancel", style: "primary" },
    { style: "danger" },
  ];
  const inputs: (InputSpec | undefined)[] = [
    undefined,
    {},
    { label: "City" },
    { label: "Draft", multiline: true },
    { multiline: false },
  ];
  const values: JsonValue[] = [true, false, null, 0, 42, "", ["a"], { d: "h" }];
  const choices: (OptionSpec[] | undefined)[] = [
    undefined,
    values.map((value) => ({ value, label: "Pick" })),
    [{ value: "y" }, { value: "n", label: "Cancel" }],
    [
      { value: "y", label: "Deploy", style: "primary" },
      { value: "n", style: "danger" },
    ],
  ];
  for (const message of ["Deploy?", "日本語\n質問"])
    for (const approve of decisions)
      for (const reject of decisions)
        for (const input of inputs)
          for (const options of choices) {
            const spec: ReasonSpec = {
              message,
              ...(approve === undefined ? {} : { approve }),
              ...(reject === undefined ? {} : { reject }),
              ...(input === undefined ? {} : { input }),
              ...(options === undefined ? {} : { options }),
            };
            const before = structuredClone(spec);
            const reason = interruptReason(spec);
            assert.deepEqual(reason, spec);
            if (options !== undefined) assert.notEqual(reason.options, options);
            assert.deepEqual(spec, before);
          }
});

describe("interruptReason", () => {
  // Welt's own rendering caps — how many buttons one Slack actions block
  // holds, how long a value or a message may be — are Welt's to enforce.
  // A copy of them here would be four copies of a number only Welt knows.
  test("leaves Welt's own rendering caps to Welt", () => {
    const options = Array.from({ length: 26 }, (_, i) => ({ value: `v${i}` }));
    assert.equal(
      interruptReason({ message: "m", options }).options?.length,
      26,
    );
    assert.ok(
      interruptReason({ message: "m", options: [{ value: "v".repeat(1801) }] }),
    );
    assert.ok(
      interruptReason({
        message: "m".repeat(12_001),
        options: [{ value: "y" }],
      }),
    );
  });

  test("refuses an empty message", () => {
    rejectsValue(
      () => interruptReason({ message: "", options: [{ value: "y" }] }),
      /message must not be empty/,
    );
  });

  test("refuses empty options", () => {
    rejectsValue(
      () => interruptReason({ message: "m", options: [] }),
      /options must not be empty/,
    );
  });

  test("refuses an option without a value", () => {
    rejectsValue(
      () => interruptReason({ message: "m", options: [{} as OptionSpec] }),
      /an option needs a value/,
    );
  });

  test("refuses an empty label", () => {
    rejectsValue(
      () =>
        interruptReason({ message: "m", options: [{ value: "y", label: "" }] }),
      /an option's label must not be empty/,
    );
    rejectsValue(
      () => interruptReason({ message: "m", input: { label: "" } }),
      /input's label must not be empty/,
    );
  });

  for (const style of ["warning", null]) {
    test(`refuses the style ${JSON.stringify(style)}, which Welt does not render`, () => {
      const option = { value: "y", style } as unknown as OptionSpec;
      rejectsValue(
        () => interruptReason({ message: "m", options: [option] }),
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

  test("refuses a reason that is not an object", () => {
    rejectsType(
      () => interruptReason("Deploy?" as unknown as ReasonSpec),
      /the reason must be an object, not a string/,
    );
  });

  test("refuses a reason key the wire contract does not name", () => {
    const spec = { message: "m", buttons: [] } as unknown as ReasonSpec;
    rejectsValue(
      () => interruptReason(spec),
      /the reason carries unknown key\(s\): buttons/,
    );
  });

  test("refuses a key the wire contract does not name", () => {
    const option = { value: "y", labl: "Yes" } as unknown as OptionSpec;
    rejectsValue(
      () => interruptReason({ message: "m", options: [option] }),
      /an option carries unknown key\(s\): labl \(known: value, label, style\)/,
    );
    const input = { placeholder: "Type here" } as unknown as InputSpec;
    rejectsValue(
      () => interruptReason({ message: "m", input }),
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
        () =>
          interruptReason({
            message: message as string,
            options: [{ value: "y" }],
          }),
        new RegExp(`message must be a string, not ${named}`),
      );
    });
  }

  const badOptionLists: unknown[] = [{ value: "y" }, "y", 42, null];
  for (const options of badOptionLists) {
    test(`refuses options that are ${JSON.stringify(options)}`, () => {
      rejectsType(
        () =>
          interruptReason({ message: "m", options: options as OptionSpec[] }),
        /options must be an array/,
      );
    });
  }

  const badOptions: unknown[] = ["y", null, [["value", "y"]]];
  for (const option of badOptions) {
    test(`refuses the option ${JSON.stringify(option)}`, () => {
      rejectsType(
        () =>
          interruptReason({ message: "m", options: [option] as OptionSpec[] }),
        /an option must be an object/,
      );
    });
  }

  const badOptionValues: [unknown, RegExp][] = [
    [{ value: () => "y" }, /an option's value must be JSON, not a function/],
    [{ value: [1, undefined] }, /an option's value must be JSON, not an array/],
    [{ value: "y", label: 42 }, /an option's label must be a string/],
    [
      { value: "y", label: null },
      /an option's label must be a string, not null/,
    ],
  ];
  for (const [option, reason] of badOptionValues) {
    test(`refuses the option ${JSON.stringify(option)}`, () => {
      rejectsType(
        () =>
          interruptReason({ message: "m", options: [option] as OptionSpec[] }),
        reason,
      );
    });
  }

  const badInputs: unknown[] = ["City", null, 42];
  for (const input of badInputs) {
    test(`refuses the input ${JSON.stringify(input)}`, () => {
      rejectsType(
        () => interruptReason({ message: "m", input: input as InputSpec }),
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
        () => interruptReason({ message: "m", input: input as InputSpec }),
        reason,
      );
    });
  }
});

describe("interruptReason decisions", () => {
  test("refuses an empty label", () => {
    rejectsValue(
      () => interruptReason({ message: "m", approve: { label: "" } }),
      /approve's label must not be empty/,
    );
  });

  test("refuses a style Welt does not render", () => {
    const reject = { style: "warning" } as unknown as DecisionSpec;
    rejectsValue(
      () => interruptReason({ message: "m", reject }),
      /reject's style must be "primary" or "danger"/,
    );
  });

  test("refuses a key the wire contract does not name", () => {
    const approve = { value: true } as unknown as DecisionSpec;
    rejectsValue(
      () => interruptReason({ message: "m", approve }),
      /approve carries unknown key\(s\): value \(known: label, style\)/,
    );
  });

  test("refuses a decision that is not an object", () => {
    const approve = "yes" as unknown as DecisionSpec;
    rejectsType(
      () => interruptReason({ message: "m", approve }),
      /approve must be an object, not a string/,
    );
  });
});
