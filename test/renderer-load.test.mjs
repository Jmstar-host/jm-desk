/* 面板脚本按 panel.html 的顺序（apps.js → panel.js）加载时，顶层代码不能出错：
 * 2026-11-18 apps.js 顶层用了 panel.js 才定义的变量，导致所有面板应用页打不开。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const R = new URL('../app/renderer/', import.meta.url);
test('apps.js 在 panel.js 之前加载也不报错，APPS 里有所有面板页', () => {
  const ipc = { on() {}, invoke: async () => ({}), send() {} };
  const ctx = vm.createContext({ require: m => (m === 'electron' ? { ipcRenderer: ipc } : {}), console, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(new URL('apps.js', R), 'utf8'), ctx, { filename: 'apps.js' });
  const keys = Object.keys(vm.runInContext('APPS', ctx));
  for (const k of ['app.peers', 'app.reminders', 'mail.stats', 'app.update']) assert.ok(keys.includes(k), k);
  for (const k of ['app.summary', 'app.tasks', 'app.pool', 'app.collect', 'app.knowledge', 'mail.report']) assert.ok(!keys.includes(k), '1.3.0 起并进主窗口：' + k);
});
