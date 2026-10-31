# Contracts

Grid runs on four contracts on Robinhood Chain. `GridMarket` and `SwarmMarket` have no owner and cannot be upgraded. A fixed protocol fee comes out of the host's side of every payment, 2% or 1% when the host is bonded, and accrues to a treasury address set at deployment; renters pay the listed price. Payouts are never pushed: every party collects what it is owed with `withdraw()`. Addresses for each network are in [`contracts/deployments/<chain id>.json`](https://github.com/Grid-Decentralized-Compute/grid/tree/main/contracts/deployments).

## GridMarket

Direct rentals: listings, ETH escrow and settlement per started minute.

| Function | Description |
| --- | --- |
| `listMachine(uint96 pricePerHour, string metadata) → uint64 id` | List a machine. Metadata is JSON, at most 1024 bytes. |
| `updateMachine(uint64 id, uint96 pricePerHour, bool available, string metadata)` | Host only. Change price, pause or reopen, update metadata. |
| `rent(uint64 machineId, uint64 hours) payable → uint64 rentalId` | Send exactly `pricePerHour × hours`. Reverts if the machine is busy or paused, or its host is neither bonded nor in its trial. An unbonded host can hold at most 0.01 ETH per rental. |
| `endRental(uint64 rentalId)` | Renter or host at any time; anyone once the paid hours are over. Pays the host per started minute (at least one), less the protocol fee, and credits the rest to the renter. |
| `withdraw()` | Collect your balance: host earnings and renter refunds. |
| `getListings(uint64 offset, uint64 limit) → MachineView[]` | A page of machines with live `rentable` and `hostBonded` flags. |
| `getRentalsOf(address renter) → RentalView[]` | A renter's rentals with their machines. |
| `hostEligible(address host) → bool` | Bonded, or within 30 days of first listing. |
| `activeRentalCount(address host) → uint64` | Rentals running on a host's machines. `StakeRegistry` blocks unbonding while it is above zero. |

**Events:** `MachineListed`, `MachineUpdated`, `Rented`, `RentalEnded(rentalId, machineId, paidToHost, fee, refunded)`, `Withdrawn`.

`FEE_BPS` (200) and `BONDED_FEE_BPS` (100) are constants; `treasury` is immutable.

## SwarmMarket

Swarm jobs: one job, many hosts.

| Function | Description |
| --- | --- |
| `postJob(uint96 pricePerRun, uint32 taskCount, uint32 leaseSeconds, bytes manifest) payable → uint256 jobId` | Send exactly `pricePerRun × taskCount × 3`. Up to 100,000 tasks, leases of 60 seconds to one day, manifest up to 64 KB (emitted, not stored). |
| `claim(uint256 jobId, uint32[] tasks) → uint256 claimed` | Host, bonded when bonding is on. Leases up to 32 tasks. Skips tasks with nothing to run for this host; a host never runs the same task twice. |
| `submit(uint256 jobId, uint32[] tasks, bytes32[] results)` | keccak256 of each output. A late result still counts unless the run was taken over. A task settles as soon as two results match. |
| `registerWorker(string endpoint)` | Where renters fetch this host's outputs. |
| `cancelJob(uint256 jobId)` | Renter. Stops new claims; runs already leased may still finish. |
| `closeJob(uint256 jobId)` | Renter. Once every task is resolved, or after cancelling once the last lease has ended. Credits unused runs back. |
| `withdraw()` | Collect your balance. |
| `claimable(uint256 jobId, address host, uint32 from, uint32 scan, uint32 max) → uint32[]` | Tasks a host could claim now, within a window. |
| `taskStatuses(uint256 jobId, uint32 offset, uint32 limit) → uint8[]` | `0` waiting, `1` running, `2` one result in, `3` disputed, `4` done, `5` failed. |
| `getJobs(uint256 offset, uint256 limit) → JobView[]` | Newest first. |
| `faults(address host) → uint32` | Tie-breaks a host has lost. |

**Settlement.** Two matching results pay both hosts, each the price per run less the protocol fee (`FeeAccrued` records the fee). Two different results open a third run; the two that agree are paid and the third host's `Fault` is recorded. Three different results fail the task, and nobody is paid for it. The renter's side never changes: two runs per finished task, the rest refunded.

**Events:** `JobPosted`, `Claimed`, `Submitted`, `TaskDisputed`, `TaskDone`, `TaskFailed`, `Fault`, `JobCancelled`, `JobClosed`, `WorkerRegistered`, `Withdrawn`.

## Allowance

A compute allowance is a small wallet a person or company funds for an AI agent. The agent holds only the agent key; it can spend at most `dailyCap` per day (UTC) and only on the allowed contracts, and anything the markets refund or pay out lands back in the allowance, not with the agent. `AllowanceFactory.create(agent, dailyCap, targets)` deploys one, funded with the ETH sent along; the caller is its owner.

| Function | Description |
| --- | --- |
| `execute(address target, uint256 value, bytes data) → bytes` | Agent only. Forwards the call with `value`, which counts against today's cap. Calls without value are unlimited. |
| `remainingToday() → uint256` | What the agent may still spend today. |
| `setAgent`, `setDailyCap`, `setTarget(address, bool)`, `withdraw(uint256)` | Owner only. |
| `transferOwnership`, `acceptOwnership` | Two-step hand-over. |

## StakeRegistry

The GRID bond.

| Function | Description |
| --- | --- |
| `bond(uint256 amount)` | Lock GRID as your own bond. Approve the registry first. |
| `bondFor(address host, uint256 amount)` | Lock GRID as another host's bond; it belongs to that host. |
| `startUnbond(uint256 amount)` | Begin a seven-day unbond. Reverts while one of your rentals is running. |
| `withdraw()` | Collect an unbond whose seven days have passed. |
| `slash(address host, uint256 bps, string reason)` | Slasher only. Burns a share of the bond, pending unbonds included. |
| `isEligible(address host) → bool` | `bonded ≥ minBond`. With `minBond` at 0, bonding is off and every host is eligible. |

The owner (meant to be a multisig) sets `minBond`, the slasher and the market; it cannot move bonds.
