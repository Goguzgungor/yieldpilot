/**
 * Testnet plumbing the product routes do not cover: wallet signing (the
 * script's stand-in for Freighter), Friendbot funding, Horizon reads, the
 * classic USDC trustline a drip wallet needs before a G→SA transfer, and
 * read-only contract simulation.
 */
import {
  Account,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  rpc,
  scValToNative,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const HORIZON_URL = "https://horizon-testnet.stellar.org";
export const FRIENDBOT_URL = "https://friendbot.stellar.org";

export type FetchLike = (url: string) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface HorizonAccount {
  balances: Array<{ asset_type: string; asset_code?: string; asset_issuer?: string; balance: string }>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Sign a server-prepared envelope as the wallet (what Freighter signTransaction does in the UI). */
export function signPrepared(xdrB64: string, kp: Keypair, passphrase = TESTNET_PASSPHRASE): string {
  const tx = TransactionBuilder.fromXDR(xdrB64, passphrase) as Transaction;
  tx.sign(kp);
  return tx.toXDR();
}

/** "USDC:G…" (a SAC's name()) → the classic asset it wraps. */
export function assetFromSacName(name: string): Asset {
  const [code, issuer] = name.split(":");
  if (!code || !issuer) throw new Error(`unexpected SAC name: ${name}`);
  return new Asset(code, issuer);
}

export function buildTrustlineTx(source: Account, kp: Keypair, asset: Asset, passphrase = TESTNET_PASSPHRASE): string {
  const tx = new TransactionBuilder(source, { fee: (Number(BASE_FEE) * 100).toString(), networkPassphrase: passphrase })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(120)
    .build();
  tx.sign(kp);
  return tx.toXDR();
}

export async function loadHorizonAccount(address: string, fetchFn: FetchLike = fetch): Promise<HorizonAccount | null> {
  const res = await fetchFn(`${HORIZON_URL}/accounts/${address}`);
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`horizon /accounts/${address} → HTTP ${res.status}`);
  return (await res.json()) as HorizonAccount;
}

export function xlmBalance(acc: HorizonAccount): number {
  const b = acc.balances.find((x) => x.asset_type === "native");
  return b ? Number(b.balance) : 0;
}

export function hasTrustline(acc: HorizonAccount, asset: Asset): boolean {
  return acc.balances.some((b) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer());
}

/** Friendbot only when the account does not exist yet — a resumed run must not fail on "already funded". */
export async function ensureFunded(address: string, fetchFn: FetchLike = fetch): Promise<"funded" | "exists"> {
  if (await loadHorizonAccount(address, fetchFn)) return "exists";
  const res = await fetchFn(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(address)}`);
  if (res.status !== 200) throw new Error(`friendbot ${address} → HTTP ${res.status}`);
  return "funded";
}

export async function sendAndPoll(server: rpc.Server, signedXdr: string, passphrase = TESTNET_PASSPHRASE): Promise<string> {
  const tx = TransactionBuilder.fromXDR(signedXdr, passphrase);
  let sent = await server.sendTransaction(tx);
  for (let i = 0; i < 10 && sent.status === "TRY_AGAIN_LATER"; i++) {
    await sleep(3000);
    sent = await server.sendTransaction(tx);
  }
  if (sent.status === "ERROR") throw new Error(`send ERROR for ${sent.hash}`);
  let g = await server.getTransaction(sent.hash);
  for (let i = 0; i < 30 && g.status === "NOT_FOUND"; i++) {
    await sleep(1000);
    g = await server.getTransaction(sent.hash);
  }
  if (g.status !== "SUCCESS") throw new Error(`tx ${sent.hash} ${g.status}`);
  return sent.hash;
}

/** Read-only contract call via simulation; `source` only has to exist (it never signs). */
export async function simulateCall(
  server: rpc.Server,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  source: string,
  passphrase = TESTNET_PASSPHRASE,
): Promise<unknown> {
  const acc = await server.getAccount(source);
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${method}() simulate failed: ${sim.error}`);
  const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!retval) throw new Error(`${method}() returned no value`);
  return scValToNative(retval);
}

export async function readContractString(
  server: rpc.Server,
  contractId: string,
  method: string,
  source: string,
  passphrase = TESTNET_PASSPHRASE,
): Promise<string> {
  return String(await simulateCall(server, contractId, method, [], source, passphrase));
}

export interface ChainOps {
  ensureFunded(address: string): Promise<"funded" | "exists">;
  /** Hash of the new trustline tx, or null when the wallet already had one. */
  ensureTrustline(kp: Keypair): Promise<string | null>;
  sign(xdrB64: string, kp: Keypair): string;
}

export function createChainOps(opts: { server: rpc.Server; asset: Asset; fetchFn?: FetchLike }): ChainOps {
  const fetchFn = opts.fetchFn ?? fetch;
  return {
    ensureFunded: (address) => ensureFunded(address, fetchFn),
    async ensureTrustline(kp) {
      const acc = await loadHorizonAccount(kp.publicKey(), fetchFn);
      if (!acc) throw new Error(`wallet ${kp.publicKey()} does not exist`);
      if (hasTrustline(acc, opts.asset)) return null;
      const source = await opts.server.getAccount(kp.publicKey());
      return sendAndPoll(opts.server, buildTrustlineTx(source, kp, opts.asset));
    },
    sign: (xdrB64, kp) => signPrepared(xdrB64, kp),
  };
}
