/**
 * One workflow run, as the fetch script prints it.
 * w workflow, u who triggered it, e event, c conclusion, a attempt,
 * t created (ISO, UTC), h local hour, wd local weekday (0 Monday),
 * m billable minutes, j jobs, s job seconds, r run span seconds.
 */
export type Run = {
  w: string
  u: string
  e: string
  c: string
  a: number
  t: string
  h: number
  wd: number
  m: number
  j: number
  s: number
  r: number
}

export type UserRow = {
  login: string
  isBot: boolean
  runs: number
  minutes: number
  failures: number
  cancelled: number
  reruns: number
  night: number
  weekend: number
  topWorkflow: string
}

export type WorkflowRow = { name: string; runs: number; minutes: number; failures: number; avgMinutes: number }

export type Award = { emoji: string; title: string; winner: string; detail: string }

export type Report = {
  repo: string
  month: string
  today: string
  fetchedAt: number
  totals: {
    runs: number
    minutes: number
    jobs: number
    computeHours: number
    success: number
    failures: number
    cancelled: number
    reruns: number
    daysElapsed: number
    daysInMonth: number
    projected: number
  }
  users: UserRow[]
  workflows: WorkflowRow[]
  events: Array<{ name: string; runs: number; minutes: number }>
  byDay: Array<{ day: string; value: number }>
  hours: number[]
  awards: Award[]
  capped: string[]
}

/** What the pane draws: the report once read, and how the read is going. */
export type View = {
  report: Report | null
  repo: string
  month: string
  status: 'idle' | 'loading' | 'error'
  message?: string
  blurb?: string
}

declare module 'claude-code' {
  interface PluginState {
    'actions-report': {
      view: Shaped<View>
    }
  }
}
