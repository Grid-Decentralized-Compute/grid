// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IGridMarket {
    /// @return How many rentals the host has running right now, across all their machines.
    function activeRentalCount(address host) external view returns (uint64);
}
