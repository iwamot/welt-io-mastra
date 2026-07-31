import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { WireMessage } from "../src/index.ts";
import { decodeMessages } from "../src/index.ts";

const source = { bytes: "aGk=" };

describe("decodeMessages", () => {
  test("decodes text blocks for both roles", () => {
    assert.deepEqual(
      decodeMessages([
        { role: "user", content: [{ text: "hello" }] },
        { role: "assistant", content: [{ text: "hi" }, { text: "there" }] },
      ]),
      [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "hi" },
            { type: "text", text: "there" },
          ],
        },
      ],
    );
  });

  test("decodes an image block into an image part", () => {
    assert.deepEqual(
      decodeMessages([
        { role: "user", content: [{ image: { format: "png", source } }] },
      ]),
      [
        {
          role: "user",
          content: [{ type: "image", image: "aGk=", mediaType: "image/png" }],
        },
      ],
    );
  });

  test("decodes a document block into a file part named after it", () => {
    assert.deepEqual(
      decodeMessages([
        {
          role: "user",
          content: [{ document: { format: "pdf", name: "Report", source } }],
        },
      ]),
      [
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
      ],
    );
  });

  test("decodes a video block into a nameless file part", () => {
    assert.deepEqual(
      decodeMessages([
        { role: "user", content: [{ video: { format: "mp4", source } }] },
      ]),
      [
        {
          role: "user",
          content: [{ type: "file", data: "aGk=", mediaType: "video/mp4" }],
        },
      ],
    );
  });

  // Every format token the wire carries has a media type, so a payload
  // built from it never wants for one.
  const imageMediaTypes = [
    ["gif", "image/gif"],
    ["jpeg", "image/jpeg"],
    ["png", "image/png"],
    ["webp", "image/webp"],
  ] as const;
  for (const [format, mediaType] of imageMediaTypes) {
    test(`maps the image format ${format} to ${mediaType}`, () => {
      const [decoded] = decodeMessages([
        { role: "user", content: [{ image: { format, source } }] },
      ]);
      assert.deepEqual(decoded?.content, [
        { type: "image", image: "aGk=", mediaType },
      ]);
    });
  }

  const documentMediaTypes = [
    ["csv", "text/csv"],
    ["doc", "application/msword"],
    [
      "docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    ["html", "text/html"],
    ["md", "text/markdown"],
    ["pdf", "application/pdf"],
    ["txt", "text/plain"],
    ["xls", "application/vnd.ms-excel"],
    [
      "xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
  ] as const;
  for (const [format, mediaType] of documentMediaTypes) {
    test(`maps the document format ${format} to ${mediaType}`, () => {
      const [decoded] = decodeMessages([
        {
          role: "user",
          content: [{ document: { format, name: "a", source } }],
        },
      ]);
      assert.deepEqual(decoded?.content, [
        { type: "file", data: "aGk=", mediaType, filename: "a" },
      ]);
    });
  }

  const videoMediaTypes = [
    ["flv", "video/x-flv"],
    ["mkv", "video/x-matroska"],
    ["mov", "video/quicktime"],
    ["mp4", "video/mp4"],
    ["mpeg", "video/mpeg"],
    ["mpg", "video/mpeg"],
    ["three_gp", "video/3gpp"],
    ["webm", "video/webm"],
    ["wmv", "video/x-ms-wmv"],
  ] as const;
  for (const [format, mediaType] of videoMediaTypes) {
    test(`maps the video format ${format} to ${mediaType}`, () => {
      const [decoded] = decodeMessages([
        { role: "user", content: [{ video: { format, source } }] },
      ]);
      assert.deepEqual(decoded?.content, [
        { type: "file", data: "aGk=", mediaType },
      ]);
    });
  }

  test("passes the base64 on without decoding or judging it", () => {
    // An AI SDK part takes the string itself, so what the bytes decode to —
    // if anything — is the framework's business, not the adapter's.
    assert.deepEqual(
      decodeMessages([
        {
          role: "user",
          content: [{ image: { format: "png", source: { bytes: "a*Gk=" } } }],
        },
      ]),
      [
        {
          role: "user",
          content: [{ type: "image", image: "a*Gk=", mediaType: "image/png" }],
        },
      ],
    );
  });

  test("leaves the payload it was handed untouched", () => {
    const messages: WireMessage[] = [
      { role: "user", content: [{ text: "hello" }] },
    ];
    decodeMessages(messages);
    assert.deepEqual(messages, [
      { role: "user", content: [{ text: "hello" }] },
    ]);
  });

  test("decodes an empty conversation into an empty one", () => {
    assert.deepEqual(decodeMessages([]), []);
  });
});
