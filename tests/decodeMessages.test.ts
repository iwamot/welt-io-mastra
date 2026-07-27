import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeMessages } from "../src/index.ts";

const rejects = (messages: unknown) =>
  assert.throws(() => decodeMessages(messages), TypeError);

describe("decodeMessages", () => {
  test("decodes text blocks for both roles", () => {
    const messages = [
      { role: "user", content: [{ text: "hello" }] },
      { role: "assistant", content: [{ text: "hi" }, { text: "there" }] },
    ];
    assert.deepEqual(decodeMessages(messages), [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "hi" },
          { type: "text", text: "there" },
        ],
      },
    ]);
  });

  test("decodes an image block into an image part", () => {
    const messages = [
      {
        role: "user",
        content: [{ image: { format: "png", source: { bytes: "aGk=" } } }],
      },
    ];
    assert.deepEqual(decodeMessages(messages), [
      {
        role: "user",
        content: [{ type: "image", image: "aGk=", mediaType: "image/png" }],
      },
    ]);
  });

  test("omits the media type for an unknown or missing image format", () => {
    const messages = [
      {
        role: "user",
        content: [
          { image: { format: "bmp", source: { bytes: "aGk=" } } },
          { image: { source: { bytes: "aGk=" } } },
        ],
      },
    ];
    assert.deepEqual(decodeMessages(messages), [
      {
        role: "user",
        content: [
          { type: "image", image: "aGk=" },
          { type: "image", image: "aGk=" },
        ],
      },
    ]);
  });

  test("decodes a document block into a file part with its name", () => {
    const messages = [
      {
        role: "user",
        content: [
          {
            document: {
              format: "pdf",
              name: "Report",
              source: { bytes: "aGk=" },
            },
          },
        ],
      },
    ];
    assert.deepEqual(decodeMessages(messages), [
      {
        role: "user",
        content: [
          {
            type: "file",
            data: "aGk=",
            mediaType: "application/pdf",
            filename: "Report",
          },
        ],
      },
    ]);
  });

  test("falls back to octet-stream for an unknown or missing document format", () => {
    const messages = [
      {
        role: "user",
        content: [
          { document: { format: "rtf", name: "n", source: { bytes: "aGk=" } } },
          { document: { name: "n", source: { bytes: "aGk=" } } },
        ],
      },
    ];
    assert.deepEqual(decodeMessages(messages), [
      {
        role: "user",
        content: [
          {
            type: "file",
            data: "aGk=",
            mediaType: "application/octet-stream",
            filename: "n",
          },
          {
            type: "file",
            data: "aGk=",
            mediaType: "application/octet-stream",
            filename: "n",
          },
        ],
      },
    ]);
  });

  test("decodes a video block into a file part", () => {
    const messages = [
      {
        role: "user",
        content: [
          { video: { format: "three_gp", source: { bytes: "aGk=" } } },
          { video: { format: "avi", source: { bytes: "aGk=" } } },
          { video: { source: { bytes: "aGk=" } } },
        ],
      },
    ];
    assert.deepEqual(decodeMessages(messages), [
      {
        role: "user",
        content: [
          { type: "file", data: "aGk=", mediaType: "video/3gpp" },
          { type: "file", data: "aGk=", mediaType: "application/octet-stream" },
          { type: "file", data: "aGk=", mediaType: "application/octet-stream" },
        ],
      },
    ]);
  });

  test("passes the base64 on without decoding or judging it", () => {
    // An AI SDK file part takes the string itself, so what the bytes decode
    // to — if anything — is the framework's business, not the adapter's.
    const messages = [
      {
        role: "user",
        content: [{ image: { format: "png", source: { bytes: "a*Gk=" } } }],
      },
    ];
    assert.deepEqual(decodeMessages(messages), [
      {
        role: "user",
        content: [{ type: "image", image: "a*Gk=", mediaType: "image/png" }],
      },
    ]);
  });

  test("keeps an empty conversation empty", () => {
    assert.deepEqual(decodeMessages([]), []);
  });

  test("passes a message with no content blocks on to the framework", () => {
    assert.deepEqual(decodeMessages([{ role: "user", content: [] }]), [
      { role: "user", content: [] },
    ]);
  });

  test("rejects a payload that is not an array", () => {
    rejects(undefined);
    rejects(null);
    rejects("hi");
    rejects({ role: "user" });
  });

  test("rejects a message that is not an object", () => {
    rejects(["hi"]);
    rejects([null]);
  });

  test("rejects a role the contract does not carry", () => {
    rejects([{ role: "tool", content: [{ text: "x" }] }]);
    rejects([{ content: [{ text: "x" }] }]);
  });

  test("rejects content that is not an array", () => {
    rejects([{ role: "user", content: "hi" }]);
    rejects([{ role: "assistant", content: 3 }]);
  });

  test("rejects a content block that is not an object", () => {
    rejects([{ role: "user", content: ["x"] }]);
    rejects([{ role: "assistant", content: [null] }]);
  });

  test("rejects a block carrying no key the contract defines", () => {
    rejects([{ role: "user", content: [{}] }]);
    rejects([{ role: "assistant", content: [{ toolUse: {} }] }]);
  });

  test("rejects non-text in an assistant message", () => {
    rejects([
      {
        role: "assistant",
        content: [{ image: { format: "png", source: { bytes: "aGk=" } } }],
      },
    ]);
  });

  test("rejects a text block whose text is not a string", () => {
    rejects([{ role: "user", content: [{ text: 5 }] }]);
  });

  test("rejects a media block that is not an object", () => {
    rejects([{ role: "user", content: [{ image: "x" }] }]);
    rejects([{ role: "user", content: [{ document: 5 }] }]);
    rejects([{ role: "user", content: [{ video: 5 }] }]);
  });

  test("rejects a media block without usable source bytes", () => {
    rejects([{ role: "user", content: [{ image: { format: "png" } }] }]);
    rejects([
      { role: "user", content: [{ image: { format: "png", source: "x" } }] },
    ]);
    rejects([
      {
        role: "user",
        content: [{ image: { format: "png", source: { bytes: 5 } } }],
      },
    ]);
    rejects([
      {
        role: "user",
        content: [{ image: { format: "png", source: { bytes: "" } } }],
      },
    ]);
    rejects([
      { role: "user", content: [{ document: { format: "pdf", name: "n" } }] },
    ]);
    rejects([{ role: "user", content: [{ video: { format: "mp4" } }] }]);
  });

  test("rejects a document without a name", () => {
    rejects([
      {
        role: "user",
        content: [{ document: { format: "csv", source: { bytes: "aGk=" } } }],
      },
    ]);
    rejects([
      {
        role: "user",
        content: [
          { document: { format: "csv", name: "", source: { bytes: "aGk=" } } },
        ],
      },
    ]);
  });
});
