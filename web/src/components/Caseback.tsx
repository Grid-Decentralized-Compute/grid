import { useEffect, useState } from "react";
import { useBlockNumber, useChainId, useChains } from "wagmi";
import { useDeployment } from "../contracts";
import { shortAddr } from "../lib/format";
import { SOURCE_URL, X_URL } from "../lib/links";
import { Link } from "../router";

/**
 * The footer, read like the caseback of a watch: the face stays plain, and here you can see
 * the movement working — the chain the page reads from, its latest block, the contract in use.
 */
export function Caseback() {
  const chainId = useChainId();
  const chain = useChains().find((c) => c.id === chainId);
  const deployment = useDeployment();
  const { data: block } = useBlockNumber({ watch: true });
  const [tick, setTick] = useState(false);

  // One beat of the steel index per new block.
  useEffect(() => {
    if (block === undefined) return;
    setTick(true);
    const t = setTimeout(() => setTick(false), 450);
    return () => clearTimeout(t);
  }, [block]);

  const explorer = chain?.blockExplorers?.default.url;
  const linkClass = "transition-colors hover:text-steel";

  return (
    <footer className="border-t border-ink/80 py-6">
      <div className="engraved flex flex-wrap items-center gap-x-8 gap-y-3 text-faint">
        <span className="text-muted">{chain?.name ?? "Unknown network"}</span>
        <span className="tnum flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`h-[7px] w-[2px] transition-colors duration-300 ${tick ? "bg-steel" : "bg-[#c4c5c0]"}`}
          />
          Block {block !== undefined ? block.toLocaleString("en-US") : "—"}
        </span>
        {deployment &&
          (explorer ? (
            <a
              href={`${explorer}/address/${deployment.GridMarket}`}
              className={`font-mono normal-case tracking-normal ${linkClass}`}
            >
              GridMarket {shortAddr(deployment.GridMarket)}
            </a>
          ) : (
            <span className="font-mono normal-case tracking-normal">GridMarket {shortAddr(deployment.GridMarket)}</span>
          ))}
      </div>

      <div className="mt-6 flex flex-wrap items-start justify-between gap-x-10 gap-y-4 text-[12px] leading-relaxed text-faint">
        <p className="max-w-[68ch]">
          Grid is experimental software provided as is, without warranty. Its contracts have not been audited. Nothing on
          this site is financial, investment, legal or tax advice.
        </p>
        <nav aria-label="Links" className="flex gap-5">
          <a href={X_URL} className={linkClass}>
            X
          </a>
          <a href={SOURCE_URL} className={linkClass}>
            GitHub
          </a>
          <Link href="/legal" className={linkClass}>
            Terms
          </Link>
          <Link href="/legal#privacy" className={linkClass}>
            Privacy
          </Link>
        </nav>
      </div>
    </footer>
  );
}
