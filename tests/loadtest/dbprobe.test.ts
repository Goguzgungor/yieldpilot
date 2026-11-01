import { describe, expect, it } from "vitest";
import { exportDbProblem, probeServerDb, registryEmptyProblem } from "../../scripts/loadtest/dbprobe";

describe("probeServerDb", () => {
  it("passes when the server's activity feed shows the row this shell just wrote", async () => {
    const rows: Array<{ kind: string; message: string }> = [];
    const write = async (message: string) => void rows.unshift({ kind: "preflight", message });
    const api = { get: async () => rows };
    expect(await probeServerDb(api, write, "n0nce")).toBe(true);
  });
  it("fails when the server reads another db (e.g. still on the smoke db)", async () => {
    const api = { get: async () => [{ kind: "scan", message: "scanned 2 pools" }] };
    expect(await probeServerDb(api, async () => {}, "n0nce")).toMatch(/different MONGODB_DB/);
  });
  it("reports an unwritable db or an unreachable server instead of throwing", async () => {
    const api = { get: async () => [] };
    expect(await probeServerDb(api, async () => { throw new Error("not authorized"); }, "n")).toMatch(/not authorized/);
    const down = { get: async () => { throw new Error("unreachable (ECONNREFUSED)"); } };
    expect(await probeServerDb(down, async () => {}, "n")).toMatch(/ECONNREFUSED/);
  });
});

describe("registryEmptyProblem", () => {
  it("refuses to start a run on a registry that already has users", () => {
    expect(registryEmptyProblem({ users: [] })).toBeNull();
    expect(registryEmptyProblem({ users: [{ owner: "G1" }, { owner: "G2" }] })).toMatch(/2 user/);
    expect(registryEmptyProblem({ error: "boom" })).toMatch(/unexpected/);
  });
});

describe("exportDbProblem", () => {
  it("requires the export shell to read the db the run wrote to", () => {
    expect(exportDbProblem("yieldseeker_loadtest_20261006", true, "yieldseeker_loadtest_20261006")).toBeNull();
    expect(exportDbProblem("yieldseeker_loadtest_20261006", false, "yieldseeker_loadtest_20261006")).toMatch(/MONGODB_URI/);
    expect(exportDbProblem("yieldseeker_loadtest_20261006", true, "yieldseeker")).toMatch(/MONGODB_DB=yieldseeker_loadtest_20261006/);
    expect(exportDbProblem(undefined, true, "yieldseeker")).toMatch(/no mongoDb/);
  });
});
