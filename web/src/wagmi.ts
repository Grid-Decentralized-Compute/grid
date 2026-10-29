import { createConfig, http } from "wagmi";
import { injected, mock } from "wagmi/connectors";
import { anvil, robinhood, robinhoodTestnet } from "@grid/shared";

// anvil's funded dev accounts: #2 plays the renter, #1 is the host node's default wallet
// (#0 deploys the contracts). The mock connector forwards signing to anvil, which holds these
// keys, so no browser wallet is needed to try the market locally. Dev builds only.
export const devWallets = [
  { label: "Renter (dev)", accounts: ["0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"] as const },
  { label: "Host (dev)", accounts: ["0x70997970C51812dc3A010C7d01b50e0d17dc79C8"] as const },
];

// The first chain is the default before a wallet connects. Until the Robinhood Chain launch the
// public site points at the testnet; the local chain only exists in dev builds.
const chains = import.meta.env.DEV
  ? ([anvil, robinhoodTestnet, robinhood] as const)
  : ([robinhoodTestnet, robinhood] as const);

export const config = createConfig({
  chains,
  connectors: [
    injected(),
    ...(import.meta.env.DEV ? devWallets.map((w) => mock({ accounts: w.accounts, features: { reconnect: true } })) : []),
  ],
  transports: {
    [anvil.id]: http(),
    [robinhoodTestnet.id]: http(),
    [robinhood.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
