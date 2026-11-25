/* 系统占用（1.7.0）：CPU 用两次采样之间各核的空闲时间算；内存在 macOS 上按「活动 + 联动 + 压缩」页算（和活动监视器的「已使用内存」接近），
 * 其他系统用 总量 - 空闲。给精灵用：占用越高动作越快（参考 RunCat），以及第一层的「占用」气泡。 */
import os from 'node:os';
import { execFile } from 'node:child_process';

export function cpuSnapshot(cpus = os.cpus()) { let idle = 0, total = 0; for (const c of cpus) { const t = c.times; idle += t.idle; total += t.user + t.nice + t.sys + t.idle + t.irq; } return { idle, total }; }
export const cpuBusy = (a, b) => { const dt = b.total - a.total; return dt > 0 ? Math.max(0, Math.min(1, 1 - (b.idle - a.idle) / dt)) : 0; };
/** vm_stat 的输出 → 已使用内存占比 */
export function parseVmStat(text, total = os.totalmem()) {
  const page = Number((String(text).match(/page size of (\d+) bytes/) || [])[1]) || 16384;
  const n = k => Number((String(text).match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1]) || 0;
  const used = (n('Pages active') + n('Pages wired down') + n('Pages occupied by compressor')) * page;
  return used > 0 && total > 0 ? Math.max(0, Math.min(1, used / total)) : null;
}
const vmStat = () => new Promise(res => execFile('/usr/bin/vm_stat', { timeout: 3000 }, (e, out) => res(e ? null : parseVmStat(out))));
export async function memBusy() { return (process.platform === 'darwin' ? await vmStat() : null) ?? 1 - os.freemem() / os.totalmem(); }
/** 精灵的动作快慢：0–1 的占用 → 1–3.5 倍速。三成以下不变，九成以上最快 */
export function tempoFor(load) { const k = Math.max(0, Math.min(1, (load - 0.3) / 0.6)); return 1 + 2.5 * k * k * (3 - 2 * k); }
/** 按设置把 CPU、内存合成一个占用：cpu = 只看 CPU；cpu+mem = 两者平均（内存常年六七成，取最大会一直很快） */
export const loadFor = (mode, cpu, mem) => mode === 'off' ? 0 : mode === 'cpu+mem' ? (cpu + (mem ?? cpu)) / 2 : cpu;

/** 指数平滑：短暂的尖峰不让精灵一下子发疯，持续忙才快起来（2 秒一次时约 5 秒见效） */
export const smooth = (prev, v, k = 0.4) => prev == null ? v : prev + (v - prev) * k;
/* own()：JM Desk 自己占的 CPU（0–1，按全部核算），从总占用里扣掉，免得精灵飞得越快、算出来越忙、飞得更快 */
export function startSampler(onSample, ms = 2000, own = () => 0) {
  let prev = cpuSnapshot(), stop = false, n = 0, mem = null, avg = null;
  const tick = async () => {
    if (stop) return;
    const cur = cpuSnapshot(), raw = cpuBusy(prev, cur); prev = cur;
    let mine = 0; try { mine = Math.max(0, Number(own()) || 0); } catch {}
    const cpu = avg = smooth(avg, Math.max(0, raw - mine));
    if (n++ % 3 === 0) mem = await memBusy().catch(() => mem); // 内存变化慢，6 秒看一次
    onSample({ cpu, mem, at: Date.now() });
    setTimeout(tick, ms);
  };
  setTimeout(tick, ms);
  return () => { stop = true; };
}
