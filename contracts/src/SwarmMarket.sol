// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IStakeRegistry} from "./interfaces/IStakeRegistry.sol";

/// @title SwarmMarket — one job, many peers.
/// @notice A renter posts a job: a container and a list of independent tasks, with the ETH for
///         three runs of every task held in escrow. Hosts claim tasks on short leases, run them
///         and submit a hash of the output. Every task runs on two different hosts; matching
///         hashes pay both. If they differ, a third host breaks the tie: the two that agree are
///         paid and the odd one out is recorded as a fault. Whatever is not paid out goes back to
///         the renter when the job is closed. Nobody operates this contract.
contract SwarmMarket {
    /// @dev Two replicas plus one tie-break.
    uint8 public constant RUNS = 3;
    uint256 public constant MAX_MANIFEST = 64 * 1024;
    uint256 public constant MAX_TASKS = 100_000;
    uint256 public constant MAX_BATCH = 32;
    uint256 public constant MAX_ENDPOINT = 256;
    uint32 public constant MIN_LEASE = 60;
    uint32 public constant MAX_LEASE = 1 days;

    enum TaskState {
        Open,
        Done,
        Failed
    }

    /// @dev Compact task status for front ends, see taskStatuses().
    uint8 public constant STATUS_WAITING = 0; // no run in progress, no result yet
    uint8 public constant STATUS_RUNNING = 1; // at least one lease active, no result yet
    uint8 public constant STATUS_PARTIAL = 2; // one result in, waiting for its replica
    uint8 public constant STATUS_DISPUTED = 3; // two results disagree, tie-break pending
    uint8 public constant STATUS_DONE = 4;
    uint8 public constant STATUS_FAILED = 5; // all three runs disagreed

    struct Job {
        address renter;
        uint96 pricePerRun; // wei paid to a host for one accepted run
        uint32 taskCount;
        uint32 leaseSeconds;
        uint32 resolved; // tasks done or failed
        uint32 done;
        bool cancelled;
        bool closed;
        uint64 postedBlock; // where to find the manifest in the JobPosted event
        uint64 lastLeaseEnd;
        uint128 deposit;
        uint128 paid;
        bytes32 manifestHash;
    }

    struct Run {
        address host;
        uint64 leaseEnd;
        bytes32 result; // keccak256 of the output, 0 while running
    }

    struct Task {
        Run[3] runs;
        TaskState state;
    }

    struct JobView {
        uint256 id;
        Job job;
    }

    IStakeRegistry public immutable stake;

    Job[] private _jobs;
    mapping(uint256 => mapping(uint32 => Task)) private _tasks;
    mapping(address => uint256) public balances; // ETH owed, pulled with withdraw()
    mapping(address => string) public workerEndpoint; // where a host serves the outputs it produced
    mapping(address => uint32) public faults; // runs a host lost a tie-break on

    event JobPosted(
        uint256 indexed jobId,
        address indexed renter,
        uint96 pricePerRun,
        uint32 taskCount,
        uint32 leaseSeconds,
        bytes manifest
    );
    event Claimed(uint256 indexed jobId, uint32 indexed task, uint8 slot, address indexed host, uint64 leaseEnd);
    event Submitted(uint256 indexed jobId, uint32 indexed task, uint8 slot, address indexed host, bytes32 result);
    event TaskDisputed(uint256 indexed jobId, uint32 indexed task);
    event TaskDone(uint256 indexed jobId, uint32 indexed task, bytes32 result);
    event TaskFailed(uint256 indexed jobId, uint32 indexed task);
    event Fault(uint256 indexed jobId, uint32 indexed task, address indexed host, bytes32 result);
    event JobCancelled(uint256 indexed jobId);
    event JobClosed(uint256 indexed jobId, uint256 refunded);
    event WorkerRegistered(address indexed host, string endpoint);
    event Withdrawn(address indexed account, uint256 amount);

    error BadJob();
    error WrongValue();
    error ManifestSize();
    error NotRenter();
    error JobInactive();
    error NotEligible();
    error BatchTooLarge();
    error LengthMismatch();
    error NotClosable();
    error EndpointTooLong();
    error NothingToWithdraw();
    error TransferFailed();
    error BadRange();

    constructor(IStakeRegistry stake_) {
        stake = stake_;
    }

    // ---------------------------------------------------------------- renters

    /// @notice Post a job. Send exactly pricePerRun × taskCount × 3: room for two replicas and a
    ///         tie-break of every task. The manifest (container, command and task inputs, as JSON)
    ///         is only emitted in the event; the contract keeps its hash.
    function postJob(uint96 pricePerRun, uint32 taskCount, uint32 leaseSeconds, bytes calldata manifest)
        external
        payable
        returns (uint256 jobId)
    {
        if (pricePerRun == 0 || taskCount == 0 || taskCount > MAX_TASKS) revert BadJob();
        if (leaseSeconds < MIN_LEASE || leaseSeconds > MAX_LEASE) revert BadJob();
        if (manifest.length == 0 || manifest.length > MAX_MANIFEST) revert ManifestSize();
        uint256 deposit = uint256(pricePerRun) * taskCount * RUNS;
        if (msg.value != deposit || deposit > type(uint128).max) revert WrongValue();

        jobId = _jobs.length;
        _jobs.push(
            Job({
                renter: msg.sender,
                pricePerRun: pricePerRun,
                taskCount: taskCount,
                leaseSeconds: leaseSeconds,
                resolved: 0,
                done: 0,
                cancelled: false,
                closed: false,
                postedBlock: uint64(block.number),
                lastLeaseEnd: 0,
                deposit: uint128(deposit),
                paid: 0,
                manifestHash: keccak256(manifest)
            })
        );
        emit JobPosted(jobId, msg.sender, pricePerRun, taskCount, leaseSeconds, manifest);
    }

    /// @notice Stop new claims. Runs already leased may still finish and are paid if they agree.
    function cancelJob(uint256 jobId) external {
        Job storage job = _job(jobId);
        if (msg.sender != job.renter) revert NotRenter();
        if (job.closed || job.cancelled) revert JobInactive();
        job.cancelled = true;
        emit JobCancelled(jobId);
    }

    /// @notice Close a finished job, or a cancelled one once its last lease has run out, and
    ///         credit the unspent deposit back to the renter.
    function closeJob(uint256 jobId) external {
        Job storage job = _job(jobId);
        if (msg.sender != job.renter) revert NotRenter();
        if (job.closed) revert JobInactive();
        bool finished = job.resolved == job.taskCount;
        bool drained = job.cancelled && block.timestamp > job.lastLeaseEnd;
        if (!finished && !drained) revert NotClosable();
        job.closed = true;
        uint256 refund = job.deposit - job.paid;
        balances[job.renter] += refund;
        emit JobClosed(jobId, refund);
    }

    // ---------------------------------------------------------------- hosts

    /// @notice Tell renters where to fetch the outputs this host produces (an https URL).
    function registerWorker(string calldata endpoint) external {
        if (bytes(endpoint).length > MAX_ENDPOINT) revert EndpointTooLong();
        workerEndpoint[msg.sender] = endpoint;
        emit WorkerRegistered(msg.sender, endpoint);
    }

    /// @notice Lease runs of the given tasks for leaseSeconds. Tasks with nothing to run for this
    ///         host are skipped rather than reverting, so two hosts racing for the same tasks both
    ///         succeed with whatever is left. A host never runs the same task twice.
    function claim(uint256 jobId, uint32[] calldata tasks) external returns (uint256 claimed) {
        Job storage job = _job(jobId);
        if (job.cancelled || job.closed) revert JobInactive();
        if (!stake.isEligible(msg.sender)) revert NotEligible();
        if (tasks.length > MAX_BATCH) revert BatchTooLarge();

        uint64 leaseEnd = uint64(block.timestamp) + job.leaseSeconds;
        for (uint256 i = 0; i < tasks.length; i++) {
            uint32 t = tasks[i];
            if (t >= job.taskCount) continue;
            Task storage task = _tasks[jobId][t];
            uint8 slot = _freeSlot(task, msg.sender);
            if (slot == RUNS) continue;
            task.runs[slot] = Run({host: msg.sender, leaseEnd: leaseEnd, result: bytes32(0)});
            emit Claimed(jobId, t, slot, msg.sender, leaseEnd);
            claimed++;
        }
        if (claimed > 0 && leaseEnd > job.lastLeaseEnd) job.lastLeaseEnd = leaseEnd;
    }

    /// @notice Submit output hashes for runs this host holds. A late result is still accepted as
    ///         long as nobody else has taken the run over.
    function submit(uint256 jobId, uint32[] calldata tasks, bytes32[] calldata results) external {
        Job storage job = _job(jobId);
        if (job.closed) revert JobInactive();
        if (tasks.length != results.length) revert LengthMismatch();
        if (tasks.length > MAX_BATCH) revert BatchTooLarge();

        for (uint256 i = 0; i < tasks.length; i++) {
            uint32 t = tasks[i];
            if (t >= job.taskCount || results[i] == bytes32(0)) continue;
            Task storage task = _tasks[jobId][t];
            if (task.state != TaskState.Open) continue;
            for (uint8 s = 0; s < RUNS; s++) {
                Run storage run = task.runs[s];
                if (run.host == msg.sender && run.result == bytes32(0)) {
                    run.result = results[i];
                    emit Submitted(jobId, t, s, msg.sender, results[i]);
                    _settle(job, jobId, t, task);
                    break;
                }
            }
        }
    }

    /// @notice Pull everything you are owed: host earnings and renter refunds.
    function withdraw() external {
        uint256 amount = balances[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        balances[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------- views

    function jobCount() external view returns (uint256) {
        return _jobs.length;
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _job(jobId);
    }

    /// @notice Newest first: ids jobCount-1-offset down to jobCount-offset-n.
    function getJobs(uint256 offset, uint256 limit) external view returns (JobView[] memory page) {
        uint256 total = _jobs.length;
        if (offset > total) revert BadRange();
        uint256 n = total - offset;
        if (n > limit) n = limit;
        page = new JobView[](n);
        for (uint256 i = 0; i < n; i++) {
            uint256 id = total - 1 - offset - i;
            page[i] = JobView({id: id, job: _jobs[id]});
        }
    }

    function getTask(uint256 jobId, uint32 t) external view returns (Run[3] memory runs, TaskState state) {
        _job(jobId);
        Task storage task = _tasks[jobId][t];
        return (task.runs, task.state);
    }

    /// @notice One STATUS_* code per task, for tasks offset..offset+limit-1.
    function taskStatuses(uint256 jobId, uint32 offset, uint32 limit) external view returns (uint8[] memory out) {
        Job storage job = _job(jobId);
        if (offset > job.taskCount) revert BadRange();
        uint256 n = job.taskCount - offset;
        if (n > limit) n = limit;
        out = new uint8[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = _status(_tasks[jobId][uint32(offset + i)]);
        }
    }

    /// @notice Up to `max` tasks in [from, from+scan) that `host` could claim right now.
    function claimable(uint256 jobId, address host, uint32 from, uint32 scan, uint32 max)
        external
        view
        returns (uint32[] memory found)
    {
        Job storage job = _job(jobId);
        found = new uint32[](max);
        if (job.cancelled || job.closed) return _trim(found, 0);
        uint256 end = uint256(from) + scan;
        if (end > job.taskCount) end = job.taskCount;
        uint256 n;
        for (uint256 t = from; t < end && n < max; t++) {
            if (_freeSlot(_tasks[jobId][uint32(t)], host) != RUNS) found[n++] = uint32(t);
        }
        return _trim(found, n);
    }

    // ---------------------------------------------------------------- internal

    function _job(uint256 jobId) internal view returns (Job storage) {
        if (jobId >= _jobs.length) revert BadJob();
        return _jobs[jobId];
    }

    /// @dev The slot `host` may take in `task`, or RUNS when there is none.
    function _freeSlot(Task storage task, address host) internal view returns (uint8) {
        if (task.state != TaskState.Open) return RUNS;
        Run storage r0 = task.runs[0];
        Run storage r1 = task.runs[1];
        Run storage r2 = task.runs[2];
        if (r0.host == host || r1.host == host || r2.host == host) return RUNS;
        if (_takeable(r0)) return 0;
        if (_takeable(r1)) return 1;
        bool disputed = r0.result != bytes32(0) && r1.result != bytes32(0) && r0.result != r1.result;
        if (disputed && _takeable(r2)) return 2;
        return RUNS;
    }

    /// @dev Never claimed, or leased and expired without a result.
    function _takeable(Run storage run) internal view returns (bool) {
        return run.host == address(0) || (run.result == bytes32(0) && run.leaseEnd < block.timestamp);
    }

    function _settle(Job storage job, uint256 jobId, uint32 t, Task storage task) internal {
        Run storage r0 = task.runs[0];
        Run storage r1 = task.runs[1];
        Run storage r2 = task.runs[2];
        if (r0.result == bytes32(0) || r1.result == bytes32(0)) return;

        if (r0.result == r1.result) {
            _pay(job, r0.host);
            _pay(job, r1.host);
            _finish(job, jobId, t, task, r0.result);
            return;
        }
        if (r2.result == bytes32(0)) {
            emit TaskDisputed(jobId, t);
            return;
        }
        if (r2.result == r0.result || r2.result == r1.result) {
            (Run storage agree, Run storage odd) = r2.result == r0.result ? (r0, r1) : (r1, r0);
            _pay(job, agree.host);
            _pay(job, r2.host);
            faults[odd.host] += 1;
            emit Fault(jobId, t, odd.host, odd.result);
            _finish(job, jobId, t, task, r2.result);
            return;
        }
        task.state = TaskState.Failed;
        job.resolved += 1;
        emit TaskFailed(jobId, t);
    }

    function _finish(Job storage job, uint256 jobId, uint32 t, Task storage task, bytes32 result) internal {
        task.state = TaskState.Done;
        job.done += 1;
        job.resolved += 1;
        emit TaskDone(jobId, t, result);
    }

    function _pay(Job storage job, address host) internal {
        balances[host] += job.pricePerRun;
        job.paid += job.pricePerRun;
    }

    function _status(Task storage task) internal view returns (uint8) {
        if (task.state == TaskState.Done) return STATUS_DONE;
        if (task.state == TaskState.Failed) return STATUS_FAILED;
        Run storage r0 = task.runs[0];
        Run storage r1 = task.runs[1];
        if (r0.result != bytes32(0) && r1.result != bytes32(0)) return STATUS_DISPUTED;
        if (r0.result != bytes32(0) || r1.result != bytes32(0)) return STATUS_PARTIAL;
        for (uint8 s = 0; s < RUNS; s++) {
            Run storage r = task.runs[s];
            if (r.host != address(0) && r.result == bytes32(0) && r.leaseEnd >= block.timestamp) return STATUS_RUNNING;
        }
        return STATUS_WAITING;
    }

    function _trim(uint32[] memory a, uint256 n) internal pure returns (uint32[] memory) {
        assembly {
            mstore(a, n)
        }
        return a;
    }
}
