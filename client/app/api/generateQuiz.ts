import type { NextApiRequest, NextApiResponse } from "next";
import { AgentRuntime, elizaLogger, type Character } from "@elizaos/core";
import { bootstrapPlugin } from "@elizaos/plugin-bootstrap";
import { createNodePlugin } from "@elizaos/plugin-node";
import { ChainQuizPlugin } from "../../../eliza-agent/src/custom-plugins/index";
import { evmPlugin } from "@elizaos/plugin-evm";
import { initializeDbCache } from "../../../eliza-agent/src/cache/index";
import { initializeDatabase } from "../../../eliza-agent/src/database/index";
import { character } from "../../../eliza-agent/src/character";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { domains, playerAddress, difficulty } = req.body;
    if (!Array.isArray(domains) || domains.length < 5 || !playerAddress || !difficulty) {
      console.error("Invalid input:", { domains, playerAddress, difficulty });
      return res.status(400).json({ error: "Invalid input: 5+ domains, playerAddress, and difficulty required" });
    }

    if (!process.env.OPENAI_API_KEY) {
      console.error("Missing OPENAI_API_KEY");
      return res.status(500).json({ error: "Server configuration error: Missing OPENAI_API_KEY" });
    }

    // Initialize ElizaOS components
    const dataDir = path.join(__dirname, "data");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const db = initializeDatabase(dataDir);
    await db.init();
    const cache = initializeDbCache(character, db);
    const runtime = new AgentRuntime({
      databaseAdapter: db,
      token: process.env.OPENAI_API_KEY,
      modelProvider: character.modelProvider,
      evaluators: [],
      character,
      plugins: [bootstrapPlugin, createNodePlugin(), ChainQuizPlugin, evmPlugin].filter(Boolean),
      providers: [],
      actions: [],
      services: [],
      managers: [],
      cacheManager: cache,
    });
    await runtime.initialize();

    // Generate questions using ChainQuizPlugin
    // Assuming ChainQuizPlugin has a generateQuiz method
    const questions = await runtime.plugins.find(p => p === ChainQuizPlugin).generateQuiz({
      domains,
      playerAddress,
      difficulty,
    });

    if (!Array.isArray(questions) || questions.length !== 10) {
      console.error("Invalid question count:", questions.length);
      return res.status(500).json({ error: "Expected exactly 10 questions" });
    }

    // Validate question format
    const formattedQuestions = questions.map((q: any, i: number) => ({
      id: q.id || `q${i + 1}`,
      domain: q.domain || domains[i % domains.length],
      text: q.text || `Question ${i + 1} — ${domains[i % domains.length]} (${difficulty})`,
      options: Array.isArray(q.options) && q.options.length === 4 ? q.options : ["Option 1", "Option 2", "Option 3", "Option 4"],
      correctIndex: Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex < 4 ? q.correctIndex : 0,
    }));

    console.log("Quiz generated:", { questions: formattedQuestions });
    res.status(200).json({ questions: formattedQuestions });
  } catch (error) {
    console.error("Error in /api/generateQuiz:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}
