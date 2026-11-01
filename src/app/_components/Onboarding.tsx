"use client";

import { useState } from "react";
import type { OnboardingState, OnboardingStep, OwnershipMode, RegisteredUser, StepKey } from "./useOnboarding";
import { formatUsdc, truncateAddress } from "./format";
import { stellarExpertUrl, testnetContractUrl, testnetTxUrl } from "./links";

// Testnet exec contract ids — surfaced as explorer links in the registered view.
const EXEC_POOL_ID = "CBI7WAUQ4NPQFZW4C3MDSVFAZJWV3RCLZSTTMA5OZ6BTPEQMOZZNSZ3Z";
const EXEC_USDC_CONTRACT_ID = "CD2R7WREEPGIAXZL4ASB76Y6PWTY6ZZXZ6C64AIKFDIG36YKQPNY6B2I";

interface Props {
  /** Connected Freighter address; null when disconnected. */
  ownerAddress: string | null;
  onboarding: OnboardingState;
  open: boolean;
  onClose: () => void;
}

const STEP_TITLES: Record<StepKey, string> = {
  deploy: "Create smart account",
  authorize: "Authorize agent",
  fund: "Get test USDC",
  register: "Activate",
};

const STEP_HINTS: Record<StepKey, string> = {
  deploy: "Deploy your personal OpenZeppelin smart account on Stellar testnet.",
  authorize: "Grant the agent a capped, on-chain rule to manage only your USDC.",
  fund: "We mint test USDC straight into your smart account — no external USDC needed.",
  register: "Hand off to the autonomous agent loop.",
};

/**
 * Per-user Freighter onboarding panel. Slides in from the right (matches
 * AnalysisPanel). Shows the registered dashboard slice when the connected owner
 * already has a smart account, otherwise a 4-step setup flow.
 */
export default function Onboarding({ ownerAddress, onboarding, open, onClose }: Props) {
  const {
    registered,
    loadingStatus,
    steps,
    running,
    error,
    smartWallet,
    start,
    agent,
    saUsdcStroops,
    resetDemo,
    resetting,
    ownership,
    finalizing,
    finalizeOwnership,
  } = onboarding;
  const [amount, setAmount] = useState("500");

  const amountNum = Number(amount);
  // The faucet caps each mint at 5,000 USDC (see /api/faucet).
  const amountValid = Number.isFinite(amountNum) && amountNum > 0 && amountNum <= 5000;

  return (
    <>
      <div
        onClick={onClose}
        className="ys-scrim"
        style={{ opacity: open ? 1 : 0, pointerEvents: open ? "auto" : "none" }}
      />
      <aside
        aria-hidden={!open}
        className="ys-panel"
        style={{ transform: open ? "translateX(0)" : "translateX(105%)" }}
      >
        {open && (
          <div className="ys-panel-inner">
            <div className="ys-panel-head">
              <div>
                <div className="ys-kicker">{registered ? "YOUR ACCOUNT" : "GET STARTED"}</div>
                <h2 className="ys-panel-title">
                  {registered ? "Agent active" : "Onboard to YieldPilot"}
                </h2>
                <div className="ys-sub-id">
                  {ownerAddress ? truncateAddress(ownerAddress, 6, 6) : "connect a wallet"}
                </div>
              </div>
              <button onClick={onClose} aria-label="Close panel" className="ys-close">
                ✕
              </button>
            </div>

            {!ownerAddress && (
              <div className="ys-reason ys-prose">
                Connect your Freighter wallet to create a smart account and let the agent manage
                your idle USDC.
              </div>
            )}

            {ownerAddress && loadingStatus && registered === null && (
              <div className="ys-reason ys-prose">Checking your account…</div>
            )}

            {ownerAddress && registered && (
              <RegisteredView
                user={registered}
                onResetDemo={resetDemo}
                resetting={resetting}
                ownership={ownership}
                finalizing={finalizing}
                onFinalize={finalizeOwnership}
                error={error}
              />
            )}

            {ownerAddress && registered === false && (
              <>
                <div className="ys-badge on">○ NOT YET ONBOARDED</div>

                <div className="ys-steps">
                  {steps.map((s, i) => (
                    <StepRow key={s.key} step={s} index={i + 1} />
                  ))}
                </div>

                <div className="ys-faucet-note ys-prose">
                  <span className="ys-faucet-badge">SELF-SERVE</span>
                  We&rsquo;ll mint test USDC straight to your smart account — no external USDC
                  needed.
                </div>

                <div className="ys-amount">
                  <label className="ys-metric-label" htmlFor="ys-fund-amount">
                    TEST USDC TO MINT
                  </label>
                  <div className="ys-amount-row">
                    <input
                      id="ys-fund-amount"
                      className="ys-amount-input"
                      value={amount}
                      inputMode="decimal"
                      disabled={running}
                      onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
                      spellCheck={false}
                    />
                    <span className="ys-amount-unit">USDC</span>
                  </div>
                  <div className="ys-cap-hint ys-prose">
                    Faucet mints up to 5,000 USDC / request. Agent spending is then on-chain capped
                    at 5,000 USDC / day.
                  </div>
                </div>

                {saUsdcStroops !== null && (
                  <div className="ys-balance">
                    <span className="ys-metric-label">SMART ACCOUNT USDC</span>
                    <span className="ys-balance-value">{formatUsdc(saUsdcStroops)} USDC</span>
                  </div>
                )}

                {error && <div className="ys-error ys-prose">{error}</div>}

                <button
                  className="ys-cta"
                  style={{ justifyContent: "center" }}
                  disabled={running || !amountValid}
                  onClick={() => void start(amountNum)}
                >
                  {running ? "Setting up…" : "Get test USDC & activate"}
                </button>

                <details className="ys-fineprint">
                  <summary>How signing works</summary>
                  <p className="ys-prose">
                    Your Freighter account owns the smart account: it is the wallet&rsquo;s
                    Default-rule signer, so only you can change its rules or move funds out.
                    Step 1 deploys it and step 2 adds the agent&rsquo;s two restricted rules, each
                    signed in Freighter (three prompts in total). Step 3 mints our own testnet USDC
                    into your smart account (we control the USDC issuer on testnet), so you never
                    need to source USDC.
                    {smartWallet && (
                      <>
                        {" "}
                        Smart account:{" "}
                        <a
                          href={testnetContractUrl(smartWallet)}
                          target="_blank"
                          rel="noreferrer"
                          className="ys-inline-link"
                        >
                          {truncateAddress(smartWallet, 4, 4)} ↗
                        </a>
                      </>
                    )}
                    {agent && (
                      <>
                        {" "}
                        Agent signer:{" "}
                        <code className="ys-code">{truncateAddress(agent.agentPublicKey, 4, 4)}</code>.
                      </>
                    )}
                  </p>
                </details>
              </>
            )}
          </div>
        )}
      </aside>
    </>
  );
}

// ── sub-components ───────────────────────────────────────────────────────────

function RegisteredView({
  user,
  onResetDemo,
  resetting,
  ownership,
  finalizing,
  onFinalize,
  error,
}: {
  user: RegisteredUser;
  onResetDemo: () => Promise<void>;
  resetting: boolean;
  ownership: OwnershipMode | null;
  finalizing: boolean;
  onFinalize: () => Promise<void>;
  error: string | null;
}) {
  const supplied = user.position.poolId ? formatUsdc(user.position.amountUsdc) : "0";

  return (
    <>
      <div className="ys-status-banner">
        <span className="ys-live-dot ys-live-on" />
        <span>Agent active — managing your USDC</span>
      </div>

      <div className="ys-metric-grid">
        {/* Smart account: clickable testnet contract link */}
        <div className="ys-metric">
          <span className="ys-metric-label">SMART ACCOUNT</span>
          <a
            href={testnetContractUrl(user.smartWallet)}
            target="_blank"
            rel="noreferrer"
            className="ys-metric-link"
            title={user.smartWallet}
          >
            {truncateAddress(user.smartWallet, 5, 5)} ↗
          </a>
        </div>
        <Metric label="SUPPLIED" value={`${supplied} USDC`} accent />
        <Metric label="POOL RULE" value={`#${user.poolRuleId}`} small />
        <Metric label="USDC RULE" value={`#${user.usdcRuleId} · capped`} small />
      </div>

      <div className="ys-block">
        <div className="ys-metric-label">CURRENT POSITION</div>
        {user.position.poolId ? (
          <>
            <div className="ys-position-amt">{supplied} USDC</div>
            <div className="ys-position-pool ys-prose">
              in{" "}
              <a
                href={stellarExpertUrl(user.position.poolId)}
                target="_blank"
                rel="noreferrer"
                className="ys-inline-link"
              >
                {truncateAddress(user.position.poolId, 5, 5)} ↗
              </a>{" "}
              (mainnet reference pool)
            </div>
          </>
        ) : (
          <div className="ys-position-pool ys-prose">
            Idle — the agent will supply your USDC into the best eligible pool on its next tick.
          </div>
        )}
      </div>

      <div className="ys-block">
        <div className="ys-metric-label">OWNERSHIP</div>
        <div className="ys-position-pool ys-prose">
          {ownership === null && "Checking who owns your smart account…"}
          {ownership === "user" && "You own this smart account — only your Freighter wallet can change its rules."}
          {ownership === "co-owned" &&
            "This wallet was created before user-owned onboarding. The backend's owner key is still a co-owner; remove it with one Freighter signature."}
          {ownership === "backend" &&
            "This wallet was created before user-owned onboarding and is still owned by the backend demo key. It will be handed to you in the next migration."}
          {ownership === "unknown" && "Ownership could not be read right now."}
        </div>
        {ownership === "co-owned" && (
          <button
            type="button"
            className="ys-cta"
            style={{ justifyContent: "center", marginTop: 8 }}
            disabled={finalizing}
            onClick={() => void onFinalize()}
          >
            {finalizing ? "Signing…" : "Finalize ownership"}
          </button>
        )}
        {error && <div className="ys-error ys-prose">{error}</div>}
      </div>

      {/* Exec contracts block — testnet contract links */}
      <div className="ys-block">
        <div className="ys-metric-label">TESTNET EXEC CONTRACTS</div>
        <div className="ys-exec-row">
          <span className="ys-metric-label">EXEC POOL</span>
          <a
            href={testnetContractUrl(EXEC_POOL_ID)}
            target="_blank"
            rel="noreferrer"
            className="ys-exec-link"
            title={EXEC_POOL_ID}
          >
            {truncateAddress(EXEC_POOL_ID, 4, 4)} ↗
          </a>
        </div>
        <div className="ys-exec-row">
          <span className="ys-metric-label">USDC</span>
          <a
            href={testnetContractUrl(EXEC_USDC_CONTRACT_ID)}
            target="_blank"
            rel="noreferrer"
            className="ys-exec-link"
            title={EXEC_USDC_CONTRACT_ID}
          >
            {truncateAddress(EXEC_USDC_CONTRACT_ID, 4, 4)} ↗
          </a>
        </div>
      </div>

      <a
        href={testnetContractUrl(user.smartWallet)}
        target="_blank"
        rel="noreferrer"
        className="ys-cta"
        style={{ justifyContent: "center" }}
      >
        View smart account ↗
      </a>

      <button
        type="button"
        onClick={() => void onResetDemo()}
        disabled={resetting}
        className="ys-reset"
        title="Forget this account in the demo registry and re-show onboarding"
      >
        {resetting ? "Resetting…" : "Reset demo"}
      </button>
      <div className="ys-reset-hint ys-prose">
        Resets the in-memory demo registry for this wallet — your on-chain smart account is
        untouched; the onboarding re-appears so you can run the flow again.
      </div>
    </>
  );
}

function StepRow({ step, index }: { step: OnboardingStep; index: number }) {
  const mark =
    step.status === "done" ? "✓" : step.status === "error" ? "✕" : step.status === "active" ? "" : index;
  const dotClass =
    step.status === "done"
      ? "ys-step-dot done"
      : step.status === "active"
        ? "ys-step-dot active"
        : step.status === "error"
          ? "ys-step-dot error"
          : "ys-step-dot";
  return (
    <div className="ys-step">
      <div className={dotClass}>
        {step.status === "active" ? <span className="ys-step-ring" /> : mark}
      </div>
      <div className="ys-step-body">
        <div className="ys-step-title">{STEP_TITLES[step.key]}</div>
        <div className="ys-step-hint ys-prose">
          {step.detail ? (
            step.txHash ? (
              <a href={testnetTxUrl(step.txHash)} target="_blank" rel="noreferrer" className="ys-inline-link">
                {step.detail.length > 42 ? truncateAddress(step.detail, 8, 8) : step.detail} ↗
              </a>
            ) : (
              step.detail
            )
          ) : (
            STEP_HINTS[step.key]
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  accent,
  small,
}: {
  label: string;
  value: string;
  accent?: boolean;
  small?: boolean;
}) {
  return (
    <div className="ys-metric">
      <span className="ys-metric-label">{label}</span>
      <span
        className={[
          "ys-metric-value",
          accent ? "accent" : "",
          small ? "small" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {value}
      </span>
    </div>
  );
}
