// Fake run of ~30 jobs on 4 lanes, for checking the job-status pane.
// node ~/.claude/job-status/demo.cjs [jobs] [--keep]
const { createStatus } = require('./status.cjs')
const N = Number(process.argv[2]) || 30
const keep = process.argv.includes('--keep')
const st = createStatus({ id: 'demo-run', title: `Demo run (${N} fake jobs)`, total: N, lanes: 4 })
const jobs = Array.from({ length: N }, (_, i) => `demo/scenario-${String(i + 1).padStart(2, '0')}@site-${'abcd'[i % 4]}`)
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function lane(n) {
  while (jobs.length) {
    const label = jobs.shift()
    st.start(label)
    const slow = label.endsWith('07@site-c') // one job runs unusually long
    await sleep(slow ? 40000 : 3000 + Math.random() * 6000)
    const r = Math.random()
    const status = r < 0.1 ? 'skip' : r < 0.22 ? 'diff' : r < 0.27 ? 'fail' : 'ok'
    st.finish(label, status, status === 'diff' ? `${Math.round(Math.random() * 900)} px differ` : status === 'fail' ? 'Timeout waiting for canvas' : undefined)
  }
}
;(async () => {
  st.note('demo started on 4 lanes')
  await Promise.all([1, 2, 3, 4].map(lane))
  st.note('demo finished')
  st.end('done')
  if (!keep) { await sleep(20000); st.remove() }
})()
