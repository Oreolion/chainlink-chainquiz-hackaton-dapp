import * as viemChains from "viem/chains";
import { Hash, Address } from "viem";

const _SupportedChainList = Object.keys(viemChains) as Array<
  keyof typeof viemChains
>;
export type SupportedChain = (typeof _SupportedChainList)[number];
export interface QuizParams {
  action: "START" | "SUBMIT" | "FINISH" | "REQUEST_CHALLENGE";
  contractAddress: Address;
  domains: string[];
  playerAddress: Address;
  donHostedSecretsSlotID: number;
  donHostedSecretsVersion: number;
  clSubId: number;
  difficulty?: "beginner" | "intermediate" | "advanced";
  selectedIndex?: number;
}

export interface Transaction {
  hash: Hash;
  from: Address;
  to: Address;
  value: bigint;
  data?: `0x${string}`;
  chainId?: number;
}
