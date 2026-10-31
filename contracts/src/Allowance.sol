// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Allowance — a spending wallet a person or company funds for an agent.
/// @notice The owner funds this contract and gives the agent its own key, nothing more. With
///         that key the agent can only call the contracts the owner allowed (GridMarket,
///         SwarmMarket) through execute(), and the ETH it sends with those calls adds up to at
///         most dailyCap per UTC day. Calls that send no ETH (withdraw(), cancelJob(),
///         closeJob(), endRental()) are not limited. The markets credit refunds and payouts to
///         msg.sender, which is this contract, and their withdraw() pays it back here, so the ETH
///         that comes back from an ended rental or a closed job lands in this wallet too. A
///         stolen agent key can spend what is left of today's cap on the allowed contracts and
///         cannot drain refunds either. Only the owner takes ETH out, with withdraw().
contract Allowance {
    /// @dev Names the agent, sets the cap and the targets and withdraws. Changes in two steps.
    address public owner;
    /// @dev Becomes owner by calling acceptOwnership().
    address public pendingOwner;
    /// @dev The only caller of execute(). address(0) = switched off.
    address public agent;
    /// @dev Wei the agent may send with its calls per UTC day.
    uint256 public dailyCap;
    /// @dev The UTC midnight that opened the day spentToday counts.
    uint64 public dayStart;
    /// @dev Wei sent with execute() since dayStart. Stale once a new day has started:
    ///      remainingToday() accounts for that, and the next call with value resets it.
    uint256 public spentToday;
    /// @dev Contracts execute() may call.
    mapping(address => bool) public allowedTarget;

    event Funded(address indexed from, uint256 amount);
    event Executed(address indexed target, uint256 value, bytes data);
    event AgentSet(address agent);
    event DailyCapSet(uint256 dailyCap);
    event TargetSet(address indexed target, bool allowed);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotAgent();
    error NotPendingOwner();
    error TargetNotAllowed();
    error CapExceeded();
    error InsufficientBalance();
    error TransferFailed();
    error ZeroAddress();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Payable so whoever deploys it (AllowanceFactory) can fund it in the same transaction.
    constructor(address owner_, address agent_, uint256 dailyCap_, address[] memory targets) payable {
        if (owner_ == address(0) || agent_ == address(0)) revert ZeroAddress();
        owner = owner_;
        _setAgent(agent_);
        _setDailyCap(dailyCap_);
        for (uint256 i = 0; i < targets.length; i++) {
            _setTarget(targets[i], true);
        }
        if (msg.value != 0) emit Funded(msg.sender, msg.value);
    }

    /// @notice Funding from anyone, and the refunds and payouts the markets send back.
    receive() external payable {
        emit Funded(msg.sender, msg.value);
    }

    // ---------------------------------------------------------------- views

    /// @notice Wei the agent can still send today. A new UTC day starts again from the full cap.
    function remainingToday() external view returns (uint256) {
        uint256 spent = _today() == dayStart ? spentToday : 0;
        return spent >= dailyCap ? 0 : dailyCap - spent;
    }

    // ---------------------------------------------------------------- agent

    /// @notice Call an allowed `target` with `value` wei and `data`, and return what it returned.
    ///         A revert is passed on with its own data. `value` counts against today's cap.
    function execute(address target, uint256 value, bytes calldata data) external returns (bytes memory) {
        if (msg.sender != agent) revert NotAgent();
        if (!allowedTarget[target]) revert TargetNotAllowed();
        if (value != 0) {
            uint64 today = _today();
            if (today != dayStart) {
                dayStart = today;
                spentToday = 0;
            }
            uint256 spent = spentToday;
            if (spent > dailyCap || value > dailyCap - spent) revert CapExceeded();
            if (value > address(this).balance) revert InsufficientBalance();
            // Counted before the call, so nothing the target does can spend the same wei twice.
            spentToday = spent + value;
        }
        (bool ok, bytes memory result) = target.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        emit Executed(target, value, data);
        return result;
    }

    // ---------------------------------------------------------------- owner

    /// @notice Hand the agent role to `agent_`; the old key stops working at once. address(0)
    ///         switches the agent off. The owner may name itself to pull market balances in.
    function setAgent(address agent_) external onlyOwner {
        _setAgent(agent_);
    }

    /// @notice Change the daily cap. It applies to today straight away: a cap below what was
    ///         already spent today stops calls with value until the next UTC day.
    function setDailyCap(uint256 dailyCap_) external onlyOwner {
        _setDailyCap(dailyCap_);
    }

    function setTarget(address target, bool allowed) external onlyOwner {
        _setTarget(target, allowed);
    }

    /// @notice Send `amount` wei to the owner. A market balance credited to this wallet has to
    ///         be pulled in first, with the market's withdraw() through execute().
    function withdraw(uint256 amount) external onlyOwner {
        if (amount > address(this).balance) revert InsufficientBalance();
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Start handing ownership to `newOwner`, who takes it with acceptOwnership().
    ///         address(0) cancels a pending transfer.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        delete pendingOwner;
    }

    // ---------------------------------------------------------------- internal

    function _setAgent(address agent_) internal {
        agent = agent_;
        emit AgentSet(agent_);
    }

    function _setDailyCap(uint256 dailyCap_) internal {
        dailyCap = dailyCap_;
        emit DailyCapSet(dailyCap_);
    }

    function _setTarget(address target, bool allowed) internal {
        if (target == address(0)) revert ZeroAddress();
        allowedTarget[target] = allowed;
        emit TargetSet(target, allowed);
    }

    /// @dev The UTC midnight at or before now.
    function _today() internal view returns (uint64) {
        return uint64(block.timestamp - block.timestamp % 1 days);
    }
}
