import { type ReactNode, useLayoutEffect, useRef } from "react";
import { ProtocolStory } from "../components/ProtocolStory";
import { H2, linkClass } from "../components/ui";
import { DOCS_URL, SOURCE_URL } from "../lib/links";
import { gsap, reducedMotion, SplitText } from "../lib/motion";
import { Link } from "../router";

/** Who runs each part of Grid, and what happens when it stops. Keep in step with docs/decentralization.md. */
const PARTS: { name: string; runBy: ReactNode; ifItStops: ReactNode }[] = [
  {
    name: "Market and escrow",
    runBy:
      "GridMarket and SwarmMarket, contracts on Robinhood Chain. They have no owner and cannot be upgraded. A fixed fee of 2% comes out of the host's side of every payment, 1% for bonded hosts, and accrues to the treasury.",
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

/** The title's letters rise into place; each section's rule draws across and its heading types in as it arrives. */
function useEngraving() {
  const root = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || reducedMotion()) return;
    const ctx = gsap.context(() => {
      const title = el.querySelector("h1");
      if (title)
        SplitText.create(title, {
          type: "chars",
          mask: "chars",
          onSplit: (self) => gsap.from(self.chars, { yPercent: 118, duration: 1.2, ease: "expo.out", stagger: 0.06, delay: 0.05 }),
        });
      for (const h of gsap.utils.toArray<HTMLElement>("[data-split]", el)) {
        const text = h.querySelector("[data-split-text]");
        const rule = h.querySelector("[data-split-rule]");
        if (!text || !rule) continue;
        SplitText.create(text, {
          type: "chars",
          mask: "chars",
          onSplit: (self) =>
            gsap
              .timeline({ scrollTrigger: { trigger: h, start: "top 90%", once: true } })
              .from(rule, { scaleX: 0, duration: 1, ease: "expo.out" }, 0)
              .from(self.chars, { yPercent: 110, duration: 0.65, ease: "expo.out", stagger: 0.022 }, 0.1),
        });
      }
    }, el);
    return () => ctx.revert();
  }, []);
  return root;
}

const Prose = ({ children }: { children: ReactNode }) => <div className="max-w-[62ch]">{children}</div>;

export function About() {
  const root = useEngraving();
  return (
    <article ref={root} className="text-[15.5px] leading-[1.7] [&_p]:mt-4">
      <Prose>
      <h1 className="font-serif text-[34px] font-light leading-[1.1] tracking-[-0.01em]">Grid</h1>
      <p className="!mt-2 text-muted">Decentralized compute network on Robinhood Chain.</p>

      <H2>How it works</H2>
      <p>
        Trustless batch compute has been tried for fifteen years and never worked, because the buyer had to be a human
        holding a token nobody wanted. Grid is built for a different buyer: an AI agent holding ETH. It posts a job, idle
        GPUs across the network run it, every task on two machines that have to agree before anyone is paid, and it pays
        for nothing else. Robinhood Chain is cheap enough to settle every task on-chain, and no company sits in between:
        Grid is two contracts and a small program hosts run next to their GPUs.
      </p>
      <p>
        A swarm job is the main way to rent. A direct rental, one machine with an SSH login, is still there for anyone who
        wants a whole machine to themselves.
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

      </Prose>

      <ProtocolStory />

      <Prose>
      <H2>Hosting</H2>
      <p>
        Any machine that can run Docker can be listed, and the host sets the price.{" "}
        <Link href="/host" className={linkClass}>
          Running a node
        </Link>{" "}
        takes a wallet, an https address for the node and a few minutes of setup.
      </p>

      <H2>Agents</H2>
      <p>
        Grid needs no account, only a wallet, so an AI agent can use it on its own. The Grid MCP server gives agents
        such as Claude or ChatGPT the market as tools: find free GPUs, run a batch job and get back outputs two hosts
        agreed on, with a receipt for every task, and run the host side of a machine. A company can fund an agent through
        a compute allowance, a small contract that caps what the agent may spend per day and keeps refunds out of its
        reach. There is a command line for the same things.{" "}
        <a className={linkClass} href={`${DOCS_URL}/guides/agents`}>
          Setting it up
        </a>
      </p>

      <H2>Fee</H2>
      <p>
        Hosts pay a protocol fee of 2% of what they earn, 1% while bonded. It comes out of the host's side: a renter pays
        the price that was listed and nothing more. The rate is written into the contracts and cannot be raised. Fees
        accrue in ETH to the treasury, which withdraws them like anyone else.
      </p>

      <H2>GRID</H2>
      <p>
        GRID is the bond hosts post to stay listed. It is not required for a host's first 30 days, but until a host is
        bonded each rental is capped at 0.01 ETH. A bond cannot be withdrawn while one of the host's rentals is running,
        takes seven days to unlock, and can be slashed if the host is shown to have cheated a renter. A bonded host also
        pays the lower fee. Rentals are always paid in ETH; renters never need GRID.
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
      </Prose>
    </article>
  );
}
