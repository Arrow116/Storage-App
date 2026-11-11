import { expect, test } from "bun:test";
import { LoginLimiter, checkCredentials, createSessionToken, readCookie, verifySessionToken } from "./auth.ts";

const secret = "s".repeat(32);

test("session tokens verify until they expire", () => {
  const now = Date.now();
  const token = createSessionToken(secret, 60, now);
  expect(verifySessionToken(token, secret, now)).toBe(true);
  expect(verifySessionToken(token, secret, now + 61_000)).toBe(false);
});

test("session tokens reject tampering and wrong secrets", () => {
  const token = createSessionToken(secret, 60);
  const [, mac] = token.split(".");
  expect(verifySessionToken(`9999999999.${mac}`, secret)).toBe(false);
  expect(verifySessionToken(token, "x".repeat(32))).toBe(false);
  for (const bad of [undefined, "", "abc", ".", "123."]) expect(verifySessionToken(bad, secret)).toBe(false);
});

test("checkCredentials", () => {
  const expected = { username: "admin", password: "correct horse" };
  expect(checkCredentials({ username: "admin", password: "correct horse" }, expected)).toBe(true);
  expect(checkCredentials({ username: "admin", password: "wrong" }, expected)).toBe(false);
  expect(checkCredentials({ username: "root", password: "correct horse" }, expected)).toBe(false);
  expect(checkCredentials({ username: undefined, password: 1 }, expected)).toBe(false);
});

test("readCookie", () => {
  const req = new Request("http://x/", { headers: { cookie: "a=1; storage_session=abc.def; b=2" } });
  expect(readCookie(req, "storage_session")).toBe("abc.def");
  expect(readCookie(req, "missing")).toBeUndefined();
});

test("LoginLimiter blocks after repeated failures and recovers", () => {
  const limiter = new LoginLimiter(3, 1000);
  for (let i = 0; i < 3; i++) limiter.recordFailure("ip", 0);
  expect(limiter.isBlocked("ip", 500)).toBe(true);
  expect(limiter.isBlocked("other", 500)).toBe(false);
  expect(limiter.isBlocked("ip", 1001)).toBe(false);
});
