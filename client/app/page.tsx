"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import {
  useAccount,
  usePublicClient,
  useWatchContractEvent,
  useAccountEffect, // Added for connection handling
} from "wagmi";
import { useQuizToken } from "../src/hooks/useQuizToken";
import { useChainQuiz } from "../src/hooks/useChainQuiz";
import { supabase } from "../src/utils/supabaseClient";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { formatEther, isAddress } from "viem";
import { keccak256,  stringToHex } from "viem";
import chainQuizABI from "../src/abis/ChainQuizABI.json";

// Environment variables
const CHAIN_QUIZ_ADDRESS = process.env
  .NEXT_PUBLIC_CHAINQUIZ_ADDRESS as `0x${string}`;
const QUIZ_TOKEN_ADDRESS = process.env
  .NEXT_PUBLIC_QUIZTOKEN_ADDRESS as `0x${string}`;

// ChainQuiz contract ABI for events

function ErrorBoundary({ children }: { children: React.ReactNode }) {
  const [hasError, setHasError] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      console.error("ErrorBoundary caught:", event);
      setHasError(true);
      setError(event.error?.message || "An unknown error occurred");
    };
    window.addEventListener("error", handleError);
    return () => window.removeEventListener("error", handleError);
  }, []);

  if (hasError) {
    return (
      <div className="min-h-screen flex flex-col bg-gray-900 text-gray-100">
        <header className="flex justify-between items-center p-6 bg-gray-800/70 backdrop-blur-sm">
          <h1 className="text-3xl font-bold text-blue-400">ChainQuiz</h1>
          <ConnectButton showBalance={false} />
        </header>
        <main className="flex-1 p-6 space-y-6">
          <div className="p-4 bg-red-500/20 border border-red-500 rounded-lg text-center">
            <p className="text-red-400">
              {error || "An unknown error occurred"}
            </p>
            <button
              onClick={() => {
                setHasError(false);
                setError(null);
              }}
              className="mt-4 px-4 py-2 bg-blue-500 hover:bg-blue-600 rounded-lg text-white"
            >
              Retry
            </button>
          </div>
        </main>
      </div>
    );
  }
  return <>{children}</>;
}

export default function Home() {
  // Hooks and state
  const { address, status } = useAccount();
  const publicClient = usePublicClient();
  const chainQuizRaw = useChainQuiz();
  const tokenContractRaw = useQuizToken();
  const chainQuiz = useMemo(() => chainQuizRaw, [chainQuizRaw]);
  const tokenContract = useMemo(() => tokenContractRaw, [tokenContractRaw]);
  const isHooksInitialized = Boolean(chainQuiz && tokenContract);
  const [isLoading, setIsLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [domains, setDomains] = useState<string[]>([]);
  const [selectedDomains, setSelectedDomains] = useState<string[]>([]);
  const [difficulty, setDifficulty] = useState<"Easy" | "Medium" | "Hard">(
    "Medium"
  );
  const [questions, setQuestions] = useState<any[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [timer, setTimer] = useState<number>(45);
  const [entryState, setEntryState] = useState<
    "idle" | "staking" | "inQuiz" | "awaitingAnswer"
  >("idle");
  const [balance, setBalance] = useState<string>("0");
  const [leaderboard, setLeaderboard] = useState<
    { address: string; score: number }[]
  >([]);
  const [quizId, setQuizId] = useState<string>("");
  const [reward, setReward] = useState<string>("");
  const [rewardUSD, setRewardUSD] = useState<string>("");
  const hasFetched = useRef(false);

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const ENTRY_FEE = BigInt(
    process.env.NEXT_PUBLIC_ENTRY_FEE ?? "10000000000000000"
  );

  // Debug wallet connection state
  useEffect(() => {
    console.log("Wallet state:", {
      address,
      status,
      timestamp: new Date().toISOString(),
    });
  }, [address, status]);

  // Reset hasFetched on wallet connect
  useAccountEffect({
    onConnect: () => {
      console.log("Wallet connected, resetting hasFetched", {
        timestamp: new Date().toISOString(),
      });
      hasFetched.current = false;
    },
    onDisconnect: () => {
      console.log("Wallet disconnected, resetting balance", {
        timestamp: new Date().toISOString(),
      });
      setBalance("0");
      hasFetched.current = false;
    },
  });

  // Validate environment variables
  const isValidConfig =
    isAddress(CHAIN_QUIZ_ADDRESS) && isAddress(QUIZ_TOKEN_ADDRESS);
  if (!isValidConfig) {
    return (
      <ErrorBoundary>
        <div className="min-h-screen flex flex-col bg-gray-900 text-gray-100">
          <header className="flex justify-between items-center p-6 bg-gray-800/70 backdrop-blur-sm">
            <h1 className="text-2xl font-bold text-blue-600">ChainQuiz</h1>
            <ConnectButton showBalance={false} />
          </header>
          <main className="flex-1 p-6 space-y-6">
            <div className="p-4 bg-red-500/20 border border-red-600 rounded-lg text-center">
              <p className="text-red-500">
                Error: Invalid contract addresses. Check
                NEXT_PUBLIC_CHAINQUIZ_ADDRESS and NEXT_PUBLIC_QUIZ_TOKEN_ADDRESS
                in .env.local
              </p>
            </div>
          </main>
        </div>
      </ErrorBoundary>
    );
  }

  // Debounce utility
  const debounce = (func: (...args: any[]) => void, wait: number) => {
    let timeout: NodeJS.Timeout;
    return (...args: any[]) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func(...args), wait);
    };
  };

  // Fetch Balance
  const fetchBalance = useCallback(
    debounce(async () => {
      if (!tokenContract || status !== "connected" || !isAddress(address!)) {
        setBalance("0");
        console.log("fetchBalance: Skipped", {
          tokenContract: !!tokenContract,
          status,
          address,
          isValidAddress: isAddress(address!),
          timestamp: new Date().toISOString(),
        });
        return;
      }
      try {
        const raw = await tokenContract.read.balanceOf(address!);
        const bal =
          typeof raw === "bigint"
            ? raw
            : typeof raw === "number"
            ? BigInt(raw)
            : 0n;
        setBalance(formatEther(bal));
        console.log("fetchBalance: Success", {
          balance: formatEther(bal),
          ts: new Date().toISOString(),
        });
      } catch (e: any) {
        console.error("fetchBalance error:", e);
        setBalance("Error");
      }
    }, 500),
    [tokenContract, address, status]
  );

  // Fetch Balance Effect
  useEffect(() => {
    if (hasFetched.current) return;
    if (tokenContract && status === "connected" && isAddress(address!)) {
      hasFetched.current = true;
      fetchBalance();
    }
  }, [tokenContract, address, status, fetchBalance]);

  // Debug Fetch Questions
  const debugFetchQuestions = useCallback(async (quizId: string) => {
    console.log("debugFetchQuestions:", {
      quizId,
      timestamp: new Date().toISOString(),
    });
    try {
      const { data, error } = await supabase
        .from("Quizzes")
        .select("questions")
        .eq("quizid", quizId)
        .single();
      if (error) throw error;
      console.log("debugFetch success:", {
        questionCount: data.questions?.length,
      });
      if (!data.questions || !Array.isArray(data.questions))
        throw new Error("Invalid questions format");
      setQuestions(data.questions);
      setEntryState("inQuiz");
      setTimer(45);
    } catch (err: any) {
      console.error("debugFetchQuestions error:", err.message);
      setErrorMessage(`Failed to fetch questions: ${err.message}`);
    }
  }, []);

  // Debug Generate Questions
const debugGenerateQuestions = useCallback(async () => {
  if (!address || !chainQuiz) {
    setErrorMessage("Connect wallet to generate questions");
    return;
  }
  setIsLoading(true);
  try {
    // 1) numeric ID for Supabase `id` (bigint)
    const numericId = BigInt(Date.now());
    // 2) human‐friendly quizId
    const quizId = `quiz-${numericId}`;
    // 3) make a 32-byte requestId by hashing the hexified quizId
    const mockRequestId = keccak256(stringToHex(quizId)) as `0x${string}`;

    // 4) mock up your 10 questions
    const mockQuestions = Array.from({ length: 10 }, (_, i) => ({
      id:   `q${i + 1}`,
      domain: selectedDomains[i % selectedDomains.length],
      text: `Question ${i + 1} — ${selectedDomains[i % selectedDomains.length]} (${difficulty})`,
      options: ["Option 1 (Correct)", "Option 2", "Option 3", "Option 4"],
      correctIndex: 0,
    }));

    // 5) insert into Supabase (id: bigint, quiz_id: text)
    const { error } = await supabase.from("Quizzes").insert({
      id: Number(numericId),     // your bigint PK
      quiz_id: quizId,           // a text column
      player_address: address.toLowerCase(),
      domains: selectedDomains,
      difficulty: difficulty.toLowerCase(),
      questions: mockQuestions,
      started_at: new Date().toISOString(),
      correct_count: 0,
      completed_at: null,
    });

    if (error) {
      console.error("Supabase insert failed:", error);
      // refund & cancel on‐chain if Supabase fails
      try {
        await chainQuiz.cancelQuiz();
        console.log("Cancelled on-chain quiz due to Supabase error.");
      } catch (cErr: any) {
        console.error("Failed to cancel on-chain quiz:", cErr);
      }
      throw new Error(error.message);
    }

    // 6) build your "response" bytes, e.g. "quiz-1234567890|10"
    const responseHex = stringToHex(`${quizId}|10`);
    await chainQuiz.debugFulfillRequest(mockRequestId, responseHex, "0x");

    // 7) drive the UI into quiz mode
    setQuizId(quizId);
    setQuestions(mockQuestions);
    setCurrentIndex(0);
    setEntryState("inQuiz");
    setTimer(45);
  } catch (err: any) {
    console.error("debugGenerateQuestions error:", err);
    setErrorMessage(`Failed to generate questions: ${err.message}`);
    setEntryState("idle");
  } finally {
    setIsLoading(false);
  }
}, [
  address,
  chainQuiz,
  selectedDomains,
  difficulty,
  setQuizId,
  setQuestions,
  setCurrentIndex,
  setEntryState,
  setTimer,
]);

  // Debug Submit Answer
  const debugSubmitAnswer = useCallback(
    async (selectedIndex: number, isCorrect: boolean) => {
      if (
        !chainQuiz?.quizId ||
        !address ||
        !chainQuiz?.lastRequestId ||
        !quizId ||
        !questions[currentIndex]?.id ||
        selectedIndex < 0 ||
        selectedIndex > 3
      ) {
        setErrorMessage(
          "Invalid input: Quiz ID, address, request ID, question, or answer index (0-3) not available"
        );
        return;
      }
      setIsLoading(true);
      try {
        const responseBytes = isCorrect ? "0x31" : "0x30";
        const hash = await chainQuiz.debugFulfillRequest(
          chainQuiz.lastRequestId,
          responseBytes,
          "0x"
        );
        console.log("debugSubmitAnswer: Transaction sent", {
          hash,
          selectedIndex,
          isCorrect,
          quizId: chainQuiz.quizId,
        });
        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          timeout: 30000,
        });
        if (receipt.status !== "success") {
          throw new Error(
            "Transaction reverted. Check contract logs for details."
          );
        }
        const { data, error } = await supabase
          .from("Quizzes")
          .select("correct_count")
          .eq("quizid", chainQuiz.quizId)
          .single();
        if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
        const newCorrectCount = isCorrect
          ? data.correct_count + 1
          : data.correct_count;
        const { error: updateError } = await supabase
          .from("Quizzes")
          .update({
            correct_count: newCorrectCount,
            completed_at:
              currentIndex === questions.length - 1
                ? new Date().toISOString()
                : null,
          })
          .eq("quizid", chainQuiz.quizId);
        if (updateError)
          throw new Error(`Supabase update failed: ${updateError.message}`);
        console.log("debugSubmitAnswer:", {
          quizId: chainQuiz.quizId,
          selectedIndex,
          isCorrect,
        });
        if (isCorrect || currentIndex < questions.length - 1) {
          setCurrentIndex((i) => Math.min(i + 1, questions.length - 1));
        }
        setTimer(45);
      } catch (err: any) {
        console.error("debugSubmitAnswer error:", err.message);
        setErrorMessage(`Failed to submit debug answer: ${err.message}`);
      } finally {
        setIsLoading(false);
      }
    },
    [chainQuiz, address, currentIndex, questions, quizId, publicClient]
  );

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

  // Start Quiz
  const startQuiz = useCallback(async () => {
    if (
      !address ||
      !publicClient ||
      !tokenContract ||
      !chainQuiz ||
      selectedDomains.length < 5
    ) {
      setErrorMessage("Please connect wallet and select at least 5 domains");
      return;
    }
    setEntryState("staking");
    setIsLoading(true);
    try {
      const balance = await tokenContract.read.balanceOf(address);
      console.log("startQuiz balance:", {
        balance: formatEther(balance),
        address,
      });
      if (balance < ENTRY_FEE) {
        throw new Error("Insufficient $QUIZ balance.");
      }

      const allowance = await tokenContract.read.allowance(
        address,
        CHAIN_QUIZ_ADDRESS
      );
      console.log("startQuiz allowance:", {
        allowance: formatEther(allowance),
        address,
      });
      if (allowance < ENTRY_FEE) {
        console.log("startQuiz approving:", {
          chainQuizAddress: CHAIN_QUIZ_ADDRESS,
          entryFee: ENTRY_FEE.toString(),
          address,
        });
        const hash = await tokenContract.write.approve([
          CHAIN_QUIZ_ADDRESS,
          ENTRY_FEE,
        ]);
        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          timeout: 30000,
        });
        if (receipt.status !== "success") throw new Error("Approval failed.");
        fetchBalance();
      }

      console.log("startQuiz submitting:", {
        selectedDomains,
        difficulty,
        address,
      });
      const startHash = await chainQuiz.startQuiz(selectedDomains, difficulty);
      console.log("startQuiz: Transaction sent", { hash: startHash });

      // Wait for transaction receipt
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: startHash,
        timeout: 60000, // 60 seconds
      });
      console.log("startQuiz: Receipt", {
        hash: startHash,
        status: receipt.status,
      });
      if (receipt.status !== "success") {
        throw new Error(
          "Transaction reverted. Check contract logs for details."
        );
      }

      // In local testing, skip waiting for QuizGenerated and use debugGenerateQuestions
      await debugGenerateQuestions();
    } catch (err: any) {
      console.error("startQuiz error:", {
        message: err.message,
        details: err,
        address,
        selectedDomains,
        difficulty,
        timestamp: new Date().toISOString(),
      });
      setErrorMessage(`Failed to start quiz: ${err.message}`);
      setEntryState("idle");
    } finally {
      setIsLoading(false);
    }
  }, [
    address,
    publicClient,
    tokenContract,
    chainQuiz,
    selectedDomains,
    difficulty,
    fetchBalance,
    debugGenerateQuestions,
  ]);

  useEffect(() => {
    if (entryState !== "staking") return;
    const timeout = setTimeout(() => {
      if (entryState === "staking") {
        console.log("startQuiz: Timeout waiting for QuizGenerated", {
          timestamp: new Date().toISOString(),
        });
        setErrorMessage("Quiz generation timed out. Please try again.");
        setEntryState("idle");
        setIsLoading(false);
      }
    }, 30_000); // 30 seconds
    return () => clearTimeout(timeout);
  }, [entryState]);

  // in your Home component, after you do `startQuiz`:

  // Submit Answer
  const submitAnswer = useCallback(
    async (selectedIndex: number) => {
      console.log("submitAnswer:", {
        quizId: chainQuiz.quizId,
        questionId: questions[currentIndex]?.id,
        selectedIndex,
      });
      if (
        !isHooksInitialized ||
        !address ||
        status !== "connected" ||
        !chainQuiz.quizId
      ) {
        setErrorMessage("Invalid input: Connect wallet or quiz not active");
        return;
      }
      setIsLoading(true);
      try {
        await chainQuiz.submitAnswer(selectedIndex);
        console.log("submitAnswer success:", { selectedIndex });
      } catch (err: any) {
        console.error("submitAnswer error:", err.message);
        setErrorMessage(`Failed to submit answer: ${err.message}`);
        setEntryState("inQuiz");
        setTimer(45);
      } finally {
        setIsLoading(false);
      }
    },
    [isHooksInitialized, address, status, chainQuiz, questions, currentIndex]
  );

  // Cancel Quiz
  const cancelQuiz = useCallback(async () => {
    console.log("cancelQuiz:", { quizId: chainQuiz.quizId });
    if (!isHooksInitialized || !address || status !== "connected") {
      setErrorMessage("Invalid input: Connect wallet");
      return;
    }
    setIsLoading(true);
    try {
      await chainQuiz.cancelQuiz();
      console.log("cancelQuiz success:");
      fetchBalance();
    } catch (err: any) {
      console.error("cancelQuiz error:", err.message);
      setErrorMessage(`Failed to cancel quiz: ${err.message}`);
      setEntryState("idle");
    } finally {
      setIsLoading(false);
    }
  }, [isHooksInitialized, address, status, chainQuiz, fetchBalance]);

  useEffect(() => {
    if (entryState === "staking") {
      // if after 30s we still haven’t seen QuizGenerated, call cancelQuiz()
      const timer = setTimeout(() => {
        console.warn("No questions arrived—auto-cancelling");
        cancelQuiz();
      }, 30_000);
      return () => clearTimeout(timer);
    }
  }, [entryState, cancelQuiz]);
  // Event Handlers
  const onQuizRequested = useCallback(
    (logs: any[]) => {
      const event = logs[0];
      const player: string = event.args.player;
      const requestId: `0x${string}` = event.args.requestId;
      console.log("onQuizRequested:", {
        player,
        requestId,
        txHash: event.transactionHash,
      });
      if (player.toLowerCase() !== address?.toLowerCase()) return;
      chainQuiz.setLastRequestId(requestId);
    },
    [address, chainQuiz]
  );

  const onQuizGenerated = useCallback(
    async (logs: any[]) => {
      const event = logs[0];
      const player: string = event.args.player;
      const qId: string = event.args.quizId;
      console.log("onQuizGenerated:", {
        player,
        quizId: qId,
        txHash: event.transactionHash,
      });
      if (player.toLowerCase() !== address?.toLowerCase()) return;
      setIsLoading(true);
      setQuizId(qId);
      try {
        await debugFetchQuestions(qId);
        setErrorMessage("");
      } catch (err: any) {
        console.error("onQuizGenerated error:", err.message);
        setErrorMessage(`Failed to fetch quiz details: ${err.message}`);
        setEntryState("idle");
      } finally {
        setIsLoading(false);
      }
    },
    [address, debugFetchQuestions]
  );

  const onAnswerChecked = useCallback(
    async (logs: any[]) => {
      const event = logs[0];
      const player: string = event.args.player;
      const requestId: `0x${string}` = event.args.requestId;
      console.log("onAnswerChecked:", {
        player,
        requestId,
        txHash: event.transactionHash,
      });
      if (player.toLowerCase() !== address?.toLowerCase()) return;
      setIsLoading(true);
      try {
        const isCorrect = await chainQuiz.verifyAnswer(
          chainQuiz.quizId,
          address,
          chainQuiz.questionIndex,
          event.args?.selectedIndex ?? 0
        );
        console.log("onAnswerChecked success (backend verification):", {
          isCorrect,
        });
        setEntryState("inQuiz");
        setTimer(45);
      } catch (err: any) {
        console.error(
          "onAnswerChecked error (backend verification):",
          err.message
        );
        setErrorMessage(`Failed to verify answer via backend: ${err.message}`);
        setEntryState("inQuiz");
        setTimer(45);
      } finally {
        setIsLoading(false);
      }
    },
    [chainQuiz, address]
  );

  const onAnswerResult = useCallback(
    (logs: any[]) => {
      const event = logs[0];
      const player: string = event.args.player;
      const isCorrect: boolean = event.args.isCorrect;
      const questionIndex: number = Number(event.args.questionIndex);
      console.log("onAnswerResult:", {
        player,
        isCorrect,
        questionIndex,
        txHash: event.transactionHash,
      });
      if (player.toLowerCase() !== address?.toLowerCase()) return;
      if (isCorrect) {
        setCurrentIndex((i) => Math.min(i + 1, questions.length - 1));
      }
      setTimer(45);
    },
    [address, questions.length]
  );

  const onQuizCompleted = useCallback(
    (logs: any[]) => {
      const event = logs[0];
      const player: string = event.args.player;
      const score: number = Number(event.args.correctCount);
      const rewardWei: bigint = event.args.reward;
      const rewardUSDWei: bigint = event.args.rewardUSD;
      console.log("onQuizCompleted:", {
        player,
        score,
        reward: formatEther(rewardWei),
        rewardUSD: formatEther(rewardUSDWei),
      });
      if (player.toLowerCase() !== address?.toLowerCase()) return;
      setReward(formatEther(rewardWei));
      setRewardUSD(formatEther(rewardUSDWei));
      setEntryState("awaitingAnswer");
      fetchLeaderboard();
      fetchBalance();
    },
    [address, fetchLeaderboard, fetchBalance]
  );

  const onQuizCancelled = useCallback(
    (logs: any[]) => {
      const event = logs[0];
      const player: string = event.args.player;
      console.log("onQuizCancelled:", {
        player,
        txHash: event.transactionHash,
      });
      if (player.toLowerCase() !== address?.toLowerCase()) return;
      setEntryState("idle");
      setQuizId("");
      setQuestions([]);
      setCurrentIndex(0);
      setReward("");
      setRewardUSD("");
      fetchBalance();
    },
    [address, fetchBalance]
  );

  useEffect(() => {
    if (!isHooksInitialized) return;
    console.log("entryState effect:", {
      isActive: chainQuiz.isActive,
      numQuestions: chainQuiz.numQuestions,
      reward: chainQuiz.reward,
      questionIndex: chainQuiz.questionIndex,
      rewardUSD: chainQuiz.rewardUSD,
    });
    if (chainQuiz.isActive && chainQuiz.numQuestions > 0) {
      setEntryState("inQuiz");
      setCurrentIndex(chainQuiz.questionIndex);
    } else if (chainQuiz.isActive) {
      setEntryState("staking");
    } else if (chainQuiz.rewardUSD && chainQuiz.rewardUSD !== "0") {
      setEntryState("awaitingAnswer");
    } else {
      setEntryState("idle");
      setQuestions([]);
      setCurrentIndex(0);
      setTimer(45);
    }
  }, [
    chainQuiz.isActive,
    chainQuiz.numQuestions,
    chainQuiz.rewardUSD,
    chainQuiz.reward,
    chainQuiz.questionIndex,
    isHooksInitialized,
  ]);

  useEffect(() => {
    async function fetchInitialData() {
      const { data, error } = await supabase.from("Quizzes").select("*");
      console.log("Quizzes data:", data, "Error:", error);
      setIsLoading(false);
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
      setLastUpdated(new Date().toLocaleTimeString());
    }
    fetchInitialData();
  }, []);

  useEffect(() => {
    if (questions.length) console.log("Questions updated:", questions);
  }, [questions]);

  // 1️⃣ countdown
  useEffect(() => {
    if (entryState !== "inQuiz") return;
    if (timer <= 0) return;

    const id = setTimeout(() => setTimer((t) => t - 1), 1000);
    return () => clearTimeout(id);
  }, [timer, entryState]);

  // 2️⃣ auto‐submit once
  const hasAutoSubmitted = useRef(false);

  useEffect(() => {
    if (
      !isHooksInitialized ||
      entryState !== "inQuiz" ||
      hasAutoSubmitted.current
    )
      return;
    if (timer === 0) {
      hasAutoSubmitted.current = true;
      submitAnswer(255).catch(() => {
        /* swallow error so it doesn’t spam you */
      });
    }
  }, [isHooksInitialized, timer, entryState, submitAnswer]);

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

  // Event Subscriptions
  useWatchContractEvent({
    address: CHAIN_QUIZ_ADDRESS,
    abi: chainQuizABI,
    eventName: "QuizRequested",
    onLogs: onQuizRequested,
    enabled: !!address && status === "connected",
  });

  useWatchContractEvent({
    address: CHAIN_QUIZ_ADDRESS,
    abi: chainQuizABI,
    eventName: "QuizGenerated",
    onLogs: onQuizGenerated,
    enabled: !!address && status === "connected",
  });

  useWatchContractEvent({
    address: CHAIN_QUIZ_ADDRESS,
    abi: chainQuizABI,
    eventName: "AnswerChecked",
    onLogs: onAnswerChecked,
    enabled: !!address && status === "connected",
  });

  useWatchContractEvent({
    address: CHAIN_QUIZ_ADDRESS,
    abi: chainQuizABI,
    eventName: "AnswerResult",
    onLogs: onAnswerResult,
    enabled: !!address && status === "connected",
  });

  useWatchContractEvent({
    address: CHAIN_QUIZ_ADDRESS,
    abi: chainQuizABI,
    eventName: "QuizCompleted",
    onLogs: onQuizCompleted,
    enabled: !!address && status === "connected",
  });

  useWatchContractEvent({
    address: CHAIN_QUIZ_ADDRESS,
    abi: chainQuizABI,
    eventName: "QuizCancelled",
    onLogs: onQuizCancelled,
    enabled: true,
  });

  return (
    <ErrorBoundary>
      <div className="min-h-screen flex flex-col bg-gray-900 text-gray-100">
        <header className="flex items-center justify-between p-4 bg-gray-800/20 backdrop-blur">
          <h1 className="text-2xl font-bold text-blue-600">ChainQuiz</h1>
          <ConnectButton showBalance={false} />
        </header>

        <main className="flex-1 p-6 space-y-6">
          {isLoading ? (
            <div className="flex items-center justify-center min-h-[calc(100vh-80px)]">
              <div className="text-center">
                <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mb-2"></div>
                <p className="text-gray-500 text-lg">Loading...</p>
              </div>
            </div>
          ) : (
            <>
              {!isValidConfig && (
                <div className="p-4 bg-red-500/20 border border-red-600 rounded-lg text-center">
                  <p className="text-red-500">
                    Error: Invalid contract addresses. Check
                    NEXT_PUBLIC_CHAINQUIZ_ADDRESS and
                    NEXT_PUBLIC_QUIZ_TOKEN_ADDRESS in .env.local
                  </p>
                </div>
              )}

              {isValidConfig && !isHooksInitialized && (
                <div className="p-4 bg-red-500/20 border border-red-600 rounded-lg text-center">
                  <p className="text-red-500">
                    Error: Contract hooks not initialized. Ensure wallet is
                    connected and environment variables are set.
                  </p>
                </div>
              )}

              {errorMessage && (
                <div className="p-4 bg-red-400/10 border border-red-600 rounded-lg text-center">
                  <p className="text-red-500">{errorMessage}</p>
                  <button
                    onClick={() => setErrorMessage("")}
                    className="mt-2 text-sm text-blue-500 hover:text-blue-400"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {status === "connected" && address && (
                <div className="flex justify-end gap-3 items-center">
                  <p className="text-base text-gray-500 truncate max-w-[10rem]">
                    {address}
                  </p>
                  <p className="text-base text-blue-500">{balance} QUIZ</p>
                </div>
              )}

              {isHooksInitialized &&
                status === "connected" &&
                address &&
                entryState === "idle" && (
                  <div className="p-4 bg-white/5 rounded-lg shadow-lg space-y-4">
                    <h2 className="text-lg font-semibold text-gray-200">
                      Select 5+ Domains
                    </h2>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      {domains.map((value) => (
                        <button
                          key={value}
                          onClick={() =>
                            setSelectedDomains((prev) =>
                              prev.includes(value)
                                ? prev.filter((x) => x !== value)
                                : [...prev, value]
                            )
                          }
                          className={`p-2 rounded-lg border text-sm ${
                            selectedDomains.includes(value)
                              ? "bg-blue-600 text-white border-blue-600"
                              : "bg-gray-700/50 text-gray-300 border-gray-300 hover:bg-gray-400/20"
                          }`}
                        >
                          {value}
                        </button>
                      ))}
                    </div>
                    <h2 className="text-lg font-semibold text-gray-200">
                      Select Difficulty
                    </h2>
                    <div className="flex gap-2">
                      {["Easy", "Medium", "Hard"].map((diff) => (
                        <button
                          key={diff}
                          onClick={() =>
                            setDifficulty(diff as "Easy" | "Medium" | "Hard")
                          }
                          className={`p-2 rounded-lg border text-sm ${
                            difficulty === diff
                              ? "bg-blue-600 text-white border-blue-600"
                              : "bg-gray-700/50 text-gray-300 border-gray-300 hover:bg-gray-400/20"
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
                        isLoading ||
                        status !== "connected" ||
                        !address
                      }
                      className="mt-2 w-full py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white font-semibold disabled:bg-gray-600 disabled:cursor-not-allowed relative"
                    >
                      {isLoading && entryState === "staking" ? (
                        <span className="flex items-center justify-center">
                          <span className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2"></span>
                          Starting Quiz...
                        </span>
                      ) : (
                        "Start Quiz"
                      )}
                    </button>
                  </div>
                )}

              {/* Cancel button: only when we’re staking or already in-quiz */}
              {isHooksInitialized &&
                status === "connected" &&
                address &&
                (entryState === "staking" || entryState === "inQuiz") && (
                  <div className="mt-4 flex justify-center">
                    <button
                      onClick={cancelQuiz}
                      disabled={isLoading}
                      className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Cancel Quiz
                    </button>
                  </div>
                )}

              {isHooksInitialized &&
                entryState === "inQuiz" &&
                questions.length > 0 && (
                  <div className="p-6 bg-gray-800 rounded-lg shadow-xl space-y-6">
                    <div className="flex justify-between items-center text-lg font-medium">
                      <span>
                        Question {currentIndex + 1} / {questions.length}
                      </span>
                      <span className="text-blue-400">Time: {timer}s</span>
                    </div>
                    <h2 className="text-2xl font-bold text-gray-100 mb-4">
                      {questions[currentIndex]?.text}
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {questions[currentIndex]?.options.map(
                        (option: string, i: number) => (
                          <button
                            key={i}
                            onClick={() => submitAnswer(i)}
                            disabled={isLoading || entryState !== "inQuiz"}
                            className="w-full p-4 bg-gray-700 hover:bg-blue-600 rounded-lg text-left transition duration-200 disabled:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {option}
                          </button>
                        )
                      )}
                    </div>
                    <button
                      onClick={cancelQuiz}
                      disabled={isLoading}
                      className="mt-4 w-full py-2 bg-red-600 hover:bg-red-700 rounded-lg text-white font-semibold disabled:bg-gray-600 disabled:cursor-not-allowed"
                    >
                      Cancel Quiz
                    </button>
                  </div>
                )}

              {isHooksInitialized &&
                entryState === "awaitingAnswer" &&
                chainQuiz.rewardUSD &&
                chainQuiz.rewardUSD !== "0" && (
                  <div className="p-6 bg-green-800/20 rounded-lg shadow-xl space-y-4 text-center border border-green-700">
                    <h2 className="text-3xl font-bold text-green-400">
                      Quiz Completed!
                    </h2>
                    <p className="text-xl text-gray-200">
                      You earned:{" "}
                      <span className="font-bold text-green-300">
                        {chainQuiz.reward} $QUIZ
                      </span>{" "}
                      (Approx.{" "}
                      <span className="font-bold text-green-300">
                        ${chainQuiz.rewardUSD}
                      </span>
                      )
                    </p>
                    <button
                      onClick={() => {
                        setEntryState("idle");
                        setQuestions([]);
                        setCurrentIndex(0);
                        chainQuiz.setReward("");
                        chainQuiz.setRewardUSD("");
                      }}
                      className="mt-4 px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white font-semibold"
                    >
                      Play Again
                    </button>
                  </div>
                )}

              {isHooksInitialized && entryState === "staking" && (
                <div className="p-6 bg-blue-800/20 rounded-lg shadow-xl space-y-4 text-center border border-blue-700">
                  <h2 className="text-2xl font-bold text-blue-400">
                    Waiting for Quiz Generation...
                  </h2>
                  <p className="text-gray-200">
                    Please wait while the quiz is being generated on-chain. This
                    may take a moment.
                  </p>
                  <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
                  {errorMessage && (
                    <div>
                      <p className="text-red-500 mt-2">{errorMessage}</p>
                      <button
                        onClick={() => {
                          setErrorMessage("");
                          setEntryState("idle");
                          setIsLoading(false);
                        }}
                        className="mt-4 px-6 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-white font-semibold"
                      >
                        Retry
                      </button>
                    </div>
                  )}
                </div>
              )}
              <div className="p-4 bg-white/5 rounded-lg shadow-lg space-y-2">
                <h2 className="text-lg font-semibold text-gray-200 flex justify-between items-center">
                  Leaderboard
                  <span className="text-sm text-gray-400">
                    Last updated: {lastUpdated}
                  </span>
                </h2>
                {leaderboard.length === 0 ? (
                  <p className="text-gray-400 text-center">
                    No scores yet. Be the first to play!
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {leaderboard.map((entry, index) => (
                      <li
                        key={index}
                        className="flex justify-between items-center text-gray-300"
                      >
                        <span className="font-mono text-blue-400">
                          {index + 1}. {entry.address.slice(0, 6)}...
                          {entry.address.slice(-4)}
                        </span>
                        <span className="font-semibold text-white">
                          {entry.score} pts
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </main>

        <footer className="p-4 text-center text-gray-500 text-sm bg-gray-800/20 backdrop-blur">
          Powered by Chainlink & Supabase
        </footer>
      </div>
    </ErrorBoundary>
  );
}
