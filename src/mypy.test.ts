import * as assert from "assert";

import { mypyOutputPattern } from "./mypy";

const mypyOutputTests = [
  ["file.py:13:12: note: hello", [["file.py", "13", "12", "note", "hello"]]],
  [
    "some/path.py:13:12: error: hello",
    [["some/path.py", "13", "12", "error", "hello"]],
  ],
  [
    "/some/absolute/path.py:13:12: error: hello",
    [["/some/absolute/path.py", "13", "12", "error", "hello"]],
  ],
  [
    "/some/absolute/path.py: error: hello",
    [["/some/absolute/path.py", undefined, undefined, "error", "hello"]],
  ],
  [
    "/some/absolute/path.py:13: error: hello",
    [["/some/absolute/path.py", "13", undefined, "error", "hello"]],
  ],
  [
    "C:\\Path with space\\file.py:13:12: error: hello",
    [["C:\\Path with space\\file.py", "13", "12", "error", "hello"]],
  ],
  ["file: note: hello", [["file", undefined, undefined, "note", "hello"]]],
  ["file: hello", []],
  ["some message", []],
  [
    "file: with: colon.py:13:12: note: hello",
    [["file", undefined, undefined, "with", "colon.py:13:12: note: hello"]],
    // This is actually a bug, the desired parsing for this line is:
    // [["file: with: colon.py", "13", "12", "note", "hello"]],
    // Probably the only way to make this work is restrict the type to "error" or "note".
  ],
  [
    "file1.py:1:2: error: some error message\n" +
      "file2.py:2:3: note: some error message\n" +
      "Some ignored line\n" +
      "file3.py: error: another message\n",
    [
      ["file1.py", "1", "2", "error", "some error message"],
      ["file2.py", "2", "3", "note", "some error message"],
      ["file3.py", undefined, undefined, "error", "another message"],
    ],
  ],
] as const;

describe("Mypy", function () {
  describe("output parsing", function () {
    for (const [input, expected] of mypyOutputTests) {
      it(`should parse "${input}"`, function () {
        const matches = matchAll(input, mypyOutputPattern);
        assert.deepStrictEqual(matches, expected);
      });
    }
  });
});

function matchAll(input: string, pattern: RegExp) {
  const matches = [];
  let match;
  while ((match = pattern.exec(input)) !== null) {
    const groups = match.groups as {
      file: string;
      line: string;
      column?: string;
      type: string;
      message: string;
    };
    matches.push([
      groups.file,
      groups.line,
      groups.column,
      groups.type,
      groups.message,
    ]);
  }
  return matches;
}
