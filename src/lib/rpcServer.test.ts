import { describe, it, expect } from "vitest";
import { rpc } from "@stellar/stellar-sdk";
import { latestLedgerFromRaw, withRawLatestLedger } from "./rpcServer";

// A header this SDK can't decode, as testnet's Protocol 30 headers were on 2026-11-08
// ("XDR Read Error: unknown StellarValueType member for value 3").
const raw: rpc.Api.RawGetLatestLedgerResponse = {
  id: "abc",
  sequence: 5_623_667,
  protocolVersion: "30",
  closeTime: "1794140000",
  headerXdr: "AAAA//8=",
  metadataXdr: "AAAA//8=",
};

describe("latestLedgerFromRaw", () => {
  it("gives the sequence without decoding a header the SDK can't read", () => {
    const l = latestLedgerFromRaw(raw);
    expect(l.sequence).toBe(5_623_667);
    expect(l.protocolVersion).toBe("30");
    expect(() => l.headerXdr).toThrow();
  });
});

describe("withRawLatestLedger", () => {
  it("makes getLatestLedger read the raw response", async () => {
    const server = withRawLatestLedger(new rpc.Server("https://soroban-testnet.stellar.org"));
    server._getLatestLedger = async () => raw;
    expect((await server.getLatestLedger()).sequence).toBe(5_623_667);
  });
});
