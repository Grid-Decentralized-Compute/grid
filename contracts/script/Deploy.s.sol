// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {GridMarket} from "../src/GridMarket.sol";
import {StakeRegistry} from "../src/StakeRegistry.sol";
import {SwarmMarket} from "../src/SwarmMarket.sol";
import {MockGRID} from "../src/MockGRID.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {IStakeRegistry} from "../src/interfaces/IStakeRegistry.sol";

/// @notice Deploys the Grid contracts and writes deployments/<chainId>.json.
///
/// Local:    npm run deploy:local            (anvil account #0, nothing to configure)
/// Testnet:  put PRIVATE_KEY=0x... in contracts/.env (forge loads it), fund that address at the
///           faucet, then npm run deploy:testnet
/// Mainnet:  also set GRID_TOKEN to the GRID address Creora launched, then npm run deploy:mainnet
///
/// Env (all optional): GRID_TOKEN (skip MockGRID), MIN_BOND in GRID wei. MIN_BOND defaults to
/// 100 GRID on a local anvil chain so the bond flow can be tried, and to 0 (bonding off) elsewhere:
/// bonded listings only open once the real GRID exists and the StakeRegistry is audited.
contract Deploy is Script {
    /// @dev anvil's account #0; public and funded only on a local chain.
    uint256 constant ANVIL_DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external {
        bool local = block.chainid == 31337;
        address gridToken = vm.envOr("GRID_TOKEN", address(0));
        uint256 minBond = vm.envOr("MIN_BOND", local ? 100 ether : 0);
        uint256 deployerKey = local ? ANVIL_DEPLOYER_KEY : vm.envUint("PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        if (gridToken == address(0)) {
            gridToken = address(new MockGRID());
            console.log("MockGRID:", gridToken);
        }
        StakeRegistry stake = new StakeRegistry(IERC20(gridToken), minBond);
        GridMarket market = new GridMarket(IStakeRegistry(address(stake)));
        SwarmMarket swarm = new SwarmMarket(IStakeRegistry(address(stake)));
        stake.setMarket(address(market));
        vm.stopBroadcast();

        console.log("StakeRegistry:", address(stake));
        console.log("GridMarket:", address(market));
        console.log("SwarmMarket:", address(swarm));

        // Only record addresses that were actually sent to the chain; a dry run keeps the old file.
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            string memory json = "deployment";
            vm.serializeAddress(json, "GRID", gridToken);
            vm.serializeAddress(json, "StakeRegistry", address(stake));
            vm.serializeAddress(json, "SwarmMarket", address(swarm));
            string memory out = vm.serializeAddress(json, "GridMarket", address(market));
            vm.writeJson(out, string.concat("deployments/", vm.toString(block.chainid), ".json"));
        } else {
            console.log("dry run: deployments/<chainId>.json not written");
        }
    }
}
