# 本机向量、语音与视频适配及测试

本次按用户授权补齐阿里百炼语音识别与合成，并在本机服务页增加真实调用测试。范围为桌面 Web 及必要后端，不新增自主发送、发布或索引重建动作。

控制对象是指定配置快照的一次向量请求、一次语音合成/识别或一个视频生成任务。观测包含配置文件修订、草稿字段、运行配置差异、服务返回和实际媒体字节。测试共用正式适配器，不能只检查 HTTP 200 或存在任务 ID。

向量检查条数、非空、数值有限、维度及非零向量；语音合成下载并校验真实音频后才允许试听，识别只接收用户明确选择的有界音频上传并展示文本；视频在真实完成且可读取有效视频后才通过。生成视频仅由明确按钮触发，固定短片参数，提交和轮询分开，网络中断不自动重提。

测试记录保存在本机私有目录，绑定所有者、配置身份、修订、开始/完成时间、任务 ID 和失败码。长期任务的连接快照加密保存；响应及日志不得包含密钥、供应商原始错误正文或上传音频。用户刷新后能继续查询视频任务，重复请求不能重复创建。停止查询不声称取消了供应商任务。

接口沿用本机所有者、回环地址及同源边界。地址或协议改变时必须重新提供密钥，不能把保存的旧密钥借给草稿新地址。所有测试不改写 .env、不改写索引，也不修改进程环境。保存和测试独立，待重启状态明确显示，测试通过不代表 Worker 已加载文件。

语音采用独立 AUDIO_PROVIDER / AUDIO_BASE_URL / AUDIO_API_KEY 连接，增加 AUDIO_ASR_MODEL、AUDIO_TTS_MODEL 和 AUDIO_TTS_VOICE。仅未设置独立字段的 OpenAI 旧配置兼容原有地址和密钥；百炼不能借用 OPENAI_API_KEY，显式清除独立密钥也不能重新启用旧密钥。百炼使用原生 HTTP，OpenAI 继续使用其原协议；模型名不授予工具权限。失败不切供应商。媒体下载只接受所选服务同源或官方阿里存储域，拒绝重定向与不受信地址，媒体请求不携带服务密钥。

百炼北京预设可直接填入草稿；需要业务空间专属域名时，将地址替换为 https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/api/v1，并重新填写同地域密钥。合成默认 qwen-audio-3.1-tts-flash / longanhuan_v3.1，识别默认 qwen3-asr-flash。合成最多 4000 字符，音频上传和下载最多 8 MB；视频文件最多 64 MB。文件有效性检查不等于合成质量或识别准确率，页面要求用户试听、核对。

验证采用本地 HTTP 协议夹具、隔离文件根目录和针对性回归，覆盖错误响应、空输出、维度不符、超时/取消、任务重复、持久化恢复、配置修改、密钥隔离和未授权请求。真实供应商试用只在用户主动点击测试时发生，生成可能计费在操作前说明。保留程序验收与真实供应商效果的区别。

回退点：codex/before-media-service-tests 及 .runtime/before-media-service-tests.env.backup。无需数据库结构迁移；保留失败测试证据和已提交视频任务记录，不通过回退重复提交。

协议依据：

- https://help.aliyun.com/zh/model-studio/qwen-audio-tts-http-api
- https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference
- https://help.aliyun.com/zh/model-studio/embedding-interfaces-compatible-with-openai
- https://help.aliyun.com/zh/model-studio/text-to-video-api-reference

复验入口：

- `pnpm exec vitest run tests/unit/machine-service-tests.test.ts tests/unit/machine-service-test-routes.test.ts tests/unit/machine-model-settings.test.ts tests/unit/bailian-embedding-provider.test.ts tests/unit/bailian-video-key-boundary.test.ts tests/unit/model-center.test.ts tests/unit/model-center-pi-resolver.test.ts tests/unit/model-configuration.test.ts tests/unit/rag-embeddings.test.ts tests/unit/local-transformers-embedding-provider.test.ts`（apps/web 目录，105 项）。单元测试保留网络和进程隔离，使用显式协议夹具。
- `node --import tsx scripts/verify-machine-services.mts`：真实回环 HTTP，9 项协议、生命周期和密钥保护检查，不连接云端。
- 完成生产构建后，使用 `ZHIYU_REVIEW_BUILD=<构建编号> node --import tsx scripts/run-machine-services-http-fixture.mts --execute` 启动隔离的 3516 Web；它创建随机 zhiyu_test_* 数据库、独立配置根和假密钥，关闭代理和调度器。另一个终端设定 `MODEL_TEST_APP_URL=http://127.0.0.1:3516` 后执行 `node --import tsx scripts/verify-machine-services-http.mts`。结束时关闭该夹具 Web，使宿主清理自建数据库；不能把 3515 当成测试目标。
- 程序验收回执见同目录 `machine-service-validation.json`。未取得阿里真实账号的生成结果；协议通过、实际装载和云端效果分别记录。
