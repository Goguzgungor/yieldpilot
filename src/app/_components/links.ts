// Canonical outbound links for a pool. Opened in a new tab from the analysis
// panel.

/**
 * Blend mainnet UI deep link. The Blend app is an IPFS-hosted SPA; its dashboard
 * route accepts a `poolId` query param to focus a specific pool. This deep-link
 * path is best-effort (the SPA can change its client routing without notice); if
 * Blend ever stops honoring the param it still lands on the live dashboard.
 */
export function blendPoolUrl(poolId: string): string {
  return `https://mainnet.blend.capital/dashboard?poolId=${encodeURIComponent(poolId)}`;
}

/**
 * stellar.expert contract explorer (public / mainnet). Reliable, stable URL shape
 * for any Soroban contract id on the public network. Used for scanned MAINNET pools.
 */
export function stellarExpertUrl(poolId: string): string {
  return `https://stellar.expert/explorer/public/contract/${encodeURIComponent(poolId)}`;
}

// ── Testnet explorer helpers ──────────────────────────────────────────────────
// Used for per-user TESTNET artifacts: smart accounts, supply/rebalance tx hashes,
// and the exec pool / USDC contract ids.

/**
 * stellar.expert contract explorer (testnet). Use for any Soroban contract id
 * deployed on the Stellar testnet, e.g. a user's smart account `C…` or the
 * exec pool / USDC contract.
 */
export function testnetContractUrl(id: string): string {
  return `https://stellar.expert/explorer/testnet/contract/${encodeURIComponent(id)}`;
}

/**
 * stellar.expert transaction explorer (testnet). Use to link supply, rebalance,
 * and onboarding tx hashes that land on Stellar testnet.
 */
export function testnetTxUrl(hash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(hash)}`;
}

/**
 * stellar.expert account explorer (testnet). Use for G… Stellar account addresses
 * (e.g. the agent signer public key) on the testnet.
 */
export function testnetAccountUrl(addr: string): string {
  return `https://stellar.expert/explorer/testnet/account/${encodeURIComponent(addr)}`;
}

/** Where to send users who don't have the wallet extension (Varial, formerly Freighter) installed. */
export const VARIAL_INSTALL_URL = "https://varialwallet.com/";

/** The open-source repository (app, engine, contracts, SDK). */
export const REPO_URL = "https://github.com/Goguzgungor/yieldpilot";
/** The project's X account. */
export const X_URL = "https://x.com/AsteriaStellar";
