import { describe, expect, test } from "bun:test";
import type { InterruptInput, InterruptOption } from "../src/index.ts";
import { interruptReason } from "../src/index.ts";

describe("interruptReason", () => {
  test("builds a message with options", () => {
    expect(interruptReason("Deploy?", [{ value: "y" }])).toEqual({
      message: "Deploy?",
      options: [{ value: "y" }],
    });
  });

  test("builds a message with an input field", () => {
    expect(interruptReason("Name?", undefined, {})).toEqual({
      message: "Name?",
      input: {},
    });
  });

  test("builds a message with both widgets", () => {
    expect(
      interruptReason(
        "Deploy?",
        [
          { value: "y", label: "Deploy", style: "primary" },
          { value: "n", label: "Cancel" },
        ],
        { label: "Or tell me what to do instead", multiline: true },
      ),
    ).toEqual({
      message: "Deploy?",
      options: [
        { value: "y", label: "Deploy", style: "primary" },
        { value: "n", label: "Cancel" },
      ],
      input: { label: "Or tell me what to do instead", multiline: true },
    });
  });

  test.each(["primary", "danger"] as const)("accepts the %s style", (style) => {
    expect(interruptReason("m", [{ value: "v", style }])).toEqual({
      message: "m",
      options: [{ value: "v", style }],
    });
  });

  test.each([true, false])("accepts multiline %p", (multiline) => {
    expect(interruptReason("m", undefined, { multiline })).toEqual({
      message: "m",
      input: { multiline },
    });
  });

  test("throws on an empty message", () => {
    expect(() => interruptReason("", [{ value: "y" }])).toThrow(TypeError);
  });

  test("throws when neither options nor input is given", () => {
    expect(() => interruptReason("m")).toThrow(TypeError);
  });

  test("throws on empty options", () => {
    expect(() => interruptReason("m", [])).toThrow(TypeError);
  });

  test("throws on an unknown option key", () => {
    const options = [
      { value: "y", text: "Yes" },
    ] as unknown as InterruptOption[];
    expect(() => interruptReason("m", options)).toThrow(TypeError);
  });

  test.each([
    [{}],
    [{ value: "" }],
    [{ value: 5 }],
  ])("throws on a missing or invalid option value: %p", (option) => {
    const options = [option] as unknown as InterruptOption[];
    expect(() => interruptReason("m", options)).toThrow(TypeError);
  });

  test.each([
    [{ value: "y", label: "" }],
    [{ value: "y", label: 5 }],
  ])("throws on an invalid option label: %p", (option) => {
    const options = [option] as unknown as InterruptOption[];
    expect(() => interruptReason("m", options)).toThrow(TypeError);
  });

  test.each([
    [{ value: "y", style: "default" }],
    [{ value: "y", style: 5 }],
  ])("throws on an invalid option style: %p", (option) => {
    const options = [option] as unknown as InterruptOption[];
    expect(() => interruptReason("m", options)).toThrow(TypeError);
  });

  test("throws on an unknown input key", () => {
    const input = { placeholder: "x" } as unknown as InterruptInput;
    expect(() => interruptReason("m", undefined, input)).toThrow(TypeError);
  });

  test.each([
    [{ label: "" }],
    [{ label: 5 }],
  ])("throws on an invalid input label: %p", (input) => {
    expect(() =>
      interruptReason("m", undefined, input as unknown as InterruptInput),
    ).toThrow(TypeError);
  });

  test("throws on a non-boolean multiline", () => {
    const input = { multiline: "yes" } as unknown as InterruptInput;
    expect(() => interruptReason("m", undefined, input)).toThrow(TypeError);
  });
});
