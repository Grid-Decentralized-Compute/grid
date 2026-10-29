import { createServer, type IncomingMessage } from "node:http";
import { verifyMessage } from "viem";
import {
  ACCESS_MESSAGE_TTL_SECONDS,
  accessMessage,
  type AccessRequest,
  type HealthInfo,
  type PeersInfo,
} from "@grid/shared";
import type { Chain } from "./chain";
import { log } from "./log";
import type { HttpHandler, P2P, WireRequest, WireResponse } from "./p2p";
import type { SessionManager } from "./sessions";
import type { SwarmWorker } from "./swarm";

type Options = {
  port: number;
  machineId: bigint;
  name: string;
  version: string;
  chain: Chain;
  sessions: SessionManager;
  swarm: SwarmWorker | null;
  p2p: P2P;
  /** This node relays: it forwards /p2p/<peer>/... to that peer. */
  relay: boolean;
  /** What renters sign is bound to this chain and market (see accessMessage). */
  chainId: number;
  market: string;
  /** Address to listen on: 127.0.0.1 when the API is only reached through a local tunnel. */
  bindHost: string;
};

/** Access attempts allowed per client per minute (each can cost an RPC call). */
const ACCESS_PER_MINUTE = 30;

const MAX_BODY = 10_000;

/**
 * The node's API. The same routes answer plain HTTP (renters calling this node directly) and
 * requests a relay forwards over libp2p (renters reaching a node that has no public address).
 *
 *   GET  /health                     liveness + what this machine is
 *   GET  /peers                      peers heard on the network in the last minute
 *   POST /access/:rentalId           { ts, sig } signed by the renter -> SSH details
 *   GET  /results/:swarm/:job/:task  output of a swarm task this host ran (the renter checks
 *                                    it against the hash on-chain, so it needs no auth)
 *   *    /p2p/:peer/<route>          relays only: the same routes, answered by that peer
 */
export function startServer(options: Options) {
  const handle = router(options);
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // Every answer is data, never a page: nothing served here can run script in a browser.
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  };
  const attempts = new Map<string, { windowStart: number; count: number }>();

  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    let reply: WireResponse;
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (/^(\/p2p\/[^/]+)?\/access\//.test(url.pathname) && !allowAttempt(attempts, clientKey(req))) {
        throw new HttpError(429, "too many attempts, wait a minute");
      }
      const body = req.method === "POST" ? await readBody(req) : "";
      const via = url.pathname.match(/^\/p2p\/([1-9A-HJ-NP-Za-km-z]{40,64})(\/.*)$/);
      if (via) {
        reply = options.relay
          ? await gateway(options.p2p, via[1], { method: req.method ?? "GET", path: via[2], body })
          : json(404, { error: "this node does not relay" });
      } else {
        reply = await handle({ method: req.method ?? "GET", path: url.pathname, body });
      }
    } catch (e) {
      // Internal errors can carry the RPC URL (and its API key): log them, never send them.
      if (e instanceof HttpError) reply = json(e.status, { error: e.message });
      else {
        log(`http: ${req.method} ${(req.url ?? "").slice(0, 100)} failed: ${(e as Error).message.split("\n")[0]}`);
        reply = json(500, { error: "internal error" });
      }
    }
    try {
      res.writeHead(reply.status, { ...headers, "Content-Type": reply.contentType });
      res.end(reply.body);
    } catch {
      res.destroy();
    }
  });
  // Slow or idle clients cannot hold connections open for long.
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 3_000;
  server.maxConnections = 256;

  // Requests forwarded by a relay reach the same routes.
  void options.p2p.serveHttp(handle);

  server.listen(options.port, options.bindHost, () =>
    log(`http api listening on ${options.bindHost}:${options.port}${options.relay ? " (relaying)" : ""}`),
  );
  return server;
}

function router({ machineId, name, version, chain, sessions, swarm, p2p, chainId, market }: Options): HttpHandler {
  return async ({ method, path, body }) => {
    if (method === "GET" && (path === "/" || path === "/health")) {
      const health: HealthInfo = {
        ok: true,
        machineId: machineId.toString(),
        name,
        busy: sessions.busy,
        mode: sessions.mode,
        now: Math.floor(Date.now() / 1000),
        version,
      };
      return json(200, health);
    }

    if (method === "GET" && path === "/peers") {
      const peers: PeersInfo = { self: p2p.peerId, peers: p2p.online() };
      return json(200, peers);
    }

    const result = path.match(/^\/results\/(0x[0-9a-fA-F]{40})\/(\d+)\/(\d+)$/);
    if (method === "GET" && result) {
      const output = swarm?.readResult(result[1], result[2], result[3]) ?? null;
      if (output === null) return json(404, { error: "this host has no output for that task" });
      return { status: 200, contentType: "text/plain; charset=utf-8", body: output };
    }

    const access = path.match(/^\/access\/(\d+)$/);
    if (method === "POST" && access) {
      const rentalId = BigInt(access[1]);
      let parsed: Partial<AccessRequest>;
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        return json(400, { error: "body must be JSON" });
      }
      const { ts, sig } = parsed;
      if (!Number.isInteger(ts) || typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) {
        return json(400, { error: "body must be { ts, sig }" });
      }
      if (Math.abs(Date.now() / 1000 - ts!) > ACCESS_MESSAGE_TTL_SECONDS) return json(401, { error: "signature expired" });
      const message = accessMessage({ chainId, market, rentalId, ts: ts! });
      const signedBy = (address: `0x${string}`) =>
        verifyMessage({ address, message, signature: sig as `0x${string}` }).catch(() => false);

      // A running session already knows its renter: answer without touching the chain.
      const session = sessions.get(rentalId);
      if (session) {
        if (!(await signedBy(session.renter))) return json(401, { error: "signature does not match the renter" });
        return json(200, session.access);
      }

      const rental = await chain.getRental(rentalId);
      if (rental.machineId !== machineId) return json(404, { error: "that rental is not on this machine" });
      if (rental.ended) return json(410, { error: "rental has ended" });
      if (!(await signedBy(rental.renter))) return json(401, { error: "signature does not match the renter" });
      return json(409, { error: "session is starting, retry in a few seconds" });
    }

    return json(404, { error: "not found" });
  };
}

/**
 * Forwards a renter's request to a peer over libp2p. Only public, read-only routes are passed on.
 * POST /access is not: a relay reads everything it forwards, and that reply carries an SSH
 * password. Peers behind a relay take swarm work only, so they never have a rental to open.
 */
async function gateway(p2p: P2P, peer: string, req: WireRequest): Promise<WireResponse> {
  const allowed = req.method === "GET" && /^\/(health|peers|results\/0x[0-9a-fA-F]{40}\/\d+\/\d+)$/.test(req.path);
  if (!allowed) return json(404, { error: "not found" });
  try {
    return await p2p.forward(peer, req);
  } catch (e) {
    // The reason (refused, timed out) would let anyone probe which peers sit where: keep it local.
    log(`gateway: ${peer.slice(0, 12)}… unreachable: ${(e as Error).message.split("\n")[0]}`);
    return json(502, { error: "peer unreachable" });
  }
}

const json = (status: number, body: unknown): WireResponse => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) throw new Error("body too large");
  }
  return raw;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Who is asking, for rate limiting. Behind a local Cloudflare tunnel every request comes from
 * 127.0.0.1, so the tunnel's CF-Connecting-IP header is used then, and only then (anyone else
 * could set it).
 */
function clientKey(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? "?";
  const viaTunnel = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  const forwarded = req.headers["cf-connecting-ip"];
  return viaTunnel && typeof forwarded === "string" ? forwarded.slice(0, 64) : remote;
}

function allowAttempt(attempts: Map<string, { windowStart: number; count: number }>, key: string): boolean {
  const now = Date.now();
  if (attempts.size > 10_000) attempts.clear();
  const a = attempts.get(key);
  if (!a || now - a.windowStart > 60_000) {
    attempts.set(key, { windowStart: now, count: 1 });
    return true;
  }
  a.count++;
  return a.count <= ACCESS_PER_MINUTE;
}
