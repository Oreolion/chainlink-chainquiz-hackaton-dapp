// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// ChainQuiz.sol for Base Sepolia (chain ID 84532)

import {FunctionsClient} from "@chainlink/contracts@1.2.0/src/v0.8/functions/v1_0_0/FunctionsClient.sol";
import {ConfirmedOwner} from "@chainlink/contracts@1.2.0/src/v0.8/shared/access/ConfirmedOwner.sol";
import {FunctionsRequest} from "@chainlink/contracts@1.2.0/src/v0.8/functions/v1_0_0/libraries/FunctionsRequest.sol";
import {IERC20} from "@openzeppelin/contracts@4.9.6/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts@4.9.6/security/ReentrancyGuard.sol";

interface IVRFConsumer {
    function requestRandomWords(address requester) external returns (uint256 requestId);
    function getRequestStatus(uint256 requestId)
        external
        view
        returns (bool fulfilled, uint256[] memory randomWords, address requester);
}

// ChainQuiz with VRFConsumer and ELIZA integration
contract ChainQuiz is FunctionsClient, ConfirmedOwner, ReentrancyGuard {
    using FunctionsRequest for FunctionsRequest.Request;

    // ─────────────────────────────────────────────────────────────────
    // 1. CONSTANTS AND IMMUTABLES
    // ─────────────────────────────────────────────────────────────────
    address private immutable FUNCTIONS_ROUTER = 0xf9B8fc078197181C841c296C876945aaa425B278;
    bytes32 private immutable DON_ID = hex"66756e2d626173652d7365706f6c69612d310000000000000000000000000000";
    uint32 private constant FUNCTIONS_CALLBACK_GAS_LIMIT = 300000;

    IERC20 private immutable quizToken;
    IVRFConsumer private immutable vrfConsumer;
    uint64 private immutable functionsSubscriptionId;
    uint256 private constant ENTRY_FEE = 10 ether; // 10 $QUIZ
    uint256 private constant REWARD_PER_QUESTION = 2 ether; // 2 $QUIZ per correct answer
    uint256 private constant MAX_QUIZ_DURATION = 450; // 7.5 minutes
    uint8 private constant MAX_QUESTIONS = 10;

    // ─────────────────────────────────────────────────────────────────
    // 2. STATE AND EVENTS
    // ─────────────────────────────────────────────────────────────────
    struct QuizSession {
        string quizId;
        uint8 questionIndex;
        uint256 correctCount;
        uint256 startedAt;
        bool active;
        uint8 numQuestions;
        uint256 vrfRequestId;
    }
    mapping(address => QuizSession) public sessions;
    mapping(bytes32 => address) public functionsRequestToPlayer;
    string[] public availableDomains;

    event QuizGenerated(address indexed player, string quizId, uint8 numQuestions);
    event AnswerSubmitted(address indexed player, bool isCorrect, uint8 questionIndex);
    event QuizCompleted(address indexed player, uint8 correctCount);
    event QuizCancelled(address indexed player, uint256 refundAmount);
    event VRFRequestInitiated(uint256 indexed requestId, address indexed player);

    // ─────────────────────────────────────────────────────────────────
    // 3. CONSTRUCTOR
    // ─────────────────────────────────────────────────────────────────
    constructor(
        address _quizToken,
        address _vrfConsumer,
        uint64 _functionsSubscriptionId
    )
        FunctionsClient(FUNCTIONS_ROUTER)
        ConfirmedOwner(msg.sender)
    {
        require(_quizToken != address(0), "Invalid token address");
        require(_vrfConsumer != address(0), "Invalid VRF consumer address");
        quizToken = IERC20(_quizToken);
        vrfConsumer = IVRFConsumer(_vrfConsumer);
        functionsSubscriptionId = _functionsSubscriptionId;
        availableDomains = [
            "DeFi",
            "Oracles",
            "Layer2",
            "Tokenomics",
            "ZeroKnowledge",
            "NFT",
            "CrossChain",
            "Governance",
            "DAOs",
            "SmartContracts",
            "WalletSecurity",
            "Stablecoins",
            "Chainlink",
            "CCIP",
            "VRF",
            "Automation",
            "DataFeeds"
        ];
    }

    // ─────────────────────────────────────────────────────────────────
    // 4. QUIZ MANAGEMENT
    // ─────────────────────────────────────────────────────────────────
    function startQuiz(string[] calldata domains) external nonReentrant {
        require(domains.length >= 5, "Select at least 5 domains");
        require(_areValidDomains(domains), "Invalid domains provided");
        QuizSession storage session = sessions[msg.sender];
        require(!session.active, "Quiz already in progress");

        // Collect entry fee
        require(quizToken.balanceOf(msg.sender) >= ENTRY_FEE, "Insufficient $QUIZ balance");
        require(quizToken.allowance(msg.sender, address(this)) >= ENTRY_FEE, "Insufficient $QUIZ allowance");
        quizToken.transferFrom(msg.sender, address(this), ENTRY_FEE);

        // Initialize session
        session.active = true;
        session.questionIndex = 0;
        session.correctCount = 0;
        session.startedAt = block.timestamp;
        session.numQuestions = MAX_QUESTIONS;

        // Request randomness
        uint256 requestId = vrfConsumer.requestRandomWords(msg.sender);
        session.vrfRequestId = requestId;
        session.quizId = string(abi.encodePacked("temp_", uint2str(requestId)));
        emit VRFRequestInitiated(requestId, msg.sender);
    }

    function checkVRFAndGenerateQuiz(uint256 vrfRequestId) external nonReentrant {
        QuizSession storage session = sessions[msg.sender];
        require(session.active, "No active quiz");
        require(session.vrfRequestId == vrfRequestId, "Invalid VRF request ID");

        (bool fulfilled, uint256[] memory randomWords, address requester) = vrfConsumer.getRequestStatus(vrfRequestId);
        require(fulfilled, "VRF request not fulfilled");
        require(requester == msg.sender, "Invalid requester");

        // Generate quizId
        string memory quizId = string(abi.encodePacked("quiz_", uint2str(randomWords[0] % 10**8)));
        session.quizId = quizId;

        // Trigger Functions request
        FunctionsRequest.Request memory req;
        req.initializeRequestForInlineJavaScript(_generateSource());

        string[] memory selectedDomains = _selectRandomDomains(randomWords[0], session.numQuestions);
        string[] memory args = new string[](5);
        args[0] = _encodeDomains(selectedDomains);
        args[1] = _toHexString(msg.sender);
        args[2] = _getElizaUrl();
        args[3] = _getSupabaseUrl();
        args[4] = _getSlotVersion();
        req.setArgs(args);

        bytes32 functionsRequestId = _sendRequest(
            req.encodeCBOR(),
            functionsSubscriptionId,
            FUNCTIONS_CALLBACK_GAS_LIMIT,
            DON_ID
        );
        functionsRequestToPlayer[functionsRequestId] = msg.sender;
    }

    function submitAnswer(uint8 selectedIndex) external nonReentrant {
        QuizSession storage session = sessions[msg.sender];
        require(session.active, "No active quiz");
        require(block.timestamp <= session.startedAt + MAX_QUIZ_DURATION, "Quiz time expired");
        require(selectedIndex < 4 || selectedIndex == 255, "Invalid answer index");

        FunctionsRequest.Request memory req;
        req.initializeRequestForInlineJavaScript(_verifySource());

        string[] memory args = new string[](5);
        args[0] = session.quizId;
        args[1] = string(abi.encodePacked("q", uint2str(session.questionIndex + 1)));
        args[2] = uint2str(selectedIndex);
        args[3] = _getElizaUrl();
        args[4] = _getSlotVersion();
        req.setArgs(args);

        bytes32 requestId = _sendRequest(
            req.encodeCBOR(),
            functionsSubscriptionId,
            FUNCTIONS_CALLBACK_GAS_LIMIT,
            DON_ID
        );
        functionsRequestToPlayer[requestId] = msg.sender;
    }

    function cancelQuiz() external nonReentrant {
        QuizSession storage session = sessions[msg.sender];
        require(session.active, "No active quiz");
        require(block.timestamp > session.startedAt + MAX_QUIZ_DURATION, "Too early to cancel");

        uint256 refund = ENTRY_FEE;
        session.active = false;
        quizToken.transfer(msg.sender, refund);
        emit QuizCancelled(msg.sender, refund);
        delete sessions[msg.sender];
    }

    // ─────────────────────────────────────────────────────────────────
    // 5. CHAINLINK FUNCTIONS CALLBACK
    // ─────────────────────────────────────────────────────────────────
    function fulfillRequest(bytes32 requestId, bytes memory response, bytes memory /*err*/) internal override {
        address player = functionsRequestToPlayer[requestId];
        require(player != address(0), "Invalid Functions request ID");
        QuizSession storage session = sessions[player];
        require(session.active, "No active quiz");

        if (session.questionIndex == 0) {
            (string memory realQuizId, uint256 numQ) = _parseQuizResponse(string(response));
            session.quizId = realQuizId;
            session.numQuestions = uint8(numQ > MAX_QUESTIONS ? MAX_QUESTIONS : numQ);
            emit QuizGenerated(player, realQuizId, session.numQuestions);
        } else {
            bool isCorrect = (uint8(bytes(string(response))[0]) == uint8(bytes("1")[0]));
            if (isCorrect) {
                session.correctCount++;
            }
            emit AnswerSubmitted(player, isCorrect, session.questionIndex);
            session.questionIndex++;

            if (session.questionIndex >= session.numQuestions) {
                session.active = false;
                uint256 reward = session.correctCount * REWARD_PER_QUESTION;
                if (reward > 0) {
                    quizToken.transfer(player, reward);
                }
                emit QuizCompleted(player, uint8(session.correctCount));
                delete sessions[player];
            }
        }

        delete functionsRequestToPlayer[requestId];
    }

    // ─────────────────────────────────────────────────────────────────
    // 6. UTILITY FUNCTIONS
    // ─────────────────────────────────────────────────────────────────
    function _generateSource() private pure returns (string memory) {
        return
            "const elizaBase = args[2];"
            "const url = `${elizaBase}/generateQuiz`; "
            "const payload = JSON.stringify({ domains: JSON.parse(args[0]), playerAddress: args[1] }); "
            "const res = await Functions.makeHttpRequest({ url, method: 'POST', headers: { 'Content-Type': 'application/json' }, data: payload }); "
            "if (res.error) throw new Error(res.error.message); "
            "const quizId = res.data.quizId; "
            "const numQ = res.data.numQuestions; "
            "return Functions.encodeString(`${quizId}|${numQ}`);";
    }

    function _verifySource() private pure returns (string memory) {
        return
            "const elizaBase = args[3];"
            "const url = `${elizaBase}/verifyAnswer`; "
            "const payload = JSON.stringify({ quizId: args[0], questionId: args[1], selectedIndex: parseInt(args[2], 10) }); "
            "const res = await Functions.makeHttpRequest({ url, method: 'POST', headers: { 'Content-Type': 'application/json' }, data: payload }); "
            "if (res.error) throw new Error(res.error.message); "
            "const correct = res.data.isCorrect ? '1' : '0'; "
            "return Functions.encodeString(correct);";
    }

    function _getElizaUrl() private pure returns (string memory) {
        return "http://localhost:5000"; // TODO: Update to production URL
    }

    function _getSupabaseUrl() private pure returns (string memory) {
        return "https://cwizrprvyzneltghznna.supabase.co";
    }

    function _getSlotVersion() private pure returns (string memory) {
        return "0|1749025465"; // TODO: Update with actual DON secrets
    }

    function _selectRandomDomains(uint256 randomWord, uint8 numQuestions) private view returns (string[] memory) {
        string[] memory result = new string[](numQuestions);
        uint256 len = availableDomains.length;
        for (uint8 i = 0; i < numQuestions; i++) {
            uint256 index = (randomWord >> (i * 8)) % len;
            result[i] = availableDomains[index];
        }
        return result;
    }

    function _areValidDomains(string[] calldata domains) private view returns (bool) {
        for (uint256 i = 0; i < domains.length; i++) {
            bool found = false;
            for (uint256 j = 0; j < availableDomains.length; j++) {
                if (keccak256(bytes(domains[i])) == keccak256(bytes(availableDomains[j]))) {
                    found = true;
                    break;
                }
            }
            if (!found) return false;
        }
        return true;
    }

    function _encodeDomains(string[] memory domains) private pure returns (string memory) {
        string memory json = "[";
        for (uint256 i = 0; i < domains.length; i++) {
            json = string(abi.encodePacked(json, '"', domains[i], '"'));
            if (i < domains.length - 1) {
                json = string(abi.encodePacked(json, ","));
            }
        }
        return string(abi.encodePacked(json, "]"));
    }

    function _parseQuizResponse(string memory resp) private pure returns (string memory, uint256) {
        bytes memory b = bytes(resp);
        uint256 sepIndex = 0;
        while (sepIndex < b.length && b[sepIndex] != "|") {
            sepIndex++;
        }
        string memory quizIdStr = string(_slice(b, 0, sepIndex));
        uint256 numQ = _atoi(string(_slice(b, sepIndex + 1, b.length - (sepIndex + 1))));
        return (quizIdStr, numQ);
    }

    function _slice(bytes memory data, uint256 start, uint256 len) private pure returns (bytes memory) {
        bytes memory ret = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            ret[i] = data[start + i];
        }
        return ret;
    }

    function _atoi(string memory s) private pure returns (uint256) {
        bytes memory b = bytes(s);
        uint256 result = 0;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] >= "0" && b[i] <= "9") {
                result = result * 10 + (uint8(b[i]) - uint8(bytes1("0")));
            }
        }
        return result;
    }

    function _toHexString(address addr) private pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory dataBytes = new bytes(42);
        dataBytes[0] = "0";
        dataBytes[1] = "x";
        for (uint256 i = 0; i < 20; i++) {
            dataBytes[2 + i * 2] = alphabet[uint8(uint160(addr) / (16 ** (39 - i * 2)) & 0xf)];
            dataBytes[3 + i * 2] = alphabet[uint8(uint160(addr) / (16 ** (38 - i * 2)) & 0xf)];
        }
        return string(dataBytes);
    }

    function uint2str(uint256 v) private pure returns (string memory) {
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
}