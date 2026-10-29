// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {GridMarket} from "../src/GridMarket.sol";
import {StakeRegistry} from "../src/StakeRegistry.sol";
import {MockGRID} from "../src/MockGRID.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {IStakeRegistry} from "../src/interfaces/IStakeRegistry.sol";

/// @notice Deploys the Grid contracts and writes deployments/<chainId>.json.
///
/// Local:    forge script script/Deploy.s.sol --rpc-url anvil --broadcast --private-key <anvil key>
/// Testnet:  forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast --interactive
/// Mainnet:  set GRID_TOKEN to the GRID address Creora launched, then the same with --rpc-url robinhood
///
/// Env (all optional): GRID_TOKEN (skip MockGRID), MIN_BOND in GRID wei. MIN_BOND defaults to
/// 100 GRID on a local anvil chain so the bond flow can be tried, and to 0 (bonding off) elsewhere:
/// bonded listings only open once the real GRID exists and the StakeRegistry is audited.
contract Deploy is Script {
    function run() external {
        address gridToken = vm.envOr("GRID_TOKEN", address(0));
        uint256 minBond = vm.envOr("MIN_BOND", block.chainid == 31337 ? 100 ether : 0);

        vm.startBroadcast();
        if (gridToken == address(0)) {
            gridToken = address(new MockGRID());
            console.log("MockGRID:", gridToken);
        }
        StakeRegistry stake = new StakeRegistry(IERC20(gridToken), minBond);
        GridMarket market = new GridMarket(IStakeRegistry(address(stake)));
        vm.stopBroadcast();

        console.log("StakeRegistry:", address(stake));
        console.log("GridMarket:", address(market));

        string memory json = "deployment";
        vm.serializeAddress(json, "GRID", gridToken);
        vm.serializeAddress(json, "StakeRegistry", address(stake));
        string memory out = vm.serializeAddress(json, "GridMarket", address(market));
        vm.writeJson(out, string.concat("deployments/", vm.toString(block.chainid), ".json"));
    }
}
