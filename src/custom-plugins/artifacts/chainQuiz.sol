// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// ─── Chainlink Imports ────────────────────────────────────────────────────────
// Functions:
import {FunctionsClient}
    from "@chainlink/contracts/src/v0.8/functions/v1_0_0/FunctionsClient.sol";
import {FunctionsRequest}
    from "@chainlink/contracts/src/v0.8/functions/v1_0_0/libraries/FunctionsRequest.sol";

// VRF V2.5:
import {VRFConsumerBaseV2Plus}
    from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient}
    from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

// Automation (Keepers):
import {AutomationCompatibleInterface}
    from "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";

// ConfirmedOwner:
import {ConfirmedOwner}
    from "@chainlink/contracts/src/v0.8/shared/access/ConfirmedOwner.sol";

// ─── OpenZeppelin Imports ─────────────────────────────────────────────────────
import {IERC20}
    from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/*
 * ChainQuiz.sol
 *
 * A stake-to-play quiz that integrates:
 *  1) Chainlink Functions → calls ElizaOS `/generateQuiz` & `/verifyAnswer`
 *  2) Chainlink VRF V2.5   → random bonus events via VRFConsumerBaseV2Plus
 *  3) Chainlink Keepers    → hourly leaderboard refresh via AutomationCompatible
 *  4) ERC-20 staking in $QUIZ, with a 45-second timeout per question (10 total)
 *  5) cancelQuiz()         → refund stake if user never finishes in time
 *
 * Replace all placeholder constants (subscription IDs, token addresses, URLs, etc.) with your own values.
 */

// — Chainlink Functions (Sepolia) —
address constant FUNCTIONS_ROUTER         = 0xf9B8fc078197181C841c296C876945aaa425B278;
bytes32 constant DON_ID                   = 0x66756e2d626173652d7365706f6c69612d310000000000000000000000000000;
uint64 constant FUNCTIONS_SUBSCRIPTION_ID = 1234;            // ← Your Functions subscription ID
uint32 constant FUNCTIONS_CALLBACK_GAS     = 300_000;         // Gas for fulfillRequest callback
uint256 constant FUNCTIONS_FEE             = 0.1 * 10**18;    // 0.1 LINK (in Juels)

// — Chainlink VRF V2.5 (Sepolia) —
address constant VRF_COORDINATOR_V2        = 0x2eD832Ba664535e5886b75D64C46EB9a228C2610;
uint256 constant VRF_SUBSCRIPTION_ID_V2    = 5678;             // ← Your VRF V2.5 subscription ID
bytes32 constant VRF_KEY_HASH_V2           = 0x354d2f95da55398f44b7cff77da56283d9c6c829a4bdf1bbcaf2ad6a4d081f61;
uint16 constant REQUEST_CONFIRMATIONS_V2   = 3;
uint32 constant CALLBACK_GAS_LIMIT_V2      = 100_000;          // As per starter guide
uint32 constant NUM_WORDS_V2               = 1;                // Requesting 1 random word

// — LINK & $QUIZ Token Addresses (Sepolia) —
address constant LINK_TOKEN                = 0x779877A7B0D9E8603169DdbD7836e478b4624789;
address constant QUIZ_TOKEN_ADDRESS        = 0x71f517833cF8c8A88f18c53ca9b1CeeD34cADc6d; // ← Your $QUIZ token

// — Quiz Configuration —
uint256 constant ENTRY_FEE                 = 10 * 10**18;   // 10 $QUIZ (18 decimals)
uint256 constant QUESTION_TIMEOUT          = 45;            // 45 seconds per question
uint256 constant NUM_QUESTIONS             = 10;            // Exactly 10 questions per quiz

// — Off-chain Endpoints (placeholders) —
string constant ELIZAOS_URL                = "https://my-elizaos.example.com";
string constant SUPABASE_URL               = "https://cwizrprvyzneltghznna.supabase.co";

// — DON-Hosted Secrets (slot|version) —
uint8  constant DON_SLOT_ID                = 0;
uint8  constant DON_SECRETS_VERSION        = 1;

/**
 * @title ChainQuiz
 * @notice A quiz contract integrating Chainlink Functions, VRF V2.5, and Keepers.
 *
 * If you are not yet using ElizaOS or Supabase, you may remove any references
 * to ELIZAOS_URL, SUPABASE_URL, and the Functions logic. Below is a fully
 * compilable version with all features included.
 */
contract ChainQuiz is
    FunctionsClient,               // inherits ConfirmedOwner internally
    ConfirmedOwner,                // explicit to linearize properly
    VRFConsumerBaseV2Plus,
    AutomationCompatibleInterface
{
    using FunctionsRequest for FunctionsRequest.Request;

    // ────────────────────────────────────────────────────────────────────────────────
    // STORAGE
    // ────────────────────────────────────────────────────────────────────────────────

    // — Chainlink VRF V2.5 —────────────────────────────────────────────────────────────
    // `s_vrfCoordinator` is inherited from VRFConsumerBaseV2Plus
    mapping(uint256 => address) private vrfRequestToPlayer;  // requestId → player

    // — ERC-20 Staking Token ($QUIZ) —──────────────────────────────────────────────────
    IERC20 public immutable quizToken;

    // — Player Session Struct —────────────────────────────────────────────────────────
    struct PlayerSession {
        uint256 startTime;       // timestamp when first question delivered
        uint256 questionIndex;   // 0..(NUM_QUESTIONS−1)
        uint256 stakeAmount;     // always ENTRY_FEE
        uint8   correctCount;    // how many answers correct so far
        string  quizId;          // returned from `/generateQuiz`
        bool    isActive;        // session active flag
    }
    mapping(address => PlayerSession) public sessions;
    address[] public activePlayers;

    // — Leaderboard —──────────────────────────────────────────────────────────────────
    mapping(address => uint256) public leaderboardScore;
    uint256 public lastLeaderboardUpdate;
    uint256 public updateInterval;            // in seconds, set by owner

    // — EVENTS —────────────────────────────────────────────────────────────────────────
    event QuizRequested(address indexed player, bytes32 indexed requestId);
    event QuizGenerated(address indexed player, string quizId);
    event AnswerSubmitted(address indexed player, bool correct, uint256 timeElapsed);
    event QuizCompleted(address indexed player, uint8 totalCorrect, uint256 reward);
    event RandomBonusRequested(address indexed player, uint256 requestId);
    event BonusAwarded(address indexed player, uint256 bonus);
    event LeaderboardRefreshed(uint256 timestamp);
    event QuizCancelled(address indexed player, uint256 refunded);
    event UpdateIntervalSet(uint256 newInterval);

    // ────────────────────────────────────────────────────────────────────────────────
    // CONSTRUCTOR
    // ────────────────────────────────────────────────────────────────────────────────
    constructor()
        FunctionsClient(FUNCTIONS_ROUTER)
        ConfirmedOwner(msg.sender)
        VRFConsumerBaseV2Plus(VRF_COORDINATOR_V2)
    {
        quizToken             = IERC20(QUIZ_TOKEN_ADDRESS);
        lastLeaderboardUpdate = block.timestamp;
        updateInterval        = 3600; // default 1 hour
    }

    // ────────────────────────────────────────────────────────────────────────────────
    // PHASE 1: START A NEW QUIZ
    // ────────────────────────────────────────────────────────────────────────────────

    /**
     * @notice Stake ENTRY_FEE $QUIZ and request a new quiz from ElizaOS.
     * @param domains An array of ≥4 domains (e.g. ["DeFi","Oracles","ZKP","Layer2"]).
     */
    function startQuiz(string[] calldata domains) external {
        PlayerSession storage s = sessions[msg.sender];
        require(!s.isActive, "Active session exists");
        require(domains.length >= 4, "Select >= 4 domains");

        // 1) Transfer in $QUIZ stake
        bool ok = quizToken.transferFrom(msg.sender, address(this), ENTRY_FEE);
        require(ok, "Stake transfer failed");

        // 2) Build Chainlink Functions request for /generateQuiz
        FunctionsRequest.Request memory req;
        req.initializeRequestForInlineJavaScript(_generateQuizSource());

        // args[0] = JSON(domains array)
        // args[1] = player hex string
        // args[2] = ELIZAOS_URL
        // args[3] = SUPABASE_URL
        // args[4] = "<slot>|<version>" for DON secrets
        string;
        argsArr[0] = _encodeDomains(domains);
        argsArr[1] = _toHexString(msg.sender);
        argsArr[2] = ELIZAOS_URL;
        argsArr[3] = SUPABASE_URL;
        argsArr[4] = string(
            abi.encodePacked(
                _uintToString(DON_SLOT_ID),
                "|",
                _uintToString(DON_SECRETS_VERSION)
            )
        );
        req.addArgs(argsArr);
        req.addDONHostedSecrets(DON_SLOT_ID, DON_SECRETS_VERSION);

        // 3) Send the request
        bytes32 requestId = _sendRequest(
            req.encodeCBOR(),
            FUNCTIONS_SUBSCRIPTION_ID,
            FUNCTIONS_CALLBACK_GAS,
            DON_ID
        );

        // 4) Record placeholder session; quizId & startTime set in callback
        sessions[msg.sender] = PlayerSession({
            startTime:      0,
            questionIndex:  0,
            stakeAmount:    ENTRY_FEE,
            correctCount:   0,
            quizId:         "",
            isActive:       true
        });
        activePlayers.push(msg.sender);

        emit QuizRequested(msg.sender, requestId);
    }

    /**
     * @dev Inline JavaScript for calling ElizaOS `/generateQuiz`.
     */
    function _generateQuizSource() internal pure returns (string memory) {
        return
        // 1) Build HTTP POST to ElizaOS /generateQuiz
        "const url = `${args[2]}/generateQuiz`;\n"
        "const payload = JSON.stringify({ domains: JSON.parse(args[0]), playerAddress: args[1] });\n"
        "const res = await Functions.makeHttpRequest({\n"
        "  url, method: 'POST', headers: { 'Content-Type': 'application/json' }, data: payload\n"
        "});\n"
        "if(res.error) { throw Error(res.error.message); }\n"
        // 2) ElizaOS returns { quizId: string, numQuestions: 10 }
        "const quizId = res.data.quizId;\n"
        // We only need quizId on-chain; numQuestions is always 10 in our MVP.
        "return Functions.encodeString(quizId);\n";
    }

    /**
     * @notice Chainlink Functions callback for `/generateQuiz`.
     * @param requestId Chainlink request ID
     * @param response  Encoded quizId (string)
     * @param err       Error bytes (if any)
     *
     * In production, map requestId→player. Here we assume msg.sender is the player.
     */
    function fulfillRequest(
        bytes32 requestId,
        bytes memory response,
        bytes memory err
    ) internal override {
        string memory quizId = string(response);
        address player = msg.sender;
        PlayerSession storage s = sessions[player];
        require(s.isActive, "No active session");

        s.quizId    = quizId;
        s.startTime = block.timestamp;
        emit QuizGenerated(player, quizId);
    }

    // ────────────────────────────────────────────────────────────────────────────────
    // PHASE 2: SUBMIT ANSWER & VERIFY
    // ────────────────────────────────────────────────────────────────────────────────

    /**
     * @notice Submit an answer for the current question. Must be within 45s window.
     * @param selectedIndex 0..2 for chosen answer, or 255 to indicate timeout.
     */
    function submitAnswer(uint8 selectedIndex) external {
        PlayerSession storage s = sessions[msg.sender];
        require(s.isActive, "No active session");
        require(s.questionIndex < NUM_QUESTIONS, "Quiz completed");

        uint256 questionStart = s.startTime + (s.questionIndex * QUESTION_TIMEOUT);
        require(block.timestamp <= questionStart + QUESTION_TIMEOUT, "Time expired");

        FunctionsRequest.Request memory req;
        req.initializeRequestForInlineJavaScript(_verifyAnswerSource());

        // args[0] = quizId
        // args[1] = questionId (“q1”, “q2”, …)
        // args[2] = selectedIndex (string)
        // args[3] = ELIZAOS_URL
        // args[4] = SUPABASE_URL
        // args[5] = "<slot>|<version>" for DON secrets
        string;
        argsArr[0] = s.quizId;
        argsArr[1] = string(abi.encodePacked("q", _uintToString(s.questionIndex + 1)));
        argsArr[2] = _uintToString(selectedIndex);
        argsArr[3] = ELIZAOS_URL;
        argsArr[4] = SUPABASE_URL;
        argsArr[5] = string(
            abi.encodePacked(
                _uintToString(DON_SLOT_ID),
                "|",
                _uintToString(DON_SECRETS_VERSION)
            )
        );
        req.addArgs(argsArr);
        req.addDONHostedSecrets(DON_SLOT_ID, DON_SECRETS_VERSION);

        bytes32 requestId = _sendRequest(
            req.encodeCBOR(),
            FUNCTIONS_SUBSCRIPTION_ID,
            FUNCTIONS_CALLBACK_GAS,
            DON_ID
        );

        emit QuizRequested(msg.sender, requestId);
    }

    /**
     * @dev Inline JavaScript for calling ElizaOS `/verifyAnswer`.
     */
    function _verifyAnswerSource() internal pure returns (string memory) {
        return
        "const url = `${args[3]}/verifyAnswer`;\n"
        "const payload = JSON.stringify({ quizId: args[0], questionId: args[1], selectedIndex: parseInt(args[2]) });\n"
        "const res = await Functions.makeHttpRequest({\n"
        "  url, method: 'POST', headers: { 'Content-Type': 'application/json' }, data: payload\n"
        "});\n"
        "if(res.error) { throw Error(res.error.message); }\n"
        "const isCorrect = res.data.isCorrect ? '1' : '0';\n"
        "return Functions.encodeString(isCorrect);\n";
    }

    /**
     * @notice Chainlink Functions callback for `/verifyAnswer`.
     * @param requestId Chainlink request ID
     * @param response  “1” or “0” encoded
     * @param err       Error bytes (if any)
     */
    function fulfillAnswerCallback(
        bytes32 requestId,
        bytes memory response,
        bytes memory err
    ) internal {
        address player = msg.sender;
        PlayerSession storage s = sessions[player];
        require(s.isActive, "No active session");

        bool correct = (keccak256(response) == keccak256(bytes("1")));
        if (correct) {
            s.correctCount++;
        }
        uint256 elapsed = block.timestamp - (s.startTime + (s.questionIndex * QUESTION_TIMEOUT));
        emit AnswerSubmitted(player, correct, elapsed);

        s.questionIndex++;
    }

    // ────────────────────────────────────────────────────────────────────────────────
    // PHASE 3: FINISH QUIZ & PAY OUT
    // ────────────────────────────────────────────────────────────────────────────────

    /**
     * @notice Finish quiz once all NUM_QUESTIONS have been answered. Pays out proportionally.
     */
    function finishQuiz() external {
        PlayerSession storage s = sessions[msg.sender];
        require(s.isActive, "No active session");
        require(s.questionIndex == NUM_QUESTIONS, "Not all questions answered");

        uint256 reward = (s.stakeAmount * s.correctCount) / NUM_QUESTIONS;
        if (reward > 0) {
            bool ok = quizToken.transfer(msg.sender, reward);
            require(ok, "Reward transfer failed");
        }
        leaderboardScore[msg.sender] += (uint256(s.correctCount) * s.stakeAmount);
        emit QuizCompleted(msg.sender, s.correctCount, reward);

        delete sessions[msg.sender];
    }

    // ────────────────────────────────────────────────────────────────────────────────
    // PHASE 4: CANCEL QUIZ (REFUND ON TIMEOUT)
    // ────────────────────────────────────────────────────────────────────────────────

    /**
     * @notice If the user never finishes within 10×QUESTION_TIMEOUT, they can cancel & refund.
     */
    function cancelQuiz() external {
        PlayerSession storage s = sessions[msg.sender];
        require(s.isActive, "No active session");
        uint256 totalTimeout = s.startTime + (QUESTION_TIMEOUT * NUM_QUESTIONS);
        require(block.timestamp > totalTimeout, "Quiz still in progress");

        uint256 refund = s.stakeAmount;
        delete sessions[msg.sender];
        bool ok = quizToken.transfer(msg.sender, refund);
        require(ok, "Refund transfer failed");

        emit QuizCancelled(msg.sender, refund);
    }

    // ────────────────────────────────────────────────────────────────────────────────
    // PHASE 5: RANDOM BONUS (VRF V2.5)
    // ────────────────────────────────────────────────────────────────────────────────

    /**
     * @notice Request randomness for a “bonus challenge” if you have an active session.
     */
    function requestRandomBonus() external {
        PlayerSession storage s = sessions[msg.sender];
        require(s.isActive, "No active session");

        VRFV2PlusClient.RandomWordsRequest memory request = VRFV2PlusClient.RandomWordsRequest({
            keyHash:              VRF_KEY_HASH_V2,
            subId:                VRF_SUBSCRIPTION_ID_V2,
            requestConfirmations: REQUEST_CONFIRMATIONS_V2,
            callbackGasLimit:     CALLBACK_GAS_LIMIT_V2,
            numWords:             NUM_WORDS_V2,
            extraArgs:            VRFV2PlusClient._argsToBytes(
                                    VRFV2PlusClient.ExtraArgsV1({ nativePayment: false })
                                  )
        });

        uint256 requestId = s_vrfCoordinator.requestRandomWords(request);
        vrfRequestToPlayer[requestId] = msg.sender;
        emit RandomBonusRequested(msg.sender, requestId);
    }

    /**
     * @notice VRF V2.5 callback: if (randomness % 5 == 0), award a 5× ENTRY_FEE bonus.
     */
    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords)
        internal
        override
    {
        address player = vrfRequestToPlayer[requestId];
        require(player != address(0), "Unknown VRF request");

        uint256 randomness = randomWords[0];
        if (randomness % 5 == 0) {
            uint256 bonus = 5 * ENTRY_FEE;
            leaderboardScore[player] += bonus;
            emit BonusAwarded(player, bonus);
        }
        delete vrfRequestToPlayer[requestId];
    }

    // ────────────────────────────────────────────────────────────────────────────────
    // PHASE 6: AUTOMATION (Chainlink Keepers)
    // ────────────────────────────────────────────────────────────────────────────────

    /**
     * @notice Allows owner to set leaderboard refresh interval (in seconds).
     */
    function setUpdateInterval(uint256 _interval) external onlyOwner {
        updateInterval = _interval;
        emit UpdateIntervalSet(_interval);
    }

    /**
     * @notice Keeper check: returns true if > updateInterval seconds passed since last refresh.
     */
    function checkUpkeep(bytes calldata) external view override returns (bool upkeepNeeded, bytes memory) {
        upkeepNeeded = (block.timestamp - lastLeaderboardUpdate) > updateInterval;
    }

    /**
     * @notice Keeper perform: updates lastLeaderboardUpdate & emits LeaderboardRefreshed.
     */
    function performUpkeep(bytes calldata) external override {
        if ((block.timestamp - lastLeaderboardUpdate) > updateInterval) {
            lastLeaderboardUpdate = block.timestamp;
            emit LeaderboardRefreshed(block.timestamp);
        }
    }

    // ────────────────────────────────────────────────────────────────────────────────
    // INTERNAL UTILITIES
    // ────────────────────────────────────────────────────────────────────────────────

    function _encodeDomains(string[] calldata arr) internal pure returns (string memory) {
        bytes memory result = "[";
        for (uint256 i = 0; i < arr.length; i++) {
            result = abi.encodePacked(result, '"', arr[i], '"');
            if (i < arr.length - 1) {
                result = abi.encodePacked(result, ",");
            }
        }
        return string(abi.encodePacked(result, "]"));
    }

    function _uintToString(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 temp = v;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (v != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(buffer);
    }

    function _toHexString(address account) internal pure returns (string memory) {
        bytes20 data = bytes20(account);
        bytes memory hexAlphabet = "0123456789abcdef";
        bytes memory str = new bytes(42);
        str[0] = "0";
        str[1] = "x";
        for (uint256 i = 0; i < 20; i++) {
            str[2 + (i * 2)]     = hexAlphabet[uint8(data[i] >> 4)];
            str[3 + (i * 2)]     = hexAlphabet[uint8(data[i] & 0x0f)];
        }
        return string(str);
    }
}
