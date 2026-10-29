import type { ReactNode } from "react";
import { linkClass } from "../components/ui";
import { SOURCE_URL } from "../lib/links";
import { Link } from "../router";

const Code = ({ children }: { children: ReactNode }) => (
  <code className="rounded-[2px] bg-plate px-1 py-0.5 font-mono text-[13px]">{children}</code>
);

const H2 = ({ children }: { children: ReactNode }) => (
  <h2 className="engraved mt-14 border-b border-rule pb-2 text-ink">{children}</h2>
);

/** Who runs each part of Grid, and what happens when it stops. Keep in step with docs/decentralization.md. */
const PARTS: { name: string; runBy: ReactNode; ifItStops: ReactNode }[] = [
  {
    name: "Market and escrow",
    runBy: "GridMarket and SwarmMarket, contracts on Robinhood Chain. They have no owner, take no fee and cannot be upgraded.",
    ifItStops: "Nobody can switch them off or move the ETH they hold. They are as available as Robinhood Chain itself.",
  },
  {
    name: "Compute",
    runBy: "Hosts, on machines they own, at prices they set.",
    ifItStops: "A direct rental ends and the unused time is refunded. A swarm task goes to another host when its lease runs out.",
  },
  {
    name: "Discovery",
    runBy: "Every node. A node finds others through the listings on-chain, then through a distributed hash table.",
    ifItStops: "There is no directory to take down. Any listed node can introduce a new one.",
  },
  {
    name: "Relays",
    runBy: "Hosts who choose to run one, so machines behind home routers can be reached.",
    ifItStops: "A machine behind a router moves to another relay.",
  },
  {
    name: "Bond",
    runBy: "StakeRegistry. Its owner, meant to be a multisig, sets the minimum bond and who may slash.",
    ifItStops: "It cannot touch rental payments, which stay in the markets.",
  },
  {
    name: "This site",
    runBy: "Static files that read the chain and talk to nodes. Anyone can build and host a copy.",
    ifItStops: "Use another copy, or call the contracts directly.",
  },
];

export function About() {
  return (
    <article className="max-w-[62ch] text-[15.5px] leading-[1.7] [&_p]:mt-4">
      <h1 className="font-serif text-[34px] font-light leading-[1.1] tracking-[-0.01em]">Grid</h1>
      <p className="!mt-2 text-muted">Decentralized compute on Robinhood Chain.</p>

      <H2>How it works</H2>
      <p>
        Grid is two marketplace contracts and a small program hosts run next to their GPUs. The contracts keep the list of
        machines and jobs and hold renters' payments. Everything else happens between renters and hosts' machines. There
        are two ways to rent.
      </p>

      <H2>What runs where</H2>
      <p>
        Grid has no servers of its own. Each part is run by someone different, and each can stop without taking the others
        with it.
      </p>
      <dl className="!mt-6 border-t border-line text-[14.5px] leading-[1.6]">
        {PARTS.map((part) => (
          <div key={part.name} className="group relative grid gap-1 border-b border-line py-4 sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:gap-6">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -left-3.5 top-[22px] h-3 w-[2px] scale-y-0 bg-steel transition-transform duration-300 ease-out group-hover:scale-y-100"
            />
            <dt className="engraved pt-[3px] text-ink transition-colors duration-300 group-hover:text-steel">{part.name}</dt>
            <dd className="m-0">
              <span className="block">{part.runBy}</span>
              <span className="mt-1 block text-muted">{part.ifItStops}</span>
            </dd>
          </div>
        ))}
      </dl>

      <H2>Direct</H2>
      <p>
        A host's node registers the machine with <Code>listMachine</Code>, giving an hourly price in ETH and the address
        the node can be reached at. To rent it, you call <Code>rent</Code> with the number of hours and send the ETH for
        them. The node sees the rental on-chain, starts a container for you, and hands over the SSH login once you sign a
        message proving the rental is yours.
      </p>
      <p>
        A rental ends when either of you calls <Code>endRental</Code>, or when anyone does after the paid hours run out.
        The host is paid for every minute that was started and you are refunded the remainder. Both of you collect with{" "}
        <Code>withdraw</Code>. The contract has no owner and charges no fee.
      </p>
      <p>
        A direct rental depends on one machine. If its host goes offline, the session ends with it; you pay only for the
        minutes that were started, and anything on the machine is lost.
      </p>

      <H2>Swarm</H2>
      <p>
        A swarm job is a container and a list of inputs, one per task. You post it to SwarmMarket with the ETH for three
        runs of every task. Hosts whose machines are idle claim tasks on short leases, run them, keep the output and
        submit its hash.
      </p>
      <p>
        Every task runs on two different hosts. When their hashes match, both are paid. When they differ, a third host
        runs it: the two that agree are paid and the odd one out is recorded as a fault against its bond. A lease that
        runs out is handed to another host, so no single machine can stall the job. When the job is done you close it and
        the runs that were not needed come back to you.
      </p>
      <p>
        Results are fetched straight from the hosts that produced them and checked against the hashes on-chain, so a
        result shown here is one two hosts agreed on. Tasks must be deterministic, and a job's inputs are public.
      </p>

      <H2>Hosting</H2>
      <p>
        Any machine that can run Docker can be listed, and the host sets the price.{" "}
        <Link href="/host" className={linkClass}>
          Running a node
        </Link>{" "}
        takes a wallet, an https address for the node and a few minutes of setup.
      </p>

      <H2>GRID</H2>
      <p>
        GRID is the bond hosts post to stay listed. It is not required for a host's first 30 days, but until a host is
        bonded each rental is capped at 0.01 ETH. A bond cannot be withdrawn while one of the host's rentals is running,
        takes seven days to unlock, and can be slashed if the host is shown to have cheated a renter. Rentals are always
        paid in ETH; renters never need GRID.
      </p>
      <p>
        GRID will launch on Creora alongside the Robinhood Chain launch, with the entire supply on the bonding curve and
        no allocation to the team.
      </p>

      <H2>Source</H2>
      <p>
        The contracts, the host node and this site are in{" "}
        <a className={linkClass} href={SOURCE_URL}>
          one repository
        </a>
        .
      </p>
    </article>
  );
}
