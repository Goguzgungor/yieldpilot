import { NextResponse } from "next/server";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { getAgentKeypair, getDemoOwnerKeypair } from "../../../../lib/agentKeys";
import { migrateLegacyWallet, type LegacyMigrationDeps } from "../../../../lib/legacyMigration";
import { getRuntime, listUsers } from "../../../../lib/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * ONE-OFF, removed after use. Runs steps 1–3 of scripts/migrate-legacy-accounts.ts
 * here, where the production AGENT_SIGNER_SECRET lives: it is a Sensitive Vercel
 * variable, so the script cannot pull it.
 *   GET  [?wallet=C…]  dry run: simulates every pending step, submits nothing
 *   POST [?wallet=C…]  applies
 * Only registered wallets, with the owner and rule ids the registry holds; the
 * request chooses nothing else. Both need `Authorization: Vigil-Admin <ts>.<sig>`:
 * an ed25519 signature by the testnet registry admin over
 * "yieldpilot:migrate-legacy:<ts>", at most 5 minutes old.
 */
const ADMIN = "GANUB45L4U3YYHZDSEJEVMLSBVXCKBIRLP3ZPE3PANUWMVI4UKBGQH3C";

function authorized(req: Request): boolean {
  const m = /^Vigil-Admin (\d+)\.([A-Za-z0-9+/=]+)$/.exec(req.headers.get("authorization") ?? "");
  if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
  try {
    return Keypair.fromPublicKey(ADMIN).verify(Buffer.from(`yieldpilot:migrate-legacy:${m[1]}`), Buffer.from(m[2], "base64"));
  } catch {
    return false;
  }
}

async function run(req: Request, apply: boolean) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { cfg } = getRuntime();
  const deps: LegacyMigrationDeps = {
    server: new rpc.Server(cfg.execRpcUrl),
    networkPassphrase: cfg.execNetworkPassphrase,
    feeSource: getAgentKeypair(),
    demoOwner: getDemoOwnerKeypair(),
    verifier: cfg.ed25519VerifierId,
    guard: cfg.vigilGuard,
    execPoolId: cfg.execPoolId,
  };
  const only = new URL(req.url).searchParams.get("wallet");
  const users = (await listUsers()).filter((u) => !only || u.smartWallet === only);
  const results = [];
  for (const u of users) {
    try {
      results.push(await migrateLegacyWallet(deps, u, apply));
    } catch (e) {
      results.push({ smartWallet: u.smartWallet, error: (e as Error).message.split("\n")[0] });
    }
  }
  return NextResponse.json({
    mode: apply ? "apply" : "dry-run",
    demoOwner: deps.demoOwner.publicKey(),
    guard: { id: cfg.vigilGuard.id, registry: cfg.vigilGuard.registry ?? null, minScore: cfg.vigilGuard.minScore },
    results,
  });
}

export const GET = (req: Request) => run(req, false);
export const POST = (req: Request) => run(req, true);
