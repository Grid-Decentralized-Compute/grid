# Node HTTP API

Every node answers these routes. A node's address is published in its listing; for a node behind a router that address is a relay's gateway, `<relay>/p2p/<peer id>`, which answers the same routes on the node's behalf. All routes allow cross-origin requests.

## Routes

### `GET /health`

Liveness and identity.

```json
{ "ok": true, "machineId": "2", "name": "atlas", "busy": false, "mode": "docker", "now": 1793293205, "version": "0.0.1" }
```

### `GET /peers`

Peers heard on the network in the last minute.

```json
{ "self": "12D3KooW…", "peers": [{ "peer": "12D3KooW…", "host": "0x…", "name": "atlas", "endpoint": "…", "relay": null, "direct": true, "busy": false, "ts": 1793293205, "seen": 1793293206 }] }
```

### `POST /access/:rentalId`

Lets the renter's SSH key into a direct rental. Logins are by key only: no password exists. The body is `{ "ts": <unix seconds>, "sig": "0x…", "key": "ssh-ed25519 AAAA…" }`, where `key` is the renter's SSH public key (type and base64, no comment) and `sig` is the renter wallet's signature (EIP-191) of

```
grid-access
chain:<chain id>
market:<GridMarket address, lowercase>
rental:<rentalId>
ssh-key:<key>
ts:<ts>
```

made within two minutes of the node's clock. Naming the chain and market means a signature cannot be replayed against another deployment, and signing the key means nobody between the renter and the node can swap in a key of their own. The node checks the signature against the renter recorded on-chain, adds the key to the rental's `authorized_keys` (at most 10 keys per rental), allows 30 attempts a minute per client and never answers with internal error details. Relays do not forward this route.

The reply carries the container's SSH host keys, so the renter's client can check it reached the real machine. Clients must check the reply field by field and build the SSH command themselves from `host`, `port` and `user` (`parseAccessInfo`, `sshCommand` and `knownHostsLine` in `@grid/shared`).

```json
{ "rentalId": "0", "host": "gpu.example.com", "port": 2222, "user": "grid", "hostKeys": ["ssh-ed25519 AAAA…"], "command": "ssh -p 2222 grid@gpu.example.com", "endsAt": 1793296805 }
```

A 409 means the container is still starting; try again a few seconds later.

### `GET /results/:swarm/:job/:task`

The output of a swarm task this node ran, as plain text. Check it against the task's hash on-chain: `keccak256(output) == result`.

### `* /p2p/:peer/<route>`

Relays only. Any route above, answered by that peer over libp2p.

## Errors

Errors are JSON, `{ "error": "…" }`.

| Status | Meaning |
| --- | --- |
| 400 | Malformed body |
| 401 | Signature wrong or expired |
| 404 | Unknown route, or no output for that task |
| 409 | The rental's session is still starting |
| 410 | The rental has ended |
| 502 | A relay could not reach the peer |
