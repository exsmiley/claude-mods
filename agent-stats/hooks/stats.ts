import type { DayStats } from '../types'

/**
 * Reads every transcript under ~/.claude/projects and prints, per local day,
 * the sessions started (a transcript's first timestamp) and the subagents
 * launched (Agent tool calls, by subagent type). Prints only counts.
 */
export const SCAN_SCRIPT = String.raw`
import json, glob, os, collections, datetime
root = os.path.expanduser('~/.claude/projects')
days = collections.defaultdict(lambda: {'sessions': 0, 'subagents': 0, 'types': collections.Counter()})
def local_day(stamp):
    try:
        return datetime.datetime.fromisoformat(stamp.replace('Z', '+00:00')).astimezone().strftime('%Y-%m-%d')
    except ValueError:
        return stamp[:10]
def first_day(path):
    with open(path, errors='replace') as f:
        for line in f:
            if '"timestamp"' not in line: continue
            try: stamp = json.loads(line).get('timestamp')
            except ValueError: continue
            if isinstance(stamp, str) and len(stamp) >= 10: return local_day(stamp)
    return None
for path in glob.glob(os.path.join(root, '*', '*.jsonl')):
    day = first_day(path)
    if not day: continue
    days[day]['sessions'] += 1
    with open(path, errors='replace') as f:
        for line in f:
            if '"tool_use"' not in line or ('"Agent"' not in line and '"Task"' not in line): continue
            try: row = json.loads(line)
            except ValueError: continue
            content = (row.get('message') or {}).get('content')
            if not isinstance(content, list): continue
            for block in content:
                if isinstance(block, dict) and block.get('type') == 'tool_use' and block.get('name') in ('Agent', 'Task'):
                    stamp = row.get('timestamp')
                    at = local_day(stamp) if isinstance(stamp, str) else day
                    kind = (block.get('input') or {}).get('subagent_type') or 'general-purpose'
                    days[at]['subagents'] += 1
                    days[at]['types'][kind] += 1
print(json.dumps({
    'today': datetime.datetime.now().strftime('%Y-%m-%d'),
    'days': {d: {'sessions': v['sessions'], 'subagents': v['subagents'], 'types': dict(v['types'])} for d, v in days.items()},
}))
`

export type Scan = { today: string; days: Record<string, DayStats> }

const total = (day: DayStats | undefined) => (day ? day.sessions + day.subagents : 0)

/**
 * Keeps what was stored for days whose transcripts are gone (Claude Code
 * deletes old ones), and takes the fresh count wherever it is at least as large.
 */
export function mergeDays(
  stored: Record<string, DayStats>,
  scanned: Record<string, DayStats>,
): Record<string, DayStats> {
  const merged: Record<string, DayStats> = { ...stored }
  for (const [day, stats] of Object.entries(scanned)) {
    if (total(stats) >= total(merged[day])) merged[day] = stats
  }

  return merged
}

/** `YYYY-MM-DD` plus `delta` days, by the calendar alone. */
export function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + delta))

  return date.toISOString().slice(0, 10)
}

/** Every day in the range, oldest first, with zero for days nothing ran. */
export function daysInRange(days: Record<string, DayStats>, today: string, range: number): string[] {
  const keys = Object.keys(days).sort()
  const start = range > 0 ? addDays(today, -(range - 1)) : (keys[0] ?? today)
  const out: string[] = []
  for (let day = start; day <= today && out.length < 3660; day = addDays(day, 1)) out.push(day)

  return out
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const shortDay = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1] ?? ''} ${Number(day.slice(8, 10))}`

export type Summary = {
  activeDays: number
  subagentsPerDay: number
  sessionsPerDay: number
  busiest?: { day: string; subagents: number }
  types: Array<[string, number]>
}

/** Averages over days that had any session, the busiest day, and the types used most. */
export function summarize(days: Record<string, DayStats>, range: string[]): Summary {
  const inRange = range.map(day => [day, days[day]] as const)
  const active = inRange.filter(([, stats]) => total(stats) > 0)
  const sum = (key: 'sessions' | 'subagents') =>
    active.reduce((acc, [, stats]) => acc + (stats?.[key] ?? 0), 0)
  const types = new Map<string, number>()
  let busiest: Summary['busiest']
  for (const [day, stats] of active) {
    if (!stats) continue
    for (const [kind, count] of Object.entries(stats.types)) types.set(kind, (types.get(kind) ?? 0) + count)
    if (!busiest || stats.subagents > busiest.subagents) busiest = { day, subagents: stats.subagents }
  }
  const per = (value: number) => (active.length > 0 ? value / active.length : 0)

  return {
    activeDays: active.length,
    subagentsPerDay: per(sum('subagents')),
    sessionsPerDay: per(sum('sessions')),
    busiest,
    types: [...types.entries()].sort((a, b) => b[1] - a[1]),
  }
}

/** A max for the y axis that lands on a round number. */
function niceMax(value: number): number {
  if (value <= 4) return 4
  const step = Math.pow(10, Math.floor(Math.log10(value)))
  for (const factor of [1, 2, 2.5, 5, 10]) if (factor * step >= value) return factor * step

  return 10 * step
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * One series as a bar chart: thin bars with rounded tops on a shared
 * baseline, a recessive grid, the peak labeled, and a tooltip per day.
 */
export function barChartSvg(points: Array<{ day: string; value: number }>, width: number, noun: string): string {
  const height = 132
  const left = 26
  const right = 6
  const top = 14
  const bottom = 20
  const plotW = width - left - right
  const plotH = height - top - bottom
  const max = niceMax(Math.max(0, ...points.map(point => point.value)))
  const slot = plotW / Math.max(1, points.length)
  const gap = slot > 6 ? 2 : 1
  const barW = Math.max(1, Math.min(28, slot - gap))
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
    const tip = `${shortDay(point.day)}: ${point.value} ${noun}${point.value === 1 ? '' : 's'}`
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
      `<g class="col"><title>${escape(tip)}</title>` +
        `<rect class="hit" x="${(left + i * slot).toFixed(1)}" y="${top}" width="${slot.toFixed(1)}" height="${plotH + bottom}"/>${bar}</g>`,
    )
    if (i === peak && point.value > 0) {
      parts.push(
        `<text class="ink strong" x="${(x + barW / 2).toFixed(1)}" y="${(y(point.value) - 4).toFixed(1)}" text-anchor="middle">${point.value}</text>`,
      )
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

/** A horizontal text bar for the terminal, scaled to `max`. */
export function textBar(value: number, max: number, width: number): string {
  if (value <= 0 || max <= 0) return ''
  const cells = (value / max) * width
  const whole = Math.floor(cells)
  const eighths = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
  const rest = eighths[Math.round((cells - whole) * 7)] ?? ''

  return '█'.repeat(whole) + rest || '▏'
}
