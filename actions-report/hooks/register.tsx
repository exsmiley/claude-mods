import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Report, Run, View } from '../types'
import {

  barChartSvg,
  buildReport,
  daysToFetch,
  FETCH_SCRIPT,
  monthDays,
  monthName,
  monthOf,
  narratorPrompt,
  parseArgs,
  sparkline,
  summaryText,
  textBar,
} from './data'
import type { Fetched } from './data'

const PANE = 'actions-report'
// Cached runs per repo and month; the store holds 4 MiB in all, so only the latest few.
const KEEP = 2
const RECENT = 'recent'
const cacheKey = (repo: string, month: string) => `runs:${repo}:${month}`
type Cache = { days: Record<string, Run[]>; capped: string[] }

const view = atom({ plugin: 'actions-report', key: 'view' } as const, { report: null, repo: '', month: '', status: 'idle' } as View, {
  shape: 'view-1',
})

let inFlight = ''

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function currentRepo($: EngineInterface): Promise<string> {
  const ran = await $.process.run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { timeoutMs: 30_000 })
  const repo = ran.stdout.trim()
  if (ran.exitCode !== 0 || !repo) {
    throw new Error('No GitHub repo here. Run /actions-report owner/repo, or start the session inside a clone.')
  }

  return repo
}

async function remember($: EngineInterface, key: string, cache: Cache) {
  const recent = ((await $.store.get(RECENT)) ?? []) as string[]
  const next = [key, ...recent.filter(k => k !== key)]
  for (const old of next.slice(KEEP)) await $.store.delete(old)
  await $.store.set(key, cache)
  await $.store.set(RECENT, next.slice(0, KEEP))
}

/** Reads the month from GitHub (only the days not cached yet), then has the narrator weigh in. */
async function load($: EngineInterface, repo: string, month: string) {
  const job = `${repo} ${month}`
  if (inFlight === job) return
  inFlight = job
  const key = cacheKey(repo, month)
  try {
    const cache = ((await $.store.get(key)) ?? { days: {}, capped: [] }) as Cache
    const now = new Date(await $.clock.now()).toISOString().slice(0, 10)
    // A past month's days all finished; the current one runs up to today.
    const today = month < monthOf(now) ? `${month}-31` : now
    const all = monthDays(month, today)
    if (month > monthOf(now)) throw new Error(`${monthName(month)} hasn't happened yet.`)
    const wanted = daysToFetch(all, cache.days, all[all.length - 1] ?? today)
    await update($, view, (last): View => ({
      ...last,
      repo,
      month,
      status: 'loading',
      message: wanted.length ? `Asking GitHub about ${wanted.length} day${wanted.length === 1 ? '' : 's'} of runs…` : 'Using cached runs…',
      ...(last.repo === repo && last.month === month ? {} : { report: null, blurb: undefined }),
    }))

    let capped = cache.capped
    if (wanted.length) {
      const ran = await $.process.run(['python3', '-I', '-c', FETCH_SCRIPT, repo, wanted.join(',')], { timeoutMs: 600_000 })
      if (ran.exitCode !== 0) throw new Error(ran.stderr.trim().split('\n').pop() || `python3 exited ${ran.exitCode}`)
      const fresh = JSON.parse(ran.stdout) as Fetched
      Object.assign(cache.days, fresh.days)
      capped = [...new Set([...cache.capped.filter(day => !wanted.includes(day)), ...fresh.capped])]
      await remember($, key, { days: cache.days, capped })
    }

    const report = buildReport(repo, month, all[all.length - 1] ?? today, cache.days, capped, await $.clock.now())
    await update($, view, (last): View => ({ ...last, report, status: 'idle', message: undefined }))
    void narrate($, report)
  } catch (error) {
    await update($, view, (last): View => ({ ...last, status: 'error', message: errorText(error) }))
  } finally {
    inFlight = ''
  }
}

async function narrate($: EngineInterface, report: Report) {
  if (report.totals.runs === 0) return
  const said = await $.model.complete({ model: 'haiku', prompt: narratorPrompt(report), maxTokens: 300 })
  if (!said.isAnswered) return
  await update($, view, last => (last.report === null || last.report.fetchedAt !== report.fetchedAt ? last : { ...last, blurb: said.text.trim() }))
}

const shiftMonth = (month: string, delta: number) => {
  const [y, m] = month.split('-').map(Number)
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1 + delta, 1))

  return date.toISOString().slice(0, 7)
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'actions-report',
      description: "A fun report of this month's GitHub Actions minutes per person",
      argumentHint: '[owner/repo] [YYYY-MM]',
    })

    return next(e)
  })

  on('command.run', { command: 'actions-report' }, async ($, e) => {
    const asked = parseArgs(e.args)
    const last = await read($, view)
    let repo = asked.repo
    try {
      repo ??= await currentRepo($)
    } catch (error) {
      return { text: errorText(error) }
    }
    const month = asked.month ?? (asked.repo || !last.month ? monthOf(new Date(await $.clock.now()).toISOString()) : last.month)
    await $.ui.open({ id: PANE, title: 'Actions report' })
    void load($, repo, month)
    const cached = last.report && last.report.repo === repo && last.report.month === month ? `\n\n${summaryText(last.report)}` : ''

    return { text: `Building the GitHub Actions report for ${repo}, ${monthName(month)}, in the pane.${cached}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const state = await read($, view)
    const report = state.report
    const columns = e.props.bodyColumns ?? e.viewport?.columns ?? 70

    const controls = state.repo ? (
      <Box flexDirection="row" gap={1}>
        <Button label="◀" variant="secondary" onPress={() => void load($, state.repo, shiftMonth(state.month, -1))} />
        <Button label="Refresh" variant="primary" onPress={() => void load($, state.repo, state.month)} />
        <Button label="▶" variant="secondary" onPress={() => void load($, state.repo, shiftMonth(state.month, 1))} />
      </Box>
    ) : null

    const status =
      state.status === 'loading' ? (
        <Text dimColor>{state.message ?? 'Working…'}</Text>
      ) : state.status === 'error' ? (
        <Text color="error">Couldn't read the runs: {state.message}</Text>
      ) : null

    if (!report) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text weight="semibold">{state.repo ? `${state.repo} · ${monthName(state.month)}` : 'Actions report'}</Text>
          {controls}
          {status ?? <Text dimColor>Run /actions-report to build one.</Text>}
          {state.status === 'loading' && <Text dimColor size="footnote">A first read of a busy month takes a minute; later reads only fetch the last few days.</Text>}
        </Box>
      )
    }

    const t = report.totals
    const humans = report.users
    const maxMin = Math.max(1, ...humans.map(user => user.minutes))
    const nameW = Math.min(22, Math.max(6, ...humans.map(user => user.login.length)))
    const barW = Math.max(6, Math.min(30, columns - nameW - 34))

    const header = (
      <Box flexDirection="column">
        <Text weight="semibold" size="heading">
          {report.repo} · {monthName(report.month)}
        </Text>
        <Text dimColor>
          {t.daysElapsed < t.daysInMonth ? `Day ${t.daysElapsed} of ${t.daysInMonth}` : 'Full month'} · read{' '}
          {new Date(report.fetchedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        </Text>
      </Box>
    )

    const stat = (value: string, label: string, color?: string) => (
      <Box flexDirection="column" key={label}>
        <Text weight="bold" size="title" tabular color={color}>
          {value}
        </Text>
        <Text dimColor size="footnote">
          {label}
        </Text>
      </Box>
    )

    const tiles = (
      <Box flexDirection="row" gap={3} flexWrap="wrap">
        {stat(fmt(t.minutes), 'billable minutes')}
        {stat(fmt(t.runs), 'workflow runs')}
        {stat(`${t.success}%`, 'green', t.success >= 90 ? 'success' : t.success >= 75 ? 'warning' : 'error')}
        {t.daysElapsed < t.daysInMonth ? stat(fmt(t.projected), 'on pace for, by month end') : null}
      </Box>
    )

    const blurb = state.blurb ? (
      <Text italic wrap="wrap">
        🎙️ {state.blurb}
      </Text>
    ) : null

    const people = (
      <Box flexDirection="column">
        <Text weight="semibold">Minutes by person</Text>
        {humans.map((user, i) => (
          <Text key={user.login} tabular wrap="truncate-end">
            <Text dimColor>{i === 0 ? '👑' : `${i + 1}.`.padStart(2)} </Text>
            {user.login.padEnd(nameW).slice(0, nameW)} <Text color={user.isBot ? 'subtle' : 'claude'}>{textBar(user.minutes, maxMin, barW).padEnd(barW)}</Text>{' '}
            {fmt(user.minutes).padStart(6)} min <Text dimColor>{String(pct(user.minutes, t.minutes)).padStart(3)}% · {fmt(user.runs)} runs · {pct(user.failures, user.runs)}% red</Text>
          </Text>
        ))}
      </Box>
    )

    const awards = (
      <Box flexDirection="column">
        <Text weight="semibold">The awards</Text>
        {report.awards.map(award => (
          <Text key={award.title} wrap="wrap">
            {award.emoji} <Text weight="semibold">{award.title}</Text>: {award.winner} <Text dimColor>— {award.detail}</Text>
          </Text>
        ))}
      </Box>
    )

    const daily =
      e.surface !== 'terminal' && 'Svg' in ui ? (
        <Box flexDirection="column">
          <Text weight="semibold">Minutes per day (UTC)</Text>
          <ui.Svg
            isInteractive
            source={barChartSvg(report.byDay, Math.max(260, Math.min(960, Math.round(columns * 7.5))))}
            alt={`Minutes per day: ${report.byDay.map(point => `${point.day.slice(8)} ${point.value}`).join(', ')}`}
          />
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text weight="semibold">Minutes per day (UTC)</Text>
          <Text tabular>{sparkline(report.byDay.map(point => point.value))}</Text>
          <Text dimColor tabular>
            1{' '.repeat(Math.max(0, report.byDay.length - 1 - String(report.byDay.length).length))}
            {report.byDay.length}
          </Text>
        </Box>
      )

    const maxW = Math.max(1, ...report.workflows.map(row => row.minutes))
    const wfW = Math.min(28, Math.max(8, ...report.workflows.map(row => row.name.length)))
    const workflows = (
      <Box flexDirection="column">
        <Text weight="semibold">Workflows</Text>
        {report.workflows.slice(0, 10).map(row => (
          <Text key={row.name} tabular wrap="truncate-end">
            {row.name.padEnd(wfW).slice(0, wfW)} <Text color="suggestion">{textBar(row.minutes, maxW, Math.max(4, barW - 6)).padEnd(Math.max(4, barW - 6))}</Text>{' '}
            {fmt(row.minutes).padStart(6)} min <Text dimColor>· {fmt(row.runs)} runs · {row.avgMinutes.toFixed(1)} min avg · {pct(row.failures, row.runs)}% red</Text>
          </Text>
        ))}
      </Box>
    )

    const odds = (
      <Box flexDirection="column">
        <Text weight="semibold">Odds and ends</Text>
        <Text wrap="wrap">
          Triggers: {report.events.map(ev => `${ev.name} ${fmt(ev.minutes)} min`).join(' · ')}
        </Text>
        <Text tabular>
          When runs start (local hour): <Text color="claude">{sparkline(report.hours)}</Text> <Text dimColor>0→23</Text>
        </Text>
        <Text>
          {fmt(t.jobs)} jobs · {t.computeHours.toFixed(1)} hours of runner time · {fmt(t.failures)} failed · {fmt(t.cancelled)} cancelled · {fmt(t.reruns)} re-runs
        </Text>
      </Box>
    )

    const footer = (
      <Text dimColor size="footnote" wrap="wrap">
        {report.capped.length ? `Days over GitHub's 1,000-run listing cap, so counted short: ${report.capped.join(', ')}. ` : ''}
        Minutes are an estimate of what GitHub bills: each job rounded up to the minute, × the runner's rate (Linux 1, Windows 2, macOS
        10, self-hosted free), credited to whoever triggered the run. Larger runners and the free allowance aren't counted. Days are UTC.
      </Text>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {controls}
        {status}
        {tiles}
        {blurb}
        {people}
        {awards}
        {daily}
        {workflows}
        {odds}
        {footer}
      </Box>
    )
  })
}
