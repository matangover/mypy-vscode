import * as assert from "assert";

import { mypyOutputPattern } from "./mypy";
console.log("ASFASFASF");
console.log(mypyOutputPattern);

const mypyOutputTests = [
  [
    "file.py:13:12: note: hello",
    ["file.py", "13", "12", "note", "hello"]
  ],
  [
    "some/path.py:13:12: error: hello",
    ["some/path.py", "13", "12", "error", "hello"],
  ],
  [
    "/some/absolute/path.py:13:12: error: hello",
    ["/some/absolute/path.py", "13", "12", "error", "hello"],
  ],
  [
    "/some/absolute/path.py: error: hello",
    null,
  ],
  [
    "/some/absolute/path.py:13: error: hello",
    ["/some/absolute/path.py", "13", undefined, "error", "hello"],
  ],
  [
    "C:\\Path with space\\file.py:13:12: error: hello",
    ["C:\\Path with space\\file.py", "13", "12", "error", "hello"],
  ],
  [
    "file: note: hello",
    null
  ],
  [
    "file: hello",
    null
  ],
  [
    "some message",
    null
  ],
  [
    "file: with: colon.py:13:12: note: hello",
    ["file: with: colon.py", "13", "12", "note", "hello"],
  ],
  [
    "file1.py:1:2: error: some error message",
    ["file1.py", "1", "2", "error", "some error message"]
  ],
  [
    "file2.py:2:3: note: some error message",
    ["file2.py", "2", "3", "note", "some error message"],
  ],
  [
    "file3.py: error: another message",
    null,
  ],
  [
    "mypy/test/data.py:627: error: Unused \"type: ignore\" comment",
    ["mypy/test/data.py", "627", undefined, "error", "Unused \"type: ignore\" comment"],
  ]
] as const;

describe("Mypy", function () {
  describe("output parsing", function () {
    for (const [input, expected] of mypyOutputTests) {
      it(`should parse "${input}"`, function () {
        const match = mypyOutputPattern.exec(input);
        let actual = null;
        if (match !== null && match.groups !== undefined) {
          const groups = match.groups;
          actual = [
            groups.file,
            groups.line,
            groups.column,
            groups.type,
            groups.message,
          ]
        }
        assert.deepStrictEqual(actual, expected);
      });
    }
  });
});
