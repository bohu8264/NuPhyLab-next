/** Keep storage and validation failures separate from keyboard recovery advice. */
export function friendlyConnectionError(value) {
  const text=String(value??'');
  if (/\b(?:EISDIR|ENOTDIR|ENOSPC|EROFS|EACCES|EPERM)\b/.test(text) && /library\.json|settings\.json|write|rename/i.test(text)) return '无法保存本机数据，请稍后重试。';
  if(!/[\u3400-\u9fff]/.test(text)&&/HID|keyboard|palette|backup|packet|response|route|checksum|device|IOKit|configuration/i.test(text))return '连接暂时中断，软件正在重新连接。';
  return /F4|KEY_(?:LEASE|RECOVERY)|恢复记录|原备份|原 USB|协议结构|灯位数量|灯效协议|键位结构/.test(text)?'暂时无法连接键盘，请关闭其他键盘设置程序，重新插拔键盘后再试。':text;
}
