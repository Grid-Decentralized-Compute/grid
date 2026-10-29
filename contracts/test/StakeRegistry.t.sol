// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StakeRegistry} from "../src/StakeRegistry.sol";
import {MockGRID} from "../src/MockGRID.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";

/// @dev A token that keeps 1% of every transfer.
contract FeeGRID {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        uint256 fee = amount / 100;
        balanceOf[from] -= amount;
        balanceOf[address(0xfee)] += fee;
        balanceOf[to] += amount - fee;
    }
}

contract StakeRegistryTest is Test {
    MockGRID grid;
    StakeRegistry stake;

    address host = makeAddr("host");
    address sponsor = makeAddr("sponsor");
    address stranger = makeAddr("stranger");
    address multisig = makeAddr("multisig");

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

    function test_feeOnTransferTokenIsRefused() public {
        FeeGRID fee = new FeeGRID();
        StakeRegistry feeStake = new StakeRegistry(IERC20(address(fee)), MIN_BOND);
        fee.mint(host, 1000e18);
        vm.startPrank(host);
        fee.approve(address(feeStake), type(uint256).max);
        vm.expectRevert(StakeRegistry.AmountMismatch.selector);
        feeStake.bond(MIN_BOND);
        vm.expectRevert(StakeRegistry.AmountMismatch.selector);
        feeStake.bondFor(sponsor, MIN_BOND);
        vm.stopPrank();
        assertEq(feeStake.bonded(host), 0);
        assertEq(fee.balanceOf(address(feeStake)), 0);
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

    // ---------------------------------------------------------------- slashing

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
    }

    function test_slashCappedAtHalf() public {
        vm.prank(host);
        stake.bond(100e18);
        vm.expectRevert(StakeRegistry.BpsTooHigh.selector);
        stake.slash(host, 5001, "too much");
        vm.expectRevert(StakeRegistry.BpsTooHigh.selector);
        stake.slash(host, 10_000, "everything");

        stake.slash(host, 5000, "half");
        assertEq(stake.bonded(host), 50e18);
        assertEq(grid.balanceOf(stake.BURN()), 50e18);
    }

    // ---------------------------------------------------------------- ownership

    function test_ownershipMovesInTwoSteps() public {
        vm.prank(stranger);
        vm.expectRevert(StakeRegistry.NotOwner.selector);
        stake.transferOwnership(stranger);

        stake.transferOwnership(multisig);
        assertEq(stake.owner(), address(this)); // nothing changes until accepted
        assertEq(stake.pendingOwner(), multisig);

        vm.prank(stranger);
        vm.expectRevert(StakeRegistry.NotPendingOwner.selector);
        stake.acceptOwnership();

        vm.prank(multisig);
        stake.acceptOwnership();
        assertEq(stake.owner(), multisig);
        assertEq(stake.pendingOwner(), address(0));

        vm.expectRevert(StakeRegistry.NotOwner.selector);
        stake.proposeMinBond(0);
        vm.prank(multisig);
        stake.proposeMinBond(0);
    }

    function test_pendingOwnershipTransferCanBeCancelled() public {
        stake.transferOwnership(multisig);
        stake.transferOwnership(address(0));
        vm.prank(multisig);
        vm.expectRevert(StakeRegistry.NotPendingOwner.selector);
        stake.acceptOwnership();
        assertEq(stake.owner(), address(this));
    }

    function test_marketCanBeSetOnlyOnce() public {
        vm.prank(stranger);
        vm.expectRevert(StakeRegistry.NotOwner.selector);
        stake.setMarket(address(0xbeef));

        vm.expectRevert(StakeRegistry.ZeroAddress.selector);
        stake.setMarket(address(0));

        stake.setMarket(address(0xbeef));
        assertEq(stake.market(), address(0xbeef));

        vm.expectRevert(StakeRegistry.MarketAlreadySet.selector);
        stake.setMarket(address(0xcafe));
        assertEq(stake.market(), address(0xbeef));
    }

    // ---------------------------------------------------------------- timelocked changes

    function test_minBondChangeIsTimelocked() public {
        vm.prank(stranger);
        vm.expectRevert(StakeRegistry.NotOwner.selector);
        stake.proposeMinBond(0);

        vm.expectRevert(StakeRegistry.NothingProposed.selector);
        stake.applyMinBond();

        stake.proposeMinBond(0);
        assertEq(stake.pendingMinBondAt(), block.timestamp + stake.CHANGE_DELAY());
        vm.warp(block.timestamp + stake.CHANGE_DELAY() - 1);
        vm.expectRevert(StakeRegistry.TooEarly.selector);
        stake.applyMinBond();
        assertFalse(stake.isEligible(host));

        vm.warp(block.timestamp + 1);
        vm.prank(stranger);
        vm.expectRevert(StakeRegistry.NotOwner.selector);
        stake.applyMinBond();
        stake.applyMinBond();
        assertEq(stake.minBond(), 0);
        assertTrue(stake.isEligible(host)); // bonding switched off
        assertEq(stake.pendingMinBondAt(), 0);

        vm.expectRevert(StakeRegistry.NothingProposed.selector);
        stake.applyMinBond();
    }

    function test_newProposalRestartsTheClock() public {
        stake.proposeMinBond(1);
        vm.warp(block.timestamp + stake.CHANGE_DELAY() - 1);
        stake.proposeMinBond(2);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(StakeRegistry.TooEarly.selector);
        stake.applyMinBond();
        vm.warp(block.timestamp + stake.CHANGE_DELAY());
        stake.applyMinBond();
        assertEq(stake.minBond(), 2);
    }

    function test_slasherChangeIsTimelocked() public {
        vm.prank(stranger);
        vm.expectRevert(StakeRegistry.NotOwner.selector);
        stake.proposeSlasher(stranger);

        stake.proposeSlasher(stranger);
        assertEq(stake.pendingSlasher(), stranger);
        assertEq(stake.slasher(), address(this));
        vm.expectRevert(StakeRegistry.TooEarly.selector);
        stake.applySlasher();

        vm.warp(block.timestamp + stake.CHANGE_DELAY());
        stake.applySlasher();
        assertEq(stake.slasher(), stranger);
        assertEq(stake.pendingSlasher(), address(0));
        assertEq(stake.pendingSlasherAt(), 0);

        vm.prank(host);
        stake.bond(100e18);
        vm.expectRevert(StakeRegistry.NotSlasher.selector);
        stake.slash(host, 1000, "old slasher");
        vm.prank(stranger);
        stake.slash(host, 1000, "new slasher");
        assertEq(stake.bonded(host), 90e18);
    }

    function test_hostCanLeaveBeforeANewSlasherBites() public {
        vm.prank(host);
        stake.bond(200e18);

        stake.proposeSlasher(stranger);
        vm.warp(block.timestamp + 1 days); // the host notices a day later
        vm.prank(host);
        stake.startUnbond(200e18);

        vm.warp(block.timestamp + stake.UNBOND_DELAY());
        uint256 before = grid.balanceOf(host);
        vm.prank(host);
        stake.withdraw();
        assertEq(grid.balanceOf(host) - before, 200e18);

        vm.expectRevert(StakeRegistry.TooEarly.selector);
        stake.applySlasher(); // still not live when the host is already out
    }
}
