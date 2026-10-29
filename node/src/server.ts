import { createServer, type IncomingMessage } from "node:http";
import { verifyMessage } from "viem";
import { ACCESS_MESSAGE_TTL_SECONDS, accessMessage, type AccessRequest, type HealthInfo } from "@grid/shared";
import type { Chain } from "./chain";
import { log } from "./log";
import type { SessionManager } from "./sessions";

type Options = {
  port: number;
  machineId: bigint;
  name: string;
  version: string;
  chain: Chain;
  sessions: SessionManager;
};

/**
 * The node's public HTTP API. Renters call it directly (its URL is in the
 * on-chain metadata), so there is no central server between them and the host.
 *
 *   GET  /health            liveness + what this machine is
 *   POST /access/:rentalId  { ts, sig } signed by the renter -> SSH details
 */
export function startServer({ port, machineId, name, version, chain, sessions }: Options) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        const body: HealthInfo = {
          ok: true,
          machineId: machineId.toString(),
          name,
          busy: sessions.busy,
          mode: sessions.mode,
          now: Math.floor(Date.now() / 1000),
          version,
        };
        return send(200, body);
      }

      const match = url.pathname.match(/^\/access\/(\d+)$/);
      if (req.method === "POST" && match) {
        const rentalId = BigInt(match[1]);
        const { ts, sig } = (await readJson(req)) as Partial<AccessRequest>;
        if (typeof ts !== "number" || typeof sig !== "string") return send(400, { error: "body must be { ts, sig }" });
        if (Math.abs(Date.now() / 1000 - ts) > ACCESS_MESSAGE_TTL_SECONDS) return send(401, { error: "signature expired" });

        const rental = await chain.getRental(rentalId);
        if (rental.machineId !== machineId) return send(404, { error: "that rental is not on this machine" });
        if (rental.ended) return send(410, { error: "rental has ended" });

        const ok = await verifyMessage({
          address: rental.renter,
          message: accessMessage(rentalId, ts),
          signature: sig as `0x${string}`,
        }).catch(() => false);
        if (!ok) return send(401, { error: "signature does not match the renter" });

        const session = sessions.get(rentalId);
        if (!session) return send(409, { error: "session is starting, retry in a few seconds" });
        return send(200, session.access);
      }

      send(404, { error: "not found" });
    } catch (e) {
      send(500, { error: (e as Error).message });
    }
  });

  server.listen(port, () => log(`http api listening on :${port}`));
  return server;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error("body too large");
  }
  return raw ? JSON.parse(raw) : {};
}
