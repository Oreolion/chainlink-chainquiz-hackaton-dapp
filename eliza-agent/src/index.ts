import { DirectClient } from "@elizaos/client-direct";
import {
  AgentRuntime,
  elizaLogger,
  settings,
  stringToUuid,
  type Character,
} from "@elizaos/core";
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
import {
  getTokenForProvider,
  loadCharacters,
  parseArguments,
} from "./config/index.ts";
import { initializeDatabase } from "./database/index.ts";
import express from "express";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const wait = (minTime: number = 1000, maxTime: number = 3000) => {
  const waitTime = Math.floor(Math.random() * (maxTime - minTime + 1)) + minTime;
  return new Promise((resolve) => setTimeout(resolve, waitTime));
};

let nodePlugin: any | undefined;

export function createAgent(
  character: Character,
  db: any,
  cache: any,
  token: string
) {
  elizaLogger.success(
    elizaLogger.successesTitle,
    "Creating runtime for character",
    character.name,
  );

  nodePlugin ??= createNodePlugin();

  return new AgentRuntime({
    databaseAdapter: db,
    token,
    modelProvider: character.modelProvider,
    evaluators: [],
    character,
    plugins: [
      bootstrapPlugin,
      nodePlugin,
      ChainQuizPlugin,
      evmPlugin,
    ].filter(Boolean),
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
    if (!token) {
      throw new Error("Token not found for provider");
    }
    const dataDir = path.join(__dirname, "../data");

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const db = initializeDatabase(dataDir);

    await db.init();

    const cache = initializeDbCache(character, db);
    const runtime = createAgent(character, db, cache, token);

    await runtime.initialize();

    directClient.registerAgent(runtime);

    elizaLogger.debug(`Started ${character.name} as ${runtime.agentId}`);

    return runtime;
  } catch (error) {
    elizaLogger.error(
      `Error starting agent for character ${character.name}:`,
      error,
    );
    console.error(error);
    throw error;
  }
}

const checkPortAvailable = (port: number): Promise<boolean> => {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(false);
      }
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
  let clientPort = expressPort + 1; // Use 5001 for DirectClient
  const args = parseArguments();

  let charactersArg = args.characters || args.character;
  let characters = [character];

  console.log("charactersArg", charactersArg);
  if (charactersArg) {
    characters = await loadCharacters(charactersArg);
  }
  console.log("characters", characters);
  try {
    for (const character of characters) {
      await startAgent(character, directClient as DirectClient);
    }
  } catch (error) {
    elizaLogger.error("Error starting agents:", error);
  }

  // Check Express port
  while (!(await checkPortAvailable(expressPort))) {
    elizaLogger.warn(`Port ${expressPort} is in use, trying ${expressPort + 1}`);
    expressPort++;
    clientPort++;
  }

  // Check DirectClient port
  while (!(await checkPortAvailable(clientPort))) {
    elizaLogger.warn(`Port ${clientPort} is in use, trying ${clientPort + 1}`);
    clientPort++;
  }

  // Add Express server
  const app = express();
  app.use(express.json());

  app.get("/health", (req, res) => {
    console.log("Health check requested");
    res.status(200).json({ status: "OK" });
  });

  app.post("/generateQuiz", async (req, res) => {
    console.log("Received /generateQuiz request:", req.body);
    try {
      const { domains, playerAddress } = req.body;
      if (!Array.isArray(domains) || domains.length < 5 || typeof playerAddress !== "string") {
        console.log("Invalid input received");
        return res.status(400).json({ error: "Invalid input: 5+ domains and playerAddress required" });
      }

      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.OPENAI_API_KEY) {
        console.error("Missing environment variables");
        return res.status(500).json({ error: "Server configuration error: Missing environment variables" });
      }

      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      );
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      console.log("Calling OpenAI for questions");
      const questions = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `
You are an assistant that produces multiple-choice questions about crypto/web3.
Return EXACTLY 10 questions in JSON:
[
  {
    "id": "q1",
    "domain": "<one of the domains>",
    "text": "<question text>",
    "options": ["<opt0>", "<opt1>", "<opt2>", "<opt3>"],
    "correctIndex": <0|1|2|3>
  },
  ... (q2..q10)
]
Ensure valid JSON, no extra commentary.
            `,
          },
          { role: "user", content: `Domains: ${domains.join(", ")}` },
        ],
      });

      const content = questions.choices[0].message.content;
      if (!content) {
        console.error("OpenAI response content is null");
        return res.status(500).json({ error: "OpenAI response content is empty" });
      }

      let parsedQuestions;
      try {
        parsedQuestions = JSON.parse(content);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("OpenAI parse error:", message);
        return res.status(500).json({ error: `Failed to parse OpenAI response: ${message}` });
      }

      if (!Array.isArray(parsedQuestions) || parsedQuestions.length !== 10) {
        console.error("Invalid question count:", parsedQuestions.length);
        return res.status(500).json({ error: "Expected 10 questions" });
      }

      console.log("Inserting quiz into Supabase");
      const quizId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const { data, error } = await supabase.from("Quizzes").insert([
        {
          quiz_id: quizId,
          player_address: playerAddress.toLowerCase(),
          questions: parsedQuestions,
          started_at: new Date().toISOString(),
          correct_count: 0,
          completed_at: null,
        },
      ]).select("quiz_id, num_questions");
      console.log("Insert result:", data, error);


      if (error) {
        console.error("Supabase error:", error);
        return res.status(500).json({ error: `Supabase insert failed: ${error.message}` });
      }

      console.log("Generated quiz:", { quizId, numQuestions: 10 });
      res.json({ quizId, numQuestions: 10 });
    } catch (error) {
      console.error("Error in /generateQuiz:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/verifyAnswer", async (req, res) => {
    console.log("Received /verifyAnswer request:", req.body);
    try {
      const { quizId, questionId, selectedIndex } = req.body;
      if (typeof quizId !== "string" || typeof questionId !== "string") {
        console.log("Invalid input received");
        return res.status(400).json({ error: "quizId and questionId required" });
      }

      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error("Missing environment variables");
        return res.status(500).json({ error: "Server configuration error: Missing environment variables" });
      }

      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
      );

      console.log("Fetching quiz from Supabase");
      const { data, error } = await supabase
        .from("Quizzes")
        .select("questions, correct_count, num_questions, completed_at")
        .eq("quiz_id", quizId)
        .single();

      if (error) {
        console.error("Supabase fetch error:", error);
        return res.status(500).json({ error: `Supabase fetch failed: ${error.message}` });
      }

      const questions = data.questions;
      const question = questions.find((q: any) => q.id === questionId);
      if (!question) {
        console.error("Question not found:", questionId);
        return res.status(404).json({ error: "Question not found" });
      }

      const isCorrect = Number(selectedIndex) === question.correctIndex;
      let newCorrectCount = data.correct_count;
      let newCompletedAt = data.completed_at;

      if (isCorrect) {
        newCorrectCount++;
        const idxNum = parseInt(questionId.slice(1)); // "q7" → 7
        if (idxNum === questions.length) {
          newCompletedAt = new Date().toISOString();
        }
      }

      console.log("Updating quiz in Supabase");
      const { error: updateError } = await supabase
        .from("Quizzes")
        .update({
          correct_count: newCorrectCount,
          completed_at: newCompletedAt,
        })
        .eq("quiz_id", quizId);

      if (updateError) {
        console.error("Supabase update error:", updateError);
        return res.status(500).json({ error: `Supabase update failed: ${updateError.message}` });
      }

      console.log("Answer verified:", { quizId, questionId, isCorrect });
      res.json({ isCorrect });
    } catch (error) {
      console.error("Error in /verifyAnswer:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Start Express server
  try {
    app.listen(expressPort, () => {
      elizaLogger.log(`HTTP server started on port ${expressPort}`);
      console.log(`Express server listening on http://localhost:${expressPort}`);
    });
  } catch (error) {
    console.error("Failed to start Express server:", error);
    process.exit(1);
  }

  // Start DirectClient
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