# Pi Traffic Optimization

[Pi](https://pi.dev) 扩展，用于减少发送给模型的数据量：

- **图片压缩**：发送前自动压缩较大的图片，原会话保留原图。
- **上下文归档**：较早的大段工具输出和图片保存到本地，请求中以短引用代替，需要时由模型通过 `context_recall` 工具按需取回。
- **流量统计**：状态栏显示累计上传量、最近一次请求大小和图片压缩率，并生成本地流量报告。

## 系统要求

- Pi 1.5 或更高版本（1.x）

## 安装

```bash
pi install npm:pi-traffic-optimization
```

安装后重启 Pi 或执行 `/reload`。

试用而不写入设置：

```bash
pi -e npm:pi-traffic-optimization
```

卸载：

```bash
pi remove npm:pi-traffic-optimization
```

## 使用

扩展安装后默认启用。在 Pi 中使用 `/traffic-opt` 命令：

| 命令 | 作用 |
|---|---|
| `/traffic-opt` | 切换开关 |
| `/traffic-opt 开` / `关` | 开启或关闭全部优化，重启后保持 |
| `/traffic-opt 状态` | 刷新状态栏 |
| `/traffic-opt 统计` | 查看累计指标并写出报告 |
| `/traffic-opt 上下文` | 查看归档与取回情况 |
| `/traffic-opt archive` | 查看归档目录与占用 |
| `/traffic-opt recall <ctx://...>` | 查看某个归档对象的信息 |
| `/traffic-opt gc` | 立即清理过期归档 |
| `/traffic-opt 清理缓存` | 清理图片压缩缓存 |

关闭后，请求恢复为 Pi 提供的完整上下文。

## 配置

数据保存在 Pi 配置目录下的 `traffic-optimization/`（默认 `~/.pi/agent/traffic-optimization/`）：

| 路径 | 内容 |
|---|---|
| `config.json` | 配置文件，不存在时使用默认值 |
| `archive/` | 上下文归档 |
| `reports/` | 流量报告 |

需要调整参数时，参考包内的 [`config.example.json`](config.example.json) 创建 `config.json`，只写需要修改的字段即可。修改后执行 `/reload` 生效。常用字段：

| 字段 | 默认值 | 作用 |
|---|---:|---|
| `enabled` | `true` | 总开关 |
| `skipBelowKB` | `300` | 小于该大小的图片不压缩 |
| `maxLongEdge` | `1920` | 压缩后图片的最长边 |
| `targetKB` | `375` | 压缩目标大小 |
| `contextOptimization.enabled` | `true` | 上下文归档开关 |
| `contextOptimization.archive.maxSizeMB` | `2048` | 归档容量上限 |
| `contextOptimization.archive.retentionDays` | `30` | 归档保留天数 |
| `reporting.retentionDays` | `14` | 报告保留天数 |

以下环境变量可以改变存储位置：

| 环境变量 | 作用 |
|---|---|
| `PI_TRAFFIC_OPT_CONFIG_PATH` | 配置文件路径 |
| `PI_TRAFFIC_OPT_ARCHIVE_DIR` | 归档目录 |
| `PI_TRAFFIC_OPT_REPORT_DIR` | 本次运行的报告目录 |
| `PI_TRAFFIC_OPT_CACHE_DIR` | 图片缓存目录，默认在系统临时目录 |

## 数据与隐私

归档和报告只保存在本机。归档包含工具输出、命令参数和图片原文，报告可能包含文件路径和模型端点，分享前请检查内容。迁移会话时，请同时迁移归档目录。

## 许可证

[MIT](LICENSE)
