// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev The ERC-20 surface Grid needs. The real GRID token is deployed by the
///      Creora launchpad (Pons v2); Grid never deploys it on mainnet.
interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
