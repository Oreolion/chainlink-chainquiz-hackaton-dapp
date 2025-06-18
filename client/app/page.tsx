"use client";

import { Component, useEffect, useState, useRef, useCallback } from "react";
import { useAccount, usePublicClient, useWatchContractEvent } from "wagmi";
import { useQuizToken } from "../src/hooks/useQuizToken";
import { useChainQuiz } from "../src/hooks/useChainQuiz";
import axios from "axios";
import { supabase } from "../src/utils/supabaseClient";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import ChainQuizABI from "../src/abis/ChainQuizABI.json";
import { formatEther, isAddress } from "viem";
import type { Address } from "viem";

class ErrorBoundary extends Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex flex-col bg-gray-900 text-gray-100">
          <header className="flex justify-between items-center p-6 bg-gray-800/70 backdrop-blur-sm">
            <h1 className="text-3xl font-bold text-blue-400">ChainQuiz</h1>
            <ConnectButton showBalance={false} />
          </header>
          <main className="flex-1 p-6">
            <div className="text-center text-red-400">
              <p>
                Something went wrong:{" "}
                {this.state.error?.message || "Unknown error"}
              </p>
              <button
                onClick={() => this.setState({ hasError: false, error: null })}
                className="mt-4 px-4 py-2 bg-blue-500 hover:bg-blue-600 rounded-lg text-white"
              >
                Retry
              </button>
            </div>
          </main>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function Home() {
  // Hooks
  const { address, status } = useAccount();
  const publicClient = usePublicClient();
  const quizContract = useChainQuiz();
  const tokenContract = useQuizToken();
  const diffMap = { Easy: 0, Medium: 1, Hard: 2 } as const;

  // State
  const [isMounted, setIsMounted] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [domains, setDomains] = useState<string[]>([]);
  const [selectedDomains, setSelectedDomains] = useState<string[]>([]);
  const [difficulty, setDifficulty] = useState<"Easy" | "Medium" | "Hard">(
    "Medium"
  );
  const [quizId, setQuizId] = useState<string>("");
  const [vrfRequestId, setVrfRequestId] = useState<string>("");
  const [questions, setQuestions] = useState<any[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [timer, setTimer] = useState<number>(45);
  const [entryState, setEntryState] = useState<
    "idle" | "staking" | "inQuiz" | "awaitingAnswer"
  >("idle");
  const [reward, setReward] = useState<string>("");
  const [rewardUSD, setRewardUSD] = useState<string>("");
  const [balance, setBalance] = useState<string>("0");
  const [leaderboard, setLeaderboard] = useState<
    { address: string; score: number }[]
  >([]);

  useEffect(() => {
    async function fetchInitialData() {
      const { data, error } = await supabase.from("Quizzes").select("*");

      console.log("Quizzes data:", data);
      console.log("Error (if any):", error);
    }

    fetchInitialData();
  }, []);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Debug Fetch Questions
  const debugFetchQuestions = useCallback(async (quizId: string) => {
    console.log("debugFetchQuestions: Querying Supabase", {
      quizId,
      timestamp: new Date().toISOString(),
    });
    try {
      const { data, error } = await supabase
        .from("Quizzes")
        .select("questions")
        .eq("quiz_id", quizId)
        .single();
      if (error) {
        console.error("debugFetchQuestions: Supabase error", {
          message: error.message,
          details: error.details,
          timestamp: new Date().toISOString(),
        });
        throw error;
      }
      console.log("debugFetchQuestions: Fetched data", {
        data,
        questionCount: data.questions?.length,
        timestamp: new Date().toISOString(),
      });
      if (!data.questions || !Array.isArray(data.questions)) {
        console.error("debugFetchQuestions: Invalid questions format", {
          questions: data.questions,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      console.log("debugFetchQuestions: Questions", {
        questionCount: data.questions.length,
        questions: data.questions,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error("debugFetchQuestions: Error", {
        message: err.message,
        timestamp: new Date().toISOString(),
      });
    }
  }, []);

  // Fetch Balance
  const fetchBalance = useCallback(async () => {
    console.log("fetchBalance: Starting", {
      address,
      status,
      tokenContract: !!tokenContract,
      isValidAddress: isAddress(address ?? ""),
      timestamp: new Date().toISOString(),
    });
    if (
      !tokenContract ||
      !address ||
      status !== "connected" ||
      !isAddress(address)
    ) {
      console.log("fetchBalance: Skipping invalid input", {
        timestamp: new Date().toISOString(),
      });
      setBalance("0");
      return;
    }
    try {
      const raw = await tokenContract.read.balanceOf(address as Address);
      const bal: bigint = typeof raw === "bigint" ? raw : BigInt(raw as string);
      console.log("fetchBalance: Success", {
        balance: formatEther(bal),
        timestamp: new Date().toISOString(),
      });
      setBalance(formatEther(bal));
    } catch (err: any) {
      console.error("fetchBalance: Error", {
        message: err.message,
        timestamp: new Date().toISOString(),
      });
      setBalance("0");
    }
  }, [tokenContract, address, status]);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  // Fetch Leaderboard
  const fetchLeaderboard = useCallback(async () => {
    console.log("fetchLeaderboard: Starting", {
      timestamp: new Date().toISOString(),
    });
    try {
      const { data, error } = await supabase
        .from("Quizzes")
        .select("player_address, correct_count")
        .not("completed_at", "is", null)
        .order("correct_count", { ascending: false })
        .limit(5);
      if (error) throw error;
      console.log("fetchLeaderboard: Raw Supabase data", {
        data,
        timestamp: new Date().toISOString(),
      });
      const arr = data.map((row: any) => ({
        address: row.player_address,
        score: row.correct_count * 10,
      }));
      console.log("fetchLeaderboard: Success", {
        leaderboard: arr,
        timestamp: new Date().toISOString(),
      });
      setLeaderboard(arr);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (err: any) {
      console.error("fetchLeaderboard: Error", {
        message: err.message,
        timestamp: new Date().toISOString(),
      });
      setLeaderboard([]);
      setErrorMessage("Failed to load leaderboard.");
    }
  }, []);

  // Event Handlers
  const onQuizGenerated = useCallback(
    async (logs: any[]) => {
      const event = logs[0];
      const player: string = event.args.player;
      const qId: string = event.args.quizId;
      const numQ: number = Number(event.args.numQuestions);
      console.log("onQuizGenerated: Event received", {
        player,
        quizId: qId,
        numQuestions: numQ,
        txHash: event.transactionHash,
        blockNumber: Number(event.blockNumber),
        timestamp: new Date().toISOString(),
      });
      if (player.toLowerCase() !== address?.toLowerCase()) {
        console.log("onQuizGenerated: Skipping, player mismatch", {
          player,
          address,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      setQuizId(qId);
      setIsLoading(true);
      try {
        console.log("onQuizGenerated: Fetching questions from Supabase", {
          quizId: qId,
          timestamp: new Date().toISOString(),
        });
        const { data, error } = await supabase
          .from("Quizzes")
          .select("questions")
          .eq("quiz_id", qId)
          .single();
        console.log("📝 Supabase questions for", qId, data?.questions);
        if (error) {
          console.error("onQuizGenerated: Supabase error", {
            message: error.message,
            details: error.details,
            timestamp: new Date().toISOString(),
          });
          throw error;
        }
        if (!data.questions || !Array.isArray(data.questions)) {
          console.error("onQuizGenerated: Invalid questions format", {
            questions: data.questions,
            timestamp: new Date().toISOString(),
          });
          throw new Error("Invalid questions format from Supabase");
        }
        console.log("onQuizGenerated: Questions fetched", {
          quizId: qId,
          questionCount: data.questions.length,
          questions: data.questions,
          timestamp: new Date().toISOString(),
        });
        setQuestions(data.questions);
        setEntryState("inQuiz");
        setTimer(45);
        setErrorMessage("");
      } catch (err: any) {
        console.error("onQuizGenerated: Error", {
          message: err.message,
          error: err.response?.data || err,
          timestamp: new Date().toISOString(),
        });
        setErrorMessage(
          `Failed to fetch quiz: ${err.response?.data?.error || err.message}`
        );
        setEntryState("idle");
      } finally {
        setIsLoading(false);
      }
    },
    [address, quizContract]
  );

  const onAnswerSubmitted = useCallback(
    (logs: any[]) => {
      const event = logs[0];
      const player: string = event.args.player;
      const isCorrect: boolean = event.args.isCorrect;
      const questionIndex: number = Number(event.args.questionIndex);
      console.log("onAnswerSubmitted: Event received", {
        player,
        isCorrect,
        questionIndex,
        txHash: event.transactionHash,
        blockNumber: Number(event.blockNumber),
        timestamp: new Date().toISOString(),
      });
      if (player.toLowerCase() !== address?.toLowerCase()) {
        console.log("onAnswerSubmitted: Skipping, mismatch", {
          player,
          address,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      setEntryState("inQuiz");
      if (isCorrect) {
        setCurrentIndex((i) => Math.min(i + 1, questions.length - 1));
        setTimer(45);
      } else {
        setTimer(45);
      }
    },
    [address, questions.length]
  );

  const onQuizCompleted = useCallback(
    (logs: any[]) => {
      const event = logs[0];
      const player: string = event.args.player;
      const score: number = Number(event.args.correctCount);
      const rewardUSD: number = Number(event.args.rewardUSD);
      console.log("onQuizCompleted: Event received", {
        player,
        score,
        rewardUSD,
        txHash: event.transactionHash,
        blockNumber: Number(event.blockNumber),
        timestamp: new Date().toISOString(),
      });
      if (player.toLowerCase() !== address?.toLowerCase()) {
        console.log("onQuizCompleted: Skipping, mismatch", {
          player,
          address,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      setReward(score.toString());
      setRewardUSD(rewardUSD.toString());
      setEntryState("awaitingAnswer");
      fetchLeaderboard();
    },
    [address, fetchLeaderboard]
  );

  const onQuizCancelled = useCallback(
    (logs: any[]) => {
      const event = logs[0];
      const player: string = event.args.player;
      const refundAmount: number = Number(event.args.refundAmount);
      console.log("onQuizCancelled: Event received", {
        player,
        refundAmount,
        txHash: event.transactionHash,
        blockNumber: Number(event.blockNumber),
        timestamp: new Date().toISOString(),
      });
      if (player.toLowerCase() !== address?.toLowerCase()) {
        console.log("onQuizCancelled: Skipping, mismatch", {
          player,
          address,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      setEntryState("idle");
      setQuizId("");
      setQuestions([]);
      setCurrentIndex(0);
      setReward("");
      setRewardUSD("");
    },
    [address]
  );

  const onVRFRequestInitiated = useCallback(
    (logs: any[]) => {
      const event = logs[0];
      const requestId: string = event.args.requestId.toString();
      const player: string = event.args.player;
      console.log("onVRFRequestInitiated: Event received", {
        requestId,
        player,
        txHash: event.transactionHash,
        blockNumber: Number(event.blockNumber),
        timestamp: new Date().toISOString(),
      });
      if (player.toLowerCase() !== address?.toLowerCase()) {
        console.log("onVRFRequestInitiated: Skipping, player mismatch", {
          player,
          address,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      setVrfRequestId(requestId);
    },
    [address]
  );

  // Event Subscriptions
  const chainQuizAddress = process.env
    .NEXT_PUBLIC_CHAINQUIZ_ADDRESS as `0x${string}`;

  useWatchContractEvent({
    address: chainQuizAddress,
    abi: ChainQuizABI,
    eventName: "QuizGenerated",
    onLogs: onQuizGenerated,
    enabled: !!quizContract && !!address && status === "connected",
  });

  useWatchContractEvent({
    address: chainQuizAddress,
    abi: ChainQuizABI,
    eventName: "AnswerSubmitted",
    onLogs: onAnswerSubmitted,
    enabled: !!quizContract && !!address && status === "connected",
  });

  useWatchContractEvent({
    address: chainQuizAddress,
    abi: ChainQuizABI,
    eventName: "QuizCompleted",
    onLogs: onQuizCompleted,
    enabled: !!quizContract && !!address && status === "connected",
  });

  useWatchContractEvent({
    address: chainQuizAddress,
    abi: ChainQuizABI,
    eventName: "QuizCancelled",
    onLogs: onQuizCancelled,
    enabled: !!quizContract && !!address && status === "connected",
  });

  useWatchContractEvent({
    address: chainQuizAddress,
    abi: ChainQuizABI,
    eventName: "VRFRequestInitiated",
    onLogs: onVRFRequestInitiated,
    enabled: !!quizContract && !!address && status === "connected",
  });

  // Start Quiz
  const startQuiz = useCallback(async () => {
    // 1️⃣ Basic validation
    if (
      !quizContract ||
      !tokenContract ||
      !publicClient ||
      selectedDomains.length < 5 ||
      !address
    ) {
      setErrorMessage(
        "Select at least 5 domains, choose a difficulty & connect your wallet."
      );
      console.log("startQuiz: Invalid input", {
        timestamp: new Date().toISOString(),
      });
      return;
    }
    setErrorMessage("");
    setEntryState("staking");
    setIsLoading(true);

    try {
      // 2️⃣ Prepare params
      const quizAddr =
        process.env.NEXT_PUBLIC_CHAINQUIZ_ADDRESS ??
        "0xB7E0a11c36C147F89f161DE392727C4A7a99761F";
      const entryFee = BigInt(
        process.env.NEXT_PUBLIC_ENTRY_FEE_IN_QUIZ ?? "10000000000000000"
      );
      const diffMap = { Easy: 0, Medium: 1, Hard: 2 } as const;
      const diffIndex = diffMap[difficulty];

      console.log("🚀 startQuiz → Config", {
        quizAddr,
        entryFee: entryFee.toString(),
        selectedDomains,
        diffIndex,
        address,
        timestamp: new Date().toISOString(),
      });

      // 3️⃣ Check $QUIZ balance
      const balance = await tokenContract.read.balanceOf(address);
      console.log("startQuiz: Balance", {
        balance: balance.toString(),
        timestamp: new Date().toISOString(),
      });
      if (balance < entryFee) {
        throw new Error(
          "Insufficient $QUIZ balance. Please acquire more tokens."
        );
      }

      // 4️⃣ Check allowance
      const allowance = await tokenContract.read.allowance(address, quizAddr);
      console.log("startQuiz: Allowance", {
        allowance: allowance.toString(),
        timestamp: new Date().toISOString(),
      });
      if (allowance < entryFee) {
        console.log("🚀 startQuiz → Approving token", {
          quizAddr,
          entryFee: entryFee.toString(),
          timestamp: new Date().toISOString(),
        });
        const approveHash = await tokenContract.write.approve([
          quizAddr,
          entryFee,
        ]);
        console.log("✍️ Approve tx sent:", approveHash, {
          timestamp: new Date().toISOString(),
        });
        const receipt1 = await publicClient.waitForTransactionReceipt({
          hash: approveHash,
        });
        console.log("✅ Approve confirmed:", {
          status: receipt1.status,
          gasUsed: receipt1.gasUsed.toString(),
          transactionHash: approveHash,
          timestamp: new Date().toISOString(),
        });
        if (receipt1.status !== "success") {
          throw new Error("Approval transaction failed.");
        }
        // Verify allowance after approval
        const newAllowance = await tokenContract.read.allowance(
          address,
          quizAddr
        );
        console.log("startQuiz: New Allowance", {
          newAllowance: newAllowance.toString(),
          timestamp: new Date().toISOString(),
        });
        if (newAllowance < entryFee) {
          throw new Error("Allowance approval failed to update.");
        }
      }

      // 5️⃣ Call startQuiz
      console.log("🚀 startQuiz → Submitting on-chain", {
        selectedDomains,
        diffIndex,
        timestamp: new Date().toISOString(),
      });
      const startHash = await quizContract.write.startQuiz(selectedDomains); // Adjust if difficulty is needed
      console.log("✍️ startQuiz tx sent:", startHash, {
        timestamp: new Date().toISOString(),
      });
      const receipt2 = await publicClient.waitForTransactionReceipt({
        hash: startHash,
      });
      console.log("✅ startQuiz confirmed:", {
        status: receipt2.status,
        gasUsed: receipt2.gasUsed.toString(),
        transactionHash: startHash,
        timestamp: new Date().toISOString(),
      });
      if (receipt2.status !== "success") {
        // Decode revert reason
        let revertReason = "Unknown reason";
        try {
          const errorData = receipt2.logs.find(
            (log) => log.topics[0] === "0x08c379a0"
          ); // Error(string)
          if (errorData) {
            const decoded = publicClient.abiDecoder.decodeErrorResult({
              abi: [
                { type: "error", name: "Error", inputs: [{ type: "string" }] },
              ],
              data: errorData.data,
            });
            revertReason = decoded.args[0];
          }
        } catch (decodeErr) {
          console.error("Failed to decode revert reason:", decodeErr);
        }
        throw new Error(`startQuiz transaction reverted: ${revertReason}`);
      }

      // All further UX updates will come via on-chain event subscribers
    } catch (err: Error) {
      console.error("❌ startQuiz error:", err);
      let errorMsg = `Failed to start quiz: ${err.message}`;
      if (err.message.includes("reverted")) {
        errorMsg = `Transaction reverted: ${
          err.message.split("reverted: ")[1] || "Unknown reason"
        }`;
      } else if (err.message.includes("rejected")) {
        errorMsg = "Transaction rejected by user.";
      } else if (err.message.includes("insufficient funds")) {
        errorMsg = "Insufficient ETH for gas fees.";
      }
      console.error("startQuiz: Error", {
        message: errorMsg,
        details: err,
        timestamp: new Date().toISOString(),
      });
      setErrorMessage(errorMsg);
      setEntryState("idle");
    } finally {
      setIsLoading(false);
    }
  }, [
    quizContract,
    tokenContract,
    publicClient,
    selectedDomains,
    difficulty,
    address,
  ]);

  // Submit Answer
  const submitAnswer = useCallback(
    async (selectedIndex: number) => {
      console.log("submitAnswer: Starting", {
        quizId,
        questionId: questions[currentIndex]?.id,
        selectedIndex,
        timestamp: new Date().toISOString(),
      });
      if (!quizContract || !address || status !== "connected" || !quizId) {
        console.error("submitAnswer: Invalid input", {
          quizContract: !!quizContract,
          address: !!address,
          status,
          quizId,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      setIsLoading(true);
      try {
        const apiUrl =
          process.env.NEXT_PUBLIC_ELIZAOS_URL || "http://localhost:5000";
        console.log("submitAnswer: Verifying answer with ELIZA", {
          url: `${apiUrl}/verifyAnswer`,
          payload: {
            quizId,
            questionId: questions[currentIndex]?.id,
            selectedIndex,
          },
          timestamp: new Date().toISOString(),
        });
        const resp = await axios.post(`${apiUrl}/verifyAnswer`, {
          quizId,
          questionId: questions[currentIndex]?.id,
          selectedIndex,
        });
        console.log("submitAnswer: ELIZA verify response", {
          status: resp.status,
          timestamp: new Date().toISOString(),
        });
        console.log("submitAnswer: Submitting on-chain", {
          selectedIndex,
          timestamp: new Date().toISOString(),
        });
        const submitHash = await quizContract.write.submitAnswer(selectedIndex);
        console.log("submitAnswer: Transaction sent", {
          txHash: submitHash,
          timestamp: new Date().toISOString(),
        });
        const receipt = await publicClient?.waitForTransactionReceipt({
          hash: submitHash,
        });
        console.log("submitAnswer: Transaction confirmed", {
          txHash: submitHash,
          status: receipt?.status,
          gasUsed: receipt?.gasUsed.toString(),
          timestamp: new Date().toISOString(),
        });
        if (currentIndex < questions.length - 1) {
          console.log("submitAnswer: Advancing to next question", {
            currentIndex,
            nextIndex: currentIndex + 1,
            totalQuestions: questions.length,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (err: any) {
        console.error("submitAnswer: Error", {
          message: err.message,
          error: err.response?.data || err,
          timestamp: new Date().toISOString(),
        });
        setErrorMessage(
          `Failed to submit answer: ${err.response?.data?.error || err.message}`
        );
        setEntryState("inQuiz");
        setTimer(60);
      } finally {
        setIsLoading(false);
      }
    },
    [
      quizContract,
      address,
      status,
      quizId,
      questions,
      currentIndex,
      publicClient,
    ]
  );

  // Cancel Quiz
  const cancelQuiz = useCallback(async () => {
    console.log("cancelQuiz: Starting", {
      quizId,
      timestamp: new Date().toISOString(),
    });
    if (!quizContract || !address || status !== "connected") {
      console.error("cancelQuiz: Invalid input", {
        quizContract: !!quizContract,
        address: !!address,
        status,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    setEntryState("awaitingAnswer");
    setIsLoading(true);
    try {
      const cancelHash = await quizContract.write.cancelQuiz();
      console.log("cancelQuiz: Transaction sent", {
        cancelHash,
        timestamp: new Date().toISOString(),
      });
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: cancelHash,
      });
      console.log("cancelQuiz: Transaction confirmed", {
        cancelHash,
        status: receipt.status,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error("cancelQuiz: Error", {
        message: err.message,
        timestamp: new Date().toISOString(),
      });
      setErrorMessage(`Failed to cancel quiz: ${err.message}`);
      setEntryState("idle");
    } finally {
      setIsLoading(false);
    }
  }, [quizContract, address, status, quizId, publicClient]);

  // Effects
  useEffect(() => {
    console.log("Mount effect: Setting initial state", {
      timestamp: new Date().toISOString(),
    });
    setIsMounted(true);
    setLastUpdated(new Date().toLocaleTimeString());
    setDomains([
      "DeFi",
      "Oracles",
      "Layer2",
      "Tokenomics",
      "ZeroKnowledge",
      "NFT",
      "CrossChain",
      "Governance",
      "DAOs",
      "SmartContracts",
      "WalletSecurity",
      "Stablecoins",
      "Chainlink",
      "CCIP",
      "VRF",
      "Automation",
      "DataFeeds",
    ]);
  }, []);

  useEffect(() => {
    if (questions.length) {
      console.log("🏗️ questions state updated:", questions);
    }
  }, [questions]);

  useEffect(() => {
    console.log("Leaderboard effect: Starting periodic fetch", {
      timestamp: new Date().toISOString(),
    });
    fetchLeaderboard();
    const interval = setInterval(fetchLeaderboard, 60_000);
    return () => {
      console.log("Leaderboard effect: Cleaning up interval", {
        timestamp: new Date().toISOString(),
      });
      clearInterval(interval);
    };
  }, [fetchLeaderboard]);

  useEffect(() => {
    if (!["inQuiz", "awaitingAnswer"].includes(entryState)) return;
    if (timer === 0) {
      submitAnswer(255); // Timeout
      return;
    }
    timerRef.current = setTimeout(() => setTimer((t) => t - 1), 1000);
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [timer, entryState, submitAnswer]);

  // Early returns
  if (!isMounted) {
    return (
      <div className="min-h-screen flex flex-col bg-gray-900 text-gray-100">
        <header className="flex justify-between items-center p-6 bg-gray-800/70 backdrop-blur-sm">
          <h1 className="text-3xl font-bold text-blue-400">ChainQuiz</h1>
          <ConnectButton showBalance={false} />
        </header>
        <main className="flex-1 p-6">
          <div className="flex items-center justify-center min-h-screen">
            <div className="text-center">
              <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-400 mb-4"></div>
              <p className="text-gray-400 text-sm">Loading...</p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (!quizContract || !tokenContract) {
    return (
      <div className="min-h-screen flex flex-col bg-gray-900 text-gray-100">
        <header className="flex justify-between items-center p-6 bg-gray-800/70 backdrop-blur-sm">
          <h1 className="text-3xl font-bold text-blue-400">ChainQuiz</h1>
          <ConnectButton showBalance={false} />
        </header>
        <main className="flex-1 p-6">
          <p className="text-center text-red-400">
            Error: Contract addresses or RPC URL not configured. Check
            NEXT_PUBLIC_PROPERTIES in .env.local.
          </p>
        </main>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen flex flex-col bg-gray-900 text-gray-100">
        <header className="flex justify-between items-center p-5 bg-gray-800/70 backdrop-blur-sm">
          <h1 className="text-3xl font-bold text-blue-400">ChainQuiz</h1>
          <ConnectButton showBalance={false} />
        </header>

        <main className="flex-1 p-6 space-y-6">
          {/* Error Message */}
          {errorMessage && (
            <div className="p-4 bg-red-500/20 border border-red-500 rounded-lg">
              <p className="text-red-400">{errorMessage}</p>
              <button
                onClick={() => setErrorMessage("")}
                className="mt-2 text-sm text-blue-400 hover:text-blue-300"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Wallet & Balance */}
          {status === "connected" && address && (
            <div className="flex justify-end gap-4">
              <p className="text-sm text-gray-400 truncate max-w-[12rem]">
                {address}
              </p>
              <p className="text-sm text-blue-400">{balance} QUIZ</p>
            </div>
          )}

          {/* Domain Selection, Difficulty, & Start Quiz */}
          {status === "connected" && address && entryState === "idle" && (
            <div className="p-6 bg-gray-800/80 rounded-2xl shadow-md space-y-4">
              <h2 className="text-xl font-semibold text-gray-100">
                Select 5+ Domains
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {domains.map((d) => (
                  <button
                    key={d}
                    onClick={() =>
                      setSelectedDomains((sd) =>
                        sd.includes(d) ? sd.filter((x) => x !== d) : [...sd, d]
                      )
                    }
                    className={`p-2 rounded-lg border text-sm ${
                      selectedDomains.includes(d)
                        ? "bg-blue-500 text-white border-blue-500"
                        : "bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600"
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
              <h2 className="text-xl font-semibold text-gray-100">
                Select Difficulty
              </h2>
              <div className="flex gap-3">
                {["Easy", "Medium", "Hard"].map((diff) => (
                  <button
                    key={diff}
                    onClick={() =>
                      setDifficulty(diff as "Easy" | "Medium" | "Hard")
                    }
                    className={`p-2 rounded-lg border text-sm ${
                      difficulty === diff
                        ? "bg-blue-500 text-white border-blue-500"
                        : "bg-gray-700 text-gray-200 border-gray-600 hover:bg-gray-600"
                    }`}
                  >
                    {diff}
                  </button>
                ))}
              </div>
              <button
                onClick={startQuiz}
                disabled={
                  selectedDomains.length < 5 ||
                  entryState !== "idle" ||
                  isLoading
                }
                className="mt-4 w-full p-3 bg-blue-500 hover:bg-blue-600 rounded-xl text-lg font-semibold text-white disabled:bg-gray-600 disabled:cursor-not-allowed relative"
              >
                {isLoading && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                  </div>
                )}
                <span className={isLoading ? "opacity-0" : ""}>
                  {entryState === "staking"
                    ? "Staking 10 QUIZ..."
                    : `Start Quiz (${selectedDomains.length} Domains, ${difficulty})`}
                </span>
              </button>
            </div>
          )}

          {/* Quiz Questions */}
          {status === "connected" &&
            address &&
            entryState === "inQuiz" &&
            questions.length > 0 && (
              <div className="p-6 bg-gray-800/80 rounded-2xl shadow-md space-y-4">
                <h2 className="text-xl font-semibold text-gray-100">
                  Question {currentIndex + 1}/{questions.length}
                </h2>
                <p className="text-base text-gray-200">
                  {questions[currentIndex]?.text || "Loading..."}
                </p>
                <div className="grid grid-cols-1 gap-2">
                  {Array.isArray(questions[currentIndex]?.options) ? (
                    questions[currentIndex].options.map(
                      (opt: string, idx: number) => (
                        <button
                          key={idx}
                          onClick={() => submitAnswer(idx)}
                          disabled={isLoading}
                          className="p-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-left text-sm text-gray-200 disabled:opacity-50 disabled:cursor-not-allowed relative"
                        >
                          {isLoading && (
                            <div className="absolute inset-0 flex items-center justify-center">
                              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-400"></div>
                            </div>
                          )}
                          <span className={isLoading ? "opacity-0" : ""}>
                            {opt}
                          </span>
                        </button>
                      )
                    )
                  ) : (
                    <p className="text-sm text-red-400">No options available</p>
                  )}
                </div>
                <div className="flex justify-between items-center">
                  <p className="text-sm text-gray-400">Time Left: {timer}s</p>
                  <button
                    onClick={() => submitAnswer(255)}
                    className="px-2 py-1 text-xs text-blue-400 hover:text-blue-300"
                  >
                    Skip (Timeout)
                  </button>
                </div>
              </div>
            )}

          {/* Quiz Completion */}
          {status === "connected" &&
            address &&
            entryState === "awaitingAnswer" && (
              <div className="p-6 bg-gray-800/80 rounded-2xl shadow-md space-y-4 text-center">
                <h2 className="text-xl font-semibold text-gray-100">
                  Quiz Completed!
                </h2>
                <p className="text-base text-gray-200">
                  You earned {reward || "0"} QUIZ (~${rewardUSD || "0"} USD)
                </p>
                <button
                  onClick={cancelQuiz}
                  disabled={isLoading}
                  className="p-2 bg-red-500 hover:bg-red-600 rounded-lg text-sm text-white disabled:bg-gray-600 disabled:cursor-not-allowed relative"
                >
                  {isLoading && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    </div>
                  )}
                  <span className={isLoading ? "opacity-0" : ""}>
                    Cancel Quiz & Refund
                  </span>
                </button>
              </div>
            )}

          {/* Debug Tools */}
          <div className="p-6 bg-gray-800/80 rounded-2xl shadow-md space-y-4">
            <h2 className="text-xl font-semibold text-gray-100">Debug Tools</h2>
            <button
              onClick={() =>
                debugFetchQuestions(quizId || `temp_${vrfRequestId}`)
              }
              className="p-2 bg-yellow-400 hover:bg-yellow-500 rounded-lg text-sm text-gray-900"
            >
              Debug Fetch Questions
            </button>
          </div>

          {/* Leaderboard */}
          <div className="p-6 bg-gray-800/80 rounded-2xl shadow-md space-y-4">
            <h2 className="text-xl font-semibold text-gray-100">
              Leaderboard (Top 5)
            </h2>
            <table className="w-full text-left text-gray-200 text-sm">
              <thead>
                <tr className="border-b border-gray-600">
                  <th className="px-2 py-3">Rank</th>
                  <th className="px-2 py-3">Address</th>
                  <th className="px-2 py-3">Score</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((row, i) => (
                  <tr key={row.address} className="border-b border-gray-700">
                    <td className="px-2 py-3">{i + 1}</td>
                    <td className="px-2 py-3 truncate max-w-[150px]">
                      {row.address}
                    </td>
                    <td className="px-2 py-3">{row.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-gray-400">Last updated: {lastUpdated}</p>
          </div>
        </main>
      </div>
    </ErrorBoundary>
  );
}
