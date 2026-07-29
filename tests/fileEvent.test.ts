import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileEvent, WireContractError } from "../src/index.ts";

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

  test("refuses a nameless file, which Welt drops", () => {
    assert.throws(
      () => fileEvent("", new Uint8Array()),
      (error: unknown) => {
        assert.ok(error instanceof WireContractError);
        assert.equal(error.path, "$.name");
        return true;
      },
    );
  });
});
