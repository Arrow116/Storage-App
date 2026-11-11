import { describe, expect, test } from "bun:test";
import { KeyError, baseName, parseFileKey, parseFolderKey } from "./keys.ts";

describe("parseFileKey", () => {
  test("accepts nested paths", () => {
    expect(parseFileKey("a/b/report (1).pdf")).toBe("a/b/report (1).pdf");
  });
  test.each(["", "/a", "a/", "a//b", "../a", "a/../b", "a/./b", "a\\b", "a\nb", 42, null])("rejects %p", (bad) => {
    expect(() => parseFileKey(bad)).toThrow(KeyError);
  });
  test("rejects overlong paths", () => {
    expect(() => parseFileKey("x".repeat(901))).toThrow(KeyError);
  });
});

describe("parseFolderKey", () => {
  test("normalizes the trailing slash", () => {
    expect(parseFolderKey("a/b")).toBe("a/b/");
    expect(parseFolderKey("a/b/")).toBe("a/b/");
  });
  test("root only when allowed", () => {
    expect(parseFolderKey("", { allowRoot: true })).toBe("");
    expect(() => parseFolderKey("")).toThrow(KeyError);
  });
  test.each(["/", "a//", "../", "a/../"])("rejects %p", (bad) => {
    expect(() => parseFolderKey(bad)).toThrow(KeyError);
  });
});

test("baseName", () => {
  expect(baseName("a/b/c.txt")).toBe("c.txt");
  expect(baseName("a/b/")).toBe("b");
  expect(baseName("c.txt")).toBe("c.txt");
});
