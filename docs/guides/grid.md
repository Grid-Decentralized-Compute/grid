# GRID

GRID is the bond hosts post to stay listed. It is not used to pay for compute: rentals and swarm jobs are always paid in ETH, and renters never need GRID.

## What the bond does

* **Required after the trial.** A host needs no bond for its first 30 days, but each direct rental is capped at 0.01 ETH until it bonds. Swarm work needs a bond whenever bonding is on.
* **Locked while working.** A bond cannot start unbonding while one of the host's rentals is running.
* **Slow to leave.** Unbonding takes seven days.
* **At stake.** Part of a bond can be burned if the host is proven to have cheated a renter. Swarm tie-breaks record faults on-chain as evidence.
* **Backable.** Anyone can bond on behalf of a host they trust with `bondFor`; the bond then belongs to the host.
* **Cheaper to work.** The protocol fee on a host's earnings is 1% while bonded and 2% otherwise.

## Launch

GRID launches on the Creora launchpad with the Robinhood Chain launch. The whole supply goes on the bonding curve, and there is no team allocation. Until then, test networks use a stand-in token that anyone can mint.

## What GRID is not

GRID gives no share of revenue or profit, no claim on anyone and no governance rights. It may lose some or all of its value. Nothing in these docs is an offer to buy or sell it, or advice to do so.
