import { describe, expect, it } from "vitest";
import { evaluatePreflight, type PreflightFacts } from "../../scripts/loadtest/preflight-checks";

const good: PreflightFacts = {
  mongoDb: "yieldseeker_loadtest_20261006",
  mongoWritable: true,
  envAgent: "GAGENT",
  serverAgent: "GAGENT",
  agentXlm: 10_000,
  faucetAdmin: "GFAUCET",
  sacAdmin: "GFAUCET",
  faucetAdminXlm: 8_741,
  poolStatus: 0,
  smartAccountWasm: true,
  rpcRetentionLedgers: 120_960,
};

describe("evaluatePreflight", () => {
  it("passes a healthy setup", () => {
    expect(evaluatePreflight(good).filter((c) => !c.ok)).toEqual([]);
  });

  const cases: Array<[string, Partial<PreflightFacts>, string]> = [
    ["the production Mongo db", { mongoDb: "yieldseeker" }, "isolated Mongo db"],
    ["an unset Mongo db", { mongoDb: undefined }, "isolated Mongo db"],
    ["an unwritable Mongo db", { mongoWritable: "not authorized" }, "Mongo writable"],
    ["a server on another agent (prod?)", { serverAgent: "GPROD" }, "server runs the load-test agent"],
    ["a server that is down", { serverAgent: null }, "server runs the load-test agent"],
    ["a poor agent", { agentXlm: 50 }, "agent XLM ≥ 1000"],
    ["a faucet key that is not the SAC admin", { sacAdmin: "GOTHER" }, "faucet key is the USDC SAC admin"],
    ["a frozen pool", { poolStatus: 4 }, "exec pool accepts supply"],
    ["a missing smart-account wasm", { smartAccountWasm: false }, "smart-account wasm installed"],
    ["a short RPC history", { rpcRetentionLedgers: 17_280 }, "RPC keeps ≥ 2 days of history"],
  ];
  it.each(cases)("fails on %s", (_label, patch, name) => {
    expect(evaluatePreflight({ ...good, ...patch }).filter((c) => !c.ok).map((c) => c.name)).toEqual([name]);
  });
});
