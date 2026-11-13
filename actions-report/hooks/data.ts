import type { Award, Report, Run, UserRow, WorkflowRow } from '../types'

/**
 * Prints a repo's workflow runs for the given UTC days through `gh`, each with
 * its billable minutes: every job's time rounded up to the minute (as GitHub
 * bills), times the runner's multiplier (Linux 1, Windows 2, macOS 10,
 * self-hosted 0). argv: owner/repo, comma-separated YYYY-MM-DD days.
 */
export const FETCH_SCRIPT = String.raw`
import json, subprocess, sys, datetime, math
from concurrent.futures import ThreadPoolExecutor
repo, days = sys.argv[1], [d for d in sys.argv[2].split(',') if d]
def call(args):
    p = subprocess.run(['gh', 'api'] + args, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError((p.stderr.strip().splitlines() or ['gh api failed'])[-1])
    return json.loads(p.stdout)
def ts(stamp):
    return datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00')) if stamp else None
capped = []
def day_runs(day):
    runs, page = [], 1
    while True:
        got = call([f'repos/{repo}/actions/runs?created={day}&per_page=100&page={page}'])['workflow_runs']
        runs.extend(got)
        if len(got) < 100: return runs
        page += 1
        if page > 10:
            capped.append(day); return runs
pool = ThreadPoolExecutor(8)
by_day = dict(zip(days, pool.map(day_runs, days)))
runs = [r for d in days for r in by_day[d]]
Q = 'query($ids:[ID!]!){nodes(ids:$ids){... on WorkflowRun{databaseId checkSuite{checkRuns(first:100){nodes{name startedAt completedAt conclusion}}}}}}'
def batch(ids):
    args = ['graphql', '-f', 'query=' + Q] + [a for x in ids for a in ('-f', 'ids[]=' + x)]
    return (call(args).get('data') or {}).get('nodes') or []
checks = {}
for nodes in pool.map(batch, [[r['node_id'] for r in runs[i:i + 50]] for i in range(0, len(runs), 50)]):
    for node in nodes:
        if node and node.get('checkSuite'):
            checks[node['databaseId']] = node['checkSuite']['checkRuns']['nodes']
samples = {}
for r in runs: samples.setdefault(r['workflow_id'], r['id'])
def jobs(item):
    wid, rid = item
    try: return [((wid, j['name']), [l.lower() for l in j.get('labels') or []]) for j in call([f'repos/{repo}/actions/runs/{rid}/jobs?filter=all&per_page=100'])['jobs']]
    except RuntimeError: return []
labels = dict(pair for got in pool.map(jobs, samples.items()) for pair in got)
def rate(lbls):
    text = ' '.join(lbls)
    if 'self-hosted' in text: return 0
    if 'macos' in text: return 10
    if 'windows' in text: return 2
    return 1
out = {}
for day in days:
    rows = []
    for r in by_day[day]:
        created = ts(r['created_at'])
        billable = njobs = secs = 0
        starts, ends = [], []
        for c in checks.get(r['id'], []):
            s, e = ts(c.get('startedAt')), ts(c.get('completedAt'))
            if not s or not e or (c.get('conclusion') or '').upper() == 'SKIPPED': continue
            d = max(0, (e - s).total_seconds())
            njobs += 1; secs += d; starts.append(s); ends.append(e)
            billable += math.ceil(d / 60) * rate(labels.get((r['workflow_id'], c.get('name')), []))
        who = (r.get('triggering_actor') or r.get('actor') or {}).get('login') or 'unknown'
        rows.append({
            'w': r.get('name') or r.get('path') or '?', 'u': who, 'e': r.get('event') or '?',
            'c': r.get('conclusion') or r.get('status') or '?', 'a': r.get('run_attempt') or 1,
            't': r['created_at'], 'h': created.astimezone().hour, 'wd': created.astimezone().weekday(),
            'm': billable, 'j': njobs, 's': round(secs),
            'r': round((max(ends) - min(starts)).total_seconds()) if starts else 0,
        })
    out[day] = rows
print(json.dumps({'today': datetime.datetime.now(datetime.timezone.utc).date().isoformat(), 'capped': capped, 'days': out}))
`

export type Fetched = { today: string; capped: string[]; days: Record<string, Run[]> }

/** `YYYY-MM` for a UTC date string. */
export const monthOf = (day: string) => day.slice(0, 7)

/** Days in a month, by the calendar alone. */
export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number)

  return new Date(Date.UTC(y ?? 1970, m ?? 1, 0)).getUTCDate()
}

/** Every UTC day of `month` up to `today`, oldest first. */
export function monthDays(month: string, today: string): string[] {
  const out: string[] = []
  for (let d = 1; d <= daysInMonth(month); d++) {
    const day = `${month}-${String(d).padStart(2, '0')}`
    if (day > today) break
    out.push(day)
  }

  return out
}

/**
 * Which days to ask GitHub for: any not cached yet, plus the last two days
 * seen (runs still finishing, re-runs landing late) and today.
 */
export function daysToFetch(all: string[], cached: Record<string, Run[]>, today: string): string[] {
  const recent = new Set(all.filter(day => day >= addDays(today, -2)))

  return all.filter(day => !cached[day] || recent.has(day))
}

export function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number)

  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + delta)).toISOString().slice(0, 10)
}

/** Reads `owner/repo` and `YYYY-MM` from the command's args, in any order. */
export function parseArgs(args: string): { repo?: string; month?: string } {
  const out: { repo?: string; month?: string } = {}
  for (const word of args.trim().split(/\s+/)) {
    if (/^\d{4}-\d{2}$/.test(word)) out.month = word
    else if (/^[\w.-]+\/[\w.-]+$/.test(word)) out.repo = word
  }

  return out
}

const isBot = (login: string) => login.endsWith('[bot]')
const isFail = (run: Run) => run.c === 'failure' || run.c === 'timed_out' || run.c === 'startup_failure'
const isNight = (run: Run) => run.h >= 22 || run.h < 6

function tally<K extends string>(runs: Run[], key: (run: Run) => K) {
  const out = new Map<K, Run[]>()
  for (const run of runs) {
    const k = key(run)
    const list = out.get(k)
    if (list) list.push(run)
    else out.set(k, [run])
  }

  return out
}

const sumBy = (runs: Run[], value: (run: Run) => number) => runs.reduce((acc, run) => acc + value(run), 0)
const count = (runs: Run[], test: (run: Run) => boolean) => runs.filter(test).length

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export const monthName = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1] ?? ''} ${month.slice(0, 4)}`
const SHORT = MONTHS.map(name => name.slice(0, 3))
export const shortDay = (day: string) => `${SHORT[Number(day.slice(5, 7)) - 1] ?? ''} ${Number(day.slice(8, 10))}`

const plural = (n: number, noun: string) => `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`
const mins = (n: number) => `${Math.round(n).toLocaleString('en-US')} min`
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)

/** The top row by `score`, if it scores above zero. */
function top<T>(rows: T[], score: (row: T) => number): T | undefined {
  let best: T | undefined
  for (const row of rows) if (score(row) > 0 && (!best || score(row) > score(best))) best = row

  return best
}

/** Turns cached days of runs into everything the pane shows. */
export function buildReport(repo: string, month: string, today: string, days: Record<string, Run[]>, capped: string[], fetchedAt: number): Report {
  const span = monthDays(month, today)
  const runs = span.flatMap(day => days[day] ?? [])

  const users: UserRow[] = [...tally(runs, run => run.u)].map(([login, list]) => {
    const byWorkflow = [...tally(list, run => run.w)].map(([name, l]) => [name, sumBy(l, run => run.m)] as const)
    byWorkflow.sort((a, b) => b[1] - a[1])

    return {
      login,
      isBot: isBot(login),
      runs: list.length,
      minutes: sumBy(list, run => run.m),
      failures: count(list, isFail),
      cancelled: count(list, run => run.c === 'cancelled'),
      reruns: count(list, run => run.a > 1),
      night: count(list, isNight),
      weekend: count(list, run => run.wd >= 5),
      topWorkflow: byWorkflow[0]?.[0] ?? '',
    }
  })
  users.sort((a, b) => b.minutes - a.minutes || b.runs - a.runs)

  const workflows: WorkflowRow[] = [...tally(runs, run => run.w)].map(([name, list]) => {
    const minutes = sumBy(list, run => run.m)

    return { name, runs: list.length, minutes, failures: count(list, isFail), avgMinutes: minutes / list.length }
  })
  workflows.sort((a, b) => b.minutes - a.minutes)

  const events = [...tally(runs, run => run.e)].map(([name, list]) => ({ name, runs: list.length, minutes: sumBy(list, run => run.m) }))
  events.sort((a, b) => b.minutes - a.minutes)

  const hours = Array.from({ length: 24 }, () => 0)
  for (const run of runs) hours[run.h] = (hours[run.h] ?? 0) + 1

  const minutes = sumBy(runs, run => run.m)
  const total = daysInMonth(month)
  const elapsed = Math.max(1, span.length)
  const finished = count(runs, run => run.c === 'success' || isFail(run))

  return {
    repo,
    month,
    today,
    fetchedAt,
    totals: {
      runs: runs.length,
      minutes,
      jobs: sumBy(runs, run => run.j),
      computeHours: sumBy(runs, run => run.s) / 3600,
      success: pct(count(runs, run => run.c === 'success'), finished),
      failures: count(runs, isFail),
      cancelled: count(runs, run => run.c === 'cancelled'),
      reruns: count(runs, run => run.a > 1),
      daysElapsed: span.length,
      daysInMonth: total,
      projected: span.length >= total ? minutes : Math.round((minutes / elapsed) * total),
    },
    users,
    workflows,
    events,
    byDay: span.map(day => ({ day, value: sumBy(days[day] ?? [], run => run.m) })),
    hours,
    awards: awards(users, workflows, runs, minutes),
    capped,
  }
}

/** The month's superlatives: people for most, the bots get one of their own. */
export function awards(users: UserRow[], workflows: WorkflowRow[], runs: Run[], minutes: number): Award[] {
  const people = users.filter(user => !user.isBot)
  const out: Award[] = []
  const add = (emoji: string, title: string, winner: string | undefined, detail: string) => {
    if (winner) out.push({ emoji, title, winner, detail })
  }

  const muncher = top(people, user => user.minutes)
  add('🍔', 'Minute Muncher', muncher?.login, muncher ? `${mins(muncher.minutes)}, ${pct(muncher.minutes, minutes)}% of the whole month` : '')

  const red = top(people, user => user.failures)
  add('🔴', 'The Red Button', red?.login, red ? `${plural(red.failures, 'failed run')} (${pct(red.failures, red.runs)}% of theirs)` : '')

  const groundhog = top(people, user => user.reruns)
  add('🔁', 'Groundhog Day', groundhog?.login, groundhog ? `${plural(groundhog.reruns, 're-run')}: "maybe this time"` : '')

  const owl = top(people, user => user.night)
  add('🦉', 'Night Owl', owl?.login, owl ? `${plural(owl.night, 'run')} kicked off between 10pm and 6am` : '')

  const weekend = top(people, user => user.weekend)
  add('🏖️', 'Weekend Warrior', weekend?.login, weekend ? `${plural(weekend.weekend, 'run')} on a Saturday or Sunday` : '')

  const cancel = top(people, user => user.cancelled)
  add('🛑', 'Cancel Culture', cancel?.login, cancel ? `${plural(cancel.cancelled, 'run')} cancelled mid-flight` : '')

  const sharp = top(
    people.filter(user => user.runs >= 20),
    user => 1000 - pct(user.failures, user.runs) + user.runs / 1e6,
  )
  add('🎯', 'Sharpshooter', sharp?.login, sharp ? `${100 - pct(sharp.failures, sharp.runs)}% green over ${plural(sharp.runs, 'run')}` : '')

  const bot = top(
    users.filter(user => user.isBot),
    user => user.minutes + user.runs / 1e6,
  )
  add('🤖', 'Robot Overlord', bot?.login, bot ? `${plural(bot.runs, 'run')}, ${mins(bot.minutes)}` : '')

  const longest = top(runs, run => run.r)
  add(
    '🐢',
    'The Marathon',
    longest ? `${longest.w}` : undefined,
    longest ? `${Math.round(longest.r / 60)} min in one run, started by ${longest.u} on ${shortDay(longest.t.slice(0, 10))}` : '',
  )

  const hog = top(workflows, row => row.minutes)
  add('🔥', 'Hungriest Workflow', hog?.name, hog ? `${mins(hog.minutes)} over ${plural(hog.runs, 'run')}` : '')

  const flaky = top(
    workflows.filter(row => row.runs >= 10),
    row => row.failures / row.runs,
  )
  add('🎲', 'Coin Flip', flaky?.name, flaky ? `fails ${pct(flaky.failures, flaky.runs)}% of the time` : '')

  return out
}

/** A plain-text recap, for the command's reply and the narrator's notes. */
export function summaryText(report: Report): string {
  const t = report.totals
  const lines = [
    `${report.repo}, ${monthName(report.month)} (${t.daysElapsed} of ${t.daysInMonth} days): ${mins(t.minutes)} billable over ${plural(t.runs, 'run')}, ${t.success}% green, on pace for ${mins(t.projected)}.`,
    ...report.users.slice(0, 8).map(user => `- ${user.login}: ${mins(user.minutes)} (${pct(user.minutes, t.minutes)}%), ${plural(user.runs, 'run')}, ${user.failures} failed`),
  ]

  return lines.join('\n')
}

/** What the narrator is told; numbers only, the model adds the color. */
export function narratorPrompt(report: Report): string {
  return [
    'Write a three-sentence recap of this GitHub Actions month in the voice of an over-excited sports commentator.',
    'Name people by their GitHub login. Keep every number exactly as given. No headings, no emoji, plain text.',
    '',
    summaryText(report),
    'Awards:',
    ...report.awards.map(award => `- ${award.title}: ${award.winner} (${award.detail})`),
  ].join('\n')
}

/** A horizontal text bar, scaled to `max`. */
export function textBar(value: number, max: number, width: number): string {
  if (value <= 0 || max <= 0) return ''
  const cells = (value / max) * width
  const whole = Math.floor(cells)
  const eighths = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

  return '█'.repeat(whole) + (eighths[Math.round((cells - whole) * 7)] ?? '') || '▏'
}

/** The 24 hours as one line of block heights. */
export function sparkline(values: number[]): string {
  const blocks = ' ▁▂▃▄▅▆▇█'
  const max = Math.max(1, ...values)

  return values.map(v => blocks[v === 0 ? 0 : Math.max(1, Math.round((v / max) * 8))] ?? ' ').join('')
}

function niceMax(value: number): number {
  if (value <= 4) return 4
  const step = Math.pow(10, Math.floor(Math.log10(value)))
  for (const factor of [1, 2, 2.5, 5, 10]) if (factor * step >= value) return factor * step

  return 10 * step
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Minutes per day as a bar chart, a tooltip per day and the peak labeled. */
export function barChartSvg(points: Array<{ day: string; value: number }>, width: number): string {
  const height = 140
  const left = 34
  const right = 6
  const top = 14
  const bottom = 20
  const plotW = width - left - right
  const plotH = height - top - bottom
  const max = niceMax(Math.max(0, ...points.map(point => point.value)))
  const slot = plotW / Math.max(1, points.length)
  const barW = Math.max(1, Math.min(28, slot - (slot > 6 ? 2 : 1)))
  const y = (value: number) => top + plotH - (value / max) * plotH
  const peak = points.reduce((best, point, i) => (point.value > (points[best]?.value ?? -1) ? i : best), 0)
  const labelEvery = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(plotW / 52))))

  const parts: string[] = []
  for (const tick of [0, max / 2, max]) {
    const at = y(tick).toFixed(1)
    parts.push(`<line class="grid" x1="${left}" x2="${width - right}" y1="${at}" y2="${at}"/>`)
    parts.push(`<text class="ink" x="${left - 5}" y="${at}" dy="3" text-anchor="end">${Math.round(tick)}</text>`)
  }
  points.forEach((point, i) => {
    const x = left + i * slot + (slot - barW) / 2
    let bar = ''
    if (point.value > 0) {
      const yTop = y(point.value)
      const base = top + plotH
      const r = Math.min(4, barW / 2, base - yTop)
      bar =
        `<path class="bar" d="M${x.toFixed(1)},${base} V${(yTop + r).toFixed(1)} ` +
        `Q${x.toFixed(1)},${yTop.toFixed(1)} ${(x + r).toFixed(1)},${yTop.toFixed(1)} ` +
        `H${(x + barW - r).toFixed(1)} Q${(x + barW).toFixed(1)},${yTop.toFixed(1)} ${(x + barW).toFixed(1)},${(yTop + r).toFixed(1)} ` +
        `V${base} Z"/>`
    }
    parts.push(
      `<g class="col"><title>${escape(`${shortDay(point.day)}: ${point.value.toLocaleString('en-US')} min`)}</title>` +
        `<rect class="hit" x="${(left + i * slot).toFixed(1)}" y="${top}" width="${slot.toFixed(1)}" height="${plotH + bottom}"/>${bar}</g>`,
    )
    if (i === peak && point.value > 0) {
      parts.push(`<text class="ink strong" x="${(x + barW / 2).toFixed(1)}" y="${(y(point.value) - 4).toFixed(1)}" text-anchor="middle">${point.value}</text>`)
    }
    const isEdge = i === 0 || i === points.length - 1
    if (isEdge || (i % labelEvery === 0 && points.length - 1 - i >= labelEvery / 2)) {
      const anchor = i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'
      const lx = anchor === 'start' ? left + i * slot : anchor === 'end' ? left + (i + 1) * slot : x + barW / 2
      parts.push(`<text class="ink" x="${lx.toFixed(1)}" y="${height - 5}" text-anchor="${anchor}">${shortDay(point.day)}</text>`)
    }
  })

  const style =
    'text{font:10px system-ui,-apple-system,sans-serif}.ink{fill:#52514e}.strong{fill:#0b0b0b;font-weight:600}' +
    '.grid{stroke:#e4e3df;stroke-width:1}.bar{fill:#2a78d6}.hit{fill:transparent}' +
    '.col:hover .hit{fill:rgba(0,0,0,.05)}.col:hover .bar{fill:#1f5fae}' +
    '@media (prefers-color-scheme:dark){.ink{fill:#c3c2b7}.strong{fill:#f0efec}.grid{stroke:#3a3a37}' +
    '.bar{fill:#3987e5}.col:hover .hit{fill:rgba(255,255,255,.06)}.col:hover .bar{fill:#6aa6ee}}'

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    `<style>${style}</style>${parts.join('')}</svg>`
  )
}
