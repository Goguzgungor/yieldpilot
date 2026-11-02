import { describe, expect, it } from "vitest";
import { requestHasKey } from "./routeKey";

const url = "https://yieldpilot.org/api/reset";

describe("requestHasKey", () => {
  it("accepts the key as a bearer token or ?key=", () => {
    expect(requestHasKey(new Request(url, { headers: { authorization: "Bearer s3cret" } }), "s3cret")).toBe(true);
    expect(requestHasKey(new Request(`${url}?key=s3cret`), "s3cret")).toBe(true);
  });

  it("rejects a missing, shorter, longer or different key", () => {
    expect(requestHasKey(new Request(url), "s3cret")).toBe(false);
    expect(requestHasKey(new Request(`${url}?key=s3cre`), "s3cret")).toBe(false);
    expect(requestHasKey(new Request(`${url}?key=s3crett`), "s3cret")).toBe(false);
    expect(requestHasKey(new Request(url, { headers: { authorization: "Bearer s3creT" } }), "s3cret")).toBe(false);
  });
});
