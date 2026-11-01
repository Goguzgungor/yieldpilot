import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/authorize — RETIRED.
 *
 * This used to owner-sign the agent's `add_context_rule` calls with a backend
 * demo-owner key, which made the backend the owner of every user's smart
 * account. New wallets are owned by the user's own G-account
 * (`Signer::Delegated(G)`) and the user authorizes the agent rules in Freighter
 * via `/api/onboard/prepare` steps `authorize-pool` / `authorize-usdc`. Accounts
 * created under the old flow are handed over by
 * scripts/migrate-legacy-accounts.ts.
 */
export async function POST() {
  return NextResponse.json(
    {
      error:
        "retired: the backend no longer owner-signs smart accounts. Use /api/onboard/prepare with step authorize-pool / authorize-usdc and sign in Freighter.",
    },
    { status: 410 },
  );
}
