import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestJson } from "../../scripts/loadtest/http";

let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status: number, payload: string) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(payload);
      };
      if (req.url === "/echo") return send(200, JSON.stringify({ method: req.method, body: body ? JSON.parse(body) : null }));
      if (req.url === "/slow") return void setTimeout(() => send(200, '{"ok":true}'), 300);
      if (req.url === "/html") {
        res.writeHead(500);
        return res.end("<html>");
      }
      send(404, '{"error":"nope"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("requestJson", () => {
  it("sends a JSON body and parses the JSON answer", async () => {
    expect(await requestJson("POST", `${base}/echo`, { a: 1 })).toEqual({ status: 200, data: { method: "POST", body: { a: 1 } } });
  });
  it("keeps the status when the body is not JSON", async () => {
    expect(await requestJson("GET", `${base}/html`)).toEqual({ status: 500, data: null });
  });
  it("maps an unreachable server to status 0 + ECONNREFUSED instead of throwing", async () => {
    expect(await requestJson("GET", "http://127.0.0.1:1/x")).toEqual({ status: 0, data: null, code: "ECONNREFUSED" });
  });
  it("times out to status 0 + ETIMEDOUT, but waits indefinitely with timeoutMs 0", async () => {
    expect(await requestJson("GET", `${base}/slow`, undefined, 50)).toEqual({ status: 0, data: null, code: "ETIMEDOUT" });
    expect(await requestJson("GET", `${base}/slow`, undefined, 0)).toEqual({ status: 200, data: { ok: true } });
  });
});
