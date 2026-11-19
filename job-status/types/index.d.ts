export type RecentRow = { label: string; status: string; detail?: string; at: string; ms?: number }
/** Usage of a set of processes, from one `ps` sample. */
export type Usage = { cpu: number; rssKb: number; procs: number }
/** Optional extras a run can name; everything it connects to is found on its own. */
export type Watch = {
  /** containers to count even if the run never connects to them; `*` wildcard, else substring */
  docker?: string[]
  /** more process roots, each counted with everything under it */
  pids?: number[]
  /** processes whose executable path contains one of these */
  names?: string[]
}
export type DockerUsage = {
  /** host cost when the Docker VM is seen (its share of the VM), else what docker stats sees */
  cpu: number
  rssKb: number
  count: number
  /** what docker stats sees inside the VM */
  insideCpu: number
  insideRssKb: number
  isHostCost?: boolean
}
export type AppUsage = { name: string; cpu: number; rssKb: number; procs: number }
/** The whole machine, sampled each poll while a run is live. */
export type Machine = {
  cpu: number
  cores: number
  usedKb?: number
  totalKb?: number
  /** every container, at host cost */
  docker?: DockerUsage
  dockerVm?: Usage
  isDockerUnavailable?: boolean
  apps?: AppUsage[]
}
export type RunningRow = { label: string; startedAt: string; pid?: number; usage?: Usage }

/** One run as the pane draws it: the file's fields plus what the poll found. */
export type RunView = {
  id: string
  title: string
  state: string
  startedAtMs: number
  updatedAtMs: number
  endedAtMs?: number
  total?: number
  counts: Record<string, number>
  running: RunningRow[]
  recent: RecentRow[]
  notes: string[]
  pid?: number
  lanes?: number
  avgJobMs?: number
  cwd?: string
  logFile?: string
  /** folders whose processes belong to the run (helper: cwd and the script's folder) */
  dirs?: string[]
  watch?: Watch
  /** pid gone or updatedAt too old while the file still says running */
  isStale: boolean
  staleReason?: string
  /** set when more than one live process has written this id lately */
  writerConflict?: string
  error?: string
  /** the run's processes: tree, group, folders, and what they connect to */
  usage?: Usage
  /** containers it uses, at host cost */
  dockerUsage?: DockerUsage
  /** what was counted, in words */
  sources?: string[]
  /** highest RAM (processes + Docker) seen this session */
  peakRssKb?: number
  /** the machine's memory, for scale */
  machineMemKb?: number
}

declare module 'claude-code' {
  interface PluginState {
    'job-status': {
      runs: Shaped<RunView[]>
      now: number
      showOld: boolean
      machine: Shaped<Machine | null>
    }
  }
}
