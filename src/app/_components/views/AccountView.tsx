"use client";

import type { RegisteredUser } from "../useOnboarding";
import { truncateAddress } from "../format";
import { testnetContractUrl } from "../links";

// Testnet exec contracts — every user supplies into this one pool.
const EXEC_POOL_ID = "CBI7WAUQ4NPQFZW4C3MDSVFAZJWV3RCLZSTTMA5OZ6BTPEQMOZZNSZ3Z";
const EXEC_USDC_CONTRACT_ID = "CD2R7WREEPGIAXZL4ASB76Y6PWTY6ZZXZ6C64AIKFDIG36YKQPNY6B2I";

/** The smart account and exactly what the agent may do with it. */
export default function AccountView({ user, onBack, onDisconnect, onResetDemo, resetting }: {
  user: RegisteredUser;
  onBack: () => void;
  onDisconnect: () => void;
  onResetDemo: () => void;
  resetting: boolean;
}) {
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
      </div>
      <div>
        <table className="kv">
          <thead><tr><th colSpan={3}>Agent rules</th></tr></thead>
          <tbody>
            <tr><td>#{user.poolRuleId} · Pool</td><td className="m">CallContract(exec pool)</td><td>no cap</td></tr>
            <tr><td>#{user.usdcRuleId} · USDC</td><td className="m">CallContract(USDC)</td><td>capped on-chain</td></tr>
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
