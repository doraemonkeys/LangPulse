# LangPulse

LangPulse 是一个面向公开 GitHub 仓库的单数据集产品。它每天采集一次语言质量快照，并通过 Cloudflare Worker API 与前端页面对外提供只读查询。

当前产品只发布一个指标：

- `quality_30d_snapshot`
  含义：在 UTC 日期 `D`，按语言 `L` 和 star 阈值 `T` 统计「最近 30 天内有 push、当前 stars 大于等于阈值、主语言匹配、公开可见」的 GitHub 仓库数量

## 产品边界

- 时区固定为 `UTC`
- 只从 `launch_date` 开始采集，不做历史回填
- 公开 API 只暴露已发布快照
- 成功发布后的 `observed_date` 不可变
- 时间序列允许稀疏，不补零
- 配置是 append-only：历史语言和阈值不会被复用或删除

## 仓库结构

```text
.
├─ collector/          Go 采集器，调用 GitHub Search 和内部 ingest API
├─ worker/             Cloudflare Worker，负责 ingest、发布和公开读取
├─ web/                前端页面，展示单张质量趋势图
├─ config/             指标维度配置，当前使用 metrics.json
├─ migrations/         D1 / SQLite schema
├─ .github/workflows/  校验、部署、日采集工作流
├─ docs/history_plan/  实施计划与产品契约
├─ go.mod              根模块，作为仓库级 Go 工作区锚点
└─ go.work             Go workspace
```

## 架构概览

1. `collector` 在当天 UTC 日期内发起 GitHub Search 查询。
2. 采集结果不直写 D1，而是写入 `worker` 的内部 ingest API。
3. `worker` 负责 run 生命周期、row upsert、finalize 发布和公开读取。
4. `web` 从 `/api/metadata`、`/api/quality`、`/api/quality/latest` 读取数据并绘图。
5. GitHub Actions 负责验证、部署和每日采集。

## API 概览

公开接口：

- `GET /api/metadata`
- `GET /api/quality?language=<id>&from=<yyyy-mm-dd>&to=<yyyy-mm-dd>`
- `GET /api/quality/latest`
- `GET /api/health`

内部 ingest 接口：

- `POST /internal/quality-runs`
- `POST /internal/quality-runs/{run_id}/heartbeat`
- `PUT /internal/quality-runs/{run_id}/rows/{language_id}/{threshold_value}`
- `POST /internal/quality-runs/{run_id}/finalize`

## 本地开发前置

- Go `1.26`
- Node.js `22`
- npm
- GNU Make
- Bash 兼容 shell
- Rust / Cargo
- 如需跑真实 Worker / D1 部署链路，需要 Cloudflare 账号与对应凭据

## 常用命令

```bash
make ci
```

首次本地运行前需要安装 `sloc-guard`：

```bash
cargo install sloc-guard
```

运行采集器时需要的关键环境变量：

- `GITHUB_TOKEN`
- `LANGPULSE_INGEST_BASE_URL`
- `LANGPULSE_INGEST_TOKEN`
- 可选：`LANGPULSE_CONFIG_PATH`
- 可选：`LANGPULSE_OBSERVED_DATE`
- 可选：`GITHUB_API_BASE_URL`

示例：

```bash
go run ./collector/cmd/collect-quality
```

采集器会自动优先读取仓库中的 `config/metrics.json`。

## 配置

指标维度定义位于 [config/metrics.json](config/metrics.json)。

它包含：

- `timezone`
- `window_days`
- `launch_date`
- `languages`
- `thresholds`

其中：

- `language.id` 是公开稳定标识
- `label` 只用于展示
- `github_query_fragment` 只用于采集器查询，并且必须是完整的 GitHub 搜索片段
- `active_from` / `active_to` 只影响未来采集，不隐藏已发布历史

## 数据库

迁移文件位于 [migrations/0001_init.sql](migrations/0001_init.sql)。

核心表：

- `quality_30d_runs`
- `quality_30d_run_rows`
- `quality_30d_publications`

该设计把「采集尝试」「单行结果」「公开发布」明确分离，便于：

- 处理同一天的重试
- 记录失败与过期尝试
- 保证公开数据不可变

## CI / CD

工作流：

- [validate.yml](.github/workflows/validate.yml)
  在 PR 和手动触发时运行，校验 Go、Worker、Web，并强制 90% 覆盖率门槛
- [collect-quality.yml](.github/workflows/collect-quality.yml)
  构建并执行当日采集，必要时输出 D1 诊断信息
- [deploy.yml](.github/workflows/deploy.yml)
  渲染环境化 Wrangler 配置、应用 migration、构建前端静态资源、部署同源 Worker、再执行 smoke

Wrangler 配置模板在 [worker/wrangler.toml](worker/wrangler.toml)，真实环境配置由 CI 在部署时通过 [render-wrangler-config.mjs](.github/scripts/render-wrangler-config.mjs) 渲染生成。

## 部署所需 GitHub 配置

常见 `vars`：

- `LANGPULSE_API_BASE_URL`
- `LANGPULSE_INGEST_BASE_URL`
- `LANGPULSE_D1_DATABASE`
- `LANGPULSE_D1_DATABASE_ID`
- `LANGPULSE_SMOKE_D1_DATABASE`
- `LANGPULSE_SMOKE_D1_DATABASE_ID`

常见 `secrets`：

- `LANGPULSE_GITHUB_API_TOKEN`
- `LANGPULSE_INGEST_AUTH_TOKEN`
- `LANGPULSE_SMOKE_INTERNAL_AUTH_TOKEN`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

## 当前验证基线

本仓库当前要求并已接入 CI 的校验基线：

- 根目录 `make ci`
- Worker 类型检查、覆盖率校验、构建
- Web 类型检查、覆盖率校验、构建
- 覆盖率门槛 `90%`
