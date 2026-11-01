/**
 * Deploy our OWN Blend V2 pool on Stellar testnet (accepts a USDC we can mint).
 *
 * Idempotent + resumable: every produced id is appended to
 *   scripts/spike-artifacts/blend-pool.env
 * and any stage whose id already exists is skipped. Safe to re-run after a crash.
 *
 * Uses the shared invoke/sign/assemble/poll helpers in scripts/deploy-lib.ts
 * (@stellar/stellar-sdk@15 + @blend-capital/blend-sdk@3.2.2, both already installed).
 *
 * Disk-conscious: no npm install, no extra writes. Reads the PREBUILT wasms from
 * scripts/blend-utils/{wasm_v2,wasm_v1,src/external}. If a command fails with
 * ENOSPC we let it throw and stop (the deploy is resumable from blend-pool.env).
 *
 * Run:  set -a; source scripts/spike-artifacts/keys.env; set +a
 *       npx tsx scripts/deploy-blend-pool.ts
 *
 * Design note: OWNER is BOTH the pool admin AND the backstop "whale". OWNER is the
 * admin of the USDC SAC and the BLND SAC, so a single signer authorises every op
 * (mint / comet join / backstop deposit) — no multi-party auth in one tx. This is
 * operationally equivalent to the prior plan's "fund AGENT as whale".
 */
import { Asset, Keypair, Address, Operation, xdr, scValToNative, Contract, nativeToScVal, hash } from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  PoolFactoryContractV2,
  BackstopContractV2,
  EmitterContract,
  PoolContractV2,
  type PoolInitMeta,
  type BackstopConstructorArgs,
  type EmitterInitializeArgs,
  type DeployV2Args,
  type SetReserveV2Args,
  type ReserveConfigV2,
  I128MAX,
} from "@blend-capital/blend-sdk";
import {
  RPC, PASS, server, ownerKp, invoke, installWasm, generateContractId,
  bumpInstance, loadArtifacts, recordArtifact, sleep,
} from "./deploy-lib.js";

// ---------- constants ----------
const WASM = {
  poolFactoryV2: "scripts/blend-utils/wasm_v2/pool_factory.wasm",
  backstopV2: "scripts/blend-utils/wasm_v2/backstop.wasm",
  poolV2: "scripts/blend-utils/wasm_v2/pool.wasm",
  emitter: "scripts/blend-utils/wasm_v1/emitter.wasm",
  comet: "scripts/blend-utils/wasm_v1/comet.wasm",
  cometFactory: "scripts/blend-utils/wasm_v1/comet_factory.wasm",
  oracle: "scripts/blend-utils/src/external/oracle.wasm",
};

const USDC_SAC = "CD2R7WREEPGIAXZL4ASB76Y6PWTY6ZZXZ6C64AIKFDIG36YKQPNY6B2I"; // USDC:OWNER (we are admin)

// Comet pool params (BLND 80% / USDC 20%). new_c_pool seeds the pool with these
// underlying balances and mints a FIXED 100 LP (Balancer INIT_POOL_SUPPLY) to the
// creator — regardless of balances. Because we seed the FULL large balances here,
// those 100 LP already back the entire 500,100 BLND + 12,501 USDC pool, so the
// backstop's k = balBLND^0.8 * balUSDC^0.2 (raw units) is ~2.4e12, far above the
// 100,000 threshold. We therefore just deposit (most of) the 100 LP we hold; no
// secondary joinPool is needed (that's only required when the pool is seeded small).
const COMET_BLND_BAL = BigInt(500100e7);
const COMET_USDC_BAL = BigInt(12501e7);
const COMET_WEIGHTS = [BigInt(0.8e7), BigInt(0.2e7)];
const COMET_SWAP_FEE = BigInt(0.003e7);
const COMET_INIT_LP = BigInt(100e7); // new_c_pool always mints exactly 100 LP

// Backstop deposit target (LP). The threshold needs only ~42 raw units of LP, so any
// sizeable fraction of our 100 LP clears it with enormous margin. Deposit 99 LP and
// keep a tiny buffer; the actual deposit is clamped to the whale's real LP balance.
const BACKSTOP_DEPOSIT_LP = BigInt(99e7);

const POOL_NAME = "YieldPilot";
const BACKSTOP_TAKE_RATE = 0.10e7; // 10%
const MAX_POSITIONS = 4;
const MIN_COLLATERAL = 0n;

// USDC reserve config (standard Blend reserve, copied from blend-utils example).
const USDC_RESERVE: ReserveConfigV2 = {
  index: 0,
  decimals: 7,
  c_factor: 900_0000,   // 0.90 collateral factor
  l_factor: 950_0000,   // 0.95 liability factor
  util: 800_0000,       // 0.80 target utilisation (< 0.95)
  max_util: 950_0000,   // 0.95 max utilisation (> util)
  r_base: 50000,        // 0.005
  r_one: 500000,        // 0.05
  r_two: 1000000,       // 0.10
  r_three: 1_0000000,   // 1.00
  reactivity: 1000,
  supply_cap: I128MAX,
  enabled: true,
};

// ---------- small helpers ----------
function scAddr(id: string) { return new Address(id).toScVal(); }

/** Read-only contract call (simulate only). */
async function simRead(contractId: string, method: string, ...args: xdr.ScVal[]): Promise<xdr.ScVal> {
  const owner = ownerKp();
  const acct = await server.getAccount(owner.publicKey());
  const { TransactionBuilder } = await import("@stellar/stellar-sdk");
  const tx = new TransactionBuilder(acct, { fee: "1000000", networkPassphrase: PASS })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  const { rpc: rpcNs } = await import("@stellar/stellar-sdk");
  if (!rpcNs.Api.isSimulationSuccess(sim) || !sim.result) throw new Error(`simRead ${method} failed`);
  return sim.result.retval;
}

/** SAC mint(to, amount) — signed by OWNER (the SAC admin). */
async function sacMint(sac: string, to: string, amount: bigint, label: string) {
  const op = new Contract(sac).call(
    "mint",
    nativeToScVal(to, { type: "address" }),
    nativeToScVal(amount, { type: "i128" }),
  );
  await invoke(op.toXDR("base64"), ownerKp(), { label });
}

async function sacBalance(sac: string, who: string): Promise<bigint> {
  const rv = await simRead(sac, "balance", new Address(who).toScVal());
  return scValToNative(rv) as bigint;
}

// ---------- main ----------
async function main() {
  const owner = ownerKp();
  const OWNER = owner.publicKey();
  console.log(`# Deploy Blend V2 pool — RPC ${RPC}`);
  console.log(`# OWNER (admin + whale) = ${OWNER}`);
  let A = loadArtifacts();

  // ---- 0. record fixed ids ----
  if (!A.USDC_SAC) recordArtifact("USDC_SAC", USDC_SAC);

  // ---- 1. BLND SAC (BLND:OWNER) ----
  const blndAsset = new Asset("BLND", OWNER);
  const BLND_SAC = blndAsset.contractId(PASS);
  if (!A.BLND_SAC) {
    console.log(`\n[1] Deploy BLND SAC (BLND:OWNER) -> ${BLND_SAC}`);
    try {
      const op = Operation.createStellarAssetContract({ asset: blndAsset });
      await invoke(op.toXDR("base64"), owner, { label: "deploy:BLND_SAC" });
    } catch (e: any) {
      // Already-exists is fine (idempotent); rethrow anything else.
      if (!/exist|already/i.test(String(e?.message))) throw e;
      console.log("  BLND SAC already exists");
    }
    recordArtifact("BLND_SAC", BLND_SAC);
  } else {
    console.log(`[1] BLND SAC exists ${A.BLND_SAC}`);
  }

  // ---- 2. install wasms ----
  const installs: Array<[keyof typeof WASM, string]> = [
    ["poolFactoryV2", "WASM_POOLFACTORY"],
    ["backstopV2", "WASM_BACKSTOP"],
    ["poolV2", "WASM_POOL"],
    ["emitter", "WASM_EMITTER"],
    ["comet", "WASM_COMET"],
    ["cometFactory", "WASM_COMETFACTORY"],
    ["oracle", "WASM_ORACLE"],
  ];
  console.log("\n[2] Install wasms");
  const wasmHashes: Record<string, string> = {};
  for (const [k, envKey] of installs) {
    if (A[envKey]) { wasmHashes[k] = A[envKey]; console.log(`  ${k} wasm already installed ${A[envKey]}`); continue; }
    const h = await installWasm(WASM[k], owner, k);
    wasmHashes[k] = h;
    recordArtifact(envKey, h);
  }
  A = loadArtifacts();

  // ---- 3. mock oracle ----
  let ORACLE = A.ORACLE;
  if (!ORACLE) {
    const salt = randomBytes(32);
    ORACLE = generateContractId(OWNER, salt);
    console.log(`\n[3] Deploy mock oracle -> ${ORACLE}`);
    const deployOp = Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeCreateContract(
        new xdr.CreateContractArgs({
          contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
            new xdr.ContractIdPreimageFromAddress({ address: new Address(OWNER).toScAddress(), salt }),
          ),
          executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(wasmHashes.oracle, "hex")),
        }),
      ),
      auth: [],
    });
    await invoke(deployOp.toXDR("base64"), owner, { label: "deploy:oracle" });
    await bumpInstance(ORACLE, owner, "oracle");
    recordArtifact("ORACLE", ORACLE);
  } else {
    console.log(`[3] oracle exists ${ORACLE}`);
  }

  // set_data + set_price_stable (cheap; re-run each time to keep prices fresh => oracle not stale)
  {
    console.log("    oracle.set_data(base=Other(USD), assets=[USDC,BLND], dec=7, res=300)");
    const oracleSpec = await buildOracleSpec();
    const setData = oracleSpec.funcArgsToScVals("set_data", {
      admin: new Address(OWNER),
      base: { tag: "Other", values: ["USD"] },
      assets: [
        { tag: "Stellar", values: [new Address(USDC_SAC)] },
        { tag: "Stellar", values: [new Address(BLND_SAC)] },
      ],
      decimals: 7,
      resolution: 300,
    });
    await invoke(new Contract(ORACLE).call("set_data", ...setData).toXDR("base64"), owner, { label: "oracle:set_data" });

    console.log("    oracle.set_price_stable([USDC=$1.00, BLND=$0.10])");
    const setPrice = oracleSpec.funcArgsToScVals("set_price_stable", { prices: [BigInt(1e7), BigInt(0.1e7)] });
    await invoke(new Contract(ORACLE).call("set_price_stable", ...setPrice).toXDR("base64"), owner, { label: "oracle:set_price_stable" });
  }

  // ---- 4. comet factory + comet LP (BLND/USDC 80/20) ----
  let COMET_FACTORY = A.COMET_FACTORY;
  if (!COMET_FACTORY) {
    const salt = randomBytes(32);
    COMET_FACTORY = generateContractId(OWNER, salt);
    console.log(`\n[4a] Deploy comet factory -> ${COMET_FACTORY}`);
    const deployOp = Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeCreateContract(
        new xdr.CreateContractArgs({
          contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
            new xdr.ContractIdPreimageFromAddress({ address: new Address(OWNER).toScAddress(), salt }),
          ),
          executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(wasmHashes.cometFactory, "hex")),
        }),
      ),
      auth: [],
    });
    await invoke(deployOp.toXDR("base64"), owner, { label: "deploy:cometFactory" });
    await bumpInstance(COMET_FACTORY, owner, "cometFactory");
    // init(comet_wasm_hash)
    const initOp = new Contract(COMET_FACTORY).call("init", xdr.ScVal.scvBytes(Buffer.from(wasmHashes.comet, "hex")));
    await invoke(initOp.toXDR("base64"), owner, { label: "cometFactory:init" });
    recordArtifact("COMET_FACTORY", COMET_FACTORY);
  } else {
    console.log(`[4a] comet factory exists ${COMET_FACTORY}`);
  }

  // Fund whale (OWNER) with BLND + USDC for the comet pool balances.
  console.log("\n[4b] Fund whale (OWNER) with BLND + USDC for comet");
  const blndBal = await sacBalance(BLND_SAC, OWNER);
  if (blndBal < COMET_BLND_BAL) {
    console.log(`    mint BLND ${COMET_BLND_BAL} to OWNER (have ${blndBal})`);
    await sacMint(BLND_SAC, OWNER, COMET_BLND_BAL * 2n, "mint:BLND");
  } else console.log(`    OWNER BLND balance ok (${blndBal})`);
  const usdcBal = await sacBalance(USDC_SAC, OWNER);
  if (usdcBal < COMET_USDC_BAL) {
    console.log(`    mint USDC to OWNER (have ${usdcBal})`);
    await sacMint(USDC_SAC, OWNER, COMET_USDC_BAL * 100n, "mint:USDC");
  } else console.log(`    OWNER USDC balance ok (${usdcBal})`);

  let COMET = A.COMET;
  if (!COMET) {
    console.log(`\n[4c] comet_factory.new_c_pool([BLND,USDC], w[0.8,0.2], bal[500100,12501], fee 0.003)`);
    const salt = randomBytes(32);
    const op = new Contract(COMET_FACTORY).call(
      "new_c_pool",
      xdr.ScVal.scvBytes(salt),
      scAddr(OWNER),
      xdr.ScVal.scvVec([scAddr(BLND_SAC), scAddr(USDC_SAC)]),
      xdr.ScVal.scvVec(COMET_WEIGHTS.map((w) => nativeToScVal(w, { type: "i128" }))),
      xdr.ScVal.scvVec([COMET_BLND_BAL, COMET_USDC_BAL].map((b) => nativeToScVal(b, { type: "i128" }))),
      nativeToScVal(COMET_SWAP_FEE, { type: "i128" }),
    );
    const { retval } = await invoke(op.toXDR("base64"), owner, { label: "comet:new_c_pool" });
    COMET = scValToNative(retval!) as string;
    console.log(`    comet LP -> ${COMET}`);
    await bumpInstance(COMET, owner, "comet");
    recordArtifact("COMET", COMET);
  } else {
    console.log(`[4c] comet exists ${COMET}`);
  }

  // ---- 5. emitter + poolFactoryV2 + backstopV2 (cross-referenced) ----
  // Deterministic ids must be fixed before either constructor runs (backstop refs factory and vice-versa).
  let EMITTER = A.EMITTER, POOL_FACTORY = A.POOL_FACTORY, BACKSTOP = A.BACKSTOP;
  let factorySaltHex = A.FACTORY_SALT, backstopSaltHex = A.BACKSTOP_SALT;
  if (!POOL_FACTORY || !BACKSTOP) {
    const factorySalt = factorySaltHex ? Buffer.from(factorySaltHex, "hex") : randomBytes(32);
    const backstopSalt = backstopSaltHex ? Buffer.from(backstopSaltHex, "hex") : randomBytes(32);
    if (!factorySaltHex) recordArtifact("FACTORY_SALT", factorySalt.toString("hex"));
    if (!backstopSaltHex) recordArtifact("BACKSTOP_SALT", backstopSalt.toString("hex"));
    POOL_FACTORY = generateContractId(OWNER, factorySalt);
    BACKSTOP = generateContractId(OWNER, backstopSalt);
    console.log(`\n[5] factory=${POOL_FACTORY} backstop=${BACKSTOP}`);

    // emitter
    if (!EMITTER) {
      const eSalt = randomBytes(32);
      EMITTER = generateContractId(OWNER, eSalt);
      console.log(`    deploy emitter -> ${EMITTER}`);
      const deployOp = Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeCreateContract(
          new xdr.CreateContractArgs({
            contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
              new xdr.ContractIdPreimageFromAddress({ address: new Address(OWNER).toScAddress(), salt: eSalt }),
            ),
            executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(wasmHashes.emitter, "hex")),
          }),
        ),
        auth: [],
      });
      await invoke(deployOp.toXDR("base64"), owner, { label: "deploy:emitter" });
      await bumpInstance(EMITTER, owner, "emitter");
      const emitter = new EmitterContract(EMITTER);
      const eArgs: EmitterInitializeArgs = { blnd_token: BLND_SAC, backstop: BACKSTOP, backstop_token: COMET };
      await invoke(emitter.initialize(eArgs), owner, { label: "emitter:initialize" });
      recordArtifact("EMITTER", EMITTER);
    }

    // pool factory V2 (constructor: PoolInitMeta)
    if (!A.POOL_FACTORY) {
      console.log("    deploy poolFactoryV2");
      // pool_hash must be the raw 32-byte Buffer (the SDK spec encodes it as scvBytes);
      // a hex string would be re-encoded byte-for-byte into a garbage hash.
      const initMeta: PoolInitMeta = { backstop: BACKSTOP, blnd_id: BLND_SAC, pool_hash: Buffer.from(wasmHashes.poolV2, "hex") };
      const op = PoolFactoryContractV2.deploy(OWNER, wasmHashes.poolFactoryV2, initMeta, factorySalt, "hex");
      await invoke(op, owner, { label: "deploy:poolFactoryV2" });
      await bumpInstance(POOL_FACTORY, owner, "poolFactoryV2");
      recordArtifact("POOL_FACTORY", POOL_FACTORY);
    }

    // backstop V2 (constructor: BackstopConstructorArgs) — usdc_token=our USDC, backstop_token=our comet LP
    if (!A.BACKSTOP) {
      console.log("    deploy backstopV2 (usdc_token=USDC_SAC, backstop_token=COMET)");
      const bArgs: BackstopConstructorArgs = {
        backstop_token: COMET,
        emitter: EMITTER,
        usdc_token: USDC_SAC,
        blnd_token: BLND_SAC,
        pool_factory: POOL_FACTORY,
        drop_list: [],
      };
      const op = BackstopContractV2.deploy(OWNER, wasmHashes.backstopV2, bArgs, backstopSalt, "hex");
      await invoke(op, owner, { label: "deploy:backstopV2" });
      await bumpInstance(BACKSTOP, owner, "backstopV2");
      recordArtifact("BACKSTOP", BACKSTOP);
    }
  } else {
    console.log(`[5] emitter=${EMITTER} factory=${POOL_FACTORY} backstop=${BACKSTOP} (exist)`);
  }
  A = loadArtifacts();

  // ---- 6. deployPool ----
  let POOL = A.POOL;
  if (!POOL) {
    console.log(`\n[6] poolFactory.deployPool(name=${POOL_NAME}, oracle, take_rate=10%, max_pos=4)`);
    const poolSalt = randomBytes(32);
    const factory = new PoolFactoryContractV2(POOL_FACTORY!);
    const args: DeployV2Args = {
      admin: OWNER,
      name: POOL_NAME,
      salt: poolSalt,
      oracle: ORACLE!,
      min_collateral: MIN_COLLATERAL,
      backstop_take_rate: BACKSTOP_TAKE_RATE,
      max_positions: MAX_POSITIONS,
    };
    const { retval } = await invoke(factory.deployPool(args), owner, { label: "deployPool" });
    POOL = PoolFactoryContractV2.parsers.deployPool(retval!.toXDR("base64"));
    console.log(`    POOL -> ${POOL}`);
    await bumpInstance(POOL, owner, "pool");
    recordArtifact("POOL", POOL);
  } else {
    console.log(`[6] POOL exists ${POOL}`);
  }

  // ---- 7. USDC reserve (queueSetReserve + setReserve) ----
  if (!A.RESERVE_USDC_SET) {
    console.log(`\n[7] queueSetReserve + setReserve for USDC reserve`);
    const pool = new PoolContractV2(POOL!);
    const reserveArgs: SetReserveV2Args = { asset: USDC_SAC, metadata: USDC_RESERVE };
    // queue (idempotent-ish: if already queued this may fail; tolerate)
    try {
      await invoke(pool.queueSetReserve(reserveArgs), owner, { label: "queueSetReserve" });
    } catch (e: any) {
      console.log(`    queueSetReserve note: ${String(e?.message).slice(0, 120)}`);
    }
    // set (may need a 1-ledger queue delay) — retry a few times
    let set = false;
    for (let i = 0; i < 4 && !set; i++) {
      try {
        await invoke(pool.setReserve(USDC_SAC), owner, { label: `setReserve#${i}` });
        set = true;
      } catch (e: any) {
        console.log(`    setReserve attempt ${i} not ready: ${String(e?.message).slice(0, 100)} — waiting a ledger`);
        await sleep(6000);
      }
    }
    if (!set) throw new Error("setReserve failed after retries (queue delay)");
    recordArtifact("RESERVE_USDC_SET", "1");
  } else {
    console.log(`[7] USDC reserve already set`);
  }

  // ---- 8. backstop deposit -> reward zone -> activate ----
  if (!A.BACKSTOP_FUNDED) {
    // Clamp the deposit to the whale's actual comet LP balance (new_c_pool mints 100 LP).
    const lpBal = await sacBalance(COMET!, OWNER);
    const depositLp = lpBal < BACKSTOP_DEPOSIT_LP ? lpBal : BACKSTOP_DEPOSIT_LP;
    console.log(`\n[8a] backstop.deposit(whale=OWNER, POOL, ${depositLp} LP)  (OWNER holds ${lpBal} LP)`);
    if (depositLp <= 0n) throw new Error(`whale holds no comet LP (${lpBal}) — comet mint failed`);
    const backstop = new BackstopContractV2(BACKSTOP!);
    await invoke(
      backstop.deposit({ from: OWNER, pool_address: POOL!, amount: depositLp }),
      owner, { label: "backstop:deposit" },
    );
    recordArtifact("BACKSTOP_FUNDED", "1");
  } else {
    console.log(`[8a] backstop already funded`);
  }

  if (!A.REWARD_ZONE) {
    console.log(`\n[8b] backstop.addReward(POOL, undefined)  (add to reward zone)`);
    const backstop = new BackstopContractV2(BACKSTOP!);
    try {
      await invoke(backstop.addReward(POOL!, undefined), owner, { label: "backstop:addReward" });
      recordArtifact("REWARD_ZONE", "1");
    } catch (e: any) {
      console.log(`    addReward note: ${String(e?.message).slice(0, 160)}`);
    }
  } else {
    console.log(`[8b] reward zone already set`);
  }

  if (!A.POOL_ACTIVE) {
    console.log(`\n[8c] pool.setStatus(0)  (Active)`);
    const pool = new PoolContractV2(POOL!);
    await invoke(pool.setStatus(0), owner, { label: "pool:setStatus(0)" });
    recordArtifact("POOL_ACTIVE", "1");
  } else {
    console.log(`[8c] pool already active`);
  }

  // ---- summary ----
  console.log("\n===== DEPLOY COMPLETE =====");
  const fin = loadArtifacts();
  for (const k of ["POOL", "USDC_SAC", "BLND_SAC", "ORACLE", "BACKSTOP", "EMITTER", "POOL_FACTORY", "COMET", "COMET_FACTORY"]) {
    console.log(`${k}=${fin[k] ?? "(missing)"}`);
  }
  console.log(`POOL_ADMIN=${OWNER}`);
}

// Build the oracle contract Spec from the blend-utils OracleContract (it embeds the spec).
async function buildOracleSpec() {
  const mod = await import("./blend-utils/src/external/oracle.js").catch(() => null);
  if (mod?.OracleContract) {
    return (new mod.OracleContract("CAME6NLSOHHWDYDIXC6CIKJV3TWZOLJDEAV2ZBM5HSB57VY4TCHAPHDJ") as any).spec;
  }
  // Fallback: inline the spec XDR (same as blend-utils/src/external/oracle.ts)
  const { contract } = await import("@stellar/stellar-sdk");
  return new contract.Spec([
    "AAAABAAAACFUaGUgZXJyb3IgY29kZXMgZm9yIHRoZSBjb250cmFjdC4AAAAAAAAAAAAAEFByaWNlT3JhY2xlRXJyb3IAAAABAAAAUVRoZSBjb25maWcgYXNzZXRzIGRvbid0IGNvbnRhaW4gcGVyc2lzdGVudCBhc3NldC4gRGVsZXRlIGFzc2V0cyBpcyBub3Qgc3VwcG9ydGVkLgAAAAAAAAxBc3NldE1pc3NpbmcAAAAC",
    "AAAAAAAAAAAAAAAIc2V0X2RhdGEAAAAFAAAAAAAAAAVhZG1pbgAAAAAAABMAAAAAAAAABGJhc2UAAAfQAAAABUFzc2V0AAAAAAAAAAAAAAZhc3NldHMAAAAAA+oAAAfQAAAABUFzc2V0AAAAAAAAAAAAAAhkZWNpbWFscwAAAAQAAAAAAAAACnJlc29sdXRpb24AAAAAAAQAAAAA",
    "AAAAAAAAAAAAAAAJc2V0X3ByaWNlAAAAAAAAAgAAAAAAAAAGcHJpY2VzAAAAAAPqAAAACwAAAAAAAAAJdGltZXN0YW1wAAAAAAAABgAAAAA=",
    "AAAAAAAAAAAAAAAQc2V0X3ByaWNlX3N0YWJsZQAAAAEAAAAAAAAABnByaWNlcwAAAAAD6gAAAAsAAAAA",
    "AAAAAAAAAAAAAAAEYmFzZQAAAAAAAAABAAAH0AAAAAVBc3NldAAAAA==",
    "AAAAAAAAAAAAAAAGYXNzZXRzAAAAAAAAAAAAAQAAA+oAAAfQAAAABUFzc2V0AAAA",
    "AAAAAAAAAAAAAAAIZGVjaW1hbHMAAAAAAAAAAQAAAAQ=",
    "AAAAAAAAAAAAAAAKcmVzb2x1dGlvbgAAAAAAAAAAAAEAAAAE",
    "AAAAAAAAAAAAAAAFcHJpY2UAAAAAAAACAAAAAAAAAAVhc3NldAAAAAAAB9AAAAAFQXNzZXQAAAAAAAAAAAAACXRpbWVzdGFtcAAAAAAAAAYAAAABAAAD6AAAB9AAAAAJUHJpY2VEYXRhAAAA",
    "AAAAAAAAAAAAAAAGcHJpY2VzAAAAAAACAAAAAAAAAAVhc3NldAAAAAAAB9AAAAAFQXNzZXQAAAAAAAAAAAAAB3JlY29yZHMAAAAABAAAAAEAAAPoAAAD6gAAB9AAAAAJUHJpY2VEYXRhAAAA",
    "AAAAAAAAAAAAAAAJbGFzdHByaWNlAAAAAAAAAQAAAAAAAAAFYXNzZXQAAAAAAAfQAAAABUFzc2V0AAAAAAAAAQAAA+gAAAfQAAAACVByaWNlRGF0YQAAAA==",
    "AAAAAQAAAC9QcmljZSBkYXRhIGZvciBhbiBhc3NldCBhdCBhIHNwZWNpZmljIHRpbWVzdGFtcAAAAAAAAAAACVByaWNlRGF0YQAAAAAAAAIAAAAAAAAABXByaWNlAAAAAAAACwAAAAAAAAAJdGltZXN0YW1wAAAAAAAABg==",
    "AAAAAgAAAApBc3NldCB0eXBlAAAAAAAAAAAABUFzc2V0AAAAAAAAAgAAAAEAAAAAAAAAB1N0ZWxsYXIAAAAAAQAAABMAAAABAAAAAAAAAAVPdGhlcgAAAAAAAAEAAAAR",
  ]);
}

main().then(() => process.exit(0)).catch((e) => { console.error("FATAL", e); process.exit(1); });
