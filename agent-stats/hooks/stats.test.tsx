import { expect, test } from 'claude-code/testing'

import type { History } from '../types'
import { addDays, barChartSvg, daysInRange, mergeDays, summarize } from './stats'

const DAY = (sessions: number, subagents: number, types: Record<string, number> = {}) => ({ sessions, subagents, types })

test('stored days outlive deleted transcripts, fresh counts win', () => {
  const stored = { '2026-09-01': DAY(4, 10), '2026-10-28': DAY(15, 13) }
  const scanned = { '2026-10-28': DAY(15, 14), '2026-10-29': DAY(5, 30) }
  expect(mergeDays(stored, scanned)).toEqual({
    '2026-09-01': DAY(4, 10),
    '2026-10-28': DAY(15, 14),
    '2026-10-29': DAY(5, 30),
  })
  // A day whose transcripts were partly deleted keeps its larger stored count.
  expect(mergeDays({ '2026-10-01': DAY(9, 9) }, { '2026-10-01': DAY(1, 0) })['2026-10-01']).toEqual(DAY(9, 9))
})

test('ranges fill quiet days with zero and cross month ends', () => {
  expect(addDays('2026-10-30', 3)).toBe('2026-11-02')
  const days = { '2026-10-19': DAY(8, 18), '2026-10-29': DAY(5, 30) }
  expect(daysInRange(days, '2026-10-29', 14)).toHaveLength(14)
  expect(daysInRange(days, '2026-10-29', 0)).toHaveLength(11)

  const summary = summarize(days, daysInRange(days, '2026-10-29', 0))
  expect(summary.activeDays).toBe(2)
  expect(summary.subagentsPerDay).toBe(24)
  expect(summary.busiest?.day).toBe('2026-10-29')
})

test('the chart has a tooltip per day and labels its peak', () => {
  const svg = barChartSvg(
    [
      { day: '2026-10-27', value: 24 },
      { day: '2026-10-28', value: 0 },
      { day: '2026-10-29', value: 30 },
    ],
    400,
    'subagent',
  )
  expect(svg.match(/<title>/g)?.length).toBe(3)
  expect(svg).toContain('<title>Oct 28: 0 subagents</title>')
  expect(svg.match(/class="bar"/g)?.length).toBe(2)
  expect(svg).toContain('>30</text>')
})

const HISTORY: History = {
  days: { '2026-10-27': DAY(3, 24, { 'general-purpose': 24 }), '2026-10-29': DAY(5, 30, { 'qa-tester-1': 12 }) },
  scannedAt: 0,
}

const PANE = {
  plugin: 'agent-stats',
  component: 'Pane',
  requestId: 'agent-stats',
  props: {
    title: 'Agent stats',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('the pane draws the stats on every surface', async ($, on) => {
  on('state.get', (_, e, next) =>
    e.key === 'history' ? { value: { value: { shape: 'history-1', value: HISTORY }, version: 1 } } : next(e),
  )

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /per active day/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /general-purpose/ })).toBeDefined()
    if (surface !== 'terminal') expect(await ui.find({ type: 'Svg' })).toBeDefined()
    await ui.unmount()
  }
})

test('before the first read the pane says so', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('Reading your transcripts…')
  await ui.unmount()
})
