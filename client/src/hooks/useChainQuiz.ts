import { useAccount, useWriteContract } from "wagmi";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "wagmi/chains";
import ChainQuizABIJson from "../abis/ChainQuizABI.json";

const CHAIN_QUIZ_ADDRESS = process.env
  .NEXT_PUBLIC_CHAINQUIZ_ADDRESS as `0x${string}`;
const RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL as string;
const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:5000";

const ChainQuizABI = Array.isArray(ChainQuizABIJson)
  ? ChainQuizABIJson
  : ChainQuizABIJson.abi || [];

export function useChainQuiz() {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();

  if (!CHAIN_QUIZ_ADDRESS?.startsWith("0x")) {
    console.error("Invalid NEXT_PUBLIC_CHAINQUIZ_ADDRESS");
    return null;
  }
  if (!RPC_URL) {
    console.error("NEXT_PUBLIC_BASE_RPC_URL is not defined");
    return null;
  }
  if (!address) {
    // no wallet connected
    return null;
  }

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  const generateQuestions = async (
    quizId: string,
    domains: string[],
    playerAddress: string,
    difficulty: string
  ) => {
    try {
      const res = await fetch(`${BACKEND_URL}/generateQuiz`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quizId, domains, playerAddress, difficulty }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (err) {
      console.error("generateQuestions error", err);
      return null;
    }
  };

  const verifyAnswer = async (
    quizId: string,
    playerAddress: string,
    questionIndex: number,
    answer: number
  ) => {
    try {
      const res = await fetch(`${BACKEND_URL}/verifyAnswer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quizId, playerAddress, questionIndex, answer }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()).isCorrect;
    } catch (err) {
      console.error("verifyAnswer error", err);
      return false;
    }
  };

  return {
    read: {
      sessions: (player: string) =>
        publicClient.readContract({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          functionName: "getSession",
          args: [player],
        }),
      getRequestStatus: (requestId: bigint) =>
        publicClient.readContract({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          functionName: "getRequestStatus",
          args: [requestId],
        }),
    },
    // useChainQuiz.ts (partial update for `write` section)
    write: {
      startQuiz: async (domains: string[]) => {
        try {
          const hash = await writeContractAsync({
            address: CHAIN_QUIZ_ADDRESS,
            abi: ChainQuizABI,
            functionName: "startQuiz",
            args: [domains],
            gas: BigInt(500000),
          });
          return { status: "success", transactionHash: hash };
        } catch (err: any) {
          console.error("startQuiz hook error:", err);
          return { status: "error", message: err.message };
        }
      },
      checkVRFAndGenerateQuiz: async (requestId: bigint) => {
        try {
          const hash = await writeContractAsync({
            address: CHAIN_QUIZ_ADDRESS,
            abi: ChainQuizABI,
            functionName: "checkVRFAndGenerateQuiz",
            args: [requestId],
            gas: BigInt(300000),
          });
          return { status: "success", transactionHash: hash };
        } catch (err: any) {
          console.error("checkVRFAndGenerateQuiz hook error:", err);
          return { status: "error", message: err.message };
        }
      },
      submitAnswer: async (answer: number) => {
        try {
          const hash = await writeContractAsync({
            address: CHAIN_QUIZ_ADDRESS,
            abi: ChainQuizABI,
            functionName: "submitAnswer",
            args: [answer],
            gas: BigInt(300000),
          });
          return { status: "success", transactionHash: hash };
        } catch (err: any) {
          console.error("submitAnswer hook error:", err);
          return { status: "error", message: err.message };
        }
      },
      recordAnswerResult: async (questionId: number, isCorrect: boolean) => {
        try {
          const hash = await writeContractAsync({
            address: CHAIN_QUIZ_ADDRESS,
            abi: ChainQuizABI,
            functionName: "recordAnswerResult",
            args: [questionId, isCorrect],
            gas: BigInt(300000),
          });
          return { status: "success", transactionHash: hash };
        } catch (err: any) {
          console.error("recordAnswerResult hook error:", err);
          return { status: "error", message: err.message };
        }
      },
      cancelQuiz: async () => {
        try {
          const hash = await writeContractAsync({
            address: CHAIN_QUIZ_ADDRESS,
            abi: ChainQuizABI,
            functionName: "cancelQuiz",
            args: [],
            gas: BigInt(200000),
          });
          return { status: "success", transactionHash: hash };
        } catch (err: any) {
          console.error("cancelQuiz hook error:", err);
          return { status: "error", message: err.message };
        }
      },
    },
    watch: {
      onVRFRequestInitiated: (
        cb: (requestId: bigint, player: string, log: any) => void
      ) =>
        publicClient.watchContractEvent({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "VRFRequestInitiated",
          onLogs: (logs) =>
            logs.forEach((log) => {
              cb(log.args.requestId, log.args.player, log);
            }),
        }),
      onQuizGenerated: (
        cb: (player: string, quizId: bigint, log: any) => void
      ) =>
        publicClient.watchContractEvent({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "QuizGenerated",
          onLogs: (logs) =>
            logs.forEach((log) => {
              const player = log.args.player;
              const quizId = log.args.quizId;
              cb(player, quizId, log);
              if (player.toLowerCase() === address.toLowerCase()) {
                // once on‐chain quizId is set, fetch questions
                publicClient
                  .readContract({
                    address: CHAIN_QUIZ_ADDRESS,
                    abi: ChainQuizABI,
                    functionName: "getSession",
                    args: [address],
                  })
                  .then((session: any) =>
                    generateQuestions(
                      session.quizId.toString(),
                      session.domains,
                      address,
                      session.numQuestions /* or store difficulty in front */
                    )
                  );
              }
            }),
        }),
      onAnswerSubmitted: (
        cb: (player: string, qId: number, answer: number, log: any) => void
      ) =>
        publicClient.watchContractEvent({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "AnswerSubmitted",
          onLogs: (logs) =>
            logs.forEach((log) => {
              const player = log.args.player;
              const qId = Number(log.args.questionId);
              const ans = Number(log.args.answer);
              cb(player, qId, ans, log);
              if (player.toLowerCase() === address.toLowerCase()) {
                publicClient
                  .readContract({
                    address: CHAIN_QUIZ_ADDRESS,
                    abi: ChainQuizABI,
                    functionName: "getSession",
                    args: [address],
                  })
                  .then((session: any) =>
                    verifyAnswer(
                      session.quizId.toString(),
                      address,
                      qId,
                      ans
                    ).then((isCorrect) =>
                      writeContractAsync({
                        address: CHAIN_QUIZ_ADDRESS,
                        abi: ChainQuizABI,
                        functionName: "recordAnswerResult",
                        args: [qId, isCorrect],
                      })
                    )
                  );
              }
            }),
        }),
      onAnswerResult: (
        callback: (
          player: string,
          questionId: number,
          isCorrect: boolean,
          log: any
        ) => void
      ) =>
        publicClient.watchContractEvent({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "AnswerResult",
          onLogs: (logs) =>
            logs.forEach((log) => {
              console.log("[useChainQuiz] AnswerResult log:", {
                log,
                timestamp: new Date().toISOString(),
              });
              callback(
                log.args.playerId,
                Number(log.args.questionId),
                log.args.isCorrect,
                log
              );
            }),
        }),
      onQuizCompleted: (
        callback: (
          player: string,
          correctCount: number,
          reward: bigint,
          rewardUSD: bigint,
          log: any
        ) => void
      ) =>
        publicClient.watchContractEvent({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "QuizCompleted",
          onLogs: (logs) =>
            logs.forEach((log) => {
              console.log("[useChainQuiz] QuizCompleted log:", {
                log,
                timestamp: new Date().toISOString(),
              });
              callback(
                log.args.playerId,
                Number(log.args.correctCount),
                log.args.reward,
                log.args.rewardUSD,
                log
              );
            }),
        }),
      onQuizCancelled: (callback: (player: string, log: any) => void) =>
        publicClient.watchContractEvent({
          address: CHAIN_QUIZ_ADDRESS,
          abi: ChainQuizABI,
          eventName: "QuizCancelled",
          onLogs: (logs) =>
            logs.forEach((log) => {
              console.log("[useChainQuiz] QuizCancelled log:", {
                log,
                timestamp: new Date().toISOString(),
              });
              callback(log.args.playerId, log);
            }),
        }),
    },
  };
}
