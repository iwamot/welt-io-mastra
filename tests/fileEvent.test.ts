import { describe, expect, test } from "bun:test";
import { fileEvent } from "../src/index.ts";

describe("fileEvent", () => {
  test("builds a file event with base64 bytes", () => {
    expect(fileEvent("hi.txt", new TextEncoder().encode("hi"))).toEqual({
      file: { name: "hi.txt", bytes: "aGk=" },
    });
  });

  test("encodes empty data", () => {
    expect(fileEvent("empty.bin", new Uint8Array())).toEqual({
      file: { name: "empty.bin", bytes: "" },
    });
  });

  test("throws on an empty name", () => {
    expect(() => fileEvent("", new Uint8Array())).toThrow(TypeError);
  });
});
