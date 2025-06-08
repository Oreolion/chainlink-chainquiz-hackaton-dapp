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

import { initWalletProvider, WalletProvider } from "../providers/wallet.ts";
import type { QuizParams, Transaction } from "../types/index.ts";
import { chainQuizTemplate } from "../templates/index.ts";
import ChainQuizJson from "../artifacts/ChainQuiz.json" assert { type: "json" };

/**
 * Class representing the ChainQuizAction.
 */
export class ChainQuizAction {
  /**
   * Creates an instance of ChainQuizAction.
   * @param {WalletProvider} walletProvider - The wallet provider instance.
   */
  constructor(private walletProvider: WalletProvider) {}

  /**
   * Calls `startQuiz` on the ChainQuiz contract.
   * @param {QuizParams} params - The parameters for starting a quiz.
   * @returns {Promise<Transaction>} The transaction details.
   * @throws Will throw an error if contract address, secrets slot, version,
   *         or Job IDs are not set.
   */
  async startQuiz(params: QuizParams): Promise<Transaction> {
    // You must supply these via environment or a config file:
    const chainName = "baseSepolia";

    // **Fill in your actual deployed contract address here**:
    const contractAddress: `0x${string}` = process.env
      .CHAINQUIZ_ADDRESS as `0x${string}`;
    // **Secrets slot & version from DON** (e.g. "42|1"):
    const donHostedSecretsSlotID: number = Number(process.env.DON_SLOT_ID);
    const donHostedSecretsVersion: number = Number(
      process.env.DON_HOSTED_SECRETS_VERSION
    );
    // Chainlink Functions Job IDs (GenerateQuiz + VerifyAnswer)
    const jobIdGen = process.env.JOBID_GEN as string; // e.g. "0xabc123..."
    const jobIdVer = process.env.JOBID_VER as string; // e.g. "0xdef456..."

    // Validate that everything is set
    if (
      !contractAddress ||
      !donHostedSecretsSlotID ||
      !donHostedSecretsVersion ||
      !jobIdGen ||
      !jobIdVer
    ) {
      throw new Error(
        "Missing one of: CONTRACT_ADDRESS, DON_SLOT_ID, DON_HOSTED_SECRETS_VERSION, JOBID_GEN, or JOBID_VER"
      );
    }

    console.log(
      `🔔 Starting quiz for domains [${params.domains.join(
        ", "
      )}] with player address: ${params.playerAddress}`
    );

    // 1) Switch to Base Sepolia
    this.walletProvider.switchChain(chainName);
    const walletClient = this.walletProvider.getWalletClient(chainName);

    try {
      // 2) Build the viem Contract instance
      const { abi } = (ChainQuizJson as any).contracts[
        "ChainQuiz.sol:ChainQuiz"
      ];
      const chainQuizContract = getContract({
        address: contractAddress,
        abi,
        client: walletClient,
      });

      // 3) Build the arguments for startQuiz:
      //    args = [
      //      [ "DeFi", "NFT", ... ],      // domains[] array
      //      jobIdGen,                   // Job ID for GenerateQuiz
      //      `${donHostedSecretsSlotID}|${donHostedSecretsVersion}`,
      //      params.playerAddress
      //    ]
      //
      //    Note: Your on‐chain function `_generateSource()` expects args[0] = JSON(domains), args[1] = playerAddress, etc.
      //    But in our `ChainQuiz.sol`, we hardcoded secrets via `_toHexString(msg.sender)` etc. Double‐check your contract’s `startQuiz` signature.
      //    Assuming it’s: `function startQuiz(string[] calldata domains) external`
      //
      //    We just call startQuiz(domains). The contract itself constructs the Functions request.
      //
      // 4) We need to stake 10 $QUIZ first. That means:
      //    a) Approve `entryFee` (10 * 10^18) to the ChainQuiz contract.
      //    b) Call `startQuiz(domains)`.
      //
      // 5) Return a consolidated Transaction object.

      // a) Approve 10 $QUIZ
      const entryFee = BigInt(parseEther("10")); // 10 * 10^18
      const quizTokenAddress = process.env.QUIZTOKEN_ADDRESS as `0x${string}`;

      // Build a viem write to the $QUIZ token’s `approve(...)`
      const approveTxHash = await walletClient.writeContract({
        address: quizTokenAddress,
        abi: (ChainQuizJson as any).contracts["QuizToken.sol:QuizToken"].abi,
        functionName: "approve",
        chain: undefined, // or specify your chain object if needed
        account: walletClient.account ?? null,
        args: [contractAddress, entryFee],
      });

      // b) Call startQuiz(domains)
      console.log("ChainQuizParams:", params);
      console.assert(
        Array.isArray(params.domains) && params.domains.length >= 5,
        "domains must be an array of length ≥ 5"
      );
      console.assert(
        typeof params.playerAddress === "string" &&
          params.playerAddress.startsWith("0x") &&
          params.playerAddress.length === 42,
        "playerAddress must be a 42-char hex string"
      );

      const hash = await chainQuizContract.write.startQuiz(
        [params.domains],
        {}
      );

      return {
        hash,
        from: walletClient.account!.address,
        to: contractAddress,
        value: parseEther("0"), // no ETH value
        data: "0x", // (we could do `chainQuizContract.interface.encodeFunctionData("startQuiz", [params.domains])`)
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
