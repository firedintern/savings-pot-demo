import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { SavingsPotDemoFactory } from '../artifacts/savings_pot/SavingsPotDemoClient'

export async function deploy() {
  console.log('=== Deploying SavingsPotDemo ===')

  const algorand = AlgorandClient.fromEnvironment()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')

  const factory = algorand.client.getTypedAppFactory(SavingsPotDemoFactory, {
    defaultSender: deployer.addr,
  })

  const { appClient, result } = await factory.deploy({
    onUpdate: 'append',
    onSchemaBreak: 'append',
    createParams: { method: 'createApplication', args: {} },
  })

  // Fund the app account with 1 ALGO so it can hold box storage MBR.
  // BoxMap for members requires the app account to have enough balance.
  if (['create', 'replace'].includes(result.operationPerformed)) {
    await algorand.send.payment({
      amount: (1).algo(),
      sender: deployer.addr,
      receiver: appClient.appAddress,
    })
    console.log(`Funded app account: ${appClient.appAddress}`)
  }

  console.log(`App ID: ${appClient.appId}`)
  console.log(`App Address: ${appClient.appAddress}`)

  // Quick smoke test: read initial state.
  const totalResult = await appClient.newGroup().getTotal().simulate()
  const memberResult = await appClient.newGroup().getMemberCount().simulate()

  console.log(`Initial total_deposited: ${totalResult.returns[0]} microAlgos`)
  console.log(`Initial member_count: ${memberResult.returns[0]}`)
}
