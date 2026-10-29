// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IStakeRegistry} from "./interfaces/IStakeRegistry.sol";

/// @title GridMarket — list a machine, rent it with ETH held in escrow, settle by the minute.
/// @notice Nobody operates this contract: hosts list, renters pay the full rental
///         up front, and either side (or anyone, once the paid time is over) can
///         end the rental. The host is paid for every started minute and the
///         renter gets the rest back. All payouts are pulled with withdraw().
contract GridMarket {
    struct Machine {
        address host;
        uint96 pricePerHour; // wei per hour
        bool available; // the host's own switch; rentability also needs no active rental
        uint64 listedAt;
        uint64 activeRental; // rentalId + 1, 0 when idle
        string metadata; // JSON: gpu, vram, cpu, ram, disk, os, endpoint
    }

    struct Rental {
        uint64 machineId;
        address renter;
        uint64 startedAt;
        uint64 paidHours;
        uint96 pricePerHour; // locked at rent time
        uint128 deposit;
        bool ended;
    }

    /// @dev Read-model structs so a front end gets a listing in one call.
    struct MachineView {
        uint64 id;
        Machine machine;
        bool rentable;
        bool hostBonded;
    }

    struct RentalView {
        uint64 id;
        Rental rental;
        Machine machine;
    }

    /// @dev A host can be rented without a GRID bond for this long after their first listing...
    uint64 public constant TRIAL_PERIOD = 30 days;
    /// @dev ...but while unbonded, one rental can hold at most this much ETH: a fresh wallet
    ///      can always start a trial, so the trial caps what a cheat could take, not who may list.
    uint256 public constant TRIAL_MAX_DEPOSIT = 0.01 ether;
    /// @dev Upper bound on a listing's metadata so a page of listings stays cheap to read.
    uint256 public constant MAX_METADATA = 1024;

    IStakeRegistry public immutable stake;

    Machine[] private _machines;
    Rental[] private _rentals;
    mapping(address => uint64[]) private _machinesByHost;
    mapping(address => uint64[]) private _rentalsByRenter;
    mapping(address => uint64) public hostSince; // first listing time, 0 = never listed
    mapping(address => uint64) public activeRentalCount; // running rentals per host; StakeRegistry blocks unbonding while > 0
    mapping(address => uint256) public balances; // ETH owed, pulled with withdraw()

    event MachineListed(uint64 indexed machineId, address indexed host, uint96 pricePerHour, string metadata);
    event MachineUpdated(uint64 indexed machineId, uint96 pricePerHour, bool available, string metadata);
    event Rented(
        uint64 indexed rentalId, uint64 indexed machineId, address indexed renter, uint64 paidHours, uint128 deposit
    );
    event RentalEnded(uint64 indexed rentalId, uint64 indexed machineId, uint128 paidToHost, uint128 refunded);
    event Withdrawn(address indexed account, uint256 amount);

    error NotHost();
    error ZeroPrice();
    error ZeroHours();
    error NotRentable();
    error WrongValue();
    error AlreadyEnded();
    error NotAllowed();
    error NothingToWithdraw();
    error TransferFailed();
    error BadRange();
    error MetadataTooLong();
    error TrialCapExceeded();

    constructor(IStakeRegistry stake_) {
        stake = stake_;
    }

    // ---------------------------------------------------------------- hosts

    function listMachine(uint96 pricePerHour, string calldata metadata) external returns (uint64 id) {
        if (pricePerHour == 0) revert ZeroPrice();
        if (bytes(metadata).length > MAX_METADATA) revert MetadataTooLong();
        id = uint64(_machines.length);
        _machines.push(
            Machine({
                host: msg.sender,
                pricePerHour: pricePerHour,
                available: true,
                listedAt: uint64(block.timestamp),
                activeRental: 0,
                metadata: metadata
            })
        );
        _machinesByHost[msg.sender].push(id);
        if (hostSince[msg.sender] == 0) hostSince[msg.sender] = uint64(block.timestamp);
        emit MachineListed(id, msg.sender, pricePerHour, metadata);
    }

    function updateMachine(uint64 id, uint96 pricePerHour, bool available, string calldata metadata) external {
        Machine storage m = _machines[id];
        if (m.host != msg.sender) revert NotHost();
        if (pricePerHour == 0) revert ZeroPrice();
        if (bytes(metadata).length > MAX_METADATA) revert MetadataTooLong();
        m.pricePerHour = pricePerHour;
        m.available = available;
        m.metadata = metadata;
        emit MachineUpdated(id, pricePerHour, available, metadata);
    }

    // ---------------------------------------------------------------- renters

    /// @notice Rent `machineId` for `hoursWanted` hours, paying exactly quote(machineId, hoursWanted).
    function rent(uint64 machineId, uint64 hoursWanted) external payable returns (uint64 rentalId) {
        if (hoursWanted == 0) revert ZeroHours();
        if (!canRent(machineId)) revert NotRentable();
        Machine storage m = _machines[machineId];
        uint256 price = uint256(m.pricePerHour) * hoursWanted;
        if (msg.value != price || price > type(uint128).max) revert WrongValue();
        if (!stake.isEligible(m.host) && price > TRIAL_MAX_DEPOSIT) revert TrialCapExceeded();

        rentalId = uint64(_rentals.length);
        _rentals.push(
            Rental({
                machineId: machineId,
                renter: msg.sender,
                startedAt: uint64(block.timestamp),
                paidHours: hoursWanted,
                pricePerHour: m.pricePerHour,
                deposit: uint128(price),
                ended: false
            })
        );
        _rentalsByRenter[msg.sender].push(rentalId);
        m.activeRental = rentalId + 1;
        activeRentalCount[m.host] += 1;
        emit Rented(rentalId, machineId, msg.sender, hoursWanted, uint128(price));
    }

    /// @notice End a rental. The renter and the host may end it any time; anyone may
    ///         end it once the paid hours are over. The host is paid per started minute.
    function endRental(uint64 rentalId) external {
        Rental storage r = _rentals[rentalId];
        if (r.ended) revert AlreadyEnded();
        Machine storage m = _machines[r.machineId];

        uint256 maxSeconds = uint256(r.paidHours) * 3600;
        uint256 elapsed = block.timestamp - r.startedAt;
        bool expired = elapsed >= maxSeconds;
        if (msg.sender != r.renter && msg.sender != m.host && !expired) revert NotAllowed();

        if (elapsed > maxSeconds) elapsed = maxSeconds;
        uint256 minutesUsed = (elapsed + 59) / 60;
        if (minutesUsed == 0) minutesUsed = 1;
        uint256 cost = uint256(r.pricePerHour) * minutesUsed / 60;
        if (cost > r.deposit) cost = r.deposit;
        uint256 refund = r.deposit - cost;

        r.ended = true;
        m.activeRental = 0;
        activeRentalCount[m.host] -= 1;
        balances[m.host] += cost;
        if (refund > 0) balances[r.renter] += refund;
        emit RentalEnded(rentalId, r.machineId, uint128(cost), uint128(refund));
    }

    /// @notice Pull everything you are owed (host earnings and renter refunds).
    function withdraw() external {
        uint256 amount = balances[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        balances[msg.sender] = 0;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------- views

    function machineCount() external view returns (uint256) {
        return _machines.length;
    }

    function rentalCount() external view returns (uint256) {
        return _rentals.length;
    }

    function getMachine(uint64 id) external view returns (Machine memory) {
        return _machines[id];
    }

    function getRental(uint64 id) external view returns (Rental memory) {
        return _rentals[id];
    }

    /// @notice Page through every machine ever listed, with live status; ids are offset..offset+n-1.
    function getListings(uint64 offset, uint64 limit) external view returns (MachineView[] memory page) {
        uint256 total = _machines.length;
        if (offset > total) revert BadRange();
        uint256 n = total - offset;
        if (n > limit) n = limit;
        page = new MachineView[](n);
        for (uint256 i = 0; i < n; i++) {
            page[i] = _machineView(uint64(offset + i));
        }
    }

    function machinesOf(address host) external view returns (uint64[] memory) {
        return _machinesByHost[host];
    }

    function rentalsOf(address renter) external view returns (uint64[] memory) {
        return _rentalsByRenter[renter];
    }

    function getMachinesOf(address host) external view returns (MachineView[] memory list) {
        uint64[] storage ids = _machinesByHost[host];
        list = new MachineView[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            list[i] = _machineView(ids[i]);
        }
    }

    function getRentalsOf(address renter) external view returns (RentalView[] memory list) {
        uint64[] storage ids = _rentalsByRenter[renter];
        list = new RentalView[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            Rental storage r = _rentals[ids[i]];
            list[i] = RentalView({id: ids[i], rental: r, machine: _machines[r.machineId]});
        }
    }

    function _machineView(uint64 id) internal view returns (MachineView memory) {
        Machine storage m = _machines[id];
        return MachineView({id: id, machine: m, rentable: canRent(id), hostBonded: stake.isEligible(m.host)});
    }

    /// @notice Whether the host is bonded or still inside their trial period.
    function hostEligible(address host) public view returns (bool) {
        return stake.isEligible(host) || (hostSince[host] != 0 && block.timestamp < hostSince[host] + TRIAL_PERIOD);
    }

    function canRent(uint64 machineId) public view returns (bool) {
        Machine storage m = _machines[machineId];
        return m.available && m.activeRental == 0 && hostEligible(m.host);
    }

    function quote(uint64 machineId, uint64 hoursWanted) external view returns (uint256) {
        return uint256(_machines[machineId].pricePerHour) * hoursWanted;
    }
}
