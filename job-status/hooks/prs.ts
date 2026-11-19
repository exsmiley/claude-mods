import type { EngineInterface } from 'claude-code'
import type { PrInfo, RunView } from '../types'

// Finished runs whose branch's pull request is merged or closed leave the pane.
// `gh` answers, run in the run's checkout; it only reads.

const CHECK_EVERY_MS = 5 * 60_000
const RETRY_MS = 60_000
const MAX_PER_ROUND = 5
/** branches that are never one PR's own */
const BASE_BRANCHES = new Set(['main', 'master', 'develop', 'trunk', 'HEAD'])

const cache = new Map<string, { at: number; pr?: PrInfo; isError?: boolean }>()
let inFlight: Promise<void> | undefined

/** What identifies a run's PR, or undefined when it has none to look up. */
export function prKey(r: RunView): string | undefined {
  if (r.pr) return `pr\n${r.git?.root ?? r.cwd ?? ''}\n${r.pr}`
  if (r.git?.root && r.git.branch && !BASE_BRANCHES.has(r.git.branch)) return `branch\n${r.git.root}\n${r.git.branch}`
  return undefined
}

/** The PR last seen for a run, if it has been looked up. */
export function prFor(r: RunView): PrInfo | undefined {
  const k = prKey(r)
  return k ? cache.get(k)?.pr : undefined
}

export function isPrDone(pr: PrInfo | undefined): boolean {
  return pr?.state === 'MERGED' || pr?.state === 'CLOSED'
}

type GhPr = { state?: string; number?: number; url?: string }

function pick(prs: GhPr[]): PrInfo {
  // An open PR wins: the branch is still being worked on.
  const by = (s: string) => prs.find(p => String(p.state).toUpperCase() === s)
  const p = by('OPEN') ?? by('MERGED') ?? by('CLOSED')
  if (!p) return { state: 'NONE' }
  const out: PrInfo = { state: String(p.state).toUpperCase() as PrInfo['state'] }
  if (typeof p.number === 'number') out.number = p.number
  if (typeof p.url === 'string') out.url = p.url
  return out
}

async function lookUp($: EngineInterface, r: RunView): Promise<PrInfo | undefined> {
  const cwd = r.git?.root ?? r.cwd
  const argv = r.pr
    ? ['gh', 'pr', 'view', r.pr, '--json', 'state,number,url']
    : ['gh', 'pr', 'list', '--head', r.git!.branch!, '--state', 'all', '--json', 'state,number,url', '--limit', '10']
  const res = await $.process.run(argv, { timeoutMs: 15_000, ...(cwd ? { cwd } : {}) })
  if (res.exitCode !== 0) return undefined
  const data = JSON.parse(res.stdout) as GhPr | GhPr[]
  return pick(Array.isArray(data) ? data : [data])
}

/** Look up, in the background, the PRs of finished runs not checked lately. */
export function refreshPrs($: EngineInterface, list: RunView[], now: number): void {
  if (inFlight) return
  const due = new Map<string, RunView>()
  for (const r of list) {
    const k = prKey(r)
    if (!k || due.has(k)) continue
    const c = cache.get(k)
    if (!c || now - c.at > (c.isError ? RETRY_MS : CHECK_EVERY_MS)) due.set(k, r)
  }
  if (!due.size) return
  inFlight = (async () => {
    for (const [k, r] of [...due].slice(0, MAX_PER_ROUND)) {
      let pr: PrInfo | undefined
      try {
        pr = await lookUp($, r)
      } catch {
        pr = undefined
      }
      cache.set(k, pr ? { at: now, pr } : { at: now, isError: true })
    }
  })()
    .catch(() => {})
    .finally(() => {
      inFlight = undefined
    })
}
