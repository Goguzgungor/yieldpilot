"use client";

import type { OwnershipMode, RegisteredUser } from "../useOnboarding";
import { truncateAddress } from "../format";
import { testnetContractUrl } from "../links";

// Testnet exec contracts — every user supplies into this one pool.
const EXEC_POOL_ID = "CBI7WAUQ4NPQFZW4C3MDSVFAZJWV3RCLZSTTMA5OZ6BTPEQMOZZNSZ3Z";
const EXEC_USDC_CONTRACT_ID = "CD2R7WREEPGIAXZL4ASB76Y6PWTY6ZZXZ6C64AIKFDIG36YKQPNY6B2I";

/** The smart account and exactly what the agent may do with it. */
export default function AccountView({ user, onBack, onDisconnect, onResetDemo, resetting, ownership, finalizing, onFinalize, error }: {
  user: RegisteredUser;
  onBack: () => void;
  onDisconnect: () => void;
  onResetDemo: () => void;
  resetting: boolean;
  ownership: OwnershipMode | null;
  finalizing: boolean;
  onFinalize: () => void;
  error: string | null;
}) {
  // Wallets still owned by the backend key predate the guard; every other
  // wallet (new, or migrated) has the Vigil guard on both agent rules.
  const guarded = ownership !== null && ownership !== "backend" && ownership !== "unknown";
  return (
    <section className="view" aria-label="Your smart account">
      <div>
        <h6 className="k"><button className="back" onClick={onBack}>← Overview</button>Your smart account</h6>
        <div className="addr" title={user.smartWallet}>{truncateAddress(user.smartWallet, 8, 8)}</div>
        <p className="lede">
          The agent acts on this account only through the two rules on the right. Anything else needs your own
          signature in Freighter.
        </p>
        <p className="links">
          <a href={testnetContractUrl(user.smartWallet)} target="_blank" rel="noreferrer">View on stellar.expert ↗</a>
          <span>OWNER {truncateAddress(user.owner, 4, 4)}</span>
        </p>
        <p className="hint">
          {ownership === null && "Checking who owns this account…"}
          {ownership === "user" && "Only your Freighter wallet owns this account: nobody else can change its rules."}
          {ownership === "co-owned" &&
            "This account was created before user-owned onboarding, so the backend's owner key is still a co-owner. Remove it with one Freighter signature."}
          {ownership === "backend" &&
            "This account was created before user-owned onboarding and is still owned by the backend's demo key. It will be handed to you in the next migration."}
          {ownership === "unknown" && "Ownership could not be read right now."}
        </p>
        {ownership === "co-owned" && (
          <button className="cta" onClick={onFinalize} disabled={finalizing}>
            {finalizing ? "Signing…" : "Remove the backend owner"}
          </button>
        )}
        {error && <p className="err">{error}</p>}
      </div>
      <div>
        <table className="kv">
          <thead><tr><th colSpan={3}>Agent rules</th></tr></thead>
          <tbody>
            <tr><td>#{user.poolRuleId} · Pool</td><td className="m">CallContract(exec pool)</td><td>{guarded ? "funds stay in your account" : "no cap"}</td></tr>
            <tr><td>#{user.usdcRuleId} · USDC</td><td className="m">CallContract(USDC)</td><td>{guarded ? "capped, pays only the pool" : "capped on-chain"}</td></tr>
          </tbody>
        </table>
        <table className="kv">
          <thead><tr><th colSpan={2}>Testnet contracts</th></tr></thead>
          <tbody>
            <tr><td>Exec pool</td><td><a href={testnetContractUrl(EXEC_POOL_ID)} target="_blank" rel="noreferrer">{truncateAddress(EXEC_POOL_ID, 4, 4)} ↗</a></td></tr>
            <tr><td>USDC</td><td><a href={testnetContractUrl(EXEC_USDC_CONTRACT_ID)} target="_blank" rel="noreferrer">{truncateAddress(EXEC_USDC_CONTRACT_ID, 4, 4)} ↗</a></td></tr>
          </tbody>
        </table>
        <p className="pair">
          <button className="underline" onClick={onDisconnect}>Disconnect</button>
          <button className="quiet" onClick={onResetDemo} disabled={resetting} title="Forget this wallet in the demo registry; the on-chain account is untouched">
            {resetting ? "Resetting…" : "Reset demo"}
          </button>
        </p>
      </div>
    </section>
  );
}
