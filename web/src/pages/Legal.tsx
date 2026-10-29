import type { ReactNode } from "react";
import { linkClass } from "../components/ui";
import { CONTACT_EMAIL, SOURCE_URL, X_URL } from "../lib/links";

const UPDATED = "29 October 2026";

function Part({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-8">
      <h2 className="engraved mt-14 border-b border-rule pb-2 text-ink">{title}</h2>
      {children}
    </section>
  );
}

const List = ({ children }: { children: ReactNode }) => (
  <ul className="mt-4 list-disc space-y-2.5 pl-5 marker:text-faint">{children}</ul>
);

export function Legal() {
  return (
    <article className="max-w-[64ch] text-[15px] leading-[1.7] [&_p]:mt-4">
      <h1 className="font-serif text-[34px] font-light leading-[1.1] tracking-[-0.01em]">Legal</h1>
      <p className="!mt-2 text-muted">Disclaimer, terms of use, risks and privacy. Last updated {UPDATED}.</p>
      <nav aria-label="On this page" className="mt-6 flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
        {[
          ["disclaimer", "Disclaimer"],
          ["terms", "Terms"],
          ["risks", "Risks"],
          ["grid", "GRID"],
          ["use", "Acceptable use"],
          ["privacy", "Privacy"],
          ["contact", "Contact"],
        ].map(([id, label]) => (
          <a key={id} href={`#${id}`} className="text-muted transition-colors hover:text-steel">
            {label}
          </a>
        ))}
      </nav>

      <Part id="disclaimer" title="Disclaimer">
        <p>
          Grid is experimental software provided as is, without warranty. Its contracts have not been audited. Nothing on
          this site is financial, investment, legal or tax advice.
        </p>
      </Part>

      <Part id="terms" title="Terms of use">
        <p>
          This site is an interface to the Grid smart contracts on Robinhood Chain. By using it you agree to these terms.
          If you do not agree, do not use the site.
        </p>
        <List>
          <li>
            Grid is software: a set of smart contracts, a host program and this interface. The site does not hold funds,
            does not operate the contracts and is not a party to any rental. A rental is an arrangement between a renter
            and a host, settled by the contracts.
          </li>
          <li>
            The software is provided "as is" and "as available", without warranty of any kind, express or implied,
            including merchantability, fitness for a particular purpose and non-infringement. To the fullest extent
            permitted by law, the people who build and maintain Grid are not liable for any loss or damage arising from
            your use of the site, the contracts or the host software, including loss of funds, data, profits or access.
          </li>
          <li>
            You are responsible for your wallet, its keys and every transaction you sign. Blockchain transactions are
            final; nobody can reverse or refund them on your behalf.
          </li>
          <li>
            You must follow the laws that apply to you, including sanctions and export controls. Do not use Grid if you
            are located in, or acting for a person or entity in, a comprehensively sanctioned country or region, or if
            you appear on a government sanctions list.
          </li>
          <li>These terms can change. The date at the top of this page shows the latest version.</li>
        </List>
      </Part>

      <Part id="risks" title="Risks">
        <List>
          <li>
            The contracts have not been audited. They may contain errors that lead to the loss of funds held in them.
          </li>
          <li>
            Hosts are independent. A machine may be slower than listed, go offline or fail during a rental. The contract
            refunds time that was paid for but not started; it does not cover any other loss, such as an interrupted job.
          </li>
          <li>
            A host can see what runs on their machine. Do not place keys, credentials or sensitive data on a machine you
            do not control.
          </li>
          <li>
            A swarm job's description, including every task input, is published on-chain and can be read by anyone. Task
            outputs are kept by the hosts that produced them and can be fetched by anyone who knows the job.
          </li>
          <li>
            Robinhood Chain can be congested, unavailable or changed by its operators. Fees, delays and outages are
            outside Grid's control.
          </li>
          <li>
            On a testnet, ETH and GRID have no value, and deployments may be replaced or reset at any time.
          </li>
        </List>
      </Part>

      <Part id="grid" title="GRID">
        <List>
          <li>
            GRID is the bond hosts post to stay listed. It is not used to pay for compute, gives no share of revenue or
            profit, no claim on anyone and no governance rights.
          </li>
          <li>
            GRID may lose some or all of its value. Its price is set by trading and nobody guarantees a market for it.
          </li>
          <li>
            Nothing on this site is an offer or solicitation to buy or sell any token, or a recommendation to do so. It is
            not financial, investment, legal or tax advice. Check whether you may hold GRID where you live.
          </li>
        </List>
      </Part>

      <Part id="use" title="Acceptable use">
        <p>Renters and hosts must not use Grid to:</p>
        <List>
          <li>create, store or distribute material that sexually exploits children;</li>
          <li>run malware, attack or scan systems without permission, or send spam;</li>
          <li>do anything that is illegal where the renter or the host is located;</li>
          <li>infringe the rights of others, or evade sanctions.</li>
        </List>
        <p>
          A host can end any rental on their machine at any time. This site may stop showing listings or rentals that are
          reported for abuse, and reports may be passed to the authorities.
        </p>
      </Part>

      <Part id="privacy" title="Privacy">
        <List>
          <li>The site has no accounts and uses no cookies, analytics or tracking.</li>
          <li>
            Your browser stores your wallet connection preference in its local storage. It stays on your device.
          </li>
          <li>
            When you connect a wallet, its address and every transaction you send are public on Robinhood Chain. This is
            how blockchains work; this site cannot hide or delete that record.
          </li>
          <li>
            Your browser connects directly to the Robinhood Chain RPC service, to the host nodes you rent from, to
            Cloudflare, which serves this site, and to Google Fonts, which serves its typefaces. Each of them receives
            your IP address and handles it under its own policy. Host nodes are run by independent operators.
          </li>
        </List>
      </Part>

      <Part id="contact" title="Contact">
        <p>
          Abuse reports, security issues and legal requests:{" "}
          <a className={linkClass} href={`mailto:${CONTACT_EMAIL}`}>
            {CONTACT_EMAIL}
          </a>
          . Source code on{" "}
          <a className={linkClass} href={SOURCE_URL}>
            GitHub
          </a>
          , under the{" "}
          <a className={linkClass} href={`${SOURCE_URL}/blob/main/LICENSE`}>
            MIT license
          </a>
          ; updates on{" "}
          <a className={linkClass} href={X_URL}>
            X
          </a>
          .
        </p>
      </Part>
    </article>
  );
}
