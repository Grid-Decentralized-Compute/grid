// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Allowance} from "./Allowance.sol";

/// @title AllowanceFactory — sets up an Allowance for an agent in one transaction.
/// @notice The caller becomes the owner of the new wallet and the ETH sent along is its first
///         funding. Created indexes wallets by owner and by agent, so an agent can find the
///         wallet it spends from. Nobody operates this contract and it holds nothing.
contract AllowanceFactory {
    event Created(address indexed owner, address indexed agent, address allowance);

    /// @notice Deploy an Allowance owned by msg.sender that lets `agent` send at most `dailyCap`
    ///         wei per UTC day to `targets`, funded with msg.value.
    function create(address agent, uint256 dailyCap, address[] calldata targets)
        external
        payable
        returns (Allowance allowance)
    {
        allowance = new Allowance{value: msg.value}(msg.sender, agent, dailyCap, targets);
        emit Created(msg.sender, agent, address(allowance));
    }
}
