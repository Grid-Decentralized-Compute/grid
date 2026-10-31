# Grid

Decentralized compute network on Robinhood Chain.

Trustless batch compute has been tried for fifteen years and never worked, because the buyer had to be a human holding a token nobody wanted. Grid is built for a different buyer: an AI agent holding ETH. It posts a job, idle GPUs across the network run it, every task on two machines that have to agree before anyone is paid, and it pays for nothing else. Grid has no servers of its own: money is held by contracts on Robinhood Chain, the work happens on hosts' machines, and renters and hosts talk to each other directly or through relays run by other hosts. [How Grid is decentralized](decentralization.md) covers who runs each part and what each can and cannot do.

![The Grid network: renters, hosts and a relay connected peer to peer, with listings, escrow, result hashes and bonds held by contracts on Robinhood Chain](.gitbook/assets/network.png)

**Site:** [gridcompute.net](https://gridcompute.net) · **Source:** [github.com/Grid-Decentralized-Compute/grid](https://github.com/Grid-Decentralized-Compute/grid) · **X:** [@Grid_Compute](https://x.com/Grid_Compute)

## Two ways to rent

| | Swarm | Direct |
| --- | --- | --- |
| What you get | One job split into tasks, spread across many hosts | One whole machine with an SSH login |
| Billing | Per accepted run, unused runs refunded | Per started minute, unused time refunded |
| If a host goes offline | Its tasks move to other hosts | The session ends; you pay only for minutes started |
| Results | Each task checked by a second host against an on-chain hash, with a receipt | Whatever the machine produces |
| Best for | Rendering, batch inference, data processing, simulations, evals | Interactive work, training, notebooks |

Swarm is the main way to rent. Hosts pay a fixed protocol fee of 2% of what they earn (1% while bonded); renters pay the listed price.

## The parts

| Part | What it does |
| --- | --- |
| `GridMarket` | Machine listings, ETH escrow for direct rentals, settlement per started minute |
| `SwarmMarket` | Swarm jobs, task leases, result hashes, tie-breaks, refunds |
| `StakeRegistry` | The GRID bond hosts post to stay listed, unbonding and slashing |
| `Allowance` | A spending wallet for an AI agent: a daily cap, allowed contracts only, refunds kept out of the agent's reach |
| The node | The program a host runs: direct rentals, swarm work when idle, the peer-to-peer network |
| The network | libp2p: encrypted connections, a DHT, signed heartbeats, relays for machines behind routers |
| The site | Reads the contracts and talks to nodes. It holds nothing, and anyone can run their own |
| The MCP server and CLI | Grid as tools for AI agents and as a command line: find GPUs, run batch jobs, collect verified outputs. See [Grid for AI agents](guides/agents.md) |

## Status

Grid is experimental software. The contracts have not been audited. Nothing here is financial, investment, legal or tax advice. The source is MIT licensed.
