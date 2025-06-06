import { Character, Clients, defaultCharacter, ModelProviderName } from "@elizaos/core";
import { ChainQuizPlugin } from "./custom-plugins/index.ts";

export const character: Character = {
  ...defaultCharacter,
  // name: "Eliza",
  plugins: [ChainQuizPlugin],
  clients: [],
  modelProvider: ModelProviderName.OPENAI,
  settings: {
    secrets: {},
    voice: {
      model: "en_US-hfc_female-medium",
    },
    chains: {
      evm: ["baseSepolia"],
    },
  },
};
