import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { checkOwnerSignature, signOwnerMessage } from "./ownerAuth";
import { ownerMessage, signatureToBase64, type OwnerRequest } from "./ownerMessage";

const owner = Keypair.random();
const register = {
  action: "register",
  owner: owner.publicKey(),
  smartWallet: "CDNE56FVWAHIMNTAUOKM3TFJCY6YM4OWOFRPJYQXZB2WRIHT5CS77PBB",
  poolRuleId: 1,
  usdcRuleId: 2,
} satisfies OwnerRequest;
const unregister: OwnerRequest = { action: "unregister", owner: owner.publicKey() };
const at = "2026-11-02T20:00:00.000Z";
const now = Date.parse(at) + 30_000;

describe("ownerMessage", () => {
  it("spells out every field the signature covers", () => {
    expect(ownerMessage(register, at)).toBe(
      [
        "YieldPilot: register this smart account for the agent",
        `Owner: ${owner.publicKey()}`,
        `Smart account: ${register.smartWallet}`,
        "Agent rules: pool #1, USDC #2",
        `Signed at: ${at}`,
      ].join("\n"),
    );
    expect(ownerMessage(unregister, at)).toBe(
      ["YieldPilot: forget this wallet's registration", `Owner: ${owner.publicKey()}`, `Signed at: ${at}`].join("\n"),
    );
  });
});

describe("checkOwnerSignature", () => {
  it("accepts the owner's SEP-53 signature of the request", () => {
    const sig = signOwnerMessage(owner, ownerMessage(register, at));
    expect(checkOwnerSignature(register, at, sig, now)).toBeNull();
    expect(checkOwnerSignature(unregister, at, signOwnerMessage(owner, ownerMessage(unregister, at)), now)).toBeNull();
  });

  it("signs sha256('Stellar Signed Message:\\n' || message), as Freighter's signMessage does", () => {
    const message = ownerMessage(unregister, at);
    const digest = createHash("sha256").update(Buffer.concat([Buffer.from("Stellar Signed Message:\n"), Buffer.from(message)])).digest();
    const sig = owner.sign(digest).toString("base64");
    expect(signOwnerMessage(owner, message)).toBe(sig);
    expect(checkOwnerSignature(unregister, at, sig, now)).toBeNull();
  });

  it("rejects a signature by any other key", () => {
    const sig = signOwnerMessage(Keypair.random(), ownerMessage(unregister, at));
    expect(checkOwnerSignature(unregister, at, sig, now)).toMatch(/does not match the owner/);
  });

  it("rejects a signature over different fields", () => {
    const sig = signOwnerMessage(owner, ownerMessage(register, at));
    const other = { ...register, smartWallet: "CCATTACKER" };
    expect(checkOwnerSignature(other, at, sig, now)).toMatch(/does not match the owner/);
    // A register signature is not an unregister signature.
    expect(checkOwnerSignature(unregister, at, sig, now)).toMatch(/does not match the owner/);
  });

  it("rejects a signature older or further ahead than 5 minutes", () => {
    const sig = signOwnerMessage(owner, ownerMessage(unregister, at));
    expect(checkOwnerSignature(unregister, at, sig, Date.parse(at) + 5 * 60_000 + 1)).toMatch(/expired/);
    expect(checkOwnerSignature(unregister, at, sig, Date.parse(at) - 5 * 60_000 - 1)).toMatch(/expired/);
  });

  it("rejects missing or malformed inputs", () => {
    const sig = signOwnerMessage(owner, ownerMessage(unregister, at));
    expect(checkOwnerSignature(unregister, undefined, sig, now)).toMatch(/required/);
    expect(checkOwnerSignature(unregister, at, undefined, now)).toMatch(/required/);
    expect(checkOwnerSignature(unregister, "yesterday", sig, now)).toMatch(/signedAt/);
    expect(checkOwnerSignature(unregister, at, "c2hvcnQ=", now)).toMatch(/ed25519/);
    expect(checkOwnerSignature({ action: "unregister", owner: "GNOTAKEY" }, at, sig, now)).toMatch(/G-address/);
  });
});

describe("signatureToBase64", () => {
  const bytes = Uint8Array.from({ length: 64 }, (_, i) => i);
  const b64 = Buffer.from(bytes).toString("base64");

  it("passes Freighter's base64 string through and encodes its older Buffer forms", () => {
    expect(signatureToBase64(b64)).toBe(b64);
    expect(signatureToBase64(bytes)).toBe(b64);
    expect(signatureToBase64({ type: "Buffer", data: Array.from(bytes) })).toBe(b64);
  });

  it("returns null for anything else", () => {
    expect(signatureToBase64(null)).toBeNull();
    expect(signatureToBase64("")).toBeNull();
    expect(signatureToBase64({ data: "x" })).toBeNull();
  });
});
