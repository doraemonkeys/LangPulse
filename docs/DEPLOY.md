# LangPulse 上线说明

## 适用范围

本文档说明如何把当前仓库发布到生产环境，并解释为什么当前流程不会自动创建 Cloudflare D1 数据库。

当前仓库的生产托管模型是：

- Cloudflare Worker 同时承载前端静态资源和公开 API
- GitHub Actions 负责校验、部署、迁移和每日采集
- Cloudflare D1 保存运行记录、行数据和公开发布结果

相关约束可参考：

- `docs/clarifications/hosting-and-config-contract.md`
- `.github/workflows/deploy.yml`
- `.github/workflows/collect-quality.yml`

## D1 数据库会自动创建吗

不会。

当前部署工作流只会：

1. 从 GitHub Variables 读取已经存在的数据库名和数据库 ID
2. 渲染部署期 `wrangler.toml`
3. 对现有 D1 数据库执行 migration
4. 部署 production 和 smoke 两个 Worker 环境

它不会在部署时创建 D1 数据库。根因不是“少写了一步脚本”，而是当前基础设施模型要求数据库身份稳定：

- `production` 数据库必须持续承载真实历史数据
- `smoke` 数据库必须与 `production` 隔离
- 部署只应更新 schema 和 Worker 代码，不应在每次发布时生成新的数据库身份

因此，D1 数据库必须在第一次上线前人工创建，然后把 `database_name` 和 `database_id` 写入 GitHub Variables。

## 一次性准备

### 1. Cloudflare 账号与权限

你需要：

- 一个可用的 Cloudflare 账号
- 一个可部署 Worker、可访问 D1 的 API Token
- Cloudflare Account ID

GitHub 侧需要能够修改仓库 `Variables` 和 `Secrets`。

### 2. 手动创建两个 D1 数据库

必须创建两个数据库：

- 一个给 `production`
- 一个给 `smoke`

推荐名称：

- `langpulse-production`
- `langpulse-smoke`

可以在 Cloudflare Dashboard 创建，也可以用 Wrangler 创建。Cloudflare 官方文档当前给出的命令是：

```bash
npx wrangler d1 create langpulse-production
npx wrangler d1 create langpulse-smoke
```

创建后请保存这两项信息：

- `database_name`
- `database_id`

如果后续忘了数据库 ID，可以再用 Wrangler 列表命令或 Cloudflare Dashboard 查回。

参考官方文档：

- https://developers.cloudflare.com/d1/wrangler-commands/
- https://developers.cloudflare.com/d1/get-started/

### 3. 配置 GitHub Variables

在 GitHub 仓库中创建这些 `Variables`：

| Name | 用途 | 何时必须 |
| --- | --- | --- |
| `LANGPULSE_D1_DATABASE` | production D1 数据库名 | 部署前必须 |
| `LANGPULSE_D1_DATABASE_ID` | production D1 数据库 ID | 部署前必须 |
| `LANGPULSE_SMOKE_D1_DATABASE` | smoke D1 数据库名 | 部署前必须 |
| `LANGPULSE_SMOKE_D1_DATABASE_ID` | smoke D1 数据库 ID | 部署前必须 |
| `LANGPULSE_API_BASE_URL` | 生产站点根地址，用于采集后校验公开发布结果 | 首次采集前必须 |
| `LANGPULSE_INGEST_BASE_URL` | 生产站点根地址，用于 collector 调用内部 ingest API | 首次采集前必须 |

注意：

- `LANGPULSE_API_BASE_URL` 和 `LANGPULSE_INGEST_BASE_URL` 在当前架构下通常是同一个值
- 两者都必须填写站点根地址，不要带 `/api` 或 `/internal`
- 例如：`https://langpulse.example.com` 或 `https://langpulse-worker.<subdomain>.workers.dev`

### 4. 配置 GitHub Secrets

在 GitHub 仓库中创建这些 `Secrets`：

| Name | 用途 | 何时必须 |
| --- | --- | --- |
| `LANGPULSE_INGEST_AUTH_TOKEN` | production 内部 ingest 鉴权 | 部署前必须 |
| `LANGPULSE_SMOKE_INTERNAL_AUTH_TOKEN` | smoke 内部 ingest 鉴权 | 部署前必须 |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions 调用 Cloudflare API | 部署前必须 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID | 部署前必须 |
| `LANGPULSE_GITHUB_API_TOKEN` | collector 调用 GitHub Search API | 首次采集前必须 |

建议：

- `LANGPULSE_INGEST_AUTH_TOKEN` 与 `LANGPULSE_SMOKE_INTERNAL_AUTH_TOKEN` 使用不同值
- `LANGPULSE_GITHUB_API_TOKEN` 使用能稳定访问 GitHub Search API 的 token

## 首次上线顺序

### 阶段一：完成部署基础设施

1. 手动创建两个 D1 数据库
2. 配置部署必需的 GitHub Variables 和 Secrets
3. 本地运行：

```bash
make ci
```

4. 推送到 `main`，或手动触发 `Deploy` workflow

当前 `Deploy` workflow 会做这些事情：

1. 校验 D1 / Cloudflare / 内部鉴权配置是否存在
2. 渲染 production 与 smoke 两套 Wrangler 配置
3. 对两个 D1 数据库执行 migration
4. 构建前端
5. 部署 production Worker
6. 部署 smoke Worker
7. 对 smoke 环境做 API 和前端 smoke test

### 阶段二：补齐生产根地址

如果你使用的是 Cloudflare 分配的 `workers.dev` 域名，最稳妥的方式是：

1. 先完成第一次部署
2. 在 Actions 或 Cloudflare Dashboard 中确认 production Worker 的可访问根地址
3. 把这个根地址写入：
   `LANGPULSE_API_BASE_URL`
4. 把同一个根地址写入：
   `LANGPULSE_INGEST_BASE_URL`

如果你已经提前配置了自定义域名，则可以在首次部署前直接填写这两个变量。

## 首次采集

网站部署成功后，不代表已经有公开数据。

前端在没有已发布快照时仍然可以打开，但会显示当前范围内没有已发布快照。要让页面出现真实图表，需要至少完成一次成功采集和发布。

首次采集步骤：

1. 确认 `LANGPULSE_API_BASE_URL` 已配置
2. 确认 `LANGPULSE_INGEST_BASE_URL` 已配置
3. 确认 `LANGPULSE_GITHUB_API_TOKEN` 已配置
4. 手动触发 GitHub Actions 中的 `Collect Quality Snapshot`

当前工作流计划任务是：

- 每天 `00:15 UTC`

按北京时间计算，是每天 `08:15`。

## 上线后验证

至少检查这几个地址：

- `/`
- `/api/health`
- `/api/metadata`
- `/api/quality/latest`

验证标准：

- 首页能返回 HTML
- `/api/health` 返回 `ok`
- `/api/metadata` 能返回语言和阈值配置
- `/api/quality/latest` 在首次成功采集后应返回当天或最新一次已发布日期

## 触发规则

### Validate

`Validate` workflow 当前触发条件是：

- `pull_request`
- `workflow_dispatch`

这意味着：

- 推到 `main` 不会自动跑 `Validate`
- 推送前最好先本地执行 `make ci`

### Deploy

`Deploy` workflow 当前触发条件是：

- `push` 到 `main`
- 且改动命中以下路径之一：
  - `.github/scripts/**`
  - `.github/workflows/deploy.yml`
  - `config/**`
  - `migrations/**`
  - `web/**`
  - `worker/**`
- 或手动 `workflow_dispatch`

注意：

- 只改 `collector/**` 不会自动触发部署

### Collect Quality Snapshot

`Collect Quality Snapshot` 当前触发条件是：

- 定时任务：`15 0 * * *`
- 手动 `workflow_dispatch`

## 常见失败与处理

### 1. Deploy 一开始就失败，说缺少 D1 变量

原因：

- 你还没创建 D1 数据库
- 或 GitHub Variables 中没填 `database_name` / `database_id`

处理：

- 先手动创建 production / smoke 数据库
- 再把名字和 ID 写入 GitHub Variables

### 2. Deploy 成功，但首页没有图表

原因：

- 还没有成功发布任何快照

处理：

- 补齐采集相关变量与 secret
- 手动运行一次 `Collect Quality Snapshot`

### 3. Collect 失败，说缺少 `LANGPULSE_API_BASE_URL` 或 `LANGPULSE_INGEST_BASE_URL`

原因：

- 生产根地址尚未写入 GitHub Variables

处理：

- 把生产 Worker 根地址填入这两个变量
- 不要带 `/api` 或 `/internal`

### 4. Collect 失败，但 Deploy 是成功的

优先排查：

- `LANGPULSE_GITHUB_API_TOKEN` 是否存在
- `LANGPULSE_INGEST_AUTH_TOKEN` 是否与 production Worker 配置一致
- `LANGPULSE_INGEST_BASE_URL` 是否指向 production Worker 根地址

## 最小可执行清单

如果你只想最快把网站跑起来，按这个顺序做：

1. 在 Cloudflare 创建 `production` 和 `smoke` 两个 D1 数据库
2. 在 GitHub 填好四个部署必需 `Variables`
3. 在 GitHub 填好四个部署必需 `Secrets`
4. 本地执行 `make ci`
5. 推到 `main` 或手动触发 `Deploy`
6. 取到 production Worker 根地址
7. 填写 `LANGPULSE_API_BASE_URL` 和 `LANGPULSE_INGEST_BASE_URL`
8. 填写 `LANGPULSE_GITHUB_API_TOKEN`
9. 手动触发一次 `Collect Quality Snapshot`
10. 检查首页和 `/api/*` 接口
