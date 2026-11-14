# 键盘口袋 / Keyboard Pocket

在实验室开启键盘口袋。它只收纳你主动选中的内容，不扫描剪贴板历史，也不需要 API。

Enable Keyboard Pocket in Labs. It stores content you choose, without scanning clipboard history or requiring an API.

## 收纳与取用 / Store and retrieve

- 选中文字或文件，按收纳前缀加槽位键，再松开按键。已有内容会先要求确认替换。
- 在目标输入位置按取用前缀加同一个槽位键，再松开。也可在页面复制槽位，手动粘贴；文件或图片是否能粘贴取决于目标软件支持的格式。
- 开启浮窗预览后，按住前缀，从顶部刘海区域展开九槽内容；没有刘海的屏幕从顶部中央展开；松开或按 Esc 收起。关闭预览仍可直接按快捷键取用。

- Select text or files, press the store prefix and a slot key, then release. Replacing existing content requires confirmation.
- At the destination, press the retrieve prefix and the same slot key, then release. You can also copy a slot from the page and paste manually. Image and file pasting depends on the destination app's supported formats.
- With floating previews enabled, hold a prefix to unfold all slots from the top notch (top center on displays without a notch). Release or press Esc to dismiss. Direct shortcuts also work with previews off.

## 设置 / Settings

点击页面上方的收纳或取用快捷键，按下一个或两个键，再松开保存；Esc 取消。槽位键在独立的“槽位按键”区域点击录制。普通字母或 F 键作为前缀时，功能开启期间专用于口袋。快捷键冲突会暂停口袋，并提示修改。拖动槽位调整顺序，槽位内容、编号和快捷键一起移动。

Click the prominent store or retrieve shortcut, press one or two keys, then release to save. Esc cancels. Record individual slot keys in the separate Slot keys section. An ordinary letter or F key used as a prefix is dedicated to Pocket while enabled. Conflicts pause Pocket and prompt you to change a shortcut. Drag slots to reorder; each slot's content, identity and key move together.

内容会在退出后保留，可以清除或撤销。图片与富文本素材保存在本机；文件与文件夹保持原位置引用。关闭总开关会停止监听并取消待执行操作，不删除内容。

Contents survive reopening and can be cleared or restored with Undo. Image and rich-text assets are stored locally; files and folders remain references to their original locations. Turning the feature off stops monitoring and cancels pending operations without deleting contents.

辅助功能权限只用于用户发起的复制和粘贴。密码输入、目标窗口变化、其他功能正在交互时，会停止自动取用。不会自动点击发送按钮。

Accessibility access is used for user-triggered copy and paste. Automatic retrieval stops in secure input, after the target changes, or while another feature is interacting. It never clicks a Send button.

## 飞书文件夹取用 / Folders in Feishu

在飞书输入位置用快捷键取用含文件夹的槽位时，会先在本机生成 ZIP，再粘贴到飞书。原文件夹与槽位保留。是否显示发送确认由飞书决定；飞书可能直接发送粘贴的附件，Lab 不会点击发送按钮。其他应用的快捷键取用继续使用原文件引用；管理页中，含文件夹的槽位显示“复制 ZIP”，方便手动粘贴到聊天。只含文件的槽位仍复制原文件。

Retrieving a slot containing folders into Feishu prepares a local ZIP and pastes it into Feishu. The original folder and slot remain. Feishu controls whether a send confirmation appears and may send pasted attachments directly; Lab never clicks Send. Shortcut retrieval into other apps keeps the original references. For slots containing folders, the management page offers Copy ZIP for pasting into chats. File-only slots keep the original file references.

单次最多 128 个根项目、10,000 个条目、1 GiB 原始内容，超时或目标变化会停止取用。符号链接等特殊文件暂不打包。兼容副本保存在本机临时目录，超过七天后在下次准备时清理；原文件不会被删除。

Each transfer supports up to 128 root items, 10,000 entries and 1 GiB of source content. Timeouts or destination changes stop retrieval. Symbolic links and other special files are not packed. Generated compatibility copies are local and cleaned up after seven days during a later preparation; original files are never deleted.

## 文件访问 / File access

收纳时会保存所选文件的只读访问凭据。旧槽位若缺少凭据或授权失效，会提示“重新选择原文件”；选择此槽位原来的文件或文件夹即可恢复访问，槽位内容和撤销历史保持不变。复制前会校验文件可读且能写入系统剪贴板，失败时不会提示复制成功。

Pocket preserves read-only access to the files you select. If an old slot has no saved grant or its access has expired, choose Reselect original and select that slot’s original file or folder. This keeps its content and undo history. Copy checks file access and clipboard output before reporting success.
