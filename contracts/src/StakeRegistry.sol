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

    /// @dev Sets minBond, the slasher and the market. Meant to be a multisig.
    address public owner;
    /// @dev May burn bonds. Meant to be the 3-of-5 Slasher multisig.
    address public slasher;
    /// @dev The GridMarket whose running rentals keep a bond locked. address(0) = no such check.
    address public market;
    /// @dev GRID (in wei) a host needs bonded to be eligible. 0 switches bonding off.
    uint256 public minBond;

    uint64 public constant UNBOND_DELAY = 7 days;
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
    event MinBondSet(uint256 minBond);
    event SlasherSet(address slasher);
    event OwnerSet(address owner);
    event MarketSet(address market);

    error NotOwner();
    error NotSlasher();
    error ZeroAmount();
    error InsufficientBond();
    error NothingClaimable();
    error BpsTooHigh();
    error TransferFailed();
    error RentalsActive();

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

    /// @notice Burn `bps` basis points (1000 = 10%) of a host's bond, including any
    ///         pending unbond, so starting an unbond does not dodge a slash.
    function slash(address host, uint256 bps, string calldata reason) external {
        if (msg.sender != slasher) revert NotSlasher();
        if (bps > 10_000) revert BpsTooHigh();
        uint256 fromBond = bonded[host] * bps / 10_000;
        uint256 fromUnbond = unbonds[host].amount * bps / 10_000;
        bonded[host] -= fromBond;
        unbonds[host].amount -= fromUnbond;
        uint256 amount = fromBond + fromUnbond;
        if (amount > 0 && !grid.transfer(BURN, amount)) revert TransferFailed();
        emit Slashed(host, amount, reason);
    }

    // ---------------------------------------------------------------- admin

    function setMinBond(uint256 minBond_) external onlyOwner {
        minBond = minBond_;
        emit MinBondSet(minBond_);
    }

    function setSlasher(address slasher_) external onlyOwner {
        slasher = slasher_;
        emit SlasherSet(slasher_);
    }

    function setOwner(address owner_) external onlyOwner {
        owner = owner_;
        emit OwnerSet(owner_);
    }

    /// @notice Points the registry at the GridMarket whose rentals lock bonds (set once after deployment,
    ///         since the market takes this registry in its constructor).
    function setMarket(address market_) external onlyOwner {
        market = market_;
        emit MarketSet(market_);
    }

    // ---------------------------------------------------------------- internal

    function _bond(address host, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        if (!grid.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        bonded[host] += amount;
        emit Bonded(host, msg.sender, amount, bonded[host]);
    }
}
