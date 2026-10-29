// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SwarmMarket} from "../src/SwarmMarket.sol";
import {StakeRegistry} from "../src/StakeRegistry.sol";
import {MockGRID} from "../src/MockGRID.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {IStakeRegistry} from "../src/interfaces/IStakeRegistry.sol";

contract SwarmMarketTest is Test {
    MockGRID grid;
    StakeRegistry stake;
    SwarmMarket swarm;

    address renter = makeAddr("renter");
    address a = makeAddr("hostA");
    address b = makeAddr("hostB");
    address c = makeAddr("hostC");
    address d = makeAddr("hostD");

    uint96 constant PRICE = 0.0001 ether;
    uint32 constant LEASE = 600;
    bytes constant MANIFEST = '{"v":1,"image":"alpine","command":"wc -c","tasks":["a","bb","ccc"]}';
    bytes32 constant GOOD = keccak256("good");
    bytes32 constant BAD = keccak256("bad");
    bytes32 constant OTHER = keccak256("other");

    function setUp() public {
        grid = new MockGRID();
        stake = new StakeRegistry(IERC20(address(grid)), 0); // bonding off: every host eligible
        swarm = new SwarmMarket(IStakeRegistry(address(stake)));
        vm.deal(renter, 10 ether);
        vm.warp(1_700_000_000);
    }

    function _post(uint32 tasks) internal returns (uint256 id) {
        vm.prank(renter);
        id = swarm.postJob{value: uint256(PRICE) * tasks * 3}(PRICE, tasks, LEASE, MANIFEST);
    }

    function _one(uint32 t) internal pure returns (uint32[] memory list) {
        list = new uint32[](1);
        list[0] = t;
    }

    function _claim(address host, uint256 id, uint32 t) internal returns (uint256) {
        vm.prank(host);
        return swarm.claim(id, _one(t));
    }

    function _submit(address host, uint256 id, uint32 t, bytes32 result) internal {
        bytes32[] memory results = new bytes32[](1);
        results[0] = result;
        vm.prank(host);
        swarm.submit(id, _one(t), results);
    }

    function test_postJobEscrowsThreeRunsPerTask() public {
        uint256 id = _post(3);
        SwarmMarket.Job memory job = swarm.getJob(id);
        assertEq(job.renter, renter);
        assertEq(job.taskCount, 3);
        assertEq(job.deposit, uint256(PRICE) * 9);
        assertEq(job.manifestHash, keccak256(MANIFEST));
        assertEq(address(swarm).balance, uint256(PRICE) * 9);
        assertEq(swarm.jobCount(), 1);
    }

    function test_postJobRejectsWrongValueAndBadParams() public {
        vm.startPrank(renter);
        vm.expectRevert(SwarmMarket.WrongValue.selector);
        swarm.postJob{value: PRICE}(PRICE, 3, LEASE, MANIFEST);
        vm.expectRevert(SwarmMarket.BadJob.selector);
        swarm.postJob{value: 0}(PRICE, 0, LEASE, MANIFEST);
        vm.expectRevert(SwarmMarket.BadJob.selector);
        swarm.postJob{value: uint256(PRICE) * 3}(PRICE, 1, 10, MANIFEST);
        vm.expectRevert(SwarmMarket.ManifestSize.selector);
        swarm.postJob{value: uint256(PRICE) * 3}(PRICE, 1, LEASE, "");
        vm.stopPrank();
    }

    function test_twoMatchingRunsPayBothHosts() public {
        uint256 id = _post(1);
        assertEq(_claim(a, id, 0), 1);
        assertEq(_claim(b, id, 0), 1);
        assertEq(swarm.taskStatuses(id, 0, 1)[0], swarm.STATUS_RUNNING());

        _submit(a, id, 0, GOOD);
        assertEq(swarm.taskStatuses(id, 0, 1)[0], swarm.STATUS_PARTIAL());
        _submit(b, id, 0, GOOD);

        assertEq(swarm.taskStatuses(id, 0, 1)[0], swarm.STATUS_DONE());
        assertEq(swarm.balances(a), PRICE);
        assertEq(swarm.balances(b), PRICE);
        SwarmMarket.Job memory job = swarm.getJob(id);
        assertEq(job.done, 1);
        assertEq(job.resolved, 1);
        assertEq(job.paid, uint256(PRICE) * 2);
    }

    function test_hostCannotRunTheSameTaskTwice() public {
        uint256 id = _post(1);
        assertEq(_claim(a, id, 0), 1);
        assertEq(_claim(a, id, 0), 0);
        assertEq(swarm.claimable(id, a, 0, 10, 10).length, 0);
        assertEq(swarm.claimable(id, b, 0, 10, 10).length, 1);
    }

    function test_noThirdRunWhileReplicasAgreeOrRun() public {
        uint256 id = _post(1);
        _claim(a, id, 0);
        _claim(b, id, 0);
        assertEq(_claim(c, id, 0), 0); // both replica slots busy, nothing disputed
    }

    function test_disagreementOpensTieBreakAndFaultsTheOddOneOut() public {
        uint256 id = _post(1);
        _claim(a, id, 0);
        _claim(b, id, 0);
        _submit(a, id, 0, GOOD);
        _submit(b, id, 0, BAD);
        assertEq(swarm.taskStatuses(id, 0, 1)[0], swarm.STATUS_DISPUTED());

        assertEq(_claim(c, id, 0), 1);
        _submit(c, id, 0, GOOD);

        assertEq(swarm.taskStatuses(id, 0, 1)[0], swarm.STATUS_DONE());
        assertEq(swarm.balances(a), PRICE);
        assertEq(swarm.balances(b), 0);
        assertEq(swarm.balances(c), PRICE);
        assertEq(swarm.faults(b), 1);
        assertEq(swarm.faults(a), 0);
    }

    function test_threeDifferentResultsFailTheTask() public {
        uint256 id = _post(1);
        _claim(a, id, 0);
        _claim(b, id, 0);
        _submit(a, id, 0, GOOD);
        _submit(b, id, 0, BAD);
        _claim(c, id, 0);
        _submit(c, id, 0, OTHER);
        assertEq(swarm.taskStatuses(id, 0, 1)[0], swarm.STATUS_FAILED());
        SwarmMarket.Job memory job = swarm.getJob(id);
        assertEq(job.resolved, 1);
        assertEq(job.done, 0);
        assertEq(job.paid, 0);
    }

    function test_expiredLeaseIsTakenOver() public {
        uint256 id = _post(1);
        _claim(a, id, 0);
        _claim(b, id, 0);
        vm.warp(block.timestamp + LEASE + 1);
        assertEq(swarm.taskStatuses(id, 0, 1)[0], swarm.STATUS_WAITING());
        assertEq(_claim(c, id, 0), 1); // takes A's expired slot
        assertEq(_claim(d, id, 0), 1); // takes B's expired slot
        _submit(a, id, 0, GOOD); // too late: A no longer holds a run
        _submit(c, id, 0, GOOD);
        _submit(d, id, 0, GOOD);
        assertEq(swarm.balances(a), 0);
        assertEq(swarm.balances(c), PRICE);
        assertEq(swarm.balances(d), PRICE);
    }

    function test_lateResultAcceptedWhenNobodyTookOver() public {
        uint256 id = _post(1);
        _claim(a, id, 0);
        _claim(b, id, 0);
        vm.warp(block.timestamp + LEASE + 1);
        _submit(a, id, 0, GOOD);
        _submit(b, id, 0, GOOD);
        assertEq(swarm.taskStatuses(id, 0, 1)[0], swarm.STATUS_DONE());
    }

    function test_closeFinishedJobRefundsTheUnusedDeposit() public {
        uint256 id = _post(2);
        for (uint32 t = 0; t < 2; t++) {
            _claim(a, id, t);
            _claim(b, id, t);
            _submit(a, id, t, GOOD);
            _submit(b, id, t, GOOD);
        }
        vm.prank(renter);
        swarm.closeJob(id);
        // 2 tasks × 3 runs escrowed, 2 tasks × 2 runs paid
        assertEq(swarm.balances(renter), uint256(PRICE) * 2);

        uint256 before = renter.balance;
        vm.prank(renter);
        swarm.withdraw();
        assertEq(renter.balance - before, uint256(PRICE) * 2);
    }

    function test_cannotCloseUnfinishedJob() public {
        uint256 id = _post(2);
        vm.prank(renter);
        vm.expectRevert(SwarmMarket.NotClosable.selector);
        swarm.closeJob(id);
    }

    function test_cancelStopsClaimsAndRefundsAfterLastLease() public {
        uint256 id = _post(3);
        _claim(a, id, 0);
        vm.prank(renter);
        swarm.cancelJob(id);

        vm.prank(b);
        vm.expectRevert(SwarmMarket.JobInactive.selector);
        swarm.claim(id, _one(1));

        vm.prank(renter);
        vm.expectRevert(SwarmMarket.NotClosable.selector);
        swarm.closeJob(id); // A's lease is still running

        vm.warp(block.timestamp + LEASE + 1);
        vm.prank(renter);
        swarm.closeJob(id);
        assertEq(swarm.balances(renter), uint256(PRICE) * 9);
    }

    function test_onlyRenterCancelsOrCloses() public {
        uint256 id = _post(1);
        vm.prank(a);
        vm.expectRevert(SwarmMarket.NotRenter.selector);
        swarm.cancelJob(id);
        vm.prank(a);
        vm.expectRevert(SwarmMarket.NotRenter.selector);
        swarm.closeJob(id);
    }

    function test_unbondedHostCannotClaimWhenBondingIsOn() public {
        stake.setMinBond(100e18);
        uint256 id = _post(1);
        vm.prank(a);
        vm.expectRevert(SwarmMarket.NotEligible.selector);
        swarm.claim(id, _one(0));
    }

    function test_claimableScansAWindowAndSkipsWhatIsTaken() public {
        uint256 id = _post(5);
        _claim(a, id, 1);
        uint32[] memory forA = swarm.claimable(id, a, 0, 5, 10);
        assertEq(forA.length, 4); // everything but task 1
        uint32[] memory window = swarm.claimable(id, b, 2, 2, 10);
        assertEq(window.length, 2);
        assertEq(window[0], 2);
        assertEq(window[1], 3);
        assertEq(swarm.claimable(id, b, 0, 5, 1).length, 1); // max respected
    }

    function test_workerEndpointAndJobPages() public {
        vm.prank(a);
        swarm.registerWorker("https://a.example");
        assertEq(swarm.workerEndpoint(a), "https://a.example");
        _post(1);
        _post(2);
        SwarmMarket.JobView[] memory page = swarm.getJobs(0, 10);
        assertEq(page.length, 2);
        assertEq(page[0].id, 1); // newest first
        assertEq(page[1].id, 0);
    }

    function test_batchOfClaimsAndSubmits() public {
        uint256 id = _post(4);
        uint32[] memory all = new uint32[](4);
        bytes32[] memory results = new bytes32[](4);
        for (uint32 t = 0; t < 4; t++) {
            all[t] = t;
            results[t] = GOOD;
        }
        vm.prank(a);
        assertEq(swarm.claim(id, all), 4);
        vm.prank(b);
        assertEq(swarm.claim(id, all), 4);
        vm.prank(a);
        swarm.submit(id, all, results);
        vm.prank(b);
        swarm.submit(id, all, results);
        assertEq(swarm.getJob(id).done, 4);
        assertEq(swarm.balances(a), uint256(PRICE) * 4);
    }
}
