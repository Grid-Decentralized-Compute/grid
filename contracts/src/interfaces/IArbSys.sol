// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev The ArbSys precompile at address(100) on Arbitrum chains, Orbit chains such as
///      Robinhood Chain included. Only the call Grid needs.
interface IArbSys {
    /// @return The chain's own block number (block.number there is the parent chain's).
    function arbBlockNumber() external view returns (uint256);
}
