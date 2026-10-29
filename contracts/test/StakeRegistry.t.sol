// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StakeRegistry} from "../src/StakeRegistry.sol";
import {MockGRID} from "../src/MockGRID.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

contract StakeRegistryTest is Test {
    MockGRID grid;
    StakeRegistry stake;

    address host = makeAddr("host");
    address sponsor = makeAddr("sponsor");
    address stranger = makeAddr("stranger");

    uint256 constant MIN_BOND = 100e18;

    function setUp() public {
        grid = new MockGRID();
        stake = new StakeRegistry(IERC20(address(grid)), MIN_BOND);
        grid.mint(host, 1000e18);
        grid.mint(sponsor, 1000e18);
        vm.prank(host);
        grid.approve(address(stake), type(uint256).max);
        vm.prank(sponsor);
        grid.approve(address(stake), type(uint256).max);
        vm.warp(1_700_000_000);
    }

    function test_bondMakesEligible() public {
        assertFalse(stake.isEligible(host));
        vm.prank(host);
        stake.bond(MIN_BOND);
        assertTrue(stake.isEligible(host));
        assertEq(stake.bonded(host), MIN_BOND);
        assertEq(grid.balanceOf(address(stake)), MIN_BOND);
    }

    function test_bondForCreditsTheHost() public {
        vm.prank(sponsor);
        stake.bondFor(host, MIN_BOND);
        assertEq(stake.bonded(host), MIN_BOND);
        assertEq(stake.bonded(sponsor), 0);
        assertTrue(stake.isEligible(host));
    }

    function test_zeroBondReverts() public {
        vm.prank(host);
        vm.expectRevert(StakeRegistry.ZeroAmount.selector);
        stake.bond(0);
    }

    function test_unbondTakesSevenDays() public {
        vm.startPrank(host);
        stake.bond(200e18);
        stake.startUnbond(150e18);
        assertEq(stake.bonded(host), 50e18);
        assertFalse(stake.isEligible(host));

        vm.expectRevert(StakeRegistry.NothingClaimable.selector);
        stake.withdraw();

        vm.warp(block.timestamp + 7 days);
        uint256 before = grid.balanceOf(host);
        stake.withdraw();
        assertEq(grid.balanceOf(host) - before, 150e18);
        vm.stopPrank();
    }

    function test_cannotUnbondMoreThanBonded() public {
        vm.startPrank(host);
        stake.bond(100e18);
        vm.expectRevert(StakeRegistry.InsufficientBond.selector);
        stake.startUnbond(101e18);
        vm.stopPrank();
    }

    function test_slashBurnsShareIncludingPendingUnbond() public {
        vm.startPrank(host);
        stake.bond(200e18);
        stake.startUnbond(100e18);
        vm.stopPrank();

        stake.slash(host, 1000, "proven fraud: fake GPU"); // 10%
        assertEq(stake.bonded(host), 90e18);
        (uint256 pending,) = stake.unbonds(host);
        assertEq(pending, 90e18);
        assertEq(grid.balanceOf(stake.BURN()), 20e18);
    }

    function test_onlySlasherCanSlash() public {
        vm.prank(host);
        stake.bond(100e18);
        vm.prank(stranger);
        vm.expectRevert(StakeRegistry.NotSlasher.selector);
        stake.slash(host, 1000, "nope");

        vm.expectRevert(StakeRegistry.BpsTooHigh.selector);
        stake.slash(host, 10_001, "too much");
    }

    function test_ownerControlsMinBondAndRoles() public {
        stake.setMinBond(0);
        assertTrue(stake.isEligible(host)); // bonding switched off

        stake.setSlasher(stranger);
        assertEq(stake.slasher(), stranger);

        vm.prank(stranger);
        vm.expectRevert(StakeRegistry.NotOwner.selector);
        stake.setMinBond(1);
    }
}
