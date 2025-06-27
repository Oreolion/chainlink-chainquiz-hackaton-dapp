### WHAT THIS REPO IS
This repo uses the ElizaOS Agentic AI framework to create an AI agent that interacts with user by creating quiz in their selected domains input (via DAPP).


The agent uses custom actions that interact with [Chainlink Functions](https://docs.chain.link/chainlink-functions).

.env.example


OPENAI_API_KEY=

# EVM
EVM_PRIVATE_KEY=       # Add the "0x" prefix infront of your private key string                  
EVM_PROVIDER_URL=https://sepolia.base.org
ETHEREUM_PROVIDER_BASE_SEPOLIA=https://sepolia.base.org

# Supabase Configuration
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_API_KEY=

ELIZAOS_URL=

# ChainQuiz Configuration
QUIZTOKEN_ADDRESS=
CHAINQUIZ_ADDRESS=
DON_SLOT_ID=
DON_SLOT_VERSION=



check Eliza result in termonal
`
curl -X POST http://localhost:5000/generateQuiz \
-H "Content-Type: application/json" \
-d '{"domains":["DeFi","NFT","Layer2","DAOs","Governance"],"playerAddress":"0x50F9c0C82C49B0E4c43ca97016C29dfd3F4A18c7", "quizId": "temp_quiz_123"}'
`
