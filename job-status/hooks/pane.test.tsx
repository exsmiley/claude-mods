import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'job-status',
  component: 'Pane',
  requestId: 'job-status',
  props: {
    title: 'Job status',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const NOW = Date.parse('2026-11-18T12:00:00Z')
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString()

const live = {
  id: 'live', title: 'Screenshot compare', state: 'running', total: 10,
  startedAt: iso(600_000), updatedAt: iso(2_000), pid: 4242, lanes: 2,
  counts: { ok: 3, skip: 1, diff: 1, fail: 1 },
  finishedJobs: 5, totalJobMs: 5 * 60_000,
  running: [
    { label: 'grp/slow@site', startedAt: iso(300_000), pid: 4300 },
    { label: 'grp/fresh@site', startedAt: iso(10_000) },
  ],
  recent: [
    { label: 'grp/a@site', status: 'ok', at: iso(50_000) },
    { label: 'grp/b@site', status: 'diff', detail: '412 px differ', at: iso(40_000) },
    { label: 'grp/c@site', status: 'fail', detail: 'Timeout', at: iso(30_000) },
  ],
  notes: ['11:59:00 lane 2 restarted'],
}
const dead = { ...live, id: 'dead', title: 'Dead run', pid: 999, startedAt: iso(900_000) }
const old = {
  ...live, id: 'old', title: 'Old run', state: 'done', pid: 1,
  startedAt: iso(3 * 86_400_000), updatedAt: iso(2 * 86_400_000), endedAt: iso(2 * 86_400_000),
  running: [],
}
const FILES: Record<string, unknown> = { 'live.json': live, 'dead.json': dead, 'old.json': old }

test('the pane draws live, stale and collapsed runs', async ($, on) => {
  on('command.register', () => ({ value: { command: 'job-status' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/home/u' }))
  on('clock.now', () => ({ value: NOW }))
  on('fs.list', () => ({
    value: Object.keys(FILES).map(name => ({ name, kind: 'file', size: 1, mtimeMs: NOW - 5000, isLink: false })),
  }))
  on('fs.read', (_, e) => {
    const name = String((e as { path: string }).path).split('/').pop() ?? ''
    return { value: JSON.stringify(FILES[name]) }
  })
  // ps -A: the run (4242) with one child job process (4300); 999 is not there.
  on('process.run', (_, e) => {
    const argv = (e as { argv: string[] }).argv
    if (argv[0] === 'sysctl') return { value: { exitCode: 0, stdout: '17179869184\n', stderr: '' } }
    return { value: { exitCode: 0, stdout: '    1     0   0.0   1000\n 4242     1 250.0 2097152\n 4300  4242  50.0 1048576\n', stderr: '' } }
  })
  on('clock.every', () => ({ value: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'job-status', args: '' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^Screenshot compare$/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /pid 999 is gone/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /In flight \(2\)/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /⚠ grp\/slow@site/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /412 px differ/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^CPU 300%$/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /RAM 3\.0 GB of 16\.0 GB/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /2 procs/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^50% 1\.0 GB$/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /ETA/ }))?.text).toMatch(/elapsed 10m00s/)
    expect(await ui.find({ type: 'Text', text: /^Old run$/ })).toBeFalsy()
    expect(await ui.findAll({ type: 'Text', text: /In flight/ })).toHaveLength(1)
    await ui.unmount()
  }
})

// A file the real status.cjs wrote mid-run (demo.cjs), pid answered as alive.
const REAL = {"version": 1, "id": "demo-run", "title": "Demo run (30 fake jobs)", "startedAt": "2026-11-19T01:47:31.932Z", "updatedAt": "2026-11-19T01:47:46.933Z", "state": "running", "total": 30, "counts": {"ok": 5, "skip": 0, "diff": 2, "fail": 1}, "running": [{"label": "demo/scenario-07@site-c", "startedAt": "2026-11-19T01:47:38.367Z"}, {"label": "demo/scenario-10@site-b", "startedAt": "2026-11-19T01:47:44.732Z"}, {"label": "demo/scenario-11@site-c", "startedAt": "2026-11-19T01:47:46.409Z"}, {"label": "demo/scenario-12@site-d", "startedAt": "2026-11-19T01:47:46.552Z"}], "recent": [{"label": "demo/scenario-01@site-a", "status": "diff", "at": "2026-11-19T01:47:36.033Z", "detail": "165 px differ", "ms": 4100}, {"label": "demo/scenario-02@site-b", "status": "diff", "at": "2026-11-19T01:47:38.104Z", "detail": "769 px differ", "ms": 6170}, {"label": "demo/scenario-04@site-d", "status": "ok", "at": "2026-11-19T01:47:38.367Z", "ms": 6433}, {"label": "demo/scenario-03@site-c", "status": "fail", "at": "2026-11-19T01:47:38.835Z", "detail": "Timeout waiting for canvas", "ms": 6901}, {"label": "demo/scenario-05@site-a", "status": "ok", "at": "2026-11-19T01:47:40.240Z", "ms": 4207}, {"label": "demo/scenario-09@site-a", "status": "ok", "at": "2026-11-19T01:47:44.731Z", "ms": 4490}, {"label": "demo/scenario-06@site-b", "status": "ok", "at": "2026-11-19T01:47:46.409Z", "ms": 8305}, {"label": "demo/scenario-08@site-d", "status": "ok", "at": "2026-11-19T01:47:46.552Z", "ms": 7716}], "notes": ["01:47:31 demo started on 4 lanes"], "pid": 74230, "lanes": 4, "cwd": "/x", "logFile": null, "finishedJobs": 8, "totalJobMs": 48322}

test('a file status.cjs wrote renders live', async ($, on) => {
  on('command.register', () => ({ value: { command: 'job-status' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/home/u' }))
  on('clock.now', () => ({ value: Date.parse(REAL.updatedAt) + 1000 }))
  on('fs.list', () => ({ value: [{ name: 'demo-run.json', kind: 'file', size: 1, mtimeMs: Date.parse(REAL.updatedAt), isLink: false }] }))
  on('fs.read', () => ({ value: JSON.stringify(REAL) }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: `${REAL.pid} 1 12.5 51200\n`, stderr: '' } }))
  on('clock.every', () => ({ value: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'job-status', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('running')
  expect(texts.some(t => /In flight \(4\)/.test(t))).toBe(true)
  await ui.unmount()
})
