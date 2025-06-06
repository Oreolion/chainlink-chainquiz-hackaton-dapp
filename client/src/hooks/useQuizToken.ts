import { useAccount } from "wagmi";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "wagmi/chains";
import QuizTokenABI from "../abis/QuizTokenABI.json";

const QUIZ_TOKEN_ADDRESS = process.env.NEXT_PUBLIC_QUIZTOKEN_ADDRESS as `0x${string}` | undefined;
const RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL as string | undefined;

export function useQuizToken() {
  const { address } = useAccount();

  if (!QUIZ_TOKEN_ADDRESS || !QUIZ_TOKEN_ADDRESS.startsWith("0x")) {
    console.error("NEXT_PUBLIC_QUIZTOKEN_ADDRESS is not defined or invalid in .env.local");
    return null;
  }

  if (!RPC_URL) {
    console.error("NEXT_PUBLIC_BASE_RPC_URL is not defined in .env.local");
    return null;
  }

  if (!address) {
    return null;
  }

  const publicClient = createPublicClient({
    chain: baseSepolia, // Chain ID 84532
    transport: http(RPC_URL),
  });

  return {
    write: {
      approve: async (args: readonly [string, bigint]) =>
        publicClient.writeContract({
          address: QUIZ_TOKEN_ADDRESS,
          abi: QuizTokenABI,
          functionName: "approve",
          args,
          account: address,
        }),
    },
    read: {
      balanceOf: async (addr: string) =>
        publicClient.readContract({
          address: QUIZ_TOKEN_ADDRESS,
          abi: QuizTokenABI,
          functionName: "balanceOf",
          args: [addr],
        }),
    },
  };
}