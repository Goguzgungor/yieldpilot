import { Account, Asset, Keypair, Operation, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  assetFromSacName,
  buildTrustlineTx,
  ensureFunded,
  hasTrustline,
  signPrepared,
  TESTNET_PASSPHRASE,
  xlmBalance,
  type FetchLike,
} from "../../scripts/loadtest/chain";

const kp = Keypair.random();
const unsignedXdr = () =>
  new TransactionBuilder(new Account(kp.publicKey(), "1"), { fee: "100", networkPassphrase: TESTNET_PASSPHRASE })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .setTimeout(30)
    .build()
    .toXDR();

describe("signing", () => {
  it("signPrepared adds the wallet's signature (the Freighter stand-in)", () => {
    const tx = TransactionBuilder.fromXDR(signPrepared(unsignedXdr(), kp), TESTNET_PASSPHRASE) as Transaction;
    expect(tx.signatures).toHaveLength(1);
    expect(kp.verify(tx.hash(), tx.signatures[0].signature())).toBe(true);
  });
  it("buildTrustlineTx is a signed changeTrust for the asset", () => {
    const asset = new Asset("USDC", Keypair.random().publicKey());
    const tx = TransactionBuilder.fromXDR(buildTrustlineTx(new Account(kp.publicKey(), "1"), kp, asset), TESTNET_PASSPHRASE) as Transaction;
    expect(tx.operations[0].type).toBe("changeTrust");
    expect(tx.signatures).toHaveLength(1);
  });
});

describe("assetFromSacName", () => {
  it("parses the SAC name() into a classic asset", () => {
    const issuer = Keypair.random().publicKey();
    const a = assetFromSacName(`USDC:${issuer}`);
    expect([a.getCode(), a.getIssuer()]).toEqual(["USDC", issuer]);
    expect(() => assetFromSacName("native")).toThrow(/unexpected SAC name/);
  });
});

describe("horizon helpers", () => {
  const issuer = Keypair.random().publicKey();
  const acc = {
    balances: [
      { asset_type: "native", balance: "9999.5" },
      { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: issuer, balance: "0" },
    ],
  };

  it("reads XLM and trustlines", () => {
    expect(xlmBalance(acc)).toBe(9999.5);
    expect(hasTrustline(acc, new Asset("USDC", issuer))).toBe(true);
    expect(hasTrustline(acc, new Asset("USDC", Keypair.random().publicKey()))).toBe(false);
  });

  it("ensureFunded calls friendbot only for a missing account", async () => {
    const urls: string[] = [];
    const fetchFn = (exists: boolean, friendbotStatus = 200): FetchLike => async (url) => {
      urls.push(url);
      return { status: url.includes("friendbot") ? friendbotStatus : exists ? 200 : 404, json: async () => acc };
    };
    expect(await ensureFunded(kp.publicKey(), fetchFn(true))).toBe("exists");
    expect(urls.some((u) => u.includes("friendbot"))).toBe(false);
    expect(await ensureFunded(kp.publicKey(), fetchFn(false))).toBe("funded");
    expect(urls.at(-1)).toContain(`friendbot.stellar.org/?addr=${kp.publicKey()}`);
    await expect(ensureFunded(kp.publicKey(), fetchFn(false, 500))).rejects.toThrow(/friendbot/);
  });
});
