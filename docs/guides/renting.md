# Renting a machine

A direct rental gives you one whole machine with an SSH login, billed by the minute.

## Steps

1. Connect a wallet holding ETH on Robinhood Chain.
2. On the market, pick a machine marked **Available**, choose the hours and confirm. The ETH for those hours is sent to `GridMarket`, which holds it.
3. Under **Rentals**, choose **Get SSH access**. Your wallet signs a short message; the host's node checks it against the renter recorded on-chain and returns a login for a container started for you.
4. End the rental whenever you like. The host is paid for every minute that was started; the rest becomes your balance in the contract. Choose **Withdraw** to collect it.

## Good to know

* The price per hour is fixed when you rent. A host changing its price does not affect running rentals.
* Once the paid hours are over anyone can settle the rental, so funds never stay stuck.
* A host in its first 30 days without a GRID bond can hold at most 0.01 ETH per rental. Bonded hosts have no cap.
* A host can see everything on its machine. Keep secrets off machines you do not control, and copy results off before the rental ends: the container is removed with it.
* If the host goes offline, the session ends with it. You pay only for the minutes that were started. For work that must survive a machine going away, use a [swarm job](swarm.md).
* Machines marked **Swarm only** are behind a router and reached through a relay. They cannot take direct rentals because their SSH port cannot be reached.
