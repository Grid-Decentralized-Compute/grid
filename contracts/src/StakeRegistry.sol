// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IGridMarket} from "./interfaces/IGridMarket.sol";
import {IStakeRegistry} from "./interfaces/IStakeRegistry.sol";

/// @title StakeRegistry — hosts bond GRID to stay rentable on Grid.
/// @notice The bond is the only thing GRID does in the protocol: it cannot start
///         unbonding while any of the host's rentals is running, takes UNBOND_DELAY
///         to get back, and a share of it is burned if the host is proven to have
///         defrauded a renter. Payments for compute are always ETH and never touch
///         this contract.
contract StakeRegistry is IStakeRegistry {
    IERC20 public immutable grid;

    /// @dev Proposes minBond and slasher changes and sets the market once. Meant to be a multisig.
    address public owner;
    /// @dev Becomes owner by calling acceptOwnership().
    address public pendingOwner;
    /// @dev May burn bonds. Meant to be the 3-of-5 Slasher multisig.
    address public slasher;
    /// @dev The GridMarket whose running rentals keep a bond locked. address(0) = no such check.
    address public market;
    /// @dev GRID (in wei) a host needs bonded to be eligible. 0 switches bonding off.
    uint256 public minBond;

    /// @dev A proposed slasher or minBond and the time it can be applied from (0 = none pending).
    address public pendingSlasher;
    uint64 public pendingSlasherAt;
    uint256 public pendingMinBond;
    uint64 public pendingMinBondAt;

    uint64 public constant UNBOND_DELAY = 7 days;
    /// @dev How long a slasher or minBond change waits after it is proposed: the unbonding delay
    ///      plus two days to react, so a host who starts unbonding when a change is announced has
    ///      its GRID back before the change can take effect (a slash also reaches pending unbonds).
    uint64 public constant CHANGE_DELAY = UNBOND_DELAY + 2 days;
    /// @dev The most a single slash may burn: half of the bond and of any pending unbond.
    uint256 public constant MAX_SLASH_BPS = 5_000;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    struct Unbond {
        uint256 amount;
        uint64 claimableAt;
    }

    mapping(address => uint256) public bonded;
    mapping(address => Unbond) public unbonds;

    event Bonded(address indexed host, address indexed from, uint256 amount, uint256 total);
    event UnbondStarted(address indexed host, uint256 amount, uint64 claimableAt);
    event Withdrawn(address indexed host, uint256 amount);
    event Slashed(address indexed host, uint256 amount, string reason);
    event MinBondProposed(uint256 minBond, uint64 readyAt);
    event MinBondSet(uint256 minBond);
    event SlasherProposed(address slasher, uint64 readyAt);
    event SlasherSet(address slasher);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event MarketSet(address market);

    error NotOwner();
    error NotSlasher();
    error ZeroAmount();
    error InsufficientBond();
    error NothingClaimable();
    error BpsTooHigh();
    error TransferFailed();
    error RentalsActive();
    error NotPendingOwner();
    error MarketAlreadySet();
    error ZeroAddress();
    error NothingProposed();
    error TooEarly();
    error AmountMismatch();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IERC20 grid_, uint256 minBond_) {
        grid = grid_;
        owner = msg.sender;
        slasher = msg.sender;
        minBond = minBond_;
    }

    // ---------------------------------------------------------------- views

    function isEligible(address host) external view returns (bool) {
        return bonded[host] >= minBond;
    }

    // ---------------------------------------------------------------- hosts

    /// @notice Lock `amount` GRID as your own bond.
    function bond(uint256 amount) external {
        _bond(msg.sender, amount);
    }

    /// @notice Lock `amount` GRID as `host`'s bond (stake-backing a host you trust).
    ///         The bond belongs to the host afterwards.
    function bondFor(address host, uint256 amount) external {
        _bond(host, amount);
    }

    /// @notice Start getting `amount` of your bond back. Not while one of your rentals is
    ///         running, so the bond still backs every rental it was shown for. Claimable
    ///         after UNBOND_DELAY; adding to a pending unbond restarts the clock for the
    ///         whole amount.
    function startUnbond(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (bonded[msg.sender] < amount) revert InsufficientBond();
        if (market != address(0) && IGridMarket(market).activeRentalCount(msg.sender) != 0) revert RentalsActive();
        bonded[msg.sender] -= amount;
        Unbond storage u = unbonds[msg.sender];
        u.amount += amount;
        u.claimableAt = uint64(block.timestamp) + UNBOND_DELAY;
        emit UnbondStarted(msg.sender, amount, u.claimableAt);
    }

    /// @notice Withdraw an unbond whose delay has passed.
    function withdraw() external {
        Unbond memory u = unbonds[msg.sender];
        if (u.amount == 0 || block.timestamp < u.claimableAt) revert NothingClaimable();
        delete unbonds[msg.sender];
        if (!grid.transfer(msg.sender, u.amount)) revert TransferFailed();
        emit Withdrawn(msg.sender, u.amount);
    }

    // ---------------------------------------------------------------- slashing

    /// @notice Burn `bps` basis points (1000 = 10%, at most MAX_SLASH_BPS) of a host's bond,
    ///         including any pending unbond, so starting an unbond does not dodge a slash.
    function slash(address host, uint256 bps, string calldata reason) external {
        if (msg.sender != slasher) revert NotSlasher();
        if (bps > MAX_SLASH_BPS) revert BpsTooHigh();
        uint256 fromBond = bonded[host] * bps / 10_000;
        uint256 fromUnbond = unbonds[host].amount * bps / 10_000;
        bonded[host] -= fromBond;
        unbonds[host].amount -= fromUnbond;
        uint256 amount = fromBond + fromUnbond;
        if (amount > 0 && !grid.transfer(BURN, amount)) revert TransferFailed();
        emit Slashed(host, amount, reason);
    }

    // ---------------------------------------------------------------- admin

    /// @notice Propose a new minimum bond, applicable CHANGE_DELAY from now so hosts can top up
    ///         or leave first. A new proposal replaces the pending one and restarts the clock;
    ///         proposing the current value cancels a change.
    function proposeMinBond(uint256 minBond_) external onlyOwner {
        uint64 readyAt = uint64(block.timestamp) + CHANGE_DELAY;
        pendingMinBond = minBond_;
        pendingMinBondAt = readyAt;
        emit MinBondProposed(minBond_, readyAt);
    }

    function applyMinBond() external onlyOwner {
        uint64 readyAt = pendingMinBondAt;
        if (readyAt == 0) revert NothingProposed();
        if (block.timestamp < readyAt) revert TooEarly();
        minBond = pendingMinBond;
        delete pendingMinBond;
        delete pendingMinBondAt;
        emit MinBondSet(minBond);
    }

    /// @notice Propose a new slasher, applicable CHANGE_DELAY from now so a host who does not
    ///         trust it can unbond and withdraw before it can slash. A new proposal replaces the
    ///         pending one and restarts the clock; proposing the current slasher cancels a change.
    function proposeSlasher(address slasher_) external onlyOwner {
        uint64 readyAt = uint64(block.timestamp) + CHANGE_DELAY;
        pendingSlasher = slasher_;
        pendingSlasherAt = readyAt;
        emit SlasherProposed(slasher_, readyAt);
    }

    function applySlasher() external onlyOwner {
        uint64 readyAt = pendingSlasherAt;
        if (readyAt == 0) revert NothingProposed();
        if (block.timestamp < readyAt) revert TooEarly();
        slasher = pendingSlasher;
        delete pendingSlasher;
        delete pendingSlasherAt;
        emit SlasherSet(slasher);
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

    /// @notice Points the registry at the GridMarket whose rentals lock bonds. Set once after
    ///         deployment (the market takes this registry in its constructor) and never again.
    function setMarket(address market_) external onlyOwner {
        if (market != address(0)) revert MarketAlreadySet();
        if (market_ == address(0)) revert ZeroAddress();
        market = market_;
        emit MarketSet(market_);
    }

    // ---------------------------------------------------------------- internal

    /// @dev Credits only what arrived in full: a token that takes a fee on transfer would
    ///      otherwise leave the registry owing more GRID than it holds.
    function _bond(address host, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        uint256 before = grid.balanceOf(address(this));
        if (!grid.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        if (grid.balanceOf(address(this)) - before != amount) revert AmountMismatch();
        bonded[host] += amount;
        emit Bonded(host, msg.sender, amount, bonded[host]);
    }
}
