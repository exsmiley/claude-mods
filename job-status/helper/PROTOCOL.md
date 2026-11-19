# job-status: live status for long-running runs

Any script can show its progress in Claude's **Job status** pane (the `job-status`
mod; open it with `/job-status`). The pane polls this folder every ~2.5 s.

## Protocol

One JSON file per run: `~/.claude/job-status/<run-id>.json`.
Rewrite it **atomically** on every change: write `.<run-id>.<pid>.tmp` in this
folder, then `rename` it over the real file. Files starting with `.` are ignored.

```jsonc
{
  "version": 1,
  "id": "shots-2026-11-18",          // filename-safe: [A-Za-z0-9._-]
  "title": "Screenshot compare",
  "startedAt": "2026-11-18T20:00:00Z", // ISO string or epoch ms
  "updatedAt": "2026-11-18T20:41:12Z", // bump at least every 60 s while running (heartbeat)
  "endedAt": "…",                       // optional, set when state leaves "running"
  "state": "running",                   // running | done | failed | stopped
  "total": 640,                         // optional; enables the progress bar and ETA
  "counts": { "ok": 400, "skip": 5, "diff": 6, "fail": 1 }, // any extra keys are shown too
  "running": [{ "label": "group/scenario@site", "startedAt": "…", "pid": 12399 }], // pid optional: per-job CPU/RAM
  "recent":  [{ "label": "…", "status": "diff", "detail": "412 px differ", "at": "…", "ms": 84000 }], // last ~20, oldest first
  "notes":   ["20:40:01 lane 3 restarted"],  // last ~10
  "pid": 12345,                         // the writer's pid; the pane marks the run stale when it is gone
  "lanes": 8,                           // optional: parallelism, used for early ETA
  "finishedJobs": 410, "totalJobMs": 34440000, // optional: for the average job time (skips excluded)
  "cwd": "…", "logFile": "…",           // optional; their folders help find the run's processes
  "dirs": ["/path/to/runner/folder"],   // optional: processes whose command line names one count
  "session": {                          // optional: the Claude session that started the run
    "hostId": "local_…",                //   desktop app session ($CLAUDE_CODE_HOST_SESSION_ID): the title links to it
    "id": "…"                           //   Claude Code session ($CLAUDE_CODE_SESSION_ID): shown for `claude --resume`
  },
  "watch": {                            // optional extras; rarely needed (see below)
    "docker": ["supabase_*_my-stack"],  //   containers by name; `*` wildcard, no `*` = substring
    "pids": [23456],                    //   other process roots
    "names": ["postgres"]               //   processes whose executable path contains this
  }
}
```

Done = sum of `counts`. Status strings are free-form, lowercase; `ok`, `skip`,
`diff`, `fail` are coloured (diff = warning, fail/error = red).

With `session.hostId` the pane shows an **open session ↗** link under the
run's title, which switches the Claude desktop app to the session that started
the run (`claude://code/continue?session=<hostId>`). With only `session.id` it
shows the `claude --resume <id>` command instead. The helper fills both from the
environment that Claude Code gives every command it runs.

The pane marks a `running` run **stale** when its `pid` no longer exists or
`updatedAt` is more than 90 s old. Finished runs older than a day collapse into
one line. Delete a run's file to remove it from the pane.

### CPU and memory

Nothing needs declaring. Each poll the pane finds what a run uses:

1. its `pid`, that pid's process group, and every process under them;
2. any process whose command line names one of the run's folders (`dirs`,
   `cwd`, the `logFile`'s folder): detached workers whose parent is gone
   still name the script or folder they run from;
3. whatever those processes connect to on localhost (`lsof`), followed up to
   3 hops: a dev server, a database, and **Docker containers** publishing
   those ports, with every other container on the same Docker network (a
   Supabase stack's auth, rest, storage… behind Kong). Links stick for the
   session, so a run that talked to a stack once keeps it.

The pane shows **Procs** (CPU, RAM, process count), **Docker** (the run's
containers at host cost: their share of the Docker VM's own CPU and RAM, since
`docker stats` sees only what is inside the VM), **Total** with the peak, and a
dim `counted:` line saying what it found and how. A **Machine** block at the
top shows the whole machine, all of Docker (inside and the VM), and the top
apps by CPU and RAM. A running job with its own `pid` gets its own CPU / RAM
beside its row. CPU% is `ps`'s (100% = one core). RAM is RSS summed over
processes, so memory shared between processes (Chromium's) is counted once per
process and reads high.

`watch` adds what the pane can't find this way (containers the run never
connects to, a process that names none of its folders).

## Node helper

```js
const { createStatus } = require(require('os').homedir() + '/.claude/job-status/status.cjs')
const st = createStatus({ id: 'shots-2026-11-18', title: 'Screenshot compare', total: 640, lanes: 8,
  logFile: '/path/to/run.log' })                // optional; dirs default to this script's folder
st.watch({ pids: [otherPid] })                  // optional extras (merges); rarely needed
st.start('group/scenario@site')                 // job began
st.start('group/scenario@site', { pid: child.pid }) // …or with the job's own process
st.pid('group/scenario@site', child.pid)        // set it later, once spawned
st.finish('group/scenario@site', 'diff', '412 px differ') // ok | skip | diff | fail | anything
st.note('lane 3 restarted')
st.set({ total: 650 })                          // merge any top-level fields
st.end('done')                                  // done | failed | stopped
st.remove()                                     // optional: delete the file
```

The helper writes atomically, heartbeats every 15 s (unref'd timer), never
throws on write errors, and on process `exit` without `end()` marks the run
`stopped`. `JOB_STATUS_DIR` overrides the folder. Other languages: just write
the JSON above with temp-file + rename.

**One writer per id.** If a run is restarted under the same id while the old
process is still alive, both would rewrite the file and the pane would flip
between them (counts, total and ETA jumping every few seconds). The helper
checks before each write: when another live process owns the file for a newer
run, it stops writing. The pane also warns when it sees two live pids write one
id, naming the older one to stop. A writer not using the helper should give
each run its own id, or stop the old writer first.
