# README 首页重写

按用户要求参考 Dify、Claude Code、Open WebUI 的公开项目首页结构，以中文读者首次理解和体验项目为主线重写根 README。

修改内容：居中标题与真实技术/许可证徽章、项目定位、核心能力、模板场景、PowerShell 快速开始、可选服务、运行架构、命令索引、文档与贡献入口。未添加虚构用户数、测试通过徽章、在线演示或未经验证的跨平台承诺。

同步纠正原 README 的主记忆向量混合召回描述；明确当前主记忆是规则评分，辅助知识路径才有向量检索。快速开始显式迁移，统一使用迁移入口可读取的 `.env`，区分主 LLM 与原生 Agent 执行配置。数据库示例采用手动管理的本地 Docker 容器，避免依赖启动脚本默认账户与环境示例不一致。

验证：34 个本地链接存在，8 个导航锚点有效，代码围栏配对，中文无替换字符，列出的根脚本与 package.json 匹配；`git diff --check -- README.md` 通过。

范围：文档修改，没有修改应用、数据库或运行配置，没有重启服务或执行安装/迁移。首次全新环境安装未在本轮重新执行，命令核对不等同于冷启动验收。

参考：
- https://github.com/langgenius/dify
- https://github.com/anthropics/claude-code
- https://github.com/open-webui/open-webui
