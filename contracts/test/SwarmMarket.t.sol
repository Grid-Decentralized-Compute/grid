// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SwarmMarket} from "../src/SwarmMarket.sol";
import {StakeRegistry} from "../src/StakeRegistry.sol";
import {MockGRID} from "../src/MockGRID.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {IStakeRegistry} from "../src/interfaces/IStakeRegistry.sol";

/// @dev Stands in for the ArbSys precompile; etched at address(100).
contract MockArbSys {
    function arbBlockNumber() external pure returns (uint256) {
        return 987_654_321;
    }
}

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

    function _bytes(bytes32 x) internal pure returns (bytes32[] memory list) {
        list = new bytes32[](1);
        list[0] = x;
    }

    function _salt(address host, uint32 t) internal pure returns (bytes32) {
        return keccak256(abi.encode("salt", host, t));
    }

    function _claim(address host, uint256 id, uint32 t) internal returns (uint256) {
        vm.prank(host);
        return swarm.claim(id, _one(t));
    }

    function _commit(address host, uint256 id, uint32 t, bytes32 result) internal {
        bytes32 commit = swarm.commitHash(id, t, host, result, _salt(host, t));
        vm.prank(host);
        swarm.submit(id, _one(t), _bytes(commit));
    }

    function _reveal(address host, uint256 id, uint32 t, bytes32 result) internal {
        vm.prank(host);
        swarm.reveal(id, _one(t), _bytes(result), _bytes(_salt(host, t)));
    }

    /// @dev Both replicas claim, commit and reveal.
    function _replicas(uint256 id, uint32 t, bytes32 resultA, bytes32 resultB) internal {
        _claim(a, id, t);
        _claim(b, id, t);
        _commit(a, id, t, resultA);
        _commit(b, id, t, resultB);
        _reveal(a, id, t, resultA);
        _reveal(b, id, t, resultB);
    }

    function _status(uint256 id, uint32 t) internal view returns (uint8) {
        return swarm.taskStatuses(id, t, 1)[0];
    }

    function _run(uint256 id, uint32 t, uint8 slot) internal view returns (SwarmMarket.Run memory) {
        (SwarmMarket.Run[3] memory runs,) = swarm.getTask(id, t);
        return runs[slot];
    }

    // ---------------------------------------------------------------- posting

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

    function test_postedBlockFallsBackToBlockNumberWithoutArbSys() public {
        assertEq(address(100).code.length, 0);
        vm.roll(1234);
        uint256 id = _post(1);
        assertEq(swarm.getJob(id).postedBlock, 1234);
    }

    function test_postedBlockUsesArbSysWhenPresent() public {
        vm.etch(address(100), address(new MockArbSys()).code);
        vm.roll(1234);
        uint256 id = _post(1);
        assertEq(swarm.getJob(id).postedBlock, 987_654_321);
    }

    function test_postedBlockFallsBackWhenArbSysReverts() public {
        vm.etch(address(100), hex"60006000fd"); // PUSH1 0 PUSH1 0 REVERT
        vm.roll(1234);
        uint256 id = _post(1);
        assertEq(swarm.getJob(id).postedBlock, 1234);
    }

    // ---------------------------------------------------------------- replicas

    function test_twoMatchingRunsPayBothHosts() public {
        uint256 id = _post(1);
        assertEq(_claim(a, id, 0), 1);
        assertEq(_claim(b, id, 0), 1);
        assertEq(_status(id, 0), swarm.STATUS_RUNNING());

        _commit(a, id, 0, GOOD);
        _commit(b, id, 0, GOOD);
        assertEq(_status(id, 0), swarm.STATUS_RUNNING());
        assertEq(_run(id, 0, 0).commit, swarm.commitHash(id, 0, a, GOOD, _salt(a, 0)));
        assertEq(_run(id, 0, 0).result, bytes32(0));

        _reveal(a, id, 0, GOOD);
        assertEq(_status(id, 0), swarm.STATUS_PARTIAL());
        _reveal(b, id, 0, GOOD);

        assertEq(_status(id, 0), swarm.STATUS_DONE());
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
        _replicas(id, 0, GOOD, BAD);
        assertEq(_status(id, 0), swarm.STATUS_DISPUTED());

        assertEq(_claim(c, id, 0), 1);
        _commit(c, id, 0, GOOD);
        _reveal(c, id, 0, GOOD);

        assertEq(_status(id, 0), swarm.STATUS_DONE());
        assertEq(swarm.balances(a), PRICE);
        assertEq(swarm.balances(b), 0);
        assertEq(swarm.balances(c), PRICE);
        assertEq(swarm.faults(b), 1);
        assertEq(swarm.faults(a), 0);
    }

    function test_threeDifferentResultsFailTheTask() public {
        uint256 id = _post(1);
        _replicas(id, 0, GOOD, BAD);
        _claim(c, id, 0);
        _commit(c, id, 0, OTHER);
        _reveal(c, id, 0, OTHER);
        assertEq(_status(id, 0), swarm.STATUS_FAILED());
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
        assertEq(_status(id, 0), swarm.STATUS_WAITING());
        assertEq(_claim(c, id, 0), 1); // takes A's expired slot
        assertEq(_claim(d, id, 0), 1); // takes B's expired slot
        assertEq(swarm.faults(a), 0); // an uncommitted lease just lapses
        _commit(a, id, 0, GOOD); // too late: A no longer holds a run
        assertEq(_run(id, 0, 0).host, c);
        assertEq(_run(id, 0, 0).commit, bytes32(0));
        _commit(c, id, 0, GOOD);
        _commit(d, id, 0, GOOD);
        _reveal(c, id, 0, GOOD);
        _reveal(d, id, 0, GOOD);
        assertEq(swarm.balances(a), 0);
        assertEq(swarm.balances(c), PRICE);
        assertEq(swarm.balances(d), PRICE);
    }

    function test_lateCommitAcceptedWhenNobodyTookOver() public {
        uint256 id = _post(1);
        _claim(a, id, 0);
        _claim(b, id, 0);
        vm.warp(block.timestamp + LEASE + 1);
        _commit(a, id, 0, GOOD);
        _commit(b, id, 0, GOOD);
        assertEq(_run(id, 0, 0).leaseEnd, block.timestamp + LEASE); // reveal deadline from the second commit
        _reveal(a, id, 0, GOOD);
        _reveal(b, id, 0, GOOD);
        assertEq(_status(id, 0), swarm.STATUS_DONE());
    }

    // ---------------------------------------------------------------- commit-reveal

    function test_revealRefusedUntilBothReplicasCommitted() public {
        uint256 id = _post(1);
        _claim(a, id, 0);
        _claim(b, id, 0);
        _commit(a, id, 0, GOOD);
        _reveal(a, id, 0, GOOD); // B has not committed: nothing happens
        assertEq(_run(id, 0, 0).result, bytes32(0));
        assertEq(_status(id, 0), swarm.STATUS_RUNNING());

        _commit(b, id, 0, GOOD);
        _reveal(a, id, 0, GOOD);
        assertEq(_run(id, 0, 0).result, GOOD);
        assertEq(_status(id, 0), swarm.STATUS_PARTIAL());
    }

    function test_revealMustMatchTheCommit() public {
        uint256 id = _post(1);
        _claim(a, id, 0);
        _claim(b, id, 0);
        _commit(a, id, 0, GOOD);
        _commit(b, id, 0, GOOD);
        _reveal(a, id, 0, BAD); // not what A committed to
        vm.prank(a);
        swarm.reveal(id, _one(0), _bytes(GOOD), _bytes(keccak256("wrong salt")));
        assertEq(_run(id, 0, 0).result, bytes32(0));
        _reveal(a, id, 0, GOOD);
        assertEq(_run(id, 0, 0).result, GOOD);
    }

    function test_copyingSecondReplicaIsNeverPaid() public {
        uint256 id = _post(1);
        _claim(a, id, 0);
        _claim(b, id, 0);
        _commit(a, id, 0, GOOD);

        // B does no work and commits whatever A committed.
        bytes32 copied = _run(id, 0, 0).commit;
        vm.prank(b);
        swarm.submit(id, _one(0), _bytes(copied));
        assertEq(_run(id, 0, 1).commit, copied);

        // A reveals, so B now knows A's result and salt, and still cannot open the copied commit:
        // commitHash binds the host.
        _reveal(a, id, 0, GOOD);
        vm.prank(b);
        swarm.reveal(id, _one(0), _bytes(GOOD), _bytes(_salt(a, 0)));
        _reveal(b, id, 0, GOOD); // with its own salt it does not match either
        assertEq(_run(id, 0, 1).result, bytes32(0));
        assertEq(_status(id, 0), swarm.STATUS_PARTIAL());
        assertEq(swarm.balances(b), 0);

        // B misses the reveal deadline: C takes the slot and B gets a fault.
        vm.warp(block.timestamp + LEASE + 1);
        assertEq(_claim(c, id, 0), 1);
        assertEq(swarm.faults(b), 1);
        _commit(c, id, 0, GOOD);
        _reveal(c, id, 0, GOOD);
        assertEq(_status(id, 0), swarm.STATUS_DONE());
        assertEq(swarm.balances(a), PRICE);
        assertEq(swarm.balances(b), 0);
        assertEq(swarm.balances(c), PRICE);
    }

    function test_copiedCommitMatchingOutputIsStillRejected() public {
        // Even when the copier would have produced the same output, A's commit opens only for A.
        uint256 id = _post(1);
        _claim(a, id, 0);
        _claim(b, id, 0);
        bytes32 commitA = swarm.commitHash(id, 0, a, GOOD, _salt(a, 0));
        assertTrue(commitA != swarm.commitHash(id, 0, b, GOOD, _salt(a, 0)));
        _commit(a, id, 0, GOOD);
        vm.prank(b);
        swarm.submit(id, _one(0), _bytes(commitA));
        vm.prank(b);
        swarm.reveal(id, _one(0), _bytes(GOOD), _bytes(_salt(a, 0)));
        assertEq(_run(id, 0, 1).result, bytes32(0));
    }

    function test_unrevealedCommitExpiresAndIsReassignedWithFault() public {
        uint256 id = _post(1);
        _claim(a, id, 0);
        _claim(b, id, 0);
        vm.warp(block.timestamp + 100);
        _commit(a, id, 0, GOOD);
        _commit(b, id, 0, GOOD); // reveal opens, both have LEASE from now
        uint256 deadline = block.timestamp + LEASE;
        assertEq(_run(id, 0, 0).leaseEnd, deadline);
        assertEq(_run(id, 0, 1).leaseEnd, deadline);
        assertEq(swarm.getJob(id).lastLeaseEnd, deadline);
        _reveal(a, id, 0, GOOD);

        vm.warp(deadline); // deadline not passed yet
        assertEq(_claim(c, id, 0), 0);
        assertEq(_status(id, 0), swarm.STATUS_PARTIAL());

        vm.warp(deadline + 1);
        assertEq(swarm.claimable(id, c, 0, 1, 1).length, 1);
        vm.expectEmit(true, true, true, true, address(swarm));
        emit SwarmMarket.Fault(id, 0, b, bytes32(0));
        assertEq(_claim(c, id, 0), 1);
        assertEq(swarm.faults(b), 1);
        assertEq(_run(id, 0, 1).host, c);

        _reveal(b, id, 0, GOOD); // B no longer holds the run
        assertEq(_run(id, 0, 1).result, bytes32(0));
        _commit(c, id, 0, GOOD);
        _reveal(c, id, 0, GOOD);
        assertEq(swarm.balances(a), PRICE);
        assertEq(swarm.balances(b), 0);
        assertEq(swarm.balances(c), PRICE);
    }

    function test_bothReplicasMissingTheirRevealAreBothReplaced() public {
        uint256 id = _post(1);
        _claim(a, id, 0);
        _claim(b, id, 0);
        _commit(a, id, 0, GOOD);
        _commit(b, id, 0, GOOD);
        vm.warp(block.timestamp + LEASE + 1);
        assertEq(_status(id, 0), swarm.STATUS_WAITING());
        assertEq(_claim(c, id, 0), 1);
        assertEq(swarm.faults(a), 1);
        // B's commit waits again until C commits, then gets a fresh deadline along with C.
        assertEq(_claim(d, id, 0), 0);
        _commit(c, id, 0, GOOD);
        _reveal(c, id, 0, GOOD);
        vm.warp(block.timestamp + LEASE + 1);
        assertEq(_claim(d, id, 0), 1);
        assertEq(swarm.faults(b), 1);
        assertEq(_run(id, 0, 1).host, d);
    }

    function test_commitWaitingForItsReplicaNeverExpires() public {
        uint256 id = _post(1);
        _claim(a, id, 0);
        _commit(a, id, 0, GOOD);
        vm.warp(block.timestamp + 30 days);
        assertEq(_status(id, 0), swarm.STATUS_RUNNING());
        assertEq(_claim(b, id, 0), 1);
        assertEq(_run(id, 0, 1).host, b); // the empty slot, not A's
        assertEq(_run(id, 0, 0).host, a);
        assertEq(swarm.faults(a), 0);
        _commit(b, id, 0, GOOD);
        _reveal(a, id, 0, GOOD);
        _reveal(b, id, 0, GOOD);
        assertEq(swarm.balances(a), PRICE);
        assertEq(swarm.balances(b), PRICE);
    }

    function test_tieBreakRunGetsARevealDeadlineAndExpires() public {
        uint256 id = _post(1);
        _replicas(id, 0, GOOD, BAD);
        _claim(c, id, 0);
        vm.warp(block.timestamp + 100);
        _commit(c, id, 0, GOOD);
        assertEq(_run(id, 0, 2).leaseEnd, block.timestamp + LEASE);
        vm.warp(block.timestamp + LEASE + 1);
        assertEq(_claim(d, id, 0), 1);
        assertEq(swarm.faults(c), 1);
        _commit(d, id, 0, GOOD);
        _reveal(d, id, 0, GOOD);
        assertEq(swarm.balances(a), PRICE);
        assertEq(swarm.balances(d), PRICE);
        assertEq(swarm.faults(b), 1);
    }

    function test_zeroCommitsAndUnheldRunsAreSkipped() public {
        uint256 id = _post(1);
        _claim(a, id, 0);
        vm.prank(a);
        swarm.submit(id, _one(0), _bytes(bytes32(0)));
        assertEq(_run(id, 0, 0).commit, bytes32(0));
        _commit(b, id, 0, GOOD); // B holds no run
        assertEq(_run(id, 0, 1).commit, bytes32(0));

        bytes32[] memory two = new bytes32[](2);
        vm.prank(a);
        vm.expectRevert(SwarmMarket.LengthMismatch.selector);
        swarm.reveal(id, _one(0), two, _bytes(bytes32(0)));
    }

    // ---------------------------------------------------------------- closing and cancelling

    function test_closeFinishedJobRefundsTheUnusedDeposit() public {
        uint256 id = _post(2);
        for (uint32 t = 0; t < 2; t++) {
            _replicas(id, t, GOOD, GOOD);
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

    function test_cancelStopsUntouchedTasksAndRefundsAfterTheGrace() public {
        uint256 id = _post(3);
        _claim(a, id, 0);
        vm.prank(renter);
        swarm.cancelJob(id);

        assertEq(_claim(b, id, 1), 0); // nobody started task 1
        uint32[] memory open = swarm.claimable(id, b, 0, 3, 3);
        assertEq(open.length, 1);
        assertEq(open[0], 0);

        uint256 lastLeaseEnd = swarm.getJob(id).lastLeaseEnd;
        vm.warp(lastLeaseEnd + 1); // A's lease is over, the grace is not
        vm.prank(renter);
        vm.expectRevert(SwarmMarket.NotClosable.selector);
        swarm.closeJob(id);

        vm.warp(lastLeaseEnd + LEASE + 1);
        vm.prank(renter);
        swarm.closeJob(id);
        assertEq(swarm.balances(renter), uint256(PRICE) * 9);

        vm.prank(b);
        vm.expectRevert(SwarmMarket.JobInactive.selector);
        swarm.claim(id, _one(0));
    }

    function test_cancelAfterCommitsCannotStiffTheHosts() public {
        uint256 id = _post(1);
        _claim(a, id, 0);
        _claim(b, id, 0);
        _commit(a, id, 0, GOOD);
        _commit(b, id, 0, GOOD);
        vm.prank(renter);
        swarm.cancelJob(id);

        // Before the fix the renter could close as soon as the leases ran out.
        vm.warp(swarm.getJob(id).lastLeaseEnd + 1);
        vm.prank(renter);
        vm.expectRevert(SwarmMarket.NotClosable.selector);
        swarm.closeJob(id);

        _reveal(a, id, 0, GOOD);
        _reveal(b, id, 0, GOOD);
        assertEq(swarm.balances(a), PRICE);
        assertEq(swarm.balances(b), PRICE);

        vm.prank(renter);
        swarm.closeJob(id); // finished
        assertEq(swarm.balances(renter), PRICE);
    }

    function test_cancelLetsAStartedTaskGetItsReplica() public {
        uint256 id = _post(2);
        _claim(a, id, 0);
        _commit(a, id, 0, GOOD);
        vm.prank(renter);
        swarm.cancelJob(id);

        assertEq(_claim(c, id, 1), 0); // untouched task: refunded, not worked on
        assertEq(_claim(b, id, 0), 1); // A's task still gets its second replica
        _commit(b, id, 0, GOOD);
        _reveal(a, id, 0, GOOD);
        _reveal(b, id, 0, GOOD);
        assertEq(swarm.balances(a), PRICE);
        assertEq(swarm.balances(b), PRICE);

        uint256 lastLeaseEnd = swarm.getJob(id).lastLeaseEnd;
        vm.warp(lastLeaseEnd + LEASE);
        vm.prank(renter);
        vm.expectRevert(SwarmMarket.NotClosable.selector);
        swarm.closeJob(id);
        vm.warp(lastLeaseEnd + LEASE + 1);
        vm.prank(renter);
        swarm.closeJob(id);
        assertEq(swarm.balances(renter), uint256(PRICE) * 6 - uint256(PRICE) * 2);
    }

    function test_noCommitOrRevealAfterClose() public {
        uint256 id = _post(1);
        _claim(a, id, 0);
        vm.prank(renter);
        swarm.cancelJob(id);
        vm.warp(block.timestamp + 2 * uint256(LEASE) + 1);
        vm.prank(renter);
        swarm.closeJob(id);

        vm.prank(a);
        vm.expectRevert(SwarmMarket.JobInactive.selector);
        swarm.submit(id, _one(0), _bytes(GOOD));
        vm.prank(a);
        vm.expectRevert(SwarmMarket.JobInactive.selector);
        swarm.reveal(id, _one(0), _bytes(GOOD), _bytes(GOOD));
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

    // ---------------------------------------------------------------- misc

    function test_unbondedHostCannotClaimWhenBondingIsOn() public {
        stake.proposeMinBond(100e18);
        vm.warp(block.timestamp + stake.CHANGE_DELAY());
        stake.applyMinBond();
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

    function test_batchOfClaimsCommitsAndReveals() public {
        uint256 id = _post(4);
        uint32[] memory all = new uint32[](4);
        bytes32[] memory results = new bytes32[](4);
        bytes32[] memory commitsA = new bytes32[](4);
        bytes32[] memory commitsB = new bytes32[](4);
        bytes32[] memory saltsA = new bytes32[](4);
        bytes32[] memory saltsB = new bytes32[](4);
        for (uint32 t = 0; t < 4; t++) {
            all[t] = t;
            results[t] = GOOD;
            saltsA[t] = _salt(a, t);
            saltsB[t] = _salt(b, t);
            commitsA[t] = swarm.commitHash(id, t, a, GOOD, saltsA[t]);
            commitsB[t] = swarm.commitHash(id, t, b, GOOD, saltsB[t]);
        }
        vm.prank(a);
        assertEq(swarm.claim(id, all), 4);
        vm.prank(b);
        assertEq(swarm.claim(id, all), 4);
        vm.prank(a);
        swarm.submit(id, all, commitsA);
        vm.prank(b);
        swarm.submit(id, all, commitsB);
        vm.prank(a);
        swarm.reveal(id, all, results, saltsA);
        vm.prank(b);
        swarm.reveal(id, all, results, saltsB);
        assertEq(swarm.getJob(id).done, 4);
        assertEq(swarm.balances(a), uint256(PRICE) * 4);
    }
}
