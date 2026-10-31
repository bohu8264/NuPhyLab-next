import {test} from 'node:test';
import assert from 'node:assert/strict';
import {friendlyConnectionError} from '../shared/error-message.mjs';
test('storage and color validation failures never suggest reconnecting a keyboard',()=>{
  assert.equal(friendlyConnectionError("EISDIR: illegal operation on a directory, open '/temporary/library.json.tmp'"),'无法保存本机数据，请稍后重试。');
  assert.equal(friendlyConnectionError('颜色必须为 #RRGGBB 格式'),'颜色必须为 #RRGGBB 格式');
  assert.equal(friendlyConnectionError('HID packet checksum failed'),'连接暂时中断，软件正在重新连接。');
  assert.equal(friendlyConnectionError('KEY_LEASE_BLOCKED'),'暂时无法连接键盘，请关闭其他键盘设置程序，重新插拔键盘后再试。');
});
