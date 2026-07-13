import { describe, expect, test } from "bun:test";
import { decodeMessages } from "../src/index.ts";

describe("decodeMessages", () => {
  test("returns no messages for a non-array payload", () => {
    expect(decodeMessages(undefined)).toEqual([]);
    expect(decodeMessages({ role: "user" })).toEqual([]);
  });

  test("skips non-object messages and unknown roles", () => {
    const messages = ["hi", null, { role: "tool", content: [{ text: "x" }] }];
    expect(decodeMessages(messages)).toEqual([]);
  });

  test("skips messages whose content is not an array", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: 3 },
    ];
    expect(decodeMessages(messages)).toEqual([]);
  });

  test("decodes text blocks for both roles", () => {
    const messages = [
      { role: "user", content: [{ text: "hello" }] },
      { role: "assistant", content: [{ text: "hi" }, { text: "there" }] },
    ];
    expect(decodeMessages(messages)).toEqual([
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
    expect(decodeMessages(messages)).toEqual([
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
    expect(decodeMessages(messages)).toEqual([
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
    expect(decodeMessages(messages)).toEqual([
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
    expect(decodeMessages(messages)).toEqual([
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
    expect(decodeMessages(messages)).toEqual([
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
    expect(decodeMessages(messages)).toEqual([
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
    expect(decodeMessages(messages)).toEqual([
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
    expect(decodeMessages(messages)).toEqual([
      { role: "user", content: [{ type: "text", text: "kept" }] },
    ]);
  });

  test("drops messages left with no parts", () => {
    const messages = [
      { role: "user", content: [] },
      { role: "user", content: [{ image: "x" }] },
      { role: "assistant", content: [{ toolUse: {} }] },
    ];
    expect(decodeMessages(messages)).toEqual([]);
  });
});
