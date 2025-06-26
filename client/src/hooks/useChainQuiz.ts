import { useCallback, useEffect, useState } from "react";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "wagmi/chains";
import { formatEther, stringToHex } from "viem";
import chainQuizData from "../abis/ChainQuizABI.json";

// Extract the abi array from the object
const chainQuizABI = chainQuizData.abi;
const CHAIN_QUIZ_ADDRESS = process.env.NEXT_PUBLIC_CHAINQUIZ_ADDRESS as `0x${string}`;
const RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://sepolia.base.org";
const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:5000";

export function useChainQuiz() {
  const { address, status } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [quizId, setQuizId] = useState<string>("");
  const [isActive, setIsActive] = useState<boolean>(false);
  const [questionIndex, setQuestionIndex] = useState<number>(0);
  const [numQuestions, setNumQuestions] = useState<number>(0);
  const [lastRequestId, setLastRequestId] = useState<`0x${string}` | null>(null);
  const [reward, setReward] = useState<string>("");
  const [rewardUSD, setRewardUSD] = useState<string>("");

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  const { data: sessionData, refetch: refetchSession } = useReadContract({
    address: CHAIN_QUIZ_ADDRESS,
    abi: chainQuizABI,
    functionName: "sessions",
    args: [address],
    query: {
      enabled: !!address && status === "connected",
    },
  });

  useEffect(() => {
    if (sessionData && address) {
      const [
        quizIdFromContract,
        questionIndexFromContract,
        correctCountFromContract,
        startedAtFromContract,
        activeFromContract,
        numQuestionsFromContract,
      ] = sessionData as [string, bigint | number, bigint | number, bigint | number, boolean, bigint | number];

      setQuizId(quizIdFromContract);
      setIsActive(activeFromContract);
      setQuestionIndex(Number(questionIndexFromContract));
      setNumQuestions(Number(numQuestionsFromContract));
      const safeCorrectCount = typeof correctCountFromContract === "bigint" ? correctCountFromContract : BigInt(correctCountFromContract);
      setReward(formatEther(safeCorrectCount * 50000000000000000n));
      setRewardUSD("0");
    }
  }, [sessionData, address]);

  const startQuiz = useCallback(
    async (domains: string[], difficulty: string) => {
      if (!address || status !== "connected") throw new Error("Wallet not connected");
      if (!publicClient) throw new Error("Public client not initialized");
      try {
        console.log("startQuiz: Preparing transaction", {
          domains,
          difficulty,
          address,
          chainQuizAddress: CHAIN_QUIZ_ADDRESS,
          timestamp: new Date().toISOString(),
        });

        // Verify ABI is an array
        if (!Array.isArray(chainQuizABI)) {
          throw new Error("Invalid ABI: chainQuizABI is not an array");
        }

        // Simulate the transaction
        try {
          await publicClient.simulateContract({
            address: CHAIN_QUIZ_ADDRESS,
            abi: chainQuizABI,
            functionName: "startQuiz",
            args: [domains, difficulty],
            account: address,
          });
          console.log("startQuiz: Simulation successful", {
            domains,
            difficulty,
            address,
            timestamp: new Date().toISOString(),
          });
        } catch (simulationError: any) {
          console.error("startQuiz: Simulation failed", {
            error: simulationError.message,
            details: simulationError,
            domains,
            difficulty,
            address,
            timestamp: new Date().toISOString(),
          });
          throw new Error(`Transaction simulation failed: ${simulationError.message}`);
        }

        // Execute the transaction
        const hash = await writeContractAsync({
          address: CHAIN_QUIZ_ADDRESS,
          abi: chainQuizABI,
          functionName: "startQuiz",
          args: [domains, difficulty],
          gas: BigInt(5000000),
          gasPrice: BigInt(5000000000), // 5 Gwei
        });
        console.log("startQuiz: Transaction sent", {
          hash,
          domains,
          difficulty,
          address,
          timestamp: new Date().toISOString(),
        });

        // Wait for transaction receipt
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        console.log("startQuiz: Receipt", {
          hash,
          status: receipt.status,
          address,
          timestamp: new Date().toISOString(),
        });

        if (receipt.status !== "success") {
          throw new Error("Transaction reverted. Check contract logs for details.");
        }

        await refetchSession();
        return hash;
      } catch (err: any) {
        console.error("startQuiz error:", {
          message: err.message,
          details: err,
          domains,
          difficulty,
          address,
          timestamp: new Date().toISOString(),
        });
        throw err;
      }
    },
    [address, status, writeContractAsync, publicClient, refetchSession]
  );

  const submitAnswer = useCallback(
    async (answer: number) => {
      if (!address || status !== "connected") throw new Error("Wallet not connected");
      try {
        console.log("submitAnswer:", { answer, quizId, questionIndex });
        const hash = await writeContractAsync({
          address: CHAIN_QUIZ_ADDRESS,
          abi: chainQuizABI,
          functionName: "submitAnswer",
          args: [answer],
          gas: BigInt(300000),
          gasPrice: BigInt(5000000000), // 5 Gwei
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        console.log("submitAnswer success:", { hash, status: receipt.status });
        await refetchSession();
        return hash;
      } catch (err: any) {
        console.error("submitAnswer error:", {
          message: err.message,
          details: err,
        });
        throw new Error(err.message);
      }
    },
    [address, status, quizId, questionIndex, writeContractAsync, publicClient, refetchSession]
  );

  const cancelQuiz = useCallback(
    async () => {
      if (!address || status !== "connected") throw new Error("Wallet not connected");
      try {
        console.log("cancelQuiz:", { quizId });
        const hash = await writeContractAsync({
          address: CHAIN_QUIZ_ADDRESS,
          abi: chainQuizABI,
          functionName: "cancelQuiz",
          args: [],
          gas: BigInt(200000),
          gasPrice: BigInt(5000000000), // 5 Gwei
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        console.log("cancelQuiz success:", { hash, status: receipt.status });
        await refetchSession();
        return hash;
      } catch (err: any) {
        console.error("cancelQuiz error:", {
          message: err.message,
          details: err,
        });
        throw new Error(err.message);
      }
    },
    [address, status, quizId, writeContractAsync, publicClient, refetchSession]
  );

  const debugFulfillRequest = useCallback(
    async (requestId: `0x${string}`, response: string, err: string) => {
      if (!address || status !== "connected") throw new Error("Wallet not connected");
      try {
        console.log("debugFulfillRequest:", { requestId, response, err });
        const responseBytes = stringToHex(response);
        const errBytes = stringToHex(err);
        const hash = await writeContractAsync({
          address: CHAIN_QUIZ_ADDRESS,
          abi: chainQuizABI,
          functionName: "debugFulfillRequest",
          args: [requestId, responseBytes, errBytes],
          gas: BigInt(300000),
          gasPrice: BigInt(5000000000), // 5 Gwei
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        console.log("debugFulfillRequest success:", { hash, status: receipt.status });
        await refetchSession();
        return hash;
      } catch (err: any) {
        console.error("debugFulfillRequest error:", {
          message: err.message,
          details: err,
        });
        throw new Error(err.message);
      }
    },
    [address, status, writeContractAsync, publicClient, refetchSession]
  );

  const generateQuestions = useCallback(
    async (quizId: string, domains: string[], playerAddress: string, difficulty: string) => {
      try {
        console.log("generateQuestions:", { quizId, domains, playerAddress, difficulty });
        const res = await fetch(`${BACKEND_URL}/generateQuiz`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ quizId, domains, playerAddress, difficulty }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        console.log("generateQuestions success:", data);
        return data;
      } catch (err: any) {
        console.error("generateQuestions error:", {
          message: err.message,
          details: err,
        });
        throw err;
      }
    },
    []
  );

  const verifyAnswer = useCallback(
    async (quizId: string, playerAddress: string, questionIndex: number, answer: number) => {
      try {
        console.log("verifyAnswer:", { quizId, playerAddress, questionIndex, answer });
        const res = await fetch(`${BACKEND_URL}/verifyAnswer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ quizId, playerAddress, questionIndex, answer }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { isCorrect } = await res.json();
        console.log("verifyAnswer success:", { isCorrect });
        return isCorrect;
      } catch (err: any) {
        console.error("verifyAnswer error:", {
          message: err.message,
          details: err,
        });
        throw err;
      }
    },
    []
  );

  return {
    contractAddress: CHAIN_QUIZ_ADDRESS,
    quizId,
    isActive,
    questionIndex,
    numQuestions,
    lastRequestId,
    reward,
    rewardUSD,
    setQuizId,
    setLastRequestId,
    setReward,
    setRewardUSD,
    startQuiz,
    submitAnswer,
    cancelQuiz,
    debugFulfillRequest,
    generateQuestions,
    verifyAnswer,
  };
}