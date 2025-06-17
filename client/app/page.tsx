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
              <p>Something went wrong: {this.state.error?.message || "Unknown error"}</p>
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
  const [difficulty, setDifficulty] = useState<"Easy" | "Medium" | "Hard">("Medium");
  const [quizId, setQuizId] = useState<string>("");
  const [vrfRequestId, setVrfRequestId] = useState<string>("");
  const [questions, setQuestions] = useState<any[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [timer, setTimer] = useState<number>(45);
  const [entryState, setEntryState] = useState<"idle" | "staking" | "inQuiz" | "awaitingAnswer">("idle");
  const [reward, setReward] = useState<string>("");
  const [balance, setBalance] = useState<string>("0");
  const [leaderboard, setLeaderboard] = useState<{ address: string; score: number }[]>([]);

  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Fetch leaderboard from Supabase
  const fetchLeaderboard = useCallback(async () => {
    console.log("fetchLeaderboard: Starting", { timestamp: new Date().toISOString() });
    try {
      const { data, error } = await supabase
        .from("Quizzes")
        .select("player_address, correct_count")
        .not("completed_at", "is", null)
        .order("correct_count", { ascending: false })
        .limit(5);
      if (error) throw error;
      console.log("fetchLeaderboard: Raw Supabase data", { data, timestamp: new Date().toISOString() });
      const arr = data.map((row: any) => ({
        address: row.player_address,
        score: row.correct_count * 10,
      }));
      console.log("fetchLeaderboard: Success", { leaderboard: arr, timestamp: new Date().toISOString() });
      setLeaderboard(arr);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (err: any) {
      console.error("fetchLeaderboard: Error", {
        message: err.message,
        error: err,
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
        selectedDomains,
        difficulty,
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
      const apiUrl = process.env.NEXT_PUBLIC_ELIZAOS_URL || "http://localhost:5000";
      try {
        console.log("onQuizGenerated: Calling ELIZA agent", {
          url: `${apiUrl}/generateQuiz`,
          payload: { domains: selectedDomains, playerAddress: address, difficulty },
          timestamp: new Date().toISOString(),
        });
        const resp = await axios.post(`${apiUrl}/generateQuiz`, {
          domains: selectedDomains,
          playerAddress: address,
          difficulty,
        });
        console.log("onQuizGenerated: ELIZA agent response", {
          quizId: resp.data.quizId,
          numQuestions: resp.data.numQuestions,
          status: resp.status,
          response: resp.data,
          timestamp: new Date().toISOString(),
        });
        if (!resp.data.quizId || typeof resp.data.numQuestions !== "number") {
          throw new Error("Invalid quiz response: missing quizId or numQuestions");
        }
        console.log("onQuizGenerated: Fetching questions from Supabase", {
          quizId: resp.data.quizId,
          timestamp: new Date().toISOString(),
        });
        const { data, error } = await supabase
          .from("Quizzes")
          .select("questions")
          .eq("quiz_id", resp.data.quizId)
          .single();
        if (error) {
          console.error("onQuizGenerated: Supabase error", {
            message: error.message,
            details: error.details,
            hint: error.hint,
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
          quizId: resp.data.quizId,
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
        setErrorMessage(`Failed to generate quiz: ${err.response?.data?.error || err.message}`);
        setEntryState("idle");
      } finally {
        setIsLoading(false);
      }
    },
    [address, selectedDomains, difficulty]
  );

  const onAnswerSubmitted = useCallback(
    (logs: any[]) => {
      const event = logs[0];
      const player: string = event.args.player;
      const qId: string = event.args.quizId;
      const isCorrect: boolean = event.args.isCorrect;
      console.log("onAnswerSubmitted: Event received", {
        player,
        quizId: qId,
        isCorrect,
        txHash: event.transactionHash,
        blockNumber: Number(event.blockNumber),
        timestamp: new Date().toISOString(),
      });
      if (player.toLowerCase() !== address?.toLowerCase() || qId !== quizId) {
        console.log("onAnswerSubmitted: Skipping, mismatch", {
          player,
          address,
          quizId,
          qId,
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
    [address, quizId, questions.length]
  );

  const onQuizCompleted = useCallback(
    (logs: any[]) => {
      const event = logs[0];
      const player: string = event.args.player;
      const qId: string = event.args.quizId;
      const score: number = Number(event.args.correctCount);
      console.log("onQuizCompleted: Event received", {
        player,
        quizId: qId,
        score,
        txHash: event.transactionHash,
        blockNumber: Number(event.blockNumber),
        timestamp: new Date().toISOString(),
      });
      if (player.toLowerCase() !== address?.toLowerCase() || qId !== quizId) {
        console.log("onQuizCompleted: Skipping, mismatch", {
          player,
          address,
          quizId,
          qId,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      setReward(score.toString());
      setEntryState("awaitingAnswer");
      fetchLeaderboard();
    },
    [address, quizId, fetchLeaderboard]
  );

  const onBonusAwarded = useCallback(
    (logs: any[]) => {
      const event = logs[0];
      const player: string = event.args.player;
      const qId: string = event.args.quizId;
      const amount: number = Number(event.args.amount);
      console.log("onBonusAwarded: Event received", {
        player,
        quizId: qId,
        amount,
        txHash: event.transactionHash,
        blockNumber: Number(event.blockNumber),
        timestamp: new Date().toISOString(),
      });
      if (player.toLowerCase() !== address?.toLowerCase() || qId !== quizId) {
        console.log("onBonusAwarded: Skipping, mismatch", {
          player,
          address,
          quizId,
          qId,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      setReward((r) => (parseInt(r || "0") + amount).toString());
    },
    [address, quizId]
  );

  const onLeaderboardRefreshed = useCallback(
    (logs: any[]) => {
      const event = logs[0];
      console.log("onLeaderboardRefreshed: Event received", {
        txHash: event.transactionHash,
        blockNumber: Number(event.blockNumber),
        timestamp: new Date().toISOString(),
      });
      fetchLeaderboard();
    },
    [fetchLeaderboard]
  );

  const onQuizCancelled = useCallback(
    (logs: any[]) => {
      const event = logs[0];
      const player: string = event.args.player;
      const qId: string = event.args.quizId;
      console.log("onQuizCancelled: Event received", {
        player,
        quizId: qId,
        txHash: event.transactionHash,
        blockNumber: Number(event.blockNumber),
        timestamp: new Date().toISOString(),
      });
      if (player.toLowerCase() !== address?.toLowerCase() || qId !== quizId) {
        console.log("onQuizCancelled: Skipping, mismatch", {
          player,
          address,
          quizId,
          qId,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      setEntryState("idle");
      setQuizId("");
      setQuestions([]);
      setCurrentIndex(0);
      setReward("");
    },
    [address, quizId]
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
      quizContract!.write.checkVRFAndGenerateQuiz(Number(requestId));
    },
    [address, quizContract]
  );

  // Event Subscriptions
  const chainQuizAddress = process.env.NEXT_PUBLIC_CHAINQUIZ_ADDRESS as `0x${string}`;

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
    eventName: "BonusAwarded",
    onLogs: onBonusAwarded,
    enabled: !!quizContract && !!address && status === "connected",
  });

  useWatchContractEvent({
    address: chainQuizAddress,
    abi: ChainQuizABI,
    eventName: "LeaderboardRefreshed",
    onLogs: onLeaderboardRefreshed,
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
    if (!quizContract || !tokenContract || selectedDomains.length < 5 || !address) {
      setErrorMessage("Select at least 5 domains, choose a difficulty & connect your wallet.");
      return;
    }
    setErrorMessage("");
    setEntryState("staking");
    setIsLoading(true);

    try {
      // 2️⃣ Prepare params
      const quizAddr = process.env.NEXT_PUBLIC_CHAINQUIZ_ADDRESS!;
      const entryFee = BigInt(process.env.NEXT_PUBLIC_ENTRY_FEE_IN_QUIZ!);
      const diffMap = { Easy: 0, Medium: 1, Hard: 2 } as const;
      const diffIndex = diffMap[difficulty];

      console.log("🚀 startQuiz → Approving token", { quizAddr, entryFee });
      const approveHash = await tokenContract.write.approve([quizAddr, entryFee]);
      console.log("✍️  Approve tx sent:", approveHash);

      // 3️⃣ Wait for the approve to be mined
      const receipt1 = await publicClient.waitForTransactionReceipt({ hash: approveHash });
      console.log("✅ Approve confirmed:", {
        status: receipt1.status,
        gasUsed: receipt1.gasUsed.toString()
      });

      // 4️⃣ Call startQuiz with BOTH domains & difficulty
      console.log("🚀 startQuiz → submitting on-chain", { selectedDomains, diffIndex });
      const startHash = await quizContract.write.startQuiz(selectedDomains);
      console.log("✍️  startQuiz tx sent:", startHash);

      // all further UX updates will come via your on-chain event subscribers
    } catch (err: any) {
      console.error("❌ startQuiz error:", err);
      setErrorMessage(`Failed to start quiz: ${err.message}`);
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
    address
  ]);

  // Submit Answer
  const submitAnswer = useCallback(
    async (selectedIndex: number) => {
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
      console.log("submitAnswer: Submitting", {
        quizId,
        questionId: questions[currentIndex]?.id,
        selectedIndex,
        timestamp: new Date().toISOString(),
      });
      setIsLoading(true);
      try {
        const apiUrl = process.env.NEXT_PUBLIC_ELIZAOS_URL || "http://localhost:5000";
        console.log("submitAnswer: Verifying answer with ELIZA", {
          url: `${apiUrl}/verifyAnswer`,
          payload: { quizId, questionId: questions[currentIndex]?.id, selectedIndex },
          timestamp: new Date().toISOString(),
        });
        const resp = await axios.post(`${apiUrl}/verifyAnswer`, {
          quizId,
          questionId: questions[currentIndex]?.id,
          selectedIndex,
        });
        console.log("submitAnswer: ELIZA verify response", {
          isCorrect: resp.data.isCorrect,
          status: resp.status,
          response: resp.data,
          timestamp: new Date().toISOString(),
        });
        if (!resp.data.isCorrect) {
          console.log("submitAnswer: Incorrect answer", {
            quizId,
            questionId: questions[currentIndex]?.id,
            selectedIndex,
            timestamp: new Date().toISOString(),
          });
          setErrorMessage("Incorrect answer. Try again!");
          setTimer(45);
          setEntryState("inQuiz");
          return;
        }
        console.log("submitAnswer: Submitting on-chain", {
          selectedIndex,
          timestamp: new Date().toISOString(),
        });
        const submitHash = await quizContract.write.submitAnswer(selectedIndex);
        console.log("submitAnswer: Transaction sent", {
          txHash: submitHash,
          timestamp: new Date().toISOString(),
        });
        if (publicClient) {
          console.log("submitAnswer: Waiting for transaction", {
            txHash: submitHash,
            timestamp: new Date().toISOString(),
          });
          const receipt = await publicClient.waitForTransactionReceipt({
            hash: submitHash,
          });
          console.log("submitAnswer: Transaction confirmed", {
            txHash: submitHash,
            receipt: {
              status: receipt.status,
              gasUsed: receipt.gasUsed.toString(),
              blockNumber: receipt.blockNumber.toString(),
            },
            timestamp: new Date().toISOString(),
          });
        }
        if (currentIndex < questions.length - 1) {
          console.log("submitAnswer: Advancing to next question", {
            currentIndex,
            nextIndex: currentIndex + 1,
            totalQuestions: questions.length,
            timestamp: new Date().toISOString(),
          });
          setCurrentIndex(currentIndex + 1);
          setTimer(45);
        } else {
          console.log("submitAnswer: Finishing quiz", {
            quizId,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (err: any) {
        console.error("submitAnswer: Error", {
          message: err.message,
          error: err.response?.data || err,
          timestamp: new Date().toISOString(),
        });
        setErrorMessage(`Failed to submit answer: ${err.response?.data?.error || err.message}`);
        setEntryState("inQuiz");
        setTimer(45);
      } finally {
        setIsLoading(false);
      }
    },
    [quizContract, address, status, quizId, questions, currentIndex, publicClient]
  );

  // Request Random Challenge
  const requestChallenge = useCallback(async () => {
    if (!quizContract || !address || status !== "connected") {
      console.error("requestChallenge: Invalid input", {
        quizContract: !!quizContract,
        address: !!address,
        status,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    console.log("requestChallenge: Starting", {
      timestamp: new Date().toISOString(),
    });
    setEntryState("awaitingAnswer");
    setIsLoading(true);
    try {
      const challengeHash = await quizContract.write.requestRandomChallenge();
      console.log("requestChallenge: Transaction sent", {
        txHash: challengeHash,
        timestamp: new Date().toISOString(),
      });
      if (publicClient) {
        console.log("requestChallenge: Waiting for transaction", {
          txHash: challengeHash,
          timestamp: new Date().toISOString(),
        });
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: challengeHash,
        });
        console.log("requestChallenge: Transaction confirmed", {
          txHash: challengeHash,
          receipt: {
            status: receipt.status,
            gasUsed: receipt.gasUsed.toString(),
            blockNumber: receipt.blockNumber.toString(),
          },
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err: any) {
      console.error("requestChallenge: Error", {
        message: err.message,
        error: err,
        timestamp: new Date().toISOString(),
      });
      setErrorMessage(`Failed to request challenge: ${err.message}`);
    } finally {
      setEntryState("idle");
      setIsLoading(false);
    }
  }, [quizContract, address, status, publicClient]);

  // Cancel Quiz
  const cancelQuiz = useCallback(async () => {
    if (!quizContract || !address || status !== "connected") {
      console.error("cancelQuiz: Invalid input", {
        quizContract: !!quizContract,
        address: !!address,
        status,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    console.log("cancelQuiz: Starting", {
      quizId,
      timestamp: new Date().toISOString(),
    });
    setEntryState("awaitingAnswer");
    setIsLoading(true);
    try {
      const cancelHash = await quizContract.write.cancelQuiz();
      console.log("cancelQuiz: Transaction sent", {
        txHash: cancelHash,
        timestamp: new Date().toISOString(),
      });
      if (publicClient) {
        console.log("cancelQuiz: Waiting for transaction", {
          txHash: cancelHash,
          timestamp: new Date().toISOString(),
        });
        const receipt = await publicClient.waitForTransactionReceipt({
          hash: cancelHash,
        });
        console.log("cancelQuiz: Transaction confirmed", {
          txHash: cancelHash,
          receipt: {
            status: receipt.status,
            gasUsed: receipt.gasUsed.toString(),
            blockNumber: receipt.blockNumber.toString(),
          },
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err: any) {
      console.error("cancelQuiz: Error", {
        message: err.message,
        error: err,
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
  }, []);

  useEffect(() => {
    console.log("Domains effect: Setting domains", {
      timestamp: new Date().toISOString(),
    });
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
    const fetchBalance = async () => {
      console.log("fetchBalance 📋", {
        address,
        status,
        tokenContract: !!tokenContract,
        isValidAddress: isAddress(address ?? ""),
        timestamp: new Date().toISOString(),
      });

      // 1️⃣ Guard: address must be a string and valid EVM address
      if (typeof address !== "string" || status !== "connected" || !tokenContract || !isAddress(address)) {
        console.log("fetchBalance ⏭ skipping invalid input");
        setBalance("0");
        return;
      }

      try {
        // 2️⃣ Call with a string, not an array!
        //    TS error “`0x${string}`[] not assignable to string” goes away here.
        const raw = await tokenContract.read.balanceOf(address as Address);

        console.log("fetchBalance raw return:", {
          typeofRaw: typeof raw,
          raw,
          timestamp: new Date().toISOString(),
        });

        // 3️⃣ Normalize to bigint in case raw isn’t typed exactly
        const bal: bigint =
          typeof raw === "bigint" ? raw : BigInt(raw as unknown as string);

        console.log("fetchBalance normalized bigint:", {
          bal,
          timestamp: new Date().toISOString(),
        });

        // 4️⃣ Format & set
        setBalance(formatEther(bal));
        console.log("fetchBalance ✅ success", { balance: formatEther(bal) });
      } catch (err: any) {
        console.error("fetchBalance ❌ error", err);
        setBalance("0");
      }
    };

    fetchBalance();
  }, [address, status, tokenContract]);

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
            Error: Contract addresses or RPC URL not configured. Check NEXT_PUBLIC_PROPERTIES in .env.local.
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
              <p className="text-sm text-gray-400 truncate max-w-[12rem]">{address}</p>
              <p className="text-sm text-blue-400">{balance} QUIZ</p>
            </div>
          )}

          {/* Domain Selection, Difficulty, & Start Quiz */}
          {status === "connected" && address && entryState === "idle" && (
            <div className="p-6 bg-gray-800/80 rounded-2xl shadow-md space-y-4">
              <h2 className="text-xl font-semibold text-gray-100">Select 5+ Domains</h2>
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
              <h2 className="text-xl font-semibold text-gray-100">Select Difficulty</h2>
              <div className="flex gap-3">
                {["Easy", "Medium", "Hard"].map((diff) => (
                  <button
                    key={diff}
                    onClick={() => setDifficulty(diff as "Easy" | "Medium" | "Hard")}
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
                disabled={selectedDomains.length < 5 || entryState !== "idle" || isLoading}
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
                    : `Start Quiz (${selectedDomains.length} Domains, ${difficulty}, ${questions.length || 10} Questions)`}
                </span>
              </button>
            </div>
          )}

          {/* Quiz Questions */}
          {status === "connected" && address && entryState === "inQuiz" && questions.length > 0 && (
            <div className="p-6 bg-gray-800/80 rounded-2xl shadow-md space-y-4">
              <h2 className="text-xl font-semibold text-gray-100">
                Question {currentIndex + 1}/{questions.length}
              </h2>
              <p className="text-base text-gray-200">{questions[currentIndex]?.text || "Loading..."}</p>
              <div className="grid grid-cols-1 gap-2">
                {Array.isArray(questions[currentIndex]?.options) ? (
                  questions[currentIndex].options.map((opt: string, idx: number) => (
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
                      <span className={isLoading ? "opacity-0" : ""}>{opt}</span>
                    </button>
                  ))
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
          {status === "connected" && address && entryState === "awaitingAnswer" && (
            <div className="p-6 bg-gray-800/80 rounded-2xl shadow-md space-y-4 text-center">
              <h2 className="text-xl font-semibold text-gray-100">Quiz Completed!</h2>
              <p className="text-base text-gray-200">
                You earned {reward || "0"} QUIZ
              </p>
              <div className="flex justify-center gap-3 mt-3">
                <button
                  onClick={requestChallenge}
                  disabled={isLoading}
                  className="p-2 bg-purple-500 hover:bg-purple-600 rounded-lg text-sm text-white disabled:bg-gray-600 disabled:cursor-not-allowed relative"
                >
                  {isLoading && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                    </div>
                  )}
                  <span className={isLoading ? "opacity-0" : ""}>Request Random Challenge</span>
                </button>
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
                  <span className={isLoading ? "opacity-0" : ""}>Cancel Quiz & Refund</span>
                </button>
              </div>
            </div>
          )}

          {/* Leaderboard */}
          <div className="p-6 bg-gray-800/80 rounded-2xl shadow-md space-y-4">
            <h2 className="text-xl font-semibold text-gray-100">Leaderboard (Top 5)</h2>
            <table className="w-full text-left text-gray-200 text-sm">
              <thead>
                <tr className="border-b border-gray-600">
                  <th className="px-2 py-1">Rank</th>
                  <th className="px-2 py-1">Address</th>
                  <th className="px-2 py-1">Score</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((row, i) => (
                  <tr key={row.address} className="border-b border-gray-700">
                    <td className="px-2 py-1">{i + 1}</td>
                    <td className="px-2 py-1 truncate max-w-[150px]">{row.address}</td>
                    <td className="px-2 py-1">{row.score}</td>
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
