// // SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/IClaimRegistry.sol";
import "./interfaces/IParameterVersionRegistry.sol";

/**
 * @title ClaimRegistry
 * @notice Legacy sequential registry plus the V2 deterministic claim creation flow.
 * @dev This contract preserves the existing API used by the repo while also
 *      supporting the canonical user-owned creation flow required by V2.
 */
contract ClaimRegistry is AccessControl, IClaimRegistry, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant REGISTRY_UPDATER_ROLE = keccak256("REGISTRY_UPDATER_ROLE");

    /// @notice ParameterVersionRegistry instance that tracks versioned economic parameters
    IParameterVersionRegistry public parameterVersionRegistry;

    // =========================================================================
    // Constants — Input Validation
    // =========================================================================

    /// @notice Minimum byte length for a valid claim statement.
    uint256 public constant STATEMENT_MIN_LENGTH = 10;
    uint256 public constant STATEMENT_MAX_LENGTH = 2000;
    uint256 public constant CID_MIN_LENGTH = 46;
    uint256 public constant CID_MAX_LENGTH = 128;
    uint64 public constant MAX_DEADLINE_HORIZON = 365 days;

    uint256 private _nextClaimId;
    mapping(uint256 => Claim) private _claims;

    uint256 private _configVersion;
    mapping(address => bool) private _supportedAssets;
    mapping(address => uint256) private _assetMinBounty;
    mapping(address => uint256) private _assetMaxBounty;
    mapping(address => uint256) private _submitterNonce;
    mapping(bytes32 => CanonicalClaim) private _canonicalClaims;
    mapping(bytes32 => bool) private _canonicalClaimExists;

    /**
     * @param initialAdmin Address that receives DEFAULT_ADMIN_ROLE and ADMIN_ROLE.
     *                     Must be non-zero.
     * @param parameterVersionRegistry_ Address of the deployed ParameterVersionRegistry
     * @dev Sets _nextClaimId = 1 so the first created claim has ID = 1.
     */
    constructor(address initialAdmin, address parameterVersionRegistry_) {
        require(initialAdmin != address(0), "ClaimRegistry: zero admin address");
        require(parameterVersionRegistry_ != address(0), "ClaimRegistry: zero registry address");

        _nextClaimId = 1;
        _configVersion = 1;
        parameterVersionRegistry = IParameterVersionRegistry(parameterVersionRegistry_);

        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(ADMIN_ROLE, initialAdmin);
        _setRoleAdmin(REGISTRY_UPDATER_ROLE, ADMIN_ROLE);
    }

    function createClaim(
        string calldata statement,
        string calldata evidenceCID,
        uint64 verificationDeadline
    ) external override returns (uint256 claimId) {
        uint256 statLen = bytes(statement).length;
        if (statLen < STATEMENT_MIN_LENGTH || statLen > STATEMENT_MAX_LENGTH) {
            revert InvalidStatement();
        }

        uint256 cidLen = bytes(evidenceCID).length;
        if (cidLen < CID_MIN_LENGTH || cidLen > CID_MAX_LENGTH) {
            revert InvalidCID();
        }

        uint64 now_ = uint64(block.timestamp);
        if (verificationDeadline <= now_ || verificationDeadline > now_ + MAX_DEADLINE_HORIZON) {
            revert InvalidDeadline();
        }

        claimId = _nextClaimId;
        unchecked {
            _nextClaimId = claimId + 1;
        }

        Claim storage c = _claims[claimId];
        c.id = claimId;
        c.creator = msg.sender;
        c.statement = statement;
        c.evidenceCID = evidenceCID;
        c.createdAt = now_;
        c.verificationDeadline = verificationDeadline;

        emit ClaimCreated(claimId, msg.sender, evidenceCID);
    }

    /**
     * @notice Update the ParameterVersionRegistry address (only callable by admin)
     * @param newRegistry The new ParameterVersionRegistry address
     */
    function setParameterVersionRegistry(address newRegistry) external onlyRole(ADMIN_ROLE) {
        if (newRegistry == address(0)) revert("ClaimRegistry: zero address");
        parameterVersionRegistry = IParameterVersionRegistry(newRegistry);
    }

    /**
     * @inheritdoc IClaimRegistry
     *
     * @dev Only accounts holding REGISTRY_UPDATER_ROLE may call this function.
     *      This role is intended for authorised downstream protocol modules only.
     *
     * @custom:emits ClaimStatusUpdated(claimId, oldStatus, newStatus)
     */
    function updateClaimStatus(
        uint256 claimId,
        ClaimStatus newStatus
    ) external override onlyRole(REGISTRY_UPDATER_ROLE) {
        if (_claims[claimId].createdAt == 0) {
            revert ClaimNotFound(claimId);
        }

        ClaimStatus current = _claims[claimId].status;
        if (current == newStatus) {
            revert InvalidStatusTransition(current, newStatus);
        }

        _claims[claimId].status = newStatus;
        emit ClaimStatusUpdated(claimId, current, newStatus);
    }

    function createCanonicalClaim(
        address recipient,
        address asset,
        uint256 bounty,
        bytes32 metadataDigest,
        bytes32 evidenceDigest,
        uint256 nonce
    ) external override nonReentrant returns (bytes32 claimId) {
        return _createCanonicalClaim(recipient, asset, bounty, metadataDigest, evidenceDigest, nonce, _configVersion);
    }

    function createCanonicalClaim(
        address recipient,
        address asset,
        uint256 bounty,
        bytes32 metadataDigest,
        bytes32 evidenceDigest,
        uint256 nonce,
        uint256 parameterVersion
    ) external override nonReentrant returns (bytes32 claimId) {
        return _createCanonicalClaim(recipient, asset, bounty, metadataDigest, evidenceDigest, nonce, parameterVersion);
    }

    function currentConfigVersion() external view override returns (uint256 version) {
        return _configVersion;
    }

    function setSupportedAsset(
        address asset,
        bool supported,
        uint256 minBounty,
        uint256 maxBounty
    ) external override onlyRole(ADMIN_ROLE) {
        if (asset == address(0)) revert ZeroAddress();

        if (supported) {
            if (minBounty == 0 || minBounty > maxBounty) revert InvalidBounty(minBounty);
            _supportedAssets[asset] = true;
            _assetMinBounty[asset] = minBounty;
            _assetMaxBounty[asset] = maxBounty;
        } else {
            _supportedAssets[asset] = false;
            _assetMinBounty[asset] = 0;
            _assetMaxBounty[asset] = 0;
        }
    }

    function isSupportedAsset(address asset) external view override returns (bool supported) {
        return _supportedAssets[asset];
    }

    function getAssetBounds(address asset) external view override returns (uint256 minBounty, uint256 maxBounty) {
        return (_assetMinBounty[asset], _assetMaxBounty[asset]);
    }

    function computeClaimId(address submitter, uint256 submitterNonce, bytes32 metadataDigest)
        public
        view
        override
        returns (bytes32 claimId)
    {
        if (submitter == address(0)) revert ZeroAddress();
        if (metadataDigest == 0) revert ZeroDigest();

        return keccak256(abi.encode(block.chainid, address(this), submitter, submitterNonce, metadataDigest));
    }

    function claimIdFor(address submitter, uint256 submitterNonce, bytes32 metadataDigest)
        external
        view
        override
        returns (bytes32 claimId)
    {
        return computeClaimId(submitter, submitterNonce, metadataDigest);
    }

    function getCanonicalClaim(bytes32 claimId) external view override returns (CanonicalClaim memory claim) {
        if (!_canonicalClaimExists[claimId]) revert CanonicalClaimNotFound(claimId);
        return _canonicalClaims[claimId];
    }

    function claimExists(bytes32 claimId) external view override returns (bool exists) {
        return _canonicalClaimExists[claimId];
    }

    function getClaim(uint256 claimId) external view override returns (Claim memory claim) {
        if (_claims[claimId].createdAt == 0) {
            revert ClaimNotFound(claimId);
        }
        return _claims[claimId];
    }

    function claimExists(uint256 claimId) external view override returns (bool exists) {
        return _claims[claimId].createdAt != 0;
    }

    function totalClaims() external view override returns (uint256 total) {
        unchecked {
            return _nextClaimId - 1;
        }
    }

    function getClaimCreator(uint256 claimId) external view override returns (address creator) {
        if (_claims[claimId].createdAt == 0) {
            revert ClaimNotFound(claimId);
        }
        return _claims[claimId].creator;
    }

    function getClaimStatus(uint256 claimId) external view override returns (ClaimStatus status) {
        if (_claims[claimId].createdAt == 0) {
            revert ClaimNotFound(claimId);
        }
        return _claims[claimId].status;
    }

    function _createCanonicalClaim(
        address recipient,
        address asset,
        uint256 bounty,
        bytes32 metadataDigest,
        bytes32 evidenceDigest,
        uint256 nonce,
        uint256 parameterVersion
    ) internal returns (bytes32 claimId) {
        if (msg.sender == address(0)) revert ZeroAddress();
        if (recipient == address(0)) revert ZeroRecipient();
        if (asset == address(0)) revert UnsupportedAsset(asset);
        if (!_supportedAssets[asset]) revert UnsupportedAsset(asset);
        if (metadataDigest == 0 || evidenceDigest == 0) revert ZeroDigest();
        if (parameterVersion == 0 || parameterVersion != _configVersion) {
            revert InvalidParameterVersion(_configVersion, parameterVersion);
        }

        uint256 minBounty = _assetMinBounty[asset];
        uint256 maxBounty = _assetMaxBounty[asset];
        if (bounty == 0 || bounty < minBounty || bounty > maxBounty) revert InvalidBounty(bounty);

        uint256 expectedNonce = _submitterNonce[msg.sender];
        if (nonce != expectedNonce) revert InvalidNonce(expectedNonce, nonce);

        claimId = computeClaimId(msg.sender, nonce, metadataDigest);
        if (_canonicalClaimExists[claimId]) revert DuplicateClaimId(claimId);

        IERC20(asset).safeTransferFrom(msg.sender, address(this), bounty);

        _submitterNonce[msg.sender] = nonce + 1;

        bytes32 custodyRef = keccak256(abi.encode(asset, recipient, bounty, claimId, block.timestamp));
        CanonicalClaim storage claim = _canonicalClaims[claimId];
        claim.id = claimId;
        claim.submitter = msg.sender;
        claim.recipient = recipient;
        claim.asset = asset;
        claim.bounty = bounty;
        claim.metadataDigest = metadataDigest;
        claim.evidenceDigest = evidenceDigest;
        claim.nonce = nonce;
        claim.parameterVersion = parameterVersion;
        claim.createdAt = uint64(block.timestamp);
        claim.custodyRef = custodyRef;
        claim.exists = true;
        _canonicalClaimExists[claimId] = true;

        emit ClaimCreated(
            claimId,
            msg.sender,
            recipient,
            asset,
            bounty,
            metadataDigest,
            evidenceDigest,
            nonce,
            parameterVersion,
            custodyRef
        );
    }
}
