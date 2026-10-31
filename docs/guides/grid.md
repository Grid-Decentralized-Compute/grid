# GRID

GRID is Grid's work token: the stake a host puts up to be allowed to earn on the network. It is not used to pay for compute: rentals and swarm jobs are always paid in ETH, and renters never need GRID.

## Four roles

| Role | What it means | Status |
| --- | --- | --- |
| Stake to work | No bond, no serving. A host locks GRID to take swarm work and to rent out machines past its trial, and loses part of it if it cheats. | Live |
| Pay less when staked | A bonded host keeps 99% of what it earns instead of 98%. | Live |
| Usage burns it | The protocol's fee income buys GRID and burns it, so a busy network removes coins from supply. First as a stated treasury policy, then done by a contract once the Uniswap pool exists, so nobody can switch it off. | Policy at launch, on-chain after graduation |
| Holders govern it | The bond size, the fee discount, the slasher and the burn share are set by a multisig today and by a vote of GRID holders later. | After the audit |

## What the bond does

* **Required after the trial.** A host needs no bond for its first 30 days, but each direct rental is capped at 0.01 ETH until it bonds. Swarm work needs a bond whenever bonding is on.
* **Locked while working.** A bond cannot start unbonding while one of the host's rentals is running.
* **Slow to leave.** Unbonding takes seven days.
* **At stake.** Part of a bond can be burned if the host is proven to have cheated a renter. Swarm tie-breaks record faults on-chain as evidence.
* **Backable.** Anyone can bond on behalf of a host they trust with `bondFor`; the bond then belongs to the host.
* **Cheaper to work.** The protocol fee on a host's earnings is 1% while bonded and 2% otherwise.

## Planned

In the order they are likely to ship, after the independent audit:

* **A bond that scales with activity.** A host that earned more last month must hold more GRID, so a growing network locks more GRID rather than just more hosts.
* **A bigger bond to break ties.** The third host decides a dispute, so the tie-break slot will need a higher bond than a replica.
* **Fee tiers.** A lower fee again above a larger bond.
* **A first claim window.** New jobs claimable by higher-bonded hosts for the first moments, so capacity competes on stake.
* **Slashes that pay the victim.** Part of a slashed bond goes to the renter who proved the fraud, the rest is burned.
* **Backing hosts for a share.** Anyone can already bond for a host; hosts may be able to offer their backers a cut of their ETH earnings. Under consideration pending legal review.

## Launch

GRID launches on the Creora launchpad with the Robinhood Chain launch: a fixed supply of one billion, sold on a bonding curve and then traded in a Uniswap pool whose liquidity is locked for good. There is no team allocation; the supply goes to the curve and the pool, less the launchpad's own share. The launch is made from the Grid treasury, which is also where the launchpad's creator fees go. Until then, test networks use a stand-in token that anyone can mint.

## What GRID is not

GRID gives no share of revenue or profit and no claim on anyone. Governance by holders is planned, not live. It may lose some or all of its value. Nothing in these docs is an offer to buy or sell it, or advice to do so.
