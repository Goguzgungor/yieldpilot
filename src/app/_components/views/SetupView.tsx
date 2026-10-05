"use client";

import { useState } from "react";
import type { OnboardingState, OnboardingStep, StepKey } from "../useOnboarding";
import { truncateAddress, networkLabel } from "../format";
import { testnetTxUrl } from "../links";

const TITLES: Record<StepKey, string> = {
  deploy: "Create your smart account",
  authorize: "Authorize the agent",
  fund: "Mint test USDC",
  register: "Activate",
};
const HINTS: Record<StepKey, string> = {
  deploy: "your own OpenZeppelin account · Freighter",
  authorize: "pool access + USDC capped at 5,000 a day",
  fund: "straight into the account, none needed",
  register: "hand it to the agent loop",
};
const WORKING: Record<StepKey, string> = {
  deploy: "confirm in Freighter…",
  authorize: "co-signing the agent rules…",
  fund: "minting test USDC…",
  register: "recording your account…",
};
const NUMERALS = ["I", "II", "III", "IV"];

function Step({ step, i }: { step: OnboardingStep; i: number }) {
  let detail: React.ReactNode = HINTS[step.key];
  if (step.status === "active") detail = WORKING[step.key];
  if (step.status === "error") detail = step.detail ?? "failed";
  if (step.status === "done") {
    detail = step.txHash
      ? <>done · <a href={testnetTxUrl(step.txHash)} target="_blank" rel="noreferrer">{truncateAddress(step.txHash, 4, 4)} ↗</a></>
      : "done";
  }
  return (
    <li className={step.status}>
      <span className="mk" />
      <div>
        <b><span>{NUMERALS[i]}</span>{TITLES[step.key]}</b>
        <small title={typeof detail === "string" ? detail : undefined}>{detail}</small>
      </div>
    </li>
  );
}

/** Connected but not onboarded: four steps on the left, the one input on the right. */
export default function SetupView({ onboarding, network }: { onboarding: OnboardingState; network: string | null }) {
  const [amount, setAmount] = useState("500");
  const n = Number(amount);
  // the faucet caps each mint at 5,000 USDC (see /api/faucet)
  const valid = Number.isFinite(n) && n > 0 && n <= 5000;
  const wrongNet = !!network && network.toUpperCase() !== "TESTNET";

  return (
    <section className="view" aria-label="Set up">
      <div>
        <h6 className="k">Set up · four steps · about a minute</h6>
        <h2 className="title">Let the agent work your idle USDC.</h2>
        <ol className="steps">
          {onboarding.steps.map((s, i) => <Step key={s.key} step={s} i={i} />)}
        </ol>
      </div>
      <div>
        <h6 className="k">Test USDC to mint</h6>
        <label className="amount">
          <input
            value={amount}
            inputMode="decimal"
            spellCheck={false}
            disabled={onboarding.running}
            aria-label="Test USDC to mint"
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
          />
          <em>USDC</em>
        </label>
        <p className="hint">Up to 5,000 per request. On-chain, the agent can move at most 5,000 USDC a day from your account.</p>
        {wrongNet && <p className="err">Freighter is on {networkLabel(network)}. Switch it to Testnet to continue.</p>}
        {!valid && amount !== "" && <p className="err">Enter an amount between 1 and 5,000 USDC.</p>}
        {onboarding.error && <p className="err">{onboarding.error}</p>}
        <button className="cta" disabled={onboarding.running || !valid || wrongNet} onClick={() => void onboarding.start(n)}>
          {onboarding.running ? "Setting up…" : "Mint & activate →"}
        </button>
        <details className="fine">
          <summary>How signing works</summary>
          <p>
            Steps I and IV are signed in Freighter. Step II is co-signed by a demo owner key, because Freighter&rsquo;s{" "}
            <code>signAuthEntry</code> cannot sign a smart account&rsquo;s custom auth payload. Step III mints our own
            testnet USDC, so you never need to source any.
          </p>
        </details>
      </div>
    </section>
  );
}
