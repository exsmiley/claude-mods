import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { DayStats, History, Range } from '../types'
import { barChartSvg, daysInRange, mergeDays, SCAN_SCRIPT, shortDay, summarize, textBar } from './stats'
import type { Scan } from './stats'

const PANE = 'agent-stats'
const TITLE = 'Agent stats'
const EVERY_MS = 5 * 60 * 1000
// Daily totals kept across sessions, so history outlives the transcripts.
const STORE_KEY = 'days'

const history = atom({ plugin: 'agent-stats', key: 'history' } as const, null, { shape: 'history-1' })
const range = atom({ plugin: 'agent-stats', key: 'range' } as const, 30)
const RANGES: Array<{ value: Range; label: string }> = [
  { value: 14, label: '14 days' },
  { value: 30, label: '30 days' },
  { value: 0, label: 'All' },
]

let ticker: Timer | undefined
let today = ''

async function scan($: EngineInterface) {
  try {
    const ran = await $.process.run(['python3', '-I', '-c', SCAN_SCRIPT], { timeoutMs: 120_000 })
    if (ran.exitCode !== 0) throw new Error(ran.stderr.trim().split('\n').pop() || `python3 exited ${ran.exitCode}`)
    const fresh = JSON.parse(ran.stdout) as Scan
    today = fresh.today
    const stored = ((await $.store.get(STORE_KEY)) ?? {}) as Record<string, DayStats>
    const days = mergeDays(stored, fresh.days)
    await $.store.set(STORE_KEY, days)
    const next: History = { days, scannedAt: await $.clock.now() }
    await update($, history, () => next)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await update($, history, last => ({ days: last?.days ?? {}, scannedAt: last?.scannedAt ?? 0, error: message }))
  }
}

async function openPane($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: TITLE })
  if (!ticker) {
    void scan($)
    ticker = $.clock.every(EVERY_MS, () => void scan($))
  }

  return opened
}

const one = (value: number) => (value >= 10 ? Math.round(value).toString() : value.toFixed(1))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-stats',
      description: 'Chart the sessions and subagents you start each day',
    })
    const started = await next(e)
    // Open on /command only, so every session doesn't poll; a reload keeps an open pane going.
    if ((await $.ui.panes()).some(pane => pane.id === PANE)) void openPane($)

    return started
  })

  on('command.run', { command: 'agent-stats' }, async $ => {
    await openPane($)

    return { text: 'Agent stats pane opened.' }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    ticker?.cancel()
    ticker = undefined

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const data = await read($, history)
    const span = await read($, range)
    if (!data) return <Text dimColor>Reading your transcripts…</Text>

    const end = today || Object.keys(data.days).sort().pop() || ''
    const days = daysInRange(data.days, end, span)
    const summary = summarize(data.days, days)
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 60
    const series = (key: 'subagents' | 'sessions') =>
      days.map(day => ({ day, value: data.days[day]?.[key] ?? 0 }))
    const alt = (key: 'subagents' | 'sessions') =>
      series(key)
        .map(point => `${shortDay(point.day)} ${point.value}`)
        .join(', ')

    const controls = (
      <Box flexDirection="row" gap={1}>
        {RANGES.map(choice => (
          <Button
            key={`range-${choice.value}`}
            label={choice.label}
            variant={choice.value === span ? 'primary' : 'secondary'}
            onPress={() => update($, range, () => choice.value)}
          />
        ))}
      </Box>
    )

    const header = (
      <Box flexDirection="column">
        <Text>
          <Text weight="semibold" tabular>
            {one(summary.subagentsPerDay)}
          </Text>
          <Text dimColor> subagents and </Text>
          <Text weight="semibold" tabular>
            {one(summary.sessionsPerDay)}
          </Text>
          <Text dimColor> sessions per active day</Text>
        </Text>
        <Text dimColor size="footnote">
          {summary.activeDays} active of {days.length} days
          {summary.busiest && summary.busiest.subagents > 0
            ? ` · busiest ${shortDay(summary.busiest.day)} (${summary.busiest.subagents} subagents)`
            : ''}
        </Text>
      </Box>
    )

    const typeList = (
      <Box flexDirection="column" marginTop={1}>
        <Text weight="semibold">Subagent types</Text>
        {summary.types.length === 0 && <Text dimColor>None in this range.</Text>}
        {summary.types.slice(0, 6).map(([kind, count]) => (
          <Text key={kind} tabular>
            <Text dimColor>{String(count).padStart(4)} </Text>
            {kind}
          </Text>
        ))}
      </Box>
    )

    const footer = (
      <Text dimColor size="footnote">
        {data.error ? `Last read failed: ${data.error}. ` : ''}
        From ~/.claude/projects, read every 5 minutes; totals are kept after old transcripts are deleted.
      </Text>
    )

    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      const width = Math.max(260, Math.min(960, Math.round(columns * 7.5)))

      return (
        <Box flexDirection="column" gap={1}>
          {controls}
          {header}
          <Box flexDirection="column">
            <Text weight="semibold">Subagents launched per day</Text>
            <Svg isInteractive source={barChartSvg(series('subagents'), width, 'subagent')} alt={`Subagents per day: ${alt('subagents')}`} />
          </Box>
          <Box flexDirection="column">
            <Text weight="semibold">Sessions started per day</Text>
            <Svg isInteractive source={barChartSvg(series('sessions'), width, 'session')} alt={`Sessions per day: ${alt('sessions')}`} />
          </Box>
          {typeList}
          {footer}
        </Box>
      )
    }

    // The terminal draws no SVG: one row per day, newest first.
    const rows = Math.max(3, (e.viewport?.rows ?? 30) - 16)
    const shown = days.slice(-rows).reverse()
    const maxSub = Math.max(1, ...shown.map(day => data.days[day]?.subagents ?? 0))
    const maxSes = Math.max(1, ...shown.map(day => data.days[day]?.sessions ?? 0))
    const barW = Math.max(4, Math.floor((columns - 22) / 2))

    return (
      <Box flexDirection="column">
        {controls}
        {header}
        <Text dimColor>
          {'\n'}
          {'day'.padEnd(7)} {'subagents'.padEnd(barW + 4)} sessions
        </Text>
        {shown.map(day => {
          const stats = data.days[day]
          const sub = stats?.subagents ?? 0
          const ses = stats?.sessions ?? 0

          return (
            <Text key={day} tabular wrap="truncate-end">
              <Text dimColor>{shortDay(day).padEnd(7)}</Text>{' '}
              <Text color="claude">{textBar(sub, maxSub, barW)}</Text>
              {` ${sub}`.padEnd(barW + 4 - textBar(sub, maxSub, barW).length)}
              <Text color="suggestion">{textBar(ses, maxSes, Math.floor(barW / 2))}</Text> {ses}
            </Text>
          )
        })}
        {typeList}
        {footer}
      </Box>
    )
  })
}
