/**
 * eliza-server.js
 *
 * A minimal Express server that exposes `/generateQuiz` and `/verifyAnswer`
 * for Chainlink Functions. It uses OpenAI to generate questions and Supabase
 * to store and verify quiz data.
 *
 * Ensure `.env` contains:
 *   ELIZAOS_PORT=5000
 *   SUPABASE_URL=https://<YOUR>.supabase.co
 *   SUPABASE_ANON_KEY=<anon-key>
 *   OPENAI_API_KEY=<your openai key>
 */

import dotenv from "dotenv";
dotenv.config();
import express from "express";
import bodyParser from "body-parser";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

// 1) Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 2) Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
app.use(bodyParser.json());

/**
 * Helper: call OpenAI to generate 10 questions given domains.
 * Each question: { id: "q1", domain: string, text: string,
 *                  options: [opt1,opt2,opt3], correctIndex: 0..2 }
 */
async function generateQuestions(domains) {
  const systemPrompt = `
You are an assistant that produces multiple-choice questions about crypto/web3.
You will receive a JSON array of domains. Return EXACTLY 10 questions in JSON:
[
  {
    "id": "q1",
    "domain": "<one of the domains>",
    "text": "<question text>",
    "options": ["<opt0>", "<opt1>", "<opt2>"],
    "correctIndex": <0|1|2>
  },
  ... (q2..q10)
]
Ensure valid JSON, no extra commentary.
`;

  const userPrompt = `
Generate 10 multiple-choice questions focused on these domains:
${JSON.stringify(domains)}
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.7,
    max_tokens: 1200,
  });

  const text = completion.choices[0].message.content;
  let questions;
  try {
    questions = JSON.parse(text);
  } catch (err) {
    console.error("LLM JSON parse error:", text);
    throw new Error("Failed to parse LLM output as JSON");
  }

  if (!Array.isArray(questions) || questions.length !== 10) {
    throw new Error("LLM did not return exactly 10 questions");
  }
  for (const q of questions) {
    if (
      typeof q.id !== "string" ||
      typeof q.domain !== "string" ||
      typeof q.text !== "string" ||
      !Array.isArray(q.options) ||
      q.options.length !== 3 ||
      typeof q.correctIndex !== "number"
    ) {
      throw new Error("Invalid question format from LLM");
    }
  }
  return questions;
}

// ----------
// /generateQuiz
// ----------
app.post("/generateQuiz", async (req, res) => {
  try {
    const { domains, playerAddress } = req.body;
    if (
      !Array.isArray(domains) ||
      domains.length < 5 ||
      typeof playerAddress !== "string"
    ) {
      return res
        .status(400)
        .json({
          error: "Invalid input: 5+ domains and playerAddress required",
        });
    }
    console.log("generateQuiz: Processing", { domains, playerAddress }); // Log input
    const questions = await generateQuestions(domains);
    const quizId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const { data, error: supaErr } = await supabase
      .from("Quizzes")
      .insert([
        {
          quiz_id: quizId,
          player_address: playerAddress.toLowerCase(), // Normalize address
          questions,
          started_at: new Date().toISOString(),
          correct_count: 0,
          completed_at: null,
        },
      ])
      .select("quiz_id, num_questions"); // Return inserted data
    if (supaErr) throw supaErr;
    console.log("Supabase insert success:", data);
    res.json({ quizId, numQuestions: 10 });
  } catch (error) {
    console.error("/generateQuiz error:", error.message, error);
    res.status(500).json({ error: error.message });
  }
});

// ----------
// /verifyAnswer
// ----------
app.post("/verifyAnswer", async (req, res) => {
  try {
    const { quizId, questionId, selectedIndex } = req.body;
    if (typeof quizId !== "string" || typeof questionId !== "string") {
      return res.status(400).json({ error: "quizId & questionId required" });
    }

    // 1) Fetch from Supabase
    const { data, error } = await supabase
      .from("Quizzes")
      .select("questions, correct_count, numQuestions, completed_at")
      .eq("quiz_id", quizId)
      .single();
    if (error) throw error;

    // 2) Find question
    const questions = data.questions;
    const q = questions.find((qq) => qq.id === questionId);
    if (!q) return res.status(404).json({ error: "Question not found" });

    const isCorrect = Number(selectedIndex) === q.correctIndex;
    let newCorrect = data.correct_count;
    let newCompletedAt = data.completed_at;

    if (isCorrect) {
      newCorrect++;
      const idxNum = parseInt(questionId.slice(1)); // "q7" → 7
      if (idxNum === questions.length) {
        newCompletedAt = new Date().toISOString();
      }
    }

    // 3) Update
    const { error: updErr } = await supabase
      .from("Quizzes")
      .update({
        correct_count: newCorrect,
        completed_at: newCompletedAt,
      })
      .eq("quiz_id", quizId);
    if (updErr) throw updErr;

    res.json({ isCorrect });
  } catch (err) {
    console.error("/verifyAnswer error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------
// Start Server
// ----------------
const PORT = parseInt(process.env.ELIZAOS_PORT, 10) || 5000;
app.listen(PORT, () => {
  console.log(`🧠 ElizaOS quiz server running on port ${PORT}`);
});
