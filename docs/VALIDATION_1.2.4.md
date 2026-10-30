# NuPhy Lab 1.2.4 验证记录

## 本次修改

- 主程序和 HID 后台用公开的 `IOHIDCheckAccess` 读取输入监控与事件发送授权；不再用进程可能保留旧结果的 CoreGraphics preflight 作为授权门槛。辅助功能继续由 `AXIsProcessTrusted` 检查。键位适配和快捷事件发送也使用相同的实时检查。
- 界面拿到原生权限快照后，将它带入同一次后台刷新请求；不再依赖另一个未等待完成的 HTTP 上报。未授权、未知状态和读取失败均不视作授权成功。
- 不重启应用、不重置系统权限、不更改键盘协议、固件、灯效或用户作品。

公开 API 与实现参考：[Apple IOHIDCheckAccess](https://developer.apple.com/documentation/iokit/3181573-iohidcheckaccess)、[Apple IOKitUser 实现](https://github.com/apple-oss-distributions/IOKitUser/blob/main/hidsystem.subproj/IOHIDLib.c)。本项目只调用公开 API，不访问 TCC 数据库或私有接口。

## 已完成验证

- 开发源码与最终签名安装包所携 Node/代码分别运行：400 项测试全部通过，无跳过。
- 原生协议离线自检：6546 项检查通过。
- 生产原生权限读取函数：在同一进程中注入操作系统返回值，覆盖先拒绝后授权、分别授权、撤权、未知状态和再次授权；即使旧 CoreGraphics 查询一直返回缓存值，56 项断言仍通过。
- 实际构建的界面 + 实际 HTTP 服务 + 模拟原生桥/键盘：两项权限由拒绝变为授权后，首次设置弹窗自动关闭，设备页两处按钮自动显示“已允许”，没有重载页面、切换窗口或重启服务。
- 保留主程序与后台独立校验；模拟测试确认单边授权、无效快照和刷新失败不会伪装为可用权限。

## 验证边界

- 本次没有在全新 Mac 或全新 TCC 授权环境中执行首次授权实测。用户暂时不方便配合；临时只读诊断应用已移除，现有 NuPhy Lab 权限未重置或更改。
- 上面的首次授权变更测试为受控模拟，不能代替朋友电脑上的复验。
- 本机原有 Gatekeeper 状态没有更改；签名、公证和安装包验证记录保存在本地发布目录。
