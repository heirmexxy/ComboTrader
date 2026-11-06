// Self-healing: a small watcher thread restarts this process if its main thread stops responding (a task stuck in a
// loop). systemd starts it again within seconds. The website uses a short limit; the background worker a long one,
// because a few of its jobs legitimately take a while.
import { Worker } from 'node:worker_threads';

export function startStallGuard(limitMs: number, label: string) {
  const sab = new SharedArrayBuffer(8);
  const beat = new Float64Array(sab);
  beat[0] = Date.now();
  setInterval(() => { beat[0] = Date.now(); }, 1000).unref();
  const code = `
    const { workerData } = require('node:worker_threads');
    const beat = new Float64Array(workerData.sab);
    setInterval(() => {
      const stuck = Date.now() - beat[0];
      if (stuck > workerData.limit) {
        require('node:fs').writeSync(2, '[stall-guard] ' + workerData.label + ' was stuck for ' + Math.round(stuck / 1000) + 's: restarting it\n');
        process.kill(process.pid, 'SIGKILL');
      }
    }, 5000);`;
  const w = new Worker(code, { eval: true, workerData: { sab, limit: limitMs, label } });
  w.unref();
  return w;
}
