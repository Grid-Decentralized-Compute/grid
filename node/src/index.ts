import { formatEther } from "viem";
import type { MachineMetadata } from "@grid/shared";
import { Chain } from "./chain";
import { loadConfig } from "./config";
import { probeHardware } from "./hardware";
import { log } from "./log";
import { startServer } from "./server";
import { SessionManager } from "./sessions";

const VERSION = "0.0.1";

async function main() {
  const config = loadConfig();
  const chain = new Chain(config);
  const sessions = new SessionManager(config);
  await sessions.init();

  const hardware = await probeHardware(config.simulate === true);
  const metadata: MachineMetadata = { v: 1, name: config.name, ...hardware, endpoint: config.publicUrl };

  log(`host ${chain.address} on ${config.chain.name} (chain ${config.chain.id}), market ${config.market}`);
  log(
    `machine "${config.name}": ${hardware.gpu} x${hardware.gpuCount}, ${hardware.vramGb} GB VRAM, ${hardware.cpu}, ` +
      `${hardware.ramGb} GB RAM, ${hardware.diskGb} GB disk — ${formatEther(config.pricePerHourWei)} ETH/h`,
  );

  const machineId = await chain.ensureListed(JSON.stringify(metadata), config.pricePerHourWei);
  log(`listed as machine #${machineId}, reachable at ${config.publicUrl}`);

  startServer({ port: config.port, machineId, name: config.name, version: VERSION, chain, sessions });

  // The chain is the source of truth: every few seconds compare its view of this
  // machine with the sessions we are running and start, stop or settle as needed.
  let current: bigint | null = null;
  async function tick() {
    const machine = await chain.getMachine(machineId);
    const active = machine.activeRental === 0n ? null : machine.activeRental - 1n;

    if (active !== null && active !== current) {
      const rental = await chain.getRental(active);
      const endsAt = Number(rental.startedAt + rental.paidHours * 3600n);
      log(`rental #${active} by ${rental.renter} for ${rental.paidHours}h — starting session`);
      await sessions.start(active, rental.renter, endsAt, hardware.gpuCount > 0);
      current = active;
    }

    if (active === null && current !== null) {
      log(`rental #${current} ended — stopping session`);
      await sessions.stop(current);
      current = null;
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
    try {
      await tick();
    } catch (e) {
      log(`error: ${(e as Error).message.split("\n")[0]}`);
    }
    setTimeout(loop, config.pollMs);
  }
  void loop();

  async function shutdown() {
    log("shutting down: stopping sessions and marking the machine unavailable");
    await sessions.stopAll();
    await chain.setAvailable(machineId, false).catch((e: Error) => log(`could not mark unavailable: ${e.message}`));
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
