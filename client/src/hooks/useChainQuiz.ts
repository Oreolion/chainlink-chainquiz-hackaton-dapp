// src/hooks/useChainQuiz.js

import { useAccount, useWriteContract } from "wagmi";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "wagmi/chains";
import ChainQuizABIJson from "../abis/ChainQuizABI.json";

const CHAIN_QUIZ_ADDRESS =
  (process.env.NEXT_PUBLIC_CHAINQUIZ_ADDRESS as `0x${string}`) || undefined;
const RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL as string | undefined;

// Extract the ABI array
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
    console.error(
      "NEXT_PUBLIC_CHAINQUIZ_ADDRESS is not defined or invalid in .env.local"
    );
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
          args: [domains],
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
          args: [],
        }),
      finishQuiz: async () =>
        writeContractAsync({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          functionName: "finishQuiz",
          args: [],
        }),
      requestRandomChallenge: async () =>
        writeContractAsync({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          functionName: "requestRandomChallenge",
          args: [],
        }),
      checkVRFAndGenerateQuiz: async (vrfRequestId: number) =>
        writeContractAsync({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          functionName: "checkVRFAndGenerateQuiz",
          args: [vrfRequestId],
        }),
    },
    watch: {
      // Each watchContractEvent: add console logs inside onLogs, fix arg names
      onQuizGenerated: (
        callback: (
          player: string,
          quizId: string,
          numQuestions: number,
          log: any
        ) => void
      ) =>
        publicClient.watchContractEvent({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "QuizGenerated",
          // `onLogs` gives an array of log entries
          onLogs: (logs) => {
            logs.forEach((log) => {
              console.log("[useChainQuiz] QuizGenerated log received:", log);
              // Arg names must match ABI: check your ABI event param names
              // e.g., event QuizGenerated(address indexed player, string quizId, uint8 numQuestions);
              const player = log.args.player;
              const quizId = log.args.quizId;
              // Ensure correct field name: often `numQuestions`, not `numQ`
              const numQuestions = Number(log.args.numQuestions);
              callback(player, quizId, numQuestions, log);
            });
          },
        }),
      onAnswerSubmitted: (
        callback: (
          player: string,
          isCorrect: boolean,
          questionIndex: number,
          log: any
        ) => void
      ) =>
        publicClient.watchContractEvent({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "AnswerSubmitted",
          onLogs: (logs) => {
            logs.forEach((log) => {
              console.log("[useChainQuiz] AnswerSubmitted log:", log);
              const player = log.args.player;
              const isCorrect = log.args.isCorrect;
              const questionIndex = Number(log.args.questionIndex);
              callback(player, isCorrect, questionIndex, log);
            });
          },
        }),
      onQuizCompleted: (
        callback: (player: string, correctCount: number, log: any) => void
      ) =>
        publicClient.watchContractEvent({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "QuizCompleted",
          onLogs: (logs) => {
            logs.forEach((log) => {
              console.log("[useChainQuiz] QuizCompleted log:", log);
              const player = log.args.player;
              const correctCount = Number(log.args.correctCount);
              callback(player, correctCount, log);
            });
          },
        }),
      onBonusAwarded: (
        callback: (player: string, bonus: bigint, log: any) => void
      ) =>
        publicClient.watchContractEvent({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "BonusAwarded",
          onLogs: (logs) => {
            logs.forEach((log) => {
              console.log("[useChainQuiz] BonusAwarded log:", log);
              const player = log.args.player;
              const bonus = log.args.bonus;
              callback(player, bonus, log);
            });
          },
        }),
      onLeaderboardRefreshed: (
        callback: (timestamp: bigint, log: any) => void
      ) =>
        publicClient.watchContractEvent({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "LeaderboardRefreshed",
          onLogs: (logs) => {
            logs.forEach((log) => {
              console.log("[useChainQuiz] LeaderboardRefreshed log:", log);
              const timestamp = log.args.timestamp;
              callback(timestamp, log);
            });
          },
        }),
      onQuizCancelled: (
        callback: (player: string, refund: bigint, log: any) => void
      ) =>
        publicClient.watchContractEvent({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "QuizCancelled",
          onLogs: (logs) => {
            logs.forEach((log) => {
              console.log("[useChainQuiz] QuizCancelled log:", log);
              const player = log.args.player;
              const refund = log.args.refund;
              callback(player, refund, log);
            });
          },
        }),
    },
  };
}
