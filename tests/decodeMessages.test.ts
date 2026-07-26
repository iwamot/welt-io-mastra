import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeMessages } from "../src/index.ts";

describe("decodeMessages", () => {
  test("returns no messages for a non-array payload", () => {
    assert.deepEqual(decodeMessages(undefined), []);
    assert.deepEqual(decodeMessages({ role: "user" }), []);
  });

  test("skips non-object messages and unknown roles", () => {
    const messages = ["hi", null, { role: "tool", content: [{ text: "x" }] }];
    assert.deepEqual(decodeMessages(messages), []);
  });

  test("skips messages whose content is not an array", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: 3 },
    ];
    assert.deepEqual(decodeMessages(messages), []);
  });

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

  test("keeps only text blocks of an assistant message", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { image: { format: "png", source: { bytes: "aGk=" } } },
          { text: "t" },
          null,
        ],
      },
    ];
    assert.deepEqual(decodeMessages(messages), [
      { role: "assistant", content: [{ type: "text", text: "t" }] },
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

  test("omits a missing or empty document name", () => {
    const messages = [
      {
        role: "user",
        content: [
          { document: { format: "csv", source: { bytes: "aGk=" } } },
          { document: { format: "csv", name: "", source: { bytes: "aGk=" } } },
        ],
      },
    ];
    assert.deepEqual(decodeMessages(messages), [
      {
        role: "user",
        content: [
          { type: "file", data: "aGk=", mediaType: "text/csv" },
          { type: "file", data: "aGk=", mediaType: "text/csv" },
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

  test("skips malformed media blocks", () => {
    const messages = [
      {
        role: "user",
        content: [
          "x",
          { image: "x" },
          { image: { format: "png" } },
          { image: { format: "png", source: "x" } },
          { image: { format: "png", source: { bytes: 5 } } },
          { image: { format: "png", source: { bytes: "" } } },
          { document: 5 },
          { document: { format: "pdf", name: "n" } },
          { video: 5 },
          { video: { format: "mp4" } },
          {},
          { text: "kept" },
        ],
      },
    ];
    assert.deepEqual(decodeMessages(messages), [
      { role: "user", content: [{ type: "text", text: "kept" }] },
    ]);
  });

  test("drops messages left with no parts", () => {
    const messages = [
      { role: "user", content: [] },
      { role: "user", content: [{ image: "x" }] },
      { role: "assistant", content: [{ toolUse: {} }] },
    ];
    assert.deepEqual(decodeMessages(messages), []);
  });
});
