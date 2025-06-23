// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts@1.2.0/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts@1.2.0/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

interface IChainQuiz {
  function processVRFResponse(uint256 requestId, uint256 randomWord) external;
}

contract VRFConsumer is VRFConsumerBaseV2Plus {
  bytes32 private constant KEY_HASH           = 0x9e1344a1247c8a1785d0a4681a27152bffdb43666ae5bf7d14d24a5efd44bf71;
  uint32  private constant CALLBACK_GAS_LIMIT = 7_500_000;  // should cover a simple mapping + event
  uint16  private constant REQUEST_CONFIRMATIONS = 3;
  uint32  private constant NUM_WORDS          = 1;

  uint256 public s_subscriptionId;
  struct RequestStatus {
    bool fulfilled;
    bool exists;
    uint256 randomWord;
    address requester;
  }
  mapping(uint256 => RequestStatus) public s_requests;
  uint256[] public requestIds;
  uint256 public lastRequestId;

  event RequestSent(uint256 indexed requestId, address indexed requester);
  event RequestFulfilled(uint256 indexed requestId, uint256 randomWord);
  event VRFCallbackFailed(uint256 indexed requestId, string reason);

  constructor(address vrfCoordinator, uint256 subscriptionId)
    VRFConsumerBaseV2Plus(vrfCoordinator)
  {
    s_subscriptionId = subscriptionId;
  }

  function requestRandomWords(address requester) external returns (uint256 requestId) {
    require(requester != address(0), "Invalid requester");
    requestId = s_vrfCoordinator.requestRandomWords(
      VRFV2PlusClient.RandomWordsRequest({
        keyHash:           KEY_HASH,
        subId:             s_subscriptionId,
        requestConfirmations: REQUEST_CONFIRMATIONS,
        callbackGasLimit:  CALLBACK_GAS_LIMIT,
        numWords:          NUM_WORDS,
        extraArgs:         VRFV2PlusClient._argsToBytes(
                              VRFV2PlusClient.ExtraArgsV1({ nativePayment: true })
                           )
      })
    );

    s_requests[requestId] = RequestStatus({
      fulfilled:   false,
      exists:      true,
      randomWord:  0,
      requester:   requester
    });
    requestIds.push(requestId);
    lastRequestId = requestId;

    emit RequestSent(requestId, requester);
    return requestId;
  }

  function fulfillRandomWords(uint256 requestId, uint256[] calldata words) internal override {
    RequestStatus storage rs = s_requests[requestId];
    require(rs.exists, "Unknown request");

    rs.fulfilled  = true;
    rs.randomWord = words[0];
    emit RequestFulfilled(requestId, words[0]);

    // Forward to ChainQuiz – only a single uint, no strings
    try IChainQuiz(rs.requester).processVRFResponse(requestId, words[0]) {
    } catch Error(string memory reason) {
      emit VRFCallbackFailed(requestId, reason);
    }
  }

  function getRequestStatus(uint256 requestId)
    external view
    returns (bool, uint256, address)
  {
    RequestStatus storage rs = s_requests[requestId];
    require(rs.exists, "Request not found");
    return (rs.fulfilled, rs.randomWord, rs.requester);
  }
}
