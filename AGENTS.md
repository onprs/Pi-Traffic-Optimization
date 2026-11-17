# AGENTS.md

本文件约束本仓库的开发、维护与发布流程，面向维护者和 AI 编码代理。公开用法写在 `README.md`，实现与配置的技术参考写在 `docs/maintenance.md`。

## 项目概况

- npm 包名 `pi-traffic-optimization`，GitHub 仓库 `onprs/Pi-Traffic-Optimization`，默认分支 `main`。
- 形态是 Pi package，通过 `package.json` 的 `pi.extensions` 声明入口 `src/index.ts`。公开用户用 `pi install npm:pi-traffic-optimization` 安装。
- 功能：图片压缩、工具结果上下文归档与 `context_recall` 取回、上传流量统计、`/traffic-opt` 命令。
- 仓库在 Windows 与 Ubuntu 上开发，所有脚本、路径和测试必须同时适用两个平台。

## 环境划分

| 环境 | 范围 | 可写入的内容 |
|---|---|---|
| 公开用户环境 | 通过 npm 安装扩展的用户 | `README.md`、`CHANGELOG.md`、GitHub Release 说明、包内文件 |
| 开发维护环境 | onprs 的本机、测试设备、CI | 本文件「维护环境」一节、`docs/maintenance.md`、`tests/`、`scripts/` |

维护环境的路径、SSH 别名、代理、数据目录和现场验证结论不能写进公开文档或包的默认行为。

## 目录结构

| 路径 | 用途 |
|---|---|
| `src/index.ts` | Pi 接入层：事件、工具、命令、配置路径 |
| `src/*.mjs` | 实现模块，原生 ESM |
| `tests/*.test.mjs` | `node:test` 测试；`sdk-runner.mjs`、`pi-root.mjs` 为测试辅助 |
| `tests/benchmark.mjs` | 本地 HTTP/SSE 对照，输出到已忽略的 `reports/benchmarks/` |
| `scripts/check.mjs` | 全部 `.mjs`/`.ts` 的语法检查 |
| `scripts/release-notes.mjs` | 校验 tag 与版本，并从 `CHANGELOG.md` 提取发布说明 |
| `config.example.json` | 完整配置示例，随包发布 |
| `docs/maintenance.md` | 数据流、配置字段、协议、故障恢复等技术参考 |
| `.github/workflows/ci.yml` | 推送与 PR 的检查，也被发布流程复用 |
| `.github/workflows/release.yml` | tag 触发的 npm 与 GitHub Release 发布 |

npm 包只包含 `src/`、`config.example.json`、`CHANGELOG.md`、`README.md` 和 `package.json`（由 `files` 字段控制）。新增需要随包发布的文件时同步修改 `files`，并用 `npm pack --dry-run` 核对。

## 代码规范

- 运行时：Node 版本以 `package.json` 的 `engines` 为准（与 Pi 1.5 的要求一致），CI 覆盖 Node 22 与 24。
- 依赖：
  - Pi 提供的包（`@earendil-works/pi-*`、`typebox`）只放在 `peerDependencies`（`"*"`）和 `devDependencies`（精确版本，供测试使用），禁止放进 `dependencies`。
  - 其他运行时依赖放在 `dependencies`，使用精确版本。修改依赖后提交更新的 `package-lock.json`。
- 模块加载：`src/index.ts` 计算 `runtimeFiles` 的源码 hash，并以带版本参数的 URL 加载 `.mjs`，保证 `/reload` 取得新实现。`.mjs` 之间的相互导入沿用 `new URL('./x.mjs' + new URL(import.meta.url).search, import.meta.url)` 写法。新增或删除实现模块时，同时更新 `src/index.ts` 的 `runtimeFiles`、`tests/reload.test.mjs` 的 `files` 和 `tests/benchmark.mjs` 的 hash 列表。
- 数据位置：配置、归档、报告默认写入 `getAgentDir()/traffic-optimization/`，可由 `PI_TRAFFIC_OPT_*` 环境变量覆盖。禁止写入扩展包目录（npm 更新会覆盖）。测试必须把所有路径指向临时目录，禁止读写真实 Pi 配置目录。
- 行为边界：扩展只观察和投影请求副本，不修改 Pi 的 canonical session；任何归档、图片、报告故障都回退到原内容并继续对话。
- 跨平台：路径使用 `node:path`；npm scripts 只调用 `node` 和 npm 自身命令，复杂逻辑写成 `scripts/*.mjs`；文件统一 UTF-8 + LF（见 `.gitattributes`、`.editorconfig`）。
- 注释与 UI 文本使用中文；UI 中只出现面向用户的文本。
- 修改文件使用编辑工具，禁止用 `sed`、`python`、`apply_patch` 等命令行方式改写文件。

## 开发流程

1. 准备：`npm ci`。devDependencies 会安装测试用的 Pi，SDK 测试默认使用它；需要测试其他 Pi 安装时设置 `PI_TRAFFIC_OPT_PI_ROOT`。
2. 分支：在 `main` 之外建立 `类型/简述` 分支，例如 `fix/recall-offset`。小改动可直接在 `main` 上提交，但必须先通过本地验证。
3. 本地试用：
   - 临时加载：`pi -e <仓库路径>`。
   - 已通过 npm 安装同名包时，先在 `pi config` 中停用该包，避免 `context_recall` 和 `/traffic-opt` 重复注册。
   - 隔离试用可设置 `PI_CODING_AGENT_DIR` 到临时目录。
   - 修改源码后在 Pi 中执行 `/reload`。
4. 验证：`npm run verify`（语法检查、全部测试、发布说明校验、打包清单）。改动涉及协议或传输时额外运行 `npm run test:sdk`，涉及投影或归档策略时运行 `npm run benchmark` 并比较报告。
5. 文档：用户可感知的变化写入 `CHANGELOG.md` 的 `## [Unreleased]`；命令、配置字段、默认值或数据目录变化时同步更新 `README.md`、`config.example.json` 和 `docs/maintenance.md`。
6. 提交：信息使用中文，格式 `类型: 摘要`，类型取 `feat`、`fix`、`perf`、`refactor`、`docs`、`test`、`ci`、`chore`。一次提交只做一件事。
7. 合并：推送后等待 CI 全部通过（Ubuntu Node 22/24、Windows Node 24）再合并到 `main`。

## 版本与发布

版本遵循语义化版本：

- `patch`：Bug 修复。
- `minor`：新增功能或配置字段，旧配置与归档保持可用。
- `major`：删除命令或配置字段、改变数据目录、归档 schema 不兼容等破坏性变化。
- 预发布使用 `x.y.z-beta.n`，会发布到 npm 的 `next` 标签并标记为 GitHub 预发布。

发布步骤（在已通过 CI 的 `main` 上执行）：

1. 把 `CHANGELOG.md` 中 `## [Unreleased]` 的内容移到新的 `## [x.y.z] - YYYY-MM-DD` 段落。段落内只写新增功能、功能改进和 Bug 修复，该段落会原样成为 GitHub Release 说明。
2. `npm version x.y.z --no-git-tag-version`，同时更新 `package.json` 与 `package-lock.json`。
3. `npm run verify`。
4. 提交 `chore: 发布 vx.y.z`，打 tag：`git tag vx.y.z`。
5. 推送：`git push origin main` 与 `git push origin vx.y.z`。
6. tag 推送触发 `release.yml`：
   1. 复用 `ci.yml` 跑全平台检查。
   2. 校验 tag 位于 `main`、tag 与 `package.json` 版本一致、CHANGELOG 段落存在。
   3. 发布 npm（带 provenance）。
   4. 创建 GitHub Release。
7. 核对：`npm view pi-traffic-optimization version`、GitHub Releases 页面，以及在干净环境执行 `pi install npm:pi-traffic-optimization@x.y.z` 后能加载 `/traffic-opt`。

失败处理：

- 发布流程可重复运行。npm 已存在同版本时跳过发布，GitHub Release 已存在时跳过创建。
- 已发布的版本号不能复用或移动 tag。发布内容有误时修复后发布新的 patch 版本。

## 发布凭据（一次性配置）

npm 的 trusted publishing（OIDC）只能为已存在的包配置，因此首个版本使用 token 发布，之后切换到 OIDC：

1. 首次发布：onprs 在 npmjs.com 创建对 `pi-traffic-optimization` 有发布权限、短有效期的 Granular Access Token，执行 `gh secret set NPM_TOKEN --repo onprs/Pi-Traffic-Optimization` 写入仓库 secret，然后按上节步骤推送 tag。
2. 首次发布成功后，在 npmjs.com 包设置的 Trusted Publisher 中添加 GitHub Actions：
   - 用户 `onprs`。
   - 仓库 `Pi-Traffic-Optimization`。
   - 工作流文件 `release.yml`。
   - 环境留空，允许 `npm publish`。
3. 删除 secret：`gh secret delete NPM_TOKEN --repo onprs/Pi-Traffic-Optimization`，并在 npm 撤销该 token。之后的发布全部走 OIDC，可在包设置中启用「要求 2FA 并禁止 token」。
4. `release.yml` 的文件名、`package.json` 的 `repository.url` 必须与 Trusted Publisher 配置一致；重命名工作流前先更新 npm 配置。

## 需要 onprs 授权的操作

AI 代理遇到以下操作时，先说明操作内容和影响，取得 onprs 明确同意后再执行。凭据由 onprs 本人输入，代理不读取、不打印、不写入文件：

- 推送到 `main`、推送或删除 tag、强制推送、修改分支保护。
- 发布或撤销 npm 版本、修改 npm dist-tag、修改包权限或 Trusted Publisher。
- 创建、修改、删除 GitHub Release、仓库 secret、仓库设置。
- `npm login`、创建或撤销 token。
- 修改许可证、包名、仓库地址。
- 移动、删除或改写维护环境中的归档、报告和 Pi 配置。

## 维护环境

本节只适用于 onprs 的维护设备。

- 迁移到 npm 包之前，维护设备从 `~/.pi/agent/extensions/traffic-optimization/` 加载一份源码副本。该目录内的 `archive`、`reports` 是指向 `~/.pi/agent/backups/traffic-optimization/` 的符号链接。
- 改用 npm 包后，默认数据目录变为 `~/.pi/agent/traffic-optimization/`，迁移步骤：
  1. 退出全部 Pi 进程。
  2. 备份 `~/.pi/agent/backups/traffic-optimization/`。
  3. 迁移数据，二选一：
     - 把其中的 `archive/`、`reports/` 和原 `config.json` 移到 `~/.pi/agent/traffic-optimization/`。
     - 用 `PI_TRAFFIC_OPT_CONFIG_PATH`、`PI_TRAFFIC_OPT_ARCHIVE_DIR` 指向原位置。
  4. 移除 `~/.pi/agent/extensions/traffic-optimization/`。
  5. 执行 `pi install npm:pi-traffic-optimization`。

  旧副本与 npm 包不能同时加载。
- 仓库根目录下的 `archive`、`reports` 符号链接和 `.maintenance-backup/` 是本机遗留物，已被 `.gitignore` 忽略，不随仓库或包发布。
- 维护环境的现场验证只证明该环境的行为；对外描述兼容性以 CI 结果和 `package.json` 声明为准。
