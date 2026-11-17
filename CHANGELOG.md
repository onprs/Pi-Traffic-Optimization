# 更新日志

本文件记录每个版本的新增功能、功能改进和 Bug 修复。版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.0.0] - 2026-11-17

### 新增

- 发送前自动压缩较大的图片，原会话保留原图。
- 较早的工具输出和图片归档到本地，请求中以引用代替；新增 `context_recall` 工具按需取回归档内容，支持分页、局部窗口、历史检索和文件新旧核对。
- 状态栏显示累计上传量、最近请求大小和图片压缩率，并生成本地流量报告。
- 新增 `/traffic-opt` 命令，用于开关、查看统计与归档、清理归档和图片缓存。
- 支持 Pi 内置的 OpenAI、Azure OpenAI、OpenAI Codex、Mistral、Anthropic、Google、Vertex、Bedrock 和 Pi Messages 协议的流量统计。
- 配置、归档和报告保存在 Pi 配置目录下的 `traffic-optimization/`，更新扩展不会覆盖。
