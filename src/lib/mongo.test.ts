import { describe, expect, it } from "vitest";
import { mongoDbName } from "./mongo";

describe("mongoDbName", () => {
  it("defaults to the production db", () => {
    expect(mongoDbName({})).toBe("yieldseeker");
  });
  it("honours MONGODB_DB so an isolated run gets its own db", () => {
    expect(mongoDbName({ MONGODB_DB: "yieldseeker_loadtest_20261006" })).toBe("yieldseeker_loadtest_20261006");
  });
  it("ignores a blank override (a copied .env.example has MONGODB_DB=)", () => {
    expect(mongoDbName({ MONGODB_DB: "  " })).toBe("yieldseeker");
  });
});
