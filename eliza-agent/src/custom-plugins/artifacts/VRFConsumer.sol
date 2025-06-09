// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts@1.2.0/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts@1.2.0/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {ConfirmedOwner} from "@chainlink/contracts@1.2.0/src/v0.8/shared/access/ConfirmedOwner.sol";

// VRFConsumer for ChainQuiz on Base Sepolia (chain ID 84532)
contract VRFConsumer is VRFConsumerBaseV2Plus {
    // ─────────────────────────────────────────────────────────────────
    // 1. CONSTANTS
    // ─────────────────────────────────────────────────────────────────
    bytes32 private constant KEY_HASH = 0x9e1344a1247c8a1785d0a4681a27152bffdb43666ae5bf7d14d24a5efd44bf71;
    uint32 private constant CALLBACK_GAS_LIMIT = 100000;
    uint16 private constant REQUEST_CONFIRMATIONS = 3;
    uint32 private constant NUM_WORDS = 1;

    // ─────────────────────────────────────────────────────────────────
    // 2. STATE AND EVENTS
    // ─────────────────────────────────────────────────────────────────
    uint256 public s_subscriptionId;
    struct RequestStatus {
        bool fulfilled;
        bool exists;
        uint256[] randomWords;
        address requester;
    }
    mapping(uint256 => RequestStatus) public requests;
    uint256[] public requestIds;
    uint256 public lastRequestId;

    event RequestSent(uint256 indexed requestId, address indexed requester);
    event RequestFulfilled(uint256 indexed requestId, uint256[] randomWords);

    // ─────────────────────────────────────────────────────────────────
    // 3. CONSTRUCTOR
    // ─────────────────────────────────────────────────────────────────
    constructor(uint256 subscriptionId)
        VRFConsumerBaseV2Plus(0x5C210eF41CD1a72de73bF76eC39637bB0d3d7BEE) // Base Sepolia VRF Coordinator
    {
        s_subscriptionId = subscriptionId;
    }

    // ─────────────────────────────────────────────────────────────────
    // 4. VRF FUNCTIONS
    // ─────────────────────────────────────────────────────────────────
    function requestRandomWords(address requester) external returns (uint256 requestId) {
        require(requester != address(0), "Invalid requester address");

        requestId = s_vrfCoordinator.requestRandomWords(
            VRFV2PlusClient.RandomWordsRequest({
                keyHash: KEY_HASH,
                subId: s_subscriptionId,
                requestConfirmations: REQUEST_CONFIRMATIONS,
                callbackGasLimit: CALLBACK_GAS_LIMIT,
                numWords: NUM_WORDS,
                extraArgs: VRFV2PlusClient._argsToBytes(
                    VRFV2PlusClient.ExtraArgsV1({nativePayment: true})
                )
            })
        );

        requests[requestId] = RequestStatus({
            randomWords: new uint256[](0),
            exists: true,
            fulfilled: false,
            requester: requester
        });
        requestIds.push(requestId);
        lastRequestId = requestId;

        emit RequestSent(requestId, requester);
        return requestId;
    }

    function fulfillRandomWords(uint256 _requestId, uint256[] calldata _randomWords) internal override {
        require(requests[_requestId].exists, "Request not found");
        requests[_requestId].fulfilled = true;
        requests[_requestId].randomWords = _randomWords;
        emit RequestFulfilled(_requestId, _randomWords);
    }

    function getRequestStatus(uint256 _requestId)
        external
        view
        returns (bool fulfilled, uint256[] memory randomWords, address requester)
    {
        require(requests[_requestId].exists, "Request not found");
        RequestStatus memory request = requests[_requestId];
        return (request.fulfilled, request.randomWords, request.requester);
    }
}