// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IStakeRegistry {
    /// @return true when the host has at least the minimum bond locked.
    function isEligible(address host) external view returns (bool);
}
