import type { ReactNode } from "react";
import { SOURCE_URL } from "../lib/links";
import { linkClass } from "../components/ui";
import { Link } from "../router";

const Code = ({ children }: { children: ReactNode }) => (
  <code className="rounded bg-wash px-1 py-0.5 font-mono text-[13px]">{children}</code>
);

const H2 = ({ children }: { children: ReactNode }) => (
  <h2 className="mt-14 text-[15px] font-semibold tracking-[-0.005em]">{children}</h2>
);

export function About() {
  return (
    <article className="max-w-[62ch] text-[15.5px] leading-[1.7] [&_p]:mt-4">
      <h1 className="text-[22px] font-medium tracking-[-0.015em]">Grid</h1>
      <p className="!mt-1 text-muted">A peer-to-peer market for compute.</p>

      <H2>Why</H2>
      <p>
        Renting a GPU today means renting it from a company. The company holds your money, sets the terms and decides
        who may sell and who may buy. Most of the machines belong to someone else anyway.
      </p>
      <p>
        Grid removes the company. Owners list their machines in a contract, renters pay that contract, and the two
        connect directly. There is no Grid server in the path and no fee in the contract.
      </p>

      <H2>How a rental works</H2>
      <ol className="mt-4 list-decimal space-y-3 pl-5 marker:text-faint">
        <li>
          A host lists a machine with <Code>listMachine</Code>: the GPU, memory, an hourly price in ETH and the https
          address of the host's node.
        </li>
        <li>
          You rent it with <Code>rent</Code>, paying for the hours you want. The ETH stays in the contract.
        </li>
        <li>
          The host's node sees the rental on-chain and starts a container. You sign a message with your wallet to
          prove the rental is yours, and the node gives you the SSH login.
        </li>
        <li>
          Either side can call <Code>endRental</Code> at any time, and anyone can once the paid hours are over. The
          host is paid for every started minute and you get the rest back. Both collect with <Code>withdraw</Code>.
        </li>
      </ol>
      <p>The market contract has no owner. Nobody can pause it, change its terms or hold your funds.</p>

      <H2>Hosting</H2>
      <p>
        Anyone with a machine can run a node and set their own price. For the first 30 days no bond is needed, but
        each rental is capped at 0.01 ETH. After that a host keeps GRID bonded to stay listed.{" "}
        <Link href="/host" className={linkClass}>
          Run a node
        </Link>
      </p>

      <H2>GRID</H2>
      <p>
        GRID is a bond, not a currency for compute. Hosts lock it to stay listed. It cannot be withdrawn while one of
        the host's rentals is running, takes seven days to come back, and part of it is burned if the host is proven
        to have cheated a renter. Compute is always paid in ETH, and renters never need GRID.
      </p>
      <p>
        GRID launches on the Creora launchpad with the Robinhood Chain launch. The whole supply goes on the bonding
        curve. There is no team allocation.
      </p>

      <H2>Where it stands</H2>
      <dl className="mt-4 grid grid-cols-[5.5rem_1fr] gap-x-4 gap-y-3">
        <dt className="font-mono text-[12px] leading-[1.7rem] text-ok">done</dt>
        <dd>The market contract, the bond registry, the host node and this app, tested end to end on a local chain.</dd>
        <dt className="font-mono text-[12px] leading-[1.7rem] text-busy">now</dt>
        <dd>Deploying to the Robinhood Chain testnet and running the first GPU host.</dd>
        <dt className="font-mono text-[12px] leading-[1.7rem] text-faint">next</dt>
        <dd>The Robinhood Chain launch, with GRID on Creora and bonded listings.</dd>
        <dt className="font-mono text-[12px] leading-[1.7rem] text-faint">later</dt>
        <dd>Jobs split across many hosts at once, and more than SSH inside a rental.</dd>
      </dl>

      <H2>Source</H2>
      <p>
        The contracts, the host node and this app are in one repository:{" "}
        <a className={linkClass} href={SOURCE_URL}>
          github.com/Grid-Decentralized-Compute/grid
        </a>
        .
      </p>
    </article>
  );
}
