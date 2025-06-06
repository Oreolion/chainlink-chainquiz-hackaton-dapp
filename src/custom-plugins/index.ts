export * from "./providers/wallet.ts";
export * from "./types/index.ts";

import type { Plugin } from "@elizaos/core";
import { evmWalletProvider } from "./providers/wallet.ts";

export const ChainQuizPlugin: Plugin = {
  name: "chainQuiz",
  description: "EVM blockchain integration plugin",
  providers: [evmWalletProvider],
  evaluators: [],
  services: [],
  clients: [], // no Twitter/Discord—our UI will be Next.js

};

export default ChainQuizPlugin;
