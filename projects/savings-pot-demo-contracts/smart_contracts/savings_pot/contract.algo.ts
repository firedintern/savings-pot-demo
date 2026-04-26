import {
  Contract,
  GlobalState,
  BoxMap,
  Txn,
  Global,
  assert,
  Uint64,
  gtxn,
} from '@algorandfoundation/algorand-typescript'
import { readonly } from '@algorandfoundation/algorand-typescript/arc4'
import type { uint64, bytes } from '@algorandfoundation/algorand-typescript'

export class SavingsPotDemo extends Contract {
  // Total microAlgos deposited by all members combined.
  totalDeposited = GlobalState<uint64>({ key: 'total_deposited' })

  // How many accounts have joined the pot.
  memberCount = GlobalState<uint64>({ key: 'member_count' })

  // BoxMap: tracks whether each account is a member.
  // Key = account address (bytes), Value = 1 (member flag).
  members = BoxMap<bytes, uint64>({ keyPrefix: 'm' })

  // Called once when the app is first created; sets counters to zero.
  public createApplication(): void {
    this.totalDeposited.value = Uint64(0)
    this.memberCount.value = Uint64(0)
  }

  // join(): registers the caller as a member.
  // Fails with a clear error if the account has already joined.
  public join(): void {
    const senderBytes = Txn.sender.bytes

    // Reject duplicate joins.
    assert(!this.members(senderBytes).exists, 'Already a member')

    // Record membership and increment the counter.
    this.members(senderBytes).value = Uint64(1)
    this.memberCount.value = this.memberCount.value + Uint64(1)
  }

  // deposit(payment): accepts a payment transaction from a member.
  // The payment must be in the same atomic group as this app call.
  // Its receiver must be this app's escrow address.
  // Only registered members may call this.
  public deposit(payment: gtxn.PaymentTxn): void {
    const senderBytes = Txn.sender.bytes

    // Only members can deposit.
    assert(this.members(senderBytes).exists, 'Not a member')

    // Ensure the ALGO goes to this app's account, not somewhere else.
    assert(payment.receiver === Global.currentApplicationAddress, 'Payment must go to the app account')

    // Add the deposited microAlgos to the running total.
    this.totalDeposited.value = this.totalDeposited.value + payment.amount
  }

  // getTotal(): read-only — returns total microAlgos deposited.
  @readonly
  public getTotal(): uint64 {
    return this.totalDeposited.value
  }

  // getMemberCount(): read-only — returns the number of members.
  @readonly
  public getMemberCount(): uint64 {
    return this.memberCount.value
  }
}
