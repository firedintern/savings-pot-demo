/**
 * SavingsPot.tsx — LocalNet Demo UI
 *
 * Demo mode: uses KMD-managed LocalNet accounts directly.
 * No wallet extension needed — all signing goes through KMD.
 *
 * How deposit works on Algorand in this contract:
 *   The user must submit an atomic group of two transactions:
 *     1. PaymentTxn: sends ALGO from the user to the app's escrow address.
 *     2. AppCallTxn: calls deposit(pay) — the contract reads gtxn[N-1],
 *        checks the receiver is the app address, then adds the amount to
 *        the running total_deposited counter.
 */

import { AlgorandClient, microAlgo } from '@algorandfoundation/algokit-utils'
import { useEffect, useState, useCallback } from 'react'
import { getApplicationAddress } from 'algosdk'
import { SavingsPotDemoFactory } from './contracts/SavingsPotDemo'

// App ID printed by `algokit project deploy localnet` — update after each deploy.
// Or set VITE_APP_ID in .env.local.
const APP_ID = BigInt(import.meta.env.VITE_APP_ID ?? '0')

// ── LocalNet AlgorandClient ───────────────────────────────────────────────────
const algorand = AlgorandClient.fromConfig({
  algodConfig: { server: 'http://localhost', port: 4001, token: 'a'.repeat(64) },
  kmdConfig:   { server: 'http://localhost', port: Number(import.meta.env.VITE_KMD_PORT ?? 4002), token: 'a'.repeat(64) },
})

const KMD_WALLET = 'unencrypted-default-wallet'

// ── Types ─────────────────────────────────────────────────────────────────────
interface ChainState  { totalDeposited: bigint; memberCount: bigint }
interface LocalAccount { address: string; label: string }

// ── Helpers ────────────────────────────────────────────────────────────────────
const microToAlgo = (micro: bigint) => (Number(micro) / 1_000_000).toFixed(6)
const ts = () => new Date().toLocaleTimeString()

export default function SavingsPot() {
  const [state,      setState]      = useState<ChainState | null>(null)
  const [accounts,   setAccounts]   = useState<LocalAccount[]>([])
  const [active,     setActive]     = useState('')
  const [depositAmt, setDepositAmt] = useState('0.5')
  const [log,        setLog]        = useState<string[]>([])
  const [busy,       setBusy]       = useState(false)
  const [err,        setErr]        = useState('')

  const addLog = (msg: string) =>
    setLog(prev => [`[${ts()}] ${msg}`, ...prev.slice(0, 29)])

  // ── Read on-chain state ─────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    if (APP_ID === 0n) {
      setErr('Set VITE_APP_ID in .env.local to your deployed app ID (see console)')
      return
    }
    setErr('')
    try {
      const dispenser = await algorand.account.localNetDispenser()
      const client = algorand.client
        .getTypedAppFactory(SavingsPotDemoFactory, { defaultSender: dispenser.addr })
        .getAppClientById({ appId: APP_ID })

      const [totalRes, countRes] = await Promise.all([
        client.newGroup().getTotal().simulate(),
        client.newGroup().getMemberCount().simulate(),
      ])
      setState({
        totalDeposited: totalRes.returns[0]  ?? 0n,
        memberCount:    countRes.returns[0]  ?? 0n,
      })
    } catch (e: unknown) {
      setErr(`Refresh failed: ${(e as Error).message.split('\n')[0]}`)
    }
  }, [])

  // ── Load KMD accounts ───────────────────────────────────────────────────────
  const loadAccounts = useCallback(async () => {
    try {
      const kmd = algorand.client.kmd
      const { wallets } = await kmd.listWallets()
      const w = wallets.find((x: { name: string }) => x.name === KMD_WALLET)
      if (!w) { setErr('KMD wallet not found — is LocalNet running?'); return }
      const { wallet_handle_token } = await kmd.initWalletHandle(w.id, '')
      const { addresses } = await kmd.listKeys(wallet_handle_token)
      await kmd.releaseWalletHandle(wallet_handle_token)
      const accts: LocalAccount[] = (addresses as string[]).slice(0, 4).map((addr, i) => ({
        address: addr,
        label:   `Account ${i + 1}: ${addr.slice(0, 12)}…${addr.slice(-6)}`,
      }))
      setAccounts(accts)
      if (accts.length > 0) setActive(accts[0].address)
    } catch (e: unknown) {
      setErr(`Could not load KMD accounts: ${(e as Error).message.split('\n')[0]}`)
    }
  }, [])

  useEffect(() => { loadAccounts(); refresh() }, [loadAccounts, refresh])

  // ── Get a signer-backed account for a specific address ──────────────────────
  async function accountForAddr(addr: string) {
    return algorand.account.fromKmd(
      KMD_WALLET,
      (a: Record<string, unknown>) => a['address'] === addr,
    )
  }

  // ── Join ────────────────────────────────────────────────────────────────────
  async function handleJoin() {
    if (!active) { setErr('Select an account first'); return }
    setBusy(true); setErr('')
    try {
      const account = await accountForAddr(active)
      const client = algorand.client
        .getTypedAppFactory(SavingsPotDemoFactory, {
          defaultSender: account.addr,
          defaultSigner: account.signer,
        })
        .getAppClientById({ appId: APP_ID })

      await client.send.join({ args: {}, populateAppCallResources: true })
      addLog(`✅ ${active.slice(0, 12)}…${active.slice(-6)} joined the pot`)
      await refresh()
    } catch (e: unknown) {
      const msg = (e as Error).message
      const friendly = msg.includes('Already a member')
        ? 'This account has already joined!'
        : `Join failed: ${msg.split('\n')[0]}`
      setErr(friendly); addLog(`❌ ${friendly}`)
    } finally { setBusy(false) }
  }

  // ── Deposit ─────────────────────────────────────────────────────────────────
  async function handleDeposit() {
    if (!active) { setErr('Select an account first'); return }
    const algoAmt = parseFloat(depositAmt)
    if (isNaN(algoAmt) || algoAmt <= 0) { setErr('Enter a valid amount in ALGO'); return }
    setBusy(true); setErr('')
    try {
      const account = await accountForAddr(active)
      const appAddress = getApplicationAddress(APP_ID)

      // Build an unsigned payment transaction pointing to the app's escrow.
      const paymentTxn = await algorand.createTransaction.payment({
        sender:   account.addr,
        receiver: appAddress,
        amount:   microAlgo(Math.round(algoAmt * 1_000_000)),
      })

      // Call deposit(pay): the contract reads the preceding payment from the group.
      const client = algorand.client
        .getTypedAppFactory(SavingsPotDemoFactory, {
          defaultSender: account.addr,
          defaultSigner: account.signer,
        })
        .getAppClientById({ appId: APP_ID })

      await client.send.deposit({ args: { payment: paymentTxn }, populateAppCallResources: true })
      addLog(`✅ ${active.slice(0, 12)}…${active.slice(-6)} deposited ${algoAmt} ALGO`)
      await refresh()
    } catch (e: unknown) {
      const msg = (e as Error).message
      const friendly = msg.includes('Not a member')
        ? 'Not a member — join first!'
        : `Deposit failed: ${msg.split('\n')[0]}`
      setErr(friendly); addLog(`❌ ${friendly}`)
    } finally { setBusy(false) }
  }

  // ── Styles ───────────────────────────────────────────────────────────────────
  const card: React.CSSProperties = {
    background: '#f8f9fa', border: '1px solid #dee2e6',
    borderRadius: 8, padding: 16, marginBottom: 20,
  }

  return (
    <div style={{ maxWidth: 640, margin: '40px auto', fontFamily: 'monospace', padding: '0 20px' }}>
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>🪙 Savings Pot Demo</h1>
      <p style={{ color: '#6c757d', fontSize: 12, marginBottom: 24 }}>
        LocalNet only · KMD test accounts · no wallet extension required
      </p>

      {err && (
        <div style={{ background: '#fff3cd', border: '1px solid #ffc107', padding: '10px 14px', borderRadius: 6, fontSize: 13, marginBottom: 16 }}>
          ⚠️ {err}
        </div>
      )}

      {/* ── On-chain state ─────────────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <strong style={{ fontSize: 15 }}>On-chain State</strong>
          <button onClick={refresh} disabled={busy} style={{ padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>
            🔄 Refresh
          </button>
        </div>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <tbody>
            <tr>
              <td style={{ padding: '4px 0', color: '#6c757d', width: 150 }}>App ID</td>
              <td style={{ fontWeight: 600 }}>
                {APP_ID === 0n ? <span style={{ color: '#dc3545' }}>Not configured — set VITE_APP_ID</span> : APP_ID.toString()}
              </td>
            </tr>
            <tr>
              <td style={{ padding: '4px 0', color: '#6c757d' }}>Total Deposited</td>
              <td style={{ fontWeight: 600 }}>
                {state ? `${microToAlgo(state.totalDeposited)} ALGO` : '—'}
                {state && <span style={{ color: '#adb5bd', marginLeft: 8, fontSize: 11 }}>({state.totalDeposited.toString()} µALGO)</span>}
              </td>
            </tr>
            <tr>
              <td style={{ padding: '4px 0', color: '#6c757d' }}>Member Count</td>
              <td style={{ fontWeight: 600 }}>{state ? state.memberCount.toString() : '—'}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ── Account selector ─────────────────────────────────────────────── */}
      <div style={card}>
        <label style={{ fontSize: 13, display: 'block', marginBottom: 6, color: '#6c757d' }}>
          Active account (LocalNet KMD)
        </label>
        <select
          value={active}
          onChange={(e) => setActive(e.target.value)}
          style={{ width: '100%', padding: 8, fontFamily: 'monospace', fontSize: 12, boxSizing: 'border-box' }}
        >
          {accounts.length === 0 && <option>Loading LocalNet accounts…</option>}
          {accounts.map(a => <option key={a.address} value={a.address}>{a.label}</option>)}
        </select>
        <p style={{ fontSize: 11, color: '#adb5bd', margin: '8px 0 0' }}>
          Full address: {active || '—'}
        </p>
      </div>

      {/* ── Actions ──────────────────────────────────────────────────────── */}
      <div style={card}>
        <strong style={{ fontSize: 15, display: 'block', marginBottom: 16 }}>Actions</strong>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>

          <div>
            <p style={{ fontSize: 12, color: '#6c757d', margin: '0 0 6px' }}>
              Register the active account as a member
            </p>
            <button
              onClick={handleJoin}
              disabled={busy || !active || APP_ID === 0n}
              style={{ padding: '10px 20px', background: '#0d6efd', color: '#fff', border: 'none', borderRadius: 6, cursor: busy ? 'wait' : 'pointer', fontSize: 14 }}
            >
              {busy ? '⏳' : '👋'} Join Pot
            </button>
          </div>

          <div>
            <p style={{ fontSize: 12, color: '#6c757d', margin: '0 0 6px' }}>
              Deposit ALGO into the pot (must be a member)
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="number" min="0.001" step="0.1"
                value={depositAmt}
                onChange={e => setDepositAmt(e.target.value)}
                style={{ width: 90, padding: 8, fontFamily: 'monospace', fontSize: 14 }}
              />
              <span style={{ fontSize: 13, color: '#6c757d' }}>ALGO</span>
              <button
                onClick={handleDeposit}
                disabled={busy || !active || APP_ID === 0n}
                style={{ padding: '10px 20px', background: '#198754', color: '#fff', border: 'none', borderRadius: 6, cursor: busy ? 'wait' : 'pointer', fontSize: 14 }}
              >
                {busy ? '⏳' : '💰'} Deposit
              </button>
            </div>
          </div>

        </div>
      </div>

      {/* ── Activity log ─────────────────────────────────────────────────── */}
      <div style={card}>
        <strong style={{ fontSize: 15, display: 'block', marginBottom: 8 }}>Activity Log</strong>
        <div style={{ background: '#1e1e1e', color: '#d4d4d4', padding: 12, borderRadius: 6, fontSize: 12, minHeight: 60, maxHeight: 200, overflowY: 'auto' }}>
          {log.length === 0
            ? <span style={{ color: '#555' }}>No activity yet</span>
            : log.map((l, i) => <div key={i} style={{ marginBottom: 2 }}>{l}</div>)}
        </div>
      </div>

      <p style={{ fontSize: 11, color: '#adb5bd', textAlign: 'center' }}>
        Contract methods: join() · deposit(pay) · getTotal() · getMemberCount()
      </p>
    </div>
  )
}
