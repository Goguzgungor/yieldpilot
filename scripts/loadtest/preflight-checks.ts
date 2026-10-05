/** Pure preflight evaluation — preflight.ts gathers the facts, this decides. */
export interface PreflightFacts {
  mongoDb: string | undefined;
  /** true, or the error message of the insert+delete probe. */
  mongoWritable: true | string;
  /** true when the server's /api/activity shows a nonce row this shell wrote (see dbprobe.ts). */
  serverDb: true | string;
  /** G of AGENT_SIGNER_SECRET in this shell (.env.loadtest). */
  envAgent: string;
  /** agentPublicKey from the running server's /api/agent; null if unreachable. */
  serverAgent: string | null;
  agentXlm: number;
  faucetAdmin: string;
  sacAdmin: string;
  faucetAdminXlm: number;
  poolStatus: number;
  smartAccountWasm: boolean;
  rpcRetentionLedgers: number;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export function evaluatePreflight(f: PreflightFacts): Check[] {
  return [
    {
      name: "isolated Mongo db",
      ok: !!f.mongoDb && f.mongoDb !== "yieldseeker",
      detail: `MONGODB_DB=${f.mongoDb ?? "(unset → production db 'yieldseeker')"}`,
    },
    { name: "Mongo writable", ok: f.mongoWritable === true, detail: f.mongoWritable === true ? "insert+delete ok" : f.mongoWritable },
    { name: "server writes to this db", ok: f.serverDb === true, detail: f.serverDb === true ? "nonce row visible via /api/activity" : f.serverDb },
    {
      name: "server runs the load-test agent",
      ok: f.serverAgent === f.envAgent,
      detail: `server=${f.serverAgent ?? "unreachable"} env=${f.envAgent}`,
    },
    { name: "agent XLM ≥ 1000", ok: f.agentXlm >= 1000, detail: `${f.agentXlm} XLM` },
    { name: "faucet key is the USDC SAC admin", ok: f.faucetAdmin === f.sacAdmin, detail: `faucet=${f.faucetAdmin} sac.admin=${f.sacAdmin}` },
    { name: "faucet admin XLM ≥ 200", ok: f.faucetAdminXlm >= 200, detail: `${f.faucetAdminXlm} XLM` },
    { name: "exec pool accepts supply", ok: f.poolStatus <= 3, detail: `status=${f.poolStatus} (0/1 active, 2/3 on ice, ≥4 frozen)` },
    { name: "smart-account wasm installed", ok: f.smartAccountWasm, detail: f.smartAccountWasm ? "found" : "missing — testnet reset?" },
    {
      name: "RPC keeps ≥ 2 days of history",
      ok: f.rpcRetentionLedgers >= 34_560,
      detail: `${f.rpcRetentionLedgers} ledgers ≈ ${((f.rpcRetentionLedgers * 5) / 86_400).toFixed(1)} days`,
    },
  ];
}
