import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileEvent } from "../src/index.ts";

describe("fileEvent", () => {
  test("builds a file event with base64 bytes", () => {
    assert.deepEqual(fileEvent("hi.txt", new TextEncoder().encode("hi")), {
      file: { name: "hi.txt", bytes: "aGk=" },
    });
  });

  test("encodes empty data", () => {
    assert.deepEqual(fileEvent("empty.bin", new Uint8Array()), {
      file: { name: "empty.bin", bytes: "" },
    });
  });

  test("throws on an empty name", () => {
    assert.throws(() => fileEvent("", new Uint8Array()), TypeError);
  });
});
