#!/usr/bin/env node
/* jm-desk：桌面 AI 空间的收集器
 *   collect   增量收集已授权的信息源 → 本地 outbox
 *   submit    把 outbox 里待搬运的信号送到 MP2（未配置 MP2 时跳过）
 *   run       collect + submit（精灵每 6 小时调用这个）
 *   status    当前授权、游标、待搬运数量
 *   ticker    最近的搬运记录（给精灵气泡）
 *   sources <name> on|off   开关某个信息源
 *   link <MP2 地址> [--no-open]   关联需求管理平台账号（显示 8 位代码，打开确认页，等待允许）
 *   link-status | unlink          查看 / 断开（只删本机凭据；撤销在 MP2「AI 接入」页）
 * 加 --json 输出机器可读结果。 */
import * as store from './store.mjs';
import { collect, submit, status } from './pipeline.mjs';
import * as link from './mp2link.mjs';
import { execFile } from 'node:child_process';

const args = process.argv.slice(2);
const json = args.includes('--json');
const cmd = args.find(a => !a.startsWith('--')) || 'status';
const out = v => { if (json) process.stdout.write(JSON.stringify(v) + '\n'); else console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };

try {
  if (cmd === 'collect') out(await collect());
  else if (cmd === 'submit') out(await submit());
  else if (cmd === 'run') { const c = await collect(); const s = await submit(); out({ collect: c, submit: s, status: status() }); }
  else if (cmd === 'status') out(status());
  else if (cmd === 'ticker') out(store.ticker(+(args.find(a => /^\d+$/.test(a)) || 20)));
  else if (cmd === 'sources') {
    const [, name, val] = args.filter(a => !a.startsWith('--'));
    const cfg = store.config();
    if (!cfg.sources[name] || !['on', 'off'].includes(val)) throw new Error('用法：jm-desk sources <feishu_im|feishu_meeting|mail> on|off');
    cfg.sources[name].enabled = val === 'on'; store.saveConfig(cfg); out(status().sources);
  } else if (cmd === 'link') {
    const url = args.filter(a => !a.startsWith('--'))[1];
    const l = await link.begin(url);
    const say = m => process.stderr.write(m + '\n');
    say(`请在需求管理平台确认关联，代码：${l.user_code}`);
    if (l.verification_url) {
      say(`确认页：${l.verification_url}`);
      if (!args.includes('--no-open')) {
        const [c, a] = process.platform === 'darwin' ? ['open', [l.verification_url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', l.verification_url]] : ['xdg-open', [l.verification_url]];
        execFile(c, a, () => {});
      }
    }
    const r = await link.waitFor(l, { onStatus: s => { if (s.status === 'slow_down') say('（MP2 要求放慢查询）'); } });
    const msg = { connected: '已关联，搬运会改用这个连接。', denied: '在 MP2 上被拒绝了，可以重新发起。', expired: '代码已过期，请重新发起。' }[r.status] || r.status;
    out({ status: r.status, connection_id: r.connectionId || null, message: msg });
    if (r.status !== 'connected') process.exitCode = 2;
  } else if (cmd === 'link-status') out(link.linkStatus());
  else if (cmd === 'unlink') out(link.unlink());
  else throw new Error('未知命令：' + cmd);
} catch (e) { out({ error: e.message }); process.exitCode = 1; }
