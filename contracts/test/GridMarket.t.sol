// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GridMarket} from "../src/GridMarket.sol";
import {StakeRegistry} from "../src/StakeRegistry.sol";
import {MockGRID} from "../src/MockGRID.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {IStakeRegistry} from "../src/interfaces/IStakeRegistry.sol";

contract GridMarketTest is Test {
    MockGRID grid;
    StakeRegistry stake;
    GridMarket market;

    address host = makeAddr("host");
    address renter = makeAddr("renter");
    address stranger = makeAddr("stranger");
    address treasury = makeAddr("treasury");

    uint96 constant PRICE = 0.0012 ether; // per hour
    uint256 constant MIN_BOND = 100e18;

    function setUp() public {
        grid = new MockGRID();
        stake = new StakeRegistry(IERC20(address(grid)), MIN_BOND);
        market = new GridMarket(IStakeRegistry(address(stake)), treasury);
        stake.setMarket(address(market));
        vm.deal(renter, 10 ether);
        vm.deal(stranger, 1 ether);
        vm.warp(1_700_000_000);
    }

    /// What the host keeps of `gross` after the protocol fee at its current bond status.
    function _net(uint256 gross) internal view returns (uint256) {
        uint256 bps = stake.isEligible(host) ? market.BONDED_FEE_BPS() : market.FEE_BPS();
        return gross - gross * bps / 10_000;
    }

    function _list() internal returns (uint64 id) {
        vm.prank(host);
        id = market.listMachine(PRICE, '{"gpu":"RTX 5090","vram":32}');
    }

    function _rent(uint64 machineId, uint64 hoursWanted) internal returns (uint64 rid) {
        vm.prank(renter);
        rid = market.rent{value: uint256(PRICE) * hoursWanted}(machineId, hoursWanted);
    }

    function _bondHost() internal {
        grid.mint(host, MIN_BOND);
        vm.startPrank(host);
        grid.approve(address(stake), MIN_BOND);
        stake.bond(MIN_BOND);
        vm.stopPrank();
    }

    function test_metadataTooLongReverts() public {
        string memory big = new string(1025);
        vm.prank(host);
        vm.expectRevert(GridMarket.MetadataTooLong.selector);
        market.listMachine(PRICE, big);
    }

    function test_unbondedHostCappedPerRental() public {
        uint64 id = _list(); // in trial, nothing bonded: 9 h at PRICE is 0.0108 ETH, over the 0.01 ETH cap
        vm.prank(renter);
        vm.expectRevert(GridMarket.TrialCapExceeded.selector);
        market.rent{value: uint256(PRICE) * 9}(id, 9);
        _rent(id, 8); // 0.0096 ETH fits
    }

    function test_bondedHostHasNoRentalCap() public {
        uint64 id = _list();
        _bondHost();
        _rent(id, 100);
    }

    function test_activeRentalCountFollowsRentals() public {
        uint64 id = _list();
        assertEq(market.activeRentalCount(host), 0);
        uint64 rid = _rent(id, 1);
        assertEq(market.activeRentalCount(host), 1);
        vm.prank(renter);
        market.endRental(rid);
        assertEq(market.activeRentalCount(host), 0);
    }

    function test_cannotUnbondWhileRentalRuns() public {
        uint64 id = _list();
        _bondHost();
        uint64 rid = _rent(id, 1);
        vm.prank(host);
        vm.expectRevert(StakeRegistry.RentalsActive.selector);
        stake.startUnbond(MIN_BOND);

        vm.prank(renter);
        market.endRental(rid);
        vm.prank(host);
        stake.startUnbond(MIN_BOND);
        assertEq(stake.bonded(host), 0);
    }

    function test_listMachine() public {
        uint64 id = _list();
        GridMarket.Machine memory m = market.getMachine(id);
        assertEq(m.host, host);
        assertEq(m.pricePerHour, PRICE);
        assertTrue(m.available);
        assertEq(market.machineCount(), 1);
        assertEq(market.machinesOf(host).length, 1);
        assertTrue(market.canRent(id)); // inside the trial period, no bond needed
        assertEq(market.quote(id, 3), uint256(PRICE) * 3);

        GridMarket.MachineView[] memory page = market.getListings(0, 10);
        assertEq(page.length, 1);
        assertEq(page[0].id, id);
        assertTrue(page[0].rentable);
        assertFalse(page[0].hostBonded); // trial, not bonded
        assertEq(market.getMachinesOf(host).length, 1);
        assertEq(market.getListings(1, 10).length, 0);
    }

    function test_getRentalsOfReturnsRentalWithMachine() public {
        uint64 id = _list();
        uint64 rid = _rent(id, 2);
        GridMarket.RentalView[] memory list = market.getRentalsOf(renter);
        assertEq(list.length, 1);
        assertEq(list[0].id, rid);
        assertEq(list[0].rental.paidHours, 2);
        assertEq(list[0].machine.host, host);
        assertEq(market.getRentalsOf(stranger).length, 0);
    }

    function test_rentNeedsExactValue() public {
        uint64 id = _list();
        vm.prank(renter);
        vm.expectRevert(GridMarket.WrongValue.selector);
        market.rent{value: PRICE}(id, 2);
    }

    function test_rentMarksMachineBusy() public {
        uint64 id = _list();
        uint64 rid = _rent(id, 2);
        assertEq(rid, 0);
        assertFalse(market.canRent(id));
        assertEq(market.getMachine(id).activeRental, 1);
        assertEq(market.rentalsOf(renter).length, 1);
        assertEq(address(market).balance, uint256(PRICE) * 2);

        vm.prank(stranger);
        vm.expectRevert(GridMarket.NotRentable.selector);
        market.rent{value: PRICE}(id, 1);
    }

    function test_renterEndsEarly_billedPerStartedMinute() public {
        uint64 id = _list();
        uint64 rid = _rent(id, 2);
        vm.warp(block.timestamp + 30 minutes + 1); // 31 started minutes
        vm.prank(renter);
        market.endRental(rid);

        uint256 cost = uint256(PRICE) * 31 / 60;
        assertEq(market.balances(host), _net(cost));
        assertEq(market.balances(renter), uint256(PRICE) * 2 - cost);
        assertTrue(market.canRent(id));
        assertTrue(market.getRental(rid).ended);

        uint256 before = host.balance;
        vm.prank(host);
        market.withdraw();
        assertEq(host.balance - before, _net(cost));

        vm.prank(host);
        vm.expectRevert(GridMarket.NothingToWithdraw.selector);
        market.withdraw();
    }

    function test_minimumOneMinuteBilled() public {
        uint64 id = _list();
        uint64 rid = _rent(id, 1);
        vm.prank(renter);
        market.endRental(rid); // same second
        assertEq(market.balances(host), _net(uint256(PRICE) / 60));
    }

    function test_strangerCannotEndBeforeExpiry() public {
        uint64 id = _list();
        uint64 rid = _rent(id, 1);
        vm.warp(block.timestamp + 59 minutes);
        vm.prank(stranger);
        vm.expectRevert(GridMarket.NotAllowed.selector);
        market.endRental(rid);
    }

    function test_anyoneCanEndAfterExpiry_hostPaidInFull() public {
        uint64 id = _list();
        uint64 rid = _rent(id, 2);
        vm.warp(block.timestamp + 3 hours); // well past the 2 paid hours
        vm.prank(stranger);
        market.endRental(rid);
        assertEq(market.balances(host), _net(uint256(PRICE) * 2));
        assertEq(market.balances(renter), 0);
    }

    function test_hostCanEndEarly_renterRefunded() public {
        uint64 id = _list();
        uint64 rid = _rent(id, 4);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(host);
        market.endRental(rid);
        assertEq(market.balances(host), _net(PRICE));
        assertEq(market.balances(renter), uint256(PRICE) * 3);
    }

    function test_hostEndingRightAwayBillsNothing() public {
        uint64 id = _list();
        uint64 rid = _rent(id, 2);
        vm.prank(host);
        market.endRental(rid); // same second: no minute served
        assertEq(market.balances(host), 0);
        assertEq(market.balances(renter), uint256(PRICE) * 2);

        rid = _rent(id, 2);
        vm.warp(block.timestamp + 59);
        vm.prank(host);
        market.endRental(rid);
        assertEq(market.balances(host), 0); // still not a full minute
    }

    function test_hostEndingEarlyBillsOnlyFullMinutes() public {
        uint64 id = _list();
        uint64 rid = _rent(id, 2);
        vm.warp(block.timestamp + 30 minutes + 59); // 30 full minutes, 31 started
        vm.prank(host);
        market.endRental(rid);
        uint256 cost = uint256(PRICE) * 30 / 60;
        assertEq(market.balances(host), _net(cost));
        assertEq(market.balances(renter), uint256(PRICE) * 2 - cost);
    }

    function test_hostEndingAfterExpiryIsPaidInFull() public {
        uint64 id = _list();
        uint64 rid = _rent(id, 2);
        vm.warp(block.timestamp + 2 hours);
        vm.prank(host);
        market.endRental(rid);
        assertEq(market.balances(host), _net(uint256(PRICE) * 2));
        assertEq(market.balances(renter), 0);
    }

    function test_endTwiceReverts() public {
        uint64 id = _list();
        uint64 rid = _rent(id, 1);
        vm.prank(renter);
        market.endRental(rid);
        vm.prank(renter);
        vm.expectRevert(GridMarket.AlreadyEnded.selector);
        market.endRental(rid);
    }

    function test_priceLockedAtRentTime() public {
        uint64 id = _list();
        uint64 rid = _rent(id, 1);
        vm.prank(host);
        market.updateMachine(id, PRICE * 10, true, "{}");
        vm.warp(block.timestamp + 1 hours);
        vm.prank(renter);
        market.endRental(rid);
        assertEq(market.balances(host), _net(PRICE));
    }

    function test_hostCanPauseListing() public {
        uint64 id = _list();
        vm.prank(host);
        market.updateMachine(id, PRICE, false, "{}");
        assertFalse(market.canRent(id));
        vm.prank(stranger);
        vm.expectRevert(GridMarket.NotHost.selector);
        market.updateMachine(id, PRICE, true, "{}");
    }

    function test_trialExpiresThenBondRequired() public {
        uint64 id = _list();
        vm.warp(block.timestamp + 31 days);
        assertFalse(market.canRent(id));
        assertFalse(market.hostEligible(host));

        _bondHost();

        assertTrue(market.hostEligible(host));
        assertTrue(market.canRent(id));
    }

    function test_renterGetsRefundViaWithdraw() public {
        uint64 id = _list();
        uint64 rid = _rent(id, 2);
        vm.warp(block.timestamp + 10 minutes);
        vm.prank(renter);
        market.endRental(rid);
        uint256 before = renter.balance;
        vm.prank(renter);
        market.withdraw();
        assertEq(renter.balance - before, uint256(PRICE) * 2 - uint256(PRICE) * 10 / 60);
    }

    // ---------------------------------------------------------------- protocol fee

    function test_fee_unbondedHostPaysTwoPercent() public {
        uint64 m = _list();
        uint64 rid = _rent(m, 2);
        vm.warp(block.timestamp + 2 hours);
        market.endRental(rid);
        uint256 cost = uint256(PRICE) * 2;
        uint256 fee = cost * market.FEE_BPS() / 10_000;
        assertEq(market.FEE_BPS(), 200);
        assertEq(market.balances(host), cost - fee);
        assertEq(market.balances(treasury), fee);
        assertEq(market.balances(host) + market.balances(treasury) + market.balances(renter), cost);
    }

    function test_fee_bondedHostPaysOnePercent() public {
        _bondHost();
        uint64 m = _list();
        uint64 rid = _rent(m, 2);
        vm.warp(block.timestamp + 2 hours);
        market.endRental(rid);
        uint256 cost = uint256(PRICE) * 2;
        uint256 fee = cost * market.BONDED_FEE_BPS() / 10_000;
        assertEq(market.BONDED_FEE_BPS(), 100);
        assertEq(market.balances(host), cost - fee);
        assertEq(market.balances(treasury), fee);
    }

    function test_fee_treasuryWithdrawsLikeAnyone() public {
        uint64 m = _list();
        uint64 rid = _rent(m, 1);
        vm.warp(block.timestamp + 1 hours);
        market.endRental(rid);
        uint256 fee = market.balances(treasury);
        assertGt(fee, 0);
        vm.prank(treasury);
        market.withdraw();
        assertEq(treasury.balance, fee);
        assertEq(market.balances(treasury), 0);
    }

    function test_fee_eventCarriesNetAndFee() public {
        uint64 m = _list();
        uint64 rid = _rent(m, 1);
        vm.warp(block.timestamp + 30 minutes);
        uint256 cost = uint256(PRICE) * 30 / 60;
        uint256 fee = cost * market.FEE_BPS() / 10_000;
        vm.expectEmit(true, true, false, true);
        emit GridMarket.RentalEnded(rid, m, uint128(cost - fee), uint128(fee), uint128(uint256(PRICE) - cost));
        vm.prank(renter);
        market.endRental(rid);
    }

    function test_fee_zeroTreasuryReverts() public {
        vm.expectRevert(GridMarket.ZeroAddress.selector);
        new GridMarket(IStakeRegistry(address(stake)), address(0));
    }
}
