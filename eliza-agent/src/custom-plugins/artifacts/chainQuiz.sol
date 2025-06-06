// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// ChainQuiz.sol
// For Base Sepolia (chain ID 84531)

import { FunctionsClient } from "@chainlink/contracts/src/v0.8/functions/v1_0_0/FunctionsClient.sol";
import { ConfirmedOwner } from "@chainlink/contracts/src/v0.8/shared/access/ConfirmedOwner.sol";
import { FunctionsRequest } from "@chainlink/contracts/src/v0.8/functions/v1_0_0/libraries/FunctionsRequest.sol";

contract ChainQuiz is FunctionsClient, ConfirmedOwner {
    using FunctionsRequest for FunctionsRequest.Request;

    // ─────────────────────────────────────────────────────────────────
    // 1. CONSTANTS
    // ─────────────────────────────────────────────────────────────────
    address private constant ROUTER = 0xf9B8fc078197181C841c296C876945aaa425B278;
    bytes32 private constant DON_ID =
        hex"66756e2d626173652d7365706f6c69612d310000000000000000000000000000";
    uint32 private constant CALLBACK_GAS_LIMIT = 300000;

    // ─────────────────────────────────────────────────────────────────
    // 2. STATE & EVENTS
    // ─────────────────────────────────────────────────────────────────
    struct QuizSession {
        string quizId;
        uint8 questionIndex;
        uint256 correctCount;
        uint256 startedAt;
        bool active;
        uint8 numQuestions; // Store number of questions
    }
    mapping(address => QuizSession) public sessions;
    mapping(bytes32 => address) public requestToPlayer; // Map requestId to player address

    event QuizGenerated(address indexed player, string quizId, uint8 numQuestions);
    event AnswerSubmitted(address indexed player, bool isCorrect, uint8 questionIndex);
    event QuizCompleted(address indexed player, uint8 correctCount);
    event QuizCancelled(address indexed player);

    // ─────────────────────────────────────────────────────────────────
    // 3. CONSTRUCTOR
    // ─────────────────────────────────────────────────────────────────
    constructor() FunctionsClient(ROUTER) ConfirmedOwner(msg.sender) {}

    // ─────────────────────────────────────────────────────────────────
    // 4. HARD-CODED UTILITIES
    // ─────────────────────────────────────────────────────────────────
    function _hardcoded(string memory key) internal pure returns (string memory) {
        if (keccak256(bytes(key)) == keccak256(bytes("ELIZAOS_URL"))) {
            return "http://localhost:5000"; // Update to production URL
        }
        if (keccak256(bytes(key)) == keccak256(bytes("SUPABASE_URL"))) {
            return "https://cwizrprvyzneltghznna.supabase.co";
        }
        return "";
    }



    function _hardcodedUint(string memory key) internal pure returns (uint256) {
        if (keccak256(bytes(key)) == keccak256(bytes("DON_HOSTED_SECRETS_SLOT_ID"))) {
            return 0;
        }
        if (keccak256(bytes(key)) == keccak256(bytes("DON_HOSTED_SECRETS_VERSION"))) {
            return 1749025465;
        }
        if (keccak256(bytes(key)) == keccak256(bytes("SUBSCRIPTION_ID"))) {
            return 330;
        }
        return 0;
    }

    // ─────────────────────────────────────────────────────────────────
    // 5. INLINE JAVASCRIPT SOURCES
    // ─────────────────────────────────────────────────────────────────
    function _generateSource() internal pure returns (string memory) {
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

    function _verifySource() internal pure returns (string memory) {
        return
            "const elizaBase = args[3];"
            "const url = `${elizaBase}/verifyAnswer`; "
            "const payload = JSON.stringify({ quizId: args[0], questionId: args[1], selectedIndex: parseInt(args[2], 10) }); "
            "const res = await Functions.makeHttpRequest({ url, method: 'POST', headers: { 'Content-Type': 'application/json' }, data: payload }); "
            "if (res.error) throw new Error(res.error.message); "
            "const correct = res.data.isCorrect ? '1' : '0'; "
            "return Functions.encodeString(correct);";
    }

    // ─────────────────────────────────────────────────────────────────
    // 6. startQuiz() – builds and sends the generateQuiz request
    // ─────────────────────────────────────────────────────────────────
    function startQuiz(string[] calldata domains) external {
        require(domains.length >= 5, "Select at least 5 domains");
        QuizSession storage s = sessions[msg.sender];
        require(!s.active, "Quiz already in progress");

        // Mark session active
        s.active = true;
        s.questionIndex = 0;
        s.correctCount = 0;
        s.startedAt = block.timestamp;
        s.numQuestions = 0; // Will be set in fulfillRequest

        // Build Chainlink Functions request
        FunctionsRequest.Request memory req;
        req.initializeRequestForInlineJavaScript(_generateSource());

        // Prepare all five arguments
        string memory domainsJson = _encodeDomains(domains);
        string memory playerHex = _toHexString(msg.sender);
        string memory eliza = _hardcoded("ELIZAOS_URL");
        string memory supa = _hardcoded("SUPABASE_URL");
        string memory slotVer = string(
            abi.encodePacked(
                uint2str(_hardcodedUint("DON_HOSTED_SECRETS_SLOT_ID")), "|",
                uint2str(_hardcodedUint("DON_HOSTED_SECRETS_VERSION"))
            )
        );

        // Declare and populate args array
        string[] memory args = new string[](5);
        args[0] = domainsJson;
        args[1] = playerHex;
        args[2] = eliza;
        args[3] = supa;
        args[4] = slotVer;
        req.setArgs(args);

        // Send the request on-chain
        bytes32 requestId = _sendRequest(
            req.encodeCBOR(),
            uint64(_hardcodedUint("SUBSCRIPTION_ID")),
            CALLBACK_GAS_LIMIT,
            DON_ID
        );

        // Store requestId to player mapping
        requestToPlayer[requestId] = msg.sender;
        s.quizId = string(abi.encodePacked(requestId));
    }

    // ─────────────────────────────────────────────────────────────────
    // 7. submitAnswer() – builds and sends the verifyAnswer request
    // ─────────────────────────────────────────────────────────────────
    function submitAnswer(uint8 selectedIndex) external {
        QuizSession storage s = sessions[msg.sender];
        require(s.active, "No active quiz");
        require(block.timestamp <= s.startedAt + 450, "Time expired");

        // Build Chainlink Functions request
        FunctionsRequest.Request memory req;
        req.initializeRequestForInlineJavaScript(_verifySource());

        // Prepare all five arguments
        string memory quizIdStr = s.quizId;
        string memory qId = string(abi.encodePacked("q", uint2str(s.questionIndex + 1)));
        string memory idxStr = uint2str(selectedIndex);
        string memory eliza = _hardcoded("ELIZAOS_URL");
        string memory slotVer = string(
            abi.encodePacked(
                uint2str(_hardcodedUint("DON_HOSTED_SECRETS_SLOT_ID")), "|",
                uint2str(_hardcodedUint("DON_HOSTED_SECRETS_VERSION"))
            )
        );

        // Declare and populate args array
        string[] memory args = new string[](5);
        args[0] = quizIdStr;
        args[1] = qId;
        args[2] = idxStr;
        args[3] = eliza;
        args[4] = slotVer;
        req.setArgs(args);

        // Send the request on-chain
        bytes32 requestId = _sendRequest(
            req.encodeCBOR(),
            uint64(_hardcodedUint("SUBSCRIPTION_ID")),
            CALLBACK_GAS_LIMIT,
            DON_ID
        );

        // Store requestId to player mapping
        requestToPlayer[requestId] = msg.sender;
    }

    // ─────────────────────────────────────────────────────────────────
    // 8. cancelQuiz() – refund placeholder
    // ─────────────────────────────────────────────────────────────────
    function cancelQuiz() external {
        QuizSession storage s = sessions[msg.sender];
        require(s.active, "No active quiz");
        require(block.timestamp > s.startedAt + 450, "Too early to cancel");

        s.active = false;
        emit QuizCancelled(msg.sender);
        // TODO: refund 10 $QUIZ tokens to msg.sender
    }

    // ─────────────────────────────────────────────────────────────────
    // 9. fulfillRequest() – handles both generateQuiz and verifyAnswer callbacks
    // ─────────────────────────────────────────────────────────────────
    function fulfillRequest(
        bytes32 requestId,
        bytes memory response,
        bytes memory /*err*/
    ) internal override {
        // Retrieve player address from requestId
        address player = requestToPlayer[requestId];
        require(player != address(0), "Invalid request ID");
        QuizSession storage s = sessions[player];
        string memory reqStr = string(abi.encodePacked(requestId));

        if (keccak256(bytes(reqStr)) == keccak256(bytes(s.quizId))) {
            // If questionIndex == 0, it’s the generateQuiz callback
            if (s.questionIndex == 0) {
                (string memory realQuizId, uint256 numQ) = _parseQuizResponse(string(response));
                s.quizId = realQuizId;
                s.numQuestions = uint8(numQ); // Store number of questions
                emit QuizGenerated(player, realQuizId, uint8(numQ));
            } else {
                // Otherwise, it’s the verifyAnswer callback
                bool isCorrect = (uint8(bytes(string(response))[0]) == uint8(bytes("1")[0]));
                if (isCorrect) {
                    s.correctCount++;
                }
                emit AnswerSubmitted(player, isCorrect, s.questionIndex);
                s.questionIndex++;
                if (s.questionIndex >= s.numQuestions) {
                    s.active = false;
                    emit QuizCompleted(player, uint8(s.correctCount));
                    // TODO: transfer reward tokens to player
                }
            }
        }

        // Clean up request mapping
        delete requestToPlayer[requestId];
    }

    // ─────────────────────────────────────────────────────────────────
    // 10. UTILITY FUNCTIONS
    // ─────────────────────────────────────────────────────────────────
    function _encodeDomains(string[] calldata domains) internal pure returns (string memory) {
        string memory json = "[";
        for (uint256 i = 0; i < domains.length; i++) {
            json = string(abi.encodePacked(json, '"', domains[i], '"'));
            if (i < domains.length - 1) {
                json = string(abi.encodePacked(json, ","));
            }
        }
        return string(abi.encodePacked(json, "]"));
    }

    function _parseQuizResponse(string memory resp) internal pure returns (string memory, uint256) {
        bytes memory b = bytes(resp);
        uint256 sepIndex = 0;
        while (sepIndex < b.length && b[sepIndex] != "|") {
            sepIndex++;
        }
        string memory quizIdStr = string(_slice(b, 0, sepIndex));
        uint256 numQ = _atoi(string(_slice(b, sepIndex + 1, b.length - (sepIndex + 1))));
        return (quizIdStr, numQ);
    }

    function _slice(
        bytes memory data,
        uint256 start,
        uint256 len
    ) internal pure returns (bytes memory) {
        bytes memory ret = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            ret[i] = data[start + i];
        }
        return ret;
    }

    function _atoi(string memory s) internal pure returns (uint256) {
        bytes memory b = bytes(s);
        uint256 result = 0;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] >= "0" && b[i] <= "9") {
                result = result * 10 + (uint8(b[i]) - uint8(bytes1("0")));
            }
        }
        return result;
    }

    function _toHexString(address addr) internal pure returns (string memory) {
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

    function uint2str(uint256 v) internal pure returns (string memory) {
        if (v == 0) {
            return "0";
        }
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
