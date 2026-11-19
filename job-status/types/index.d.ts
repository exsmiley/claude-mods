export type RecentRow = { label: string; status: string; detail?: string; at: string; ms?: number }
/** Usage of a process and everything under it, from one `ps` sample. */
export type Usage = { cpu: number; rssKb: number; procs: number }
/** What else belongs to a run, beyond its own process tree. */
export type Watch = {
  /** container-name patterns; `*` is a wildcard, a pattern without one matches as a substring */
  docker?: string[]
  /** more process roots, each counted with everything under it */
  pids?: number[]
  /** processes whose executable path contains one of these, with everything under them */
  names?: string[]
}
export type DockerUsage = { cpu: number; rssKb: number; count: number }
/** The whole machine, sampled each poll while a run is live. */
export type Machine = {
  cpu: number
  cores: number
  usedKb?: number
  totalKb?: number
  docker?: DockerUsage
  isDockerUnavailable?: boolean
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
  /** pid gone or updatedAt too old while the file still says running */
  isStale: boolean
  /** the run's pid and all its descendants, sampled each poll */
  usage?: Usage
  watch?: Watch
  /** containers matching watch.docker */
  dockerUsage?: DockerUsage
  /** highest rssKb seen this session */
  peakRssKb?: number
  /** the machine's memory, for scale */
  machineMemKb?: number
  staleReason?: string
  error?: string
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
