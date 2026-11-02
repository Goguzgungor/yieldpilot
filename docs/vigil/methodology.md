# Vigil risk engine: methodology

Engine version **`vigil-risk-v2.5.0`** (2026-11-02). Code: `src/lib/vigil/` (engine and tests), `scripts/vigil-ratings.ts` (live run), `scripts/vigil-backtest.ts` (backtest). What changed between versions, and why, is in §10.

**v2.5 is frozen for the SCF review round.** Six versions shipped in two days, each after an internal review of the previous one's live output (reviewers running the SCF review skills against the live site and the chain). v2.3 was announced as frozen and that was broken twice, both times for HR10 (§5): v2.4 added it after a review found that the only pool passing the gate could not pay its lenders back, and v2.5 gave it a 6 h window the same day, after it flipped between two runs. From here the methodology changes only through the external review in deliverable 1.2, and any change is published with the reviewer's notes and a new version number. The engine version is part of every `reasonsHash`, and every publishing run (every 30 minutes) is archived with everything it was computed from, order books included, so anyone can recompute each hash (§5, reasonsHash).

Vigil gives a pool-level risk rating to every Blend pool on Stellar **mainnet**, from both Blend deployments that run the V2 pool code (V2, and v2.1 since 2026-09-30), and to DeFindex strategies built on those pools. It only reads data. Every contract read is a `simulateTransaction` of a view call. Nothing is signed or submitted.

**Score:** `0..100`, where **higher means safer**. Each rating also has a grade `A..E`, or **NR** (not rated) for a pool that never launched or holds under $10K. It also has an `eligibleForDeposit` flag, a factor breakdown, human-readable reasons, and a `reasonsHash`. The hash is a sha256 of the canonical inputs and factors, meant to be published on-chain as `BytesN<32>`.

**The grade answers one question: how safe is it to supply here?** Blend's own pool status is reported next to the grade, not inside it. It decides whether deposits are possible at all (HR1).

Every factual statement below is tagged with its source:

| Tag | Source |
|---|---|
| **[chain]** | A contract call on mainnet via Soroban RPC (`https://mainnet.sorobanrpc.com`) on 2026-11-01. |
| **[SE]** | Stellar Expert's public API, `https://api.stellar.expert/explorer/public/...`. |
| **[H]** | Horizon, `https://horizon.stellar.org`. |
| **[src]** | Contract source code at the given URL. |

---

## 1. Coverage: how pools are found

Blend runs two deployments of the V2 pool code on mainnet. Each has its own pool factory and its own backstop:

| Deployment | Pool factory | Backstop | Since |
|---|---|---|---|
| **V2** | `CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU` | `CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7` | 2025-04 |
| **v2.1** | `CACUXRNBUFV7BFPKUDLVJFQI6H7EHHNSJPOFJSCWJCYUUYMORM6C63AL`, the backstop's `PoolFact` instance entry **[chain]** | `CCS4AZ5ORM6VLLPJTJUFRNXWBMHOO3L5WHHRPL2ZMILE35ZDMQFHOQMJ`, whose LP token is a new BLND–USDC pool built from Comet v1.1.0 | 2026-09-30 |

blend-ui PR #238 (merged 2026-10-04) added v2.1 to Blend's app: "the audited v2 contracts with its own backstop", with backstop deposits reopened "for V2.1 pools only. V1 and V2 stay closed" **[src]**.

Every source below is read for **each** deployment:

| Source | Result on 2026-11-01 | Used as |
|---|---|---|
| **Factory `deploy` event history, indexed by Stellar Expert:** `GET /contract/{factory}/events?order=asc&limit=200&cursor=…` **[SE]** | V2: **12** `deploy` events, 2025-04-14 to 2026-08-26. v2.1: **1**, on 2026-09-30 (`CBAKAZ…`). Each event body is the pool's ScAddress. | **Primary** (authoritative) source |
| Backstop `reward_zone()` | V2: `[]`, empty. v2.1: `[CBAKAZ…]` **[chain]** | Secondary source |
| RPC `getEvents` on the factory | Only covers the RPC retention window, about 7 days. | Secondary source |
| Curated `SCAN_BLEND_POOL_IDS` | 2 ids, both already found above | Fallback |
| Factory `is_pool(address)` **[chain]** | `true` for all 13, each on its own deployment's factory | **Verifier** for every candidate (a pool passes if any deployment's factory deployed it) |

Each pool's backstop is read from the pool's **own config** (`PoolV2` metadata `backstop`), so V2 and v2.1 pools are each measured against their own backstop, and every rating carries a `deployment` label.

DefiLlama's Blend V2 adapter uses the same primary method, for the same reason. Its own comment says the reward zone "can be empty … so it alone is not a reliable enumeration source" (https://github.com/DefiLlama/DefiLlama-Adapters/blob/main/projects/blend-pools-v2/index.js) **[src]**.

Stellar Expert's metadata is consistent with this: it reports the factory with `events: 12` and `storage_entries: 13` **[SE]**. Our reading is that this is 12 per-pool records plus the instance; that split is an inference, not something Stellar Expert reports.

**Coverage limits:**

1. **Trusted indexer.** Stellar Expert is a third-party indexer. Any id it returns must still pass `is_pool` on-chain, so it cannot inject a non-factory contract. But a deploy it *missed* would also be missed by Vigil. If Stellar Expert is down, Vigil falls back to the RPC and curated sources, and the output sets `coverage.fallbackOnly = true`.
2. **V2 and v2.1 factories only.** Blend V1 pools and Blend-code forks deployed outside these two factories are out of scope. A new Blend deployment has to be added to the configuration (`SCAN_POOL_FACTORY_V2_1_ID` / `SCAN_BACKSTOP_V2_1_ID` show the pattern). Until v2.2 Vigil covered only V2 and missed the v2.1 pool; an external review found it on 2026-11-01.
3. **13 pools found, all 13 read: 5 graded and 8 not rated.** The 8 never launched or hold under $10K.

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
| Backstop state per pool | `pool_data(pool)` on **the backstop named in the pool's config** returns `tokens`, `shares`, `q4w_pct`, `blnd`, `usdc` **[chain]** |
| SDEX depth | Horizon `/order_book` for the asset against classic USDC (`GA5ZSEJY…`), up to 200 levels **[H]**. Fetched **only for collateral priced from SDEX feeds**. Since v2.3 each read is also stored (at most one per asset per 50 minutes), and the books of the last 24 h are rated together with the current one (§4). |
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
| Fixed / New Fixed / Fixed v2.1 `CBAKAZ…` | `CCVTVW…` | Blend aggregator, `blend-capital/oracle-aggregator@b97e0a8` **[SE]**. Routes XLM, USDC and EURC to the Reflector CEX feed, with `max_dev` of 60%, 20% and 20% **[chain]**. |
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

## 4. Scoring

Each factor produces a sub-score from 0 to 100, where higher is safer:

`score = Σ weight_i · sub_i`

The score is rounded, then the hard rules (§5) cap it. `uncappedScore` is the score before the caps. A pool that is not rated (NR) has neither: its factors are still shown for reference.

"Collateral" means a reserve that is `enabled` and has `c_factor ≥ 0.01`. The Forex pool's `c_factor = 1e-7` is therefore not counted as collateral.

### Factors and weights

| Factor | Weight | Formula | Why |
|---|---|---|---|
| `oracle_source` | 0.18 | **Worst** quality across collateral. Base 100, Reflector CEX/FX 95, RedStone 85, fixed peg 60, Reflector DEX 60, other SDEX feed 50, PT model 50, issuer push 45, opaque 25, missing 0. Minus 10 for a market feed with `max_dev = 0`; minus 10 for an inferred source. | A pool is only as sound as its weakest collateral price. One mispriced collateral drained YieldBlox. |
| `oracle_freshness` | 0.12 | 0 if the price of any collateral, or of any asset with outstanding borrows, is missing or stale; otherwise 100. Stale means older than `max(3600 s, 2·resolution)`, capped at 24 h. | The 24 h cap is Blend's own limit (`load_price` panics when `timestamp + 24h < now`, pool.rs **[src]**). A stale price blocks liquidations, and an unpriced debt counts as $0 in every USD total. |
| `sdex_manipulation` | 0.23 | Worst ρ across SDEX-priced collateral, each on the **thinnest of its books from the last 24 h**: `sub = clamp(50 + 50·log10 ρ)`, so ρ = 0.1 → 0, ρ = 1 → 50, ρ ≥ 10 → 100. A truncated book with ρ < 1 → 50 (uncertain). No book at all → 50. Opaque-sourced collateral → 50. | The only failure mode that has actually drained a Blend pool (§6). An attacker picks the moment the book is thin, so one read at a random time overstates the cost. |
| `backstop_coverage` | 0.18 | `effective = 5·usdc·(1−q4w)`, `coverage = effective / liabilities_USD`. `sub = clamp(coverage / 0.10)·100`. If liabilities are under $1k: 100 when a backstop exists, else 50. | The backstop is first-loss capital. The Comet LP is 80/20 BLND/USDC, so its spot value is 5×USDC ("LP token is 20% USDC, so 5x is the spot price", backstop/src/backstop/pool.rs **[src]**). |
| `utilization` | 0.12 | `borrowed / supplied` of the **most-borrowed reserve** with at least $1K supplied (the pool-wide figure is shown for reference). 100 at ≤ 60%, 0 at ≥ 95%, linear in between. | A depositor supplies one asset: Fixed's idle XLM does not make its USDC (76% borrowed) withdrawable. A pool-wide USD average hid exactly that. |
| `supply_caps` | 0.12 | Worst κ over *weakly priced* collateral. Weakly priced means not base, CEX, FX or RedStone, and not SDEX collateral that already scored ≥ 75 on depth. `κ = cap·price·c / borrowable_liquidity`; κ ≤ 0.1 → 100, κ ≥ 1 → 0, log-linear in between. Not applicable if liquidity is under $1k. | Caps bound how much borrow power a weakly priced collateral can create. |
| `collateral_concentration` | 0.05 | `clamp(200·(1 − HHI))` over the USD value of supplied collateral. Not applicable when nothing is borrowable. | Concentration of tail risk. Kept small to avoid double-counting the oracle factors. |

The weights sum to 1. They are expert judgment, **not fitted**. There is only one historical loss event, and fitting to one point would be meaningless. Pool status is not a factor (since v2.1): Blend's On_Ice / Frozen status is its reaction to the backstop and its withdrawal queue, which `backstop_coverage` and HR7 already measure.

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

**Rolling window (v2.3).** The model runs on the current book and on every stored book of the same asset from the last 24 h, and the worst result sets the factor (and HR3). A past book is rescaled to today's oracle price: each level keeps its USD size and its distance from the price, so pushing the price ×M costs what it cost then. The pool's own reserves (liquidity, caps, c_factor) are always today's. The factor's note names the book used ("thinnest of N books in 24 h, read HH:MM UTC"). Stored books are trimmed to the levels the largest multiplier can reach, plus the next one.

## 5. Hard rules

| Rule | Condition | Effect |
|---|---|---|
| **NR** | The pool never launched (status 6, Setup), or holds under **$10K** supplied | **Not rated**: no score, no grade, not eligible. Nothing is published on-chain for it, so RiskGate refuses deposits as for any unrated pool. |
| **HR1** | Status ≥ 4 (Admin_Frozen, Frozen, Setup): Blend refuses supply above 3 (`pool.rs` `require_action_allowed` **[src]**) | Not eligible. The grade is unchanged: it still describes the setup. On_Ice pools (2/3) accept deposits and are graded on their merits. |
| **HR8** | The backstop's withdrawal queue is at or past the share at which `update_status` **freezes** the pool: 60% for Active or On_Ice, 75% for Admin_On_Ice (`status.rs` **[src]**) | Not eligible. The grade is unchanged. Deposits are still open, but one permissionless call closes them. |
| **HR2** | The price of a collateral, or of an asset with outstanding borrows, is stale or missing | Not eligible. Score ≤ 49, so grade ≤ D. |
| **HR3** | SDEX-priced collateral with ρ < 1, computed from a fully observed book | Not eligible. Score ≤ 34, so **grade E**. |
| **HR5** | Collateral whose price source cannot be identified (opaque, and no exact match) | Not eligible. Score ≤ 64. |
| **HR10** | A reserve with ≥ $1K supplied is borrowed **to or past its own `max_util`**, now or in any read of the **last 6 h** | Not eligible. Score ≤ 64, so grade ≤ C. The rule names what each such reserve's lenders can withdraw, and when the reserve was last at the line. |
| **HR4** | Score < 50 | Not eligible |
| **HR6** | A collateral priced by a source below the robust threshold (`sourceQuality` < 85: anything weaker than RedStone, Reflector CEX/FX or the base asset) | **At most B**, as a soft ceiling (below) |
| **HR7** | The backstop does not count as first-loss capital: it is below Blend's threshold, **or ≥ 30% of it is queued for withdrawal** | **At most B**, as a soft ceiling |
| **HR9** | The pool has ≥ $1K of borrows and its effective backstop (`5·usdc·(1−q4w)`) covers **under 1%** of them | **At most C**, as a soft ceiling (50+ compressed into 50–64). Replaces HR7, which it implies. |

Grade bands: A ≥ 80, B ≥ 65, C ≥ 50, D ≥ 35, E < 35.

**Hard caps and soft ceilings.** HR2, HR3, HR5 and HR10 are hard caps: they describe conditions where the number below the cap carries no useful information. HR6 and HR7 share one **soft ceiling**, applied once even when both hold: scores above 65 are compressed linearly into 65–79 (`65 + (score − 65)·14/35`), so such pools top out at B but keep their order. A hard `min(score, 79)` would flatten all of them to the same number. HR9 is the same construction one band lower: `50 + (score − 50)·14/50`, so at most 64 (C). When HR9 holds it is the ceiling that applies.

**Why HR9.** Under v2.2 Fixed (V2) was B 69 with $0 of backstop against $39.6M of borrows: the backstop factor was 0, but the other factors were good enough to carry it into B. Both internal reviews of 2026-11-02 called that generous, and it is: with no first-loss capital, any bad debt goes straight to lenders, however clean the oracle setup is. 1% is the line because at that cover a bad debt of 1% of the borrows already exceeds the backstop; full marks on the factor start at 10%. The cap is C, not D, because the pool's prices and collateral can still be sound: C says "lend here only if you accept carrying the first loss".

**Why HR10.** Under v2.3 Fixed v2.1 was B 74, the only pool above RiskGate's default minimum of 60, while its USDC reserve was 95.5–96.1% borrowed against its own `max_util` of 90%: of $43.6K supplied, about $1.7K could be withdrawn. The utilization factor was 0, but it weighs 12%, so the rest of the setup carried the pool into B. Both internal reviews of v2.3 (2026-11-02) asked for this rule. Past `max_util` Blend lends no more of the asset, and its lenders can take out only what is not borrowed until borrowers repay or new lenders arrive; a new deposit is the first money that waiting lenders can withdraw and borrowers can draw. The cap is C, as for HR9: the pool's prices and collateral can still be sound. The pool is also not eligible, because a rating that sends deposits into a pool its lenders cannot leave fails the one question the grade answers. The $1K line is the one the utilization factor already uses, so dust reserves do not trigger it. A reserve without a price is left out (its supply cannot be valued, and HR2 already applies).

**Why 6 h (v2.5).** A rule on a line flips when a reserve hovers at it. Fixed v2.1's USDC was 96.1% borrowed at 13:50 UTC on 2026-11-02 (C 64, not eligible) and 89.94% at 14:32 after about $3K of new supply (B 75, eligible): a 0.1-point move swung the score 11 points across the gate's minimum. Since v2.5 every run stores each reserve's supply and borrows, and HR10 holds while any read of the last 6 h was at or past `max_util`; the reads are part of the snapshot, so they are in `reasonsHash` and the archive. 6 h is twelve publishing runs: one deposit cannot reopen the pool within the hour, and a pool whose borrowers have repaid is not kept closed for most of a day, as the 24 h SDEX window would. The window was rebuilt from the archived runs when v2.5 went live, so it did not start empty.

**Why HR8.** YieldBlox read On_Ice with 97.8% of its backstop queued to leave, and v2.2 marked it eligible. Blend's own rule freezes such a pool at 60% (75% when the admin set On_Ice), but only when someone calls `update_status`, which anyone can. HR8 applies Blend's rule before the call is made. Like HR1 it decides eligibility, not the grade.

**Why HR6.** Without it a pool like YieldBlox (PYUSD at a fixed peg) or the Etherfuse pools (CETES/USTRY/TESOURO from the pool admin's own push oracle) would reach A as soon as the backstop came back, although oracle configuration is the failure mode Vigil exists to catch. SDEX-priced collateral whose order book was deep enough to make manipulation unprofitable (manipulation sub-score ≥ 75) counts as robust, as it does for supply caps.

**Why HR7 includes the queue.** At ≥ 30% queued, Blend's own `update_status` puts an Active pool On_Ice (`pool/src/pool/status.rs`: `q4w_pct >= 0_3000000 || !met_threshold` ⇒ status 3; ≥ 60% ⇒ Frozen **[src]**). `update_status` is permissionless but has to be called, so a pool can still read Active while its backstop is leaving: Fixed v2.1 was status 1 with 44.5% queued on 2026-11-01. `backstop_coverage` already discounts the queued part; HR7 adds that the remainder is not reliable either while depositors are exiting.

**Why NR.** Below $10K a pool's utilization, backstop cover and manipulation economics are set by a few dust positions. A pool that never launched has nothing to measure at all. Before v2.2 such pools scored *highest* (an empty pool has no debt, so most factors read 100), and an integrator sorting by score would have been sent to a $0 pool. Credit-rating practice marks these NR.

### What would raise a rating (`paths`)

Each rating carries `paths.B` and `paths.A`: the smallest set of protocol-side changes after which the engine itself would give 65+ / 80+ (`src/lib/vigil/whatif.ts`). The levers are applied to the snapshot and re-scored with `ratePool`, so the answer always follows the current rules:

| Lever | Change simulated |
|---|---|
| `backstop` | backstop above Blend's threshold, covering 10% of borrows, under 30% queued. On_Ice / Frozen pools become Active, as anyone calling Blend's permissionless `update_status` would then make them. When the backstop is already funded and only the queue is too long, the step asks for the queue to be cut instead of a refill. For V2 pools the step notes that Blend's app takes backstop deposits for v2.1 pools only. |
| `oracle` | the weak collateral sources above become a CEX/FX feed behind a max_dev limit |
| `caps` | supply caps so a weakly-priced collateral's borrow power is ≤ 10% of available liquidity |
| `fresh` | stale prices republished |

Utilization, collateral mix and pool size are market conditions, not levers, and admin actions (status changes) are not levers either, because status is not graded. A missing price cannot be simulated, so pools with one report the target as out of reach. NR pools have no path. Paths are informational and not part of `reasonsHash`.

### DeFindex

A strategy's rating is its underlying pool's rating (worst-of). The pool is taken from the strategy's **on-chain** `Config.pool` where it can be read, and any difference from the config is reported.

If the strategy's asset is not an enabled reserve of that pool, the strategy is not eligible (HR-D2). A strategy on an NR pool is NR. A vault is rated worst-of its rated strategies; any NR strategy makes the vault not eligible.

DeFindex's own contract, keeper and upgrade risk is **not modelled**, and every DeFindex rating says so.

### reasonsHash

`reasonsHash = sha256(canonicalJson({engineVersion, inputs, factors, hardRules, score, uncappedScore, grade, eligibleForDeposit}))`

- **`inputs`:** status, oracle, `asOf` (chain time and ledger), the backstop contract id and its `pool_data`, the per-reserve configuration, amounts, prices, source kind and `max_dev`, a sha256 of each SDEX ask book and of each stored book in the 24 h window (with its time and reference price), and the data gaps.
- **`engineVersion`** is hashed, so a hash also identifies the methodology. The registry does not store the version itself yet (§9).
- **`score` / `uncappedScore`** are `null` for an NR pool.
- **Canonical JSON:** keys sorted, no whitespace, non-integers rounded to 6 decimal places, bigint written as a string.
- **`computedAt` is excluded.** The same snapshot always gives the same hash.

**Checking a published hash.** Every run the publisher signs is archived for 90 days at `/api/ratings/runs` (`?at=<computedAt>`, the timestamp the registry returns). An archived run carries each pool's full snapshot, the DeFindex strategy inputs, and every order book it used, stored once by its sha256 (`src/lib/vigil/audit.ts`). `npx tsx scripts/vigil-verify.ts [computedAt]` needs no keys. For each rating it does three things:
1. It recomputes the reasonsHash from the archived input and the rating's own factors, rules and score.
2. It re-rates the pool with the checked-out engine.
3. It compares the result with what each publisher signed into the RiskRegistry.

Runs archived before 2026-11-02's change kept a summary of each order book only, and the script says so. To re-rate a run of an older engine version, check out the commit that ships it.

## 6. History behind the rules

| Event | What happened | Sources |
|---|---|---|
| **YieldBlox pool `CCCCIQ…`, 22 Feb 2026** | About $10.2M to $10.97M was drained. USTRY was pushed on SDEX from about $1.06 to $106.74, used as collateral, and the attacker borrowed 1,000,196 USDC and 61,249,278 XLM. | BlockSec (above), https://rekt.news/yieldblox-rekt, and the DefiLlama `hacks` entry for blend-pools-v2 (amount 10,970,000, date 1771718400) |
| **Comet BLND-USDC pool**, the one feeding the backstop | A separate exploit of about $717K. DefiLlama lists it as CometDEX, "Incorrect Share Accounting", date 1787616000 (2026-08-25). | DefiLlama hacks dataset |
| **Comet LP today** (the V2 backstop's LP token) | Holds 387.76 BLND and 0.64 USDC against a total supply of about 1.86e20 LP tokens (raw `get_total_supply` = 1.86e27 stroops) **[chain]**. As a result, the V2 backstop's `pool_data(..)` returns `blnd = 0` and `usdc = 0` for **every V2 pool** **[chain]**: their backstop insurance is worth about $0 today. | **[chain]** |
| **Blend v2.1, 2026-09-30** | Blend relaunched the same pool code with a new backstop (`CCS4AZ…`) whose LP is built from Comet v1.1.0, and a new factory. Its one pool, Fixed v2.1 `CBAKAZ…`, is Active with 7.14M BLND and 11,820 USDC behind it, 44.5% of it queued for withdrawal on 2026-11-01 **[chain]**. | blend-ui PR #238; **[chain]** |

## 7. Live results (mainnet, engine v2.5.0, computedAt 2026-11-02T16:02:24Z, the deployment's run)

This is the run the deployment published at 16:02 UTC, archived as [`/api/ratings/runs?at=1793635344`](https://yieldpilot.org/api/ratings/runs?at=1793635344); `npx tsx scripts/vigil-verify.ts 1793635344` recomputes all 17 hashes and re-rates every pool from it. The deployment's 24 h book window and 6 h utilization window are in its inputs; a CLI run without them (`scripts/vigil-ratings.ts` with no history files) sees only the books and reads of that moment.

```
coverage: 13 pools found [stellar-expert:factory-deploy-events:v2=12, rpc:backstop-reward-zone+recent-deploy-events:v2=0,
          stellar-expert:factory-deploy-events:v2.1=1, rpc:backstop-reward-zone+recent-deploy-events:v2.1=1, curated=2],
          rated 13, failed 0, unverified 0, rejected 0
protocol | name                   | id      | status         | dep  | scr | unc | G  | elg |       TVL | weakest factor
blend    | Fixed v2.1             | CBAKAZ… | 1 Active       | v2.1 |  64 |  89 | C  | no  |   $149.2K | utilization=14.4
blend    | Fixed                  | CAJJZS… | 3 On_Ice       | v2   |  57 |  75 | C  | yes |  $168.83M | backstop_coverage=0
blend    | Etherfuse              | CDMAVJ… | 4 Admin_Frozen | v2   |  53 |  60 | C  | no  |    $15.2K | backstop_coverage=0
blend    | YieldBlox              | CCCCIQ… | 3 On_Ice       | v2   |  51 |  53 | C  | no  |   $157.3K | backstop_coverage=0
blend    | Orbit                  | CAE7QV… | 4 Admin_Frozen | v2   |  34 |  50 | E  | no  |   $190.8K | supply_caps=0
blend    | Forex                  | CBYOBT… | 5 Frozen       | v2   |  NR |   - | NR | no  |      $456 | oracle_freshness=0
blend    | Solv                   | CC4HHX… | 3 On_Ice       | v2   |  NR |   - | NR | no  |      $173 | backstop_coverage=50
blend    | Spectra PTs            | CDZVHC… | 2 Admin_On_Ice | v2   |  NR |   - | NR | no  |       $10 | oracle_source=50
blend    | YieldBlox              | CBNR7P… | 6 Setup        | v2   |  NR |   - | NR | no  |        $0 | oracle_source=50
blend    | Orbit                  | CB4OFH… | 6 Setup        | v2   |  NR |   - | NR | no  |        $0 | oracle_source=50
blend    | Etherfuse              | CALRF5… | 6 Setup        | v2   |  NR |   - | NR | no  |        $0 | oracle_source=0
blend    | Etherfuse              | CADR6Q… | 6 Setup        | v2   |  NR |   - | NR | no  |        $0 | oracle_source=45
blend    | New Fixed              | CAIYBZ… | 6 Setup        | v2   |  NR |   - | NR | no  |        $0 | backstop_coverage=50
defindex | DeFindex USDC Fixed    | CDB2WM… | 3 On_Ice       | v2   |  57 |  75 | C  | yes |   $18.80M | underlying_pool=57
defindex | DeFindex EURC Fixed    | CC5CE6… | 3 On_Ice       | v2   |  57 |  75 | C  | yes |    $19.2K | underlying_pool=57
defindex | DeFindex XLM Fixed     | CDPWNU… | 3 On_Ice       | v2   |  57 |  75 | C  | yes |     $7.1K | underlying_pool=57
defindex | DeFindex USDC Etherfus | CCBTSH… | 4 Admin_Frozen | v2   |  53 |  60 | C  | no  |        $7 | underlying_pool=53
```

**Reading the table:**

- **Fixed v2.1 is C 64 and not eligible (HR10, 6 h window).** At 13:59 UTC its USDC reserve was 96.1% borrowed against its own 90% `max_util`: of $43.6K supplied, $1.7K could be withdrawn. A ~$3K deposit brought it to 89.9% by 14:32 ($4.7K of $46.6K withdrawable). v2.4 read only the current state and graded that 14:32 run B 75, eligible, and it was published at 75; from the 15:02 run v2.5 holds HR10 for 6 h after the 13:59 read, so the pool stays not eligible until 19:59 UTC if no later read reaches `max_util`. Its setup scores 89 uncapped. Under v2.3 it was B 74, held to B by HR7 (44.5% of its backstop is queued to leave). Its path back is market-side: borrowers repaying or lenders adding USDC.
- **Fixed (V2) is C 57 (HR9).** Its backstop covers $0 of $39.6M of borrows. Its setup scores 75 uncapped (CEX-priced collateral, no SDEX exposure), so it stays eligible, but at C: lenders carry the first loss. DeFindex's three Fixed strategies, $18.8M of them in USDC, inherit C 57. Its path to B and A is the backstop, which Blend's app takes for v2.1 pools only.
- **YieldBlox is not eligible (HR8)**: 97.8% of its backstop is queued, so one `update_status` call would freeze it. It is C 51 (HR9 as well).
- **Orbit `CAE7QV…` is E 34 (HR3).** On the thinnest of the 8 CETES books the deployment read in the last 24 h (10:59 UTC), pushing CETES ×100 on SDEX costs $64.5K, plus $2.1K of collateral, to borrow $180.1K (ρ 0.37). A CLI run at 13:50 UTC, which had only that moment's book, read $148K (ρ 0.83). Its grade moved in and out of E on 2026-11-01 as its CETES book changed ($275 at 15:07 UTC, $253K at 19:17, $268 at 20:19). Since v2.3 it is rated on the thinnest book of the last 24 h, so once a thin book has been read the grade stays E for a day instead of flipping back within the hour. The pool is Admin_Frozen either way.
- **8 pools are NR.** Five never launched (status 6). Forex ($456, whose oracle publishes no price for the three assets borrowed in it), Solv ($173) and Spectra ($10) hold too little to measure.
- **4 of 17 ratings accept deposits:** Fixed and DeFindex's three Fixed strategies, all C 57. **No pool reaches the default RiskGate minimum of 60**, so the gate refuses every new deposit until one does. YieldPilot holds; withdrawals are never gated.

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
score 34 (uncapped 49) grade E eligible=false status=1 Active TVL $27.41M        (engine v2.4.0; same as v2.2.0)
oracle_source 50 (XLM ← reflector_dex, max_dev=0) | oracle_freshness 100
sdex_manipulation 0  USTRY: pump ×100 costs $5.19 on SDEX + $190.0K collateral to borrow $13.14M (rho=0.0145; hold 2 rounds ≈600s, max_dev=10%)
backstop_coverage 100 ($1.53M covers 18.8% of $8.10M) | utilization 42 (most-borrowed reserve USDC 80.3%; pool-wide 29.6%)
supply_caps 0 (XLM: cap allows $120.86M borrow power = 919.8% of liquidity) | concentration 91.8
hard rules: HR3 SDEX-manipulable collateral (USTRY) ⇒ not eligible, grade E
actually extracted: $10.87M
```

- **Grade E, with no deposits allowed.** The engine would have refused deposits into the pool. Its uncapped score is **49 (D)**, one point under the deposit line, and most of the drop below C comes from its USDC reserve being 80% borrowed. Under v2.0 and v2.1, which averaged utilization over the whole pool, it was 62 and 56 (C): without the SDEX rule the pool looked investable. The SDEX rule is what identifies the actual attack.
- **The model's numbers line up with the exploit.** It found $13.1M extractable with $190K of collateral, against roughly $11M actually taken with about $160K of USTRY collateral (rekt.news).
- **The flag holds across a wide range of book depths.** The flag stays on (ρ < 1) until the USTRY ask book below $1.06 is about **$10M deep**, and clears at about $26M. The real book held about $5.
- **The rule keys on the price source, not on thin markets.** Re-pointing USTRY to a CEX feed, with the book unchanged, removes HR3 (see the unit test in `backtest.test.ts`).

## 9. Known limitations and assumptions

1. **The depth window only sees the books we read.** Books are read when ratings are computed, every 30 minutes (the publisher), so asks posted and pulled between two reads are missed. Each archived run carries the books it used (§5, reasonsHash), so anyone can recompute our ratings. A second publisher computing on its own still starts from single reads and agrees with us only after it has its own 24 h (the CLI keeps them in a file with `VIGIL_DEPTH_HISTORY`).
2. **SDEX book coverage is partial.** Vigil reads only the Horizon USDC-quoted book: at most 200 levels, no AMM pools, and no XLM-quoted paths. Ignoring other venues *lowers* the estimated manipulation cost, so the model errs toward flagging. A truncated book makes the cost a lower bound, and that case never fires HR3.
3. **Attacker-friendly simplifications in the manipulation model:**
   - Order books are not replenished (r = 0).
   - Fees and slippage are ignored.
   - Swept tokens are not recycled as collateral.
   - USDC is treated as worth $1.
4. **Opaque adapters (Orbit, Forex).** Their sources are attributed by exact price match only, marked `inferred`, and penalised. An adapter that proxies one feed for some assets and a different source for others would be partly misread.
5. **Prices come from the pool's own oracle.** TVL and liquidity are valued with the pool oracle's prices. A manipulated oracle therefore also inflates TVL.
6. **Backstop value is approximate.** It uses Comet spot (5×USDC, for both the V2 and the v2.1 LP) and ignores price impact when the backstop is drawn.
7. **Thresholds are judgment calls.** The source-quality scores, in particular issuer push 45 and fixed peg 60, and the $10K NR line. The CETES, USTRY and TESOURO push oracle used by the Etherfuse pools is operated by the pool admin's own key (`admin()` = `GDH3FR…` **[chain]**).
8. **The on-chain registry carries no engine version or eligibility.** A published `(score, timestamp, reasonsHash)` does not say which methodology produced it, so an owner's minimum score changes meaning when the methodology changes (it did on 2026-11-01: v2.0 gave 49 to most pools, v2.1 gave 71–75). The version is inside `reasonsHash`, and each run's input is archived (`/api/ratings/runs`, 90 days), but a contract cannot read either. The guard checks only the score, so a pool that is not eligible under HR5, HR8 or HR10 but scores at or above an owner's minimum would still pass it: HR10 caps at 64, above the default minimum of 60. YieldPilot's own path does not have this gap, because its testnet exec pool is published at 0 when the pool it holds is not eligible. HR1 pools are refused by Blend itself. Storing the version and the eligibility flag in the registry is deliverable 1.3.
9. **The backtest is a reconstruction.** USTRY's book comes from a post-mortem, not from chain data. The LP price is an estimate from auction fills. Prices are daily closes, not the oracle's own values at 00:20Z.
10. **No contract-level risk.** The engine does not model upgradeability or admin key risk of pools, oracles or DeFindex. These are noted only through the oracle class.

## 10. Version history

All six versions ran on 2026-11-01/02 against the same chain. Each change came from an internal review of the previous version's live output. v2.5 is frozen for the review round (see the top of this document).

**v2.0 → v2.1 (2026-11-01).** v2.0 gave every non-active pool the same 49 (D): once Blend's V2 backstop was drained, every pool fell into that cap and the differences that matter disappeared.

| | v2.0 | v2.1 |
|---|---|---|
| Pool status | a 15% factor, plus HR1: status ≥ 2 ⇒ ≤ 49 (D), not eligible | not graded. HR1 only marks status ≥ 4 as not eligible, because Blend refuses supply above 3 |
| Weights | status 0.15, source 0.15, freshness 0.10, manipulation 0.20, backstop 0.15, utilization 0.10, caps 0.10, concentration 0.05 | source 0.18, freshness 0.12, manipulation 0.23, backstop 0.18, utilization 0.12, caps 0.12, concentration 0.05 |
| Uninsured backstop | counted three times: backstop factor, status factor, HR1 cap | backstop factor, plus HR7: at most B |
| Weak collateral price source | factor only | HR6: at most B |
| "At most B" | n/a | the soft ceiling (§5) |

**v2.1 → v2.2 (2026-11-02).** Two internal reviews of v2.1 (2026-11-01) found that empty pools scored highest, that an unpriced debt made a pool look safer, that utilization averaged away a 99%-borrowed reserve, and that the v2.1 deployment was not covered.

| | v2.1 | v2.2 |
|---|---|---|
| Coverage | V2 factory and backstop | V2 **and v2.1**; each pool's backstop read from its own config; `deployment` label on every rating |
| Empty pools | graded (New Fixed, $0, scored 75, the highest of all) | **NR** below $10K supplied or when never launched |
| Unpriced borrowed asset | freshness factor 50, no rule | **HR2** (≤ D, not eligible), like unpriced collateral |
| Utilization | USD-weighted pool-wide | most-borrowed reserve with ≥ $1K supplied |
| HR7 | backstop below Blend's threshold | below threshold, **or ≥ 30% queued for withdrawal** (Blend's own On_Ice trigger) |
| Path text | "Blend then reactivates the pool by itself" | `update_status` is permissionless but must be called; V2 backstop deposits are closed in Blend's app |

Effect on the live table: v2.1 had 11 B's (71–75), four of them for pools holding $173 or less. v2.2 grades 5 Blend pools (B 79, B 69, C 60, C 57, C 53) and marks 8 NR.

**v2.2 → v2.3 (2026-11-02).** Two more internal reviews, of v2.2, found that a pool lent against with no backstop at all still reached B, that a pool one permissionless call from Frozen was marked eligible, and that a single order-book read let Orbit's grade flip within hours.

| | v2.2 | v2.3 |
|---|---|---|
| No first-loss capital | HR7: at most B | **HR9**: under 1% backstop cover of ≥ $1K borrows ⇒ at most C (soft ceiling 50–64) |
| Queue past Blend's freeze share | eligible (YieldBlox, 97.8% queued) | **HR8**: not eligible (60%, or 75% for Admin_On_Ice), grade unchanged |
| SDEX depth | one read | **thinnest book of the last 24 h**, past books rescaled to today's price; the books are part of `reasonsHash` |

Effect on the live table: Fixed (V2) B 69 → C 57, DeFindex's Fixed strategies B 69 → C 57, YieldBlox eligible → not eligible, Etherfuse C 60 → C 53. Fixed v2.1 is unaffected by the new rules (B 75 on 2026-11-02 06:53, after its utilization rose).

**v2.3 → v2.4 (2026-11-02).** The internal reviews of v2.3 with the gate live found that the one pool passing the gate could not pay its lenders back: Fixed v2.1 was B 74 with its USDC 95.5% borrowed against a 90% `max_util`, because utilization is one factor of seven. This breaks the v2.3 freeze for that one rule; nothing else changed.

| | v2.3 | v2.4 |
|---|---|---|
| A reserve borrowed to or past its `max_util` | utilization factor 0 (weight 0.12), nothing else | **HR10**: not eligible, at most C (hard cap 64), for every reserve with ≥ $1K supplied |
| Run archive | ratings plus a summary of each order book (level count, best ask) | every input, order books included, stored once by hash; `scripts/vigil-verify.ts` recomputes each hash, re-rates each pool and compares with the registry |

Effect on the live table: Fixed v2.1 B 74 → C 64, eligible → not eligible. No pool reached RiskGate's default minimum of 60 at that run.

**v2.4 → v2.5 (2026-11-02).** The next reviews found HR10 flipping: 40 minutes after v2.4 went live, about $3K of new USDC took Fixed v2.1's reserve from 96.1% to 89.94% borrowed, under its 90% `max_util`, and the pool was back to B 75 and eligible. Both reviewers asked for hysteresis.

| | v2.4 | v2.5 |
|---|---|---|
| HR10 | the current read only | the current read **or any read of the last 6 h** (stored per pool and reserve, hashed, archived) |

The run archive and `scripts/vigil-verify.ts` are unchanged; the stored reads are part of each archived snapshot.
