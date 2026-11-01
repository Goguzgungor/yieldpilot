"use client";

import type { AgentTx } from "../format";
import { formatTimeAgo, truncateAddress } from "../format";
import { testnetTxUrl } from "../links";
import { usdc2 } from "../../../lib/voice";

const KIND: Record<string, string> = { peruser: "SUPPLY", rebalance: "REBALANCE" };

/** Every transaction the agent sent for this account. */
export default function HistoryView({ txs, onBack }: { txs: AgentTx[]; onBack: () => void }) {
  return (
    <section className="view wide" aria-label="Agent transactions">
      <div>
        <h6 className="k"><button className="back" onClick={onBack}>← Overview</button>Agent transactions for your account · {txs.length}</h6>
        {txs.length === 0 ? (
          <p className="empty">No transactions yet. The agent supplies idle USDC on its next tick.</p>
        ) : (
          <table className="hist">
            <thead><tr><th>Kind</th><th>Amount</th><th>Into</th><th>When</th><th>Transaction</th></tr></thead>
            <tbody>
              {txs.slice(0, 7).map((t) => (
                <tr key={t.hash}>
                  <td>{KIND[t.kind] ?? t.kind.toUpperCase()}</td>
                  <td className="amt">{t.amountStroops ? `+${usdc2(t.amountStroops)} USDC` : "—"}</td>
                  <td>Blend testnet exec pool</td>
                  <td>{formatTimeAgo(t.ts)}</td>
                  <td><a href={testnetTxUrl(t.hash)} target="_blank" rel="noreferrer">{truncateAddress(t.hash, 6, 6)} ↗</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
