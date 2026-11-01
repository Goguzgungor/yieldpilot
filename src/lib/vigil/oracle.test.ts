import { describe, expect, it } from "vitest";
import {
  REFLECTOR_DEPLOYER,
  attributeSources,
  classifyFeed,
  classifyPoolOracle,
  type AggregatorConfig,
  type ContractInfo,
} from "./oracle";
import { cid } from "./testkit";

const RDEX = "CALI2BYU2JE6WVRUFYTS6MSBNEHGJ35P4AVCZYF3B6QOE3QKOB2PLE6M";
const RCEX = "CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN";
const AGG_FNS = ["oracles", "asset_configs", "max_age", "base", "decimals", "assets", "lastprice", "add_asset"];

describe("classifyFeed", () => {
  it("recognises the two known Reflector mainnet feeds by id", () => {
    expect(classifyFeed({ id: RDEX, functions: null }).kind).toBe("reflector_dex");
    expect(classifyFeed({ id: RCEX, functions: null }).kind).toBe("reflector_cex");
  });

  it("classifies unknown Reflector-deployed feeds by base() and assets()", () => {
    const base = { id: cid("r1"), functions: ["lastprice"], creator: REFLECTOR_DEPLOYER };
    expect(classifyFeed({ ...base, base: { type: "Stellar", address: cid("usdc") } }).kind).toBe("reflector_dex");
    expect(classifyFeed({ ...base, base: { type: "Other", symbol: "USD" }, assets: [{ type: "Other", symbol: "BTC" }] }).kind).toBe("reflector_cex");
    expect(
      classifyFeed({
        ...base,
        base: { type: "Other", symbol: "USD" },
        assets: ["EUR", "GBP", "JPY", "BTC"].map((s) => ({ type: "Other" as const, symbol: s })),
      }).kind,
    ).toBe("reflector_fx");
  });

  it("classifies RedStone, PT-model, operator push and unknown contracts", () => {
    expect(classifyFeed({ id: cid("rs"), functions: ["lastprice"], verifiedRepo: "https://github.com/redstone-finance/redstone-public-contracts" }).kind).toBe("redstone");
    expect(classifyFeed({ id: cid("pt"), functions: ["lastprice", "get_pt", "get_maturity"] }).kind).toBe("protocol_model");
    expect(classifyFeed({ id: cid("push"), functions: ["lastprice", "set_price"], creator: "GDH3FR", admin: "GDH3FR" }).kind).toBe("issuer_push");
    expect(classifyFeed({ id: cid("x"), functions: ["lastprice", "decimals"] }).kind).toBe("opaque");
  });
});

describe("classifyPoolOracle", () => {
  it("separates verified aggregators, compatible forks, direct feeds and opaque adapters", () => {
    expect(classifyPoolOracle({ id: cid("a"), functions: AGG_FNS, verifiedRepo: "https://github.com/blend-capital/oracle-aggregator" })).toBe("blend_aggregator");
    expect(classifyPoolOracle({ id: cid("b"), functions: AGG_FNS })).toBe("aggregator_compatible");
    expect(classifyPoolOracle({ id: RCEX, functions: ["lastprice"] })).toBe("direct_feed");
    expect(classifyPoolOracle({ id: cid("c"), functions: ["lastprice", "add_asset", "upgrade"] })).toBe("opaque");
  });
});

describe("attributeSources (aggregator)", () => {
  const usdc = cid("USDC");
  const ustry = cid("USTRY");
  const xlm = cid("XLM");
  const pyusd = cid("PYUSD");
  const aqua = cid("AQUA");
  const unknown = cid("UNK");
  const agg: AggregatorConfig = {
    base: { type: "Stellar", address: usdc },
    maxAgeSec: 900,
    decimals: 7,
    oracles: [
      { address: RDEX, index: 0, resolutionSec: 300, decimals: 14 },
      { address: RCEX, index: 1, resolutionSec: 300, decimals: 14 },
    ],
    assetConfigs: [
      { asset: { type: "Stellar", address: ustry }, sourceAsset: { type: "Stellar", address: ustry }, oracleIndex: 0, maxDevPct: 10 },
      { asset: { type: "Stellar", address: xlm }, sourceAsset: { type: "Other", symbol: "XLM" }, oracleIndex: 1, maxDevPct: 20 },
      { asset: { type: "Stellar", address: aqua }, sourceAsset: { type: "Stellar", address: aqua }, oracleIndex: 0, maxDevPct: 0 },
    ],
    assets: [{ type: "Stellar", address: pyusd }, { type: "Stellar", address: ustry }, { type: "Stellar", address: xlm }, { type: "Stellar", address: aqua }],
  };
  const poolOracle: ContractInfo = { id: cid("agg"), functions: AGG_FNS };
  const ids = [usdc, ustry, xlm, pyusd, aqua, unknown];
  const all = Object.fromEntries(ids.map((i) => [i, true]));
  const out = attributeSources({ poolOracle, oracleKind: "blend_aggregator", aggregator: agg, feeds: {}, reserveAssetIds: ids, pricePresent: all });

  it("maps the base asset, DEX- and CEX-routed assets with max_dev / resolution", () => {
    expect(out[usdc].kind).toBe("base");
    expect(out[ustry]).toMatchObject({ kind: "reflector_dex", sourceOracleId: RDEX, maxDevPct: 10, resolutionSec: 300, maxAgeSec: 900 });
    expect(out[xlm]).toMatchObject({ kind: "reflector_cex", sourceOracleId: RCEX, maxDevPct: 20 });
    expect(out[aqua]).toMatchObject({ kind: "reflector_dex", maxDevPct: 0 });
  });

  it("treats assets listed in assets() without a config as fixed 1.0 pegs (e.g. PYUSD)", () => {
    expect(out[pyusd].kind).toBe("fixed_peg");
  });

  it("marks unconfigured assets and assets with no returned price as missing", () => {
    expect(out[unknown].kind).toBe("missing");
    const noPrice = attributeSources({
      poolOracle,
      oracleKind: "blend_aggregator",
      aggregator: agg,
      feeds: {},
      reserveAssetIds: [ustry, usdc],
      pricePresent: { [ustry]: false, [usdc]: false },
    });
    expect(noPrice[ustry].kind).toBe("missing");
    expect(noPrice[ustry].sourceOracleId).toBe(RDEX);
    expect(noPrice[usdc].kind).toBe("base"); // base is 1.0 by definition
  });
});

describe("attributeSources (direct / opaque)", () => {
  it("uses the pool oracle's own class for a direct feed", () => {
    const a = cid("SolvBTC");
    const out = attributeSources({
      poolOracle: { id: cid("rs"), functions: ["lastprice"], verifiedRepo: "redstone-finance/x", resolutionSec: 43200 },
      oracleKind: "direct_feed",
      feeds: {},
      reserveAssetIds: [a],
      pricePresent: { [a]: true },
    });
    expect(out[a]).toMatchObject({ kind: "redstone", viaAggregator: false, resolutionSec: 43200 });
  });

  it("infers an opaque adapter's source from an exact price match, else stays opaque", () => {
    const cetes = cid("CETES");
    const other = cid("OTHER");
    const out = attributeSources({
      poolOracle: { id: cid("orbit"), functions: ["lastprice", "add_asset"] },
      oracleKind: "opaque",
      feeds: { [RDEX]: { id: RDEX, functions: null } },
      reserveAssetIds: [cetes, other],
      pricePresent: { [cetes]: true, [other]: true },
      priceMatches: { [cetes]: RDEX },
    });
    expect(out[cetes]).toMatchObject({ kind: "reflector_dex", inferred: true, sourceOracleId: RDEX });
    expect(out[other].kind).toBe("opaque");
  });
});
