// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.0;

/**
 * @notice The primary usage of this interface is for child `BridgePool` contracts to be able to read global state
 * data from their parent `BridgePoolFactory` contract.
 */
interface BridgePoolFactoryInterface {
    // L1 token addresses are mapped to their canonical token address on L2 and the BridgePool contract that houses
    // relay liquidity for any deposits of the canonical L2 token.
    struct L1TokenRelationships {
        address l2Token;
        address bridgePool;
    }

    // Finder used to point to latest OptimisticOracle and other DVM contracts.
    function getFinder() external view returns (address);

    // L2 Deposit contract that originates deposits that can be fulfilled by this contract.
    function getDepositContract() external view returns (address);

    function getWhitelistedToken(address l1Token) external view returns (L1TokenRelationships memory);

    function getOptimisticOracleLiveness() external view returns (uint256);

    function getProposerBondPct() external view returns (uint256);

    function getIdentifier() external view returns (bytes32);
}