# Grid for AI agents

Grid needs no account: whatever holds a funded wallet can rent a GPU, run a swarm job or run the host side of a machine. The Grid MCP server turns that into tools any agent that speaks the Model Context Protocol can call, from Claude and ChatGPT to Cursor and custom agents.

An agent can, with no person in the loop:

* find free GPUs and compare prices per GPU-hour,
* rent a machine, prove it holds the rental and get the SSH login,
* post a job split into many tasks, follow it, and collect outputs that two hosts agreed on,
* end rentals, close jobs and withdraw what is refunded,
* change the price of a machine it hosts, pause or resume it, and withdraw its earnings.

## Set up

```bash
git clone https://github.com/Grid-Decentralized-Compute/grid
cd grid && npm install && npm run mcp:build
```

That writes `mcp/dist/grid-mcp.mjs`, one file that runs with Node.js 22.22 or newer from anywhere.

Make a new wallet for the agent and send it only what it may spend. The server signs every transaction with that key itself.

### Claude Code

```bash
claude mcp add grid -e GRID_AGENT_PRIVATE_KEY=0x... -e GRID_AGENT_MAX_SPEND=0.02 -- node /path/to/grid/mcp/dist/grid-mcp.mjs
```

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
        "GRID_AGENT_MAX_SPEND": "0.02"
      }
    }
  }
}
```

Without `GRID_AGENT_PRIVATE_KEY` the server still runs and can browse the market; tools that spend or sign say they need a wallet.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `GRID_AGENT_PRIVATE_KEY` | unset | The agent's wallet. Fund it with only what the agent may spend |
| `GRID_AGENT_MAX_SPEND` | `0.02` | Most ETH one transaction may carry. A rental or job above it is refused with the reason |
| `GRID_CHAIN_ID` | `46630` | `46630` Robinhood Chain testnet, `4663` Robinhood Chain, `31337` a local Anvil chain |
| `GRID_RPC_URL` | the chain's public RPC | Another RPC endpoint |

## Tools

| Tool | What it does |
| --- | --- |
| `wallet` | Network, contracts, the wallet, its balance, what the markets owe it, the spending limit |
| `find_gpus` | One line per GPU model: machines, how many are free, cheapest free GPU-hour |
| `list_machines` | Machines with hardware, price and live status; filters by GPU, memory, price |
| `rent_machine` | Rents a machine for whole hours, paid up front; returns the rental id |
| `get_access` | Signs for the rental and fetches the SSH login from the host's node |
| `my_rentals` | The wallet's rentals: running or ended, cost so far, refund if ended now |
| `end_rental` | Ends a rental; the host is paid per started minute, the rest is refunded |
| `post_swarm_job` | Posts a job of many tasks: image, command, one input per task, price per run |
| `swarm_job_status` | Tasks by state, ETH deposited and paid |
| `swarm_results` | Outputs of finished tasks, checked against the hash two hosts agreed on |
| `stop_swarm_job` | Stops a job and, once no task is leased, closes it to get unused runs back |
| `my_machines` | Machines the wallet hosts, their status and the earnings waiting |
| `update_machine` | Changes a hosted machine's price, or pauses and resumes its listing |
| `withdraw` | Moves refunds and earnings from both markets into the wallet |

## What a session looks like

Asked to "rent the cheapest free RTX 5090 for two hours and run train.py on it", an agent calls `find_gpus`, then `list_machines` with `gpu: "5090"`, `rent_machine` for two hours, and `get_access` for the login. It runs the work over SSH, then `end_rental` to stop paying and `withdraw` to take the refund back.

For "run this model over these 2,000 images", it uses `post_swarm_job` with one task per image, polls `swarm_job_status`, reads outputs with `swarm_results` as tasks finish, and calls `stop_swarm_job` at the end so the runs that were not needed come back.

## Hosting with an agent

An agent that holds a host's wallet can run that host's business: watch `my_machines`, raise or lower the price with `update_machine`, pause the machine for maintenance and resume it, and `withdraw` the earnings. It cannot list hardware it is not running on: the [Grid node](hosting.md) does that on the machine itself, because it is what starts the renters' containers.

## Things to know

* **Keys and limits.** The server never sends the key anywhere; it signs locally. Most clients ask before each tool call, and `GRID_AGENT_MAX_SPEND` caps any single transaction. The real limit is what the wallet holds.
* **Logins reach the agent.** `get_access` returns the SSH password to the agent, so it can use the machine.
* **Swarm inputs are public.** They are published on-chain with the job; never put secrets in them.
* **Testnet first.** Grid runs on Robinhood Chain testnet until the Robinhood Chain launch; its ETH has no value.
