import { expect, test } from "bun:test";

process.env.APP_PASSWORD ??= "test-password";
process.env.SESSION_SECRET ??= "s".repeat(32);
process.env.S3_BUCKET ??= "b";
process.env.S3_ACCESS_KEY_ID ??= "k";
process.env.S3_SECRET_ACCESS_KEY ??= "s";
const { open, seal } = await import("./tokens.ts");

test("sealed tokens round-trip and are bound to their type", () => {
  const token = seal("access", { jti: "1" }, 60);
  expect(open<{ jti: string }>("access", token)?.jti).toBe("1");
  expect(open("refresh", token)).toBeNull();
});

test("tampered, expired and malformed tokens are rejected", () => {
  const token = seal("code", { jti: "1" }, 60);
  expect(open("code", token.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toBeNull();
  expect(open("code", seal("code", { jti: "1" }, -1))).toBeNull();
  for (const bad of [null, 42, "", "abc", ".", "a.b"]) expect(open("code", bad)).toBeNull();
});

test("tokens without a lifetime do not expire", () => {
  expect(open("client", seal("client", { redirect_uris: ["https://a/cb"] }))).not.toBeNull();
});
