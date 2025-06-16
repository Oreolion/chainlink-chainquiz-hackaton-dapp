"use client";

import React, {
  Component,
  useEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { useAccount } from "wagmi";
import { useChainQuiz } from "../src/hooks/useChainQuiz";
import { useQuizToken } from "../src/hooks/useQuizToken";
import axios from "axios";
import { supabase } from "../src/utils/supabaseClient";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { formatEther } from "viem";

// --- Define types for quiz questions and leaderboard entries ---
interface QuizQuestion {
  id: string;
  domain: string;
  text: string;
  options: string[];
  correctIndex: number;
}

interface LeaderboardEntry {
  address: string;
  score: number;
}

// Error Boundary Component
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
  // 1) Wallet & contract hooks
  const { address, isConnected } = useAccount();
  const quizContract = useChainQuiz();
  const tokenContract = useQuizToken();

  // 2) UI state hooks with explicit generics
  const [isMounted, setIsMounted] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>("");

  const [domains, setDomains] = useState<string[]>([]);
  const [selectedDomains, setSelectedDomains] = useState<string[]>([]);

  const [quizId, setQuizId] = useState<string>("");
  const [questions, setQuestions] = useState<QuizQuestion[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  // Timer for question
  const [timer, setTimer] = useState<number>(45);
  // States: idle, staking, inQuiz, awaitingAnswer
  type EntryState = "idle" | "staking" | "inQuiz" | "awaitingAnswer";
  const [entryState, setEntryState] = useState<EntryState>("idle");

  const [reward, setReward] = useState<string>("");
  const [balance, setBalance] = useState<string>("0");
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);

  // Ref for timer: in browser, setTimeout returns number
  const timerRef = useRef<number | null>(null);

  // 3) Fetch leaderboard from Supabase, typed
  const fetchLeaderboard = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("Quizzes")
        .select("player_address, correct_count")
        .not("completed_at", "is", null);

      if (error) throw error;
      // data: array of rows with player_address and correct_count
      const arr: LeaderboardEntry[] = data.map((row: any) => ({
        address: row.player_address,
        score: row.correct_count * 10,
      }));
      arr.sort((a, b) => b.score - a.score);
      console.log("Fetched leaderboard:", arr);
      setLeaderboard(arr.slice(0, 5));
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (err) {
      console.error("Supabase error in fetchLeaderboard:", err);
      setLeaderboard([]);
      setErrorMessage("Failed to load leaderboard.");
    }
  }, []);

  // 4) Event handlers with explicit types
  const eventHandlers = useMemo(
    () => ({
      onQuizGenerated: async (
        player: string,
        qId: string,
        numQuestions: number,
        log: any
      ) => {
        console.log("Event QuizGenerated fired. Args:", { player, qId, numQuestions, log });
        if (!address) {
          console.log("No address in context, ignoring QuizGenerated.");
          return;
        }
        if (player.toLowerCase() !== address.toLowerCase()) {
          console.log("QuizGenerated for different player, ignoring", player);
          return;
        }
        // Now quizId matches current user, fetch questions
        setQuizId(qId);
        setIsLoading(true);
        const apiUrl = process.env.NEXT_PUBLIC_ELIZAOS_URL || "http://localhost:5000";
        try {
          // **IMPORTANT**: if your architecture is that contract/Chainlink Function already inserted questions into Supabase under this quizId,
          // you should not re-call `/generateQuiz`. Instead directly fetch from Supabase. Adjust as per your design.
          console.log("Fetching questions from Supabase for quizId:", qId);
          const { data, error } = await supabase
            .from("Quizzes")
            .select("questions")
            .eq("quiz_id", qId)
            .single();

          if (error) throw error;
          console.log("Supabase returned questions:", data.questions);
          if (!data.questions || !Array.isArray(data.questions)) {
            throw new Error("Invalid questions format from Supabase");
          }
          // Type assertion: ensure each question matches QuizQuestion shape
          setQuestions(data.questions as QuizQuestion[]);
          setEntryState("inQuiz");
          setCurrentIndex(0);
          setTimer(45);
          setErrorMessage("");
        } catch (err: any) {
          console.error("Error in onQuizGenerated handling:", err.message || err, err.response?.data);
          setErrorMessage(`Failed to load quiz questions: ${err.response?.data?.error || err.message}`);
          setEntryState("idle");
        } finally {
          setIsLoading(false);
        }
      },

      onAnswerSubmitted: (
        player: string,
        isCorrect: boolean,
        questionIndex: number,
        log: any
      ) => {
        console.log("Event AnswerSubmitted fired. Args:", { player, isCorrect, questionIndex, log });
        if (!address) {
          console.log("No address in context, ignoring AnswerSubmitted.");
          return;
        }
        if (player.toLowerCase() !== address.toLowerCase() || quizId === "") {
          console.log("AnswerSubmitted: ignoring for player or missing quizId");
          return;
        }
        // Advance or reset timer
        if (isCorrect) {
          setCurrentIndex((i) => Math.min(i + 1, questions.length - 1));
        }
        setEntryState("inQuiz");
        setTimer(45);
      },

      onQuizCompleted: (player: string, correctCount: number, log: any) => {
        console.log("Event QuizCompleted fired. Args:", { player, correctCount, log });
        if (!address) {
          console.log("No address in context, ignoring QuizCompleted.");
          return;
        }
        if (player.toLowerCase() !== address.toLowerCase() || quizId === "") {
          console.log("QuizCompleted: ignoring for player or missing quizId");
          return;
        }
        setReward(correctCount.toString());
        setEntryState("awaitingAnswer");
        fetchLeaderboard();
      },

      onBonusAwarded: (player: string, bonus: bigint, log: any) => {
        console.log("Event BonusAwarded fired. Args:", { player, bonus, log });
        if (!address) {
          console.log("No address in context, ignoring BonusAwarded.");
          return;
        }
        if (player.toLowerCase() !== address.toLowerCase() || quizId === "") {
          console.log("BonusAwarded: ignoring for player or missing quizId");
          return;
        }
        setReward((r) => {
          const prev = parseInt(r || "0", 10);
          return (prev + Number(bonus)).toString();
        });
      },

      onLeaderboardRefreshed: (timestamp: bigint, log: any) => {
        console.log("Event LeaderboardRefreshed fired. Args:", { timestamp, log });
        fetchLeaderboard();
      },

      onQuizCancelled: (player: string, refund: bigint, log: any) => {
        console.log("Event QuizCancelled fired. Args:", { player, refund, log });
        if (!address) {
          console.log("No address in context, ignoring QuizCancelled.");
          return;
        }
        if (player.toLowerCase() !== address.toLowerCase() || quizId === "") {
          console.log("QuizCancelled: ignoring for player or missing quizId");
          return;
        }
        setEntryState("idle");
        setQuizId("");
        setQuestions([]);
        setCurrentIndex(0);
        setReward("");
      },
    }),
    [address, quizId, questions.length, fetchLeaderboard]
  );

  // 5) Subscribe to contract events
  useEffect(() => {
    if (!quizContract || !address || !tokenContract) {
      console.warn("Cannot subscribe: quizContract or address or tokenContract missing");
      return;
    }
    console.log("=== Subscribing to contract events ===");
    console.log("quizContract.watch keys:", Object.keys((quizContract.watch || {}) as any));

    const trySubscribe = (
      methodName: string,
      handler: (...args: any[]) => void
    ) => {
      const watchObj = quizContract.watch as any;
      const fn = watchObj[methodName];
      if (typeof fn !== "function") {
        console.warn(`quizContract.watch.${methodName} is NOT a function`);
        return null;
      }
      try {
        console.log(`Subscribing to ${methodName}...`);
        const unsub = fn(handler);
        console.log(`Subscribed to ${methodName}`);
        return unsub as () => void;
      } catch (err) {
        console.error(`Error subscribing to ${methodName}:`, err);
        return null;
      }
    };

    const unsubscribers: Array<() => void> = [];
    unsubscribers.push(
      trySubscribe("onQuizGenerated", eventHandlers.onQuizGenerated) || (() => {})
    );
    unsubscribers.push(
      trySubscribe("onAnswerSubmitted", eventHandlers.onAnswerSubmitted) || (() => {})
    );
    unsubscribers.push(
      trySubscribe("onQuizCompleted", eventHandlers.onQuizCompleted) || (() => {})
    );
    unsubscribers.push(
      trySubscribe("onBonusAwarded", eventHandlers.onBonusAwarded) || (() => {})
    );
    unsubscribers.push(
      trySubscribe("onLeaderboardRefreshed", eventHandlers.onLeaderboardRefreshed) ||
        (() => {})
    );
    unsubscribers.push(
      trySubscribe("onQuizCancelled", eventHandlers.onQuizCancelled) || (() => {})
    );

    return () => {
      console.log("=== Unsubscribing from contract events ===");
      unsubscribers.forEach((unsub) => {
        try {
          unsub();
        } catch (err) {
          console.error("Error during unsubscribe:", err);
        }
      });
    };
  }, [quizContract, address, tokenContract, eventHandlers]);

  // 6) Timer logic
  useEffect(() => {
    if (!["inQuiz", "awaitingAnswer"].includes(entryState)) return;
    if (timer <= 0) {
      console.log("Timer expired: auto-submitting/skipping");
      submitAnswer(255);
      return;
    }
    timerRef.current = window.setTimeout(() => setTimer((t) => t - 1), 1000);
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
    };
  }, [timer, entryState]);

  // 7) Handlers: startQuiz, submitAnswer, finishQuiz, etc.
  const startQuiz = useCallback(async () => {
    if (!quizContract || !tokenContract || selectedDomains.length < 5 || !address) {
      console.error("startQuiz: Invalid input", {
        selectedDomains,
        quizContract: !!quizContract,
        tokenContract: !!tokenContract,
        address,
        timestamp: new Date().toISOString(),
      });
      setErrorMessage("Select at least 5 domains and ensure wallet is connected.");
      return;
    }
    console.log("startQuiz: Initiating with domains", {
      domains: selectedDomains,
      playerAddress: address,
      timestamp: new Date().toISOString(),
    });
    setEntryState("staking");
    setIsLoading(true);
    try {
      const chainQuizAddress = process.env
        .NEXT_PUBLIC_CHAINQUIZ_ADDRESS as `0x${string}`;
      if (!chainQuizAddress) throw new Error("ChainQuiz contract address undefined");
      const entryFee = BigInt(
        process.env.NEXT_PUBLIC_ENTRY_FEE_IN_QUIZ || "10000000000000000000"
      );
      console.log("Approving tokens:", {
        chainQuizAddress,
        entryFee: entryFee.toString(),
        timestamp: new Date().toISOString(),
      });
      const approveTxHash = await tokenContract.write.approve([
        chainQuizAddress,
        entryFee,
      ]);
      console.log("Approve tx hash:", approveTxHash);
      console.log("Calling startQuiz on-chain with domains:", selectedDomains);
      const startQuizTxHash = await quizContract.write.startQuiz([
        selectedDomains,
      ]);
      console.log("startQuiz tx hash:", startQuizTxHash);
      // Rely on event subscription for QuizGenerated
    } catch (err: any) {
      console.error("startQuiz error:", {
        message: err.message,
        error: err,
        timestamp: new Date().toISOString(),
      });
      setErrorMessage(`Failed to start quiz: ${err.message}`);
      setEntryState("idle");
    } finally {
      setIsLoading(false);
    }
  }, [quizContract, tokenContract, selectedDomains, address]);

  const submitAnswer = useCallback(
    async (selectedIndex: number) => {
      if (!quizContract || !address || !quizId) {
        console.warn("submitAnswer: missing quizContract/address/quizId");
        return;
      }
      console.log("Submitting answer on-chain:", {
        quizId,
        questionIndex: currentIndex,
        selectedIndex,
        timestamp: new Date().toISOString(),
      });
      setEntryState("awaitingAnswer");
      setIsLoading(true);
      try {
        // First, backend verify (optional):
        const apiUrl = process.env.NEXT_PUBLIC_ELIZAOS_URL || "http://localhost:5000";
        console.log("Calling verifyAnswer backend:", `${apiUrl}/verifyAnswer`, {
          quizId,
          questionId: questions[currentIndex]?.id,
          selectedIndex,
        });
        const resp = await axios.post(`${apiUrl}/verifyAnswer`, {
          quizId,
          questionId: questions[currentIndex]?.id,
          selectedIndex,
        });
        console.log("VerifyAnswer API response:", resp.status, resp.data);
        if (!resp.data.isCorrect) {
          console.log("Answer incorrect per backend.");
          setErrorMessage("Incorrect answer. Try again!");
          setEntryState("inQuiz");
          setTimer(45);
          return;
        }
        // On-chain call
        const submitTxHash = await quizContract.write.submitAnswer(selectedIndex);
        console.log("submitAnswer tx hash:", submitTxHash);
        // Rely on event subscription (AnswerSubmitted)
      } catch (err: any) {
        console.error("submitAnswer error:", {
          message: err.message,
          error: err.response?.data || err,
          timestamp: new Date().toISOString(),
        });
        setErrorMessage(
          `Failed to submit answer: ${err.response?.data?.error || err.message}`
        );
        setEntryState("inQuiz");
        setTimer(45);
      } finally {
        setIsLoading(false);
      }
    },
    [quizContract, address, quizId, questions, currentIndex]
  );

  const finishQuiz = useCallback(async () => {
    if (!quizContract || !address) {
      console.warn("finishQuiz: missing quizContract or address");
      return;
    }
    console.log("Finishing quiz on-chain:", { quizId, timestamp: new Date().toISOString() });
    setEntryState("awaitingAnswer");
    setIsLoading(true);
    try {
      const finishTxHash = await quizContract.write.finishQuiz();
      console.log("finishQuiz tx hash:", finishTxHash);
      // Rely on event subscription (QuizCompleted)
    } catch (err: any) {
      console.error("finishQuiz error:", {
        message: err.message,
        error: err,
        timestamp: new Date().toISOString(),
      });
      setErrorMessage(`Failed to finish quiz: ${err.message}`);
      setEntryState("idle");
    } finally {
      setIsLoading(false);
    }
  }, [quizContract, address, quizId]);

  const requestChallenge = useCallback(async () => {
    if (!quizContract || !address) {
      console.warn("requestChallenge: missing quizContract or address");
      return;
    }
    console.log("Requesting random challenge on-chain:", { timestamp: new Date().toISOString() });
    setEntryState("awaitingAnswer");
    setIsLoading(true);
    try {
      const challengeTxHash = await quizContract.write.requestRandomChallenge();
      console.log("requestRandomChallenge tx hash:", challengeTxHash);
      // Rely on event subscription if relevant
    } catch (err: any) {
      console.error("requestChallenge error:", {
        message: err.message,
        error: err,
        timestamp: new Date().toISOString(),
      });
      setErrorMessage(`Failed to request challenge: ${err.message}`);
    } finally {
      setEntryState("idle");
      setIsLoading(false);
    }
  }, [quizContract, address]);

  const cancelQuiz = useCallback(async () => {
    if (!quizContract || !address) {
      console.warn("cancelQuiz: missing quizContract or address");
      return;
    }
    console.log("Cancelling quiz on-chain:", { quizId, timestamp: new Date().toISOString() });
    setEntryState("awaitingAnswer");
    setIsLoading(true);
    try {
      const cancelTxHash = await quizContract.write.cancelQuiz();
      console.log("cancelQuiz tx hash:", cancelTxHash);
      // Rely on event subscription (QuizCancelled)
    } catch (err: any) {
      console.error("cancelQuiz error:", {
        message: err.message,
        error: err,
        timestamp: new Date().toISOString(),
      });
      setErrorMessage(`Failed to cancel quiz: ${err.message}`);
      setEntryState("idle");
    } finally {
      setIsLoading(false);
    }
  }, [quizContract, address, quizId]);

  // 8) Effects: mount, domains, balance, leaderboard
  useEffect(() => {
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
    ]);
  }, []);

  useEffect(() => {
    const fetchBalance = async () => {
      if (!address || !tokenContract) return;
      try {
        const bal = await tokenContract.read.balanceOf(address);
        setBalance(formatEther(bal));
      } catch (err) {
        console.error("Error fetching balance:", err);
        setBalance("0");
      }
    };
    fetchBalance();
  }, [address, tokenContract]);

  useEffect(() => {
    fetchLeaderboard();
    const interval = setInterval(fetchLeaderboard, 60_000);
    return () => clearInterval(interval);
  }, [fetchLeaderboard]);

  // 9) Early returns
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
  if (!quizContract || !tokenContract || !address) {
    return (
      <div className="min-h-screen flex flex-col bg-gray-900 text-gray-100">
        <header className="flex justify-between items-center p-6 bg-gray-800/70 backdrop-blur-sm">
          <h1 className="text-3xl font-bold text-blue-400">ChainQuiz</h1>
          <ConnectButton showBalance={false} />
        </header>
        <main className="flex-1 p-6">
          <p className="text-center text-red-400">
            Error: Contract addresses, RPC URL, or wallet connection not configured.
            Check NEXT_PUBLIC_CHAINQUIZ_ADDRESS and NEXT_PUBLIC_BASE_RPC_URL, or connect your wallet.
          </p>
        </main>
      </div>
    );
  }

  // 10) Main UI render
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
          {isConnected && (
            <div className="flex justify-end gap-4">
              <p className="text-sm text-gray-400 truncate max-w-[12rem]">{address}</p>
              <p className="text-sm text-blue-400">{balance} QUIZ</p>
            </div>
          )}

          {/* Domain Selection & Start Quiz */}
          {isConnected && entryState === "idle" && (
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
                    : `Start Quiz (${selectedDomains.length} Domains, ${
                        questions.length || 10
                      } Questions)`}
                </span>
              </button>
            </div>
          )}

          {/* Quiz Questions */}
          {isConnected && entryState === "inQuiz" && questions.length > 0 && (
            <div className="p-6 bg-gray-800/80 rounded-2xl shadow-md space-y-4">
              <h2 className="text-xl font-semibold text-gray-100">
                Question {currentIndex + 1}/{questions.length}
              </h2>
              <p className="text-base text-gray-200">
                {questions[currentIndex]?.text || "Loading..."}
              </p>
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

          {/* Finish Quiz */}
          {isConnected && entryState === "awaitingAnswer" && (
            <div className="p-6 bg-gray-800/80 rounded-2xl shadow-md space-y-4 text-center">
              <h2 className="text-xl font-semibold text-gray-100">All questions answered!</h2>
              <button
                onClick={finishQuiz}
                disabled={isLoading}
                className="mt-2 w-full p-3 bg-blue-500 hover:bg-blue-600 rounded-xl text-lg font-semibold text-white disabled:bg-gray-600 disabled:cursor-not-allowed relative"
              >
                {isLoading && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                  </div>
                )}
                <span className={isLoading ? "opacity-0" : ""}>
                  {reward === "" ? "Finish Quiz" : `You earned ${reward} QUIZ`}
                </span>
              </button>
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
