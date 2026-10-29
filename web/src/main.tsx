import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WagmiProvider } from "wagmi";
import "lenis/dist/lenis.css";
import App from "./App";
import "./index.css";
import { startSmoothScroll } from "./lib/motion";
import { config } from "./wagmi";

const queryClient = new QueryClient();
startSmoothScroll();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
