// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Allowance} from "../src/Allowance.sol";
import {AllowanceFactory} from "../src/AllowanceFactory.sol";
import {SwarmMarket} from "../src/SwarmMarket.sol";
import {StakeRegistry} from "../src/StakeRegistry.sol";
import {MockGRID} from "../src/MockGRID.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {IStakeRegistry} from "../src/interfaces/IStakeRegistry.sol";

/// @dev A contract the agent may call: counts calls, keeps the ETH it is sent, reverts on
///      request, and records what the wallet had counted as spent while the call ran.
contract Probe {
    uint256 public calls;
    uint256 public spentSeen;

    error Refused(uint256 code);

    function ping() external payable returns (uint256) {
        calls += 1;
        spentSeen = Allowance(payable(msg.sender)).spentToday();
        return calls;
    }

    function refuse(uint256 code) external payable {
        revert Refused(code);
    }

    function refuseWithReason() external pure {
        revert("probe says no");
    }

    /// @dev Tries to spend again from inside a call the agent made.
    function reenter(uint256 value) external {
        Allowance(payable(msg.sender)).execute(address(this), value, abi.encodeCall(this.ping, ()));
    }
}

/// @dev An owner that cannot take ETH.
contract Refuser {
    function accept(Allowance wallet) external {
        wallet.acceptOwnership();
    }

    function pull(Allowance wallet, uint256 amount) external {
        wallet.withdraw(amount);
    }
}

contract AllowanceTest is Test {
    Allowance wallet;
    AllowanceFactory factory;
    Probe probe;
    Probe other;

    MockGRID grid;
    StakeRegistry stake;
    SwarmMarket swarm;

    address owner = makeAddr("owner");
    address agent = makeAddr("agent");
    address stranger = makeAddr("stranger");
    address multisig = makeAddr("multisig");
    address hostA = makeAddr("hostA");
    address hostB = makeAddr("hostB");

    uint256 constant CAP = 1 ether;
    uint256 constant FUNDING = 5 ether;

    uint96 constant PRICE = 0.0001 ether;
    uint32 constant LEASE = 600;
    bytes constant MANIFEST = '{"v":1,"image":"alpine","command":"wc -c","tasks":["a","bb","ccc"]}';
    bytes32 constant GOOD = keccak256("good");

    function setUp() public {
        vm.warp(1_700_000_000); // 2023-11-14 22:13:20 UTC
        probe = new Probe();
        other = new Probe();
        factory = new AllowanceFactory();

        grid = new MockGRID();
        stake = new StakeRegistry(IERC20(address(grid)), 0); // bonding off: every host eligible
        swarm = new SwarmMarket(IStakeRegistry(address(stake)), makeAddr("treasury"));

        address[] memory targets = new address[](2);
        targets[0] = address(probe);
        targets[1] = address(swarm);
        wallet = new Allowance(owner, agent, CAP, targets);
        vm.deal(address(wallet), FUNDING);
    }

    function _exec(address target, uint256 value, bytes memory data) internal returns (bytes memory) {
        vm.prank(agent);
        return wallet.execute(target, value, data);
    }

    function _ping(uint256 value) internal returns (bytes memory) {
        return _exec(address(probe), value, abi.encodeCall(Probe.ping, ()));
    }

    function _midnightAfter(uint256 t) internal pure returns (uint256) {
        return t - t % 1 days + 1 days;
    }

    // ---------------------------------------------------------------- setup

    function test_constructorSetsEverything() public view {
        assertEq(wallet.owner(), owner);
        assertEq(wallet.pendingOwner(), address(0));
        assertEq(wallet.agent(), agent);
        assertEq(wallet.dailyCap(), CAP);
        assertTrue(wallet.allowedTarget(address(probe)));
        assertTrue(wallet.allowedTarget(address(swarm)));
        assertFalse(wallet.allowedTarget(address(other)));
        assertEq(wallet.remainingToday(), CAP);
        assertEq(wallet.spentToday(), 0);
    }

    function test_constructorRejectsZeroAddresses() public {
        address[] memory targets = new address[](1);
        targets[0] = address(probe);
        vm.expectRevert(Allowance.ZeroAddress.selector);
        new Allowance(address(0), agent, CAP, targets);
        vm.expectRevert(Allowance.ZeroAddress.selector);
        new Allowance(owner, address(0), CAP, targets);
        targets[0] = address(0);
        vm.expectRevert(Allowance.ZeroAddress.selector);
        new Allowance(owner, agent, CAP, targets);
    }

    function test_receiveEmitsFunded() public {
        vm.deal(stranger, 1 ether);
        vm.expectEmit(address(wallet));
        emit Allowance.Funded(stranger, 0.25 ether);
        vm.prank(stranger);
        (bool ok,) = address(wallet).call{value: 0.25 ether}("");
        assertTrue(ok);
        assertEq(address(wallet).balance, FUNDING + 0.25 ether);
    }

    // ---------------------------------------------------------------- execute

    function test_executeForwardsValueAndReturnsData() public {
        vm.expectEmit(address(wallet));
        emit Allowance.Executed(address(probe), 0.3 ether, abi.encodeCall(Probe.ping, ()));
        bytes memory ret = _ping(0.3 ether);
        assertEq(abi.decode(ret, (uint256)), 1);
        assertEq(probe.calls(), 1);
        assertEq(address(probe).balance, 0.3 ether);
        assertEq(address(wallet).balance, FUNDING - 0.3 ether);
        assertEq(wallet.spentToday(), 0.3 ether);
        assertEq(wallet.remainingToday(), CAP - 0.3 ether);
        assertEq(wallet.dayStart(), block.timestamp - block.timestamp % 1 days);
    }

    function test_capEnforcedWithinADay() public {
        _ping(0.6 ether);
        vm.expectRevert(Allowance.CapExceeded.selector);
        _ping(0.4 ether + 1);

        vm.warp(block.timestamp + 1 hours); // still the same UTC day
        _ping(0.4 ether); // exactly up to the cap
        assertEq(wallet.spentToday(), CAP);
        assertEq(wallet.remainingToday(), 0);

        vm.expectRevert(Allowance.CapExceeded.selector);
        _ping(1);
        vm.expectRevert(Allowance.CapExceeded.selector);
        _ping(type(uint256).max); // no overflow, just over the cap
        assertEq(address(probe).balance, CAP);
    }

    function test_capResetsAtUtcMidnight() public {
        uint256 midnight = _midnightAfter(block.timestamp);
        _ping(CAP);

        vm.warp(midnight - 1); // 23:59:59
        assertEq(wallet.remainingToday(), 0);
        vm.expectRevert(Allowance.CapExceeded.selector);
        _ping(1);

        vm.warp(midnight); // 00:00:00
        assertEq(wallet.remainingToday(), CAP);
        _ping(CAP);
        assertEq(wallet.dayStart(), midnight);
        assertEq(wallet.spentToday(), CAP);
        assertEq(address(probe).balance, 2 * CAP);
    }

    function test_theDayIsTheUtcDateNotARolling24Hours() public {
        uint256 midnight = _midnightAfter(block.timestamp);
        vm.warp(midnight - 1);
        _ping(CAP); // spent at 23:59:59 ...
        vm.warp(midnight);
        _ping(CAP); // ... and again one second later, on the new date

        vm.warp(midnight + 1 days - 1); // the end of that second day
        vm.expectRevert(Allowance.CapExceeded.selector);
        _ping(1);
    }

    function test_remainingTodayRollsOverWithoutWriting() public {
        _ping(0.7 ether);
        uint64 day = wallet.dayStart();
        vm.warp(_midnightAfter(block.timestamp) + 5 hours);
        assertEq(wallet.remainingToday(), CAP);
        assertEq(wallet.spentToday(), 0.7 ether); // stale until the next call with value
        assertEq(wallet.dayStart(), day);

        _ping(0.1 ether);
        assertEq(wallet.spentToday(), 0.1 ether);
        assertEq(wallet.remainingToday(), 0.9 ether);
    }

    function test_onlyTheAgentCanExecute() public {
        bytes memory data = abi.encodeCall(Probe.ping, ());
        vm.prank(stranger);
        vm.expectRevert(Allowance.NotAgent.selector);
        wallet.execute(address(probe), 0, data);

        vm.prank(owner); // not even the owner
        vm.expectRevert(Allowance.NotAgent.selector);
        wallet.execute(address(probe), 0, data);
        assertEq(probe.calls(), 0);
    }

    function test_disallowedTargetReverts() public {
        vm.expectRevert(Allowance.TargetNotAllowed.selector);
        _exec(address(other), 0, abi.encodeCall(Probe.ping, ()));
        vm.expectRevert(Allowance.TargetNotAllowed.selector);
        _exec(stranger, 0.1 ether, "");

        vm.prank(owner);
        wallet.setTarget(address(probe), false);
        vm.expectRevert(Allowance.TargetNotAllowed.selector);
        _ping(0);
        assertEq(wallet.spentToday(), 0);
    }

    function test_valueZeroCallsAreUnlimited() public {
        _ping(CAP);
        for (uint256 i = 0; i < 50; i++) {
            _ping(0);
        }
        assertEq(probe.calls(), 51);
        assertEq(wallet.spentToday(), CAP);

        vm.prank(owner);
        wallet.setDailyCap(0); // below what was spent today
        _ping(0);
        assertEq(probe.calls(), 52);
    }

    function test_revertDataBubblesUp() public {
        vm.expectRevert(abi.encodeWithSelector(Probe.Refused.selector, 42));
        _exec(address(probe), 0, abi.encodeCall(Probe.refuse, (42)));

        vm.expectRevert(bytes("probe says no"));
        _exec(address(probe), 0, abi.encodeCall(Probe.refuseWithReason, ()));
    }

    function test_failedCallDoesNotCountAgainstTheCap() public {
        vm.expectRevert(abi.encodeWithSelector(Probe.Refused.selector, 7));
        _exec(address(probe), 0.5 ether, abi.encodeCall(Probe.refuse, (7)));
        assertEq(wallet.spentToday(), 0);
        assertEq(wallet.remainingToday(), CAP);
        assertEq(address(wallet).balance, FUNDING);
    }

    function test_spendIsCountedBeforeTheCall() public {
        _ping(0.2 ether);
        assertEq(probe.spentSeen(), 0.2 ether);
        _ping(0.3 ether);
        assertEq(probe.spentSeen(), 0.5 ether);
    }

    function test_targetCannotReenter() public {
        vm.expectRevert(Allowance.NotAgent.selector);
        _exec(address(probe), 0, abi.encodeCall(Probe.reenter, (0.1 ether)));
        assertEq(probe.calls(), 0);
        assertEq(wallet.spentToday(), 0);
    }

    function test_cannotSendMoreThanTheBalance() public {
        vm.prank(owner);
        wallet.setDailyCap(100 ether);
        vm.expectRevert(Allowance.InsufficientBalance.selector);
        _ping(FUNDING + 1);
        _ping(FUNDING);
        assertEq(address(wallet).balance, 0);
    }

    // ---------------------------------------------------------------- owner

    function test_ownerWithdraws() public {
        vm.prank(stranger);
        vm.expectRevert(Allowance.NotOwner.selector);
        wallet.withdraw(1 ether);
        vm.prank(agent);
        vm.expectRevert(Allowance.NotOwner.selector);
        wallet.withdraw(1 ether);

        vm.prank(owner);
        vm.expectRevert(Allowance.InsufficientBalance.selector);
        wallet.withdraw(FUNDING + 1);

        vm.expectEmit(address(wallet));
        emit Allowance.Withdrawn(owner, 2 ether);
        vm.prank(owner);
        wallet.withdraw(2 ether);
        assertEq(owner.balance, 2 ether);
        assertEq(address(wallet).balance, FUNDING - 2 ether);

        vm.prank(owner);
        wallet.withdraw(FUNDING - 2 ether);
        assertEq(owner.balance, FUNDING);
        assertEq(address(wallet).balance, 0);
    }

    function test_withdrawToAnOwnerThatRefusesEthReverts() public {
        Refuser refuser = new Refuser();
        vm.prank(owner);
        wallet.transferOwnership(address(refuser));
        refuser.accept(wallet);
        vm.expectRevert(Allowance.TransferFailed.selector);
        refuser.pull(wallet, 1 ether);
        assertEq(address(wallet).balance, FUNDING);
    }

    function test_setAgentMovesTheKey() public {
        vm.prank(stranger);
        vm.expectRevert(Allowance.NotOwner.selector);
        wallet.setAgent(stranger);

        vm.expectEmit(address(wallet));
        emit Allowance.AgentSet(stranger);
        vm.prank(owner);
        wallet.setAgent(stranger);
        assertEq(wallet.agent(), stranger);

        vm.expectRevert(Allowance.NotAgent.selector);
        _ping(0); // the old key
        vm.prank(stranger);
        wallet.execute(address(probe), 0, abi.encodeCall(Probe.ping, ()));
        assertEq(probe.calls(), 1);
    }

    function test_setAgentToZeroSwitchesTheAgentOff() public {
        vm.prank(owner);
        wallet.setAgent(address(0));
        vm.expectRevert(Allowance.NotAgent.selector);
        _ping(0);
        vm.prank(owner);
        vm.expectRevert(Allowance.NotAgent.selector);
        wallet.execute(address(probe), 0, abi.encodeCall(Probe.ping, ()));
    }

    function test_setDailyCap() public {
        vm.prank(stranger);
        vm.expectRevert(Allowance.NotOwner.selector);
        wallet.setDailyCap(0);

        _ping(0.5 ether);
        vm.expectEmit(address(wallet));
        emit Allowance.DailyCapSet(2 ether);
        vm.prank(owner);
        wallet.setDailyCap(2 ether);
        assertEq(wallet.remainingToday(), 1.5 ether); // what was spent today still counts
        _ping(1.5 ether);

        vm.prank(owner);
        wallet.setDailyCap(1 ether); // below what was spent today
        assertEq(wallet.remainingToday(), 0);
        vm.expectRevert(Allowance.CapExceeded.selector);
        _ping(1);

        vm.warp(_midnightAfter(block.timestamp));
        assertEq(wallet.remainingToday(), 1 ether);
        _ping(1 ether);
    }

    function test_setTarget() public {
        vm.prank(stranger);
        vm.expectRevert(Allowance.NotOwner.selector);
        wallet.setTarget(address(other), true);

        vm.prank(owner);
        vm.expectRevert(Allowance.ZeroAddress.selector);
        wallet.setTarget(address(0), true);

        vm.expectEmit(address(wallet));
        emit Allowance.TargetSet(address(other), true);
        vm.prank(owner);
        wallet.setTarget(address(other), true);
        assertTrue(wallet.allowedTarget(address(other)));
        _exec(address(other), 0.1 ether, abi.encodeCall(Probe.ping, ()));
        assertEq(other.calls(), 1);

        vm.expectEmit(address(wallet));
        emit Allowance.TargetSet(address(other), false);
        vm.prank(owner);
        wallet.setTarget(address(other), false);
        assertFalse(wallet.allowedTarget(address(other)));
    }

    // ---------------------------------------------------------------- ownership

    function test_ownershipMovesInTwoSteps() public {
        vm.prank(stranger);
        vm.expectRevert(Allowance.NotOwner.selector);
        wallet.transferOwnership(stranger);

        vm.prank(owner);
        wallet.transferOwnership(multisig);
        assertEq(wallet.owner(), owner); // nothing changes until accepted
        assertEq(wallet.pendingOwner(), multisig);

        vm.prank(stranger);
        vm.expectRevert(Allowance.NotPendingOwner.selector);
        wallet.acceptOwnership();

        vm.expectEmit(address(wallet));
        emit Allowance.OwnershipTransferred(owner, multisig);
        vm.prank(multisig);
        wallet.acceptOwnership();
        assertEq(wallet.owner(), multisig);
        assertEq(wallet.pendingOwner(), address(0));

        vm.prank(owner);
        vm.expectRevert(Allowance.NotOwner.selector);
        wallet.withdraw(1 ether);
        vm.prank(multisig);
        wallet.withdraw(1 ether);
        assertEq(multisig.balance, 1 ether);
    }

    function test_pendingOwnershipTransferCanBeCancelled() public {
        vm.startPrank(owner);
        wallet.transferOwnership(multisig);
        wallet.transferOwnership(address(0));
        vm.stopPrank();
        vm.prank(multisig);
        vm.expectRevert(Allowance.NotPendingOwner.selector);
        wallet.acceptOwnership();
        assertEq(wallet.owner(), owner);
    }

    // ---------------------------------------------------------------- factory

    function test_factoryFundsAndSetsOwner() public {
        address[] memory targets = new address[](1);
        targets[0] = address(swarm);
        vm.deal(owner, 3 ether);
        address expected = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));

        vm.expectEmit(address(factory));
        emit AllowanceFactory.Created(owner, agent, expected);
        vm.prank(owner);
        Allowance created = factory.create{value: 2 ether}(agent, CAP, targets);

        assertEq(address(created), expected);
        assertEq(created.owner(), owner);
        assertEq(created.agent(), agent);
        assertEq(created.dailyCap(), CAP);
        assertTrue(created.allowedTarget(address(swarm)));
        assertFalse(created.allowedTarget(address(probe)));
        assertEq(address(created).balance, 2 ether);
        assertEq(address(factory).balance, 0);
        assertEq(owner.balance, 1 ether);

        vm.prank(owner);
        created.withdraw(2 ether);
        assertEq(owner.balance, 3 ether);
    }

    function test_factoryWithoutFundingAndWithBadInput() public {
        address[] memory targets = new address[](0);
        vm.prank(stranger);
        Allowance created = factory.create(agent, CAP, targets);
        assertEq(created.owner(), stranger);
        assertEq(address(created).balance, 0);

        vm.expectRevert(Allowance.ZeroAddress.selector);
        factory.create(address(0), CAP, targets);
    }

    // ---------------------------------------------------------------- SwarmMarket

    function _hostRuns(uint256 id, uint32 t, address host) internal {
        uint32[] memory tasks = new uint32[](1);
        tasks[0] = t;
        vm.prank(host);
        swarm.claim(id, tasks);
    }

    function _hostCommits(uint256 id, uint32 t, address host) internal {
        uint32[] memory tasks = new uint32[](1);
        tasks[0] = t;
        bytes32[] memory commits = new bytes32[](1);
        commits[0] = swarm.commitHash(id, t, host, GOOD, keccak256(abi.encode(host)));
        vm.prank(host);
        swarm.submit(id, tasks, commits);
    }

    function _hostReveals(uint256 id, uint32 t, address host) internal {
        uint32[] memory tasks = new uint32[](1);
        tasks[0] = t;
        bytes32[] memory results = new bytes32[](1);
        results[0] = GOOD;
        bytes32[] memory salts = new bytes32[](1);
        salts[0] = keccak256(abi.encode(host));
        vm.prank(host);
        swarm.reveal(id, tasks, results, salts);
    }

    function test_agentRunsASwarmJobAndTheRefundComesHome() public {
        address[] memory targets = new address[](1);
        targets[0] = address(swarm);
        uint256 cap = 0.004 ether;
        vm.deal(owner, 1 ether);
        vm.prank(owner);
        Allowance w = factory.create{value: 1 ether}(agent, cap, targets);

        // The agent posts a 3-task job: the wallet is the renter and pays the deposit.
        uint256 deposit = uint256(PRICE) * 3 * 3;
        bytes memory post = abi.encodeCall(SwarmMarket.postJob, (PRICE, 3, LEASE, MANIFEST));
        vm.prank(agent);
        uint256 id = abi.decode(w.execute(address(swarm), deposit, post), (uint256));
        assertEq(swarm.getJob(id).renter, address(w));
        assertEq(address(swarm).balance, deposit);
        assertEq(address(w).balance, 1 ether - deposit);
        assertEq(w.spentToday(), deposit);

        // A second job would go over today's cap.
        bytes memory big = abi.encodeCall(SwarmMarket.postJob, (PRICE, 12, LEASE, MANIFEST));
        vm.prank(agent);
        vm.expectRevert(Allowance.CapExceeded.selector);
        w.execute(address(swarm), uint256(PRICE) * 12 * 3, big);

        // Two hosts finish task 0; the agent then cancels the rest.
        _hostRuns(id, 0, hostA);
        _hostRuns(id, 0, hostB);
        _hostCommits(id, 0, hostA);
        _hostCommits(id, 0, hostB);
        _hostReveals(id, 0, hostA);
        _hostReveals(id, 0, hostB);
        vm.prank(agent);
        w.execute(address(swarm), 0, abi.encodeCall(SwarmMarket.cancelJob, (id)));
        assertTrue(swarm.getJob(id).cancelled);

        // Too early to close: the market's own error comes back through execute.
        bytes memory close = abi.encodeCall(SwarmMarket.closeJob, (id));
        vm.prank(agent);
        vm.expectRevert(SwarmMarket.NotClosable.selector);
        w.execute(address(swarm), 0, close);

        vm.warp(block.timestamp + 2 * uint256(LEASE) + 1);
        vm.prank(agent);
        w.execute(address(swarm), 0, close);
        uint256 refund = deposit - 2 * uint256(PRICE);
        assertEq(swarm.balances(address(w)), refund);
        assertEq(swarm.balances(agent), 0);

        // The agent's own key holds nothing at the market; only the wallet can pull the refund.
        vm.prank(agent);
        vm.expectRevert(SwarmMarket.NothingToWithdraw.selector);
        swarm.withdraw();

        vm.expectEmit(address(w));
        emit Allowance.Funded(address(swarm), refund);
        vm.prank(agent);
        w.execute(address(swarm), 0, abi.encodeCall(SwarmMarket.withdraw, ()));
        assertEq(address(w).balance, 1 ether - deposit + refund);
        assertEq(agent.balance, 0);
        assertEq(swarm.balances(address(w)), 0);
        assertEq(w.spentToday(), deposit); // calls without value did not touch the cap

        // The owner takes it all out.
        uint256 left = address(w).balance;
        vm.prank(owner);
        w.withdraw(left);
        assertEq(owner.balance, left);
        assertEq(address(w).balance, 0);
    }
}
