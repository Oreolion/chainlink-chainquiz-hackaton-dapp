import { useAccount, useWriteContract } from "wagmi";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "wagmi/chains";
import ChainQuizABIJson from "../abis/ChainQuizABI.json";

const CHAIN_QUIZ_ADDRESS = process.env.NEXT_PUBLIC_CHAINQUIZ_ADDRESS as `0x${string}` | undefined;
const RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL as string | undefined;

// Extract the ABI array, handling wrapped formats
const ChainQuizABI = Array.isArray(ChainQuizABIJson)
  ? ChainQuizABIJson
  : ChainQuizABIJson.abi || [];

if (!Array.isArray(ChainQuizABI)) {
  console.error("ChainQuizABI is not a valid ABI array:", ChainQuizABI);
}

export function useChainQuiz() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();

  if (!CHAIN_QUIZ_ADDRESS || !CHAIN_QUIZ_ADDRESS.startsWith("0x")) {
    console.error("NEXT_PUBLIC_CHAINQUIZ_ADDRESS is not defined or invalid in .env.local");
    return null;
  }

  if (!RPC_URL) {
    console.error("NEXT_PUBLIC_BASE_RPC_URL is not defined in .env.local");
    return null;
  }

  if (!address) {
    return null;
  }

  if (!ChainQuizABI.length) {
    console.error("ChainQuizABI is empty or invalid");
    return null;
  }

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  return {
    read: {
      sessions: async (player: string) =>
        publicClient.readContract({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          functionName: "sessions",
          args: [player],
        }),
    },
    write: {
      startQuiz: async (domains: string[]) =>
        writeContractAsync({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          functionName: "startQuiz",
          args: [domains], // Wrap domains in an array
        }),
      submitAnswer: async (selectedIndex: number) =>
        writeContractAsync({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          functionName: "submitAnswer",
          args: [selectedIndex],
        }),
      cancelQuiz: async () =>
        writeContractAsync({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          functionName: "cancelQuiz",
          args: [], // Explicitly set empty args
        }),
      finishQuiz: async () =>
        writeContractAsync({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          functionName: "finishQuiz",
          args: [], // Explicitly set empty args
        }),
      requestRandomChallenge: async () =>
        writeContractAsync({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          functionName: "requestRandomChallenge",
          args: [], // Explicitly set empty args
        }),
    },
    watch: {
      onQuizGenerated: (callback: (player: string, quizId: string, numQ: number) => void) =>
        publicClient.watchContractEvent({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "QuizGenerated",
          onLogs: (logs) =>
            logs.forEach((log) =>
              callback(log.args.player, log.args.quizId, Number(log.args.numQ))
            ),
        }),
      onAnswerSubmitted: (callback: (player: string, isCorrect: boolean, questionIndex: number) => void) =>
        publicClient.watchContractEvent({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "AnswerSubmitted",
          onLogs: (logs) =>
            logs.forEach((log) =>
              callback(log.args.player, log.args.isCorrect, Number(log.args.questionIndex))
            ),
        }),
      onQuizCompleted: (callback: (player: string, correctCount: number) => void) =>
        publicClient.watchContractEvent({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "QuizCompleted",
          onLogs: (logs) =>
            logs.forEach((log) =>
              callback(log.args.player, Number(log.args.correctCount))
            ),
        }),
      onBonusAwarded: (callback: (player: string, bonus: bigint) => void) =>
        publicClient.watchContractEvent({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "BonusAwarded",
          onLogs: (logs) =>
            logs.forEach((log) =>
              callback(log.args.player, log.args.bonus)
            ),
        }),
      onLeaderboardRefreshed: (callback: (timestamp: bigint) => void) =>
        publicClient.watchContractEvent({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "LeaderboardRefreshed",
          onLogs: (logs) =>
            logs.forEach((log) =>
              callback(log.args.timestamp)
            ),
        }),
      onQuizCancelled: (callback: (player: string, refund: bigint) => void) =>
        publicClient.watchContractEvent({
          address: CHAIN_QUIZ_ADDRESS,
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