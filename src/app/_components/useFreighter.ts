"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Freighter wallet integration (client-only). Uses @stellar/freighter-api v6,
 * whose calls all resolve to objects carrying an optional `error` string:
 *   isConnected()  -> { isConnected: boolean, error?: string }
 *   requestAccess()-> { address: string, error?: string }
 *   getAddress()   -> { address: string, error?: string }
 *   getNetwork()   -> { network: string, networkPassphrase: string, error?: string }
 *
 * The module is dynamically imported inside the handlers so it never runs during
 * SSR / `next build` (it touches `window`/the injected extension).
 */
export interface FreighterState {
  installed: boolean | null; // null = not yet checked
  address: string | null;
  network: string | null;
  connecting: boolean;
  error: string | null;
}

// Pre-rename key, kept so a disconnect a user already chose still holds.
const DISCONNECT_KEY = "yieldseeker:wallet-disconnected";

export function useFreighter() {
  const [state, setState] = useState<FreighterState>({
    installed: null,
    address: null,
    network: null,
    connecting: false,
    error: null,
  });

  // Detect the extension on mount, and silently restore the address if the app
  // is already on Freighter's allow-list (unless the user explicitly disconnected).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const api = await import("@stellar/freighter-api");
        const conn = await api.isConnected();
        const installed = Boolean(conn?.isConnected);
        if (cancelled) return;
        if (!installed) {
          setState((s) => ({ ...s, installed: false }));
          return;
        }
        const userDisconnected =
          typeof window !== "undefined" && window.localStorage.getItem(DISCONNECT_KEY) === "1";
        if (userDisconnected) {
          setState((s) => ({ ...s, installed: true }));
          return;
        }
        // Lightweight read — returns "" when not yet authorized.
        const addrObj = await api.getAddress();
        const address = addrObj?.error ? "" : addrObj?.address ?? "";
        let network: string | null = null;
        if (address) {
          const net = await api.getNetwork();
          network = net?.error ? null : net?.network ?? null;
        }
        if (cancelled) return;
        setState((s) => ({
          ...s,
          installed: true,
          address: address || null,
          network,
        }));
      } catch {
        if (!cancelled) setState((s) => ({ ...s, installed: false }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async () => {
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      const api = await import("@stellar/freighter-api");
      const conn = await api.isConnected();
      if (!conn?.isConnected) {
        setState((s) => ({ ...s, installed: false, connecting: false }));
        return;
      }
      const access = await api.requestAccess();
      if (access?.error || !access?.address) {
        setState((s) => ({
          ...s,
          installed: true,
          connecting: false,
          error: access?.error || "Access denied",
        }));
        return;
      }
      const net = await api.getNetwork();
      if (typeof window !== "undefined") window.localStorage.removeItem(DISCONNECT_KEY);
      setState({
        installed: true,
        address: access.address,
        network: net?.error ? null : net?.network ?? null,
        connecting: false,
        error: null,
      });
    } catch (e) {
      setState((s) => ({
        ...s,
        connecting: false,
        error: (e as Error)?.message || "Failed to connect",
      }));
    }
  }, []);

  // Freighter has no revoke API; we just forget the address locally and remember
  // the choice so the next mount doesn't silently re-attach.
  const disconnect = useCallback(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(DISCONNECT_KEY, "1");
    setState((s) => ({ ...s, address: null, network: null, error: null }));
  }, []);

  return { ...state, connect, disconnect };
}
