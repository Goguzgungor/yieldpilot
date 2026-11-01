# Vigil risk engine v2: methodology

Engine version `vigil-risk-v2.0.0`. Code: `src/lib/vigil/` (engine and tests), `scripts/vigil-ratings.ts` (live run), `scripts/vigil-backtest.ts` (backtest).

Vigil gives a pool-level risk rating to every Blend V2 pool on Stellar **mainnet**, and to DeFindex strategies built on those pools. It only reads data. Every contract read is a `simulateTransaction` of a view call. Nothing is signed or submitted.

**Score:** `0..100`, where **higher means safer**. Each rating also has a grade `A..E`, an `eligibleForDeposit` flag, a factor breakdown, human-readable reasons, and a `reasonsHash`. The hash is a sha256 of the canonical inputs and factors, meant to be published on-chain as `BytesN<32>`.

Every factual statement below is tagged with its source:

| Tag | Source |
|---|---|
| **[chain]** | A contract call on mainnet via Soroban RPC (`https://mainnet.sorobanrpc.com`) on 2026-11-01. |
| **[SE]** | Stellar Expert's public API, `https://api.stellar.expert/explorer/public/...`. |
| **[H]** | Horizon, `https://horizon.stellar.org`. |
| **[src]** | Contract source code at the given URL. |

---

## 1. Coverage: how pools are found

| Source | Result on 2026-11-01 | Used as |
|---|---|---|
| Backstop `reward_zone()` on `CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7` | `[]`, empty **[chain]** | Secondary source. Useless today. |
| RPC `getEvents` on the factory | Only covers the RPC retention window, about 7 days. 0 deploys found. | Secondary source |
| **Factory `deploy` event history, indexed by Stellar Expert:** `GET /contract/CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU/events?order=asc&limit=200&cursor=…` **[SE]** | **12** `deploy` events, from 2025-04-14 to 2026-08-26. Each event body is the pool's ScAddress. | **Primary** (authoritative) source |
| Curated `SCAN_BLEND_POOL_IDS` | 2 ids, both already in the list above | Fallback |
| Factory `is_pool(address)` **[chain]** | `true` for all 12 | **Verifier** for every candidate |

DefiLlama's Blend V2 adapter uses the same primary method, for the same reason. Its own comment says the reward zone "can be empty … so it alone is not a reliable enumeration source" (https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/blend-pools-v2/index.js) **[src]**.

Stellar Expert's metadata is consistent with this: it reports the factory with `events: 12` and `storage_entries: 13` **[SE]**. Our reading is that this is 12 per-pool records plus the instance; that split is an inference, not something Stellar Expert reports.

**Coverage limits:**

1. **Trusted indexer.** Stellar Expert is a third-party indexer. Any id it returns must still pass `is_pool` on-chain, so it cannot inject a non-factory contract. But a deploy it *missed* would also be missed by Vigil. If Stellar Expert is down, Vigil falls back to the RPC and curated sources, and the output sets `coverage.fallbackOnly = true`.
2. **V2 factory only.** Only the V2 factory is covered. Blend V1 pools and Blend-code forks deployed outside the factory are out of scope.
3. **12 pools found: all 12 deployed, all 12 rated.** Many of them hold no funds.

## 2. Inputs and their data sources

| Input | How it is read |
|---|---|
| Pool status, admin, oracle, backstop rate, reserves | Blend SDK `PoolV2.load` (ledger entries) **[chain]** |
| Reserve `c_factor`, `l_factor`, `max_util`, `supply_cap`, `enabled`; supply and liabilities | Same as above. Supply is `b_supply·b_rate` and liabilities are `d_supply·d_rate` (`Reserve.totalSupplyFloat/totalLiabilitiesFloat`). |
| Token symbol and classic asset | SAC `name()` (`CODE:ISSUER` or `native`) and `symbol()` **[chain]** |
| Price per reserve | Pool oracle `lastprice(Stellar(asset))` and `decimals()`, read one asset at a time so one bad asset cannot hide the others **[chain]** |
| Oracle contract type | WASM spec function list (`getContractWasmByContractId`) **[chain]**. Stellar Expert `creator`, `wasm`, and `validation.repository` **[SE]**. |
| Aggregator routing | `oracles()`, `asset_configs()` (decoded from the raw ScMap), `base()`, `assets()`, `max_age()` **[chain]** |
| Source feed identity | Known ids, plus `base()`, `assets()`, `resolution()`, `admin()` **[chain]** and the creator **[SE]** |
| Opaque adapters (no config getters) | Source is *inferred* when the adapter returns the same `(price, timestamp)` as a known Reflector feed, read back to back. Marked `inferred: true`. |
| Backstop state per pool | Backstop `pool_data(pool)` returns `tokens`, `shares`, `q4w_pct`, `blnd`, `usdc` **[chain]** |
| SDEX depth | Horizon `/order_book` for the asset against classic USDC (`GA5ZSEJY…`), up to 200 levels **[H]**. Fetched **only for collateral priced from SDEX feeds**. |
| DeFindex strategy | The strategy's instance storage `Config.pool` / `Config.asset`, plus `Reserves.total_b_tokens·b_rate` **[chain]** |

### Feed attribution (2026-11-01)

**Reflector feeds**

| Feed | Classification |
|---|---|
| `CALI2BYU2JE6WVRUFYTS6MSBNEHGJ35P4AVCZYF3B6QOE3QKOB2PLE6M` | **Reflector Stellar-DEX feed.** `base() = Stellar(USDC SAC CCW67…)`, its `assets()` are SAC addresses, and `resolution() = 300` **[chain]**. Its creator is `GDLMOS3L…`, the same as the CEX feed **[SE]**. BlockSec's post-mortem names this contract as the YieldBlox oracle (https://blocksec.com/blog/yieldblox-dao-incident-on-stellar-oracle-misconfiguration-enabled-a-10m-drain). |
| `CAFJZQWSED6YAWZU3GWRTOCNPPCGBN32L7QV43XX5LZLFTK6JLN34DLN` | **Reflector CEX/DEX feed.** `base() = Other(USD)`, and its `assets()` are `Other(BTC, ETH, …, XLM, USDC, EURC)` **[chain]**. The Reflector README uses it as its example address (https://github.com/reflector-network/reflector-contract) **[src]**. |

**Pool oracles**

| Pools | Pool oracle | What it does |
|---|---|---|
| Fixed / New Fixed | `CCVTVW…` | Blend aggregator, `blend-capital/oracle-aggregator@b97e0a8` **[SE]**. Routes XLM, USDC and EURC to the Reflector CEX feed, with `max_dev` of 60%, 20% and 20% **[chain]**. |
| YieldBlox `CCCCIQ…` | `CD74A3…` | `yieldblox/oracle-aggregator@2307a9b` **[SE]**. USDC is the base. USTRY, CETES and EURC go to Reflector DEX with `max_dev` 10%. XLM and AQUA go to Reflector DEX with `max_dev` 0. PYUSD and USDGLO are base-like assets, priced at a **fixed 1.0** **[chain]**. |
| Etherfuse `CDMAVJ…` / `CADR6Q…` | `CAVRP26…` | Aggregator-compatible but unverified. CETES, USTRY and TESOURO come from `CBWUSO…`, a push oracle whose `admin()` is `GDH3FR…`, the Etherfuse pool admin **[chain]**. XLM and USDC come from the Reflector CEX feed. |
| Etherfuse `CALRF5…` | `CCCG2Q…` | Its Etherfuse source `CCXUCI…` has `last_timestamp()` 1764017100 (2025-11-24). `lastprice` returns `None` for CETES, USTRY and TESOURO **[chain]**. |
| Orbit `CB4OFH…` / `CAE7QV…` | `CBRSGB…` / `CAD2MC…` | Opaque adapters. Their prices equal Reflector DEX's exactly, so the source is inferred as Reflector DEX. |
| Forex | `CDCFT5…` | Opaque. Its XLM price matches the Reflector CEX feed. USDx, EURx and GBPx revert with `Error(Contract, #2)` **[chain]**. |
| Solv | `CBMGLK…` | RedStone feed (`redstone-finance/redstone-public-contracts`, **[SE]**), `resolution() = 43200` **[chain]**. |
| Spectra | `CC4VF5…` | A PT pricing-model oracle (it exports `get_pt` and `get_maturity`) **[chain]**. |

## 3. What `max_dev` does and does not do

The earlier working assumption was that `max_dev` (about 10% per round) caps cumulative price movement. **It does not.** Both deployed aggregator versions compare **only the newest price with the price immediately before it**:

- `blend-capital/oracle-aggregator@b97e0a8` `src/price_data.rs` steps back one round and returns `None` if `|p_new − p_prev| > max_dev·p_prev`.
- `yieldblox/oracle-aggregator@2307a9b` `src/price_data.rs` calls `prices(asset, 4)` and compares records `[0]` and `[1]` **[src]**.

So `max_dev` blocks a one-round spike. A manipulated price that is **held for two consecutive rounds** passes, because the difference between them is 0. That is exactly how the YieldBlox exploit got past USTRY's `max_dev = 10`: the oracle "ingested" the poisoned trade at 00:15 and at 00:20 UTC, and `prices(…, 4)` returned "two flagged as SDEX-poisoned at $106.74 and two normal at $1.06" (https://rekt.news/yieldblox-rekt).

Vigil therefore models `roundsToHold = 2` when `0 < max_dev < 100`, and `1` otherwise. It does **not** model a geometric `(1+max_dev)^N` ramp.

## v2.1 changes (2026-11-01)

v2.0 gave every non-active pool the same 49 (D), which hid the differences that matter: once Blend's backstop was drained every pool fell into that cap. v2.1 makes the grade answer one question, "how safe is it to supply here?", and keeps Blend's pool state as a separate label.

| | v2.0 | v2.1 |
|---|---|---|
| Pool status | a 15% factor, plus HR1: status ≥ 2 ⇒ ≤ 49 (D), not eligible | not graded. HR1 only marks status ≥ 4 (Admin_Frozen, Frozen, Setup) as not eligible, because Blend refuses supply above 3 (`pool.rs` `require_action_allowed`). On_Ice pools accept deposits and are graded on their merits |
| Weights | status 0.15, source 0.15, freshness 0.10, manipulation 0.20, backstop 0.15, utilization 0.10, caps 0.10, concentration 0.05 | source 0.18, freshness 0.12, manipulation 0.23, backstop 0.18, utilization 0.12, caps 0.12, concentration 0.05 |
| Uninsured (backstop below Blend's threshold) | counted three times: backstop factor, status factor, HR1 cap | backstop factor, plus HR7: at most B |
| Weak collateral price source | factor only | HR6: at most B (SDEX assets with verified depth count as robust) |
| "At most B" | n/a | a soft ceiling: scores above 65 are compressed linearly into 65–79, so pools keep their order instead of all landing on 79 |

HR2 (missing collateral price, ≤ 49), HR3 (profitable SDEX manipulation, ≤ 34, E), HR4 (score < 50 ⇒ not eligible) and HR5 (unidentifiable source, ≤ 64) are unchanged and stay hard caps: they describe conditions where the number below the cap carries no useful information.

The sections below describe v2.0 where they mention the status factor or HR1; this table is authoritative where they differ.

## 4. Scoring

Each factor produces a sub-score from 0 to 100, where higher is safer:

`score = Σ weight_i · sub_i`

The score is rounded, then the hard rules (§5) cap it. `uncappedScore` is the score before the caps.

"Collateral" means a reserve that is `enabled` and has `c_factor ≥ 0.01`. The Forex pool's `c_factor = 1e-7` is therefore not counted as collateral.

### Factors and weights

| Factor | Weight | Formula | Why |
|---|---|---|---|
| `pool_status` | 0.15 | Status 0/1 → 100, 2 → 40, 3 → 30, 4 → 10, 5 and 6 → 0 | `require_action_allowed` disables borrowing when status > 1 and supplying when status > 3. The automatic on-ice/frozen states follow backstop stress (pool/src/pool/pool.rs, status.rs in https://github.com/blend-capital/blend-contracts-v2) **[src]**. |
| `oracle_source` | 0.15 | **Worst** quality across collateral. Base 100, Reflector CEX/FX 95, RedStone 85, fixed peg 60, Reflector DEX 60, other SDEX feed 50, PT model 50, issuer push 45, opaque 25, missing 0. Minus 10 for a market feed with `max_dev = 0`; minus 10 for an inferred source. | A pool is only as sound as its weakest collateral price. One mispriced collateral drained YieldBlox. |
| `oracle_freshness` | 0.10 | 0 if any collateral price is missing or stale. 50 if only a borrowed, non-collateral asset's price is. Otherwise 100. Stale means older than `max(3600 s, 2·resolution)`, capped at 24 h. | The 24 h cap is Blend's own limit (`load_price` panics when `timestamp + 24h < now`, pool.rs **[src]**). A stale price blocks liquidations. |
| `sdex_manipulation` | 0.20 | Worst ρ across SDEX-priced collateral: `sub = clamp(50 + 50·log10 ρ)`, so ρ = 0.1 → 0, ρ = 1 → 50, ρ ≥ 10 → 100. A truncated book with ρ < 1 → 50 (uncertain). A missing book → 50. Opaque-sourced collateral → 50. | The only failure mode that has actually drained a Blend pool (§6). |
| `backstop_coverage` | 0.15 | `effective = 5·usdc·(1−q4w)`, `coverage = effective / liabilities_USD`. `sub = clamp(coverage / 0.10)·100`. If liabilities are under $1k: 100 when a backstop exists, else 50. | The backstop is first-loss capital. The Comet LP is 80/20 BLND/USDC, so its spot value is 5×USDC ("LP token is 20% USDC, so 5x is the spot price", backstop/src/backstop/pool.rs **[src]**). |
| `utilization` | 0.10 | USD-weighted `borrowed / supplied`. 100 at ≤ 60%, 0 at ≥ 95%, linear in between. | Withdrawal liquidity, and how much of supply is exposed to bad debt. |
| `supply_caps` | 0.10 | Worst κ over *weakly priced* collateral. Weakly priced means not base, CEX, FX or RedStone, and not SDEX collateral that already scored ≥ 75 on depth. `κ = cap·price·c / borrowable_liquidity`; κ ≤ 0.1 → 100, κ ≥ 1 → 0, log-linear in between. Not applicable if liquidity is under $1k. | Caps bound how much borrow power a weakly priced collateral can create. |
| `collateral_concentration` | 0.05 | `clamp(200·(1 − HHI))` over the USD value of supplied collateral. Not applicable when nothing is borrowable. | Concentration of tail risk. Kept small to avoid double-counting the oracle factors. |

The weights are expert judgment, **not fitted**. There is only one historical loss event, and fitting to one point would be meaningless.

### The SDEX manipulation model

This model only runs for collateral whose source is `reflector_dex` or `sdex_other`.

**Inputs:**

| Symbol | Meaning |
|---|---|
| `P` | Oracle price |
| `c` | Collateral factor |
| `H` | Supply-cap headroom, in tokens |
| `L` | Liquidity borrowable from the *other* reserves: `Σ max(0, supply·max_util − borrowed)·price` |
| `l̄` | `l_factor`, weighted by that availability |
| `asks` | The SDEX ask levels |

**For each target multiplier** `M ∈ {1.1, 1.25, 1.5, 2, 3, 5, 10, 25, 100}`:

| Quantity | Formula |
|---|---|
| Leverage | `lev = M·c·l̄` (skip this M if `lev ≤ 1`) |
| Extractable value | `E = min(L, H·P·lev)` |
| Collateral cost | `E / lev` (collateral posted at its true value) |
| Manipulation cost | USDC needed to buy every ask priced `≤ P·M`, × `(1 + r·(roundsToHold−1))`, with `r = 0` |
| Cost per dollar extracted | `ρ = (collateral cost + manipulation cost) / E` |

Vigil reports the cheapest ρ. A ρ computed from a book that was fully observed outranks a lower ρ that is only a lower bound, because Horizon returned 200 levels and the book "ran out". **ρ < 1** means a profitable attack exists.

## 5. Hard rules

| Rule | Condition | Effect |
|---|---|---|
| **HR1** | Status ≥ 2 (on ice, frozen, or setup) | Not eligible. Score ≤ 49, so grade ≤ D. |
| **HR2** | Collateral price stale or missing | Not eligible. Score ≤ 49. |
| **HR3** | SDEX-priced collateral with ρ < 1, computed from a fully observed book | Not eligible. Score ≤ 34, so **grade E**. |
| **HR5** | Collateral whose price source cannot be identified (opaque, and no exact match) | Not eligible. Score ≤ 64. |
| **HR4** | Score < 50 | Not eligible |

Grade bands: A ≥ 80, B ≥ 65, C ≥ 50, D ≥ 35, E < 35.

**HR6 (added 2026-11-01).** If any collateral is priced by a source below the robust threshold (`sourceQuality` < 85: anything weaker than RedStone, Reflector CEX/FX or the base asset), the score is capped at 79: the pool can be B but not A. SDEX-priced collateral whose order book was deep enough to make manipulation unprofitable (manipulation sub-score ≥ 75) counts as robust, as it already does for supply caps. Without this rule a pool like YieldBlox (PYUSD at a fixed peg) or the Etherfuse pools (CETES/USTRY/TESOURO from the pool admin's own push oracle) would reach A as soon as the backstop came back, although oracle configuration is the failure mode Vigil exists to catch.

### What would raise a rating (`paths`)

Each rating carries `paths.B` and `paths.A`: the smallest set of protocol-side changes after which the engine itself would give 65+ / 80+ (`src/lib/vigil/whatif.ts`). The levers are applied to the snapshot and re-scored with `ratePool`, so the answer always follows the current rules:

| Lever | Change simulated |
|---|---|
| `backstop` | backstop above Blend's threshold, covering 10% of borrows, under 30% queued; On_Ice / Frozen pools become Active, as Blend's `update_status` would do |
| `activate` | the admin sets Admin_On_Ice / Admin_Frozen / Setup pools Active (only together with `backstop` when the threshold is not met, as Blend requires) |
| `oracle` | the weak collateral sources above become a CEX/FX feed behind a max_dev limit |
| `caps` | supply caps so a weakly-priced collateral's borrow power is ≤ 10% of available liquidity |
| `fresh` | stale prices republished |

Utilization and collateral mix are market conditions, not levers. A missing price cannot be simulated, so pools with one report the target as out of reach. Paths are informational and not part of `reasonsHash`.

### DeFindex

A strategy's rating is its underlying pool's rating (worst-of). The pool is taken from the strategy's **on-chain** `Config.pool` where it can be read, and any difference from the config is reported.

If the strategy's asset is not an enabled reserve of that pool, the strategy is not eligible (HR-D2). A vault is rated worst-of its strategies.

DeFindex's own contract, keeper and upgrade risk is **not modelled**, and every DeFindex rating says so.

### reasonsHash

`reasonsHash = sha256(canonicalJson({engineVersion, inputs, factors, hardRules, score, uncappedScore, grade, eligibleForDeposit}))`

- **`inputs`:** status, oracle, `asOf` (chain time and ledger), backstop, the per-reserve configuration, amounts, prices, source kind and `max_dev`, a sha256 of each SDEX ask book, and the data gaps.
- **Canonical JSON:** keys sorted, no whitespace, non-integers rounded to 6 decimal places, bigint written as a string.
- **`computedAt` is excluded.** The same snapshot always gives the same hash.

## 6. History behind the rules

| Event | What happened | Sources |
|---|---|---|
| **YieldBlox pool `CCCCIQ…`, 22 Feb 2026** | About $10.2M to $10.97M was drained. USTRY was pushed on SDEX from about $1.06 to $106.74, used as collateral, and the attacker borrowed 1,000,196 USDC and 61,249,278 XLM. | BlockSec (above), https://rekt.news/yieldblox-rekt, and the DefiLlama `hacks` entry for blend-pools-v2 (amount 10,970,000, date 1771718400) |
| **Comet BLND-USDC pool**, the one feeding the backstop | A separate exploit of about $717K. DefiLlama lists it as CometDEX, "Incorrect Share Accounting", date 1787616000 (2026-08-25). | DefiLlama hacks dataset |
| **Comet LP today** | Holds 387.76 BLND and 0.64 USDC against a total supply of about 1.86e20 LP tokens (raw `get_total_supply` = 1.86e27 stroops) **[chain]**. As a result, `pool_data(..)` returns `blnd = 0` and `usdc = 0` for **every** pool **[chain]**: the backstop insurance is worth about $0 today. | **[chain]** |

## 7. Live results (mainnet, computedAt 2026-11-01T15:06:59Z, 83 s run)

```
coverage: 12 pools found [stellar-expert:factory-deploy-events=12, rpc:backstop-reward-zone+recent-deploy-events=0, curated=2], rated 12, failed 0, unverified 0, rejected 0
protocol | name                   | id      | status         | scr | unc | G | elg |       TVL | weakest factor
blend    | Fixed                  | CAJJZS… | 3 On_Ice       |  49 |  73 | D | no  |  $169.56M | backstop_coverage=0
blend    | YieldBlox              | CCCCIQ… | 3 On_Ice       |  49 |  56 | D | no  |   $158.4K | backstop_coverage=0
blend    | Etherfuse              | CDMAVJ… | 4 Admin_Frozen |  49 |  53 | D | no  |    $15.1K | backstop_coverage=0
blend    | Forex                  | CBYOBT… | 5 Frozen       |  49 |  73 | D | no  |      $459 | pool_status=0
blend    | Solv                   | CC4HHX… | 3 On_Ice       |  49 |  80 | D | no  |      $174 | pool_status=30
blend    | Spectra PTs            | CDZVHC… | 2 Admin_On_Ice |  49 |  76 | D | no  |       $10 | pool_status=40
blend    | YieldBlox              | CBNR7P… | 6 Setup        |  49 |  70 | D | no  |        $0 | pool_status=0
blend    | Orbit                  | CB4OFH… | 6 Setup        |  49 |  70 | D | no  |        $0 | pool_status=0
blend    | Etherfuse              | CALRF5… | 6 Setup        |  49 |  53 | D | no  |        $0 | pool_status=0
blend    | Etherfuse              | CADR6Q… | 6 Setup        |  49 |  69 | D | no  |        $0 | pool_status=0
blend    | New Fixed              | CAIYBZ… | 6 Setup        |  49 |  77 | D | no  |        $0 | pool_status=0
blend    | Orbit                  | CAE7QV… | 4 Admin_Frozen |  34 |  38 | E | no  |   $190.8K | sdex_manipulation=0
defindex | DeFindex USDC Fixed    | CDB2WM… | 3 On_Ice       |  49 |  73 | D | no  |   $18.80M | underlying_pool=49
defindex | DeFindex EURC Fixed    | CC5CE6… | 3 On_Ice       |  49 |  73 | D | no  |    $19.1K | underlying_pool=49
defindex | DeFindex XLM Fixed     | CDPWNU… | 3 On_Ice       |  49 |  73 | D | no  |     $7.1K | underlying_pool=49
defindex | DeFindex USDC Etherfus | CCBTSH… | 4 Admin_Frozen |  49 |  53 | D | no  |        $7 | underlying_pool=49
```

**Reading the table:**

- **No pool is eligible today.** Every Blend V2 pool has status ≥ 2 **[chain]**, so HR1 caps all of them. This is the real state of the chain, not an engine artefact.
- **Fixed** would score 73 without the cap. Its weakest factor is the zero backstop: $0 against $39.6M of liabilities.
- **Orbit `CAE7QV…` is the one HR3 hit.** CETES (c = 0.85) is priced through an adapter that returns Reflector-DEX prices exactly. Pumping CETES ×100 on SDEX would cost about $275 and would let an attacker borrow about $180K of oUSD (ρ ≈ 0.013).
  - Today the pool is Admin_Frozen, so borrowing is disabled. The risk is in the *configuration*: if the pool were reactivated as it stands, it would be exploitable.

## 8. Backtest: YieldBlox before 22 Feb 2026

**This run is a RECONSTRUCTION**, not a historical read. RPC cannot read past ledger state, and Horizon keeps no order-book history. How each input was rebuilt (full detail in `src/lib/vigil/backtest.ts`):

| Input | Reconstructed from |
|---|---|
| Status 1 (Active) | Pool `set_status` events **[SE]**. The status was 1 from 2025-04-17 and changed to 3 at 2026-02-22T01:35Z. |
| Reserve configs | `queue_set_reserve` / `set_reserve` events **[SE]**. USTRY: c 0.9, cap 250,000. CETES: c 0.8, cap 20M. EURC: c 0.9. PYUSD: c 0.9, cap 5M. XLM: c 0.75. |
| Supply and borrows | A replay of all **53,537** pool events up to 2026-02-21T23:58:52Z **[SE]**. The result is consistent with the exploit: the reconstruction gives about 1.10M USDC and 72.9M XLM borrowable, and the attacker took 1.0M USDC and 61.2M XLM. |
| Oracle routing | Today's `asset_configs()` on `CD74A3…`. This is valid for the past because a pool's oracle "CANNOT be changed after a pool is created" (https://docs.blend.capital/pool-creators/selecting-an-oracle), the aggregator has emitted 0 events **[SE]**, and its configs can only be added, never edited (oracle-aggregator README **[src]**). |
| Prices | Horizon `trade_aggregations` daily closes for 2026-02-21 **[H]**: XLM 0.16115, EURC 1.1765, CETES 0.0670, USTRY 1.0574, AQUA 0.000349. USDC is the base; PYUSD and USDGLO are pegged at 1.0. |
| Backstop | A replay of 5,727 backstop events for this pool: 4,385,291 LP tokens, q4w 0.52% **[SE]**. LP value ≈ $0.35 from the 2026-02-21 interest-auction fills (USDC lot ÷ LP bid), which is an upper-bound estimate. |
| USTRY ask book | "Fewer than five tokens" on the ask side, and hourly volume under $1 (rekt.news). Modelled as 4.9 USTRY at $1.06. Horizon daily USTRY/USDC volume for 2026-02-01 to 02-21 was $5 to $680 per day, except one day at $10.4K **[H]**. |
| XLM, CETES, EURC books | **Unavailable.** Left as data gaps, which means those three assets score 50 ("uncertain"). |

**Result** (`npx tsx scripts/vigil-backtest.ts`):

```
score 34 (uncapped 62) grade E eligible=false status=1 Active TVL $27.41M
pool_status 100 | oracle_source 50 (XLM ← reflector_dex, max_dev=0) | oracle_freshness 100
sdex_manipulation 0  USTRY: pump ×100 costs $5.19 on SDEX + $190.0K collateral to borrow $13.14M (rho=0.0145; hold 2 rounds ≈600s, max_dev=10%)
backstop_coverage 100 ($1.53M covers 18.8% of $8.10M) | utilization 100 (29.6%) | supply_caps 0 (XLM uncapped, no depth data) | concentration 91.8
hard rules: HR3 SDEX-manipulable collateral (USTRY) ⇒ not eligible, grade E
actually extracted: $10.87M
```

- **Grade E, with no deposits allowed.** The engine would have refused deposits into the pool. Its uncapped score was **62 (C)**: without the SDEX rule, the pool looked fine on status, backstop and utilization.
- **The model's numbers line up with the exploit.** It found $13.1M extractable with $190K of collateral, against roughly $11M actually taken with about $160K of USTRY collateral (rekt.news).
- **The flag holds across a wide range of book depths.** The flag stays on (ρ < 1) until the USTRY ask book below $1.06 is about **$10M deep**, and clears at about $26M. The real book held about $5.
- **The rule keys on the price source, not on thin markets.** Re-pointing USTRY to a CEX feed, with the book unchanged, removes HR3 (see the unit test in `backtest.test.ts`).

## 9. Known limitations and assumptions

1. **SDEX book coverage is partial.** Vigil reads only the Horizon USDC-quoted book: at most 200 levels, no AMM pools, and no XLM-quoted paths. Ignoring other venues *lowers* the estimated manipulation cost, so the model errs toward flagging. A truncated book makes the cost a lower bound, and that case never fires HR3.
2. **Attacker-friendly simplifications in the manipulation model:**
   - Order books are not replenished (r = 0).
   - Fees and slippage are ignored.
   - Swept tokens are not recycled as collateral.
   - USDC is treated as worth $1.
3. **Opaque adapters (Orbit, Forex).** Their sources are attributed by exact price match only, marked `inferred`, and penalised. An adapter that proxies one feed for some assets and a different source for others would be partly misread.
4. **Prices come from the pool's own oracle.** TVL and liquidity are valued with the pool oracle's prices. A manipulated oracle therefore also inflates TVL.
5. **Backstop value is approximate.** It uses Comet spot (5×USDC) and ignores price impact when the backstop is drawn.
6. **Source-quality scores are judgment calls.** In particular, issuer push 45 and fixed peg 60. The CETES, USTRY and TESOURO push oracle used by the Etherfuse pools is operated by the pool admin's own key (`admin()` = `GDH3FR…` **[chain]**).
7. **Status dominates today.** Every pool is status ≥ 2, so every grade is D or E. `uncappedScore` is reported so pools can still be compared.
8. **The backtest is a reconstruction.** USTRY's book comes from a post-mortem, not from chain data. The LP price is an estimate from auction fills. Prices are daily closes, not the oracle's own values at 00:20Z.
9. **No contract-level risk.** The engine does not model upgradeability or admin key risk of pools, oracles or DeFindex. These are noted only through the oracle class.
