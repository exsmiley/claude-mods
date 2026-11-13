import { expect, test } from 'claude-code/testing'

import type { Run, View } from '../types'
import { buildReport, daysToFetch, monthDays, parseArgs, summaryText } from './data'

const PANE = {
  plugin: 'actions-report',
  component: 'Pane',
  requestId: 'actions-report',
  props: { title: 'Actions report', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const run = (over: Partial<Run>): Run => ({
  w: 'CI', u: 'ada', e: 'pull_request', c: 'success', a: 1, t: '2026-11-02T15:00:00Z', h: 10, wd: 0, m: 3, j: 2, s: 150, r: 90,
  ...over,
})

test('args come in any order', () => {
  expect(parseArgs('2026-10 acme/app')).toEqual({ month: '2026-10', repo: 'acme/app' })
  expect(parseArgs('')).toEqual({})
})

test('only uncached days and the last few are fetched again', () => {
  const all = monthDays('2026-11', '2026-11-05')
  expect(all).toHaveLength(5)
  const cached = { '2026-11-01': [], '2026-11-02': [], '2026-11-03': [], '2026-11-04': [] }
  expect(daysToFetch(all, cached, '2026-11-05')).toEqual(['2026-11-03', '2026-11-04', '2026-11-05'])
  expect(monthDays('2026-02', '2026-03-10')).toHaveLength(28)
})

test('minutes add up per person and the awards go to the right people', () => {
  const days = {
    '2026-11-01': [run({ m: 10 }), run({ u: 'bob', c: 'failure', a: 2, h: 23, m: 4 }), run({ u: 'dependabot[bot]', m: 1 })],
    '2026-11-02': [run({ u: 'bob', c: 'cancelled', wd: 6, m: 2, r: 1800, w: 'E2E' })],
  }
  const report = buildReport('acme/app', '2026-11', '2026-11-02', days, [], 0)
  expect(report.totals.minutes).toBe(17)
  expect(report.totals.runs).toBe(4)
  expect(report.totals.projected).toBe(255)
  expect(report.users.map(user => [user.login, user.minutes])).toEqual([
    ['ada', 10],
    ['bob', 6],
    ['dependabot[bot]', 1],
  ])
  const winners = Object.fromEntries(report.awards.map(award => [award.title, award.winner]))
  expect(winners['Minute Muncher']).toBe('ada')
  expect(winners['The Red Button']).toBe('bob')
  expect(winners['Groundhog Day']).toBe('bob')
  expect(winners['Night Owl']).toBe('bob')
  expect(winners['Weekend Warrior']).toBe('bob')
  expect(winners['Robot Overlord']).toBe('dependabot[bot]')
  expect(winners['The Marathon']).toBe('E2E')
  expect(report.byDay).toEqual([
    { day: '2026-11-01', value: 15 },
    { day: '2026-11-02', value: 2 },
  ])
  expect(summaryText(report)).toContain('ada: 10 min (59%)')
})

test('the pane draws a report on every surface', async ($, on) => {
  const days = { '2026-11-01': [run({}), run({ u: 'bob', c: 'failure' })] }
  const report = buildReport('acme/app', '2026-11', '2026-11-01', days, [], 0)
  const seeded: View = { report, repo: 'acme/app', month: '2026-11', status: 'idle', blurb: 'What a month!' }
  on('state.get', () => ({ value: { value: { shape: 'view-1', value: seeded }, version: 1 } }))
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Minute Muncher/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /What a month/ })).toBeDefined()
    await ui.unmount()
  }
})
