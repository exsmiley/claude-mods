import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { RunView, RecentRow, RunningRow, Usage } from '../types'

// Live pane for long-running job runs. Any script writes one JSON file per
// run to ~/.claude/job-status/<id>.json (protocol: README.md there); this mod
// polls the folder every few seconds and draws every run, newest first.

const PANE = 'job-status'
const POLL_MS = 2500
const STALE_MS = 90_000 // no write for this long while "running" → stale
const OLD_MS = 24 * 3600_000 // finished runs older than this are collapsed
const MAX_RUNS = 30

const runs = atom({ plugin: 'job-status', key: 'runs' } as const, [] as RunView[], {
  shape: 'runs-1',
})
const nowAtom = atom({ plugin: 'job-status', key: 'now' } as const, 0)
const showOld = atom({ plugin: 'job-status', key: 'showOld' } as const, false)

// Module variables: lost on reload, which is fine (they only steer auto-open).
const openedFor = new Set<string>()
let inFlight: Promise<void> | undefined

const toMs = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : undefined
  }
  return undefined
}
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined
const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : v == null ? d : String(v))

function parseRun(name: string, text: string, mtimeMs: number): RunView {
  const id = name.replace(/\.json$/, '')
  let o: Record<string, unknown>
  try {
    o = JSON.parse(text)
  } catch (err) {
    return {
      id, title: id, state: 'unknown', startedAtMs: mtimeMs, updatedAtMs: mtimeMs,
      counts: {}, running: [], recent: [], notes: [], isStale: false,
      error: 'unreadable JSON',
    }
  }
  const counts: Record<string, number> = {}
  if (o.counts && typeof o.counts === 'object') {
    for (const [k, v] of Object.entries(o.counts as Record<string, unknown>)) {
      const n = num(v)
      if (n !== undefined) counts[k.toLowerCase()] = n
    }
  }
  const running: RunningRow[] = Array.isArray(o.running)
    ? (o.running as unknown[]).slice(0, 64).map(r => {
        const x = (r ?? {}) as Record<string, unknown>
        const row: RunningRow = { label: str(x.label, '?'), startedAt: str(x.startedAt) }
        const pid = num(x.pid)
        if (pid !== undefined) row.pid = pid
        return row
      })
    : []
  const recent: RecentRow[] = Array.isArray(o.recent)
    ? (o.recent as unknown[]).slice(-20).map(r => {
        const x = (r ?? {}) as Record<string, unknown>
        const row: RecentRow = { label: str(x.label, '?'), status: str(x.status, '?').toLowerCase(), at: str(x.at) }
        if (x.detail != null && x.detail !== '') row.detail = str(x.detail)
        const ms = num(x.ms)
        if (ms !== undefined) row.ms = ms
        return row
      })
    : []
  const notes = Array.isArray(o.notes) ? (o.notes as unknown[]).slice(-10).map(n => str(n)) : []
  const startedAtMs = toMs(o.startedAt) ?? mtimeMs
  const updatedAtMs = Math.max(toMs(o.updatedAt) ?? 0, mtimeMs)
  const fin = num(o.finishedJobs)
  const tot = num(o.totalJobMs)
  let avgJobMs = num(o.avgJobMs)
  if (avgJobMs === undefined && fin && tot !== undefined && fin > 0) avgJobMs = tot / fin
  if (avgJobMs === undefined) {
    const timed = recent.filter(r => r.ms !== undefined && r.status !== 'skip')
    if (timed.length) avgJobMs = timed.reduce((a, r) => a + (r.ms ?? 0), 0) / timed.length
  }
  const view: RunView = {
    id: str(o.id, id),
    title: str(o.title, id),
    state: str(o.state, 'running').toLowerCase(),
    startedAtMs,
    updatedAtMs,
    counts,
    running,
    recent,
    notes,
    isStale: false,
  }
  const ended = toMs(o.endedAt)
  if (ended !== undefined) view.endedAtMs = ended
  const total = num(o.total)
  if (total !== undefined) view.total = total
  const pid = num(o.pid)
  if (pid !== undefined) view.pid = pid
  const lanes = num(o.lanes)
  if (lanes !== undefined) view.lanes = lanes
  if (avgJobMs !== undefined) view.avgJobMs = avgJobMs
  return view
}

type ProcTable = { alive: Set<number>; kids: Map<number, number[]>; own: Map<number, { cpu: number; rssKb: number }> }

// One `ps` of every process per poll: liveness, and CPU / memory by subtree.
async function procTable($: EngineInterface): Promise<ProcTable | undefined> {
  try {
    const r = await $.process.run(['ps', '-A', '-o', 'pid=,ppid=,pcpu=,rss='], { timeoutMs: 5000 })
    const t: ProcTable = { alive: new Set(), kids: new Map(), own: new Map() }
    for (const line of r.stdout.split('\n')) {
      const [a, b, c, d] = line.trim().split(/\s+/)
      const pid = Number(a)
      const ppid = Number(b)
      if (!a || !Number.isFinite(pid) || !Number.isFinite(ppid)) continue
      t.alive.add(pid)
      t.own.set(pid, { cpu: Number(c) || 0, rssKb: Number(d) || 0 })
      const list = t.kids.get(ppid)
      if (list) list.push(pid)
      else t.kids.set(ppid, [pid])
    }
    return t.alive.size ? t : undefined
  } catch {
    return undefined // can't tell; fall back to updatedAt alone
  }
}

function usageOf(t: ProcTable, root: number): Usage | undefined {
  if (!t.alive.has(root)) return undefined
  const u: Usage = { cpu: 0, rssKb: 0, procs: 0 }
  const seen = new Set<number>()
  const stack = [root]
  while (stack.length) {
    const pid = stack.pop() as number
    if (seen.has(pid)) continue
    seen.add(pid)
    const o = t.own.get(pid)
    if (o) {
      u.cpu += o.cpu
      u.rssKb += o.rssKb
      u.procs++
    }
    for (const k of t.kids.get(pid) ?? []) stack.push(k)
  }
  return u
}

let machineMemKb: number | undefined
async function machineMem($: EngineInterface): Promise<number | undefined> {
  if (machineMemKb !== undefined) return machineMemKb
  try {
    const r = await $.process.run(['sysctl', '-n', 'hw.memsize'], { timeoutMs: 3000 })
    const bytes = Number(r.stdout.trim())
    if (bytes > 0) machineMemKb = bytes / 1024
  } catch {
    // not macOS: leave the scale out
  }
  return machineMemKb
}

// Peak memory per run, for this session (module memory: a reload resets it).
const peaks = new Map<string, number>()

function poll($: EngineInterface): Promise<void> {
  inFlight ??= pollOnce($).finally(() => {
    inFlight = undefined
  })
  return inFlight
}

async function pollOnce($: EngineInterface) {
  {
    const home = await $.env.get('HOME')
    if (!home) return
    const dir = `${home}/.claude/job-status`
    const now = await $.clock.now()
    let entries: { name: string; kind: string; mtimeMs: number }[] = []
    try {
      entries = await $.fs.list(dir)
    } catch {
      entries = []
    }
    const files = entries
      .filter(f => f.kind === 'file' && f.name.endsWith('.json') && !f.name.startsWith('.'))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_RUNS)
    const list: RunView[] = []
    for (const f of files) {
      try {
        list.push(parseRun(f.name, await $.fs.read(`${dir}/${f.name}`), f.mtimeMs))
      } catch {
        // vanished between list and read
      }
    }
    const active = list.filter(r => r.state === 'running')
    const table = active.length ? await procTable($) : undefined
    const memKb = active.length ? await machineMem($) : undefined
    for (const r of active) {
      if (r.pid !== undefined && table && !table.alive.has(r.pid)) {
        r.isStale = true
        r.staleReason = `pid ${r.pid} is gone`
      } else if (now - r.updatedAtMs > STALE_MS) {
        r.isStale = true
        r.staleReason = `no update for ${fmtDur(now - r.updatedAtMs)}`
      }
      if (table && r.pid !== undefined && !r.isStale) {
        const u = usageOf(table, r.pid)
        if (u) {
          r.usage = u
          const peak = Math.max(peaks.get(r.id) ?? 0, u.rssKb)
          peaks.set(r.id, peak)
          r.peakRssKb = peak
        }
        if (memKb !== undefined) r.machineMemKb = memKb
        for (const j of r.running) {
          if (j.pid === undefined) continue
          const ju = usageOf(table, j.pid)
          if (ju) j.usage = ju
        }
      }
    }
    list.sort((a, b) => b.startedAtMs - a.startedAtMs)
    await update($, runs, () => list)
    await update($, nowAtom, () => now)

    // Open the pane on its own once per new live run.
    for (const r of active) {
      if (!r.isStale && !openedFor.has(r.id)) {
        openedFor.add(r.id)
        void $.ui.open({ id: PANE, title: 'Job status' })
      }
    }
  }
}

function fmtMem(kb: number): string {
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`
  if (kb >= 1024) return `${Math.round(kb / 1024)} MB`
  return `${Math.round(kb)} KB`
}

function fmtCpu(pct: number): string {
  return `${Math.round(pct)}%`
}

function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

function textBar(frac: number, width: number): string {
  const w = Math.max(8, width)
  const n = Math.round(Math.min(1, Math.max(0, frac)) * w)
  return '█'.repeat(n) + '░'.repeat(w - n)
}

function memColor(kb: number, machineKb?: number): string {
  if (!machineKb) return 'subtle'
  if (kb > machineKb * 0.75) return 'error'
  if (kb > machineKb * 0.5) return 'warning'
  return 'subtle'
}

const STATUS_COLOR: Record<string, string> = {
  ok: 'success',
  pass: 'success',
  done: 'success',
  skip: 'inactive',
  diff: 'warning',
  fail: 'error',
  failed: 'error',
  error: 'error',
}
const STATE_COLOR: Record<string, string> = {
  running: 'suggestion',
  done: 'success',
  failed: 'error',
  stopped: 'warning',
}
const COUNT_ORDER = ['ok', 'skip', 'diff', 'fail']

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'job-status',
      description: 'Show the live job-status pane (runs in ~/.claude/job-status)',
    })
    void poll($)
    $.clock.every(POLL_MS, () => poll($))
    return started
  })

  on('command.run', { command: 'job-status' }, async $ => {
    await poll($)
    await $.ui.open({ id: PANE, title: 'Job status' })
    const list = await read($, runs)
    const live = list.filter(r => r.state === 'running' && !r.isStale).length
    return { text: `Job status pane opened (${list.length} run(s), ${live} live).` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Progress } = $.ui.resolve(e)
    const list = await read($, runs)
    const now = (await read($, nowAtom)) || Date.now()
    const isShowingOld = await read($, showOld)
    const cols = Math.max(20, e.props.bodyColumns ?? 60)

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No runs in ~/.claude/job-status yet.</Text>
          <Text dimColor>Scripts write status there with status.cjs (see README.md).</Text>
        </Box>
      )
    }

    const isOld = (r: RunView) =>
      r.state !== 'running' && now - (r.endedAtMs ?? r.updatedAtMs) > OLD_MS
    const fresh = list.filter(r => !isOld(r))
    const old = list.filter(isOld)

    const drawRun = (r: RunView, isCompact: boolean) => {
      const done = Object.values(r.counts).reduce((a, n) => a + n, 0)
      const endMs = r.state === 'running' ? (r.isStale ? r.updatedAtMs : now) : (r.endedAtMs ?? r.updatedAtMs)
      const elapsed = endMs - r.startedAtMs
      const stateText = r.isStale ? 'stale' : r.state
      const stateColor = r.isStale ? 'error' : (STATE_COLOR[r.state] ?? 'subtle')
      let eta: string | undefined
      if (r.state === 'running' && !r.isStale && r.total && done > 0 && done < r.total) {
        const timedDone = done - (r.counts.skip ?? 0)
        const rate = elapsed / Math.max(1, timedDone > 2 ? timedDone : done)
        const remaining = r.total - done
        let etaMs = rate * remaining
        if (timedDone <= 2 && r.avgJobMs) etaMs = (r.avgJobMs * remaining) / Math.max(1, r.lanes ?? r.running.length)
        eta = `~${fmtDur(etaMs)}`
      }
      const countKeys = [
        ...COUNT_ORDER,
        ...Object.keys(r.counts).filter(k => !COUNT_ORDER.includes(k)).sort(),
      ].filter(k => k in r.counts || COUNT_ORDER.includes(k))
      const longMs = r.avgJobMs ? Math.max(30_000, r.avgJobMs * 2) : undefined
      const recentRows = isCompact
        ? r.recent.filter(x => x.status !== 'ok' && x.status !== 'skip').slice(-3).reverse()
        : r.recent.slice(-8).reverse()

      return (
        <Box key={`run-${r.id}`} flexDirection="column" marginBottom={1} borderStyle="round" borderColor={stateColor} paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Text bold wrap="truncate-end">{r.title}</Text>
            <Text color={stateColor} bold>{stateText}</Text>
          </Box>
          {r.isStale && r.staleReason && <Text color="error" size="footnote">{r.staleReason}</Text>}
          {r.error && <Text color="error">{r.error}</Text>}
          {r.total && !Progress ? (
            <Text>
              <Text color={r.isStale ? 'inactive' : stateColor}>{textBar(done / r.total, Math.min(40, cols - 22))}</Text>
              {` ${done} / ${r.total} (${Math.floor((done / r.total) * 100)}%)`}
            </Text>
          ) : r.total ? (
            <Progress
              label={r.title}
              value={done}
              max={r.total}
              valueText={`${done} / ${r.total} (${Math.floor((done / r.total) * 100)}%)`}
              color={r.isStale ? 'inactive' : (r.counts.fail ? 'warning' : stateColor)}
            />
          ) : (
            <Text>{done} finished</Text>
          )}
          <Text>
            {countKeys.map((k, i) => (
              <Text color={(r.counts[k] ?? 0) > 0 ? (STATUS_COLOR[k] ?? 'text') : 'inactive'} bold={(k === 'diff' || k === 'fail') && (r.counts[k] ?? 0) > 0}>
                {i > 0 ? '  ' : ''}{k} {r.counts[k] ?? 0}
              </Text>
            ))}
          </Text>
          <Text dimColor>
            {`elapsed ${fmtDur(elapsed)}`}
            {eta ? `  ·  ETA ${eta}` : ''}
            {r.avgJobMs ? `  ·  avg ${fmtDur(r.avgJobMs)}/job` : ''}
            {r.state === 'running' ? `  ·  updated ${fmtDur(now - r.updatedAtMs)} ago` : ''}
          </Text>
          {r.usage && (
            <Text>
              <Text color="subtle">{`CPU ${fmtCpu(r.usage.cpu)}`}</Text>
              <Text color={memColor(r.usage.rssKb, r.machineMemKb)}>
                {`  ·  RAM ${fmtMem(r.usage.rssKb)}`}
                {r.machineMemKb ? ` of ${fmtMem(r.machineMemKb)}` : ''}
              </Text>
              <Text dimColor>
                {r.peakRssKb && r.peakRssKb > r.usage.rssKb ? `  ·  peak ${fmtMem(r.peakRssKb)}` : ''}
                {`  ·  ${r.usage.procs} proc${r.usage.procs === 1 ? '' : 's'}`}
              </Text>
            </Text>
          )}

          {!isCompact && r.state === 'running' && !r.isStale && r.running.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold size="footnote">In flight ({r.running.length})</Text>
              {[...r.running]
                .sort((a, b) => (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0))
                .map(j => {
                  const ran = now - (Date.parse(j.startedAt) || now)
                  const isLong = longMs !== undefined && ran > longMs
                  return (
                    <Box key={`run-${r.id}-job-${j.label}`} flexDirection="row" gap={1}>
                      <Text color={isLong ? 'warning' : 'subtle'} tabular>{fmtDur(ran).padStart(6)}</Text>
                      <Text color={isLong ? 'warning' : undefined} wrap="truncate-middle">
                        {isLong ? '⚠ ' : ''}{j.label}
                      </Text>
                      {j.usage && (
                        <Text dimColor tabular>{`${fmtCpu(j.usage.cpu)} ${fmtMem(j.usage.rssKb)}`}</Text>
                      )}
                    </Box>
                  )
                })}
            </Box>
          )}

          {recentRows.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold size="footnote">{isCompact ? 'Diffs and failures' : 'Recent'}</Text>
              {recentRows.map((x, i) => {
                const isBad = x.status === 'diff' || x.status === 'fail' || x.status === 'error' || x.status === 'failed'
                const color = STATUS_COLOR[x.status] ?? 'text'
                return (
                  <Box key={`run-${r.id}-rec-${i}`} flexDirection="column">
                    <Box flexDirection="row" gap={1}>
                      <Text color={color} bold={isBad}>{x.status.toUpperCase().padEnd(4)}</Text>
                      <Text wrap="truncate-middle" color={isBad ? color : undefined} dimColor={!isBad}>{x.label}</Text>
                    </Box>
                    {x.detail && isBad && (
                      <Text dimColor size="footnote" wrap="truncate-end">{'     '}{x.detail.slice(0, cols * 2)}</Text>
                    )}
                  </Box>
                )
              })}
            </Box>
          )}

          {!isCompact && r.notes.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {r.notes.slice(-3).map(n => (
                <Text dimColor size="footnote" wrap="truncate-end">{n}</Text>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {fresh.map(r => drawRun(r, r.state !== 'running'))}
        {fresh.length === 0 && <Text dimColor>No live or recent runs.</Text>}
        {old.length > 0 && (
          <Box flexDirection="column">
            <Button key="toggle-old" plain onPress={() => update($, showOld, v => !v)}>
              {isShowingOld ? '▾' : '▸'} {old.length} finished run(s) older than a day
            </Button>
            {isShowingOld && old.map(r => drawRun(r, true))}
          </Box>
        )}
      </Box>
    )
  })
}
