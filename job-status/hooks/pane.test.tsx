import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'job-status',
  component: 'Pane',
  requestId: 'job-status',
  props: {
    title: 'Job status',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const NOW = Date.parse('2026-11-18T12:00:00Z')
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString()

// A machine like the one this was built on: the status file is written by a
// small watcher (4242) that has no children; the runner (6000) and its job
// processes are detached from it but name the run's folder; the jobs talk
// to a dev server (7000, parent pid 1) on :3051, which talks to a Supabase
// stack in Docker on :54321. 8000 and the other stack are someone else's.
type P = { pid: number; ppid: number; pgid: number; cpu: number; rss: number; comm: string; cmd?: string }
const PROCS: P[] = [
  { pid: 1, ppid: 0, pgid: 1, cpu: 0, rss: 1000, comm: '/sbin/launchd' },
  { pid: 4242, ppid: 1, pgid: 4241, cpu: 1, rss: 51200, comm: '/usr/local/bin/node', cmd: 'node -e require(process.argv[1]) /work/scen/status-watch.cjs' },
  { pid: 6000, ppid: 900, pgid: 6000, cpu: 10, rss: 102400, comm: '/usr/local/bin/node', cmd: 'node /work/scen/final.cjs /work/scen/jobs.json /work/scen/out-final --lanes 2' },
  { pid: 6001, ppid: 6000, pgid: 6000, cpu: 40, rss: 204800, comm: '/usr/local/bin/node', cmd: 'node /work/scen/sh-harness.cjs --b http://localhost:3051' },
  { pid: 6002, ppid: 6001, pgid: 6002, cpu: 150, rss: 1048576, comm: '/Users/u/Library/Caches/ms-playwright/chromium/chrome-headless-shell' },
  { pid: 7000, ppid: 1, pgid: 7000, cpu: 100, rss: 1048576, comm: '/usr/local/bin/node', cmd: 'next-server (v16.4.6)' },
  { pid: 8000, ppid: 1, pgid: 8000, cpu: 30, rss: 512000, comm: '/usr/local/bin/node', cmd: 'node /elsewhere/app.js' },
  { pid: 31422, ppid: 1, pgid: 31422, cpu: 120, rss: 6291456, comm: '/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine' },
  { pid: 9000, ppid: 1, pgid: 9000, cpu: 5, rss: 600000, comm: '/Applications/Claude.app/Contents/MacOS/Claude' },
]
const DOCKER_STATS = [
  { Name: 'supabase_kong_x', CPUPerc: '20.00%', MemUsage: '256MiB / 23.44GiB' },
  { Name: 'supabase_auth_x', CPUPerc: '80.00%', MemUsage: '768MiB / 23.44GiB' },
  { Name: 'supabase_kong_other', CPUPerc: '100.00%', MemUsage: '1GiB / 23.44GiB' },
].map(o => JSON.stringify(o)).join('\n')
const DOCKER_PS = [
  { Names: 'supabase_kong_x', Ports: '0.0.0.0:54321->8000/tcp, [::]:54321->8000/tcp', Networks: 'supabase_network_x' },
  { Names: 'supabase_auth_x', Ports: '9999/tcp', Networks: 'supabase_network_x' },
  { Names: 'supabase_kong_other', Ports: '0.0.0.0:54581->8000/tcp', Networks: 'supabase_network_other' },
].map(o => JSON.stringify(o)).join('\n')
const VM_STAT = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages active:   262144.\nPages wired down:   131072.\nPages occupied by compressor:   131072.\n'
const LISTEN = [
  'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
  'node 7000 u 20u IPv4 0x1 0t0 TCP 127.0.0.1:3051 (LISTEN)',
  'node 8000 u 20u IPv4 0x2 0t0 TCP *:4061 (LISTEN)',
  'com.docke 500 u 30u IPv6 0x3 0t0 TCP *:54321 (LISTEN)',
].join('\n')
// Who holds a connection to what, by pid.
const CONNECTS: Record<number, string> = {
  6001: 'node 6001 u 30u IPv4 0x4 0t0 TCP 127.0.0.1:50000->127.0.0.1:3051 (ESTABLISHED)',
  7000: 'node 7000 u 31u IPv4 0x5 0t0 TCP 127.0.0.1:50001->127.0.0.1:54321 (ESTABLISHED)',
  9000: 'Claude 9000 u 32u IPv4 0x6 0t0 TCP 127.0.0.1:50002->127.0.0.1:4061 (ESTABLISHED)',
}

/** deep links the pane asked macOS to open */
const OPENED: string[] = []
/** the run files the world holds; `mv` takes them out */
let FILES: Record<string, unknown> = {}
const MOVED: string[][] = []
/** gh calls the pane made */
const GH: string[][] = []

const host = (procs: P[]) => (_: unknown, e: unknown) => {
  const argv = (e as { argv: string[] }).argv
  const out = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
  switch (argv[0]) {
    case 'ps':
      return argv[3]?.includes('pgid')
        ? out(procs.map(p => ` ${p.pid} ${p.ppid} ${p.pgid} ${p.cpu.toFixed(1)} ${p.rss} ${p.comm}`).join('\n'))
        : out(procs.map(p => ` ${p.pid} ${p.cmd ?? p.comm}`).join('\n'))
    case 'sysctl':
      return out(argv[2] === 'hw.ncpu' ? '8\n' : '17179869184\n')
    case 'mv': {
      MOVED.push(argv.slice(2))
      for (const src of argv.slice(2, -1)) delete FILES[src.split('/').pop() ?? '']
      return out('')
    }
    case 'gh': {
      GH.push(argv)
      const branch = argv[argv.indexOf('--head') + 1]
      const prs: Record<string, unknown[]> = {
        'zach/merged': [{ state: 'CLOSED', number: 11 }, { state: 'MERGED', number: 12, url: 'https://github.com/o/r/pull/12' }],
        'zach/open': [{ state: 'OPEN', number: 13 }],
      }
      return out(JSON.stringify(prs[branch ?? ''] ?? []))
    }
    case 'open':
      OPENED.push(argv[1] ?? '')
      return out('')
    case 'vm_stat':
      return out(VM_STAT)
    case 'docker':
      return out(argv[1] === 'ps' ? DOCKER_PS : DOCKER_STATS)
    case 'lsof': {
      if (argv.includes('-sTCP:LISTEN')) return out(LISTEN)
      const pids = (argv[argv.indexOf('-p') + 1] ?? '').split(',').map(Number)
      return out(['COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME', ...pids.flatMap(p => CONNECTS[p] ?? [])].join('\n'))
    }
    default:
      return out('')
  }
}

const live = {
  id: 'live', title: 'Screenshot compare', state: 'running', total: 10,
  startedAt: iso(600_000), updatedAt: iso(2_000), pid: 4242, lanes: 2,
  cwd: '/work/proj/web', logFile: '/work/scen/out-final/final.log',
  counts: { ok: 3, skip: 1, diff: 1, fail: 1 },
  finishedJobs: 5, totalJobMs: 5 * 60_000,
  running: [
    { label: 'grp/slow@site', startedAt: iso(300_000), pid: 6001 },
    { label: 'grp/fresh@site', startedAt: iso(10_000) },
  ],
  recent: [
    { label: 'grp/a@site', status: 'ok', at: iso(50_000) },
    { label: 'grp/b@site', status: 'diff', detail: '412 px differ', at: iso(40_000) },
    { label: 'grp/c@site', status: 'fail', detail: 'Timeout', at: iso(30_000) },
  ],
  notes: ['11:59:00 lane 2 restarted'],
  session: { hostId: 'local_abc-123', id: 'cafe-0001' },
}
const dead = { ...live, id: 'dead', title: 'Dead run', pid: 999, startedAt: iso(900_000), session: { id: 'beef-0002', hostId: 'not a desktop id' } }
const old = {
  ...live, id: 'old', title: 'Old run', state: 'done', pid: 1,
  startedAt: iso(3 * 86_400_000), updatedAt: iso(2 * 86_400_000), endedAt: iso(2 * 86_400_000),
  running: [],
}

/** pane opens the mod asked for */
let OPENS = 0
/** the mod's $.store, kept across engines */
let STORE: Record<string, unknown> = {}

type WorldOpts = {
  /** the clock, when a test moves it */
  clock?: () => number
  /** answers a process.run first; undefined falls through to the host */
  run?: (argv: string[]) => unknown
  /** stands in for fs.list */
  list?: () => unknown
  /** what an earlier engine of this session stored */
  store?: Record<string, unknown>
  /** the engine's open panes; none in a fresh engine */
  panes?: () => unknown[]
  /** clock.sleep returns at once; by default it never does, so /job-status waits for its poll */
  isSleepInstant?: boolean
}

function world(on: (event: string, hook: (...a: never[]) => unknown) => unknown, files: Record<string, unknown>, procs: P[], now = NOW, opts: WorldOpts = {}) {
  FILES = files
  MOVED.length = 0
  OPENS = 0
  STORE = opts.store ?? {}
  on('command.register', () => ({ value: { command: 'job-status' } }))
  on('ui.open', () => {
    OPENS++
    return { value: { isPlaced: true } }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('env.get', () => ({ value: '/home/u' }))
  on('clock.now', () => ({ value: opts.clock ? opts.clock() : now }))
  on('clock.every', () => ({ value: {} }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.attach', (_: unknown, e: { clientId: string }) => ({ clientId: e.clientId }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: opts.panes?.() ?? [] }))
  on('store.get', (_: unknown, e: { key: string }) => ({ value: STORE[e.key] }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    STORE[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(STORE) }))
  on('store.delete', (_: unknown, e: { key: string }) => {
    delete STORE[e.key]
    return { value: undefined }
  })
  on('clock.sleep', () => (opts.isSleepInstant ? { value: undefined } : new Promise(() => {})))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', opts.list ?? (() => ({
    value: Object.keys(files).map(name => ({ name, kind: 'file', size: 1, mtimeMs: now - 5000, isLink: false })),
  })))
  on('fs.read', (_: unknown, e: { path: string }) => ({ value: JSON.stringify(files[e.path.split('/').pop() ?? '']) }))
  const fromHost = host(procs)
  on('process.run', ((_: unknown, e: { argv: string[] }) => opts.run?.(e.argv) ?? fromHost(_, e)) as never)
}

const RUN = { command: 'job-status', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

test('a run counts its detached jobs, the dev server they use, and that server\'s Docker stack', async ($, on) => {
  world(on as never, { 'live.json': live, 'dead.json': dead, 'old.json': old }, PROCS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // first poll starts docker sampling; the next ones use it
  await $.command.run(RUN)
  await $.command.run(RUN)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const has = (re: RegExp) => expect(texts.some(t => re.test(t))).toBe(true)

    has(/^Screenshot compare$/)
    // the live run links to its desktop session; the dead one has only a CLI id
    const opens = (await ui.findAll({ type: 'Button' })).filter(b => /open session/.test(b.text ?? ''))
    expect(opens).toHaveLength(1)
    OPENED.length = 0
    await ui.press({ key: 'open-live' })
    expect(OPENED).toEqual(['claude://code/continue?session=local_abc-123'])
    has(/^claude --resume beef-0002$/)
    has(/pid 999 is gone/)
    has(/In flight \(2\)/)
    has(/⚠ grp\/slow@site/)
    has(/412 px differ/)
    has(/elapsed 10m00s/)
    expect(texts.some(t => /^Old run$/.test(t))).toBe(false)

    // processes: the watcher, the runner tree found by folder, and the dev
    // server found through the connection; not 8000, not Claude
    has(/^Procs  CPU 301%  ·  RAM 2\.3 GB  ·  5 procs$/)
    // Docker: the run's stack only, at its share of the VM (half of 120% / 6 GB)
    has(/^Docker CPU 60%  ·  RAM 3\.0 GB  ·  2 containers  \(share of Docker VM\)$/)
    has(/^Total  CPU 361%  ·  $/)
    has(/^RAM 5\.3 GB of 16\.0 GB$/)
    has(/^counted: 1 in its process tree; 3 by folder or name; 1 it connects to \(localhost:3051\); 2 containers \(supabase_network_x\)$/)
    // a job's own process
    has(/^190% 1\.2 GB$/)
    // machine
    has(/^Machine  CPU 57% of 8 cores  ·  RAM 8\.0 GB of 16\.0 GB used$/)
    has(/^Docker   3 containers  ·  inside CPU 200%, RAM 2\.0 GB  ·  VM CPU 120%, RAM 6\.0 GB$/)
    has(/^Docker VM$/)
    await ui.unmount()
  }
})

// A file the real status.cjs wrote mid-run (demo.cjs), its pid alive.
const REAL = {"version": 1, "id": "demo-run", "title": "Demo run (30 fake jobs)", "startedAt": "2026-11-19T01:47:31.932Z", "updatedAt": "2026-11-19T01:47:46.933Z", "state": "running", "total": 30, "counts": {"ok": 5, "skip": 0, "diff": 2, "fail": 1}, "running": [{"label": "demo/scenario-07@site-c", "startedAt": "2026-11-19T01:47:38.367Z"}, {"label": "demo/scenario-10@site-b", "startedAt": "2026-11-19T01:47:44.732Z"}, {"label": "demo/scenario-11@site-c", "startedAt": "2026-11-19T01:47:46.409Z"}, {"label": "demo/scenario-12@site-d", "startedAt": "2026-11-19T01:47:46.552Z"}], "recent": [{"label": "demo/scenario-01@site-a", "status": "diff", "at": "2026-11-19T01:47:36.033Z", "detail": "165 px differ", "ms": 4100}, {"label": "demo/scenario-02@site-b", "status": "diff", "at": "2026-11-19T01:47:38.104Z", "detail": "769 px differ", "ms": 6170}, {"label": "demo/scenario-04@site-d", "status": "ok", "at": "2026-11-19T01:47:38.367Z", "ms": 6433}, {"label": "demo/scenario-03@site-c", "status": "fail", "at": "2026-11-19T01:47:38.835Z", "detail": "Timeout waiting for canvas", "ms": 6901}, {"label": "demo/scenario-05@site-a", "status": "ok", "at": "2026-11-19T01:47:40.240Z", "ms": 4207}, {"label": "demo/scenario-09@site-a", "status": "ok", "at": "2026-11-19T01:47:44.731Z", "ms": 4490}, {"label": "demo/scenario-06@site-b", "status": "ok", "at": "2026-11-19T01:47:46.409Z", "ms": 8305}, {"label": "demo/scenario-08@site-d", "status": "ok", "at": "2026-11-19T01:47:46.552Z", "ms": 7716}], "notes": ["01:47:31 demo started on 4 lanes"], "pid": 74230, "lanes": 4, "cwd": "/x", "logFile": null, "finishedJobs": 8, "totalJobMs": 48322}

test('a file status.cjs wrote renders live', async ($, on) => {
  const at = Date.parse(REAL.updatedAt) + 1000
  world(on as never, { 'demo-run.json': REAL }, [
    ...PROCS,
    { pid: REAL.pid, ppid: 1, pgid: REAL.pid, cpu: 12.5, rss: 51200, comm: '/usr/local/bin/node', cmd: 'node demo.cjs' },
  ], at)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('running')
  expect(texts.some(t => /In flight \(4\)/.test(t))).toBe(true)
  expect(texts.some(t => /^CPU 13%  ·  RAM 50 MB  ·  1 proc$/.test(t))).toBe(true)
  await ui.unmount()
})

test('two live processes writing one id are called out', async ($, on) => {
  // The file flips between an old run (4242) and a restarted one (6000).
  const older = { ...live, id: 'flip', pid: 4242, startedAt: iso(3_600_000), total: 644 }
  const newer = { ...live, id: 'flip', pid: 6000, startedAt: iso(600_000), total: 249 }
  let reads = 0
  const files = {} as Record<string, unknown>
  Object.defineProperty(files, 'flip.json', { enumerable: true, get: () => (reads++ % 2 ? older : newer) })
  world(on as never, files, PROCS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(RUN)
  await $.command.run(RUN)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.some(t => /^⚠ 2 live processes write this file \(pids \d+, \d+\); .* Stop the older one \(pid 4242\)\.$/.test(t))).toBe(true)
  await ui.unmount()
})

test('finished runs clear from the pane, by hand or after a week', async ($, on) => {
  const ancient = { ...old, id: 'ancient', title: 'Ancient run', startedAt: iso(9 * 86_400_000), updatedAt: iso(8 * 86_400_000), endedAt: iso(8 * 86_400_000) }
  world(on as never, { 'live.json': live, 'dead.json': dead, 'old.json': old, 'ancient.json': ancient }, PROCS)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(RUN)

  // a week-old finished run is moved out on its own, not deleted
  expect(MOVED).toEqual([['/home/u/.claude/job-status/ancient.json', '/home/u/.claude/job-status/.cleared/']])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const buttons = async () => (await ui.findAll({ type: 'Button' })).map(b => b.text ?? '')
  // the live run has no clear button; the stale and the old one do, and both together
  expect((await buttons()).filter(t => /✕ clear$/.test(t))).toHaveLength(1) // old run is folded away
  expect(await buttons()).toContain('✕ clear 2 finished runs')

  await ui.press({ key: 'clear-dead' })
  expect(MOVED.at(-1)).toEqual(['/home/u/.claude/job-status/dead.json', '/home/u/.claude/job-status/.cleared/'])
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts.some(t => /^Dead run$/.test(t))).toBe(false)
  expect(texts.some(t => /^Screenshot compare$/.test(t))).toBe(true)

  const r = await $.command.run({ ...RUN, args: 'clear' })
  expect(r).toMatchObject({ text: 'Cleared 1 finished run(s) into ~/.claude/job-status/.cleared.' })
  expect(Object.keys(FILES)).toEqual(['live.json'])
  await ui.unmount()
})

test('a finished run clears once its branch\'s PR is merged; open PRs and live runs stay', async ($, on) => {
  const done = { ...live, state: 'done', endedAt: iso(60_000), running: [] }
  const files = {
    'merged.json': { ...done, id: 'merged', title: 'Merged run', git: { root: '/work/proj', branch: 'zach/merged' } },
    'open.json': { ...done, id: 'open', title: 'Open run', git: { root: '/work/proj', branch: 'zach/open' } },
    'onmain.json': { ...done, id: 'onmain', title: 'Main run', git: { root: '/work/proj', branch: 'main' } },
    'live.json': { ...live, git: { root: '/work/proj', branch: 'zach/merged' } },
  }
  world(on as never, files, PROCS)
  GH.length = 0
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run(RUN) // starts the lookups
  await $.command.run(RUN) // acts on them

  // gh is asked only about finished runs on their own branches, in their checkout
  expect(GH.map(a => a[a.indexOf('--head') + 1]).sort()).toEqual(['zach/merged', 'zach/open'])
  expect(MOVED).toEqual([['/home/u/.claude/job-status/merged.json', '/home/u/.claude/job-status/.cleared/']])
  expect(Object.keys(FILES).sort()).toEqual(['live.json', 'onmain.json', 'open.json'])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('PR #13 open')
  expect(texts.some(t => /^Merged run$/.test(t))).toBe(false)
  await ui.unmount()
})

test('a poll that never settles is abandoned, and /job-status still answers', async ($, on) => {
  let t = NOW
  let isHung = true
  const hung: ((v: unknown) => void)[] = []
  world(on as never, { 'live.json': live }, PROCS, NOW, {
    clock: () => t,
    // ps never answers while hung: the poll it is in can't finish
    run: argv => (argv[0] === 'ps' && isHung ? new Promise(resolve => hung.push(resolve)) : undefined),
    isSleepInstant: true,
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // the pane opens before the poll, and the command answers without it
  const first = await $.command.run(RUN)
  expect(OPENS).toBeGreaterThan(0)
  expect(first).toMatchObject({ text: expect.stringContaining('showing the last results') })
  // let the poll reach the ps that never answers; later commands wait on it
  for (let i = 0; i < 50 && hung.length === 0; i++) await $.command.run(RUN)
  expect(hung.length).toBeGreaterThan(0)
  const stuck = await $.command.run(RUN)
  expect(stuck).toMatchObject({ text: expect.stringContaining('showing the last results') })

  // past the time limit the next poll starts over and draws the live run
  t += 60_000
  isHung = false
  const isDrawn = (r: unknown) => /\(1 run\(s\), 1 live\)/.test(String((r as { text?: string }).text))
  const abandoned = await $.command.run(RUN)
  expect(abandoned).toMatchObject({ text: expect.stringContaining('The last poll was stuck for 1m00s; started a new one.') })
  let last = abandoned
  for (let i = 0; i < 50 && !isDrawn(last); i++) last = await $.command.run(RUN)
  expect(isDrawn(last)).toBe(true)

  // release the stuck calls: mounting waits while any call is pending
  for (const resolve of hung) resolve({ value: { exitCode: 0, stdout: '', stderr: '' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(x => x.text)
  expect(texts).toContain('Screenshot compare')
  expect(texts).toContain('running')
  await ui.unmount()
})

test('a folder the pane cannot read is said, not shown as empty', async ($, on) => {
  world(on as never, {}, PROCS, NOW, {
    list: () => ({ deny: 'EACCES: permission denied' }),
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await $.command.run(RUN)
  expect(r).toMatchObject({ text: expect.stringContaining("Couldn't read /home/u/.claude/job-status") })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(x => x.text)
  expect(texts.some(x => /^Couldn't read \/home\/u\/\.claude\/job-status: .*EACCES/.test(x))).toBe(true)
  await ui.unmount()
})

const DONE = { 'old.json': { ...old, updatedAt: iso(60_000), endedAt: iso(60_000) } }
const memory = (isOpen: boolean, openedFor: string[] = []) => ({ 'pane:sess-1': { isOpen, openedFor, at: NOW - 60_000 } })

test('a fresh engine reopens a pane that was open, with no live run', async ($, on) => {
  world(on as never, DONE, PROCS, NOW, { store: memory(true) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(OPENS).toBe(1)
})

test('a pane the person closed stays closed in a fresh engine, even with its run live', async ($, on) => {
  world(on as never, { 'live.json': live }, PROCS, NOW, { store: memory(false, ['live']) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.attach({ surface: 'desktop', clientId: 'd' })
  await $.command.run({ ...RUN, args: 'clear' }) // waits for a poll to finish, opens nothing itself
  expect(OPENS).toBe(0)
})

test('attaching reopens a pane the engine lost, and leaves one it has', async ($, on) => {
  let panes: unknown[] = []
  world(on as never, DONE, PROCS, NOW, { panes: () => panes })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(OPENS).toBe(0)
  await $.command.run(RUN) // opens, and is remembered
  expect(OPENS).toBe(1)
  panes = [{ id: 'job-status', title: 'Job status', isShown: true, isFocused: false, isPlaced: true }]
  await $.session.attach({ surface: 'desktop', clientId: 'd' })
  expect(OPENS).toBe(1)
  panes = []
  await $.session.attach({ surface: 'desktop', clientId: 'd' })
  expect(OPENS).toBe(2)
})

test('memory of a session not seen for a month is dropped', async ($, on) => {
  world(on as never, {}, PROCS, NOW, { store: { 'pane:gone': { isOpen: true, openedFor: [], at: NOW - 40 * 86_400_000 }, ...memory(false) } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (let i = 0; i < 200 && 'pane:gone' in STORE; i++) await Promise.resolve()
  expect(Object.keys(STORE)).toEqual(['pane:sess-1'])
})
