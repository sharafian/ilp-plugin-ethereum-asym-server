import {
  AssetUnit,
  convert,
  eth,
  gwei,
  wei
} from '@kava-labs/crypto-rate-utils'
import BigNumber from 'bignumber.js'
import {
  MIME_APPLICATION_JSON,
  MIME_APPLICATION_OCTET_STREAM,
  MIME_TEXT_PLAIN_UTF8,
  TYPE_MESSAGE
} from 'btp-packet'
import { randomBytes } from 'crypto'
import { sign } from 'eth-crypto'
import {
  deserializeIlpPrepare,
  deserializeIlpReply,
  Errors,
  errorToReject,
  IlpPrepare,
  IlpReply,
  isFulfill,
  isReject
} from 'ilp-packet'
import { BtpPacket, BtpPacketData, BtpSubProtocol } from 'ilp-plugin-btp'
import { keccak256 } from 'js-sha3'
import { promisify } from 'util'
import Web3 from 'web3'
import { TransactionReceipt } from 'web3/types'
import EthereumPlugin from '.'
import { DataHandler, MoneyHandler } from './types/plugin'
import {
  ClaimablePaymentChannel,
  fetchChannel,
  generateChannelId,
  isDisputed,
  isValidClaimSignature,
  PaymentChannel,
  prepareTransaction,
  remainingInChannel,
  SerializedClaim,
  SIGNED_MESSAGE_PREFIX,
  spentFromChannel,
  updateChannel
} from './utils/contract'
import ReducerQueue from './utils/queue'

// Almost never use exponential notation
BigNumber.config({ EXPONENTIAL_AT: 1e9 })

const delay = (timeout: number) => new Promise(r => setTimeout(r, timeout))

const getBtpSubprotocol = (message: BtpPacket, name: string) =>
  message.data.protocolData.find((p: BtpSubProtocol) => p.protocolName === name)

export const generateBtpRequestId = async () =>
  (await promisify(randomBytes)(4)).readUInt32BE(0)

export const format = (num: AssetUnit) => convert(num, eth()) + ' eth'

export interface SerializedAccountData {
  accountName: string
  receivableBalance: string
  payableBalance: string
  payoutAmount: string
  ethereumAddress?: string
  incoming?: ClaimablePaymentChannel
  outgoing?: PaymentChannel
}

export interface AccountData {
  /** Hash/account identifier in ILP address */
  accountName: string

  /** Incoming amount owed to us by our peer for their packets we've forwarded */
  receivableBalance: BigNumber

  /** Outgoing amount owed by us to our peer for packets we've sent to them */
  payableBalance: BigNumber

  /**
   * Amount of failed outgoing settlements that is owed to the peer, but not reflected
   * in the payableBalance (e.g. due to sendMoney calls on client)
   */
  payoutAmount: BigNumber

  /**
   * Ethereum address counterparty should be paid at
   * - Does not pertain to address counterparty sends from
   * - Must be linked for the lifetime of the account
   */
  ethereumAddress?: string

  /**
   * Priority FIFO queue for validating incoming claims,
   * watching channels and claiming channels
   */
  incoming: ReducerQueue<ClaimablePaymentChannel | undefined>

  /**
   * Priority FIFO queue for opening/depositing to channels,
   * and signing outgoing payment channel claims
   */
  outgoing: ReducerQueue<PaymentChannel | undefined>
}

enum IncomingTaskPriority {
  ClaimChannel = 3,
  ChannelWatcher = 2,
  ValidateClaim = 1
}

export default class EthereumAccount {
  /** Metadata specific to this account to persist (claims, channels, balances) */
  account: AccountData

  /** Expose access to common configuration across accounts */
  private master: EthereumPlugin

  /**
   * Send the given BTP packet message to the counterparty for this account
   * (wraps _call on internal plugin)
   */
  private sendMessage: (message: BtpPacket) => Promise<BtpPacketData>

  /** Data handler from plugin for incoming ILP packets */
  private dataHandler: DataHandler

  /** Money handler from plugin for incoming money */
  private moneyHandler: MoneyHandler

  /** Timer/interval for channel watcher to claim incoming, disputed channels */
  private watcher: NodeJS.Timer | null

  constructor({
    accountData,
    master,
    sendMessage,
    dataHandler,
    moneyHandler
  }: {
    accountName: string
    accountData: AccountData
    master: EthereumPlugin
    sendMessage: (message: BtpPacket) => Promise<BtpPacketData>
    dataHandler: DataHandler
    moneyHandler: MoneyHandler
  }) {
    this.master = master
    this.sendMessage = sendMessage
    this.dataHandler = dataHandler
    this.moneyHandler = moneyHandler

    this.account = new Proxy(accountData, {
      set: (account, key, val) => {
        this.persistAccountData()
        return Reflect.set(account, key, val)
      }
    })

    // Automatically persist cached channels/claims to the store
    this.account.incoming.on('data', () => this.persistAccountData())
    this.account.outgoing.on('data', () => this.persistAccountData())

    this.watcher = this.startChannelWatcher()
  }

  private persistAccountData(): void {
    this.master._store.set(`${this.account.accountName}:account`, this.account)
  }

  /**
   * Inform the peer what address this instance should be paid at and
   * request the Ethereum address the peer wants to be paid at
   * - No-op if we already know the peer's address
   */
  private async fetchEthereumAddress(): Promise<void> {
    if (typeof this.account.ethereumAddress === 'string') return
    try {
      const response = await this.sendMessage({
        type: TYPE_MESSAGE,
        requestId: await generateBtpRequestId(),
        data: {
          protocolData: [
            {
              protocolName: 'info',
              contentType: MIME_APPLICATION_JSON,
              data: Buffer.from(
                JSON.stringify({
                  ethereumAddress: this.master._ethereumAddress
                })
              )
            }
          ]
        }
      })

      const info = response.protocolData.find(
        (p: BtpSubProtocol) => p.protocolName === 'info'
      )

      if (info) {
        this.linkEthereumAddress(info)
      } else {
        this.master._log.debug(
          `Failed to link Ethereum address: BTP response did not include any 'info' subprotocol data`
        )
      }
    } catch (err) {
      this.master._log.debug(
        `Failed to exchange Ethereum addresses: ${err.message}`
      )
    }
  }

  /**
   * Validate the response to an `info` request and link
   * the provided Ethereum address to the account, if it's valid
   */
  private linkEthereumAddress(info: BtpSubProtocol): void {
    try {
      const { ethereumAddress } = JSON.parse(info.data.toString())

      if (typeof ethereumAddress !== 'string') {
        return this.master._log.debug(
          `Failed to link Ethereum address: invalid response, no address provided`
        )
      }

      if (!Web3.utils.isAddress(ethereumAddress)) {
        return this.master._log.debug(
          `Failed to link Ethereum address: not a valid address`
        )
      }

      const currentAddress = this.account.ethereumAddress
      if (currentAddress) {
        // Don't log if it's the same address that's already linked...we don't care
        if (currentAddress.toLowerCase() === ethereumAddress.toLowerCase()) {
          return
        }

        return this.master._log.debug(
          `Cannot link Ethereum address ${ethereumAddress} to ${
            this.account.accountName
          }: ${currentAddress} is already linked for the lifetime of the account`
        )
      }

      this.account.ethereumAddress = ethereumAddress
      this.master._log.debug(
        `Successfully linked Ethereum address ${ethereumAddress} to ${
          this.account.accountName
        }`
      )
    } catch (err) {
      this.master._log.debug(`Failed to link Ethereum address: ${err.message}`)
    }
  }

  async fundOutgoingChannel(
    value: BigNumber = this.master._outgoingChannelAmount,
    authorize: (fee: BigNumber) => Promise<void> = () => Promise.resolve()
  ): Promise<void> {
    await this.account.outgoing.add(async cachedChannel => {
      const valueWei = convert(gwei(value), wei())

      // Always refresh the channel details
      // TODO This should only happen if depositing, right? (Does it need to though?)
      const channel =
        cachedChannel &&
        (await updateChannel(this.master._contract!, cachedChannel))

      if (!channel) {
        await this.fetchEthereumAddress()
        if (!this.account.ethereumAddress) {
          this.master._log.debug(
            'Failed to open channel: no Ethereum address is linked'
          )
          return
        }

        const channelId = await generateChannelId()
        const txObj = this.master._contract!.methods.open(
          channelId,
          this.account.ethereumAddress,
          this.master._outgoingDisputePeriod.toString()
        )

        const { sendTransaction, txFee } = await prepareTransaction({
          txObj,
          value: valueWei,
          from: this.master._ethereumAddress,
          gasPrice: await this.master._getGasPrice()
        })

        await authorize(txFee)

        this.master._log.debug(
          `Opening channel for ${format(gwei(value))} and fee of ${format(
            wei(txFee)
          )}`
        )

        const emitter = sendTransaction()

        await new Promise((resolve, reject) => {
          emitter.on(
            'confirmation',
            (confNumber: number, receipt: TransactionReceipt) => {
              if (!receipt.status) {
                this.master._log.error(
                  `Failed to open channel: on-chain transaction reverted by the EVM`
                )
                reject()
              } else if (confNumber >= 1) {
                this.master._log.info(
                  `Successfully opened new channel ${channelId} for ${format(
                    gwei(value)
                  )} and fee of ${format(wei(txFee))}`
                )

                // TODO Should the channel refreshing occur here?
                // TODO If it was mined (but then was orphaned, idk), the tx might
                // still be pending and get mined later, so it'd be a shame to throw away the open channel

                resolve()
              }
            }
          )

          emitter.on('error', (err: Error) => {
            this.master._log.error(`Failed to open channel: ${err.message}`)
            reject()
          })
        })

        // @ts-ignore
        emitter.removeAllListeners()

        // Ensure that we've successfully fetched the channel details before sending a claim
        const refreshChannel = async (
          attempts = 0
        ): Promise<PaymentChannel | undefined> => {
          if (attempts > 20) {
            this.master._log.error(
              'Unable to lookup newly opened channel after 20 attempts despite 1 block confirmation'
            )
            return
          }

          // Swallow errors here: we'll throw if all attempts fail
          const updatedChannel = await fetchChannel(
            this.master._contract!,
            channelId
          ).catch(() => undefined)

          return !updatedChannel
            ? delay(500).then(() => refreshChannel(attempts + 1))
            : updatedChannel
        }

        return refreshChannel()
      } else {
        const totalNewValue = channel.value.plus(value)

        const channelId = channel.channelId
        const txObj = this.master._contract!.methods.deposit(channelId)

        const { sendTransaction, txFee } = await prepareTransaction({
          txObj,
          value: valueWei,
          from: channel.sender,
          gasPrice: await this.master._getGasPrice()
        })

        await authorize(txFee)

        this.master._log.debug(
          `Depositing ${format(gwei(value))} to channel for fee of ${format(
            wei(txFee)
          )}`
        )
        const emitter = sendTransaction()

        await new Promise((resolve, reject) => {
          emitter.on(
            'confirmation',
            (confNumber: number, receipt: TransactionReceipt) => {
              if (!receipt.status) {
                this.master._log.error(
                  `Failed to deposit to channel: on-chain transaction reverted by the EVM`
                )
                reject()
              } else if (confNumber >= 1) {
                this.master._log.info(
                  `Successfully deposited ${format(
                    gwei(value)
                  )} to channel ${channelId}`
                )
                resolve()
              }
            }
          )

          emitter.on('error', (err: Error) => {
            this.master._log.error(
              `Failed to deposit to channel: ${err.message}`
            )
            reject()
          })
        })

        // @ts-ignore
        emitter.removeAllListeners()

        // Ensure that we've successfully fetched the updated channel details before sending a new claim
        const refreshChannel = async (
          attempts = 0
        ): Promise<PaymentChannel | undefined> => {
          if (attempts > 20) {
            this.master._log.error(
              'Unable to lookup new channel details after 20 attempts despite 1 block confirmation'
            )
            return channel
          }

          const updatedChannel = await updateChannel(
            this.master._contract!,
            channel
          )

          const successfulDeposit =
            updatedChannel &&
            updatedChannel.value.isGreaterThanOrEqualTo(totalNewValue)

          return !successfulDeposit
            ? delay(500).then(() => refreshChannel(attempts + 1))
            : updatedChannel
        }

        return refreshChannel()
      }
    })
  }

  /**
   * Send a settlement/payment channel claim to the peer
   *
   * If an amount is specified (e.g. role=client), try to send that amount, plus the amount of
   * settlements that have previously failed.
   *
   * If no amount is specified (e.g. role=server), settle such that 0 is owed to the peer.
   */
  async sendMoney(amount?: string) {
    // TODO Don't log 0 amount settlements!

    await this.account.outgoing.add(async cachedChannel => {
      this.master._log.info(
        `Settlement attempt triggered with ${this.account.accountName}`
      )

      const amountToSend =
        amount || BigNumber.max(0, this.account.payableBalance)

      this.account.payoutAmount = this.account.payoutAmount.plus(amountToSend)
      const settlementBudget = convert(gwei(this.account.payoutAmount), wei())

      if (!cachedChannel) {
        this.master._log.debug(`Cannot send claim: no channel is open`)
        return
      }

      // Even if the channel is disputed, continue to send claims: assuming this plugin is not malicious,
      // sending a better claim is good, because it may incentivize the receiver to claim the channel

      // Ensure the claim increment is always > 0
      if (!remainingInChannel(cachedChannel).isPositive()) {
        this.master._log.debug(
          `Cannot send claim to: no remaining funds in outgoing channel`
        )
        return cachedChannel
      }

      if (!settlementBudget.isPositive()) {
        this.master._log.debug(
          `Cannot send claim to: no remaining settlement budget`
        )
        return cachedChannel
      }

      // Ensures that the increment is greater than the previous claim
      // Since budget and remaining in channel must be positive, claim increment should always be positive
      const claimIncrement = BigNumber.min(
        remainingInChannel(cachedChannel),
        settlementBudget
      )

      // Total value of new claim: value of old best claim + increment of new claim
      const value = spentFromChannel(cachedChannel).plus(claimIncrement)

      const updatedChannel = this.signClaim(value, cachedChannel)

      this.master._log.debug(
        `Sending claim for total of ${format(
          wei(value)
        )}, incremented by ${format(wei(claimIncrement))}`
      )

      // Send paychan claim to client, don't await a response
      this.sendClaim(updatedChannel).catch(err =>
        // If they reject the claim, it's not particularly actionable
        this.master._log.debug(
          `Error while sending claim to peer: ${err.message}`
        )
      )

      const claimIncrementGwei = convert(
        wei(claimIncrement),
        gwei()
      ).decimalPlaces(0, BigNumber.ROUND_DOWN)

      this.account.payableBalance = this.account.payableBalance.minus(
        claimIncrementGwei
      )

      this.account.payoutAmount = BigNumber.min(
        0,
        this.account.payoutAmount.minus(claimIncrementGwei)
      )

      return updatedChannel
    })
  }

  signClaim(value: BigNumber, cachedChannel: PaymentChannel): PaymentChannel {
    const paymentDigest = Web3.utils.soliditySha3(
      cachedChannel.contractAddress,
      cachedChannel.channelId,
      value.toString()
    )

    const paymentDigestBuffer = Buffer.from(
      Web3.utils.hexToBytes(paymentDigest)
    )

    const prefixedPaymentDigest = Buffer.concat([
      Buffer.from(SIGNED_MESSAGE_PREFIX),
      paymentDigestBuffer
    ])

    const signature = sign(
      this.master._privateKey,
      keccak256(prefixedPaymentDigest)
    )

    return {
      ...cachedChannel,
      spent: value,
      signature
    }
  }

  async sendClaim({
    channelId,
    signature,
    spent,
    contractAddress
  }: PaymentChannel) {
    const claim = {
      channelId,
      signature,
      value: spent.toString(),
      contractAddress
    }

    return this.sendMessage({
      type: TYPE_MESSAGE,
      requestId: await generateBtpRequestId(),
      data: {
        protocolData: [
          {
            protocolName: 'machinomy',
            contentType: MIME_APPLICATION_JSON,
            data: Buffer.from(JSON.stringify(claim))
          }
        ]
      }
    })
  }

  async handleData(message: BtpPacket): Promise<BtpSubProtocol[]> {
    // Link the given Ethereum address & inform counterparty what address this wants to be paid at
    const info = getBtpSubprotocol(message, 'info')
    if (info) {
      this.linkEthereumAddress(info)

      return [
        {
          protocolName: 'info',
          contentType: MIME_APPLICATION_JSON,
          data: Buffer.from(
            JSON.stringify({
              ethereumAddress: this.master._ethereumAddress
            })
          )
        }
      ]
    }

    // If the peer requests to close a channel, try to close it, if it's profitable
    const requestClose = getBtpSubprotocol(message, 'requestClose')
    if (requestClose) {
      this.master._log.info(
        `Channel close requested for account ${this.account.accountName}`
      )

      this.claimIfProfitable().catch(err =>
        this.master._log.error(
          `Error attempting to claim channel: ${err.message}`
        )
      )

      return [
        {
          protocolName: 'requestClose',
          contentType: MIME_TEXT_PLAIN_UTF8,
          data: Buffer.alloc(0)
        }
      ]
    }

    const machinomy = getBtpSubprotocol(message, 'machinomy')
    if (machinomy) {
      this.master._log.debug(
        `Handling Machinomy claim for account ${this.account.accountName}`
      )

      // If JSON is semantically invalid, this will throw
      const claim = JSON.parse(machinomy.data.toString())

      const hasValidSchema = (o: any): o is SerializedClaim =>
        typeof o.value === 'string' &&
        typeof o.channelId === 'string' &&
        typeof o.signature === 'string' &&
        typeof o.contractAddress === 'string'
      if (!hasValidSchema(claim)) {
        this.master._log.debug('Invalid claim: schema is malformed')
        return []
      }

      await this.account.incoming
        .add(this.validateClaim(claim), IncomingTaskPriority.ValidateClaim)
        .catch(err =>
          // Don't expose internal errors, since it wasn't intentionally thrown
          this.master._log.error('Failed to validate claim: ', err)
        )

      return []
    }

    // Handle incoming ILP PREPARE packets from peer
    // plugin-btp handles correlating the response packets for the dataHandler
    const ilp = getBtpSubprotocol(message, 'ilp')
    if (ilp) {
      try {
        const { amount } = deserializeIlpPrepare(ilp.data)
        const amountBN = new BigNumber(amount)

        if (amountBN.gt(this.master._maxPacketAmount)) {
          throw new Errors.AmountTooLargeError('Packet size is too large.', {
            receivedAmount: amount,
            maximumAmount: this.master._maxPacketAmount.toString()
          })
        }

        const newBalance = this.account.receivableBalance.plus(amount)
        if (newBalance.isGreaterThan(this.master._maxBalance)) {
          this.master._log.debug(
            `Cannot forward PREPARE: cannot debit ${format(
              gwei(amount)
            )}: proposed balance of ${format(
              gwei(newBalance)
            )} exceeds maximum of ${format(gwei(this.master._maxBalance))}`
          )
          throw new Errors.InsufficientLiquidityError(
            'Exceeded maximum balance'
          )
        }

        this.master._log.debug(
          `Forwarding PREPARE: Debited ${format(
            gwei(amount)
          )}, new balance is ${format(gwei(newBalance))}`
        )
        this.account.receivableBalance = newBalance

        const response = await this.dataHandler(ilp.data)
        const reply = deserializeIlpReply(response)

        if (isReject(reply)) {
          this.master._log.debug(
            `Credited ${format(gwei(amount))} in response to REJECT`
          )
          this.account.receivableBalance = this.account.receivableBalance.minus(
            amount
          )
        } else if (isFulfill(reply)) {
          this.master._log.debug(
            `Received FULFILL in response to forwarded PREPARE`
          )
        }

        return [
          {
            protocolName: 'ilp',
            contentType: MIME_APPLICATION_OCTET_STREAM,
            data: response
          }
        ]
      } catch (err) {
        return [
          {
            protocolName: 'ilp',
            contentType: MIME_APPLICATION_OCTET_STREAM,
            data: errorToReject('', err)
          }
        ]
      }
    }

    return []
  }

  validateClaim = (claim: SerializedClaim) => async (
    cachedChannel: ClaimablePaymentChannel | undefined,
    attempts = 0
  ): Promise<ClaimablePaymentChannel | undefined> => {
    if (attempts > 20) {
      this.master._log.debug(
        `Failed to validate claim: can't certify updated channel state, despite several attempts. Will not retry.`
      )
      return cachedChannel
    }

    // To reduce latency, only fetch channel state if no channel was linked, or there was a possible on-chain deposit
    const shouldFetchChannel =
      !cachedChannel ||
      new BigNumber(claim.value).isGreaterThan(cachedChannel.value)
    const updatedChannel = shouldFetchChannel
      ? await fetchChannel(this.master._contract!, claim.channelId) // TODO Make sure using the claim id here is safe!
      : cachedChannel

    // Perform checks to link a new channel
    if (!cachedChannel) {
      // TODO Should this also re-try if the claim value is greater than the channel value, akin to deposits?
      if (!updatedChannel) {
        this.master._log.debug(
          `Disregarding incoming claim: channel ${
            claim.channelId
          } doesn't exist (will retry in 500ms in case the block is still propagating)`
        )

        await delay(500)
        return this.validateClaim(claim)(cachedChannel, attempts + 1)
      }

      // Ensure the claim is positive or zero
      // Allow claims of 0, essentially a proof of channel ownership without sending any money
      const hasNegativeValue = new BigNumber(claim.value).isNegative()
      if (hasNegativeValue) {
        this.master._log.error(`Invalid claim: value is negative`)
        return
      }

      const isCorrectContract =
        claim.contractAddress.toLowerCase() ===
        this.master._contract!.options.address.toLowerCase()
      if (!isCorrectContract) {
        this.master._log.debug(
          'Invalid claim: sender is using a different contract or network (e.g. testnet instead of mainnet)'
        )
        return
      }

      if (!isValidClaimSignature(claim, updatedChannel)) {
        this.master._log.debug('Invalid claim: signature is invalid')
        return
      }

      // Ensure the channel is to this address
      // (only check for new channels, not per claim, in case the server restarts and changes config)
      const amReceiver =
        updatedChannel.receiver.toLowerCase() ===
        this.master._ethereumAddress.toLowerCase()
      if (!amReceiver) {
        this.master._log.debug(
          `Invalid claim: the recipient for new channel ${
            claim.channelId
          } is not ${this.master._ethereumAddress}`
        )
        return
      }

      // Confirm the settling period for the channel is above the minimum
      const isAboveMinDisputePeriod = updatedChannel.disputePeriod.isGreaterThanOrEqualTo(
        this.master._minIncomingDisputePeriod
      )
      if (!isAboveMinDisputePeriod) {
        this.master._log.debug(
          `Invalid claim: new channel ${
            claim.channelId
          } has dispute period of ${
            updatedChannel.disputePeriod
          } blocks, below floor of ${
            this.master._minIncomingDisputePeriod
          } blocks`
        )
        return
      }

      /**
       * Ensure no channel can be linked to multiple accounts
       * - No race condition, since linked channel will added to store cache at the end of this closure)
       * - Each channel key is a mapping of channelId -> accountName
       */
      const channelKey = `${claim.channelId}:incoming-channel`
      await this.master._store.load(channelKey)
      const linkedAccount = this.master._store.get(channelKey)
      if (typeof linkedAccount === 'string') {
        this.master._log.debug(
          `Invalid claim: channel ${
            claim.channelId
          } is already linked to a different account`
        )
        return
      }

      this.master._store.set(channelKey, this.account.accountName)
      this.master._log.debug(
        `Incoming channel ${claim.channelId} is now linked to account ${
          this.account.accountName
        }`
      )
    }
    // An existing claim is linked, so validate this against the previous claim
    else {
      if (!updatedChannel) {
        this.master._log.error(`Invalid claim: channel is unexpectedly closed`)
        return cachedChannel
      }

      const sufficientChannelValue = updatedChannel.value.isGreaterThanOrEqualTo(
        claim.value
      )
      if (!sufficientChannelValue) {
        this.master._log.debug(
          `Disregarding incoming claim: value of ${format(
            wei(claim.value)
          )} is above value of channel (will retry in 500ms in case an on-chain deposit occurred)`
        )

        await delay(500)
        return this.validateClaim(claim)(cachedChannel, attempts + 1)
      }

      // `updatedChannel` is fetched using the id in the claim, so compare
      // against the previously linked channelId in `cachedChannel`
      const wrongChannel = claim.channelId !== cachedChannel.channelId
      if (wrongChannel) {
        this.master._log.debug(
          'Invalid claim: channel is not the linked channel'
        )
        return cachedChannel
      }

      if (!isValidClaimSignature(claim, updatedChannel)) {
        this.master._log.debug('Invalid claim: signature is invalid')
        return cachedChannel
      }
    }

    // Cap the value of the credited claim by the total value of the channel
    const claimIncrement = BigNumber.min(
      claim.value,
      updatedChannel.value
    ).minus(cachedChannel ? cachedChannel.spent : 0)

    const isBestClaim = claimIncrement.isPositive()
    if (!isBestClaim && cachedChannel) {
      this.master._log.debug(
        `Invalid claim: value of ${format(
          wei(claim.value)
        )} is less than previous claim for ${format(wei(updatedChannel.spent))}`
      )
      return cachedChannel
    }

    // Only perform balance operations if the claim increment is positive
    if (isBestClaim) {
      const amount = convert(wei(claimIncrement), gwei()).dp(
        0,
        BigNumber.ROUND_DOWN
      )

      this.account.receivableBalance = this.account.receivableBalance.minus(
        amount
      )

      await this.moneyHandler(amount.toString())
    }

    this.master._log.debug(
      `Accepted incoming claim from account ${
        this.account.accountName
      } for ${format(wei(claimIncrement))}`
    )

    // Start the channel watcher if it wasn't already running
    if (!this.watcher) {
      this.watcher = this.startChannelWatcher()
    }

    return {
      ...updatedChannel,
      channelId: claim.channelId,
      contractAddress: claim.contractAddress,
      signature: claim.signature,
      spent: new BigNumber(claim.value)
    }
  }

  // Handle the response from a forwarded ILP PREPARE
  handlePrepareResponse(prepare: IlpPrepare, reply: IlpReply) {
    if (isFulfill(reply)) {
      // Update balance to reflect that we owe them the amount of the FULFILL
      const amount = new BigNumber(prepare.amount)

      this.master._log.debug(
        `Received a FULFILL in response to forwarded PREPARE: credited ${format(
          gwei(amount)
        )}`
      )
      this.account.payableBalance = this.account.payableBalance.plus(amount)
    } else if (isReject(reply)) {
      this.master._log.debug(
        `Received a ${reply.code} REJECT in response to the forwarded PREPARE`
      )
    }

    // Attempt to settle on fulfills *and* T04s (to resolve stalemates)
    const shouldSettle =
      isFulfill(reply) || (isReject(reply) && reply.code === 'T04')
    if (shouldSettle) {
      this.sendMoney().catch((err: Error) =>
        this.master._log.debug('Error queueing outgoing settlement: ', err)
      )
    }
  }

  private startChannelWatcher() {
    const timer: NodeJS.Timeout = setInterval(
      () =>
        this.account.incoming.add(async cachedChannel => {
          // No channel & claim are linked: stop the channel watcher
          if (!cachedChannel) {
            this.watcher = null
            clearInterval(timer)
            return cachedChannel
          }

          const updatedChannel = await updateChannel<ClaimablePaymentChannel>(
            this.master._contract!,
            cachedChannel
          )

          // Channel is closed: stop the channel watcher
          if (!updatedChannel) {
            this.watcher = null
            clearInterval(timer)
            return updatedChannel
          }

          if (isDisputed(updatedChannel)) {
            this.claimIfProfitable(true).catch((err: Error) => {
              this.master._log.debug(
                `Error attempting to claim channel: ${err.message}`
              )
            })
          }

          return updatedChannel
        }, IncomingTaskPriority.ChannelWatcher),
      this.master._channelWatcherInterval.toNumber()
    )

    return timer
  }

  claimIfProfitable(
    requireDisputed = false,
    authorize?: (channel: PaymentChannel, fee: BigNumber) => Promise<void>
  ) {
    return this.account.incoming.add(async cachedChannel => {
      if (!cachedChannel || !cachedChannel.signature) {
        return cachedChannel
      }

      const updatedChannel = await updateChannel(
        this.master._contract!,
        cachedChannel
      )
      if (!updatedChannel) {
        this.master._log.error(
          `Cannot claim channel ${cachedChannel.channelId} with ${
            this.account.accountName
          }: linked channel is unexpectedly closed`
        )
        return updatedChannel
      }

      const { channelId, spent, signature } = updatedChannel

      if (requireDisputed && !isDisputed(updatedChannel)) {
        this.master._log.debug(
          `Won't claim channel ${updatedChannel.channelId} with ${
            this.account.accountName
          }: channel is not disputed`
        )
        return updatedChannel
      }

      this.master._log.debug(
        `Attempting to claim channel ${channelId} for ${format(
          wei(updatedChannel.spent)
        )}`
      )

      const txObj = this.master._contract!.methods.claim(
        channelId,
        spent.toString(),
        signature
      )

      const { sendTransaction, txFee } = await prepareTransaction({
        txObj,
        from: updatedChannel.receiver,
        gasPrice: await this.master._getGasPrice()
      })

      // Check to verify it's profitable first
      if (authorize) {
        const isAuthorized = await authorize(updatedChannel, txFee)
          .then(() => true)
          .catch(() => false)

        if (!isAuthorized) {
          return updatedChannel
        }
      } else if (txFee.isGreaterThanOrEqualTo(spent)) {
        this.master._log.debug(
          `Not profitable to claim channel ${channelId} with ${
            this.account.accountName
          }: fee of ${format(wei(txFee))} is greater than value of ${format(
            wei(spent)
          )}`
        )

        return updatedChannel
      }

      const emitter = sendTransaction()

      await new Promise((resolve, reject) => {
        emitter.on(
          'confirmation',
          (confNumber: number, receipt: TransactionReceipt) => {
            if (!receipt.status) {
              this.master._log.error(
                `Failed to claim channel: on-chain transaction reverted by the EVM`
              )
              reject()
            } else if (confNumber >= 1) {
              this.master._log.info(
                `Successfully claimed channel ${channelId} for account ${
                  this.account.accountName
                }`
              )
              resolve()
            }
          }
        )

        emitter.on('error', (err: Error) => {
          this.master._log.error(`Failed to claim channel: ${err.message}`)
          reject()
        })
      })

      // @ts-ignore
      emitter.removeAllListeners()

      // Ensure that we've successfully fetched the updated channel details before sending a new claim
      const refreshChannel = async (
        attempts = 0
      ): Promise<ClaimablePaymentChannel | undefined> => {
        if (attempts > 20) {
          this.master._log.error(
            'Unable to confirm channel close after 20 attempts despite 1 block confirmation'
          )
          return updatedChannel
        }

        return (
          // Return undefined if the channel no longer exists (good!)...
          (await fetchChannel(this.master._contract!, channelId)) &&
          // ...or check again in 500ms if it still exists
          delay(500).then(() => refreshChannel(attempts + 1))
        )
      }

      return refreshChannel()
    }, IncomingTaskPriority.ClaimChannel)
  }

  // Request the peer to claim the outgoing channel
  async requestClose() {
    return this.sendMessage({
      requestId: await generateBtpRequestId(),
      type: TYPE_MESSAGE,
      data: {
        protocolData: [
          {
            protocolName: 'requestClose',
            contentType: MIME_TEXT_PLAIN_UTF8,
            data: Buffer.alloc(0)
          }
        ]
      }
    }).catch(err =>
      this.master._log.debug(
        `Error while requesting peer to claim channel: ${err.message}`
      )
    )
  }

  // From mini-accounts: invoked on a websocket close or error event
  // From plugin-btp: invoked *only* when `disconnect` is called on plugin
  async disconnect(): Promise<void> {
    // Only stop the channel watcher if the channels were attempted to be closed
    if (this.watcher) {
      clearInterval(this.watcher)
    }
  }

  unload(): void {
    // Stop the channel watcher
    if (this.watcher) {
      clearInterval(this.watcher)
    }

    // Remove event listeners that persisted updated channels/claims
    this.account.outgoing.removeAllListeners()
    this.account.incoming.removeAllListeners()

    // Remove account from store cache
    this.master._store.unload(`${this.account.accountName}:account`)

    // Garbage collect the account at the top-level
    this.master._accounts.delete(this.account.accountName)
  }
}
