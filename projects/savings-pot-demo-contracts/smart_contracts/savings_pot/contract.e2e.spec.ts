import { Config, algo } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { SavingsPotDemoFactory } from '../artifacts/savings_pot/SavingsPotDemoClient'

describe('SavingsPotDemo contract', () => {
  // algorandFixture creates a fresh LocalNet scope per test.
  // 100 ALGO per account so deposits don't drain test wallets.
  const localnet = algorandFixture({ testAccountFunding: algo(100) })

  beforeAll(() => {
    Config.configure({ debug: true })
  })
  beforeEach(localnet.newScope)

  // Helper: deploy a fresh app and fund its account for BoxMap MBR.
  async function deployAndFund() {
    const { testAccount } = localnet.context
    const factory = localnet.algorand.client.getTypedAppFactory(SavingsPotDemoFactory, {
      defaultSender: testAccount,
    })
    const { appClient } = await factory.deploy({
      onUpdate: 'append',
      onSchemaBreak: 'append',
      suppressLog: true,
      createParams: { method: 'createApplication', args: {} },
    })
    // BoxMap requires the app account to hold enough balance for MBR.
    await localnet.algorand.send.payment({
      amount: (1).algo(),
      sender: testAccount,
      receiver: appClient.appAddress,
    })
    return { client: appClient, deployer: testAccount }
  }

  // Helper: get a client for an existing app from a different sender.
  async function clientFor(appId: bigint, sender: { addr: import('algosdk').Address }) {
    const factory = localnet.algorand.client.getTypedAppFactory(SavingsPotDemoFactory, {
      defaultSender: sender.addr,
    })
    return factory.getAppClientById({ appId })
  }

  test('deployment succeeds and initial state is zero', async () => {
    const { client } = await deployAndFund()

    const totalResult = await client.newGroup().getTotal().simulate()
    const memberResult = await client.newGroup().getMemberCount().simulate()

    expect(totalResult.returns[0]).toBe(0n)
    expect(memberResult.returns[0]).toBe(0n)
  })

  test('an account can join', async () => {
    const { client } = await deployAndFund()

    await client.send.join({ args: {}, populateAppCallResources: true })

    const memberResult = await client.newGroup().getMemberCount().simulate()
    expect(memberResult.returns[0]).toBe(1n)
  })

  test('the same account cannot join twice', async () => {
    const { client } = await deployAndFund()

    await client.send.join({ args: {}, populateAppCallResources: true })

    await expect(
      client.send.join({ args: {}, populateAppCallResources: true }),
    ).rejects.toThrow()
  })

  test('a non-member cannot deposit', async () => {
    const { client } = await deployAndFund()

    // testAccount has NOT called join — deposit must fail.
    const paymentTxn = await localnet.algorand.createTransaction.payment({
      sender: localnet.context.testAccount,
      receiver: client.appAddress,
      amount: (0.5).algo(),
    })

    await expect(
      client.send.deposit({
        args: { payment: paymentTxn },
        populateAppCallResources: true,
      }),
    ).rejects.toThrow()
  })

  test('two members can join and deposit; get_total is correct', async () => {
    const { client, deployer: alice } = await deployAndFund()
    const bob = await localnet.context.generateAccount({ initialFunds: algo(50) })

    // Alice joins.
    await client.send.join({ args: {}, populateAppCallResources: true })

    // Bob joins via a client with his address as sender.
    const bobClient = await clientFor(client.appId, bob)
    await bobClient.send.join({ args: {}, populateAppCallResources: true })

    expect((await client.newGroup().getMemberCount().simulate()).returns[0]).toBe(2n)

    // Alice deposits 1 ALGO.
    const alicePayment = await localnet.algorand.createTransaction.payment({
      sender: alice,
      receiver: client.appAddress,
      amount: (1).algo(),
    })
    await client.send.deposit({ args: { payment: alicePayment }, populateAppCallResources: true })

    // Bob deposits 2 ALGO.
    const bobPayment = await localnet.algorand.createTransaction.payment({
      sender: bob.addr,
      receiver: client.appAddress,
      amount: (2).algo(),
    })
    await bobClient.send.deposit({ args: { payment: bobPayment }, populateAppCallResources: true })

    const totalResult = await client.newGroup().getTotal().simulate()
    // 1 ALGO + 2 ALGO = 3,000,000 microAlgos
    expect(totalResult.returns[0]).toBe(3_000_000n)
  })

  test('get_total returns expected value after a single deposit', async () => {
    const { client } = await deployAndFund()

    await client.send.join({ args: {}, populateAppCallResources: true })

    const paymentTxn = await localnet.algorand.createTransaction.payment({
      sender: localnet.context.testAccount,
      receiver: client.appAddress,
      amount: (0.5).algo(),
    })
    await client.send.deposit({ args: { payment: paymentTxn }, populateAppCallResources: true })

    const result = await client.newGroup().getTotal().simulate()
    expect(result.returns[0]).toBe(500_000n) // 0.5 ALGO in microAlgos
  })

  test('get_member_count returns expected number after two joins', async () => {
    const { client } = await deployAndFund()
    const bob = await localnet.context.generateAccount({ initialFunds: algo(10) })

    await client.send.join({ args: {}, populateAppCallResources: true })

    const bobClient = await clientFor(client.appId, bob)
    await bobClient.send.join({ args: {}, populateAppCallResources: true })

    const result = await client.newGroup().getMemberCount().simulate()
    expect(result.returns[0]).toBe(2n)
  })
})
