import { describe, it, expect } from "vitest";
import { Account, Address, Keypair, StrKey, scValToNative, xdr, type rpc, type Transaction } from "@stellar/stellar-sdk";
import { decodeVigilError, policiesMap, poolRuleParams, riskGateParams, tokenRuleParams, addPolicyOp } from "./guard";
import { RegistryClient } from "./registry";

const POOL = StrKey.encodeContract(Buffer.alloc(32, 2));
const REG = StrKey.encodeContract(Buffer.alloc(32, 7));
const GUARD = StrKey.encodeContract(Buffer.alloc(32, 6));
const SPEND = StrKey.encodeContract(Buffer.alloc(32, 4));
const SA = StrKey.encodeContract(Buffer.alloc(32, 5));
const PASS = "Test SDF Network ; September 2015";

describe("guard encodings", () => {
  it("matches the contract README's pool-rule ScVal", () => {
    const v = poolRuleParams({ registry: REG, minScore: 60, maxAgeSecs: 3600n });
    expect(v.toXDR("hex")).toBe(
      riskGateParams({ registry: REG, minScore: 60, maxAgeSecs: 3600n, allowedRecipients: [] }).toXDR("hex"),
    );
    expect(scValToNative(v)).toEqual({ allowed_recipients: [], max_age_secs: 3600n, min_score: 60, registry: REG });
  });

  it("structural-only pool params and token params zero the rating fields", () => {
    expect(scValToNative(poolRuleParams({}))).toEqual({ allowed_recipients: [], max_age_secs: 0n, min_score: 0, registry: null });
    expect(scValToNative(tokenRuleParams([POOL]))).toEqual({ allowed_recipients: [POOL], max_age_secs: 0n, min_score: 0, registry: null });
  });

  it("policiesMap sorts by key bytes regardless of input order", () => {
    const a = policiesMap([[GUARD, xdr.ScVal.scvVoid()], [SPEND, xdr.ScVal.scvVoid()]]).map()!;
    const b = policiesMap([[SPEND, xdr.ScVal.scvVoid()], [GUARD, xdr.ScVal.scvVoid()]]).map()!;
    expect(a.map((e) => e.key().toXDR("hex"))).toEqual(b.map((e) => e.key().toXDR("hex")));
    expect(Address.fromScAddress(a[0].key().address()).toString()).toBe(SPEND); // 0x04… < 0x06…
  });

  it("addPolicyOp targets the smart account", () => {
    const fn = addPolicyOp(SA, 1, GUARD, tokenRuleParams([POOL]));
    const call = (fn.body().value() as xdr.InvokeHostFunctionOp).hostFunction().invokeContract();
    expect(call.functionName().toString()).toBe("add_policy");
    expect(Address.fromScAddress(call.contractAddress()).toString()).toBe(SA);
  });

  it("decodeVigilError finds the guard code in a host error", () => {
    expect(decodeVigilError("HostError: Error(Contract, #4115)\n…")).toEqual({ code: 4115, name: expect.stringMatching(/ScoreTooLow/) });
    expect(decodeVigilError("HostError: Error(Contract, #10)")).toBeNull();
  });
});

describe("RegistryClient (network mocked)", () => {
  const reader = Keypair.random().publicKey();
  function serverReturning(retval: xdr.ScVal, seen: Transaction[] = []) {
    return {
      getAccount: async (id: string) => new Account(id, "1"),
      simulateTransaction: async (tx: Transaction) => {
        seen.push(tx);
        return { result: { retval, auth: [] }, latestLedger: 1 } as unknown as rpc.Api.SimulateTransactionResponse;
      },
    };
  }
  const rating = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("publishers"), val: xdr.ScVal.scvU32(2) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("score"), val: xdr.ScVal.scvU32(72) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("timestamp"), val: xdr.ScVal.scvU64(xdr.Uint64.fromString("1000")) }),
  ]);

  it("getRating decodes the aggregate and calls get_rating(pool)", async () => {
    const seen: Transaction[] = [];
    const c = new RegistryClient(REG, serverReturning(rating, seen), PASS, reader);
    expect(await c.getRating(POOL)).toEqual({ score: 72, publishers: 2, timestamp: 1000n });
    const call = (seen[0].operations[0] as unknown as { func: xdr.HostFunction }).func.invokeContract();
    expect(call.functionName().toString()).toBe("get_rating");
  });

  it("getRating returns null for Option::None", async () => {
    const c = new RegistryClient(REG, serverReturning(xdr.ScVal.scvVoid()), PASS, reader);
    expect(await c.getRating(POOL)).toBeNull();
  });

  it("depositAllowed mirrors the guard's checks", async () => {
    const c = new RegistryClient(REG, serverReturning(rating), PASS, reader);
    expect((await c.depositAllowed(POOL, 60, 3600n, 2000n)).allowed).toBe(true);
    expect((await c.depositAllowed(POOL, 80, 3600n, 2000n)).reason).toMatch(/4115/);
    expect((await c.depositAllowed(POOL, 60, 500n, 2000n)).reason).toMatch(/4116/);
    expect((await c.depositAllowed(POOL, 60, 3600n, 999n)).reason).toMatch(/4116/); // future rating
  });

  it("publishOp orders args as publish(publisher, pool, score, timestamp, reasons_hash)", () => {
    const c = new RegistryClient(REG, serverReturning(rating), PASS, reader);
    const pub = Keypair.random().publicKey();
    const op = c.publishOp(pub, { pool: POOL, score: 81, timestamp: 1234n, reasonsHash: "ab".repeat(32) });
    const args = (op.body().value() as xdr.InvokeHostFunctionOp).hostFunction().invokeContract().args();
    expect(scValToNative(args[0])).toBe(pub);
    expect(scValToNative(args[1])).toBe(POOL);
    expect(args[2].u32()).toBe(81);
    expect(scValToNative(args[3])).toBe(1234n);
    expect(args[4].bytes().toString("hex")).toBe("ab".repeat(32));
    expect(() => c.publishOp(pub, { pool: POOL, score: 101, timestamp: 1n, reasonsHash: "ab".repeat(32) })).toThrow(/0..100/);
  });
});
