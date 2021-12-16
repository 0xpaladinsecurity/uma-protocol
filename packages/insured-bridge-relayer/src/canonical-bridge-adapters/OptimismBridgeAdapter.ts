import winston from "winston";
import { ZERO_ADDRESS } from "@uma/common";

import { providers } from "ethers";

import { getMessagesAndProofsForL2Transaction } from "@eth-optimism/message-relayer";
import { predeploys, getContractDefinition } from "@eth-optimism/contracts";
import { getDeployedContractArtifact } from "@eth-optimism/contracts/dist/contract-deployed-artifacts";

import BridgeAdapterInterface from "./BridgeAdapterInterface";

import Web3 from "web3";
import { Contract } from "web3-eth-contract";

import type { TransactionType } from "@uma/common";

export class OptimismBridgeAdapter implements BridgeAdapterInterface {
  private l1EthersProvider: providers.JsonRpcProvider;
  private l2EthersProvider: providers.JsonRpcProvider;
  private l1StateCommitmentChainAddress: string;
  private l2CrossDomainMessengerAddress: string;
  private l1CrossDomainMessenger: Contract;

  constructor(readonly logger: winston.Logger, readonly l1Web3: Web3, readonly l2Web3: Web3) {
    // Set providers for L1 and L2. Optimism package requires ethers providers.
    this.l1EthersProvider = new providers.Web3Provider(this.l1Web3.currentProvider as any);
    this.l2EthersProvider = new providers.Web3Provider(this.l2Web3.currentProvider as any);

    // Fetch contract data.
    this.l1StateCommitmentChainAddress = getDeployedContractArtifact("StateCommitmentChain", "mainnet").address;
    this.l2CrossDomainMessengerAddress = predeploys.L2CrossDomainMessenger;
    this.l1CrossDomainMessenger = new this.l1Web3.eth.Contract(
      getContractDefinition("IL1CrossDomainMessenger").abi,
      getDeployedContractArtifact("Proxy__OVM_L1CrossDomainMessenger", "mainnet").address
    );
  }

  async initialize() {
    return;
  }

  async constructCrossDomainFinalizationTransaction(
    l2TransactionHash: string
  ): Promise<{ l2TransactionHash: string; finalizationTransaction: TransactionType | null }> {
    // Fetch Message proofs.
    const messagePairs = await getMessagesAndProofsForL2Transaction(
      this.l1EthersProvider,
      this.l2EthersProvider,
      this.l1StateCommitmentChainAddress,
      this.l2CrossDomainMessengerAddress,
      l2TransactionHash
    );

    // Note that in principle, a single transaction could trigger any number of outgoing messages; However, the bridge
    // deposit box used in across is designed to only send one at a time.
    if (messagePairs.length !== 1) {
      const error = new Error(`No (or wrong number) of outgoing messages found in transaction:${l2TransactionHash}`);
      this.logger.error({
        at: "OptimismBridgeAdapter",
        message: "Bad Optimism L2 Transaction included 🤢!",
        l2TransactionHash,
        error,
      });
      throw error;
    }

    const { message, proof } = messagePairs[0];

    // Optimism's package does not provide any way to see if a message is in the finalized state (not yet sent and
    // passed the 1 week liveness). To see if a transaction is relayable we can simply see if calling the
    // `relayMessage` function would revert. If it does, then it's not ready. Else, if it does not revert then
    // return the transaction object to be sent in the CrossDomainFinalizer.
    const finalizationTransaction = this.l1CrossDomainMessenger.methods.relayMessage(
      message.target,
      message.sender,
      message.message,
      message.messageNonce,
      proof
    );

    try {
      await finalizationTransaction.call({ from: ZERO_ADDRESS });

      this.logger.debug({
        at: "OptimismBridgeAdapter",
        message: `Constructing cross domain finalization transaction for ${l2TransactionHash}`,
      });
      return { l2TransactionHash, finalizationTransaction };
    } catch (error) {
      this.logger.debug({ at: "OptimismBridgeAdapter", message: `${l2TransactionHash} is not confirmed` });
      return { l2TransactionHash, finalizationTransaction: null };
    }
  }
}
