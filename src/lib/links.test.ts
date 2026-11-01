import { describe, it, expect } from "vitest";
import {
  blendPoolUrl,
  stellarExpertUrl,
  testnetContractUrl,
  testnetTxUrl,
  testnetAccountUrl,
  VARIAL_INSTALL_URL,
  REPO_URL,
  X_URL,
} from "../app/_components/links";

describe("link helpers", () => {
  // ── existing mainnet helpers ─────────────────────────────────────────────

  it("blendPoolUrl builds a mainnet Blend deep-link", () => {
    const url = blendPoolUrl("CPOOL123");
    expect(url).toBe("https://mainnet.blend.capital/dashboard?poolId=CPOOL123");
  });

  it("stellarExpertUrl builds a public-network contract URL", () => {
    const id = "CABI7WAUQ4NPQFZW4C3MDSVFAZJWV3RCLZSTTMA5OZ6BTPEQMOZZNSZ3Z";
    expect(stellarExpertUrl(id)).toBe(
      `https://stellar.expert/explorer/public/contract/${id}`,
    );
  });

  it("VARIAL_INSTALL_URL points at Varial (Freighter's new name)", () => {
    expect(VARIAL_INSTALL_URL).toBe("https://varialwallet.com/");
  });

  // ── new testnet helpers ──────────────────────────────────────────────────

  it("testnetContractUrl builds a testnet contract explorer URL", () => {
    const id = "CBI7WAUQ4NPQFZW4C3MDSVFAZJWV3RCLZSTTMA5OZ6BTPEQMOZZNSZ3Z";
    expect(testnetContractUrl(id)).toBe(
      `https://stellar.expert/explorer/testnet/contract/${id}`,
    );
  });

  it("testnetTxUrl builds a testnet transaction explorer URL", () => {
    const hash = "abc123def456";
    expect(testnetTxUrl(hash)).toBe(
      `https://stellar.expert/explorer/testnet/tx/${hash}`,
    );
  });

  it("testnetAccountUrl builds a testnet account explorer URL", () => {
    const addr = "GBXYZ1234AGENT";
    expect(testnetAccountUrl(addr)).toBe(
      `https://stellar.expert/explorer/testnet/account/${addr}`,
    );
  });

  it("testnet helpers use 'testnet' in the URL, not 'public'", () => {
    const id = "CSOME_ID";
    expect(testnetContractUrl(id)).toContain("/testnet/");
    expect(testnetTxUrl("hash")).toContain("/testnet/");
    expect(testnetAccountUrl("addr")).toContain("/testnet/");
  });

  it("testnet and mainnet contract helpers produce different URLs for the same id", () => {
    const id = "CSAME_ID";
    expect(testnetContractUrl(id)).not.toBe(stellarExpertUrl(id));
    expect(testnetContractUrl(id)).toContain("/testnet/");
    expect(stellarExpertUrl(id)).toContain("/public/");
  });

  it("testnetContractUrl URL-encodes special characters", () => {
    const id = "C/WEIRD?ID";
    const url = testnetContractUrl(id);
    expect(url).not.toContain("/WEIRD?ID");
    expect(url).toContain("C%2FWEIRD%3FID");
  });

  it("REPO_URL and X_URL point at the project's GitHub repo and X account", () => {
    expect(REPO_URL).toBe("https://github.com/Goguzgungor/yieldpilot");
    expect(X_URL).toBe("https://x.com/AsteriaStellar");
  });
});
