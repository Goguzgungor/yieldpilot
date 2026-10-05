"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLivingData } from "./useLivingData";
import { useFreighter } from "./useFreighter";
import { useOnboarding } from "./useOnboarding";
import Plate, { type PlatePhase } from "./plate/Plate";
import TopBar from "./TopBar";
import AgentBlock from "./views/AgentBlock";
import { CheckingView, HolderView, VisitorView } from "./views/Overview";
import PoolView from "./views/PoolView";
import SetupView from "./views/SetupView";
import AccountView from "./views/AccountView";
import HistoryView from "./views/HistoryView";
import { extractAgentTxs, formatTimeAgo } from "./format";
import { routeName } from "./poolNames";
import { agentStatus, routeVoice } from "../../lib/voice";
import { routeRationale } from "../../lib/rationale";
import { clamp } from "../../lib/plate/noise";

// Plate I: the plate (the range of pools) never moves; the reading area above
// it shows one view at a time — your position, a summit you picked, setup,
// your account, or the agent's transactions.

type Mode = "overview" | "pool" | "account" | "history";

/** No contact for this long reads as offline (polls run every 3s). */
const OFFLINE_AFTER_MS = 15_000;

function useNow(stepMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), stepMs);
    return () => clearInterval(id);
  }, [stepMs]);
  return now;
}

/** The reading area is a fixed band; every view is designed to fit it. */
function useBand() {
  const [v, setV] = useState<{ W: number; H: number } | null>(null);
  useEffect(() => {
    const read = () => setV({ W: window.innerWidth, H: window.innerHeight });
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);
  if (!v) return null;
  const top = clamp(v.H * 0.115, 92, 124);
  const height = v.W <= 960 ? clamp(v.H * 0.38, 400, 480) : clamp(v.H * 0.31, 270, 336);
  const ruleTop = Math.round(top + height + 26);
  return { top, height, ruleTop, plateLine: ruleTop + 22 };
}

export default function PlateApp() {
  const data = useLivingData();
  const wallet = useFreighter();
  const onboarding = useOnboarding(wallet.address);
  const [mode, setMode] = useState<Mode>("overview");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const now = useNow(1000);
  const band = useBand();
  const mountedAt = useRef(Date.now());

  const registered = onboarding.registered || null;
  const cold = !data.loading && data.scanUpdatedAt == null && data.pools.length === 0;
  const offline = data.lastOkAt ? now - data.lastOkAt > OFFLINE_AFTER_MS : now - mountedAt.current > OFFLINE_AFTER_MS;
  const phase: PlatePhase = offline ? "offline" : cold ? "cold" : "live";

  // the route is the best eligible pool — the same rule the agent decides by
  const route = useMemo(() => {
    const ok = data.pools.filter((p) => p.eligible);
    return ok.length ? ok.reduce((a, b) => (b.apyBps > a.apyBps ? b : a)) : null;
  }, [data.pools]);
  const protocols = useMemo(() => [...new Set(data.pools.map((p) => p.protocol))], [data.pools]);
  const standing = useMemo(() => routeVoice(data.pools), [data.pools]);
  // Derived from the live scan, never read back from the stored decision: a
  // stored rationale can be stale (or the old model's markdown) until the next tick.
  const rationale = useMemo(() => routeRationale(data.pools), [data.pools]);
  const allTxs = useMemo(() => extractAgentTxs(data.activity, 50), [data.activity]);
  const myTxs = useMemo(
    () => (registered ? allTxs.filter((t) => t.smartWallet === registered.smartWallet) : []),
    [allTxs, registered],
  );

  const supplied = registered?.position.poolId ? registered.position.amountUsdc : "0";
  const idle = registered?.idleUsdc ?? onboarding.saUsdcStroops ?? null;
  let holding = false;
  try { holding = !!registered && BigInt(supplied || "0") > 0n; } catch { holding = false; }

  const status = agentStatus({
    activity: data.activity,
    nowSec: now / 1000,
    offline,
    coldStart: cold,
    rationale,
    routeVoice: standing,
    poolCount: data.pools.length,
    protocols,
  });

  // a real scan landing → the labelled sweep; a supply landing → ink rises.
  // Both are anchored after the first load so history doesn't replay on open.
  const seenScan = useRef<number | null>(null);
  const seenTx = useRef<string | null | undefined>(undefined);
  const [scanKey, setScanKey] = useState(0);
  const [supplyKey, setSupplyKey] = useState(0);
  const refreshAccount = onboarding.refresh;
  useEffect(() => {
    if (data.loading) return;
    const scan = data.activity.find((a) => a.kind === "scan");
    if (scan) {
      if (seenScan.current == null) seenScan.current = scan.ts;
      else if (scan.ts > seenScan.current) { seenScan.current = scan.ts; setScanKey((k) => k + 1); }
    }
    const tx = allTxs[0];
    if (seenTx.current === undefined) seenTx.current = tx?.hash ?? null;
    else if (tx && tx.hash !== seenTx.current) {
      seenTx.current = tx.hash;
      setSupplyKey((k) => k + 1);
      if (registered && tx.smartWallet === registered.smartWallet) refreshAccount();
    }
  }, [data.loading, data.activity, allTxs, registered, refreshAccount]);

  const home = () => { setMode("overview"); setSelectedId(null); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setMode("overview"); setSelectedId(null); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selected = selectedId ? data.pools.find((p) => p.poolId === selectedId) ?? null : null;
  const agent = (
    <AgentBlock
      status={status}
      phase={phase}
      now={now}
      nextTickAt={data.nextTickAt}
      scanUpdatedAt={data.scanUpdatedAt}
      lastOkAt={data.lastOkAt}
      poolCount={data.pools.length}
      protocolCount={protocols.length}
    />
  );

  let viewKey: string;
  let view: React.ReactNode;
  if (mode === "pool" && selected) {
    viewKey = `pool:${selected.poolId}`;
    view = <PoolView pool={selected} route={route} holding={holding} riskCap={data.riskCap} rationale={rationale} onBack={home} />;
  } else if (mode === "account" && registered) {
    viewKey = "account";
    view = (
      <AccountView
        user={registered}
        onBack={home}
        onDisconnect={() => { home(); wallet.disconnect(); }}
        onResetDemo={() => { home(); void onboarding.resetDemo(); }}
        resetting={onboarding.resetting}
      />
    );
  } else if (mode === "history" && registered) {
    viewKey = "history";
    view = <HistoryView txs={myTxs} onBack={home} />;
  } else if (!wallet.address) {
    viewKey = "visitor";
    view = <VisitorView route={route} installed={wallet.installed} connecting={wallet.connecting} error={wallet.error} onConnect={wallet.connect} agent={agent} />;
  } else if (onboarding.registered === false) {
    viewKey = "setup";
    view = <SetupView onboarding={onboarding} network={wallet.network} />;
  } else if (registered) {
    viewKey = "holder";
    view = <HolderView supplied={supplied} idle={idle} route={route} riskCap={data.riskCap} cold={cold} txs={myTxs} agent={agent} />;
  } else {
    viewKey = "checking";
    view = <CheckingView agent={agent} />;
  }

  let caption: React.ReactNode = <><b>Fig. 1</b> — USDC yield on Stellar, live</>;
  if (phase === "cold") caption = <><b>Fig. 1</b> — first survey in progress</>;
  if (phase === "offline") caption = <><b>Fig. 1</b> — last known survey{data.scanUpdatedAt ? ` · ${formatTimeAgo(data.scanUpdatedAt / 1000, now)}` : ""}</>;
  if (mode === "pool" && selected) caption = <><b>Fig. 1</b> — {routeName(selected)} selected · Esc to return</>;

  return (
    <main className={phase === "offline" ? "app offline" : "app"}>
      {band && (
        <Plate
          pools={data.pools}
          riskCap={data.riskCap}
          chosenId={route?.poolId ?? null}
          selectedId={mode === "pool" ? selectedId : null}
          holding={holding}
          phase={phase}
          plateLine={band.plateLine}
          scanKey={scanKey}
          supplyKey={supplyKey}
          onSelect={(id) => { setSelectedId(id); setMode("pool"); }}
          onBackground={() => { if (mode === "pool") home(); }}
        />
      )}
      <TopBar
        wallet={wallet}
        registered={!!registered}
        notSetUp={onboarding.registered === false}
        historyOn={mode === "history"}
        onHome={home}
        onHistory={() => setMode(mode === "history" ? "overview" : "history")}
        onRefresh={data.rescan}
        onWallet={() => {
          if (!wallet.address) return void wallet.connect();
          if (registered) setMode(mode === "account" ? "overview" : "account");
          else home();
        }}
      />
      {band && (
        <>
          <div className="hero" style={{ top: band.top, height: band.height }}>
            <div key={viewKey} style={{ height: "100%" }}>{view}</div>
          </div>
          <div className="rule" style={{ top: band.ruleTop }}>
            <span>{caption}</span>
            <span>Height = APY · Width = depth · Left to right = risk</span>
          </div>
        </>
      )}
      <div className="signature" aria-hidden="true">YieldPilot · Plate I</div>
      <div className="grain" aria-hidden="true" />
    </main>
  );
}
