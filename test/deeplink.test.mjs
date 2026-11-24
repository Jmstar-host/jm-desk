import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeepLink, normalizeBase, isLoopback } from '../app/main/deeplink.mjs';

test('jmdesk://connect 解析出平台地址', () => {
  assert.deepEqual(parseDeepLink('jmdesk://connect?base=' + encodeURIComponent('http://127.0.0.1:5231')), { action: 'connect', base: 'http://127.0.0.1:5231' });
  assert.deepEqual(parseDeepLink('jmdesk://connect/?base=https%3A%2F%2Fmp2.example.com%2Fapp%2F'), { action: 'connect', base: 'https://mp2.example.com/app' });
  assert.deepEqual(parseDeepLink('jmdesk:connect?base=https://mp2.example.com'), { action: 'connect', base: 'https://mp2.example.com' });
});

test('不认识的动作、缺地址或非法地址一律忽略', () => {
  for (const bad of [
    'jmdesk://settings',
    'jmdesk://connect',
    'jmdesk://connect?base=',
    'jmdesk://connect?base=javascript:alert(1)',
    'jmdesk://connect?base=file:///etc/passwd',
    'jmdesk://connect?base=' + encodeURIComponent('https://user:pass@mp2.example.com'),
    'https://connect?base=https://mp2.example.com',
    'not a url',
    'jmdesk://connect?base=https://' + 'a'.repeat(400) + '.com',
    42,
  ]) assert.equal(parseDeepLink(bad), null, String(bad));
});

test('地址规整：去掉查询串、片段和末尾斜杠', () => {
  assert.equal(normalizeBase('https://mp2.example.com/x/?a=1#b'), 'https://mp2.example.com/x');
  assert.equal(normalizeBase('  http://127.0.0.1:5231/  '), 'http://127.0.0.1:5231');
  assert.equal(normalizeBase('ftp://mp2.example.com'), null);
});

test('本机地址判断', () => {
  assert.ok(isLoopback('http://127.0.0.1:5231'));
  assert.ok(isLoopback('http://localhost:8080'));
  assert.ok(!isLoopback('http://10.0.0.5'));
});
