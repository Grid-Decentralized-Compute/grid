// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IArbSys} from "./interfaces/IArbSys.sol";
import {IStakeRegistry} from "./interfaces/IStakeRegistry.sol";

/// @title SwarmMarket — one job, many peers.
/// @notice A renter posts a job: a container and a list of independent tasks, with the ETH for
///         three runs of every task held in escrow. Hosts claim tasks on short leases, run them
///         and commit to a salted hash of the output; once both replicas of a task have
///         committed, each reveals its output hash. Commits bind the host, so a replica cannot
///         copy the other's answer. Matching hashes pay both. If they differ, a third host
///         breaks the tie: the two that agree are paid and the odd one out is recorded as a
///         fault. A host that commits and then does not reveal in time loses the run and gets a
///         fault. Whatever is not paid out goes back to the renter when the job is closed.
///         A fixed protocol fee comes out of the host's side of every paid run and accrues to
///         the treasury; the renter pays the price per run as posted. Nobody operates this
///         contract.
contract SwarmMarket {
    /// @dev Two replicas plus one tie-break.
    uint8 public constant RUNS = 3;
    uint256 public constant MAX_MANIFEST = 64 * 1024;
    uint256 public constant MAX_TASKS = 100_000;
    uint256 public constant MAX_BATCH = 32;
    uint256 public constant MAX_ENDPOINT = 256;
    uint32 public constant MIN_LEASE = 60;
    uint32 public constant MAX_LEASE = 1 days;
    /// @dev The protocol fee, in basis points of pricePerRun, taken from the host's side of each paid run.
    uint256 public constant FEE_BPS = 200;
    /// @dev The fee for a host that is bonded (StakeRegistry.isEligible) when the run is paid.
    uint256 public constant BONDED_FEE_BPS = 100;
    /// @dev The ArbSys precompile; nothing lives there on anvil.
    address private constant ARB_SYS = address(100);

    enum TaskState {
        Open,
        Done,
        Failed
    }

    /// @dev Compact task status for front ends, see taskStatuses().
    uint8 public constant STATUS_WAITING = 0; // no run in progress, no result yet
    uint8 public constant STATUS_RUNNING = 1; // a run is leased or committed, nothing revealed yet
    uint8 public constant STATUS_PARTIAL = 2; // one replica revealed, waiting for the other
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
        uint64 postedBlock; // this chain's block holding the JobPosted event with the manifest
        uint64 lastLeaseEnd; // latest lease end or reveal deadline handed out
        uint128 deposit;
        uint128 paid;
        bytes32 manifestHash;
    }

    struct Run {
        address host;
        uint64 leaseEnd; // lease end; the reveal deadline once this run's reveal is open
        bytes32 commit; // commitHash(...) of the output, 0 until committed
        bytes32 result; // keccak256 of the output, 0 until revealed
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
    /// @dev Where fees accrue. Meant to be the project treasury (a multisig); it withdraws like anyone.
    address public immutable treasury;

    Job[] private _jobs;
    mapping(uint256 => mapping(uint32 => Task)) private _tasks;
    mapping(address => uint256) public balances; // ETH owed, pulled with withdraw()
    mapping(address => string) public workerEndpoint; // where a host serves the outputs it produced
    mapping(address => uint32) public faults; // runs a host lost a tie-break on or never revealed

    event JobPosted(
        uint256 indexed jobId,
        address indexed renter,
        uint96 pricePerRun,
        uint32 taskCount,
        uint32 leaseSeconds,
        bytes manifest
    );
    event Claimed(uint256 indexed jobId, uint32 indexed task, uint8 slot, address indexed host, uint64 leaseEnd);
    event Committed(uint256 indexed jobId, uint32 indexed task, uint8 slot, address indexed host);
    event Submitted(uint256 indexed jobId, uint32 indexed task, uint8 slot, address indexed host, bytes32 result);
    event TaskDisputed(uint256 indexed jobId, uint32 indexed task);
    event TaskDone(uint256 indexed jobId, uint32 indexed task, bytes32 result);
    event TaskFailed(uint256 indexed jobId, uint32 indexed task);
    /// @dev result is 0 when the host committed and then missed its reveal deadline.
    event Fault(uint256 indexed jobId, uint32 indexed task, address indexed host, bytes32 result);
    event JobCancelled(uint256 indexed jobId);
    event JobClosed(uint256 indexed jobId, uint256 refunded);
    /// @dev The protocol fee taken from one paid run.
    event FeeAccrued(uint256 indexed jobId, uint32 task, address indexed host, uint256 amount);
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

    error ZeroAddress();

    constructor(IStakeRegistry stake_, address treasury_) {
        if (treasury_ == address(0)) revert ZeroAddress();
        stake = stake_;
        treasury = treasury_;
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
                postedBlock: _blockNumber(),
                lastLeaseEnd: 0,
                deposit: uint128(deposit),
                paid: 0,
                manifestHash: keccak256(manifest)
            })
        );
        emit JobPosted(jobId, msg.sender, pricePerRun, taskCount, leaseSeconds, manifest);
    }

    /// @notice Stop work on tasks nobody has started. A task that already has a run keeps going:
    ///         its open slots can still be claimed, and its commits and reveals are paid if they
    ///         agree.
    function cancelJob(uint256 jobId) external {
        Job storage job = _job(jobId);
        if (msg.sender != job.renter) revert NotRenter();
        if (job.closed || job.cancelled) revert JobInactive();
        job.cancelled = true;
        emit JobCancelled(jobId);
    }

    /// @notice Close a finished job, or a cancelled one once its last lease or reveal deadline
    ///         plus one more leaseSeconds of grace has run out, and credit the unspent deposit
    ///         back to the renter. Nothing is committed, revealed or paid after this.
    function closeJob(uint256 jobId) external {
        Job storage job = _job(jobId);
        if (msg.sender != job.renter) revert NotRenter();
        if (job.closed) revert JobInactive();
        bool finished = job.resolved == job.taskCount;
        bool drained = job.cancelled && block.timestamp > uint256(job.lastLeaseEnd) + job.leaseSeconds;
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
    ///         succeed with whatever is left. A host never runs the same task twice. Once the job
    ///         is cancelled only tasks that already have a run are handed out. Taking over a run
    ///         that committed and then missed its reveal deadline records a fault on its host.
    function claim(uint256 jobId, uint32[] calldata tasks) external returns (uint256 claimed) {
        Job storage job = _job(jobId);
        if (job.closed) revert JobInactive();
        if (!stake.isEligible(msg.sender)) revert NotEligible();
        if (tasks.length > MAX_BATCH) revert BatchTooLarge();

        uint64 leaseEnd = uint64(block.timestamp) + job.leaseSeconds;
        for (uint256 i = 0; i < tasks.length; i++) {
            uint32 t = tasks[i];
            if (t >= job.taskCount) continue;
            Task storage task = _tasks[jobId][t];
            uint8 slot = _claimSlot(job, task, msg.sender);
            if (slot == RUNS) continue;
            Run storage run = task.runs[slot];
            if (run.commit != bytes32(0)) {
                faults[run.host] += 1;
                emit Fault(jobId, t, run.host, bytes32(0));
            }
            task.runs[slot] = Run({host: msg.sender, leaseEnd: leaseEnd, commit: bytes32(0), result: bytes32(0)});
            emit Claimed(jobId, t, slot, msg.sender, leaseEnd);
            claimed++;
        }
        if (claimed > 0 && leaseEnd > job.lastLeaseEnd) job.lastLeaseEnd = leaseEnd;
    }

    /// @notice Commit to the outputs of runs this host holds: commits[i] is
    ///         commitHash(jobId, tasks[i], msg.sender, result, salt) with a fresh random salt the
    ///         host keeps for reveal(). A late commit is still accepted as long as nobody else has
    ///         taken the run over. When the second replica commits, reveal opens and both replicas
    ///         have leaseSeconds from then to reveal; a tie-break run gets the same window from its
    ///         own commit.
    function submit(uint256 jobId, uint32[] calldata tasks, bytes32[] calldata commits) external {
        Job storage job = _job(jobId);
        if (job.closed) revert JobInactive();
        if (tasks.length != commits.length) revert LengthMismatch();
        if (tasks.length > MAX_BATCH) revert BatchTooLarge();

        uint64 deadline = uint64(block.timestamp) + job.leaseSeconds;
        bool opened;
        for (uint256 i = 0; i < tasks.length; i++) {
            uint32 t = tasks[i];
            if (t >= job.taskCount || commits[i] == bytes32(0)) continue;
            Task storage task = _tasks[jobId][t];
            if (task.state != TaskState.Open) continue;
            uint8 s = _slotOf(task, msg.sender);
            if (s == RUNS) continue;
            Run storage run = task.runs[s];
            if (run.commit != bytes32(0)) continue;
            run.commit = commits[i];
            emit Committed(jobId, t, s, msg.sender);

            if (s == 2) {
                run.leaseEnd = deadline;
                opened = true;
            } else if (task.runs[1 - s].commit != bytes32(0)) {
                task.runs[0].leaseEnd = deadline;
                task.runs[1].leaseEnd = deadline;
                opened = true;
            }
        }
        if (opened && deadline > job.lastLeaseEnd) job.lastLeaseEnd = deadline;
    }

    /// @notice Reveal the outputs committed with submit(). A replica reveals once both replicas of
    ///         the task have committed; a tie-break run once it has committed. A reveal that does
    ///         not match the commit is skipped; a late one counts as long as nobody has taken the
    ///         run over. Each reveal settles the task as soon as there is enough to decide it.
    ///         Works on a cancelled job, not on a closed one.
    function reveal(uint256 jobId, uint32[] calldata tasks, bytes32[] calldata results, bytes32[] calldata salts)
        external
    {
        Job storage job = _job(jobId);
        if (job.closed) revert JobInactive();
        if (tasks.length != results.length || tasks.length != salts.length) revert LengthMismatch();
        if (tasks.length > MAX_BATCH) revert BatchTooLarge();

        for (uint256 i = 0; i < tasks.length; i++) {
            uint32 t = tasks[i];
            if (t >= job.taskCount || results[i] == bytes32(0)) continue;
            Task storage task = _tasks[jobId][t];
            if (task.state != TaskState.Open) continue;
            uint8 s = _slotOf(task, msg.sender);
            if (s == RUNS) continue;
            Run storage run = task.runs[s];
            if (run.commit == bytes32(0) || run.result != bytes32(0)) continue;
            if (s != 2 && task.runs[1 - s].commit == bytes32(0)) continue;
            if (commitHash(jobId, t, msg.sender, results[i], salts[i]) != run.commit) continue;
            run.result = results[i];
            emit Submitted(jobId, t, s, msg.sender, results[i]);
            _settle(job, jobId, t, task);
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

    /// @notice What a host commits to for one run. It binds this contract, the chain, the job, the
    ///         task and the host, so a commit copied from another host can never be revealed.
    function commitHash(uint256 jobId, uint32 task, address host, bytes32 result, bytes32 salt)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(address(this), block.chainid, jobId, task, host, result, salt));
    }

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
        if (job.closed) return _trim(found, 0);
        uint256 end = uint256(from) + scan;
        if (end > job.taskCount) end = job.taskCount;
        uint256 n;
        for (uint256 t = from; t < end && n < max; t++) {
            if (_claimSlot(job, _tasks[jobId][uint32(t)], host) != RUNS) found[n++] = uint32(t);
        }
        return _trim(found, n);
    }

    // ---------------------------------------------------------------- internal

    function _job(uint256 jobId) internal view returns (Job storage) {
        if (jobId >= _jobs.length) revert BadJob();
        return _jobs[jobId];
    }

    /// @dev This chain's block number. On an Arbitrum Orbit chain block.number is the parent
    ///      chain's block, while clients look up JobPosted by the chain's own number, so ask
    ///      ArbSys. Anvil has no code at address(100) and falls back to block.number.
    function _blockNumber() private view returns (uint64) {
        if (ARB_SYS.code.length != 0) {
            try IArbSys(ARB_SYS).arbBlockNumber() returns (uint256 n) {
                return uint64(n);
            } catch {}
        }
        return uint64(block.number);
    }

    /// @dev The slot `host` holds in `task`, or RUNS when none. A host holds at most one.
    function _slotOf(Task storage task, address host) internal view returns (uint8) {
        for (uint8 s = 0; s < RUNS; s++) {
            if (task.runs[s].host == host) return s;
        }
        return RUNS;
    }

    /// @dev _freeSlot, except that a cancelled job hands out nothing on tasks nobody has started.
    function _claimSlot(Job storage job, Task storage task, address host) internal view returns (uint8) {
        if (job.cancelled && !_started(task)) return RUNS;
        return _freeSlot(task, host);
    }

    function _started(Task storage task) internal view returns (bool) {
        return task.runs[0].host != address(0) || task.runs[1].host != address(0) || task.runs[2].host != address(0);
    }

    /// @dev The slot `host` may take in `task`, or RUNS when there is none.
    function _freeSlot(Task storage task, address host) internal view returns (uint8) {
        if (task.state != TaskState.Open) return RUNS;
        Run storage r0 = task.runs[0];
        Run storage r1 = task.runs[1];
        Run storage r2 = task.runs[2];
        if (r0.host == host || r1.host == host || r2.host == host) return RUNS;
        bool revealOpen = _revealOpen(task);
        if (_takeable(r0, revealOpen)) return 0;
        if (_takeable(r1, revealOpen)) return 1;
        bool disputed = r0.result != bytes32(0) && r1.result != bytes32(0) && r0.result != r1.result;
        if (disputed && _takeable(r2, true)) return 2;
        return RUNS;
    }

    /// @dev Replicas may reveal once both of them have committed.
    function _revealOpen(Task storage task) internal view returns (bool) {
        return task.runs[0].commit != bytes32(0) && task.runs[1].commit != bytes32(0);
    }

    /// @dev Never claimed, leased and expired without a commit, or committed and past its reveal
    ///      deadline without a reveal. A commit still waiting for reveal to open never expires.
    function _takeable(Run storage run, bool revealOpen) internal view returns (bool) {
        if (run.host == address(0)) return true;
        if (run.result != bytes32(0)) return false;
        if (run.commit != bytes32(0) && !revealOpen) return false;
        return run.leaseEnd < block.timestamp;
    }

    function _settle(Job storage job, uint256 jobId, uint32 t, Task storage task) internal {
        Run storage r0 = task.runs[0];
        Run storage r1 = task.runs[1];
        Run storage r2 = task.runs[2];
        if (r0.result == bytes32(0) || r1.result == bytes32(0)) return;

        if (r0.result == r1.result) {
            _pay(job, jobId, t, r0.host);
            _pay(job, jobId, t, r1.host);
            _finish(job, jobId, t, task, r0.result);
            return;
        }
        if (r2.result == bytes32(0)) {
            emit TaskDisputed(jobId, t);
            return;
        }
        if (r2.result == r0.result || r2.result == r1.result) {
            (Run storage agree, Run storage odd) = r2.result == r0.result ? (r0, r1) : (r1, r0);
            _pay(job, jobId, t, agree.host);
            _pay(job, jobId, t, r2.host);
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

    /// @dev Pays a host for one accepted run, less the protocol fee, which accrues to the treasury.
    function _pay(Job storage job, uint256 jobId, uint32 t, address host) internal {
        uint256 fee = uint256(job.pricePerRun) * (stake.isEligible(host) ? BONDED_FEE_BPS : FEE_BPS) / 10_000;
        balances[host] += job.pricePerRun - fee;
        balances[treasury] += fee;
        job.paid += job.pricePerRun;
        emit FeeAccrued(jobId, t, host, fee);
    }

    function _status(Task storage task) internal view returns (uint8) {
        if (task.state == TaskState.Done) return STATUS_DONE;
        if (task.state == TaskState.Failed) return STATUS_FAILED;
        Run storage r0 = task.runs[0];
        Run storage r1 = task.runs[1];
        if (r0.result != bytes32(0) && r1.result != bytes32(0)) return STATUS_DISPUTED;
        if (r0.result != bytes32(0) || r1.result != bytes32(0)) return STATUS_PARTIAL;
        bool revealOpen = _revealOpen(task);
        for (uint8 s = 0; s < RUNS; s++) {
            Run storage r = task.runs[s];
            if (r.host != address(0) && !_takeable(r, s == 2 || revealOpen)) return STATUS_RUNNING;
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
