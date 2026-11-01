"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import NetworkGraph from "./NetworkGraph";
import AnalysisPanel from "./AnalysisPanel";
import TransactionsPanel from "./TransactionsPanel";
import Onboarding from "./Onboarding";
import { useLivingData } from "./useLivingData";
import { useFreighter } from "./useFreighter";
import { useOnboarding } from "./useOnboarding";
import { extractAgentTxs, formatApy, networkLabel, truncateAddress } from "./format";
import { FREIGHTER_INSTALL_URL, testnetTxUrl } from "./links";

// Known yield-source protocols (rail order + glyph). A dot lights up when the
// latest scan actually contains pools from that protocol (derived from
// pool.protocol), so the rail honestly reflects the multi-protocol set the agent
// is watching — Blend and DeFindex today, the rest "· soon".
const PROTOCOLS = [
  { key: "blend", glyph: "B", label: "Blend" },
  { key: "defindex", glyph: "D", label: "DeFindex" },
  { key: "soroswap", glyph: "◴", label: "Soroswap" },
  { key: "aquarius", glyph: "≋", label: "Aquarius" },
  { key: "phoenix", glyph: "◍", label: "Phoenix" },
];

/** Returns a human-readable age string like "2m ago" or "just now". */
function useAgeLabel(updatedAt: number | null): string {
  const [label, setLabel] = useState("");
  useEffect(() => {
    if (updatedAt == null) { setLabel(""); return; }
    const compute = () => {
      const secs = Math.floor((Date.now() - updatedAt) / 1000);
      if (secs < 10) return "just now";
      if (secs < 60) return `${secs}s ago`;
      const mins = Math.floor(secs / 60);
      if (mins < 60) return `${mins}m ago`;
      return `${Math.floor(mins / 60)}h ago`;
    };
    setLabel(compute());
    const id = setInterval(() => setLabel(compute()), 15_000);
    return () => clearInterval(id);
  }, [updatedAt]);
  return label;
}

export default function LivingNetwork() {
  const { pools, scanUpdatedAt, position, activity, loading, scanning, rescan } = useLivingData();
  const wallet = useFreighter();
  const onboarding = useOnboarding(wallet.address);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [onboardOpen, setOnboardOpen] = useState(false);
  const ageLabel = useAgeLabel(scanUpdatedAt);

  // Gently open the onboarding panel the first time we learn a connected wallet
  // is NOT yet registered. Re-armed whenever the address changes so each newly
  // connected wallet gets one nudge (but never nags after the user closes it).
  const nudgedFor = useRef<string | null>(null);
  useEffect(() => {
    if (wallet.address && onboarding.registered === false && nudgedFor.current !== wallet.address) {
      nudgedFor.current = wallet.address;
      setOnboardOpen(true);
    }
    if (!wallet.address) setOnboardOpen(false);
  }, [wallet.address, onboarding.registered]);

  const selectedPool = useMemo(
    () => pools.find((p) => p.poolId === selectedId) ?? null,
    [pools, selectedId],
  );

  // Best eligible APY for the stat bar.
  const bestApy = useMemo(() => {
    const eligible = pools.filter((p) => p.eligible);
    if (!eligible.length) return null;
    return eligible.reduce((a, b) => (b.apyBps > a.apyBps ? b : a)).apyBps;
  }, [pools]);

  // Distinct protocols present in the latest scan → which rail dots light up.
  const activeProtocols = useMemo(() => new Set(pools.map((p) => p.protocol)), [pools]);

  // All agent transactions from the activity log.
  const agentTxs = useMemo(() => extractAgentTxs(activity), [activity]);

  // Per-user TX filter:
  //   • Registered user → only their own supplies (matched by smart wallet).
  //   • Wallet connected but NOT registered (setup mode / post-reset) → empty
  //     list so the panel feels clean before they onboard.
  //   • No wallet connected (visitor) → full list so the dashboard feels alive.
  const mySmartWallet = onboarding.registered ? onboarding.registered.smartWallet : null;
  const myTxs = useMemo(() => {
    if (mySmartWallet) return agentTxs.filter((tx) => tx.smartWallet === mySmartWallet);
    return []; // no registered wallet → empty panel (setup mode or visitor)
  }, [agentTxs, mySmartWallet]);

  // Ripple trigger: only fires for this user's latest TX, not someone else's.
  const latestTxHash = myTxs[0]?.hash ?? null;

  // Graph position: blue glow + ripple only appear once THIS user's USDC has
  // been supplied (their TX exists in the log). Neutral graph before that.
  const graphPosition = useMemo(
    () => (mySmartWallet && myTxs.length > 0 ? position : null),
    [mySmartWallet, myTxs, position],
  );

  const latestLog = activity[0];
  const active = scanning && !paused;

  return (
    <main className="ys-page">
      <div className="ys-frame">
        {/* ───────── top bar (paper) ───────── */}
        <div className="ys-top">
          <div className="ys-glyph">
            <i />
          </div>
          <div className="ys-title-pill" title="Autonomous DeFi yield agent">
            <b>YieldPilot</b>
            <span>· Stellar</span>
            <span className="ys-tagline">· autonomous agent</span>
          </div>
          <span className="ys-live-chip">
            <span className={paused ? "ys-live-dot" : "ys-live-dot ys-live-on"} />
            {paused ? "PAUSED" : "LIVE"}
          </span>
          <button
            className="ys-play"
            onClick={() => setPaused((p) => !p)}
            aria-label={paused ? "Resume" : "Pause"}
            title={paused ? "Resume scanning" : "Pause scanning"}
          >
            {paused ? (
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M3 1.5 L10.5 6 L3 10.5 Z" fill="currentColor" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <rect x="2.5" y="1.5" width="2.6" height="9" rx="1" fill="currentColor" />
                <rect x="6.9" y="1.5" width="2.6" height="9" rx="1" fill="currentColor" />
              </svg>
            )}
          </button>
        </div>

        {/* ───────── the screen (dark glass viewport) ───────── */}
        <div className="ys-screen">
          {/* protocol rail */}
          <div className="ys-rail">
            {PROTOCOLS.map((r) => {
              const on = activeProtocols.has(r.key);
              return (
                <div key={r.key} className={on ? "ys-rail-dot on" : "ys-rail-dot"}>
                  {r.glyph}
                  <span className="ys-rail-label">{on ? r.label : `${r.label} · soon`}</span>
                </div>
              );
            })}
          </div>

          {/* status readout */}
          <div className="ys-note">
            {loading
              ? "Connecting to YieldPilot…"
              : pools.length === 0
                ? "First scan in progress — agent discovering pools…"
                : `live network — agent watching ${pools.length} mainnet pool${
                    pools.length === 1 ? "" : "s"
                  } across ${activeProtocols.size} protocol${activeProtocols.size === 1 ? "" : "s"}`}
          </div>

          {pools.length === 0 ? (
            // Show empty stage only on genuine cold start (no prior snapshot).
            // If there IS a cached snapshot but pools still empty (corrupt/raced),
            // fall through to NetworkGraph with empty array (renders nothing).
            <EmptyStage loading={loading || scanUpdatedAt == null} />
          ) : (
            <NetworkGraph
              pools={pools}
              position={graphPosition}
              scanning={active}
              selectedId={selectedId}
              onSelect={setSelectedId}
              chosenTxHash={latestTxHash}
            />
          )}

          {/* agent transactions feed (right-docked): filtered to this user */}
          <TransactionsPanel txs={myTxs} />

          {/* activity ticker */}
          {latestLog && (
            <div className="ys-ticker">
              <span
                className="ys-ticker-dot"
                style={{ background: tickerDotColor(latestLog.kind) }}
              />
              <span className="ys-ticker-kind">{latestLog.kind}</span>
              <span className="ys-ticker-msg">{latestLog.message}</span>
              {/* If the log entry carries tx hashes (rebalance / peruser), link the first one */}
              {(() => {
                if (!latestLog.meta) return null;
                try {
                  const m = JSON.parse(latestLog.meta) as { hashes?: string[] };
                  const hash = m.hashes?.[0];
                  if (!hash) return null;
                  return (
                    <a
                      href={testnetTxUrl(hash)}
                      target="_blank"
                      rel="noreferrer"
                      className="ys-ticker-link"
                      title={hash}
                    >
                      {truncateAddress(hash, 4, 4)} ↗
                    </a>
                  );
                } catch {
                  return null;
                }
              })()}
            </div>
          )}
        </div>

        {/* ───────── bottom bar (paper) ───────── */}
        <div className="ys-bottom">
          <Stat label="Pools" value={loading ? "—" : String(pools.length)} />
          <Stat label="Best APY" value={bestApy != null ? formatApy(bestApy) : "—"} />
          <Stat label="Agent TXs" value={loading ? "—" : String(myTxs.length)} />
          {onboarding.registered ? (
            <button
              type="button"
              className="ys-stat"
              onClick={() => setOnboardOpen(true)}
              title="View your smart account"
            >
              <b className="ys-stat-accent">ACCOUNT</b>
              <span>{truncateAddress(onboarding.registered.smartWallet, 4, 4)}</span>
            </button>
          ) : (
            <Stat label="Network" value={networkLabel(wallet.network) || "Stellar"} />
          )}
          {ageLabel && (
            <div className="ys-stat">
              <b>Updated</b>
              <span className="ys-stat-dim">{ageLabel}</span>
            </div>
          )}

          {/* flexible spacer keeps the wallet + scan controls right-aligned */}
          <div className="ys-spacer" />

          <WalletButton
            wallet={wallet}
            registered={!!onboarding.registered}
            onOpenAccount={() => setOnboardOpen(true)}
            onDisconnect={() => {
              // Disconnecting a registered wallet also clears its in-memory demo
              // registration, so reconnecting re-shows the onboarding (demo reset).
              if (onboarding.registered) void onboarding.resetDemo();
              wallet.disconnect();
            }}
          />

          <button
            className={active ? "ys-scan scanning" : "ys-scan"}
            onClick={rescan}
            disabled={paused}
            title={paused ? "Resume to scan" : "Trigger a scan"}
          >
            {active ? "SCANNING" : "SCAN"}
          </button>
        </div>

        <AnalysisPanel pool={selectedPool} position={position} onClose={() => setSelectedId(null)} />
        <Onboarding
          ownerAddress={wallet.address}
          onboarding={onboarding}
          open={onboardOpen}
          onClose={() => setOnboardOpen(false)}
        />
      </div>
    </main>
  );
}

// ── sub-components ───────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="ys-stat">
      <b>{label}</b>
      <span>{value}</span>
    </div>
  );
}

function EmptyStage({ loading }: { loading: boolean }) {
  return (
    <div className="ys-empty">
      <div className="ys-cloud" />
      <div className="ys-center">
        <div className={loading ? "ys-ring ys-ring-pulse" : "ys-ring"} />
        <div className="ys-center-name">YIELDPILOT AGENT</div>
        <div className="ys-center-amt">Autonomous yield agent</div>
        <div className="ys-center-hint">
          {loading ? "first scan in progress…" : "awaiting first scan result…"}
        </div>
      </div>
    </div>
  );
}

function WalletButton({
  wallet,
  registered,
  onOpenAccount,
  onDisconnect,
}: {
  wallet: ReturnType<typeof useFreighter>;
  registered: boolean;
  onOpenAccount: () => void;
  onDisconnect: () => void;
}) {
  if (wallet.installed === false) {
    return (
      <a
        href={FREIGHTER_INSTALL_URL}
        target="_blank"
        rel="noreferrer"
        className="ys-connect ys-connect-link"
        title="Freighter wallet is required"
      >
        Install Freighter ↗
      </a>
    );
  }
  if (wallet.address) {
    // The chip opens the account / onboarding panel; a small ✕ disconnects, so
    // the primary action surfaces the user's smart account rather than dropping
    // the connection by accident.
    return (
      <div className="ys-wallet">
        <button
          className="ys-wallet-chip"
          onClick={onOpenAccount}
          title={`${wallet.address}\nClick to ${registered ? "view your smart account" : "set up your account"}`}
        >
          <span className="ys-live-dot ys-live-on" />
          <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
            <span className="ys-wallet-addr">{truncateAddress(wallet.address, 4, 4)}</span>
            <span className={registered ? "ys-wallet-status on" : "ys-wallet-status"}>
              {registered ? "agent active · manage" : "set up account"}
            </span>
          </span>
        </button>
        <button
          className="ys-wallet-x"
          onClick={onDisconnect}
          aria-label="Disconnect wallet"
          title={registered ? "Disconnect (resets the demo for this wallet)" : "Disconnect"}
        >
          ✕
        </button>
      </div>
    );
  }
  return (
    <button className="ys-connect" onClick={wallet.connect} disabled={wallet.connecting}>
      {wallet.connecting ? "Connecting…" : "Connect Wallet"}
    </button>
  );
}

// Ticker kind → dot color (bright semantic variants — the ticker sits on the
// dark screen).
const tickerDotColor = (kind: string): string => {
  if (kind === "rebalance") return "var(--ok-bright)";
  if (kind === "error" || kind === "skip") return "var(--err-bright)";
  if (kind === "decision") return "var(--blue-bright)";
  return "var(--screen-mut)";
};
