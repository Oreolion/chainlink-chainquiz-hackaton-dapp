"use client";

import { Component, useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useAccount } from "wagmi";
import { useQuizToken } from "../../client/src/hooks/useQuizToken";
import { useChainQuiz } from "../../client/src/hooks/useChainQuiz";
import axios from "axios";
import { supabase } from "../../client/src/utils/supabaseClient";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { formatEther } from "viem";

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
        <div className="min-h-screen flex flex-col bg-gray-100 text-gray-800">
          <header className="flex justify-between items-center p-6 bg-gray-800/70 backdrop-blur-sm">
            <h1 className="text-3xl font-bold text-blue-500">ChainQuiz</h1>
            <ConnectButton showBalance={false} />
          </header>
          <main className="flex-1 p-6">
            <div className="text-center text-red-500">
              <p>Something went wrong: {this.state.error?.message || "Unknown error"}</p>
              <button
                onClick={() => this.setState({ hasError: false, error: null })}
                className="mt-4 px-4 py-2 bg-blue-500 hover:bg-blue-400 rounded-lg"
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
  // Initial hooks (always called)
  const { address, isConnected } = useAccount();
  const quizContract = useChainQuiz();
  const tokenContract = useQuizToken();

  // State hooks (always called)
  const [isMounted, setIsMounted] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [domains, setDomains] = useState<string[]>([]);
  const [selectedDomains, setSelectedDomains] = useState<string[]>([]);
  const [quizId, setQuizId] = useState<string>("");
  const [questions, setQuestions] = useState<any[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [timer, setTimer] = useState<number>(45);
  const [entryState, setEntryState] = useState<"idle" | "staking" | "inQuiz" | "awaitingAnswer">("idle");
  const [reward, setReward] = useState<string>("");
  const [balance, setBalance] = useState<string>("0");
  const [leaderboard, setLeaderboard] = useState<{ address: string; score: number }[]>([]);

  // Ref hooks (always called)
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Callback hooks (always called, moved before useMemo)
  const fetchLeaderboard = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("Quizzes")
        .select("player_address, correct_count")
        .not("completed_at", "is", null);
      if (error) throw error;
      const arr = data.map((row: any) => ({
        address: row.player_address,
        score: row.correct_count * 10,
      }));
      arr.sort((a, b) => b.score - a.score);
      setLeaderboard(arr.slice(0, 5));
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (err) {
      console.error("Supabase error:", err);
      setLeaderboard([]);
    }
  }, []);

  // Memoized handlers to optimize event subscriptions
  const eventHandlers = useMemo(
    () => ({
      onQuizGenerated: (player: string, qId: string, numQ: number) => {
        if (player.toLowerCase() !== address?.toLowerCase()) return;
        setQuizId(qId);
        axios
          .post(
            `${process.env.NEXT_PUBLIC_ELIZAOS_URL || "http://localhost:5000"}/generateQuiz`,
            { domains: selectedDomains, playerAddress: address }
          )
          .then((resp) => {
            if (!resp.data || !Array.isArray(resp.data.questions)) {
              console.error("Invalid questions format:", resp.data);
              setQuestions([]);
              setEntryState("idle");
              return;
            }
            setQuestions(resp.data.questions);
            setEntryState("inQuiz");
            setTimer(45);
          })
          .catch((err) => {
            console.error("Error fetching questions:", err);
            setQuestions([]);
            setEntryState("idle");
          });
      },
      onAnswerSubmitted: (player: string, isCorrect: boolean, questionIndex: number) => {
        if (player.toLowerCase() !== address?.toLowerCase()) return;
        const nextIndex = currentIndex + 1;
        if (nextIndex < questions.length) {
          setCurrentIndex(nextIndex);
          setTimer(45);
          setEntryState("inQuiz");
        } else {
          setEntryState("awaitingAnswer");
        }
      },
      onQuizCompleted: (player: string, correctCount: number) => {
        if (player.toLowerCase() !== address?.toLowerCase()) return;
        tokenContract?.read
          .balanceOf(address!)
          .then((bal) => setBalance(formatEther(bal)))
          .catch((err) => console.error("Balance update error:", err));
        setEntryState("idle");
        setReward(`${correctCount * 2}`);
      },
      onBonusAwarded: (player: string, bonus: bigint) => {
        if (player.toLowerCase() !== address?.toLowerCase()) return;
        tokenContract?.read
          .balanceOf(address!)
          .then((bal) => setBalance(formatEther(bal)))
          .catch((err) => console.error("Balance update error:", err));
        alert(`🎉 Bonus awarded: ${formatEther(bonus)} $QUIZ!`);
      },
      onLeaderboardRefreshed: (timestamp: bigint) => {
        fetchLeaderboard();
      },
      onQuizCancelled: (player: string, refund: bigint) => {
        if (player.toLowerCase() !== address?.toLowerCase()) return;
        tokenContract?.read
          .balanceOf(address!)
          .then((bal) => setBalance(formatEther(bal)))
          .catch((err) => console.error("Balance update error:", err));
        alert(`✅ Quiz cancelled. Refunded ${formatEther(refund)} $QUIZ.`);
        setEntryState("idle");
      },
    }),
    [address, selectedDomains, currentIndex, questions.length, tokenContract, fetchLeaderboard]
  );

  // Other callback hooks (always called)
  const startQuiz = useCallback(async () => {
    if (!quizContract || !tokenContract || selectedDomains.length < 5) return;
    setEntryState("staking");
    setIsLoading(true);
    try {
      const chainQuizAddress = process.env.NEXT_PUBLIC_CHAINQUIZ_ADDRESS as `0x${string}`;
      if (!chainQuizAddress) throw new Error("ChainQuiz contract address is not defined");
      const entryFee = BigInt(process.env.NEXT_PUBLIC_ENTRY_FEE_IN_QUIZ || "10000000000000000000");
      await tokenContract.write.approve([chainQuizAddress, entryFee]);
      await quizContract.write.startQuiz(selectedDomains);
    } catch (err) {
      console.error("startQuiz error:", err);
      setEntryState("idle");
    } finally {
      setIsLoading(false);
    }
  }, [quizContract, tokenContract, selectedDomains]);

  const submitAnswer = useCallback(
    async (selectedIndex: number) => {
      if (!quizContract || !address) return;
      setEntryState("awaitingAnswer");
      setIsLoading(true);
      try {
        await quizContract.write.submitAnswer(selectedIndex);
      } catch (err) {
        console.error("submitAnswer error:", err);
        setEntryState("inQuiz");
        setTimer(45); // Reset timer on error
      } finally {
        setIsLoading(false);
      }
    },
    [quizContract, address]
  );

  const finishQuiz = useCallback(async () => {
    if (!quizContract || !address) return;
    setEntryState("awaitingAnswer");
    setIsLoading(true);
    try {
      await quizContract.write.finishQuiz();
    } catch (err) {
      console.error("finishQuiz error:", err);
      setEntryState("idle");
    } finally {
      setIsLoading(false);
    }
  }, [quizContract, address]);

  const requestChallenge = useCallback(async () => {
    if (!quizContract || !address) return;
    setEntryState("awaitingAnswer");
    setIsLoading(true);
    try {
      await quizContract.write.requestRandomChallenge();
    } catch (err) {
      console.error("requestChallenge error:", err);
    } finally {
      setEntryState("idle");
      setIsLoading(false);
    }
  }, [quizContract, address]);

  const cancelQuiz = useCallback(async () => {
    if (!quizContract || !address) return;
    setEntryState("awaitingAnswer");
    setIsLoading(true);
    try {
      await quizContract.write.cancelQuiz();
    } catch (err) {
      console.error("cancelQuiz error:", err);
      setEntryState("idle");
    } finally {
      setIsLoading(false);
    }
  }, [quizContract, address]);

  // Effect hooks (always called)
  useEffect(() => {
    setIsMounted(true);
    setLastUpdated(new Date().toLocaleTimeString());
  }, []);

  useEffect(() => {
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

  useEffect(() => {
    if (!quizContract || !address || !tokenContract) return;

    let unsubGen, unsubAns, unsubDone, unsubBonus, unsubLB, unsubCancel;
    try {
      unsubGen = quizContract.watch.onQuizGenerated(eventHandlers.onQuizGenerated);
      unsubAns = quizContract.watch.onAnswerSubmitted(eventHandlers.onAnswerSubmitted);
      unsubDone = quizContract.watch.onQuizCompleted(eventHandlers.onQuizCompleted);
      unsubBonus = quizContract.watch.onBonusAwarded(eventHandlers.onBonusAwarded);
      unsubLB = quizContract.watch.onLeaderboardRefreshed(eventHandlers.onLeaderboardRefreshed);
      unsubCancel = quizContract.watch.onQuizCancelled(eventHandlers.onQuizCancelled);
    } catch (err) {
      console.error("Error subscribing to events:", err);
    }

    return () => {
      try {
        unsubGen?.();
        unsubAns?.();
        unsubDone?.();
        unsubBonus?.();
        unsubLB?.();
        unsubCancel?.();
      } catch (err) {
        console.error("Error unsubscribing from events:", err);
      }
    };
  }, [quizContract, address, tokenContract, eventHandlers]);

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

  // Add any new useEffect hooks here to maintain hook order
  // Example: useEffect(() => { /* your new logic */ }, [dependencies]);

  // Early returns after all hooks
  if (!isMounted) {
    return (
      <div className="min-h-screen flex flex-col bg-gray-100 text-gray-800">
        <header className="flex justify-between items-center p-6 bg-gray-800/70 backdrop-blur-sm">
          <h1 className="text-3xl font-bold text-blue-500">ChainQuiz</h1>
          <ConnectButton showBalance={false} />
        </header>
        <main className="flex-1 p-6">
          <div className="flex items-center justify-center min-h-screen">
            <div className="text-center">
              <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500 mb-4"></div>
              <p className="text-gray-600 text-sm">Loading...</p>
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (!quizContract || !tokenContract || !address) {
    return (
      <div className="min-h-screen flex flex-col bg-gray-100 text-gray-800">
        <header className="flex justify-between items-center p-6 bg-gray-800/70 backdrop-blur-sm">
          <h1 className="text-3xl font-bold text-blue-500">ChainQuiz</h1>
          <ConnectButton showBalance={false} />
        </header>
        <main className="flex-1 p-6">
          <p className="text-center text-red-600">
            Error: Contract addresses, RPC URL, or wallet connection not configured. Check
            NEXT_PUBLIC_PROPERTIES in .env.local, or connect your wallet.
          </p>
        </main>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen flex flex-col bg-gray-100 text-gray-800">
        <header className="flex justify-between items-center p-5 bg-gray-50/60 backdrop-blur-sm">
          <h1 className="text-3xl font-bold text-blue-600">Chain Quiz</h1>
          <ConnectButton showBalance={false} />
        </header>

        <main className="flex-1 p-6 space-y-6">
          {/* Wallet & Balance */}
          {isConnected && (
            <div className="flex justify-end gap-4">
              <p className="text-sm text-gray-500 truncate max-w-[12rem]">{address}</p>
              <p className="text-sm text-blue-500">{balance} $QUIZ</p>
            </div>
          )}

          {/* Domain Selection & Start Quiz */}
          {isConnected && entryState === "idle" && (
            <div className="p-6 bg-white/80 rounded-2xl shadow-md space-y-4">
              <h2 className="text-xl font-semibold text-gray-800">Select 5+ Domains</h2>
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
                        : "bg-gray-100 text-gray-700 border-gray-300 hover:bg-gray-200"
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
              <button
                onClick={startQuiz}
                disabled={selectedDomains.length < 5 || entryState !== "idle" || isLoading}
                className="mt-4 w-full p-3 bg-blue-500 hover:bg-blue-600 rounded-xl text-lg font-semibold text-white disabled:bg-gray-400 disabled:cursor-not-allowed relative"
              >
                {isLoading && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                  </div>
                )}
                <span className={isLoading ? "opacity-0" : ""}>
                  {entryState === "staking"
                    ? "Staking 10 $QUIZ..."
                    : `Start Quiz (${selectedDomains.length} Domains, ${questions.length || 10} Questions)`}
                </span>
              </button>
            </div>
          )}

          {/* Quiz Questions */}
          {isConnected && entryState === "inQuiz" && questions.length > 0 && (
            <div className="p-6 bg-white/80 rounded-2xl shadow-md space-y-4">
              <h2 className="text-xl font-semibold text-gray-800">
                Question {currentIndex + 1}/{questions.length}
              </h2>
              <p className="text-base text-gray-700">{questions[currentIndex]?.text || "Loading..."}</p>
              <div className="grid grid-cols-1 gap-2">
                {Array.isArray(questions[currentIndex]?.options) ? (
                  questions[currentIndex].options.map((opt: string, idx: number) => (
                    <button
                      key={idx}
                      onClick={() => submitAnswer(idx)}
                      disabled={isLoading}
                      className="p-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-left text-sm text-gray-700 disabled:opacity-50 disabled:cursor-not-allowed relative"
                    >
                      {isLoading && (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600"></div>
                        </div>
                      )}
                      <span className={isLoading ? "opacity-0" : ""}>{opt}</span>
                    </button>
                  ))
                ) : (
                  <p className="text-sm text-red-500">No options available</p>
                )}
              </div>
              <div className="flex justify-between items-center">
                <p className="text-sm text-gray-500">Time Left: {timer}s</p>
                <button
                  onClick={() => submitAnswer(255)}
                  className="px-2 py-1 text-xs text-blue-500 hover:text-blue-600"
                >
                  Skip (Timeout)
                </button>
              </div>
            </div>
          )}

          {/* Finish Quiz */}
          {isConnected && entryState === "awaitingAnswer" && (
            <div className="p-6 bg-white/80 rounded-2xl shadow-md space-y-4 text-center">
              <h2 className="text-xl font-semibold text-gray-800">All questions answered!</h2>
              <button
                onClick={finishQuiz}
                disabled={isLoading}
                className="mt-2 w-full p-3 bg-blue-500 hover:bg-blue-600 rounded-xl text-lg font-semibold text-white disabled:bg-gray-400 disabled:cursor-not-allowed relative"
              >
                {isLoading && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                  </div>
                )}
                <span className={isLoading ? "opacity-0" : ""}>
                  {reward === "" ? "Finish Quiz" : `You earned ${reward} $QUIZ`}
                </span>
              </button>
              <div className="flex justify-center gap-3 mt-3">
                <button
                  onClick={requestChallenge}
                  disabled={isLoading}
                  className="p-2 bg-purple-500 hover:bg-purple-600 rounded-lg text-sm text-white disabled:bg-gray-400 disabled:cursor-not-allowed relative"
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
                  className="p-2 bg-red-500 hover:bg-red-600 rounded-lg text-sm text-white disabled:bg-gray-400 disabled:cursor-not-allowed relative"
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
          <div className="p-6 bg-white/80 rounded-2xl shadow-md space-y-4">
            <h2 className="text-xl font-semibold text-gray-800">Leaderboard (Top 5)</h2>
            <table className="w-full text-left text-gray-700 text-sm">
              <thead>
                <tr className="border-b border-gray-300">
                  <th className="px-2 py-1">Rank</th>
                  <th className="px-2 py-1">Address</th>
                  <th className="px-2 py-1">Score</th>
                </tr>
              </thead>
              <tbody>
                {leaderboard.map((row, i) => (
                  <tr key={row.address} className="border-b border-gray-200">
                    <td className="px-2 py-1">{i + 1}</td>
                    <td className="px-2 py-1 truncate max-w-[150px]">{row.address}</td>
                    <td className="px-2 py-1">{row.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-gray-500">Last updated: {lastUpdated}</p>
          </div>
        </main>
      </div>
    </ErrorBoundary>
  );
}