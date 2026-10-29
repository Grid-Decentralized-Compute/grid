# How Grid is decentralized

Grid has no servers of its own. The market and the money are contracts on Robinhood Chain, the compute is hosts' machines, and the machines find and reach each other over a peer-to-peer network. This page covers who runs each part, what each party can and cannot do, and where the limits are.

![The Grid network: renters, hosts and a relay connected peer to peer, with listings, escrow, result hashes and bonds held by contracts on Robinhood Chain](.gitbook/assets/network.png)

## Who runs what

| Part | Run by | If it stops |
| --- | --- | --- |
| Market and escrow | `GridMarket` and `SwarmMarket` on Robinhood Chain. No owner, no fee, not upgradeable | Nobody can switch them off or move the ETH they hold. They are as available as Robinhood Chain |
| Compute | Hosts, on machines they own, at prices they set | A direct rental ends and the unused time is refunded. A swarm task moves to another host when its lease runs out |
| Discovery | Every node: listings on-chain first, then a Kademlia DHT | There is no directory to take down. Any listed node can introduce a new one |
| Relays | Hosts who choose to run one | A machine behind a router moves to another relay |
| Bond | `StakeRegistry`. Its owner, meant to be a multisig, sets the minimum bond and who may slash | It cannot touch rental payments, which stay in the markets |
| The site | Static files that read the chain and talk to nodes. Anyone can build and host a copy | Use another copy, or call the contracts directly |

## What each party can and cannot do

**A host** can refuse work, go offline or set any price. On a direct rental it controls the machine, so it can see what you run there. In a swarm job it can return a wrong result, but the second run disagrees, a third host breaks the tie, and the wrong host goes unpaid with a fault recorded against it. It can never collect more than the minutes started or the runs it completed.

**A renter** can end a rental at any time and gets the unused time back. It cannot take back what a host has already earned.

**A relay** passes requests between renters and machines behind routers. It can read what it forwards. It cannot change a swarm result without the hash check failing.

**The `StakeRegistry` owner** can change the minimum bond, the slasher and the market the registry listens to. It cannot touch the ETH held by the markets.

**The site** builds transactions for your wallet to sign. It never holds funds or keys, and your wallet shows every transaction before it is sent.

**Nobody** can pause the markets, change their rules or move the ETH they hold.

## Limits

* **The chain.** Grid is only as available and as hard to censor as Robinhood Chain.
* **Two replicas.** One address cannot take both runs of a task, but one person with two addresses could agree with themselves. Replication raises the cost of cheating without ruling it out; bonds and recorded faults make a second attempt expensive.
* **Direct rentals trust the host.** The machine is theirs. Do not put anything on a rented machine that you would not hand to its owner.
* **Swarm jobs are public.** Inputs are published on-chain, and anyone who knows the job can fetch its outputs.
* **Bootstrapping.** A new node finds its first peers through the listings on-chain or `GRID_BOOTSTRAP`. Machines behind routers depend on the relays that exist, so the network is sturdier the more hosts run one.
