/**
 * Probe the locks on the routes that change the user registry, against a
 * running server (no Mongo needed; nothing on-chain):
 *   - /api/reset answers 404 without RESET_KEY, 401 without the key;
 *   - POST / DELETE /api/register need the owner's SEP-53 signature: unsigned,
 *     foreign, stale and wrong-action signatures get 401, the owner's passes.
 *
 *   AGENT_LOOP_ENABLED=0 npx next start -p 3963          # RESET_KEY unset
 *   npx tsx scripts/probe-owner-auth.ts http://127.0.0.1:3963
 *   # with RESET_KEY=k on the server: npx tsx scripts/probe-owner-auth.ts <url> k
 */
import { Keypair } from "@stellar/stellar-sdk";
import { signOwnerMessage } from "../src/lib/ownerAuth";
import { ownerMessage } from "../src/lib/ownerMessage";

const BASE = process.argv[2];
const resetKey = process.argv[3];
const owner = Keypair.random();
const reg = { owner: owner.publicKey(), smartWallet: "CDNE56FVWAHIMNTAUOKM3TFJCY6YM4OWOFRPJYQXZB2WRIHT5CS77PBB", poolRuleId: 1, usdcRuleId: 2 };
async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  return `${r.status} ${(await r.text()).slice(0, 110)}`;
}
const signed = (kp: Keypair, r: Parameters<typeof ownerMessage>[0]) => {
  const signedAt = new Date().toISOString();
  return { signedAt, signature: signOwnerMessage(kp, ownerMessage(r, signedAt)) };
};
const show = (label: string, v: string) => console.log(`${label.padEnd(44)} ${v}`);
(async () => {
  show("GET  /api/reset (no key)", await req("GET", "/api/reset"));
  show("POST /api/reset (no key)", await req("POST", "/api/reset"));
  if (resetKey) {
    show("GET  /api/reset (wrong key)", await req("GET", "/api/reset", undefined, { authorization: "Bearer nope" }));
    show("GET  /api/reset (right key)", await req("GET", "/api/reset", undefined, { authorization: `Bearer ${resetKey}` }));
    return;
  }
  show("POST /api/register unsigned", await req("POST", "/api/register", reg));
  show("POST /api/register signed by someone else", await req("POST", "/api/register", { ...reg, ...signed(Keypair.random(), { action: "register", ...reg }) }));
  const old = new Date(Date.now() - 10 * 60_000).toISOString();
  show("POST /api/register signed 10 min ago", await req("POST", "/api/register", { ...reg, signedAt: old, signature: signOwnerMessage(owner, ownerMessage({ action: "register", ...reg }, old)) }));
  show("POST /api/register signed by the owner", await req("POST", "/api/register", { ...reg, ...signed(owner, { action: "register", ...reg }) }));
  show("GET  /api/users?owner", await req("GET", `/api/users?owner=${owner.publicKey()}`));
  show("DELETE /api/register unsigned", await req("DELETE", "/api/register", { owner: owner.publicKey() }));
  show("DELETE ?owner= (old form)", await req("DELETE", `/api/register?owner=${owner.publicKey()}`));
  show("DELETE with the register signature", await req("DELETE", "/api/register", { owner: owner.publicKey(), ...signed(owner, { action: "register", ...reg }) }));
  show("DELETE signed by the owner", await req("DELETE", "/api/register", { owner: owner.publicKey(), ...signed(owner, { action: "unregister", owner: owner.publicKey() }) }));
  show("GET  /api/users?owner (after)", await req("GET", `/api/users?owner=${owner.publicKey()}`));
})();
