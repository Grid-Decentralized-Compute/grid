# Grid for AI agents

Grid needs no account: whatever holds a funded wallet can run a batch of tasks on other people's GPUs, or run the host side of a machine. The Grid MCP server turns that into tools any agent that speaks the Model Context Protocol can call. The same code is also a command line, `grid`, for scripts and people.

The main path is a batch job: split the work into independent tasks, post them once, and collect outputs that two hosts agreed on. An agent can, with no person in the loop:

* see which GPUs are free and what they cost per GPU-hour,
* run a batch job with `run_batch`, which posts it, waits for it and returns every output with a receipt link,
* post a job without waiting, follow it, and read outputs as tasks finish,
* close jobs and withdraw what is refunded,
* change the price of a machine it hosts, pause or resume it, and withdraw its earnings,
* if the person running the server switches it on, rent one whole machine by the hour and log in over SSH.

## Set up

```bash
git clone https://github.com/Grid-Decentralized-Compute/grid
cd grid && npm install && npm run mcp:build
```

That writes `mcp/dist/grid-mcp.mjs` (the server) and `mcp/dist/grid-cli.mjs` (the command line), one file each, which run with Node.js 22.22 or newer from anywhere.

Make a new wallet for the agent and send it only what it may spend, or fund an [allowance](#spending-through-an-allowance) and give the agent a key that can spend only from that. The server signs every transaction with that key itself.

### Claude Code

```bash
claude mcp add grid -e GRID_AGENT_MAX_SPEND=0.02 -e GRID_AGENT_MAX_TOTAL=0.1 -- node --env-file=/path/to/grid-agent.env /path/to/grid/mcp/dist/grid-mcp.mjs
```

Keep the key in that env file (`GRID_AGENT_PRIVATE_KEY=0x...`, readable only by you: `chmod 600`) rather than on the command line, where it would end up in your shell history and in the client's config.

### Other MCP clients

Most clients take a JSON entry like this one:

```json
{
  "mcpServers": {
    "grid": {
      "command": "node",
      "args": ["/path/to/grid/mcp/dist/grid-mcp.mjs"],
      "env": {
        "GRID_AGENT_PRIVATE_KEY": "0x...",
        "GRID_AGENT_MAX_SPEND": "0.02",
        "GRID_AGENT_MAX_TOTAL": "0.1"
      }
    }
  }
}
```

Without `GRID_AGENT_PRIVATE_KEY` the server still runs and can browse the market; tools that spend or sign say they need a wallet.

Once the package is on npm, `npx -y grid-mcp` replaces `node /path/to/grid/mcp/dist/grid-mcp.mjs` in both of these.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `GRID_AGENT_PRIVATE_KEY` | unset | The agent's wallet. Fund it with only what the agent may spend |
| `GRID_AGENT_ALLOWANCE` | unset | Address of a compute allowance. Every payment to the markets is then sent through it, see [below](#spending-through-an-allowance) |
| `GRID_AGENT_MAX_SPEND` | `0.02` | Most ETH one transaction may carry. A job above it is refused with the reason |
| `GRID_AGENT_MAX_TOTAL` | `0.1` | Most ETH all transactions together may carry in any 24 hours |
| `GRID_AGENT_DIRECT` | unset | `1` turns on direct rentals: `rent_machine`, `get_access`, `my_rentals`, `end_rental` |
| `GRID_AGENT_MAX_RENTALS` | `2` | Most direct rentals the wallet may have running at once |
| `GRID_CHAIN_ID` | `46630` | `46630` Robinhood Chain testnet, `4663` Robinhood Chain, `31337` a local Anvil chain |
| `GRID_RPC_URL` | the chain's public RPC | Another RPC endpoint |
| `GRID_SITE_URL` | `https://gridcompute.net` | The website that serves receipt pages |
| `GRID_AGENT_SSH_KEY` | `~/.grid-agent/id_ed25519` | Private key for logging in to direct rentals. Made with `ssh-keygen` on first use if missing |

## Tools

| Tool | What it does |
| --- | --- |
| `wallet` | Network, contracts, the wallet, its balance, what the markets owe it, the spending limit, and the allowance if one is set |
| `find_gpus` | One line per GPU model: machines, how many are free, cheapest free GPU-hour |
| `list_machines` | Machines with hardware, price and live status; filters by GPU, memory, price |
| `run_batch` | Posts a job of many tasks, waits until they are done, and returns the outputs with a receipt link per task |
| `post_swarm_job` | Posts a job of many tasks and returns at once: image, command, one input per task, price per run |
| `swarm_job_status` | Tasks by state, ETH deposited and paid |
| `swarm_results` | Outputs of finished tasks, checked against the hash two hosts agreed on, each with a receipt link |
| `stop_swarm_job` | Stops a job and, once no task is leased, closes it to get unused runs back |
| `my_machines` | Machines the wallet hosts, their status and the earnings waiting |
| `update_machine` | Changes a hosted machine's price, or pauses and resumes its listing |
| `withdraw` | Moves refunds and earnings from both markets into the wallet |

With `GRID_AGENT_DIRECT=1` four more appear:

| Tool | What it does |
| --- | --- |
| `rent_machine` | Rents a machine for whole hours, paid up front; returns the rental id |
| `get_access` | Signs for the rental and fetches the SSH login from the host's node |
| `my_rentals` | The wallet's rentals: running or ended, cost so far, refund if ended now |
| `end_rental` | Ends a rental; the host is paid per started minute, the rest is refunded |

## What a session looks like

Asked to "run this script over these 2,000 images", an agent optionally calls `find_gpus`, then `run_batch` with a container image, a command that reads one image's name on stdin and writes its result to stdout, and one task per image. `run_batch` posts the job, checks it every few seconds (up to `waitMinutes`, 10 by default, 120 at most) and returns the first outputs, each with a receipt link. It reads the rest with `swarm_results` (`fromTask`), then calls `stop_swarm_job` so the runs that were not needed come back, and `withdraw` to take them.

If the wait runs out, `run_batch` does not give up the job: it returns the job id and its status so far and says to call `swarm_results` later. The same job can be followed with `swarm_job_status`.

**Tasks must be deterministic.** Every task runs on two hosts and is paid only when their outputs are byte for byte the same; a third host breaks a tie. Pin the image by digest (`image@sha256:...`), fix random seeds, and keep clocks, hostnames and thread-order out of the output.

**Receipts.** Every task in `run_batch` and `swarm_results` comes with a `receipt` link, `https://gridcompute.net/receipt/<jobId>/<task>`, a page that shows how the task was run and which hosts agreed on its output. It reads everything from the chain, so it works for any job.

With direct rentals switched on, "rent the cheapest free RTX 5090 for two hours and run train.py on it" is `find_gpus`, then `list_machines` with `gpu: "5090"`, `rent_machine` for two hours, and `get_access` for the login. The agent runs the work over SSH, then `end_rental` to stop paying and `withdraw` to take the refund back.

## Command line

`grid` runs the same thing from a terminal, with the same settings from the environment (`GRID_AGENT_PRIVATE_KEY`, `GRID_CHAIN_ID`, `GRID_RPC_URL`, `GRID_AGENT_MAX_SPEND`, `GRID_AGENT_MAX_TOTAL`, `GRID_AGENT_ALLOWANCE`, `GRID_SITE_URL`). Until the package is published to npm it runs as `node mcp/dist/grid-cli.mjs` from a checkout that has run `npm run mcp:build`; the examples below write `grid` for either.

```bash
export GRID_AGENT_PRIVATE_KEY=0x...
grid wallet                       # network, wallet, balance, what is owed to it
grid gpus                         # GPU models, free machines, cheapest GPU-hour

grid run \
  --image python:3.12-slim@sha256:... \
  --command "python -c 'import sys; print(int(sys.stdin.read()) ** 2)'" \
  --tasks numbers.txt \
  --price 0.0005 --out ./results
```

| Command | What it does |
| --- | --- |
| `grid run --image <image> --command <command> --tasks <file or ->` | Posts a job, waits and prints the outputs with receipt links |
| `grid status <jobId>` | Tasks by state, ETH deposited and paid |
| `grid results <jobId> [--out <dir>]` | The first 20 outputs, or with `--out` every output saved as `<dir>/task-<n>.out` |
| `grid stop <jobId>` | Stops the job and closes it once nothing is leased, to get unused runs back |
| `grid withdraw` | Moves refunds and earnings into the wallet |
| `grid wallet` | The network, the wallet, its balance, the allowance if one is set |
| `grid gpus` | The market at a glance |

Options for `grid run`:

| Option | Default | Meaning |
| --- | --- | --- |
| `--tasks <file or ->` | required | One task per line, or a JSON array of strings; `-` reads standard input. Blank lines are skipped |
| `--gpu` | off | Tasks need a GPU |
| `--price <eth>` | `0.001` | ETH paid to a host per accepted run. The deposit is three runs per task |
| `--lease <minutes>` | `10` | How long a host may hold a task before it is handed to another |
| `--wait <minutes>` | `10` | How long to wait; `0` posts the job and returns. At most 120 |
| `--out <dir>` | none | Save every output to its own file instead of printing the first few |

Every command takes `--json` for machine-readable output. Progress goes to standard error, results to standard output. The exit status is `0` when every task is done, `1` for an error or failed tasks, `2` for wrong usage and `3` when the wait ran out with the job still running (it is not lost: `grid results <jobId>` collects it later).

### Publishing the package to npm

This is for the project owner: it needs the project's npm account.

1. Check that the build embeds the deployment you want to ship. The bundles contain the contract addresses from `packages/shared/src/generated/deployments.ts`, so run `npm run deploy:testnet` first, commit the regenerated files, and only then build. A package built before that cannot find Grid on the default chain.
2. Build and look at what would be published, from the repository root: `npm run mcp:build`, then `cd mcp && npm pack --dry-run`. The list should be `package.json` and the two files in `dist/`.
3. Log in as the project account: `npm login`.
4. Publish from `mcp/`: `npm publish --access public`. npm asks for a one-time code when the account uses two-factor authentication.
5. Check it: `npm view grid-mcp version`, then `npx -y --package grid-mcp grid --version`. (`npx -y grid-mcp` starts the MCP server, which waits for a client on standard input, so it is not a check.)

The package is named `grid-mcp`: unscoped, so no npm organization is needed, and it matches the `grid-mcp` program, which is why `npx -y grid-mcp` starts the server. Installing it globally (`npm install -g grid-mcp`) gives both programs, `grid` and `grid-mcp`. Every new version needs a new number in `mcp/package.json` and, if it is listed in the MCP registry, in `mcp/server.json` (below).

## Spending through an allowance

An agent that holds a funded key can lose everything on it. A compute allowance is a small contract a person or company funds instead: the owner puts ETH in, names the agent's key, sets a daily cap and the contracts the agent may call (GridMarket and SwarmMarket). The agent key can then only call `execute()`, and the ETH it sends with those calls adds up to at most the daily cap per day. Refunds and payouts from the markets land back in the allowance, and only the owner takes ETH out. See the [contracts reference](../reference/contracts.md).

Set `GRID_AGENT_ALLOWANCE` to the contract's address, with `GRID_AGENT_PRIVATE_KEY` the agent key it names:

```bash
GRID_AGENT_ALLOWANCE=0x... GRID_AGENT_PRIVATE_KEY=0x... grid run ...
```

* Every transaction the server sends to a market (posting, cancelling and closing a job, withdrawing, and, if switched on, the direct tools) is sent as `allowance.execute(market, value, data)` from the agent key. The markets see the allowance, not the agent key, as the renter.
* The agent key needs a little ETH of its own, only for gas.
* `wallet` (and `grid wallet`) also report the allowance's ETH balance, its daily cap and what it may still send today. Before it sends, the server checks the cost against that and says so if a job does not fit.
* Refunds and withdrawals land in the allowance, not in the agent wallet. `swarm_job_status` and `stop_swarm_job` recognise the allowance's jobs as the agent's own.
* `GRID_AGENT_MAX_SPEND` and `GRID_AGENT_MAX_TOTAL` still apply on top of the allowance's own cap.
* **No SSH logins with an allowance.** A host lets a renter in only on a signature from the renter's own key, and a contract has none, so a direct rental held by an allowance cannot be logged in to. Use swarm jobs, which need no login.
* The hosting tools act as the allowance too: `my_machines` and `update_machine` find machines listed by the allowance's address, not the agent key's.

## Hosting with an agent

An agent that holds a host's wallet can run that host's business: watch `my_machines`, raise or lower the price with `update_machine`, pause the machine for maintenance and resume it, and `withdraw` the earnings. It cannot list hardware it is not running on: the [Grid node](hosting.md) does that on the machine itself, because it is what starts the renters' containers.

## Listing the server

The MCP registry makes the server findable by clients that browse it. The manifest is `mcp/server.json`; it names the server `io.github.Grid-Decentralized-Compute/grid` and the npm package `grid-mcp`, and `mcpName` in `mcp/package.json` carries the same name, which is how the registry checks that the package is yours. These are the steps for the project owner, as of the registry's publishing guide when this was written ([modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry)):

1. Publish the package to npm first (see above). The registry stores no code: it points at the npm package, and refuses a name or version it cannot find there.
2. Install the publisher: `brew install mcp-publisher`, or download the binary for your system from the [registry's releases](https://github.com/modelcontextprotocol/registry/releases) and put it on your `PATH`.
3. From `mcp/`, check the manifest: `mcp-publisher validate`.
4. Log in as the project's GitHub account: `mcp-publisher login github`. It prints a code and a link (`https://github.com/login/device`); open it in a browser that is signed in to that account. The `Grid-Decentralized-Compute` account owns the `io.github.Grid-Decentralized-Compute/` names.
5. Publish: `mcp-publisher publish`.
6. Check the listing: `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Grid-Decentralized-Compute/grid"`.

For a new version, change the version in `mcp/package.json` and twice in `mcp/server.json` (the server's and the package's), publish to npm, then run `mcp-publisher publish` again.

### For Claude and ChatGPT

Claude Code and Claude Desktop start MCP servers on your own machine, which is how this one runs: for Claude Code use the command in [Set up](#claude-code); for Claude Desktop add the `mcpServers` entry from [Other MCP clients](#other-mcp-clients) to its configuration file (Settings, Developer, Edit Config) and restart it. Claude on the web and ChatGPT add connectors by the address of a remote MCP server, and this server runs locally over stdio and holds a wallet key, so there is no address to give them: a key kept on a server someone else runs is a key you have handed over. To use Grid from those apps, run it in a client that starts local servers, or serve your own copy behind HTTPS and authentication on a machine you control and add that address as a custom connector. Menu names change; check the app's current connector documentation for where it goes.

## Things to know

* **Keys and limits.** The server never sends the key anywhere; it signs locally. Every tool that spends, ends or changes something is marked so clients ask before running it, and the limits apply on top: per transaction, per 24 hours, and, for direct rentals, rentals at once. The hard limit is still what the wallet holds, or the allowance's daily cap.
* **Strangers' text is labelled.** Machine names, hardware strings, host messages and swarm outputs are written by strangers. The server strips control and invisible characters, caps their length and tells the agent to treat them as data, never as instructions. The command line does the same before printing.
* **No requests into private networks.** Addresses come from on-chain listings, so the server only calls https addresses that resolve to public IPs, never follows redirects and caps every reply's size. A listing cannot point it at the agent's own network or a cloud metadata service.
* **Hardware is the host's word.** After a direct rental, check the GPU with `nvidia-smi` and end the rental if it does not match; you pay only for the minutes used. In a swarm job, two hosts must agree on every output, which is what catches a host that does not run the work.
* **Direct rentals are off by default.** Set `GRID_AGENT_DIRECT=1` to register their four tools. Logins are by key: the server makes its own SSH key on first use (`~/.grid-agent/id_ed25519`, or the one `GRID_AGENT_SSH_KEY` points to) and signs its public half into the access request. Hosts never see a private key and no password exists. `get_access` pins the machine's host key in a known_hosts file, and the command it returns refuses to connect to anything else.
* **Swarm inputs are public.** They are published on-chain with the job; never put secrets in them.
* **Testnet first.** Grid runs on Robinhood Chain testnet until the Robinhood Chain launch; its ETH has no value.
