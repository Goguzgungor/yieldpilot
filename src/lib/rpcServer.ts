import { rpc, xdr } from "@stellar/stellar-sdk";

/**
 * `rpc.Server.getLatestLedger` in SDK 15.1 decodes the ledger header and close
 * meta, and fails on any XDR newer than the SDK: testnet's Protocol 30 broke it
 * on 2026-11-08 ("XDR Read Error: unknown StellarValueType member for value 3"),
 * which stopped onboarding step II and the agent's supply auth. Every caller
 * here needs only `sequence`, so the header and meta are decoded only if read.
 */
export function latestLedgerFromRaw(raw: rpc.Api.RawGetLatestLedgerResponse): rpc.Api.GetLatestLedgerResponse {
  return {
    id: raw.id,
    sequence: raw.sequence,
    protocolVersion: raw.protocolVersion,
    closeTime: raw.closeTime,
    get headerXdr() {
      return xdr.LedgerHeader.fromXDR(raw.headerXdr, "base64");
    },
    get metadataXdr() {
      return xdr.LedgerCloseMeta.fromXDR(raw.metadataXdr, "base64");
    },
  };
}

/** Point `server.getLatestLedger` at the raw response (see {@link latestLedgerFromRaw}). */
export function withRawLatestLedger<T extends rpc.Server>(server: T): T {
  server.getLatestLedger = async () => latestLedgerFromRaw(await server._getLatestLedger());
  return server;
}

/** An `rpc.Server` that survives protocol upgrades the SDK doesn't know yet. */
export function createRpcServer(url: string, opts?: rpc.Server.Options): rpc.Server {
  return withRawLatestLedger(new rpc.Server(url, opts));
}
