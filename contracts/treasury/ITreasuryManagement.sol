// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title ITreasuryManagement
 * @notice V2 Treasury Management Module interface for TruthBounty Protocol
 * @dev The single source of truth for all protocol-owned assets.
 *
 * Responsibilities:
 *  - Custody of protocol tokens across multiple reserve pools
 *  - Deterministic accounting: balance == totalDeposits - totalWithdrawals
 *  - Authorised deposits, withdrawals, and internal transfers
 *  - Governance-controlled parameter updates and fund allocation
 *  - Emergency pause/unpause controls
 *  - Immutable event stream for indexers, dashboards, and analytics
 *
 * Security invariants:
 *  - No module may move protocol funds without passing through Treasury
 *  - Every balance-changing operation validates global invariants
 *  - Withdrawal limits prevent single-transaction pool drain
 *  - ReentrancyGuard on all state-mutating external calls
 */
interface ITreasuryManagement {
    // =========================================================================
    // Enums
    // =========================================================================

    /// @notice Reserve pools tracked by the treasury
    enum TreasuryPool {
        STAKING_RESERVE,       // Tokens actively staked by users
        REWARDS_POOL,          // Reserved for reward distribution
        SLASHING_RESERVE,      // Funds slashed from verifiers
        PROTOCOL_FEES,         // Accumulated protocol fees
        GOVERNANCE_RESERVE,    // Governance-controlled reserve
        ECOSYSTEM_FUND,        // Future ecosystem incentives
        EMERGENCY_RESERVE      // Emergency recovery fund
    }

    // =========================================================================
    // Structs
    // =========================================================================

    /// @notice Snapshot of a single reserve pool's state
    struct PoolBalance {
        uint256 currentBalance;
        uint256 totalDeposited;
        uint256 totalWithdrawn;
        uint256 lastUpdatedBlock;
        uint256 lastUpdatedTimestamp;
    }

    /// @notice Complete treasury accounting record for an operation
    struct TreasuryRecord {
        bytes32 recordId;
        address from;
        address to;
        uint256 amount;
        TreasuryPool fromPool;
        TreasuryPool toPool;
        string operationType;
        uint256 timestamp;
        uint256 blockNumber;
    }

    /// @notice Configuration for governance-controlled parameters
    struct TreasuryConfig {
        uint256 maxWithdrawalBPS;        // Max withdrawal per tx as % of pool (basis points)
        uint256 emergencyWithdrawalLimit; // Max emergency withdrawal amount
        uint256 minReserveRatioBPS;      // Min reserve ratio for stability
        uint256 maxAllocationBPS;        // Max allocation change per governance action
        bool withdrawalsEnabled;         // Global withdrawal toggle
        bool depositsEnabled;            // Global deposit toggle
    }

    // =========================================================================
    // Events — Deposits
    // =========================================================================

    event TreasuryDeposit(
        address indexed sender,
        uint256 amount,
        TreasuryPool indexed pool,
        bytes32 indexed recordId
    );

    event StakeDeposit(
        address indexed user,
        uint256 amount,
        bytes32 indexed recordId
    );

    event FeeDeposit(
        address indexed source,
        uint256 amount,
        bytes32 indexed recordId
    );

    event SlashDeposit(
        address indexed verifier,
        uint256 amount,
        bytes32 indexed recordId
    );

    event GovernanceDeposit(
        address indexed source,
        uint256 amount,
        bytes32 indexed recordId
    );

    // =========================================================================
    // Events — Withdrawals
    // =========================================================================

    event TreasuryWithdrawal(
        address indexed recipient,
        uint256 amount,
        TreasuryPool indexed pool,
        bytes32 indexed recordId
    );

    event RewardWithdrawal(
        address indexed recipient,
        uint256 amount,
        bytes32 indexed recordId
    );

    event SettlementWithdrawal(
        address indexed recipient,
        uint256 amount,
        bytes32 indexed recordId
    );

    event GovernanceWithdrawal(
        address indexed recipient,
        uint256 amount,
        bytes32 indexed recordId
    );

    event EmergencyWithdrawal(
        address indexed recipient,
        uint256 amount,
        bytes32 indexed recordId
    );

    // =========================================================================
    // Events — Internal Transfers
    // =========================================================================

    event TreasuryTransfer(
        TreasuryPool indexed fromPool,
        TreasuryPool indexed toPool,
        uint256 amount,
        bytes32 indexed recordId
    );

    // =========================================================================
    // Events — Configuration
    // =========================================================================

    event TreasuryConfigUpdated(
        string configName,
        uint256 oldValue,
        uint256 newValue
    );

    event TreasuryPoolAdded(TreasuryPool indexed pool, address indexed token);
    event TreasuryPoolRemoved(TreasuryPool indexed pool);

    event AuthorisedModuleUpdated(
        address indexed module,
        bool indexed authorised
    );

    event SnapshotCreated(
        uint256 indexed snapshotId,
        uint256 totalAssets,
        address indexed creator
    );

    event EmergencyPaused(address indexed actor, string reason);
    event EmergencyUnpaused(address indexed actor);

    // =========================================================================
    // Errors
    // =========================================================================

    error ZeroAmount();
    error InsufficientPoolBalance(TreasuryPool pool, uint256 requested, uint256 available);
    error WithdrawalExceedsLimit(uint256 requested, uint256 maxAllowed);
    error PoolNotActive(TreasuryPool pool);
    error UnauthorisedModule(address caller);
    error UnauthorisedWithdrawal(address caller, TreasuryPool pool);
    error InvariantViolation(string reason, uint256 expected, uint256 actual);
    error InvalidBasisPoints(uint256 bps);
    error SameBlockOperation(TreasuryPool pool);
    error DuplicateRecord(bytes32 recordId);
    error WithdrawalsPaused();
    error DepositsPaused();
    error InvalidRecordIndex(uint256 index, uint256 length);
    error MaxAllocationChangeExceeded(uint256 requested, uint256 maxAllowed);

    // =========================================================================
    // Deposit Functions
    // =========================================================================

    /// @notice Deposit tokens into a specific treasury pool from external source
    /// @param pool The target reserve pool
    /// @param amount Amount of tokens to deposit
    function depositToPool(TreasuryPool pool, uint256 amount) external;

    /// @notice Record a staking deposit (called by staking module)
    /// @param user The staker address
    /// @param amount Amount staked
    function recordStakeDeposit(address user, uint256 amount) external;

    /// @notice Record a protocol fee deposit (called by FeeManager)
    /// @param source Fee source address
    /// @param amount Fee amount
    function recordFeeDeposit(address source, uint256 amount) external;

    /// @notice Record a slashing deposit (called by Slashing module)
    /// @param verifier Slashed verifier address
    /// @param amount Slash amount
    function recordSlashDeposit(address verifier, uint256 amount) external;

    /// @notice Record a governance-controlled deposit
    /// @param source Source address
    /// @param amount Amount deposited
    function recordGovernanceDeposit(address source, uint256 amount) external;

    // =========================================================================
    // Withdrawal Functions
    // =========================================================================

    /// @notice Withdraw from a pool to an external recipient (authorised modules)
    /// @param pool Source pool
    /// @param recipient Recipient address
    /// @param amount Amount to withdraw
    function withdrawFromPool(
        TreasuryPool pool,
        address recipient,
        uint256 amount
    ) external;

    /// @notice Record reward distribution withdrawal (called by RewardEngine)
    /// @param recipient Reward recipient
    /// @param amount Reward amount
    function recordRewardWithdrawal(address recipient, uint256 amount) external;

    /// @notice Record settlement withdrawal (called by Settlement module)
    /// @param recipient Settlement recipient
    /// @param amount Settlement amount
    function recordSettlementWithdrawal(address recipient, uint256 amount) external;

    /// @notice Emergency withdrawal (governance-controlled, strictly permissioned)
    /// @param recipient Emergency recipient
    /// @param amount Emergency amount
    function emergencyWithdrawal(address recipient, uint256 amount) external;

    // =========================================================================
    // Internal Transfer Functions
    // =========================================================================

    /// @notice Transfer funds between treasury pools (authorised modules only)
    /// @param fromPool Source pool
    /// @param toPool Destination pool
    /// @param amount Amount to transfer
    /// @param reason Description of the transfer
    function transferBetweenPools(
        TreasuryPool fromPool,
        TreasuryPool toPool,
        uint256 amount,
        string calldata reason
    ) external;

    // =========================================================================
    // View Functions
    // =========================================================================

    /// @notice Get balance details for a specific pool
    function getPoolBalance(TreasuryPool pool) external view returns (PoolBalance memory);

    /// @notice Get all pool balances
    function getAllPoolBalances() external view returns (PoolBalance[7] memory);

    /// @notice Get total assets across all pools
    function getTotalAssets() external view returns (uint256);

    /// @notice Get a treasury record by index
    function getRecord(uint256 index) external view returns (TreasuryRecord memory);

    /// @notice Get paginated treasury records
    function getRecords(uint256 offset, uint256 limit) external view returns (TreasuryRecord[] memory);

    /// @notice Get total number of treasury records
    function getRecordCount() external view returns (uint256);

    /// @notice Get the current treasury configuration
    function getConfig() external view returns (TreasuryConfig memory);

    /// @notice Check if an address is an authorised module
    function isAuthorisedModule(address module) external view returns (bool);

    /// @notice Create and store a snapshot of all pool balances
    function createSnapshot() external returns (uint256 snapshotId);

    /// @notice Get snapshot data
    function getSnapshot(uint256 snapshotId) external view returns (PoolBalance[7] memory, uint256 totalAssets, uint256 timestamp);
}
