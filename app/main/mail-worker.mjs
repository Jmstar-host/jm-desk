/* 工作线程：在主进程之外读 Mailspring 本地库 */
import { parentPort } from 'node:worker_threads';
import * as mail from './mail.mjs';
parentPort.on('message', async ({ id, fn, args }) => {
  try {
    if (!['stats', 'collect'].includes(fn)) throw new Error('unknown');
    parentPort.postMessage({ id, ok: true, data: await mail[fn](...args) });
  } catch (e) { parentPort.postMessage({ id, ok: false, error: e.message || String(e) }); }
});
