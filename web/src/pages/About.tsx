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

export function About() {
  return (
    <article className="max-w-[62ch] text-[15.5px] leading-[1.7] [&_p]:mt-4">
      <h1 className="font-serif text-[34px] font-light leading-[1.1] tracking-[-0.01em]">Grid</h1>
      <p className="!mt-2 text-muted">Peer-to-peer GPU rental on Robinhood Chain.</p>

      <H2>How it works</H2>
      <p>
        Grid is two marketplace contracts and a small program hosts run next to their GPUs. The contracts keep the list of
        machines and jobs and hold renters' payments. Everything else happens between renters and hosts' machines. There
        are two ways to rent.
      </p>

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
