import { http, createConfig } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { metaMask } from "wagmi/connectors";

export const config = createConfig({
  chains: [baseSepolia],
  connectors: [metaMask()],
  transports: {
    [baseSepolia.id]: http("https://sepolia.base.org"), // Base Sepolia RPC
  },
});