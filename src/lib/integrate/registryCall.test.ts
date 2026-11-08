import { describe, it, expect } from "vitest";
import * as sdk from "@stellar/stellar-sdk";
import { READ_SOURCE, buildReadTx, callRegistry } from "./registryCall";
import { VIGIL } from "./facts";

const POOL = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD";

/** An RPC that answers simulateTransaction with `retval`, and records what it was sent. */
function fakeRpc(retval: sdk.xdr.ScVal | { error: string }) {
  const sent: Array<{ url: string; body: { method: string; params: { transaction: string } } }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    // ScVal has an error() arm accessor, so tell the two apart by type, not by `"error" in`.
    const result = retval instanceof sdk.xdr.ScVal
      ? { latestLedger: 5623913, results: [{ xdr: retval.toXDR("base64"), auth: [] }] }
      : { latestLedger: 5623913, error: retval.error };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

const someRating = sdk.nativeToScVal(
  { publishers: 1, score: 76, timestamp: 1794142857n },
  { type: { publishers: ["symbol", "u32"], score: ["symbol", "u32"], timestamp: ["symbol", "u64"] } },
);

describe("buildReadTx", () => {
  it("is an unsigned call of the registry's get_rating with the pool address", async () => {
    const tx = sdk.TransactionBuilder.fromXDR(await buildReadTx({ fn: "get_rating", pool: POOL }, sdk), VIGIL.networkPassphrase) as sdk.Transaction;
    expect(tx.source).toBe(READ_SOURCE);
    expect(tx.signatures).toHaveLength(0);
    const fn = (tx.operations[0] as sdk.Operation.InvokeHostFunction).func.invokeContract();
    expect(sdk.Address.fromScAddress(fn.contractAddress()).toString()).toBe(VIGIL.registryId);
    expect(fn.functionName().toString()).toBe("get_rating");
    expect(fn.args().map((a) => sdk.scValToNative(a))).toEqual([POOL]);
  });
});

describe("callRegistry", () => {
  it("POSTs simulateTransaction to the testnet RPC and decodes Some(Rating)", async () => {
    const rpc = fakeRpc(someRating);
    const r = await callRegistry({ fn: "get_rating", pool: POOL }, { fetchImpl: rpc.fetchImpl, sdk });
    expect(rpc.sent[0].url).toBe(VIGIL.rpcUrl);
    expect(rpc.sent[0].body.method).toBe("simulateTransaction");
    expect(r.body).toBe(JSON.stringify(rpc.sent[0].body)); // shown exactly as sent
    expect(r.value).toEqual({ score: 76, publishers: 1, timestamp: 1794142857 });
    expect(r).toMatchObject({ signature: "get_rating(Address(CAJJ…BXBD))", latestLedger: 5623913 });
  });

  it("decodes None as null", async () => {
    const r = await callRegistry({ fn: "get_rating", pool: POOL }, { fetchImpl: fakeRpc(sdk.xdr.ScVal.scvVoid()).fetchImpl, sdk });
    expect(r.value).toBeNull();
  });

  it("decodes the zero-argument reads", async () => {
    const pubs = sdk.nativeToScVal([new sdk.Address(READ_SOURCE)]);
    expect((await callRegistry({ fn: "publishers" }, { fetchImpl: fakeRpc(pubs).fetchImpl, sdk })).value).toEqual([READ_SOURCE]);
    const u64 = sdk.nativeToScVal(7200n, { type: "u64" });
    expect((await callRegistry({ fn: "max_age" }, { fetchImpl: fakeRpc(u64).fetchImpl, sdk })).value).toBe(7200);
  });

  it("surfaces a failed simulation", async () => {
    const rpc = fakeRpc({ error: "HostError: Error(Contract, #1)\nmore" });
    await expect(callRegistry({ fn: "threshold" }, { fetchImpl: rpc.fetchImpl, sdk })).rejects.toThrow("simulation failed: HostError: Error(Contract, #1)");
  });
});
