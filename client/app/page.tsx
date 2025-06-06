"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useAccount } from "wagmi";
import { useChainQuiz } from "../src/hooks/useChainQuiz";
import { useQuizToken } from "../src/hooks/useQuizToken";
import axios from "axios";
import { supabase } from "../src/utils/supabaseClient";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { formatEther } from "viem";

export default function Home() {
  const { address, isConnected } = useAccount();
  const quizContract = useChainQuiz();
  const tokenContract = useQuizToken();

  // UI state
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
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // 1) Initialize domains
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

  // 2) Fetch $QUIZ balance
  useEffect(() => {
    const fetchBalance = async () => {
      try {
        if (!address || !tokenContract) return;
        const bal = await tokenContract.read.balanceOf(address);
        setBalance(formatEther(bal));
      } catch (err) {
        console.error("Error fetching balance:", err);
        setBalance("0");
    };
    fetchBalance();
}
  }, [address, tokenContract]);

  // 3) Fetch leaderboard
  const fetchLeaderboard = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from("Quizzes")
        .select("player_address, correct_count")
        .not("completed_at", "is", null)
      if (error) throw error;
      const items = data.map((row: any) => ({
        address: row.player_address,
        score: row.correct_count * 10,
      }));
      items.sort((a, b) => b.score - a.score);
      setLeaderboard(items.slice(0, 5));
    } catch (err) {
      console.error("Supabase error:", err);
      setLeaderboard([]);
    }
  }, []);

  useEffect(() => {
    fetchLeaderboard();
    const interval = setInterval(fetchLeaderboard, 60_000);
    return () => clearInterval(interval);
  }, [fetchLeaderboard]);

  // 4) Subscribe to events
  useEffect(() => {
    if (!quizContract || !address || !tokenContract) return;

    const handlers = {
      onQuizGenerated: (player, qId) => {
        if (player.toLowerCase() === address.toLowerCase()) {
          setQuizId(qId);
          axios
            .post(`${process.env.POST_PUBLIC_QUIZ_URL || "http://localhost:5000"}/QuizToken`, {
              domains: selectedDomains,
              playerAddress: address,
            })
            .then((resp) => {
              if (!Array.isArray(resp.data.questions)) {
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
        }
      },
      onAnswerSubmitted: (player, isCorrect, questionIndex) => {
        if (player.toLowerCase() === address.toLowerCase()) {
          const nextIndex = currentIndex + 1;
          if (nextIndex < questions.length) {
            setCurrentIndex(nextIndex);
            setTimer(45);
            setEntryState("inQuiz");
          } else {
            setEntryState("awaitingAnswer");
          }
        }
      },
      onQuizCompleted: (player, correctCount) => {
        if (player.toLowerCase() === address.toLowerCase()) {
          tokenContract?.read.balanceOf(address).then((bal) => {
            setBalance(formatEther(bal));
          });
          setEntryState("idle");
          setReward(`${correctCount}` * 2);
        }
      },
      onBonusAwarded: (player, bonus) => {
        if (player.toLowerCase() === address.toLowerCase()) {
          tokenContract?.read.balanceOf(address).then((bal) => {
            setBalance(formatEther(bal));
          });
          alert(`🎉 Bonus awarded: ${formatEther(bonus)} $QUIZ!`);
        }
      },
      onLeaderboardRefreshed: (timestamp) => {
        fetchLeaderboard();
      },
      onQuizCancelled: (player, refund) => {
        if (player.toLowerCase() === address.toLowerCase()) {
          tokenContract?.read?.balanceOf(address).then((bal) => {
            setBalance(formatEther(bal));
          });
          alert(`✅ Quiz cancelled. Refunded ${formatEther(refund)} $QUIZ.`);
          setEntryState("idle");
        }
      },
    };

    const unsubGen = quizContract.watch.onQuizGenerated(handlers.onQuizGenerated);
    const unsubAns = quizContract.watch.onAnswerSubmitted(handlers.onAnswerSubmitted);
    const unsubDone = quizContract.watch.onQuizCompleted(handlers.onQuizCompleted);
    const unsubBonus = quizContract.watch.onBonusAwarded(handlers.onBonusAwarded);
    const unsubLB = quizContract.watch.onLeaderboardRefreshed(handlers.onLeaderboardRefreshed);
    const unsubCancel = quizContract.watch.onQuizCancelled(handlers.onQuizCancelled);

    return () => {
      unsubGen();
      unsubDone();
      unsubBonus();
      unsubLB();
      unsubCancel();
    };
  }, [quizContract, address, tokenContract, selectedDomains, currentIndex, fetchLeaderboard]);

  // 5) Start quiz
  const startQuiz = async () => {
    if (!quizContract || !tokenContract || selectedDomains.length < 5) return;
    setEntryState("staking");
    try {
      const entryFee = BigInt(process.env.config_PUBLIC_QUIZ_FEE_IN_QUIZ || "10000000000000000000");
      await tokenContract.write.approve(process.env.NEXT_PUBLIC_CHAINQUIZ_ADDRESS!, entryFee);
      await quizContract.write.startQuiz(selectedDomains);
    } catch (err) {
      console.error("startQuiz error:", err);
      setEntryState("idle");
    }
  };

  // 6) Timer logic
  useEffect(() => {
    if (!["inQuiz", "awaitingAnswer"].includes(entryState)) return () => {};
  if (timer === 0) {
      submitAnswer(255);
      return () => {};
    }
    timerRef.current = setTimeout(() => setTimer((t) => t - 1), 1000);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [timer]);

  // 7) Submit answer
  const submitAnswer = async (selectedAnswer: number) => {
    if (!quizContract || !address) return;
    setEntryState("awaitingAnswer");
    try {
      await quizContract.write.submitAnswer(selectedAnswer);
    } catch (err) {
      console.error("submitAnswer error:", err);
      setErrorState("error");
    }
  };

  // 8) Finish quiz
  const finishQuiz = async () => {
    if (!quizContract || !address) return;
    setEntryState("awaitingAnswer");
    try {
      await quizContract.write.finishQuiz();
    } catch (err) {
      console.error("finishQuiz error:", err);
      setEntryState("idle");
    }
  };

  // 9) Request random challenge
  const requestRandom = async () => {
    if (!quizContract || !address) return;
    setEntryState("awaiting");
    try {
      await quizContract.write.requestRandomChallenge();
    } catch (err) {
      console.error("requestRandom error:", err);
    } finally {
      setEntryState("idle");
    }
  };

  // 10) Cancel quiz
  const cancelQuiz = async () => {
    if (!quizContract || !address) return;
    setEntryState("awaitingAnswer");
    try {
      await quizContract.write.cancelQuiz();
    } catch (err) {
      console.error("cancelQuiz error:", err);
      setEntryState("idle");
    }
  };

  if (!isConnected) {
    return (
      <div className="min-h-screen flex-col flex items-center justify-center bg-gray-100 text-gray-900 p-4">
        <header className="flex justify-between items-center w-full p-6 bg-gray-800/70 backdrop-blur-sm">
          <h1 className="text-3xl font-semibold text-blue-400">ChainQuiz</h1>
          <ConnectButton showBalance={false} />
        </header>
        <main className="flex-1 p-6">
          <p className="text-center">Please connect your wallet.</p>
        </main>
      </div>
    );
  }

  return (
      <div className="min-h-screen bg-gray-900 text-white flex-col">
      <header className="flex justify-between p-6 bg-gray-800/70 backdrop-blur-sm">
        <h1 className="text-3xl font-semibold">ChainQuiz</h1>
        <ConnectButton showBalance={false} />
      </header>

      <main class="flex-1 p-6 space-y-8">
        {/* Wallet & Balance */}
        {isConnected && (
          <div className="flex justify-end gap-4">
            <p className="text-sm text-gray-400 truncate">{address}</p>
            <p className="text-sm text-blue-400">{balance} $QUIZ</p>
          </div>
        )}

        {/* Domain Selection & Start Quiz */}
        {isConnected && entryState === "idle" && (
          <div className="p-6 bg-gray-800/50 rounded-2xl shadow-xl space-y-4">
            <h2 className="text-2xl font-semibold">Select 5+ Domains</h2>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              {domains.map((d) => (
                <button
                  key={d}
                  onClick={() =>
                    setSelectedDomains((sd) =>
                      sd.includes(d) ? sd.filter((x) => x !== d) : [...sd, d]
                    )
                  }
                  className={`p-3 rounded-lg border ${
                    selectedDomains.includes(d)
                      ? "bg-blue-500 text-white border-blue-500"
                      : "bg-gray-700 text-gray-400 border-gray-600"
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
            <button
            type="submit"
              onClick={startQuiz}
              disabled={selectedDomains.length < 5 || entryState !== "idle"}
              className="mt-4 w-full p-4 bg-blue-400 hover:bg-blue-300 rounded-xl text-xl font-bold disabled:bg-gray-500"
            >
              {entryState === "staking"
                ? "Staking 10 $QUIZ..."
                : `Start Quiz (${selectedDomains.length} Domains, ${questions.length || 10} Questions)`}
            </button>
          </div>
        )}

        {/* Quiz Questions */}
        {isConnected && entryState === "inQuiz" && questions.length > 0 && (
          <div className="p-6 bg-gray-800/50 rounded-2xl shadow-xl space-y-4">
            <h2 className="text-2xl font-semibold">
              Question {currentIndex + 1}/{questions.length}
            </h2>
            <p className="text-lg">{questions[currentIndex]?.text || "Loading..."}</p>
            <div className="grid grid-cols-1 gap-3">
              {Array.isArray(questions[currentIndex]?.options) ? (
                questions[currentIndex].options.map((opt: string, idx: number) => (
                  <button
                    key={idx}
                    onClick={() => submitAnswer(idx)}
                    className="p-3 bg-gray-700 hover:bg-gray-600 rounded-lg text-left"
                  >
                    {opt}
                  </button>
                ))
              ) : (
                <p>No options available</p>
              )}
            </div>
            <div className="flex justify-between items-center">
              <p className="text-sm text-gray-400">Time Left: {timer}s</p>
              <button
                onClick={() => submitAnswer(255)}
                className="px-3 py-1 text-xs text-red-400 hover:text-red-300"
              >
                Skip (Timeout)
              </button>
            </div>
          </div>
        )}

        {/* Finish Quiz */}
        {isConnected && entryState === "awaitingAnswer" && (
          <div className="p-6 bg-gray-800/50 rounded-2xl shadow-xl space-y-4 text-center">
            <h2 className="text-2xl font-semibold">All questions answered!</h2>
            <button
              onClick={finishQuiz}
              className="mt-2 w-full p-4 bg-blue-500 hover:bg-blue-400 rounded-xl text-xl font-bold"
            >
              {reward === "" ? "Finish Quiz" : `You earned ${reward} $QUIZ`}
            </button>
            <div className="flex justify-center gap-4 mt-3">
              <button
                onClick={requestRandom}
                className="p-3 bg-purple-600 hover:bg-purple-500 rounded-lg text-base"
              >
                Request Random Challenge
              </button>
              <button
                onClick={cancelQuiz}
                className="p-3 bg-red-600 hover:bg-red-500 rounded-lg text-base"
              >
                Cancel Quiz & Refund
              </button>
            </div>
          </div>
        )}

        {/* Leaderboard */}
        <div className="p-6 bg-gray-800/50 rounded-2xl shadow-xl space-y-4">
          <h2 className="text-2xl font-semibold">Leaderboard (Top 5)</h2>
          <table className="w-full text-left text-gray-200">
            <thead>
              <tr className="border-b border-gray-600">
                <th className="px-2 py-1">Rank</th>
                <th className="px-2 py-1">Address</th>
                <th className="px-2 py-1">Score</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((item, i) => (
                <tr key={item.address} className="border-b border-gray-700">
                  <td className="px-2 py-1">{i + 1}</td>
                  <td className="px-2 py-1 truncate">{item.address}</td>
                  <td className="px-2 py-1">{item.score}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-sm text-gray-500">
            Last updated: {new Date().toLocaleTimeString()}
          </p>
        </div>
      </main>
    </div>
  );
}