import { AgentRuntime } from "@elizaos/core";
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { domains, playerAddress, difficulty } = req.body;
    if (
      !Array.isArray(domains) ||
      domains.length < 5 ||
      !playerAddress ||
      !difficulty
    ) {
      console.error("Invalid input:", { domains, playerAddress, difficulty });
      return res.status(400).json({
        error:
          "Invalid input: 5+ domains, playerAddress, and difficulty required",
      });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) {
      console.error("Missing OPENAI_API_KEY");
      return res
        .status(500)
        .json({ error: "Server configuration error: Missing OPENAI_API_KEY" });
    }

    // ─── Initialize ElizaOS runtime ───
    const dataDir = path.join(__dirname, "data");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const db = initializeDatabase(dataDir);
    await db.init();
    const cache = initializeDbCache(character, db);

    const runtime = new AgentRuntime({
      databaseAdapter: db,
      token: OPENAI_API_KEY,
      modelProvider: character.modelProvider,
      evaluators: [],
      character,
      plugins: [
        bootstrapPlugin,
        createNodePlugin(),    // ← note the ()
        ChainQuizPlugin,
        evmPlugin,
      ],
      providers: [],
      actions: [],
      services: [],
      managers: [],
      cacheManager: cache,
    });
    await runtime.initialize();

    // ─── Find the ChainQuizPlugin instance ───
    const quizPlugin = runtime.plugins.find(
      (p) =>
        // match by reference or by name
        p === ChainQuizPlugin || p.name === ChainQuizPlugin.name
    );
    if (!quizPlugin || typeof quizPlugin.generateQuiz !== "function") {
      console.error("ChainQuizPlugin not found or invalid");
      return res
        .status(500)
        .json({ error: "Server error: ChainQuizPlugin not available" });
    }

    // ─── Generate the 10 questions ───
    const questions = await quizPlugin.generateQuiz({
      domains,
      playerAddress,
      difficulty,
    });

    if (!Array.isArray(questions) || questions.length !== 10) {
      console.error("Invalid question count:", questions);
      return res
        .status(500)
        .json({ error: "Expected exactly 10 questions" });
    }

    // ─── Sanitize/format them ───
    const formatted = questions.map((q, i) => ({
      id: q.id || `q${i + 1}`,
      domain: q.domain || domains[i % domains.length],
      text:
        q.text ||
        `Question ${i + 1} — ${domains[i % domains.length]} (${difficulty})`,
      options:
        Array.isArray(q.options) && q.options.length === 4
          ? q.options
          : ["Option 1", "Option 2", "Option 3", "Option 4"],
      correctIndex:
        Number.isInteger(q.correctIndex) &&
        q.correctIndex >= 0 &&
        q.correctIndex < 4
          ? q.correctIndex
          : 0,
    }));

    console.log("Quiz generated:", formatted);
    res.status(200).json({ questions: formatted });
  } catch (err) {
    console.error("Error in /api/generateQuiz:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}
