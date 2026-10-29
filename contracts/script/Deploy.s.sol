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
/// Env (all optional):
///   GRID_TOKEN      the GRID token; MockGRID is deployed when unset.
///   MIN_BOND        GRID wei a host must bond, default 100 GRID. The bond is the Sybil gate, so
///                   off anvil the script refuses MIN_BOND=0 unless ALLOW_UNBONDED=1 is set too.
///   OWNER           starts the two-step hand-over of the StakeRegistry to this address (a
///                   multisig), which then calls acceptOwnership(). The deployer stays owner
///                   until it does.
contract Deploy is Script {
    /// @dev anvil's account #0; public and funded only on a local chain.
    uint256 constant ANVIL_DEPLOYER_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external {
        bool local = block.chainid == 31337;
        address gridToken = vm.envOr("GRID_TOKEN", address(0));
        uint256 minBond = vm.envOr("MIN_BOND", uint256(100 ether));
        if (!local && minBond == 0 && vm.envOr("ALLOW_UNBONDED", uint256(0)) != 1) {
            revert("MIN_BOND=0 switches the bond off; set ALLOW_UNBONDED=1 to deploy that way");
        }
        address owner = vm.envOr("OWNER", address(0));
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
        if (owner != address(0)) stake.transferOwnership(owner);
        vm.stopBroadcast();

        console.log("StakeRegistry:", address(stake));
        console.log("GridMarket:", address(market));
        console.log("SwarmMarket:", address(swarm));
        console.log("minBond (GRID wei):", minBond);
        if (owner != address(0)) console.log("StakeRegistry owner pending, must acceptOwnership():", owner);

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
