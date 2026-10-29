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

The SSH login for a direct rental. The body is `{ "ts": <unix seconds>, "sig": "0x…" }`, where `sig` is the renter wallet's signature (EIP-191) of `grid-access:<rentalId>:<ts>`, made within the last five minutes. The node checks it against the renter recorded on-chain.

```json
{ "rentalId": "0", "host": "gpu.example.com", "port": 2222, "user": "grid", "password": "…", "command": "ssh -p 2222 grid@gpu.example.com", "endsAt": 1793296805 }
```

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
