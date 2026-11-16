# NuPhy Lab 1.2.48

## 中文

- 新增语音输入：在功能中心添加后，可用快捷键录音、整理文字并填入选定输入框；支持 Esc 取消和麦克风选择。
- 支持 OpenAI、DeepSeek、阿里云百炼和自定义兼容服务，语音识别与文字整理可分别配置。
- 个人词库支持逐条添加、回车添加和删除，操作后自动保存。
- 内置新的默认整理规则，兼顾口述原意、语气、数字关系、观点归属和自然排版。
- 整理提示词可完整编辑、保存和恢复默认；已保存的自定义规则在升级后继续保留。

在 **功能中心 → 语音输入** 配置自己的 API 服务并开启。首次默认右 Option：按一次说话，选好输入框后再按一次完成；也可自行录制快捷键。页面试录只展示结果，不向其他应用插入。软件不会自动发送消息。

个人词库点“添加”或按回车加入，点 × 删除，自动保存。展开“整理提示词”可修改完整规则；点击“保存提示词”，下一次录音生效。“恢复默认”载入本版的默认规则，再保存即可应用。已有自定义提示词继续保留；没有自定义时使用本版默认规则。

语音识别负责把声音转成文字；整理提示词负责后续文字编辑，不改变识别模型本身。录音发送至自己配置的识别服务，文字发送至整理服务；API Key 保存在 macOS 钥匙串，临时录音处理或取消后删除。需要麦克风和辅助功能权限。

[语音输入使用说明](VOICE_INPUT.md)

## English

- Add Voice Input through Feature Center: record with a shortcut, refine the transcript and insert it into the selected text field, with microphone selection and Esc to cancel.
- Configure OpenAI, DeepSeek, Alibaba Cloud Model Studio or compatible custom services; speech recognition and text refinement can use separate providers.
- Add personal dictionary entries with the Add button or Enter, and delete them individually. Changes save automatically.
- Include new default refinement instructions for preserving meaning, tone, numerical relationships and attributed opinions while choosing natural formatting.
- Edit, save or restore the complete refinement instructions. Upgrades preserve saved custom rules.

Add **Voice Input** in **Feature Center**, configure your API services and enable it. The initial shortcut is right Option: press once to speak, select a text field and press again to finish. You can record a different shortcut. Try Recording displays the result inside the app. Messages are never sent automatically.

Click Add or press Enter to add dictionary entries; click × to delete them. Changes save immediately. Expand Refinement Instructions to edit the complete rules, then click Save Instructions for the next recording. Restore Default loads this version's rules; save to apply them. Existing custom instructions stay in place, while users without an override receive the new default.

Speech recognition converts audio to text; refinement instructions control the subsequent editing step, not the recognition model itself. Audio goes to your configured speech service, and transcripts to the text service. API keys stay in macOS Keychain; temporary audio is deleted after processing or cancellation. Microphone and Accessibility permissions are required.

[Voice Input guide](VOICE_INPUT.md)
