import { useAccount, useWriteContract } from "wagmi";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "wagmi/chains";
import  ChainQuizABI  from "../abis/ChainQuizABI.json";
import QuizTokenABI  from "../abis/QuizTokenABI.json";

const CHAINQUIZ_ADDRESS = process.env.NEXT_PUBLIC_CHAINQUIZ_ADDRESS as `0x${string}` | undefined;
const QUIZTOKEN_ADDRESS = process.env.NEXT_PUBLIC_QUIZTOKEN_ADDRESS as `0x${string}` | undefined;

export function useChainQuiz() {
  if (!CHAINQUIZ_ADDRESS || !CHAINQUIZ_ADDRESS.startsWith("0x")) {
    console.error("NEXT_PUBLIC_CHAINQUIZ_ADDRESS is not defined or invalid in .env.local");
    return null; // Return null to indicate hook failurepnpm
  }

  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
  });

  return {
    read: {
      sessions: async (player: string) =>
        publicClient.readContract({
          address: CHAINQUIZ_ADDRESS,
          abi: ChainQuizABI,
          functionName: "sessions",
          args: [player],
        }),
    },
    write: {
      startQuiz: async (domains: string[]) =>
        writeContractAsync({
          address: CHAINQUIZ_ADDRESS,
          abi: ChainQuizABI,
          functionName: "startQuiz",
          args: [domains],
        }),
      submitAnswer: async (selectedIndex: number) =>
        writeContractAsync({
          address: CHAINQUIZ_ADDRESS,
          abi: ChainQuizABI,
          functionName: "submitAnswer",
          args: [selectedIndex],
        }),
      cancelQuiz: async () =>
        writeContractAsync({
          address: CHAINQUIZ_ADDRESS,
          abi: ChainQuizABI,
          functionName: "cancelQuiz",
        }),
      finishQuiz: async () =>
        writeContractAsync({
          address: CHAINQUIZ_ADDRESS,
          abi: ChainQuizABI,
          functionName: "finishQuiz",
        }),
      requestRandomChallenge: async () =>
        writeContractAsync({
          address: CHAINQUIZ_ADDRESS,
          abi: ChainQuizABI,
          functionName: "requestRandomChallenge",
        }),
    },
    watch: {
      onQuizGenerated: (callback: (player: string, quizId: string, numQ: number) => void) =>
        publicClient.watchContractEvent({
          address: CHAINQUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "QuizGenerated",
          onLogs: (logs) =>
            logs.forEach((log) =>
              callback(log.args.player, log.args.quizId, Number(log.args.numQ))
            ),
        }),
      onAnswerSubmitted: (callback: (player: string, isCorrect: boolean, questionIndex: number) => void) =>
        publicClient.watchContractEvent({
          address: CHAINQUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "AnswerSubmitted",
          onLogs: (logs) =>
            logs.forEach((log) =>
              callback(log.args.player, log.args.isCorrect, Number(log.args.questionIndex))
            ),
        }),
      onQuizCompleted: (callback: (player: string, correctCount: number) => void) =>
        publicClient.watchContractEvent({
          address: CHAINQUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "QuizCompleted",
          onLogs: (logs) =>
            logs.forEach((log) =>
              callback(log.args.player, Number(log.args.correctCount))
            ),
        }),
      onBonusAwarded: (callback: (player: string, bonus: bigint) => void) =>
        publicClient.watchContractEvent({
          address: CHAINQUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "BonusAwarded",
          onLogs: (logs) =>
            logs.forEach((log) =>
              callback(log.args.player, log.args.bonus)
            ),
        }),
      onLeaderboardRefreshed: (callback: (timestamp: bigint) => void) =>
        publicClient.watchContractEvent({
          address: CHAINQUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "LeaderboardRefreshed",
          onLogs: (logs) =>
            logs.forEach((log) =>
              callback(log.args.timestamp)
            ),
        }),
      onQuizCancelled: (callback: (player: string, refund: bigint) => void) =>
        publicClient.watchContractEvent({
          address: CHAINQUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "QuizCancelled",
          onLogs: (logs) =>
            logs.forEach((log) =>
              callback(log.args.player, log.args.refund)
            ),
        }),
    },
  };
}

export function useQuizToken() {
  if (!QUIZTOKEN_ADDRESS || !QUIZTOKEN_ADDRESS.startsWith("0x")) {
    console.error("NEXT_PUBLIC_QUIZTOKEN_ADDRESS is not defined or invalid in .env.local");
    return null; // Return null to indicate hook failure
  }

  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
  });

  return {
    read: {
      balanceOf: async (account: string) =>
        publicClient.readContract({
          address: QUIZTOKEN_ADDRESS,
          abi: QuizTokenABI,
          functionName: "balanceOf",
          args: [account],
        }),
      allowance: async (owner: string, spender: string) =>
        publicClient.readContract({
          address: QUIZTOKEN_ADDRESS,
          abi: QuizTokenABI,
          functionName: "allowance",
          args: [owner, spender],
        }),
    },
    write: {
      approve: async (spender: string, amount: bigint) =>
        writeContractAsync({
          address: QUIZTOKEN_ADDRESS,
          abi: QuizTokenABI,
          functionName: "approve",
          args: [spender, amount],
        }),
    },
  };
}