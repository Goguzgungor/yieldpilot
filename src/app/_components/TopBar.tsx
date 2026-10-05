"use client";

import type { FreighterState } from "./useFreighter";
import { truncateAddress } from "./format";
import { FREIGHTER_INSTALL_URL } from "./links";

interface Props {
  wallet: FreighterState;
  registered: boolean;
  /** Connected, and the lookup says this wallet has no account yet. */
  notSetUp: boolean;
  historyOn: boolean;
  onHome: () => void;
  onHistory: () => void;
  onRefresh: () => void;
  onWallet: () => void;
}

/** Identity on the left; on the right, only the things you can do. */
export default function TopBar({ wallet, registered, notSetUp, historyOn, onHome, onHistory, onRefresh, onWallet }: Props) {
  let chip: React.ReactNode;
  if (wallet.installed === false) {
    chip = <a className="wallet plain underline" href={FREIGHTER_INSTALL_URL} target="_blank" rel="noreferrer">Install Freighter ↗</a>;
  } else if (!wallet.address) {
    chip = (
      <button className="wallet plain underline" onClick={onWallet} disabled={wallet.connecting}>
        {wallet.connecting ? "Connecting…" : "Connect Freighter"}
      </button>
    );
  } else {
    chip = (
      <button className="wallet" onClick={onWallet} title={wallet.address}>
        <i />
        <span className="underline">{truncateAddress(wallet.address, 4, 4)}</span>
        {notSetUp && <small>NOT SET UP</small>}
      </button>
    );
  }
  return (
    <header className="top">
      <button className="brand" onClick={onHome} aria-label="YieldSeeker, overview">
        <svg viewBox="0 0 30 30" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
          <path d="M2 26 L10.5 13 L14.6 18.6 L20 8.6 L28 26" />
          <rect x="18.6" y="1.6" width="2.8" height="2.8" fill="currentColor" stroke="none" />
        </svg>
        YieldSeeker
        <span className="nets"><span>SCAN MAINNET</span><span>EXEC TESTNET</span></span>
      </button>
      <nav className="actions">
        {registered && <button className={historyOn ? "quiet on" : "quiet"} onClick={onHistory}>History</button>}
        {/* Re-reads the cached scan; it never triggers the agent. */}
        <button className="quiet" onClick={onRefresh} title="Re-read the latest survey">Refresh</button>
        {chip}
      </nav>
    </header>
  );
}
