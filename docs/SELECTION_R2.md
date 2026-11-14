# 模型、图片与权限 / Models, images and permissions

## 选择模型 / Choose a model

支持 OpenAI、Claude、Gemini、DeepSeek、通义千问和 OpenRouter 服务预设。每次请求使用一个选定模型，可在多款预设中切换，或填写自己的模型 ID。支持读取账户列表的服务提供“读取模型”操作；通义千问使用预设或手动填写。兼容端点可在高级设置中填写。

Service presets cover OpenAI, Claude, Gemini, DeepSeek, Qwen and OpenRouter. Each request uses one selected model. Switch between presets or enter your own model ID. Providers with account-list support offer an action to load models; Qwen uses presets or manual IDs. Compatible endpoints can be entered in Advanced settings.

可用型号取决于服务账户、所在区域和服务端更新。列表里有该模型不代表账户一定获准调用。图片能力也由具体模型和接口决定。

Availability depends on your provider account, region and provider changes. A listed model does not guarantee access for your account. Image support also depends on the specific model and endpoint.

## 发送图片 / Include images

开关位于 **功能中心 → 智能框选** 的“按住说话”下方。关闭时只发送本机 OCR 文字；开启后，提问可附图，翻译、总结、解释在没有识别到文字时可附图。“提取文字”始终只在本机执行。

The switch is below **Hold to speak** in **Feature Center → Smart Selection**. When off, only local OCR text is sent. When on, questions can include an image; translation, summary and explanation may include an image when OCR found no text. Extract Text always runs locally.

只有模型和接口支持图片输入时，图片请求才能成功。更换模型不会自动打开图片开关，开关本身也不代表已验证账户访问或图片能力。

Image requests require both the model and endpoint to support image input. Changing models never automatically enables images. The switch itself does not verify account access or image capability.

## 权限与就绪 / Permissions and readiness

框选需要辅助功能、输入监控和屏幕录制。按住说话还需要麦克风与语音识别；不使用语音时可关闭该功能。框选无需系统声音权限。

Selection requires Accessibility, Input Monitoring and Screen Recording. Hold to speak also requires Microphone and Speech Recognition; leave it off if you do not need voice. Selection does not require System Audio access.

软件还会核对模型与 API Key 是否配置、快捷键是否冲突及实际监听是否运行。安全输入开启、监听暂停和缺少权限会显示各自状态。重新检查会刷新权限并尝试恢复监听，不会触发截图或模型请求。系统明确要求重开应用时，完成该步骤后再使用。

The app also checks the model and API-key configuration, shortcut conflicts and whether the listener is running. Secure input, a paused listener and missing permissions have distinct states. Recheck refreshes access and tries to restore listening without taking a screenshot or calling a model. Reopen the app if macOS explicitly requires it.

[使用说明 / Setup and usage](SELECTION.md) · [语言设置 / Language settings](SELECTION_LANGUAGES.md)
