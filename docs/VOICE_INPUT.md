# 语音输入 / Voice Input

## 中文

在功能中心添加语音输入，再打开“AI 服务与权限”。选择 OpenAI、DeepSeek、阿里云百炼或自定义服务，保存自己的 API Key。高级设置可以分别配置语音识别和语句整理；同一服务地址可共用 Key。百炼需要选择与 Key 对应的地区。Key 保存在 macOS 钥匙串；语音服务与智能框选的模型设置相互独立。

授予麦克风和辅助功能权限，开启语音输入。按一次快捷键开始说话，切换到需要输入的应用并选好文本框，再按一次完成输入。首次默认右 Option，可点击快捷键按钮后按下并松开要设置的按键或鼠标侧键。侧键同样按一次开始、再按一次结束；左键、右键和中键保留原用途。与智能框选相同的侧键组合不能同时启用，请更换其中一个。Esc 取消本次输入。不会自动发送消息；没有找到输入框或无法自动插入时，完成的文字会自动复制到剪贴板，可直接按 ⌘V 粘贴。若等待插入期间你复制了其他内容，会保留你的新剪贴板，语音结果仍留在页面供复制。

“跟随系统”会显示系统当前麦克风名称；也可固定选择一支麦克风，仅影响语音输入，不改变系统默认设备。固定设备断开时不会偷偷切换到其他设备。个人词库可填写常用名称，点击“添加”或按回车加入；词条旁的 × 可删除，添加和删除立即保存。试录在页面显示结果，不向其他应用插入。

“整理提示词”内置当前使用的完整规则。点击“编辑提示词”，修改后点击“保存提示词”，从下一次录音生效；“恢复默认”会载入当前版本的默认规则，再保存即可应用。升级后，已有自定义提示词继续保留；没有自定义时使用本版默认规则。人名、品牌听错时先补充词库或检查麦克风/识别模型；断句、去重复、格式或表达方式不合适时修改整理提示词。它作用于识别后的文字整理，兼容当前所选服务，不会自动更换模型。

语音输入录音发送至你配置的语音识别服务，转写内容发送至文字整理服务；临时录音在处理结束或取消后删除。长录音按服务要求分段识别，再以完整文本整理。提前整理仅适用于支持的实时识别模式，可能增加一次请求；仅在完整最终文本一致时复用。识别、整理速度和效果取决于麦克风、网络、服务与模型。

已安装语音输入实验版的用户首次打开正式功能时，会保留原来的服务、快捷键、麦克风、词库和偏好。原 API 凭据继续按原用途和服务地址读取；新保存的凭据属于正式语音输入。实验版运行时，正式语音输入暂停，避免两个热键同时响应。已有正式语音设置不会被重复导入覆盖。

## English

Click the shortcut button, then press and release a keyboard shortcut or mouse side button. A side button starts recording on one click and finishes on the next. Left, right and middle buttons keep their normal roles. Use different bindings for Voice Input and Smart Selection.

Add Voice Input in Feature Center and open **AI Service & Permissions**. Choose OpenAI, DeepSeek, Alibaba Cloud Model Studio or Custom, then save your API key. Advanced settings configure speech recognition and text refinement separately. Endpoints at the same origin may share a key. For Alibaba, select the region that issued your key. Credentials stay in macOS Keychain; Voice Input and Smart Selection have separate service settings.

Allow Microphone and Accessibility, then enable Voice Input. Press the shortcut to speak, select a text field in your destination app, and press again to finish. The initial shortcut is right Option; click the shortcut button and press and release different keys to change it. Esc cancels. Messages are never sent automatically. If no text field is found or insertion is unavailable, the completed text is copied to the clipboard so you can press ⌘V to paste. A newer copy made while waiting to insert is preserved; the speech result remains on the page for manual copying.

System Default displays the current microphone name. A fixed microphone choice affects only Voice Input and preserves the system default. A disconnected fixed device never silently falls back to another microphone. Type a personal dictionary entry and click Add or press Enter. Click × beside an entry to delete it. Both actions save immediately. Try Recording shows results in the app without inserting into another application.

Refinement Instructions contains the complete built-in rules. Choose Edit Instructions, make changes and click Save Instructions; the next recording uses them. Restore Default loads the current version’s built-in rules, which you then save. Upgrades preserve custom instructions; without an override, the current built-in rules apply. For misheard names or brands, update the dictionary or check the microphone and speech model. For punctuation, repetition, formatting or wording, edit the refinement instructions. They apply after recognition, using your selected service and model.

Audio is sent to your configured speech service, and transcripts to your text service. Temporary recordings are deleted after processing or cancellation. Longer recordings are segmented according to service requirements before refining the complete transcript. Early refinement applies only to supported realtime recognition and may add one request; it is reused only if the complete final transcript matches. Quality and speed depend on the microphone, network, provider and model.

For existing experimental Voice Input users, the first formal integration keeps service settings, shortcut, microphone, dictionary and preferences. Existing credentials remain scoped to their original purpose and service origin; newly saved credentials use the formal Voice Input namespace. Formal Voice Input pauses while the experimental app is running, preventing duplicate shortcuts. Existing formal settings are never overwritten by repeated imports.
