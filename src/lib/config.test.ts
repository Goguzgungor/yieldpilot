import { describe, it, expect } from "vitest";
import { parseConfig } from "./config";

const env = {
  RISK_TOLERANCE: "balanced",
  // Scan side (mainnet)
  SCAN_RPC_URL: "https://mainnet.sorobanrpc.com",
  SCAN_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
  SCAN_BLEND_POOL_IDS: "C_A,C_B",
  SCAN_USDC_CONTRACT_ID: "C_USDC_MAINNET",
  // Exec side (testnet)
  EXEC_RPC_URL: "https://soroban-testnet.stellar.org",
  EXEC_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  EXEC_POOL_ID: "C_EXEC_POOL",
  EXEC_USDC_CONTRACT_ID: "C_USDC_TESTNET",
  AGENT_SIGNER_SECRET: "S_SECRET", SMART_WALLET_ADDRESS: "C_WALLET",
  PER_TX_CAP_USDC: "2000", DAILY_CAP_USDC: "5000",
  MIN_YIELD_DELTA_BPS: "50", REBALANCE_COOLDOWN_SEC: "120", SCAN_INTERVAL_SEC: "30",
};

describe("parseConfig", () => {
  it("parses scan pool ids into an array and caps into stroop bigints", () => {
    const c = parseConfig(env);
    expect(c.scanBlendPoolIds).toEqual(["C_A", "C_B"]);
    expect(c.perTxCapStroops).toBe(2000_0000000n);
    expect(c.minYieldDeltaBps).toBe(50);
  });

  it("defaults the on-chain discovery contract ids (mainnet) when env omits them", () => {
    const c = parseConfig(env);
    expect(c.scanPoolFactoryId).toBe("CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU");
    expect(c.scanBackstopId).toBe("CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7");
  });

  it("defaults WALLET_MODE to smart-account and parses keypair override", () => {
    expect(parseConfig(env).walletMode).toBe("smart-account");
    expect(parseConfig({ ...env, WALLET_MODE: "keypair" }).walletMode).toBe("keypair");
    expect(() => parseConfig({ ...env, WALLET_MODE: "bogus" })).toThrow();
  });

  it("defaults the OZ verifier + spending-policy ids (proven testnet) when omitted", () => {
    const c = parseConfig(env);
    expect(c.ed25519VerifierId).toBe("CBHJOANTAHF2ZKU5HZRZTWP4GX7YCSNR3V3AIMAH5P5R7S465SK24RSO");
    expect(c.spendingPolicyId).toBe("CBLNG63CIFKLFY6ZTL32NWMGPN7NBDSXZUSCQNTLMYRTLIZYA7MG3KAP");
  });

  it("defaults EXEC pool + USDC ids to our deployed testnet pool when omitted", () => {
    const { EXEC_POOL_ID: _p, EXEC_USDC_CONTRACT_ID: _u, ...rest } = env;
    void _p;
    void _u;
    const c = parseConfig(rest);
    expect(c.execPoolId).toBe("CBI7WAUQ4NPQFZW4C3MDSVFAZJWV3RCLZSTTMA5OZ6BTPEQMOZZNSZ3Z");
    expect(c.execUsdcContractId).toBe("CD2R7WREEPGIAXZL4ASB76Y6PWTY6ZZXZ6C64AIKFDIG36YKQPNY6B2I");
  });

  it("separates scan (mainnet) and exec (testnet) config", () => {
    const c = parseConfig(env);
    expect(c.scanRpcUrl).toBe("https://mainnet.sorobanrpc.com");
    expect(c.scanUsdcContractId).toBe("C_USDC_MAINNET");
    expect(c.execRpcUrl).toBe("https://soroban-testnet.stellar.org");
    expect(c.execPoolId).toBe("C_EXEC_POOL");
    expect(c.execUsdcContractId).toBe("C_USDC_TESTNET");
  });

  it("throws when required keys are missing", () => {
    expect(() => parseConfig({})).toThrow();
  });

  it("defaults DeFindex strategies to an empty list when omitted", () => {
    const c = parseConfig(env);
    expect(c.scanDefindexStrategies).toEqual([]);
  });

  it("throws a clear error when SCAN_DEFINDEX_STRATEGIES is malformed JSON", () => {
    expect(() => parseConfig({ ...env, SCAN_DEFINDEX_STRATEGIES: "{not json" })).toThrow(/valid JSON/);
  });

  it("parses DeFindex strategies from JSON, defaulting asset/assetContractId and converting TVL", () => {
    const c = parseConfig({
      ...env,
      SCAN_DEFINDEX_STRATEGIES: JSON.stringify([
        { strategyId: "C_STRAT", blendPoolId: "C_A", name: "DeFindex USDC", fallbackTvlUsdc: 1000 },
      ]),
    });
    expect(c.scanDefindexStrategies).toEqual([
      { strategyId: "C_STRAT", blendPoolId: "C_A", name: "DeFindex USDC", asset: "USDC", assetContractId: "C_USDC_MAINNET", fallbackTvlUsdc: 1000_0000000n },
    ]);
  });

  it("keeps explicit asset + assetContractId for non-USDC DeFindex strategies", () => {
    const c = parseConfig({
      ...env,
      SCAN_DEFINDEX_STRATEGIES: JSON.stringify([
        { strategyId: "C_E", blendPoolId: "C_A", name: "DeFindex EURC", asset: "EURC", assetContractId: "C_EURC", fallbackTvlUsdc: 0 },
      ]),
    });
    expect(c.scanDefindexStrategies[0]).toMatchObject({ asset: "EURC", assetContractId: "C_EURC" });
  });
});
