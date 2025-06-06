import { SecretsManager } from "@chainlink/functions-toolkit";
import { ethers } from "ethers";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const makeRequestSepolia = async () => {
  if (!process.env.ETHEREUM_PROVIDER_BASE_SEPOLIA) {
    throw new Error("ETHEREUM_PROVIDER_BASE_SEPOLIA not provided - check your environment variables");
  }
  if (!process.env.SUPABASE_API_KEY) {
    throw new Error("SUPABASE_API_KEY not provided - check your environment variables");
  }
  if (!process.env.EVM_PRIVATE_KEY) {
    throw new Error("EVM_PRIVATE_KEY not provided - check your environment variables");
  }

  // hardcoded for Base Sepolia
  const routerAddress = "0xf9B8fc078197181C841c296C876945aaa425B278";
  const donId = "fun-base-sepolia-1"; // DON ID for Base Sepolia
  const rpcUrl = process.env.ETHEREUM_PROVIDER_BASE_SEPOLIA; // fetch Base Sepolia RPC URL
  const gatewayUrls = [
    "https://01.functions-gateway.testnet.chain.link/",
    "https://02.functions-gateway.testnet.chain.link/",
  ];
  
  const slotIdNumber = 0;
  const expirationTimeMinutes = 1440;
  
  // Use a very short key name to ensure it's under 32 bytes
  const secrets = { 
    "key": process.env.SUPABASE_API_KEY
  };

  // Debug: Check the byte length of the key
  const keyName = "key";
  console.log(`Key name "${keyName}" byte length:`, Buffer.from(keyName, 'utf8').length);

  // Initialize ethers signer and provider to interact with the contracts onchain
  const privateKey = process.env.EVM_PRIVATE_KEY; // fetch EVM_PRIVATE_KEY
  if (!privateKey) throw new Error("private key not provided - check your environment variables");

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey);
  const signer = wallet.connect(provider); // create ethers signer for signing transactions

  //////// MAKE REQUEST ////////
  console.log("\nMake request...");

  try {
    // First encrypt secrets and create a gist
    const secretsManager = new SecretsManager({
      signer: signer,
      functionsRouterAddress: routerAddress,
      donId: donId,
    });

    console.log("Initializing SecretsManager...");
    await secretsManager.initialize();
    console.log("SecretsManager initialized successfully");

    // Encrypt secrets
    console.log("Encrypting secrets...");
    const encryptedSecretsObj = await secretsManager.encryptSecrets(secrets);
    console.log("Secrets encrypted successfully");

    console.log(
      `Upload encrypted secret to gateways ${gatewayUrls}. slotId ${slotIdNumber}. Expiration in minutes: ${expirationTimeMinutes}`
    );

    // Upload secrets
    const uploadResult = await secretsManager.uploadEncryptedSecretsToDON({
      encryptedSecretsHexstring: encryptedSecretsObj.encryptedSecrets,
      gatewayUrls: gatewayUrls,
      slotId: slotIdNumber,
      minutesUntilExpiration: expirationTimeMinutes,
    });

    if (!uploadResult.success) {
      throw new Error(`Encrypted secrets not uploaded to ${gatewayUrls}`);
    }

    console.log(`\n✅ Secrets uploaded properly to gateways ${gatewayUrls}! Gateways response: `, uploadResult);

    const donHostedSecretsVersion = parseInt(uploadResult.version); // fetch the reference of the encrypted secrets

    // Save info in case we clear console
    const secretsInfo = {
      donHostedSecretsVersion: donHostedSecretsVersion.toString(),
      slotId: slotIdNumber.toString(),
      expirationTimeMinutes: expirationTimeMinutes.toString(),
    };

    fs.writeFileSync("donSecretsInfo.txt", JSON.stringify(secretsInfo, null, 2));
    console.log(`donHostedSecretsVersion is ${donHostedSecretsVersion}, Saved info to donSecretsInfo.txt`);

  } catch (error) {
    console.error("Error details:", error);
    throw error;
  }
};

makeRequestSepolia().catch(e => {
  console.error("Script failed:", e);
  process.exit(1);
});