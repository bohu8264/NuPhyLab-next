export function nativeLightingOnly(state) {
  const device=state?.device;
  return device?.connected===true && device.modelId==='kick75' && device.readOnly!==true &&
    device.capabilities?.stockEffects===true && device.capabilities?.perKey===false;
}
export function lightingUnavailableMessage(state) {
  if(state?.firmware?.upgradeRecommended===true || nativeLightingOnly(state))
    return '请前往 NuPhyIO 更新键盘固件。作品可继续编辑和保存。';
  if(state?.device?.connection?.status==='updateRequired')
    return '请检查 NuPhy Lab 更新。作品可继续编辑和保存。';
  if(state?.device?.connection?.status==='attention')
    return '键盘连接暂时中断。请确认有线模式，并关闭其他键盘设置程序。';
  if(state?.device?.connected)
    return '正在重新连接键盘。作品可继续编辑和保存。';
  return '连接键盘后即可播放。作品可继续编辑和保存。';
}
