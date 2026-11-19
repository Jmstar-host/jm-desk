import { execFile } from 'node:child_process';
import os from 'node:os';

const PATH = [process.env.PATH, os.homedir() + '/.npm-global/bin', os.homedir() + '/.local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
/* 跑命令拿 stdout；不经 shell，参数不拼接 */
export function run(cmd, args, { timeout = 90000, input } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH, LARK_CLI_NO_UPDATE_NOTICE: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    const p = execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(Object.assign(new Error(String(stderr || err.message).split('\n').filter(l => !/UNDICI|trace-warn|proxy detected/i.test(l)).join(' ').slice(0, 400)), { code: err.code }));
      resolve({ stdout, stderr, code: err ? err.code : 0 });
    });
    if (input) { p.stdin.end(input); }
  });
}
export async function lark(args, opts) {
  const { stdout } = await run('lark-cli', args, opts);
  const i = stdout.indexOf('{');
  if (i < 0) throw new Error('lark-cli 没有返回 JSON');
  return JSON.parse(stdout.slice(i));
}
