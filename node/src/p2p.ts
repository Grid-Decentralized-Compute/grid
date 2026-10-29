import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { autoNAT } from "@libp2p/autonat";
import { circuitRelayServer, circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { dcutr } from "@libp2p/dcutr";
import { gossipsub } from "@libp2p/gossipsub";
import { identify, identifyPush } from "@libp2p/identify";
import type { PrivateKey } from "@libp2p/interface";
import { kadDHT } from "@libp2p/kad-dht";
import { peerIdFromString } from "@libp2p/peer-id";
import { ping } from "@libp2p/ping";
import { tcp } from "@libp2p/tcp";
import { lpStream } from "@libp2p/utils";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2p } from "libp2p";
import { verifyMessage } from "viem";
import {
  HEARTBEAT_SECONDS,
  HEARTBEAT_TTL_SECONDS,
  heartbeatMessage,
  P2P_DHT_PROTOCOL,
  P2P_HEARTBEAT_TOPIC,
  P2P_HTTP_PROTOCOL,
  type PeerHeartbeat,
} from "@grid/shared";
import type { Chain } from "./chain";
import type { Config } from "./config";
import { log } from "./log";

/** An HTTP request or response carried over a libp2p stream between a relay and a peer. */
export type WireRequest = { method: string; path: string; body: string };
export type WireResponse = { status: number; contentType: string; body: string };
export type HttpHandler = (req: WireRequest) => Promise<WireResponse>;

/** Largest request or response the gateway carries (a task output is at most 1 MB). */
const MAX_FRAME = 2 * 1024 * 1024;
const FORWARD_TIMEOUT_MS = 15_000;

type Heard = Omit<PeerHeartbeat, "sig"> & { seen: number };

/**
 * The node's place in the Grid peer-to-peer network.
 *
 * - Identity: an ed25519 libp2p key kept in the state directory, bound to the host wallet by the
 *   signed heartbeats below.
 * - Transport: TCP, encrypted with Noise, multiplexed with yamux. Nodes behind NAT are reachable
 *   through circuit relays and upgrade to direct connections by hole punching (DCUtR) when they can.
 * - Discovery: peers listed on-chain are dialled first; a Kademlia DHT on /grid/kad/1.0.0 finds the rest.
 * - Presence: every node gossips a heartbeat on grid/heartbeat/1, signed by its wallet.
 * - Gateway: a relay forwards renters' HTTP requests for /p2p/<peer>/... to that peer over a
 *   libp2p stream, so a machine with no public address can still serve its swarm results.
 */
export class P2P {
  private readonly heard = new Map<string, Heard>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  private constructor(
    private readonly config: Config,
    private readonly chain: Chain,
    readonly node: Awaited<ReturnType<typeof createNode>>,
  ) {}

  static async start(config: Config, chain: Chain): Promise<P2P> {
    const node = await createNode(config, await loadKey(config.stateDir));
    const p2p = new P2P(config, chain, node);
    node.services.pubsub.subscribe(P2P_HEARTBEAT_TOPIC);
    node.services.pubsub.addEventListener("message", (evt) => {
      if (evt.detail.topic !== P2P_HEARTBEAT_TOPIC) return;
      void p2p.onHeartbeat(evt.detail.data, evt.detail.type === "signed" ? evt.detail.from.toString() : null);
    });
    node.addEventListener("peer:connect", (evt) => log(`p2p: connected to ${short(evt.detail.toString())}`));
    log(`p2p: peer ${p2p.peerId} listening on ${node.getMultiaddrs().map(String).join(", ") || "(relay only)"}`);
    return p2p;
  }

  get peerId(): string {
    return this.node.peerId.toString();
  }

  /** Addresses other peers can dial, each ending in /p2p/<this peer>. */
  get addrs(): string[] {
    return this.config.p2pAnnounce.map((a) => `${a}/p2p/${this.peerId}`);
  }

  /** Dials peers by multiaddr, ignoring ones that fail or are this node. */
  async dial(addrs: string[]) {
    await Promise.all(
      addrs
        .filter((a) => !a.endsWith(`/p2p/${this.peerId}`))
        .map((a) =>
          this.node.dial(multiaddr(a), { signal: AbortSignal.timeout(8_000) }).catch((e: Error) => {
            log(`p2p: could not reach ${a}: ${e.message.split("\n")[0]}`);
          }),
        ),
    );
  }

  /** A relay this node is connected to, by its public URL (for nodes without one of their own). */
  connectedRelay(): string | null {
    const connected = new Set(this.node.getPeers().map(String));
    for (const h of this.online()) if (h.relay && connected.has(h.peer)) return h.relay;
    return null;
  }

  /** Peers heard from within HEARTBEAT_TTL_SECONDS, this node included. */
  online(): Heard[] {
    const cutoff = Date.now() / 1000 - HEARTBEAT_TTL_SECONDS;
    return [...this.heard.values()].filter((h) => h.seen >= cutoff);
  }

  /** Answers HTTP requests that relays forward to this node. */
  async serveHttp(handler: HttpHandler) {
    await this.node.handle(P2P_HTTP_PROTOCOL, async (stream) => {
      const lp = lpStream(stream, { maxDataLength: MAX_FRAME });
      try {
        const req = JSON.parse(new TextDecoder().decode((await lp.read({ signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS) })).subarray())) as WireRequest;
        const res = await handler(req);
        await lp.write(new TextEncoder().encode(JSON.stringify(res)));
        await stream.close();
      } catch (e) {
        stream.abort(e as Error);
      }
    });
  }

  /** Relay side of the gateway: sends one request to `peer` and returns its answer. */
  async forward(peer: string, req: WireRequest): Promise<WireResponse> {
    const signal = AbortSignal.timeout(FORWARD_TIMEOUT_MS);
    const stream = await this.node.dialProtocol(peerIdFromString(peer), P2P_HTTP_PROTOCOL, { signal });
    const lp = lpStream(stream, { maxDataLength: MAX_FRAME });
    await lp.write(new TextEncoder().encode(JSON.stringify(req)), { signal });
    const res = JSON.parse(new TextDecoder().decode((await lp.read({ signal })).subarray())) as WireResponse;
    await stream.close().catch(() => {});
    return res;
  }

  /** Starts announcing this node every HEARTBEAT_SECONDS with whatever `state` returns. */
  startHeartbeats(state: () => Pick<PeerHeartbeat, "name" | "endpoint" | "relay" | "direct" | "busy">) {
    const beat = async () => {
      const body: Omit<PeerHeartbeat, "sig"> = {
        v: 1,
        peer: this.peerId,
        host: this.chain.address,
        ...state(),
        ts: Math.floor(Date.now() / 1000),
      };
      const sig = await this.chain.account.signMessage({ message: heartbeatMessage(body) });
      this.heard.set(this.peerId, { ...body, seen: body.ts });
      const data = new TextEncoder().encode(JSON.stringify({ ...body, sig }));
      await this.node.services.pubsub.publish(P2P_HEARTBEAT_TOPIC, data).catch(() => {
        // nobody subscribed yet: the next beat will reach them
      });
    };
    void beat();
    this.heartbeatTimer = setInterval(() => void beat(), HEARTBEAT_SECONDS * 1000);
  }

  async stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.node.stop();
  }

  /** Accepts a heartbeat only when the wallet signature checks out and the gossip sender is that peer. */
  private async onHeartbeat(data: Uint8Array, from: string | null) {
    try {
      const msg = JSON.parse(new TextDecoder().decode(data)) as PeerHeartbeat;
      if (msg.v !== 1 || msg.peer !== from) return;
      const { sig, ...body } = msg;
      if (Math.abs(Date.now() / 1000 - body.ts) > HEARTBEAT_TTL_SECONDS) return;
      const ok = await verifyMessage({ address: body.host, message: heartbeatMessage(body), signature: sig });
      if (!ok) return;
      const isNew = !this.heard.has(body.peer);
      this.heard.set(body.peer, { ...body, seen: Math.floor(Date.now() / 1000) });
      if (isNew) log(`p2p: heard ${body.name} (${short(body.peer)})${body.relay ? ", a relay" : ""}`);
    } catch {
      // malformed heartbeat: ignore it
    }
  }
}

async function createNode(config: Config, privateKey: PrivateKey) {
  return createLibp2p({
    privateKey,
    addresses: {
      listen: [`/ip4/0.0.0.0/tcp/${config.p2pPort}`, "/p2p-circuit"],
      announce: config.p2pAnnounce,
    },
    transports: [tcp(), circuitRelayTransport()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      identifyPush: identifyPush(),
      ping: ping(),
      autoNAT: autoNAT(),
      dcutr: dcutr(),
      // Public nodes answer DHT queries; nodes behind NAT only ask.
      dht: kadDHT({ protocol: P2P_DHT_PROTOCOL, clientMode: !config.publicUrl }),
      pubsub: gossipsub({ allowPublishToZeroTopicPeers: true, emitSelf: false }),
      ...(config.relay ? { relay: circuitRelayServer({ reservations: { maxReservations: 256 } }) } : {}),
    },
  });
}

/** The node's libp2p key, created once and kept next to the rest of its state. */
async function loadKey(stateDir: string): Promise<PrivateKey> {
  const file = join(stateDir, "peer.key");
  if (existsSync(file)) return privateKeyFromProtobuf(readFileSync(file));
  const key = await generateKeyPair("Ed25519");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(file, privateKeyToProtobuf(key), { mode: 0o600 });
  return key;
}

const short = (peer: string) => `${peer.slice(0, 8)}…${peer.slice(-4)}`;
