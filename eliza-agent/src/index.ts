import { DirectClient } from "@elizaos/client-direct";
import { AgentRuntime, elizaLogger, settings, stringToUuid, type Character } from "@elizaos/core";
import { bootstrapPlugin } from "@elizaos/plugin-bootstrap";
import { createNodePlugin } from "@elizaos/plugin-node";
import { ChainQuizPlugin } from "./custom-plugins/index.ts";
import { evmPlugin } from "@elizaos/plugin-evm";
import fs from "fs";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";
import { initializeDbCache } from "./cache/index.ts";
import { character } from "./character.ts";
import { startChat } from "./chat/index.ts";
import { getTokenForProvider, loadCharacters, parseArguments } from "./config/index.ts";
import { initializeDatabase } from "./database/index.ts";
import express from "express";
import cors from "cors"; // Add CORS
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const wait = (minTime: number = 1000, maxTime: number = 3000) => {
  const waitTime = Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
  return new Promise((resolve) => setTimeout(resolve, waitTime));
};

let nodePlugin: any | undefined;

export function createAgent(character: Character, db: any, cache: any, token: string) {
  elizaLogger.success(elizaLogger.successesTitle, "Creating runtime for character", character.name);
  nodePlugin ??= createNodePlugin();
  return new AgentRuntime({
    databaseAdapter: db,
    token,
    modelProvider: character.modelProvider,
    evaluators: [],
    character,
    plugins: [bootstrapPlugin, nodePlugin, ChainQuizPlugin, evmPlugin].filter(Boolean),
    providers: [],
    actions: [],
    services: [],
    managers: [],
    cacheManager: cache,
  });
}

async function startAgent(character: Character, directClient: DirectClient) {
  try {
    character.id ??= stringToUuid(character.name);
    character.username ??= character.name;
    const token = getTokenForProvider(character.modelProvider, character);
    console.log(`Token provider is ${character.modelProvider}`);
    if (!token) throw new Error("Token not found for provider");
    const dataDir = path.join(__dirname, "data");
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const db = initializeDatabase(dataDir);
    await db.init();
    const cache = initializeDbCache(character, db);
    const runtime = createAgent(character, db, cache, token);
    await runtime.initialize();
    directClient.registerAgent(runtime);
    elizaLogger.debug(`Started ${character.name} as ${runtime.agentId}`);
    return runtime;
  } catch (error) {
    elizaLogger.error(`Error starting agent for character ${character.name}:`, error);
    console.error(error);
    throw error;
  }
}

const checkPortAvailable = (port: number): Promise<boolean> => {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") resolve(false);
    });
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port);
  });
};

const startAgents = async () => {
  const directClient = new DirectClient();
  let expressPort = parseInt(settings.SERVER_PORT || "5000");
  let clientPort = expressPort + 1;
  const args = parseArguments();
  let charactersArg = args.characters || args.character;
  let characters = [character];
  console.log("charactersArg", charactersArg);
  if (charactersArg) characters = await loadCharacters(charactersArg);
  console.log("characters", characters);
  try {
    for (const character of characters) {
      await startAgent(character, directClient);
    }
  } catch (error) {
    elizaLogger.error("Error starting agents:", error);
  }

  while (!(await checkPortAvailable(expressPort))) {
    elizaLogger.warn(`Port ${expressPort} is in use, trying ${expressPort + 1}`);
    expressPort++;
    clientPort++;
  }

  while (!(await checkPortAvailable(clientPort))) {
    elizaLogger.warn(`Port ${clientPort} is in use, trying ${clientPort + 1}`);
    clientPort++;
  }

  const app = express();
  app.use(cors({ origin: "http://localhost:3000", methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] })); // Add CORS
  app.use(express.json());

  app.get("/health", (req, res) => {
    console.log("Health check requested");
    res.status(200).json({ status: "healthy" });
  });

  app.post("/generateQuiz", async (req, res) => {
    console.log("POST /generateQuiz received:", req.body);
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

      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      console.log("Generating questions with OpenAI");
      const questionsResponse = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `
You are an expert in crypto and web3, tasked with generating multiple-choice questions for a quiz.
Generate EXACTLY 10 questions based on the provided domains and difficulty level.
Return valid JSON:
[
  {
    "id": "<q1 to q10>",
    "domain": "<one of the input domains>",
    "text": "<question text, tailored to difficulty>",
    "options": ["<option0>", "<option1>", "<option2>", "<option3>"],
    "correctIndex": <0|1|2|3>
  },
  ... (9 more questions)
]
- Use the provided domains: ${domains.join(", ")}.
- Adjust question complexity based on difficulty: "${difficulty}" (e.g., Easy, Medium, Hard).
- Ensure questions are diverse across domains.
- No extra commentary, only valid JSON.
            `,
          },
          {
            role: "user",
            content: `Domains: ${domains.join(", ")}\nDifficulty: ${difficulty}`,
          },
        ],
      });

      const content = questionsResponse.choices[0].message.content;
      if (!content) {
        console.error("OpenAI response content is null");
        return res.status(500).json({ error: "OpenAI response content is empty" });
      }

      let questions;
      try {
        questions = JSON.parse(content);
      } catch (error) {
        console.error("OpenAI parse error:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        return res.status(500).json({ error: `Failed to parse OpenAI response: ${errorMessage}` });
      }

      if (!Array.isArray(questions) || questions.length !== 10) {
        console.error("Invalid question count:", questions.length);
        return res.status(500).json({ error: "Expected exactly 10 questions" });
      }

      console.log("Quiz generated:", { questions });
      res.json({ questions }); // Return questions directly
    } catch (error) {
      console.error("Error in /generateQuiz:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/verifyAnswer", async (req, res) => {
    console.log("POST /verifyAnswer received:", req.body);
    try {
      const { quizId, playerAddress, questionIndex, answer } = req.body;
      if (!quizId || !playerAddress || questionIndex === undefined || answer === undefined) {
        console.error("Invalid input:", { quizId, playerAddress, questionIndex, answer });
        return res.status(400).json({ error: "quizId, playerAddress, questionIndex, and answer required" });
      }

      const questionIdx = parseInt(questionIndex);
      if (isNaN(questionIdx) || questionIdx < 0 || questionIdx >= 10) {
        console.error("Invalid questionIndex:", questionIndex);
        return res.status(400).json({ error: "Invalid questionIndex: must be 0 to 9" });
      }

      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error("Missing environment variables");
        return res.status(500).json({ error: "Server configuration error: Missing environment variables" });
      }

      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      console.log("Fetching quiz from Supabase");
      const { data, error } = await supabase
        .from("Quizzes")
        .select("questions, correct_count, num_questions, completed_at, player_address")
        .eq("quiz_id", quizId)
        .single();

      if (error) {
        console.error("Supabase fetch error:", error);
        return res.status(500).json({ error: `Supabase fetch failed: ${error.message}` });
      }

      if (data.player_address.toLowerCase() !== playerAddress.toLowerCase()) {
        console.error("Player address mismatch:", { quizId, playerAddress });
        return res.status(403).json({ error: "Unauthorized: player address does not match" });
      }

      const questions = data.questions;
      const question = questions[questionIdx];
      if (!question) {
        console.error("Question not found at index:", questionIdx);
        return res.status(404).json({ error: `Question not found at index ${questionIdx}` });
      }

      const isCorrect = parseInt(answer) === question.correctIndex;
      let newCorrectCount = data.correct_count;
      let newCompletedAt = data.completed_at;

      if (isCorrect) {
        newCorrectCount++;
        if (questionIdx === questions.length - 1) newCompletedAt = new Date().toISOString();
      }

      console.log("Updating quiz in Supabase");
      const { error: updateError } = await supabase
        .from("Quizzes")
        .update({ correct_count: newCorrectCount, completed_at: newCompletedAt })
        .eq("quiz_id", quizId);

      if (updateError) {
        console.error("Supabase update error:", updateError);
        return res.status(500).json({ error: `Supabase update failed: ${updateError.message}` });
      }

      console.log("Answer verified:", { quizId, questionIndex, isCorrect });
      res.json({ isCorrect });
    } catch (error) {
      console.error("Error in /verifyAnswer:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  try {
    app.listen(expressPort, () => {
      elizaLogger.log(`HTTP server started on port ${expressPort}`);
      console.log(`Express server listening on http://localhost:${expressPort}`);
    });
  } catch (error) {
    console.error("Failed to start Express server:", error);
    process.exit(1);
  }

  try {
    directClient.start(clientPort);
    console.log(`DirectClient started on port ${clientPort}`);
  } catch (error) {
    console.error("Failed to start DirectClient:", error);
    process.exit(1);
  }

  directClient.startAgent = async (character: Character) => {
    return startAgent(character, directClient);
  };

  if (expressPort !== parseInt(settings.SERVER_PORT || "5000")) {
    elizaLogger.log(`Express server started on alternate port ${expressPort}`);
  }

  const isDaemonProcess = process.env.DAEMON_PROCESS === "true";
  if (!isDaemonProcess) {
    elizaLogger.log("Chat started. Type 'exit' to quit.");
    const chat = startChat(characters);
    chat();
  }
};

startAgents().catch((error) => {
  elizaLogger.error("Unhandled error in startAgents:", error);
  process.exit(1);
});
