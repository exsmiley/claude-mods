import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface } from 'claude-code'

import type { RunView, RecentRow, RunningRow, Watch, Machine } from '../types'
import {
  attribute,
  cpuCores,
  docker,
  dockerCost,
  dockerVmUsage,
  machineMem,
  procTable,
  refreshDocker,
  topApps,
  treeOf,
  usageOf,
  usedMem,
} from './usage'

// Live pane for long-running job runs. Any script writes one JSON file per
// run to ~/.claude/job-status/<id>.json (protocol: README.md there); this mod
// polls the folder every few seconds and draws every run, newest first.

const PANE = 'job-status'
const POLL_MS = 2500
const STALE_MS = 90_000 // no write for this long while "running" → stale
const OLD_MS = 24 * 3600_000 // finished runs older than this are collapsed
const MAX_RUNS = 30

const runs = atom({ plugin: 'job-status', key: 'runs' } as const, [] as RunView[], {
  shape: 'runs-2',
})
const nowAtom = atom({ plugin: 'job-status', key: 'now' } as const, 0)
const showOld = atom({ plugin: 'job-status', key: 'showOld' } as const, false)
const machineAtom = atom({ plugin: 'job-status', key: 'machine' } as const, null as Machine | null, {
  shape: 'machine-2',
})

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
  if (typeof o.cwd === 'string' && o.cwd) view.cwd = o.cwd
  if (typeof o.logFile === 'string' && o.logFile) view.logFile = o.logFile
  if (Array.isArray(o.dirs)) {
    const dirs = o.dirs.filter(d => typeof d === 'string' && d).map(String).slice(0, 20)
    if (dirs.length) view.dirs = dirs
  }
  if (o.watch && typeof o.watch === 'object') {
    const w = o.watch as Record<string, unknown>
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x).map(String).slice(0, 50) : [])
    const watch: Watch = {}
    const docker = strs(w.docker)
    if (docker.length) watch.docker = docker
    const pids = Array.isArray(w.pids) ? w.pids.map(Number).filter(n => Number.isFinite(n) && n > 0).slice(0, 50) : []
    if (pids.length) watch.pids = pids
    const names = strs(w.names)
    if (names.length) watch.names = names
    if (watch.docker || watch.pids || watch.names) view.watch = watch
  }
  return view
}

// Peak memory per run, for this session (module memory: a reload resets it).
const peaks = new Map<string, number>()

// Which pids have written each run id lately. Two live writers on one id
// (an old run's process still alive beside a restarted one) make the pane
// flip between them every poll, so it says so.
const WRITER_WINDOW_MS = 120_000
const writers = new Map<string, Map<number, { at: number; startedAtMs: number }>>()

function noteWriter(r: RunView, now: number) {
  if (r.pid === undefined) return
  const seen = writers.get(r.id) ?? new Map<number, { at: number; startedAtMs: number }>()
  seen.set(r.pid, { at: now, startedAtMs: r.startedAtMs })
  for (const [pid, w] of seen) if (now - w.at > WRITER_WINDOW_MS) seen.delete(pid)
  writers.set(r.id, seen)
}

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
    if (active.length) refreshDocker($, now)
    const vm = table ? dockerVmUsage(table) : undefined
    for (const r of active) {
      if (r.pid !== undefined && table && !table.procs.has(r.pid)) {
        r.isStale = true
        r.staleReason = `pid ${r.pid} is gone`
      } else if (now - r.updatedAtMs > STALE_MS) {
        r.isStale = true
        r.staleReason = `no update for ${fmtDur(now - r.updatedAtMs)}`
      }
      noteWriter(r, now)
      const others = [...(writers.get(r.id) ?? new Map<number, { at: number; startedAtMs: number }>())]
        .filter(([pid]) => pid !== r.pid && table?.procs.has(pid))
      if (others.length) {
        // Name the older one: that's the process to stop.
        const all = [[r.pid, r.startedAtMs] as const, ...others.map(([pid, w]) => [pid, w.startedAtMs] as const)]
        const oldest = [...all].sort((a, b) => a[1] - b[1])[0]
        r.writerConflict = `${all.length} live processes write this file (pids ${all.map(a => a[0]).join(', ')}); its numbers flip between them. Stop the older one (pid ${oldest?.[0]}).`
      }
      if (!table || r.isStale) continue
      const found = await attribute($, table, r, home, now, vm)
      if (found.usage.procs > 0 || found.docker) {
        r.usage = found.usage
        if (found.docker) r.dockerUsage = found.docker
        r.sources = found.sources
        const total = found.usage.rssKb + (found.docker?.rssKb ?? 0)
        const peak = Math.max(peaks.get(r.id) ?? 0, total)
        peaks.set(r.id, peak)
        r.peakRssKb = peak
      }
      if (memKb !== undefined) r.machineMemKb = memKb
      for (const j of r.running) {
        if (j.pid === undefined || !table.procs.has(j.pid)) continue
        j.usage = usageOf(table, treeOf(table, [j.pid]))
      }
    }
    let machine: Machine | null = null
    if (table && active.some(r => !r.isStale)) {
      machine = { cpu: table.cpuAll, cores: await cpuCores($), apps: topApps(table) }
      const used = await usedMem($)
      if (used !== undefined) machine.usedKb = used
      const total = memKb ?? (await machineMem($))
      if (total !== undefined) machine.totalKb = total
      const rows = docker.rows()
      if (rows?.length) machine.docker = dockerCost(rows, rows, vm)
      if (vm) machine.dockerVm = vm
      if (docker.isDown()) machine.isDockerUnavailable = true
    }
    list.sort((a, b) => b.startedAtMs - a.startedAtMs)
    await update($, runs, () => list)
    await update($, nowAtom, () => now)
    await update($, machineAtom, () => machine)

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
    const machine = await read($, machineAtom)
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
          {r.writerConflict && <Text color="warning" size="footnote">{`⚠ ${r.writerConflict}`}</Text>}
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
            <Box flexDirection="column">
              <Text color="subtle">
                {`${r.dockerUsage ? 'Procs  ' : ''}CPU ${fmtCpu(r.usage.cpu)}  ·  RAM ${fmtMem(r.usage.rssKb)}  ·  ${r.usage.procs} proc${r.usage.procs === 1 ? '' : 's'}`}
              </Text>
              {r.dockerUsage && (
                <Text color="subtle">
                  {`Docker CPU ${fmtCpu(r.dockerUsage.cpu)}  ·  RAM ${fmtMem(r.dockerUsage.rssKb)}  ·  ${r.dockerUsage.count} container${r.dockerUsage.count === 1 ? '' : 's'}`}
                  {r.dockerUsage.isHostCost ? '  (share of Docker VM)' : ''}
                </Text>
              )}
              <Text>
                <Text bold={!!r.dockerUsage}>
                  {r.dockerUsage ? `Total  CPU ${fmtCpu(r.usage.cpu + r.dockerUsage.cpu)}  ·  ` : ''}
                </Text>
                <Text bold={!!r.dockerUsage} color={memColor(r.usage.rssKb + (r.dockerUsage?.rssKb ?? 0), r.machineMemKb)}>
                  {r.dockerUsage ? `RAM ${fmtMem(r.usage.rssKb + r.dockerUsage.rssKb)}` : ''}
                  {r.dockerUsage && r.machineMemKb ? ` of ${fmtMem(r.machineMemKb)}` : ''}
                </Text>
                <Text dimColor>
                  {r.peakRssKb ? `${r.dockerUsage ? '  ·  ' : ''}peak ${fmtMem(r.peakRssKb)}` : ''}
                </Text>
              </Text>
              {!isCompact && r.sources && r.sources.length > 0 && (
                <Text dimColor size="footnote" wrap="truncate-end">{`counted: ${r.sources.join('; ')}`}</Text>
              )}
            </Box>
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
        {machine && (
          <Box flexDirection="column" marginBottom={1}>
            <Text dimColor>
              {`Machine  CPU ${Math.round(machine.cpu / Math.max(1, machine.cores))}% of ${machine.cores} cores`}
              {machine.usedKb !== undefined ? `  ·  RAM ${fmtMem(machine.usedKb)}${machine.totalKb ? ` of ${fmtMem(machine.totalKb)}` : ''} used` : ''}
            </Text>
            {machine.docker && machine.docker.count > 0 && (
              <Text dimColor>
                {`Docker   ${machine.docker.count} containers  ·  inside CPU ${fmtCpu(machine.docker.insideCpu)}, RAM ${fmtMem(machine.docker.insideRssKb)}`}
                {machine.dockerVm ? `  ·  VM CPU ${fmtCpu(machine.dockerVm.cpu)}, RAM ${fmtMem(machine.dockerVm.rssKb)}` : ''}
              </Text>
            )}
            {(machine.apps ?? []).map(a => (
              <Box key={`app-${a.name}`} flexDirection="row" gap={1}>
                <Text dimColor tabular>{fmtCpu(a.cpu).padStart(5)}</Text>
                <Text dimColor tabular>{fmtMem(a.rssKb).padStart(7)}</Text>
                <Text dimColor wrap="truncate-end">{`${a.name}${a.procs > 1 ? ` (${a.procs})` : ''}`}</Text>
              </Box>
            ))}
          </Box>
        )}
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
