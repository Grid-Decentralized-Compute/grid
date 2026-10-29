# The peer-to-peer network

Every node is a libp2p peer. Nodes find each other through the chain and a distributed hash table, prove who they are with signed heartbeats, and relay for machines that sit behind routers.

## Stack

| Layer | Choice |
| --- | --- |
| Transport | TCP, plus libp2p circuit relay v2 for peers that cannot be dialled directly |
| Security | Noise: every connection is encrypted and authenticated |
| Multiplexing | yamux |
| Identity | An ed25519 peer key per node, bound to the host wallet by signed heartbeats |
| Discovery | Peers listed on-chain first, then a Kademlia DHT on `/grid/kad/1.0.0` |
| NAT | AutoNAT detects reachability; DCUtR upgrades relayed connections to direct ones by hole punching |
| Presence | Gossipsub topic `grid/heartbeat/1`, one signed heartbeat per node every 15 seconds |

## Joining

1. The node loads or creates its peer key in its state directory.
2. It reads the machine listings on `GridMarket` and dials the libp2p addresses other hosts published there, plus any in `GRID_BOOTSTRAP`.
3. It lists its own machine with its peer ID and addresses, so the next node can find it the same way, and starts announcing itself.

Public nodes answer DHT queries; nodes behind routers only ask.

## Relays

A node with a public address and `GRID_RELAY=1` is a relay. A node without a public address keeps a connection open to one and publishes `<relay>/p2p/<peer id>` as its address.

When a renter calls that address, the relay opens a libp2p stream to the peer on `/grid/http/1.0.0`, passes the request along as a length-prefixed JSON message and returns the answer. Only the public routes are passed on: health, peers, swarm results and access requests.

A relay can read the requests it forwards. Swarm results are checked against on-chain hashes, so a relay cannot alter them unnoticed, but it can see them.

## Heartbeats

A heartbeat is JSON:

```json
{
  "v": 1,
  "peer": "12D3KooW…",
  "host": "0x7099…79C8",
  "name": "atlas",
  "endpoint": "https://relay.example/p2p/12D3KooW…",
  "relay": null,
  "direct": false,
  "busy": false,
  "ts": 1793293205,
  "sig": "0x…"
}
```

`sig` is the host wallet's signature (EIP-191) of `grid-heartbeat\n` followed by the JSON of every field before it. A node drops heartbeats whose signature does not match, whose gossip sender is a different peer, or that are more than a minute old. `GET /peers` on any node returns the ones it heard in the last minute; the site uses a relay's list to show how many peers are online.

## Ports

| Port | Default | Purpose |
| --- | --- | --- |
| `GRID_P2P_PORT` | 4001/tcp | libp2p |
| `GRID_PORT` | 7777/tcp | HTTP API |
| `GRID_SSH_PORT` | 2222/tcp | SSH into direct rentals |
