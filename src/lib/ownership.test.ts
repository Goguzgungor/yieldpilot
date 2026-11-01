import { describe, it, expect } from "vitest";
import { Keypair, StrKey, scValToNative } from "@stellar/stellar-sdk";
import { classifyOwners } from "./ownership";
import { delegatedSignerScVal, externalSignerScVal } from "./smartAccount";

const VERIFIER = StrKey.encodeContract(Buffer.alloc(32, 1));
const demo = { verifier: VERIFIER, publicKeyHex: "22".repeat(32) };
const user = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3)).publicKey();
const other = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4)).publicKey();
const decoded = (...vs: ReturnType<typeof delegatedSignerScVal>[]) => vs.map((v) => scValToNative(v));

describe("classifyOwners", () => {
  it("user-only Delegated owner → user", () => {
    expect(classifyOwners(decoded(delegatedSignerScVal(user)), user, demo)).toBe("user");
  });
  it("user + demo owner → co-owned", () => {
    expect(classifyOwners(decoded(externalSignerScVal(demo), delegatedSignerScVal(user)), user, demo)).toBe("co-owned");
  });
  it("demo owner only → backend (legacy, not migrated)", () => {
    expect(classifyOwners(decoded(externalSignerScVal(demo)), user, demo)).toBe("backend");
  });
  it("someone else's Delegated owner → unknown", () => {
    expect(classifyOwners(decoded(delegatedSignerScVal(other)), user, demo)).toBe("unknown");
  });
});
