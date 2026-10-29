import { setTimeout as sleep } from "node:timers/promises";
import { formatEther } from "viem";
import type { MachineMetadata } from "@grid/shared";
import { Chain } from "./chain";
import { loadConfig } from "./config";
import { probeHardware } from "./hardware";
import { log } from "./log";
import { P2P } from "./p2p";
import { startServer } from "./server";
import { SessionManager } from "./sessions";
import { SwarmWorker } from "./swarm";

const VERSION = "0.0.1";
/** Consecutive session-start failures before the rental is ended and the listing paused. */
const MAX_START_FAILURES = 3;

async function main() {
  const config = loadConfig();
  const chain = new Chain(config);
  const sessions = new SessionManager(config);
  await sessions.init();

  const hardware = await probeHardware(config.simulate === true);

  log(`host ${chain.address} on ${config.chain.name} (chain ${config.chain.id}), market ${config.market}`);
  log(
    `machine "${config.name}": ${hardware.gpu} x${hardware.gpuCount}, ${hardware.vramGb} GB VRAM, ${hardware.cpu}, ` +
      `${hardware.ramGb} GB RAM, ${hardware.diskGb} GB disk — ${formatEther(config.pricePerHourWei)} ETH/h`,
  );
  if (sessions.mode === "docker" && hardware.gpuCount > 0) await sessions.preflightGpu();

  // Join the peer-to-peer network. Peers listed on-chain are the way in; GRID_BOOTSTRAP adds more.
  const p2p = await P2P.start(config, chain);
  await p2p.dial([...config.p2pBootstrap, ...(await chain.listedPeerAddrs())]);

  // Where renters reach this node: its own URL, or the gateway of a relay it is connected to.
  const direct = config.publicUrl !== null;
  const reachableAt = () => {
    if (config.publicUrl) return config.publicUrl;
    const relay = p2p.connectedRelay();
    return relay ? `${relay}/p2p/${p2p.peerId}` : null;
  };
  if (!direct) {
    log("p2p: no public address — looking for a relay");
    for (let i = 0; i < 30 && !reachableAt(); i++) await sleep(1_000);
  }
  let endpoint = reachableAt();
  const metadataFor = (at: string | null) => {
    const metadata: MachineMetadata = {
      v: 1,
      name: config.name,
      ...hardware,
      endpoint: at ?? "",
      p2p: { peer: p2p.peerId, addrs: p2p.addrs, relay: config.relay, direct },
    };
    return JSON.stringify(metadata);
  };

  // Behind NAT the SSH port cannot be reached, so the listing stays closed to direct rentals.
  const machineId = await chain.ensureListed(metadataFor(endpoint), config.pricePerHourWei, direct);
  log(
    `listed as machine #${machineId}, reachable at ${endpoint ?? "nowhere yet"}` +
      (direct ? `, ssh via ${config.sshHost}:${config.sshPort}` : " (swarm only: no public address for SSH)"),
  );

  // Containers from an earlier run are stale unless their rental is still running on-chain.
  const activeAtStart = activeOf(await chain.getMachine(machineId));
  await sessions.sweep(activeAtStart);

  const swarm = config.swarm ? new SwarmWorker(config, chain, sessions.mode === "docker", hardware.gpuCount > 0) : null;
  if (swarm) await swarm.register(endpoint);
  else log("swarm: off (GRID_SWARM=0 or no SwarmMarket on this chain)");

  startServer({
    port: config.port,
    machineId,
    name: config.name,
    version: VERSION,
    chain,
    sessions,
    swarm,
    p2p,
    relay: config.relay,
  });

  p2p.startHeartbeats(() => ({
    name: config.name,
    endpoint,
    relay: config.relay ? config.publicUrl : null,
    direct,
    busy: sessions.busy,
  }));

  // A node behind NAT follows its relay: if the relay changes, so do its listing and results address.
  setInterval(async () => {
    const next = reachableAt();
    if (next === endpoint) return;
    try {
      log(`p2p: now reachable at ${next ?? "nowhere"} (was ${endpoint ?? "nowhere"})`);
      endpoint = next;
      await chain.ensureListed(metadataFor(endpoint), config.pricePerHourWei, direct);
      if (swarm) await swarm.register(endpoint);
    } catch (e) {
      log(`p2p: could not publish the new address: ${firstLine(e)}`);
    }
  }, 20_000);

  // The chain is the source of truth: every few seconds compare its view of this
  // machine with the session we are running and start, stop or settle as needed.
  let current: bigint | null = null;
  let startFailures = 0;

  async function tick() {
    const active = activeOf(await chain.getMachine(machineId));

    // A new rental can follow the old one within a single poll, so compare ids, not just "idle".
    if (current !== null && active !== current) {
      log(`rental #${current} ended — stopping session`);
      await sessions.stop(current);
      current = null;
    }

    if (active !== null && active !== current) {
      const rental = await chain.getRental(active);
      const endsAt = Number(rental.startedAt + rental.paidHours * 3600n);
      try {
        log(`rental #${active} by ${rental.renter} for ${rental.paidHours}h — starting session`);
        await sessions.start(active, rental.renter, endsAt, hardware.gpuCount > 0);
        current = active;
        startFailures = 0;
      } catch (e) {
        startFailures += 1;
        log(`could not start the session for rental #${active} (${startFailures}/${MAX_START_FAILURES}): ${firstLine(e)}`);
        if (startFailures >= MAX_START_FAILURES) {
          // Do not keep billing a renter for a machine that cannot serve them.
          log(`giving up on rental #${active}: ending it so the renter is refunded, and pausing this listing until the node restarts`);
          await chain.endRental(active);
          await chain.setAvailable(machineId, false);
          startFailures = 0;
        }
        return;
      }
    }

    if (current !== null) {
      const session = sessions.get(current);
      if (session && Date.now() / 1000 >= session.endsAt) {
        log(`rental #${current} used up its paid time — settling on-chain`);
        await chain.endRental(current);
      }
    }
  }

  async function loop() {
    let worked = false;
    try {
      await tick();
      // An idle machine works for the swarm; a direct rental always comes first.
      if (swarm && current === null) worked = await swarm.round();
    } catch (e) {
      log(`error: ${firstLine(e)}`);
    }
    setTimeout(loop, worked ? 250 : config.pollMs);
  }
  void loop();

  async function shutdown() {
    if (current !== null && sessions.mode === "docker") {
      // The renter keeps what they paid for: the container stays up and is adopted when the node returns.
      log(`shutting down with rental #${current} running — its container stays up until the rental ends`);
      sessions.release(current);
    }
    log("marking the machine unavailable");
    await sessions.stopAll();
    await chain.setAvailable(machineId, false).catch((e: Error) => log(`could not mark unavailable: ${firstLine(e)}`));
    await p2p.stop().catch(() => {});
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

/** GridMarket stores rentalId + 1 in activeRental, 0 when idle. */
function activeOf(machine: { activeRental: bigint }): bigint | null {
  return machine.activeRental === 0n ? null : machine.activeRental - 1n;
}

function firstLine(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split("\n")[0];
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
