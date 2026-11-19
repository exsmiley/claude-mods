'use strict'
// Job-status helper: writes ~/.claude/job-status/<id>.json for the Claude
// "job-status" pane. Protocol: see README.md beside this file.
//
//   const { createStatus } = require(require('os').homedir() + '/.claude/job-status/status.cjs')
//   const st = createStatus({ id: 'shots-2026-11-18', title: 'Screenshot compare', total: 640 })
//   st.start('group/scenario@site')
//   st.finish('group/scenario@site', 'ok' | 'skip' | 'diff' | 'fail', 'optional detail')
//   st.note('lane 3 restarted')
//   st.end('done' | 'failed' | 'stopped')

const fs = require('fs')
const os = require('os')
const path = require('path')

const DIR = process.env.JOB_STATUS_DIR || path.join(os.homedir(), '.claude', 'job-status')
const RECENT_MAX = 20
const NOTES_MAX = 10
const HEARTBEAT_MS = 15000

function safeId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'run'
}

function mergeWatch(a, b) {
  const out = {}
  for (const k of ['docker', 'pids', 'names']) {
    const vals = [...(a[k] || []), ...([].concat(b[k] || []))]
      .map(v => (k === 'pids' ? Number(v) : String(v)))
      .filter(v => (k === 'pids' ? v > 0 : v))
    if (vals.length) out[k] = [...new Set(vals)]
  }
  return out
}

function createStatus(opts = {}) {
  const id = safeId(opts.id || `run-${Date.now()}`)
  const dir = opts.dir || DIR
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.json`)
  const tmp = path.join(dir, `.${id}.${process.pid}.tmp`)
  const now = () => new Date().toISOString()

  const s = {
    version: 1,
    id,
    title: opts.title || id,
    startedAt: now(),
    updatedAt: now(),
    state: 'running',
    total: typeof opts.total === 'number' ? opts.total : null,
    counts: { ok: 0, skip: 0, diff: 0, fail: 0 },
    running: [],
    recent: [],
    notes: [],
    pid: process.pid,
    lanes: opts.lanes || null,
    cwd: opts.cwd || process.cwd(),
    logFile: opts.logFile || null,
    finishedJobs: 0,
    totalJobMs: 0,
  }
  if (opts.counts) Object.assign(s.counts, opts.counts)
  // What else the run's CPU / RAM should include: { docker: ['supabase_*'],
  // pids: [1234], names: ['postgres'] }. See README.md.
  if (opts.watch) s.watch = mergeWatch({}, opts.watch)
  let ended = false

  function write() {
    s.updatedAt = now()
    try {
      fs.writeFileSync(tmp, JSON.stringify(s, null, 1))
      fs.renameSync(tmp, file)
    } catch (err) {
      // Never let status reporting crash the run.
      if (!write.warned) { write.warned = true; console.error(`[job-status] write failed: ${err.message}`) }
    }
  }

  const beat = setInterval(() => { if (!ended) write() }, HEARTBEAT_MS)
  if (beat.unref) beat.unref()
  process.on('exit', () => { if (!ended) { ended = true; s.state = 'stopped'; s.running = []; write() } })

  const api = {
    file,
    id,
    // opts.pid: the job's own process (e.g. child.pid), so the pane can show
    // that job's CPU and memory. The run's total comes from the run's `pid`.
    start(label, opts = {}) {
      label = String(label)
      const row = s.running.find(r => r.label === label)
      const pid = Number(opts.pid)
      if (row) {
        if (pid > 0) row.pid = pid
      } else {
        const next = { label, startedAt: now() }
        if (pid > 0) next.pid = pid
        s.running.push(next)
      }
      write()
    },
    // Add to what the run's usage counts (merges, de-duplicated).
    watch(more) {
      s.watch = mergeWatch(s.watch || {}, more || {})
      write()
    },
    // Set or change a running job's pid after start (spawn often comes later).
    pid(label, pid) {
      const row = s.running.find(r => r.label === String(label))
      if (row && Number(pid) > 0) { row.pid = Number(pid); write() }
    },
    finish(label, status = 'ok', detail) {
      label = String(label)
      status = String(status).toLowerCase()
      const at = now()
      const i = s.running.findIndex(r => r.label === label)
      let ms = null
      if (i >= 0) {
        ms = Date.parse(at) - Date.parse(s.running[i].startedAt)
        s.running.splice(i, 1)
      }
      s.counts[status] = (s.counts[status] || 0) + 1
      if (ms !== null && status !== 'skip') { s.finishedJobs++; s.totalJobMs += ms }
      const row = { label, status, at }
      if (detail !== undefined && detail !== null && detail !== '') row.detail = String(detail).slice(0, 500)
      if (ms !== null) row.ms = ms
      s.recent.push(row)
      if (s.recent.length > RECENT_MAX) s.recent.splice(0, s.recent.length - RECENT_MAX)
      write()
    },
    note(text) {
      s.notes.push(`${now().slice(11, 19)} ${String(text).slice(0, 300)}`)
      if (s.notes.length > NOTES_MAX) s.notes.splice(0, s.notes.length - NOTES_MAX)
      write()
    },
    set(fields) {
      Object.assign(s, fields)
      write()
    },
    end(state = 'done') {
      ended = true
      clearInterval(beat)
      s.state = state
      s.running = []
      s.endedAt = now()
      write()
    },
    remove() {
      ended = true
      clearInterval(beat)
      try { fs.unlinkSync(file) } catch {}
    },
  }
  write()
  return api
}

module.exports = { createStatus, DIR }
