# Collector Throughput Improvement Plan — ✅ Completed

> Status: All sections (A–F) landed; `make ci` green (77 files checked, 0 failed). Only pre-existing sloc-guard warnings remain, none introduced by this plan.

## Problem Statement

`collect-quality` workflow 每次跑约 5–8 分钟。根因（对应 `collector/quality/run.go:246-270` 和 `collector/github/client.go:137-164`）：

1. **完全串行**：`for language { for threshold { count; upsert } }`，当前 30 × 5 = 150 次迭代全部串行。
2. **GitHub 客户端无主动限流**：只在 429 之后被动退避，不读 `X-RateLimit-Remaining`。每个窗口浪费 1 次 429 往返 + 尾部跨窗口空转。
3. **Worker upsert RTT 挤占 GitHub 节奏**：每次迭代的 `r.search.CountRepositories` 与 `r.ingest.UpsertRow` 串行绑定，Worker RTT（~200–500ms）把 GitHub 调用窗口搅乱。

## Hard Lower Bound

GitHub Search API 对认证用户当前限额 **30 req/min**。150 次调用的理论墙钟下限 ≈ 150 / 30 = **5 min**。任何单 token、单查询方式都无法突破。并发化能做的是"压平网络延迟尾部"，不会质变。

> **限速参数不硬编码**：GitHub 未来可能提升额度、用户也可能跑自建代理。`requests_per_minute` 与 `burst` 必须从配置 / env 读入；代码内只保留一个"未配置时的默认值"常量，易替换。

## Scope（一步到位，Phase 1 + 2 + 3 一起落地）

三项改动互相耦合：
- 去掉 per-row upsert RTT（Phase 1）后，GitHub 调用节奏才显露出来，主动限流（Phase 2）才有可观察的收益；
- 并发化（Phase 3）要求 `rate.Limiter` 在多 goroutine 间共享来自然化流，同时要求 upsert 走后端聚合路径避免每个 worker 独立 upsert 制造冲突。
- 分期交付会产生两次接口契约破坏（`RunIngestor` 与 Worker 路由），不划算。

按 AGENTS.md 的 "No Backward Compatibility"（pre-v1.0、无外部消费者）：**一次性重塑契约，不保留旧单行路径**。

---

## Change Set

### A. Worker — 批量 upsert 端点（替换单行端点）

**删除**：
- `worker/src/routes/internal/quality-runs-row-upsert.ts`（整文件）
- `worker/src/index.ts` 中 `INTERNAL_ROW_UPSERT_PATH` 常量、`maybeHandleInternalRowUpsert` 及其 `??` 组合
- `worker/src/quality-runs.ts` 中 `upsertQualityRunRow` 函数
- `worker/test/internal-quality-runs.test.ts` 里 row-upsert 相关 `describe` 块（精确改，不整文件删）
- **保留** `worker/test/quality-runs-toctou.test.ts`——该文件覆盖的是 `finalizeQualityRun` 的状态迁移 TOCTOU，与 row-upsert 无关

**新增**：
- 路由：`POST /internal/quality-runs/:id/rows:batch`
  - 保留冒号后缀 `:batch` 的 Google AIP 风格，在 `INTERNAL_ROW_BATCH_PATH` 正则里写成 `/^\/internal\/quality-runs\/([^/]+)\/rows:batch$/`
- Handler：`worker/src/routes/internal/quality-runs-rows-batch.ts`
  - `requireServiceAuth` → `readJsonObject`（payload: `{ "rows": RowUpsert[] }`）→ 调用 `upsertQualityRunRows`
  - 返回 `qualityRunResponse(run)`（与旧 handler 形态一致）
- `worker/src/quality-runs.ts` 新增 `upsertQualityRunRows(context, runId, rows) → QualityRunRecord`
  - **单次 D1 事务**：`database.batch([...])` 里**每行一条** `INSERT ... ON CONFLICT DO UPDATE`（N 条 statement，不是单条多-VALUES——D1 单语句 bind 上限 100，150×5=750 会被拒），最后追加一条 `UPDATE quality_30d_runs SET actual_rows = (SELECT COUNT(*)...)` 同步 actual_rows。所有行共用一次 lease 校验（批入口做一次、每条 INSERT 的 SQL 里用 `WHERE EXISTS (... AND lease_expires_at > ?)` 兜底）。
  - **每行校验**：`languageId ∈ registry`、`thresholdValue ∈ registry`、`active_from/active_to` 覆盖 `observed_date`；任一失败 → `HttpError(400/409)`，整批拒绝（batch 语义）。
  - **空数组**：collector 不会发送空 batch（调用点唯一），但服务端仍然要 reject 空 `rows` 防止契约漂移。
  - **大小上限**：设 `MAX_BATCH_ROWS = 500` 常量（150 是当前产品面的真实值，500 留出扩容余量），超过则 413。

**payload 契约**（locked）：

```json
{
  "rows": [
    {
      "language_id": "go",
      "threshold_value": 0,
      "count": 12345,
      "collected_at": "2026-04-19T10:12:00Z"
    },
    ...
  ]
}
```

`run_id` 不在 body 里，从 path 取（与单行端点的惯例一致）。

**返回体**：与旧单行端点相同——`qualityRunResponse(run)`，让 collector 侧能解出更新后的 `QualityRunRecord`（调用方目前不读，但响应一致对日后观测/调试有用）。

---

### B. Collector — `RunIngestor` 契约重塑

`collector/quality/run.go`：

```go
type RunIngestor interface {
    CreateRun(ctx context.Context, request CreateRunRequest) (CreatedRun, error)
    HeartbeatRun(ctx context.Context, runID string) (HeartbeatResult, error)
    UpsertRows(ctx context.Context, rows []RowUpsert) error   // 替换 UpsertRow
    FinalizeRun(ctx context.Context, request FinalizeRequest) (FinalizeResult, error)
}
```

- 删除 `UpsertRow(ctx, RowUpsert) error`。
- `RowUpsert` 结构保留不变（包含 `RunID` 字段虽然冗余——batch 端点从 path 取 id——但保留让调用方无需分离 id 和 body）。
- `collector/ingest/client.go` 对应实现：
  - 删除 `(c *Client) UpsertRow(...)`
  - 新增 `(c *Client) UpsertRows(ctx, rows []RowUpsert) error`
    - 断言 `len(rows) > 0` 与 `rows` 中的 `RunID` 全部相同（从第一个取 id 拼 path），避免跨 run 的 payload 污染
    - `PathEscape(runID)` 拼出 `/internal/quality-runs/:id/rows:batch`
    - body：`{"rows": [...]}`，每行 `collected_at` 用 RFC3339
    - drain + close response body（保留现有 `errjoin` 模式）

---

### C. Collector — `Runner.Run` 并发化 + 批量写

`collector/quality/run.go` 的主循环彻底重写：

**收集阶段**（并发）：
- 把 `activeLanguages × activeThresholds` 笛卡尔积扁平化成 `tasks []task{language, threshold, query}` slice。
- 用 `golang.org/x/sync/errgroup`（需加到 `go.sum`）：`group, groupCtx := errgroup.WithContext(workCtx)` + `group.SetLimit(workerCount)`；**每个 worker 的 `search.CountRepositories` 必须传 `groupCtx`**，否则兄弟 worker 的 fail-fast 取消不会传播。
  - `workerCount` 来自配置（见 D 节），默认 4。
- **并发收益的真实上限**：limiter 默认 `rate.Every(2s)/burst=1` → 全进程吞吐恒为 30/min，并发 ≈ 压平首帧 HTTP RTT(~500ms 量级)，不会拉高稳态吞吐。若要真正获得并行红利，需把 `LANGPULSE_GITHUB_REQUEST_BURST` 调高到 N(e.g. 5)并接受"瞬时突发被 GitHub 侧计入 30/min 窗口"的风险——默认配置不走这条路。
- 每个 worker 共享同一个 `*rate.Limiter`（B/D 节、装在 `github.Client` 里），在 `executeRequest` 入口处 `limiter.Wait(ctx)`——自然化流，不在 Runner 层再套一层限流。
- 结果通过 channel 流向 writer（或直接用带锁的 slice；150 次，锁开销可忽略，优先 slice + mutex 的简单实现）。
- 任一 worker 失败 → 返回 error，errgroup 自动取消其余 worker 的 ctx；通过现有 `workCtx + lease controller` 的取消链把 lease goroutine 一并收尾。

**写入阶段**（单次 batch）：
- 所有 task 完成后，Runner 拿到完整 `rows []RowUpsert`（长度 = expected_rows）；
- 一次 `r.ingest.UpsertRows(ctx, rows)` → 整批写入；
- 后续 `HeartbeatRun` → `FinalizeRun` 链路不变。

**heartbeat 并发安全**（验证而非修改）：
- `maintainLease` 是单 goroutine 消费者，本来就串行地调 `HeartbeatRun`；**并发化的是 search+row 收集，不是 heartbeat**。worker 无权触碰 lease——维持现有结构即可。
- 新增一个并发 run 的测试：多个 worker 并发失败时 `failRun` 只执行一次，`stopLease` 幂等。现有 `exclusiveLeaseIngest` 测试架构（`run_lease_test.go`）可复用。

**错误聚合**：
- errgroup 只保留第一个 error（其 `context.Canceled` 传染是预期的）；真正的根因 error 通过 errgroup 的 `Wait()` 拿到。
- failRun 路径保留 `leaseErr` 优先于 `original` 的当前语义——只需确保第一 worker 的真实 error 不被其他 worker 的 `context.Canceled` 压盖。errgroup 默认就是这个语义，直接用。

**取消 early-row-writes**：
- 目前没有"部分写"概念（batch 是 end-of-run 原子动作），所以 worker 取消时不需要 rollback D1——什么都还没写。
- 运行中途崩溃：lease 过期后 Worker 的 `expireRun` 会把 run 标记为 `expired`，与当前逐行写的语义等价（expired run 的 rows 反正不会被 publish）。

✅ Done — Collector RunIngestor + Runner concurrency + ingest client (Sections B + C + F-collector)

---

### D. GitHub client — 主动限流 + X-RateLimit 读取

`collector/github/client.go`：

**新增字段**：
```go
type Client struct {
    ...existing...
    limiter *rate.Limiter   // golang.org/x/time/rate
}
```

**新增 option**（不写死速率）：
```go
// WithRateLimit 注入外部构造好的 *rate.Limiter。
// 典型用法：rate.NewLimiter(rate.Every(2*time.Second), 1) 对应 30 req/min burst 1。
// 不调用此 option → 回退到 defaultRequestsPerMinute / defaultRequestBurst 常量（下方）。
func WithRateLimit(limiter *rate.Limiter) Option { ... }
```

**默认常量**（仅作 fallback，不作为"硬上限"语义）：
```go
const (
    defaultRequestsPerMinute = 30   // GitHub 当前公开文档值，随时可调
    defaultRequestBurst      = 1
)
```

`NewClient` 在 `limiter == nil` 时用默认值构造。**生产路径通过 env / flag 注入**，不依赖默认值。

**`executeRequest` 改造**：
1. 入口：`if err := c.limiter.Wait(ctx); err != nil { return 0, -1, fmt.Errorf("rate limiter wait: %w", err) }`
2. 成功响应解析 rate-limit headers——**作用于共享 limiter 本身**，不是 per-worker sleep：
   ```go
   if response.Header.Get("X-RateLimit-Resource") == "search" {
       remaining, _ := strconv.Atoi(response.Header.Get("X-RateLimit-Remaining"))
       if remaining < defaultLowRemainingThreshold {  // 常量默认 3
           reset, _ := strconv.ParseInt(response.Header.Get("X-RateLimit-Reset"), 10, 64)
           resetAt := time.Unix(reset, 0).UTC()
           // 把共享 limiter 的下一个 token 推迟到窗口重置时刻——所有 worker 一起停，
           // 避免 B/C/D 继续从 limiter 抽走最后两个配额撞 429。
           c.limiter.SetBurstAt(resetAt, 0)
           c.limiter.SetLimitAt(resetAt, rate.Every(c.interval))  // 恢复稳态速率
       }
   }
   ```
   - **只在 `resource == "search"` 时更新**——同一 token 的 `core`（5000/h）与 `search`（30/min）是独立计数桶，混用会误判。
   - **header 缺失 fallback**：若 2xx 响应未带 `X-RateLimit-Resource`（自建代理 / GHE 可能不返回），不触发调整——现有 limiter 稳态速率本身就是保守的 pacer。
3. 429 / 403 / 5xx 的退避路径保持现有实现（`retryDelay` + `ClampRetryDelay`），兼容 `Retry-After` 与 `X-RateLimit-Reset` header。

**测试策略**：
- 所有 `github` 包的现有测试改为构造 `rate.NewLimiter(rate.Inf, 1)`（零等待）→ 不改测试语义。
- 新增两组：
  - `TestLimiterWaitIsCalledOncePerRequest`：用 fake clock 驱动的 `*rate.Limiter`，验证 N 次请求会产生 N-1 次 Wait 阻塞。
  - `TestLowRemainingTriggersActiveSleep`：handler 返回 `X-RateLimit-Remaining: 2`、`X-RateLimit-Resource: search`、`X-RateLimit-Reset: <future>`，验证 client 调用了 `c.sleep` 并传入正确 duration。
- `resource` 不是 `search` 的 low-remaining header 不应触发停顿——加一个负 case。

Done — GitHub client rate limiter + CLI (Sections D + E)

---

### E. 配置 & CLI — 限速参数与并发度注入

`collector/cmd/collect-quality/main.go`：

**新增 env / flag**（限速、并发都不写死）：

| env | flag | 默认 | 含义 |
|---|---|---|---|
| `LANGPULSE_GITHUB_REQUESTS_PER_MINUTE` | `--github-requests-per-minute` | `0`（= 走 client 默认常量 30） | GitHub search 限速（req/min） |
| `LANGPULSE_GITHUB_REQUEST_BURST` | `--github-request-burst` | `0`（= 走 client 默认常量 1） | 限速令牌桶容量 |
| `LANGPULSE_COLLECTOR_CONCURRENCY` | `--concurrency` | `4` | errgroup worker 数 |

- `settings` 结构增加三字段，`resolveSettings` 里解析。
- `0` 作为"未配置"sentinel，交给下游用 hard-coded 默认；**不在 CLI 层硬编码 30/min**，只在 `github` 包的默认常量里保留。
- flag 与 env 同时存在时，flag 优先（与现有 `--github-api-base-url` 的语义一致）。
- `runWithSettings` 把解析后的值传给 `github.NewClient`（通过 `WithRateLimit(rate.NewLimiter(...))`）和 `quality.NewRunner`（新增 `WithConcurrency(n)` option 或直接参数，推荐 option 风格保持对称）。

Done — GitHub client rate limiter + CLI (Sections D + E)

---

### F. 测试 / Smoke 契约同步

- `collector/ingest/client_test.go`：删旧 `UpsertRow` 测试、加 `UpsertRows` 测试（含空 slice 拒绝、跨 run_id 拒绝、429/400 透传）。
- `collector/quality/run_test.go`：
  - `fakeIngest.UpsertRow` → `UpsertRows([]RowUpsert)`，改收集所有行到 `rows` 字段。
  - 新增 `TestRunnerRunConcurrentSearchFailureCancelsSiblings`：两个 worker 中一个返回 err，验证另一个 worker 看到 `ctx.Err() == context.Canceled`，且 `failRun` 只 finalize 一次。
  - 新增 `TestRunnerRunWritesAllRowsInSingleBatch`：验证 `fakeIngest.UpsertRows` 仅被调用 1 次、长度等于 `expected_rows`。
- `worker/test/`：
  - 删除 row-upsert 相关测试。
  - 新增 `quality-runs-rows-batch.test.ts` 覆盖：成功批写、lease 过期、未知 language / threshold、非激活、空 rows、超过 MAX_BATCH_ROWS、actual_rows 同步。
- `.github/scripts/smoke-quality-api.mjs`（`:149` 的 `/rows/{LANGUAGE_ID}/{THRESHOLD_VALUE}` 模板）：改成构造 `rows:batch` 单次调用，payload 聚合所有 language × threshold 组合。
- `collector/cmd/collect-quality/main_test.go`：新增三个 env / flag 的解析 case。

✅ Done — Smoke script migrated to rows:batch (Section F smoke)

---

## Implementation Order（单一 PR 内的落地顺序，确保中途任何 commit 可编译）

1. **worker**：增加 `rows:batch` handler + `upsertQualityRunRows`，**暂不删**旧路径与旧函数。跑通新测试。
2. **collector (ingest client)**：新增 `UpsertRows`，**暂不删**旧 `UpsertRow`。
3. **collector (Runner)**：改 `RunIngestor` 接口——此时 `UpsertRow` 同时保留旧签名会冲突，所以这步一次性删旧接口方法、重写 Runner.Run 用 errgroup + UpsertRows。修所有测试。
4. **github client**：引入 `*rate.Limiter` + `WithRateLimit` option + `executeRequest` 改造；把 collector/cmd/collect-quality 接起来（env / flag）。
5. **worker**：删除旧单行 upsert（路由、handler、函数、测试）。
6. **smoke script**：切到新端点。
7. `make ci` 跑通。

> 为什么不从 worker 先删：删路由 + Go client 改接口 + Runner 改主循环耦合在同一 PR 里，先"加新"再"删旧"，中间节点都能 build。

---

## Expected Wins（实测指标）

所有指标通过 `quality_30d_runs.finished_at - started_at`（Worker D1 已记录）测量：

| Change | 预期节省 | 测量方式 |
|---|---|---|
| A + B + C（batch upsert） | 30–75s（消除 150 次 Worker RTT） | 对比 batch 前后平均墙钟 |
| D（主动 pacer + 共享 limiter 重置） | 5–15s（消除每窗口 1 次 429 + 尾部空转） | 对比 collector 日志里的 `limiter.Wait` 分布 |
| C（并发，默认 burst=1） | ~首帧 HTTP RTT（秒级），稳态吞吐不变 | 对比 `workerCount=1` 与 `workerCount=4` 的墙钟 |

**保守估计总节省**：主要来自 batch（A+B+C）与主动 pacer（D），5–8 min → **5–6 min**。并发默认配置下不是节省来源——它的价值是把未来 burst 调高（GitHub 提额 / 自建代理）时的扩展面留好。理论 floor 仍是 30/min × 150 = 5 min。

> 节省数字≠质变——真正价值是把"串行 + 被动退避"的脆弱节奏换成"主动限流 + 并发收集 + 原子写"的稳态，后续若 GitHub 提高限额（调大 `LANGPULSE_GITHUB_REQUESTS_PER_MINUTE`）可线性获益。

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| 并发下 lease 续约不足（150 次并发可能比串行更快 burn token 桶，心跳间隔漂移） | `maintainLease` 用 `nextLeaseHeartbeatDelay` 基于实际 `leaseExpiresAt` 自适应，不受 worker 节奏影响——保留现有逻辑即可 |
| `rate.Limiter` 在 errgroup 里被 N 个 worker 同时 Wait，是否公平？ | `rate.Limiter` 内部是 FIFO，公平性由标准库保证；不需要额外同步 |
| 一次 batch D1 事务 > D1 事务上限 | 当前 150 行 + 每行 2 bind slots × 2 statement ≈ 可控；`MAX_BATCH_ROWS=500` 预留余量，超限返回 413 |
| 错误诊断退化（150 行批写失败时，难定位是哪行 bind 出错） | `upsertQualityRunRows` 的 registry 校验在**入 D1 之前**完成，返回 400 时带 `language_id` / `threshold_value`；D1 层面的失败仍然整批回滚，需要靠 collector 日志拼出上下文 |
| Phase 3 并发改动引入 race | `go test -race ./...` 已是 `make ci` 的一部分；errgroup + 共享 `*rate.Limiter` + `[]RowUpsert` 加 `sync.Mutex` 是 race-free 模式 |

---

## Out of Scope

- GraphQL alias 合并查询（可把 150 次 REST 压到 ~30 次 GraphQL，但要重写整个 `github` 包 + 影响 registry 校验逻辑——独立议题，另开计划）。
- 多 token 轮转（需要新的 secret 管理 + token health 监控，独立议题）。
- Worker 侧 D1 分片 / 读写分离（目前瓶颈不在 D1）。

---

## Execution Progress

- ✅ Done — Smoke script migrated to rows:batch (Section F smoke)
- ✅ Done — Worker batch endpoint (Sections A + F-worker + step 5)
