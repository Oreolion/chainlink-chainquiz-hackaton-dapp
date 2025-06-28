// elizaos/actions/ChainQuizAction.ts

/**
 * @fileoverview This file contains the implementation of the ChainQuizAction class
 * and the chainQuizAction handler. It interacts with your deployed ChainQuiz
 * contract on Base Sepolia to start a quiz (stake tokens, request quiz questions).
 *
 * Pre‐conditions:
 *  • ElizaOS runtime has EVM_PRIVATE_KEY pointing to a funded wallet.
 *  • You have a DON‐Hosted Secrets slot containing your Supabase and OpenAI keys.
 *  • Chainlink Functions Job IDs (GEN & VER) are stored as environment variables.
 */

import { parseEther, getContract } from "viem";
import {
  Action,
  composeContext,
  generateObjectDeprecated,
  HandlerCallback,
  ModelClass,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { initWalletProvider, WalletProvider } from "../providers/wallet";
import type { QuizParams, Transaction } from "../types/index";
import { chainQuizTemplate } from "../templates/index";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load ChainQuiz.json
const ChainQuizJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../artifacts/ChainQuiz.json"), "utf-8"));

export class ChainQuizAction {
  constructor(private walletProvider: WalletProvider) {}

  async startQuiz(params: QuizParams): Promise<Transaction> {
    const chainName = "baseSepolia";
    const contractAddress: `0x${string}` = process.env.CHAINQUIZ_ADDRESS as `0x${string}`;
    const donHostedSecretsSlotID: number = Number(process.env.DON_SLOT_ID);
    const donHostedSecretsVersion: number = Number(process.env.DON_HOSTED_SECRETS_VERSION);
    const jobIdGen = process.env.JOBID_GEN as string;
    const jobIdVer = process.env.JOBID_VER as string;

    if (!contractAddress || !donHostedSecretsSlotID || !donHostedSecretsVersion || !jobIdGen || !jobIdVer) {
      throw new Error("Missing one of: CONTRACT_ADDRESS, DON_SLOT_ID, DON_HOSTED_SECRETS_VERSION, JOBID_GEN, or JOBID_VER");
    }

    console.log(`🔔 Starting quiz for domains [${params.domains.join(", ")}] with player address: ${params.playerAddress}`);

    this.walletProvider.switchChain(chainName);
    const walletClient = this.walletProvider.getWalletClient(chainName);

    try {
      const { abi } = (ChainQuizJson as any).contracts["ChainQuiz.sol:ChainQuiz"];
      const chainQuizContract = getContract({
        address: contractAddress,
        abi,
        client: walletClient,
      });

      const entryFee = BigInt(parseEther("10"));
      const quizTokenAddress = process.env.QUIZTOKEN_ADDRESS as `0x${string}`;

      const approveTxHash = await walletClient.writeContract({
        address: quizTokenAddress,
        abi: (ChainQuizJson as any).contracts["QuizToken.sol:QuizToken"].abi,
        functionName: "approve",
        chain: undefined,
        account: walletClient.account ?? null,
        args: [contractAddress, entryFee],
      });

      console.log("ChainQuizParams:", params);
      console.assert(Array.isArray(params.domains) && params.domains.length >= 5, "domains must be an array of length ≥ 5");
      console.assert(typeof params.playerAddress === "string" && params.playerAddress.startsWith("0x") && params.playerAddress.length === 42, "playerAddress must be a 42-char hex string");

      const hash = await chainQuizContract.write.startQuiz([params.domains], {
        gas: BigInt(3_000_000),
        account: walletClient.account!,
        chain: walletClient.chain ?? null,
      });

      return {
        hash,
        from: walletClient.account!.address,
        to: contractAddress,
        value: parseEther("0"),
        data: "0x",
      };
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`startQuiz call failed: ${error.message}`);
      } else {
        throw new Error("startQuiz call failed: unknown error");
      }
    }
  }
}

/**
 * Builds the function call details required for starting a quiz.
 * @param {State} state - The current state.
 * @param {IAgentRuntime} runtime - The agent runtime.
 * @param {WalletProvider} wp - The wallet provider.
 * @returns {Promise<QuizParams>} The parameters for startQuiz.
 */
const buildFunctionCallDetails = async (
  state: State,
  runtime: IAgentRuntime,
  wp: WalletProvider
): Promise<QuizParams> => {
  // Let’s assume the user will “tell” the AI something like:
  // “I want to start a quiz with domains DeFi, NFT, Oracles, Tokenomics, Layer2”
  // We need to extract `domains` array and their `playerAddress`.
  state.supportedChains = Object.keys(wp.chains)
    .map((item) => `"${item}"`)
    .join("|");

  const context = composeContext({
    state,
    template: chainQuizTemplate,
  });

  // This will ask the LLM to fill in a JSON object matching QuizParams:
  const functionCallDetails = (await generateObjectDeprecated({
    runtime,
    context,
    modelClass: ModelClass.SMALL,
  })) as QuizParams;

  return functionCallDetails;
};

/**
 * The chainQuizAction handler.
 * @type {Action}
 */
export const chainQuizAction: Action = {
  name: "start quiz",
  description:
    "Given 5+ domains and a player address, call `startQuiz` on ChainQuiz contract via Chainlink Functions",
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: any,
    callback?: HandlerCallback
  ) => {
    if (!state) {
      state = (await runtime.composeState(message)) as State;
    } else {
      state = await runtime.updateRecentMessageState(state);
    }

    console.log("ChainQuiz action handler called");
    const walletProvider = await initWalletProvider(runtime);
    const action = new ChainQuizAction(walletProvider);

    // Compose functionCall context
    const params: QuizParams = await buildFunctionCallDetails(
      state,
      runtime,
      walletProvider
    );

    try {
      const callFunctionResp = await action.startQuiz(params);
      if (callback) {
        callback({
          text: `✅ Quiz started with domains [${params.domains.join(
            ", "
          )}]. Transaction Hash: ${callFunctionResp.hash}`,
          content: {
            success: true,
            hash: callFunctionResp.hash,
            from: callFunctionResp.from,
            to: callFunctionResp.to,
          },
        });
      }
      return true;
    } catch (error) {
      console.error("Error during startQuiz call:", error);
      if (error instanceof Error && callback) {
        callback({
          text: `❌ Error calling startQuiz: ${error.message}`,
          content: { error: error.message },
        });
      }
      return false;
    }
  },
  validate: async (runtime: IAgentRuntime) => {
    const privateKey = runtime.getSetting("EVM_PRIVATE_KEY");
    return typeof privateKey === "string" && privateKey.startsWith("0x");
  },
  examples: [
    [
      {
        user: "assistant",
        content: {
          text: "I can help you start a ChainQuiz.",
          action: "CHAINQUIZ_START",
        },
      },
      {
        user: "user",
        content: {
          text: "Start a quiz on domains DeFi, Oracles, NFT, Layer2, Tokenomics. My address is 0xAbC...123.",
          action: "CHAINQUIZ_START",
        },
      },
    ],
  ],
  similes: ["START_QUIZ", "QUIZ_BEGIN", "LAUNCH_QUIZ"],
};
