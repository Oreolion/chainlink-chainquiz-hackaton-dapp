import { useCallback, useEffect, useState } from "react";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "wagmi/chains";
import { formatEther, stringToHex } from "viem";
import chainQuizData from "../abis/ChainQuizABI.json";

// Extract the abi array from the object
const chainQuizABI = chainQuizData.abi;
const CHAIN_QUIZ_ADDRESS = process.env
  .NEXT_PUBLIC_CHAINQUIZ_ADDRESS as `0x${string}`;
const RPC_URL =
  process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://sepolia.base.org";
const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:5000";

export function useChainQuiz() {
  const { address, status } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [quizId, setQuizId] = useState<string>("");
  const [isActive, setIsActive] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [questionIndex, setQuestionIndex] = useState<number>(0);
  const [numQuestions, setNumQuestions] = useState<number>(0);
  const [lastRequestId, setLastRequestId] = useState<`0x${string}` | null>(
    null
  );
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
      ] = sessionData as [
        string,
        bigint | number,
        bigint | number,
        bigint | number,
        boolean,
        bigint | number
      ];

      setQuizId(quizIdFromContract);
      setIsActive(activeFromContract);
      setQuestionIndex(Number(questionIndexFromContract));
      setNumQuestions(Number(numQuestionsFromContract));
      const safeCorrectCount =
        typeof correctCountFromContract === "bigint"
          ? correctCountFromContract
          : BigInt(correctCountFromContract);
      setReward(formatEther(safeCorrectCount * 50000000000000000n));
      setRewardUSD("0");
    }
  }, [sessionData, address]);

  const startQuiz = useCallback(
    async (domains: string[], difficulty: string) => {
      if (!address || status !== "connected") {
        throw new Error("Wallet not connected");
      }
      if (!publicClient) {
        throw new Error("Public client not initialized");
      }

      try {
        console.log("startQuiz: Preparing transaction", {
          domains,
          difficulty,
          address,
          chainQuizAddress: CHAIN_QUIZ_ADDRESS,
          timestamp: new Date().toISOString(),
        });

        // Fire off the tx
        const hash = await writeContractAsync({
          address: CHAIN_QUIZ_ADDRESS,
          abi: chainQuizABI,
          functionName: "startQuiz",
          args: [domains, difficulty],
          // gas & gasPrice can be omitted to let viem estimate them
        });

        console.log("startQuiz: Transaction sent", { hash });

        // Wait for finality
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        console.log("startQuiz: Receipt", { status: receipt.status });

        if (receipt.status !== "success") {
          throw new Error("startQuiz reverted on-chain");
        }

        // Refresh the on-chain session data
        await refetchSession();
        return hash;
      } catch (err: any) {
        console.error("startQuiz error:", err);
        throw err;
      }
    },
    [address, status, writeContractAsync, publicClient, refetchSession]
  );

  const submitAnswer = useCallback(
    async (answer: number) => {
      if (!address || status !== "connected")
        throw new Error("Wallet not connected");
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
    [
      address,
      status,
      quizId,
      questionIndex,
      writeContractAsync,
      publicClient,
      refetchSession,
    ]
  );

  const cancelQuiz = useCallback(async () => {
    if (!address || status !== "connected") {
      throw new Error("Wallet not connected");
    }
    if (!publicClient) {
      throw new Error("Public client not initialized");
    }
    try {
      // Check session status
      const session = await publicClient.readContract({
        address: CHAIN_QUIZ_ADDRESS,
        abi: chainQuizABI,
        functionName: "sessions",
        args: [address],
      });
      const isActive = session[4];
      const startedAt = Number(session[3]);
      const currentTime = Math.floor(Date.now() / 1000);
      console.log("cancelQuiz: Session check", {
        quizId,
        isActive,
        startedAt,
        currentTime,
        isExpired: startedAt + 450 < currentTime,
      });

      if (!isActive) {
        console.log("cancelQuiz: No active session, skipping");
        await refetchSession();
        return null; // No need to cancel
      }

      if (startedAt + 450 < currentTime) {
        console.log("cancelQuiz: Session expired, treating as cancelled");
        setIsActive(false); // Update local state
        await refetchSession();
        return null; // Treat as cancelled without calling contract
      }

      // Simulate transaction
      try {
        await publicClient.simulateContract({
          address: CHAIN_QUIZ_ADDRESS,
          abi: chainQuizABI,
          functionName: "cancelQuiz",
          args: [],
          account: address,
        });
      } catch (simulationError: any) {
        let revertReason = simulationError.message;
        if (simulationError.data) {
          try {
            const decodedError = decodeErrorResult({
              abi: chainQuizABI,
              data: simulationError.data,
            });
            revertReason = `Revert: ${decodedError.errorName || "Unknown"} - ${
              decodedError.args || []
            }`;
          } catch (decodeErr) {
            revertReason = `Failed to decode revert: ${simulationError.message}`;
          }
        }
        console.error("cancelQuiz: Simulation failed", {
          revertReason,
          timestamp: new Date().toISOString(),
        });
        throw new Error(`Simulation failed: ${revertReason}`);
      }

      console.log("cancelQuiz: Sending transaction", { quizId });
      const hash = await writeContractAsync({
        address: CHAIN_QUIZ_ADDRESS,
        abi: chainQuizABI,
        functionName: "cancelQuiz",
        args: [],
        gas: BigInt(500000),
        gasPrice: BigInt(5000000000), // 5 Gwei
      });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: 30000,
      });
      console.log("cancelQuiz: Transaction receipt", {
        hash,
        status: receipt.status,
        timestamp: new Date().toISOString(),
      });
      if (receipt.status !== "success") {
        throw new Error(
          "Transaction reverted. Check contract logs for details."
        );
      }
      setIsActive(false);
      await refetchSession();
      return hash;
    } catch (err: any) {
      console.error("cancelQuiz error:", {
        message: err.message,
        details: err,
        quizId,
        timestamp: new Date().toISOString(),
      });
      // Don't throw for "Expired" errors
      if (err.message.includes("Expired")) {
        console.log("cancelQuiz: Treating expired session as cancelled");
        setIsActive(false);
        await refetchSession();
        return null;
      }
      throw new Error(`Failed to cancel quiz: ${err.message}`);
    }
  }, [
    address,
    status,
    quizId,
    writeContractAsync,
    publicClient,
    refetchSession,
    setIsActive,
  ]);

  const debugFulfillRequest = useCallback(
    async (requestId: `0x${string}`, response: string, err: string) => {
      if (!address || status !== "connected")
        throw new Error("Wallet not connected");
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
        console.log("debugFulfillRequest success:", {
          hash,
          status: receipt.status,
        });
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
    async (
      quizId: string,
      domains: string[],
      playerAddress: string,
      difficulty: string
    ) => {
      try {
        console.log("generateQuestions:", {
          quizId,
          domains,
          playerAddress,
          difficulty,
        });
        // const res = await fetch(`${BACKEND_URL}/generateQuiz`, {
        const res = await fetch(`api/generateQuiz`, {
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
    async (
      quizId: string,
      playerAddress: string,
      questionIndex: number,
      answer: number
    ) => {
      try {
        console.log("verifyAnswer:", {
          quizId,
          playerAddress,
          questionIndex,
          answer,
        });
        // const res = await fetch(`${BACKEND_URL}/verifyAnswer`, {
        const res = await fetch(`api/verifyAnswer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            quizId,
            playerAddress,
            questionIndex,
            answer,
          }),
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
