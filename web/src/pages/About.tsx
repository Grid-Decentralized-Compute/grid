import type { ReactNode } from "react";
import { linkClass } from "../components/ui";
import { SOURCE_URL } from "../lib/links";
import { Link } from "../router";

const Code = ({ children }: { children: ReactNode }) => (
  <code className="rounded-[2px] bg-plate px-1 py-0.5 font-mono text-[13px]">{children}</code>
);

const H2 = ({ children }: { children: ReactNode }) => (
  <h2 className="engraved mt-14 border-b border-ink/80 pb-2 text-ink">{children}</h2>
);

export function About() {
  return (
    <article className="max-w-[62ch] text-[15.5px] leading-[1.7] [&_p]:mt-4">
      <h1 className="font-serif text-[34px] font-light leading-[1.1] tracking-[-0.01em]">Grid</h1>
      <p className="!mt-2 text-muted">Peer-to-peer GPU rental on Robinhood Chain.</p>

      <H2>How it works</H2>
      <p>
        Grid is a marketplace contract, GridMarket, and a small program hosts run next to their GPUs. The contract keeps
        the list of machines and holds renters' payments. Everything else happens between the renter and the host's
        machine.
      </p>
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
