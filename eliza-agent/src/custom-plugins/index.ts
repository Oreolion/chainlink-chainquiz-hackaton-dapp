export * from "./providers/wallet";
export * from "./types/index";

import type { Plugin } from "@elizaos/core";
import { evmWalletProvider } from "./providers/wallet";
import { chainQuizAction } from "./actions/ChainQuizAction";

export const ChainQuizPlugin: Plugin = {
  name: "chainQuiz",
  description: "EVM blockchain integration plugin",
  providers: [evmWalletProvider],
  evaluators: [],
  services: [],
  clients: [], // no Twitter/Discord—our UI will be Next.js
  actions: [chainQuizAction],

};

