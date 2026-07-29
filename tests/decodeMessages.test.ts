import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decodeMessages, WireContractError } from "../src/index.ts";

/** Assert that a payload is refused, and that the error names `path`. */
function rejects(messages: unknown, path: string) {
  assert.throws(
    () => decodeMessages(messages),
    (error: unknown) => {
      assert.ok(error instanceof WireContractError);
      assert.equal(error.path, path);
      assert.ok(error.message.startsWith(`${path}: `));
      return true;
    },
  );
}

const source = { bytes: "aGk=" };

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
      { role: "user", content: [{ image: { format: "png", source } }] },
    ];
    assert.deepEqual(decodeMessages(messages), [
      {
        role: "user",
        content: [{ type: "image", image: "aGk=", mediaType: "image/png" }],
      },
    ]);
  });

  test("decodes a document block into a file part named after it", () => {
    const messages = [
      {
        role: "user",
        content: [{ document: { format: "pdf", name: "Report", source } }],
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

  test("decodes a video block into a nameless file part", () => {
    const messages = [
      { role: "user", content: [{ video: { format: "mp4", source } }] },
    ];
    assert.deepEqual(decodeMessages(messages), [
      {
        role: "user",
        content: [{ type: "file", data: "aGk=", mediaType: "video/mp4" }],
      },
    ]);
  });

  // Every format token the schema admits has a media type, so a payload it
  // vouched for never wants for one.
  const mediaTypeByFormat: [string, string, string][] = [
    ["image", "gif", "image/gif"],
    ["image", "jpeg", "image/jpeg"],
    ["image", "png", "image/png"],
    ["image", "webp", "image/webp"],
    ["document", "csv", "text/csv"],
    ["document", "doc", "application/msword"],
    [
      "document",
      "docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    ["document", "html", "text/html"],
    ["document", "md", "text/markdown"],
    ["document", "pdf", "application/pdf"],
    ["document", "txt", "text/plain"],
    ["document", "xls", "application/vnd.ms-excel"],
    [
      "document",
      "xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    ["video", "flv", "video/x-flv"],
    ["video", "mkv", "video/x-matroska"],
    ["video", "mov", "video/quicktime"],
    ["video", "mp4", "video/mp4"],
    ["video", "mpeg", "video/mpeg"],
    ["video", "mpg", "video/mpeg"],
    ["video", "three_gp", "video/3gpp"],
    ["video", "webm", "video/webm"],
    ["video", "wmv", "video/x-ms-wmv"],
  ];
  for (const [kind, format, mediaType] of mediaTypeByFormat) {
    test(`maps the ${kind} format ${format} to ${mediaType}`, () => {
      const media =
        kind === "document"
          ? { format, name: "a", source }
          : { format, source };
      const [decoded] = decodeMessages([
        { role: "user", content: [{ [kind]: media }] },
      ]);
      const expected =
        kind === "image"
          ? { type: "image", image: "aGk=", mediaType }
          : kind === "document"
            ? { type: "file", data: "aGk=", mediaType, filename: "a" }
            : { type: "file", data: "aGk=", mediaType };
      assert.deepEqual(decoded?.content, [expected]);
    });
  }

  test("passes the base64 on without decoding or judging it", () => {
    // An AI SDK part takes the string itself, so what the bytes decode to —
    // if anything — is the framework's business, not the adapter's. The
    // schema annotates the encoding without asserting it.
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

  test("leaves the payload it was handed untouched", () => {
    const messages = [{ role: "user", content: [{ text: "hello" }] }];
    decodeMessages(messages);
    assert.deepEqual(messages, [
      { role: "user", content: [{ text: "hello" }] },
    ]);
  });

  test("names where a nested block broke", () => {
    rejects(
      [
        { role: "user", content: [{ text: "hi" }] },
        {
          role: "user",
          content: [{ image: { format: "png", source: { bytes: "" } } }],
        },
      ],
      "$[1].content[0].image.source.bytes",
    );
  });

  test("refuses a payload that is not a conversation", () => {
    rejects(undefined, "$");
    rejects("hi", "$");
    rejects({ messages: [] }, "$");
    rejects([], "$");
  });

  test("refuses a conversation that does not open with a user turn", () => {
    rejects([{ role: "assistant", content: [{ text: "hi" }] }], "$[0].role");
  });

  test("refuses a role the wire does not carry", () => {
    rejects([{ role: "system", content: [{ text: "hi" }] }], "$[0].role");
    rejects([{ content: [{ text: "hi" }] }], "$[0]");
  });

  test("refuses a turn without content", () => {
    rejects([{ role: "user" }], "$[0]");
    rejects([{ role: "user", content: [] }], "$[0].content");
    rejects([{ role: "user", content: "hi" }], "$[0].content");
  });

  test("refuses an empty text block", () => {
    rejects(
      [{ role: "user", content: [{ text: "" }] }],
      "$[0].content[0].text",
    );
  });

  test("refuses a block carrying none of the kinds the wire defines", () => {
    rejects([{ role: "user", content: [{}] }], "$[0].content[0]");
    rejects([{ role: "user", content: [{ audio: {} }] }], "$[0].content[0]");
    rejects([{ role: "user", content: ["hi"] }], "$[0].content[0]");
  });

  test("refuses a block with a key the wire does not define", () => {
    rejects(
      [{ role: "user", content: [{ text: "hi", extra: 1 }] }],
      "$[0].content[0]",
    );
  });

  test("refuses a format the wire does not carry", () => {
    rejects(
      [{ role: "user", content: [{ image: { format: "bmp", source } }] }],
      "$[0].content[0].image.format",
    );
    rejects(
      [
        {
          role: "user",
          content: [{ document: { format: "rtf", name: "a", source } }],
        },
      ],
      "$[0].content[0].document.format",
    );
    rejects(
      [{ role: "user", content: [{ video: { format: "avi", source } }] }],
      "$[0].content[0].video.format",
    );
  });

  test("refuses a media block without usable source bytes", () => {
    rejects(
      [{ role: "user", content: [{ image: { format: "png" } }] }],
      "$[0].content[0].image",
    );
    rejects(
      [
        {
          role: "user",
          content: [{ video: { format: "mp4", source: { bytes: 5 } } }],
        },
      ],
      "$[0].content[0].video.source.bytes",
    );
  });

  test("refuses a document without a name Converse accepts", () => {
    rejects(
      [{ role: "user", content: [{ document: { format: "pdf", source } }] }],
      "$[0].content[0].document",
    );
    rejects(
      [
        {
          role: "user",
          content: [{ document: { format: "pdf", name: "", source } }],
        },
      ],
      "$[0].content[0].document.name",
    );
    rejects(
      [
        {
          role: "user",
          content: [{ document: { format: "pdf", name: "a/b", source } }],
        },
      ],
      "$[0].content[0].document.name",
    );
  });

  test("refuses an assistant turn carrying anything but text", () => {
    rejects(
      [
        { role: "user", content: [{ text: "hi" }] },
        {
          role: "assistant",
          content: [{ image: { format: "png", source } }],
        },
      ],
      "$[1].content[0]",
    );
  });
});
