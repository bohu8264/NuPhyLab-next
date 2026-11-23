# NuPhy Lab 项目约束

## 文档网页与通俗概要

- 新增或实质更新项目说明、开发计划、架构设计、使用指南、排查记录和验收报告时，统一提供由 **doc-page** 生成的 HTML 网页。详细 Markdown 可保留完整技术内容，网页面向没有技术背景的读者。
- 每个主题默认使用三份文件：`<主题>.md` 保存详细内容，`<主题>.summary.md` 保存通俗概要，`<主题>.summary.html` 由概要 Markdown 生成。示例见 `docs/WINDOWS_ARCHITECTURE_PLAN*`。
- **网页只能从概要 Markdown 生成，不得直接把长篇详细文档整篇转成网页。** 详细文档是事实与技术细节的依据；概要 Markdown 是网页的唯一内容源。不得手工维护另一份 HTML 正文。
- 概要以 **1 至 3 分钟读懂** 为目标，正文通常为 300 至 800 字。先说明结论与当前状态，再按需要解释“要做什么、对使用者有什么用、分几步完成、有什么限制、下一步做什么”。用短句和日常用语，必要术语第一次出现时立即解释；不堆代码、文件路径、接口名和参数。
- 概要可以简化表述，但必须与详细文档一致，尤其是支持范围、已完成与待完成、风险及审核状态。不得把计划写成已交付，也不得为了简短删掉影响决定的条件。
- 概要 Markdown 添加 `page: true`、`title`、`standfirst` 和实际状态等 front matter。详细 Markdown 不标记 `page: true`，避免批量构建时生成长篇网页。概要末尾提供详细 Markdown 链接。
- 使用前读取 doc-page 的 `SKILL.md`、`assets/STYLEGUIDE.md` 和 `assets/gallery.md`。优先查找 `~/.claude/skills/doc-page`；本机源码位置为 `/Users/unofficial/blogs/tools/doc-page-kit/skill`。缺失时先寻找已有工具，不自行仿制网页模板。
- 只使用 doc-page 的统一样式和已登记组件，不在文档中添加自定义 CSS、内联样式或自造 class。默认使用普通 Markdown，需要说明真实步骤或重点时再选现有组件。
- 修改内容后按顺序执行 `check_doc_style.py`、`build_doc_page.py`，并实际查看网页。至少检查桌面、窄屏、深浅主题、目录和相对链接；生成成功不能代替渲染检查。
- 同一主题的详细文档、概要 Markdown 和 HTML 必须同步更新。`docs/README.md` 等目录优先提供通俗网页入口，同时保留详细文档入口。生成的 HTML 随对应 Markdown 一起纳入 Git。
- 这条规则不代表批准文档描述的开发方案。方案审核与实际开发仍按用户授权执行。

构建示例（`DOC_PAGE_SKILL` 指向实际找到的 skill，Python 环境需有 `markdown-it-py` 和 `pyyaml`）：

```sh
python3 "$DOC_PAGE_SKILL/scripts/check_doc_style.py" docs/WINDOWS_ARCHITECTURE_PLAN.summary.md
python3 "$DOC_PAGE_SKILL/scripts/build_doc_page.py" docs/WINDOWS_ARCHITECTURE_PLAN.summary.md
```
