# 更新日志

本文件记录每个版本的新增功能、功能改进和 Bug 修复。版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.1.0] - 2026-11-22

### 新增

- 适配 `pi-antigravity-bridge`（`antigravity-acp`）：支持 `session/prompt` 与宿主 MCP 工具结果回传的上传流量统计、内容分类、状态栏更新和本地报告生成。
- 支持归档与追踪 `pi-antigravity-bridge` 镜像工具（`agy_read`、`agy_edit`、`agy_write`、`agy_bash` 等），在 `agy_edit`/`agy_write` 修改文件后自动标记既有读取快照为过期。

### 改进

- 图片压缩率按单次请求实际发送的图片统计，适配有状态增量协议，避免重复计入未重发的历史图片。
- 并发工具调用产生极小输入 token 分摊样本时自动忽略，保持上下文动态校准稳定。
- 在 `context_recall` 未激活的模式下跳过上下文投影并清理过期的上下文压力估算。

## [1.0.0] - 2026-11-17

### 新增

- 发送前自动压缩较大的图片，原会话保留原图。
- 较早的工具输出和图片归档到本地，请求中以引用代替；新增 `context_recall` 工具按需取回归档内容，支持分页、局部窗口、历史检索和文件新旧核对。
- 状态栏显示累计上传量、最近请求大小和图片压缩率，并生成本地流量报告。
- 新增 `/traffic-opt` 命令，用于开关、查看统计与归档、清理归档和图片缓存。
- 支持 Pi 内置的 OpenAI、Azure OpenAI、OpenAI Codex、Mistral、Anthropic、Google、Vertex、Bedrock 和 Pi Messages 协议的流量统计。
- 配置、归档和报告保存在 Pi 配置目录下的 `traffic-optimization/`，更新扩展不会覆盖。
