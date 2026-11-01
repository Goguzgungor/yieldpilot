import { describe, it, expect } from "vitest";
import { Address, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import {
  gAddressToRawHex,
  usdcToStroops,
  stroopsToUsdcStr,
  buildDeployOp,
  buildAgentRuleOpsXdr,
  buildFundUsdcOp,
  opFromXdr,
  EXEC_USDC_CONTRACT_ID,
  EXEC_POOL_ID,
  SPENDING_POLICY_ID,
  VIGIL_GUARD_ID,
  ED25519_VERIFIER_ID,
  STROOPS_PER_USDC,
} from "./onboarding";

describe("gAddressToRawHex", () => {
  it("derives the 32-byte raw ed25519 hex matching Keypair.rawPublicKey()", () => {
    const kp = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
    const hex = gAddressToRawHex(kp.publicKey());
    expect(hex).toBe(kp.rawPublicKey().toString("hex"));
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    // and matches a direct StrKey decode
    expect(hex).toBe(Buffer.from(StrKey.decodeEd25519PublicKey(kp.publicKey())).toString("hex"));
  });

  it("is robust to surrounding whitespace", () => {
    const kp = Keypair.random();
    expect(gAddressToRawHex(`  ${kp.publicKey()}\n`)).toBe(kp.rawPublicKey().toString("hex"));
  });

  it("throws on a contract (C…) address", () => {
    const c = StrKey.encodeContract(Buffer.alloc(32, 5));
    expect(() => gAddressToRawHex(c)).toThrow(/valid Stellar G-address/);
  });

  it("throws on garbage input", () => {
    expect(() => gAddressToRawHex("not-an-address")).toThrow(/valid Stellar G-address/);
    expect(() => gAddressToRawHex("")).toThrow(/valid Stellar G-address/);
  });
});

describe("usdcToStroops / stroopsToUsdcStr", () => {
  it("converts whole USDC to stroops (7 decimals)", () => {
    expect(usdcToStroops(1)).toBe(STROOPS_PER_USDC);
    expect(usdcToStroops(500)).toBe(5_000_000_000n);
    expect(usdcToStroops(0.5)).toBe(5_000_000n);
    expect(usdcToStroops(1.2345678)).toBe(12_345_678n);
  });

  it("rejects non-positive / non-finite amounts", () => {
    expect(() => usdcToStroops(0)).toThrow(/invalid USDC amount/);
    expect(() => usdcToStroops(-5)).toThrow(/invalid USDC amount/);
    expect(() => usdcToStroops(NaN)).toThrow(/invalid USDC amount/);
  });

  it("round-trips through stroopsToUsdcStr", () => {
    expect(stroopsToUsdcStr(usdcToStroops(500))).toBe("500");
    expect(stroopsToUsdcStr(usdcToStroops(1.5))).toBe("1.5");
    expect(stroopsToUsdcStr(12_345_678n)).toBe("1.2345678");
    expect(stroopsToUsdcStr(0n)).toBe("0");
  });
});

/** Decode an invokeHostFunction contract-call op into { contract, fn, args }. */
function decodeInvoke(op: xdr.Operation): { contract: string; fn: string; args: xdr.ScVal[] } {
  const host = (op.body().value() as xdr.InvokeHostFunctionOp).hostFunction();
  const invoke = host.invokeContract();
  return {
    contract: Address.fromScAddress(invoke.contractAddress()).toString(),
    fn: invoke.functionName().toString(),
    args: invoke.args(),
  };
}

describe("buildDeployOp", () => {
  it("returns base64 op XDR + a deterministic contract id (stable for a fixed salt)", () => {
    const deployer = Keypair.random().publicKey();
    const ownerHex = "22".repeat(32);
    const saltHex = "ab".repeat(32);
    const a = buildDeployOp({ deployer, ownerPublicKeyHex: ownerHex, saltHex });
    const b = buildDeployOp({ deployer, ownerPublicKeyHex: ownerHex, saltHex });
    expect(a.contractId).toBe(b.contractId);
    expect(a.saltHex).toBe(saltHex);
    expect(StrKey.isValidContract(a.contractId)).toBe(true);
    // round-trips back into a real op
    expect(opFromXdr(a.opXdr)).toBeInstanceOf(xdr.Operation);
  });
});

describe("buildDeployOp ownership", () => {
  it("defaults the Default-rule owner to Delegated(deployer) — the user owns the wallet", () => {
    const deployer = Keypair.random().publicKey();
    const { opXdr } = buildDeployOp({ deployer, saltHex: "cd".repeat(32) });
    const owner = (opFromXdr(opXdr).body().value() as xdr.InvokeHostFunctionOp)
      .hostFunction()
      .createContractV2()
      .constructorArgs()[0]
      .vec()![0]
      .vec()!;
    expect(owner[0].sym().toString()).toBe("Delegated");
    expect(Address.fromScAddress(owner[1].address()).toString()).toBe(deployer);
  });
});

describe("buildAgentRuleOpsXdr", () => {
  it("emits two add_context_rule ops scoped to POOL and USDC", () => {
    const smartWallet = StrKey.encodeContract(Buffer.alloc(32, 9));
    const agentHex = "11".repeat(32);
    const { poolRuleOpXdr, usdcRuleOpXdr } = buildAgentRuleOpsXdr({ smartWallet, agentPublicKeyHex: agentHex });

    const pool = decodeInvoke(opFromXdr(poolRuleOpXdr));
    expect(pool.contract).toBe(smartWallet);
    expect(pool.fn).toBe("add_context_rule");
    // arg0 = CallContract(POOL)
    expect(Address.fromScAddress(pool.args[0].vec()![1].address()).toString()).toBe(EXEC_POOL_ID);
    // signer arg embeds the verifier + agent key
    const signer = pool.args[3].vec()![0].vec()!;
    expect(signer[0].sym().toString()).toBe("External");
    expect(Address.fromScAddress(signer[1].address()).toString()).toBe(ED25519_VERIFIER_ID);
    expect(signer[2].bytes().toString("hex")).toBe(agentHex);

    const usdc = decodeInvoke(opFromXdr(usdcRuleOpXdr));
    expect(Address.fromScAddress(usdc.args[0].vec()![1].address()).toString()).toBe(EXEC_USDC_CONTRACT_ID);
    // Both rules carry the Vigil guard; the USDC rule also carries the cap.
    const policyIds = (v: xdr.ScVal) => v.map()!.map((e) => Address.fromScAddress(e.key().address()).toString());
    expect(policyIds(pool.args[4])).toEqual([VIGIL_GUARD_ID]);
    expect(policyIds(usdc.args[4]).sort()).toEqual([SPENDING_POLICY_ID, VIGIL_GUARD_ID].sort());
  });
});

describe("buildFundUsdcOp", () => {
  it("builds a USDC transfer(from, smartWallet, amount) op", () => {
    const from = Keypair.random().publicKey();
    const smartWallet = StrKey.encodeContract(Buffer.alloc(32, 9));
    const opXdr = buildFundUsdcOp({ from, smartWallet, amountStroops: 5_000_000_000n });
    const inv = decodeInvoke(opFromXdr(opXdr));
    expect(inv.contract).toBe(EXEC_USDC_CONTRACT_ID);
    expect(inv.fn).toBe("transfer");
    expect(Address.fromScAddress(inv.args[0].address()).toString()).toBe(from);
    expect(Address.fromScAddress(inv.args[1].address()).toString()).toBe(smartWallet);
    // amount i128 = 5000 USDC
    expect(inv.args[2].i128().lo().toString()).toBe("5000000000");
  });
});
