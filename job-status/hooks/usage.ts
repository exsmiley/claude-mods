import type { EngineInterface } from 'claude-code'

import type { AppUsage, DockerUsage, RunView, Usage } from '../types'

// What a run uses, found without the run declaring anything:
//   1. its pid's process tree and process group,
//   2. processes whose command line names one of the run's folders (detached
//      workers whose parent is gone still name the script or dir they run),
//   3. whatever those connect to on localhost, followed up to 3 hops (a dev
//      server, a database), and Docker containers publishing those ports,
//      with the rest of each container's Docker network.
// Docker is charged at host cost: the Docker VM's own CPU and RAM, split by
// each container's share of what `docker stats` sees inside it.

export type Proc = { ppid: number; pgid: number; cpu: number; rssKb: number; comm: string; cmd: string }
export type ProcTable = { procs: Map<number, Proc>; kids: Map<number, number[]>; cpuAll: number }

export async function procTable($: EngineInterface): Promise<ProcTable | undefined> {
  try {
    const [a, b] = await Promise.all([
      $.process.run(['ps', '-A', '-o', 'pid=,ppid=,pgid=,pcpu=,rss=,comm='], { timeoutMs: 5000 }),
      $.process.run(['ps', '-A', '-o', 'pid=,command='], { timeoutMs: 5000 }),
    ])
    const cmds = new Map<number, string>()
    for (const line of b.stdout.split('\n')) {
      const m = /^\s*(\d+)\s(.*)$/.exec(line)
      if (m) cmds.set(Number(m[1]), (m[2] ?? '').trim())
    }
    const t: ProcTable = { procs: new Map(), kids: new Map(), cpuAll: 0 }
    for (const line of a.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s*(.*)$/.exec(line)
      if (!m) continue
      const pid = Number(m[1])
      const ppid = Number(m[2])
      const cpu = Number(m[4]) || 0
      const comm = m[6] ?? ''
      t.procs.set(pid, { ppid, pgid: Number(m[3]), cpu, rssKb: Number(m[5]) || 0, comm, cmd: cmds.get(pid) ?? comm })
      t.cpuAll += cpu
      const list = t.kids.get(ppid)
      if (list) list.push(pid)
      else t.kids.set(ppid, [pid])
    }
    return t.procs.size ? t : undefined
  } catch {
    return undefined
  }
}

export function treeOf(t: ProcTable, roots: Iterable<number>, into = new Set<number>()): Set<number> {
  const stack = [...roots].filter(p => t.procs.has(p))
  while (stack.length) {
    const pid = stack.pop() as number
    if (into.has(pid)) continue
    into.add(pid)
    for (const k of t.kids.get(pid) ?? []) stack.push(k)
  }
  return into
}

export function usageOf(t: ProcTable, pids: Iterable<number>): Usage {
  const u: Usage = { cpu: 0, rssKb: 0, procs: 0 }
  for (const pid of pids) {
    const p = t.procs.get(pid)
    if (!p) continue
    u.cpu += p.cpu
    u.rssKb += p.rssKb
    u.procs++
  }
  return u
}

// ---------------------------------------------------------------- machine

let memKb: number | undefined
export async function machineMem($: EngineInterface): Promise<number | undefined> {
  if (memKb !== undefined) return memKb
  try {
    const r = await $.process.run(['sysctl', '-n', 'hw.memsize'], { timeoutMs: 3000 })
    const bytes = Number(r.stdout.trim())
    if (bytes > 0) memKb = bytes / 1024
  } catch {
    // not macOS; usedMem fills it from /proc/meminfo
  }
  return memKb
}

let cores: number | undefined
export async function cpuCores($: EngineInterface): Promise<number> {
  if (cores !== undefined) return cores
  for (const argv of [['sysctl', '-n', 'hw.ncpu'], ['nproc']]) {
    try {
      const r = await $.process.run(argv, { timeoutMs: 3000 })
      const n = Number(r.stdout.trim())
      if (n > 0) return (cores = n)
    } catch {
      // try the next
    }
  }
  return (cores = 1)
}

// Memory in use: macOS vm_stat (active + wired + compressed), else Linux
// /proc/meminfo (total - available).
export async function usedMem($: EngineInterface): Promise<number | undefined> {
  try {
    const r = await $.process.run(['vm_stat'], { timeoutMs: 3000 })
    const page = Number(/page size of (\d+) bytes/.exec(r.stdout)?.[1] ?? 0)
    const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(r.stdout)?.[1] ?? 0)
    if (page > 0) {
      return ((pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor')) * page) / 1024
    }
  } catch {
    // not macOS
  }
  try {
    const text = await $.fs.read('/proc/meminfo')
    const kb = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(text)?.[1] ?? 0)
    const total = kb('MemTotal')
    if (total > 0) {
      memKb ??= total
      return total - kb('MemAvailable')
    }
  } catch {
    // no meminfo
  }
  return undefined
}

const DOCKER_VM = /Virtualization\.VirtualMachine|com\.docker\.(hyperkit|virtualization|krun)|qemu-system|vfkit/

export function dockerVmUsage(t: ProcTable): Usage | undefined {
  const pids = [...t.procs].filter(([, p]) => DOCKER_VM.test(p.comm)).map(([pid]) => pid)
  return pids.length ? usageOf(t, treeOf(t, pids)) : undefined
}

function appName(comm: string): string {
  if (DOCKER_VM.test(comm)) return 'Docker VM'
  const app = /\/([^/]+)\.app\//.exec(comm)
  if (app?.[1]) return app[1]
  return comm.split('/').pop() || comm
}

/** The machine's biggest consumers, grouped by app or executable. */
export function topApps(t: ProcTable, n = 6): AppUsage[] {
  const by = new Map<string, AppUsage>()
  for (const p of t.procs.values()) {
    const name = appName(p.comm)
    const a = by.get(name) ?? { name, cpu: 0, rssKb: 0, procs: 0 }
    a.cpu += p.cpu
    a.rssKb += p.rssKb
    a.procs++
    by.set(name, a)
  }
  return [...by.values()]
    .sort((a, b) => b.cpu + b.rssKb / 1e6 - (a.cpu + a.rssKb / 1e6))
    .slice(0, n)
}

// ----------------------------------------------------------------- docker

export type DockerRow = { name: string; cpu: number; rssKb: number; hostPorts: number[]; networks: string[] }
const DOCKER_EVERY_MS = 10_000
const DOCKER_RETRY_MS = 60_000
let rows: DockerRow[] | undefined
let rowsAt = 0
let isDown = false
let dockerInFlight: Promise<void> | undefined

export const docker = {
  rows: () => rows,
  isDown: () => isDown,
}

function memToKb(text: string): number {
  const m = /([\d.]+)\s*([KMGT]?i?B)/i.exec(text)
  if (!m) return 0
  const unit = (m[2] ?? 'B').toUpperCase()
  const pow: Record<string, number> = { B: 0, KB: 1, KIB: 1, MB: 2, MIB: 2, GB: 3, GIB: 3, TB: 4, TIB: 4 }
  return ((Number(m[1]) || 0) * (unit.includes('I') ? 1024 : 1000) ** (pow[unit] ?? 0)) / 1024
}

const jsonLines = (text: string): Record<string, string>[] =>
  text.split('\n').flatMap(line => {
    if (!line.trim()) return []
    try {
      return [JSON.parse(line) as Record<string, string>]
    } catch {
      return []
    }
  })

// `docker stats` takes ~2 s, so it runs on its own cadence; polls read the
// last sample.
export function refreshDocker($: EngineInterface, now: number): void {
  if (dockerInFlight || now - rowsAt < (isDown ? DOCKER_RETRY_MS : DOCKER_EVERY_MS)) return
  dockerInFlight = (async () => {
    try {
      const [stats, ps] = await Promise.all([
        $.process.run(['docker', 'stats', '--no-stream', '--format', '{{json .}}'], { timeoutMs: 15000 }),
        $.process.run(['docker', 'ps', '--format', '{{json .}}'], { timeoutMs: 10000 }),
      ])
      if (stats.exitCode !== 0) throw new Error('docker stats failed')
      const meta = new Map<string, { hostPorts: number[]; networks: string[] }>()
      for (const o of jsonLines(ps.stdout)) {
        meta.set(String(o.Names ?? ''), {
          hostPorts: [...new Set([...String(o.Ports ?? '').matchAll(/:(\d+)->/g)].map(m => Number(m[1])))],
          networks: String(o.Networks ?? '').split(',').map(n => n.trim()).filter(Boolean),
        })
      }
      rows = jsonLines(stats.stdout).map(o => {
        const name = String(o.Name ?? '')
        return {
          name,
          cpu: Number(String(o.CPUPerc ?? '0').replace('%', '')) || 0,
          rssKb: memToKb(String(o.MemUsage ?? '').split('/')[0] ?? ''),
          hostPorts: meta.get(name)?.hostPorts ?? [],
          networks: meta.get(name)?.networks ?? [],
        }
      })
      isDown = false
    } catch {
      rows = undefined
      isDown = true
    } finally {
      rowsAt = await $.clock.now()
      dockerInFlight = undefined
    }
  })()
}

/** Containers' usage at host cost: their share of the Docker VM, when it is seen. */
export function dockerCost(all: DockerRow[], picked: DockerRow[], vm: Usage | undefined): DockerUsage {
  const sum = (list: DockerRow[], k: 'cpu' | 'rssKb') => list.reduce((a, r) => a + r[k], 0)
  const inside = { cpu: sum(picked, 'cpu'), rssKb: sum(picked, 'rssKb') }
  const u: DockerUsage = { ...inside, count: picked.length, insideCpu: inside.cpu, insideRssKb: inside.rssKb }
  if (vm && all.length) {
    const allCpu = sum(all, 'cpu')
    const allMem = sum(all, 'rssKb')
    u.cpu = vm.cpu * (allCpu > 0 ? inside.cpu / allCpu : picked.length / all.length)
    u.rssKb = vm.rssKb * (allMem > 0 ? inside.rssKb / allMem : picked.length / all.length)
    u.isHostCost = true
  }
  return u
}

// ----------------------------------------------------------- attribution

const LINK_EVERY_MS = 10_000
const SHARED_NETWORKS = new Set(['bridge', 'host', 'none'])
// Never pull these in through a connection: the Claude apps, Docker's own
// port forwarder, launchd.
const NEVER_LINK = /[Cc]laude(\.app| Helper)|\/claude$|com\.docker\.|vpnkit|docker-proxy|^\/sbin\/launchd$/

type Link = { pids: Set<number>; ports: Set<number>; containers: Set<string>; networks: Set<string>; at: number; sawDocker: boolean }
const links = new Map<string, Link>()

const BROAD = /^(\/|\/Users|\/home|\/tmp|\/private|\/private\/tmp|\/var|\/private\/var|\/opt|\/usr|\/Applications|\/Volumes)\/?$/

/** Folders specific enough that a command line naming one belongs to the run. */
export function specificDirs(dirs: string[], home: string | undefined): string[] {
  return [...new Set(dirs)]
    .map(d => d.replace(/\/+$/, ''))
    .filter(d => d.startsWith('/') && !BROAD.test(d) && d !== home && d.split('/').filter(Boolean).length >= 3)
}

async function loopbackPorts($: EngineInterface, pids: number[]): Promise<Set<number>> {
  const ports = new Set<number>()
  if (pids.length === 0) return ports
  try {
    const r = await $.process.run(
      ['lsof', '-a', '-nP', '-iTCP', '-sTCP:ESTABLISHED', '-p', pids.slice(0, 1000).join(',')],
      { timeoutMs: 5000 },
    )
    for (const m of r.stdout.matchAll(/->(\[[^\]]+\]|[^\s:]+):(\d+)/g)) {
      if (/^(127\.|\[::1\]|\[::ffff:127\.|localhost|0\.0\.0\.0|\[::\])/.test(m[1] ?? '')) ports.add(Number(m[2]))
    }
  } catch {
    // no lsof
  }
  return ports
}

async function listeners($: EngineInterface): Promise<Map<number, number>> {
  const byPort = new Map<number, number>()
  try {
    const r = await $.process.run(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN'], { timeoutMs: 5000 })
    for (const line of r.stdout.split('\n')) {
      const m = /^\S+\s+(\d+)\s.*:(\d+)\s+\(LISTEN\)/.exec(line)
      if (m && !byPort.has(Number(m[2]))) byPort.set(Number(m[2]), Number(m[1]))
    }
  } catch {
    // no lsof
  }
  return byPort
}

export type Attribution = {
  usage: Usage
  docker?: DockerUsage
  /** what was counted, for the pane to say */
  sources: string[]
}

export async function attribute(
  $: EngineInterface,
  t: ProcTable,
  r: RunView,
  home: string | undefined,
  now: number,
  vm: Usage | undefined,
): Promise<Attribution> {
  const sources: string[] = []
  const base = new Set<number>()
  if (r.pid !== undefined && t.procs.has(r.pid)) {
    treeOf(t, [r.pid], base)
    const pgid = t.procs.get(r.pid)?.pgid ?? 0
    if (pgid > 1) {
      const group = [...t.procs].filter(([, p]) => p.pgid === pgid).map(([pid]) => pid)
      if (group.length < 2000) treeOf(t, group, base)
    }
  }
  if (r.watch?.pids?.length) treeOf(t, r.watch.pids, base)
  const fromTree = base.size

  const dirs = specificDirs([...(r.dirs ?? []), ...(r.cwd ? [r.cwd] : []), ...(r.logFile ? [r.logFile.replace(/\/[^/]*$/, '')] : [])], home)
  const names = r.watch?.names ?? []
  if (dirs.length || names.length) {
    const hits: number[] = []
    for (const [pid, p] of t.procs) {
      if (base.has(pid) || NEVER_LINK.test(p.comm)) continue
      if (dirs.some(d => p.cmd.includes(d + '/') || p.cmd.endsWith(d) || p.cmd.includes(d + ' ')) || names.some(n => p.comm.includes(n))) {
        hits.push(pid)
      }
    }
    const before = base.size
    treeOf(t, hits, base)
    if (base.size > before) sources.push(`${base.size - before} by folder or name`)
  }
  if (fromTree) sources.unshift(`${fromTree} in its process tree`)

  // Connections: sticky per run, refreshed every LINK_EVERY_MS.
  let link = links.get(r.id)
  if (!link) {
    link = { pids: new Set(), ports: new Set(), containers: new Set(), networks: new Set(), at: 0, sawDocker: false }
    links.set(r.id, link)
  }
  const rows = docker.rows()
  // Look again on the cadence, and as soon as Docker's first sample lands.
  if (now - link.at >= LINK_EVERY_MS || (rows !== undefined && !link.sawDocker)) {
    link.at = now
    link.sawDocker = rows !== undefined
    const published = new Map<number, DockerRow>()
    for (const row of rows ?? []) for (const port of row.hostPorts) published.set(port, row)
    const listen = await listeners($)
    let frontier = [...base, ...link.pids]
    for (let hop = 0; hop < 3 && frontier.length; hop++) {
      const ports = await loopbackPorts($, frontier)
      const added: number[] = []
      for (const port of ports) {
        const row = published.get(port)
        if (row) {
          link.containers.add(row.name)
          for (const n of row.networks) if (!SHARED_NETWORKS.has(n)) link.networks.add(n)
          continue
        }
        const owner = listen.get(port)
        const p = owner === undefined ? undefined : t.procs.get(owner)
        if (owner === undefined || !p || owner <= 1 || NEVER_LINK.test(p.comm)) continue
        if (base.has(owner) || link.pids.has(owner)) continue
        link.pids.add(owner)
        link.ports.add(port)
        added.push(owner)
      }
      frontier = [...treeOf(t, added)]
    }
  }
  for (const pid of [...link.pids]) if (!t.procs.has(pid)) link.pids.delete(pid)
  const before = base.size
  treeOf(t, link.pids, base)
  if (base.size > before) {
    sources.push(`${base.size - before} it connects to (localhost:${[...link.ports].sort((a, b) => a - b).slice(0, 4).join(', :')})`)
  }

  const out: Attribution = { usage: usageOf(t, base), sources }
  if (rows) {
    const picked = rows.filter(
      row =>
        link.containers.has(row.name) ||
        row.networks.some(n => link.networks.has(n)) ||
        (r.watch?.docker ?? []).some(pattern => globToRegExp(pattern).test(row.name)),
    )
    if (picked.length) {
      out.docker = dockerCost(rows, picked, vm)
      const nets = [...link.networks].sort()
      sources.push(`${picked.length} container${picked.length === 1 ? '' : 's'}${nets.length ? ` (${nets.join(', ')})` : ''}`)
    }
  }
  return out
}

export function globToRegExp(pattern: string): RegExp {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return pattern.includes('*') ? new RegExp(`^${esc}$`) : new RegExp(esc)
}
