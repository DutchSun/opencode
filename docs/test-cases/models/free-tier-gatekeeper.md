# Zen 免费模型 Gatekeeper（UA 版本号 403）

> 公共测试环境和配置请参考 [`00-preamble.md`](./00-preamble.md)。

## 背景

官方 Console 于 2026-09-17 上线 Gatekeeper：免费模型（`*-free`、`big-pickle`，走 `https://opencode.ai/zen/v1` + `Bearer public`）仅允许"OpenCode 本体"调用。判定条件之一是 UA 携带**真实发布版本号（≥1.17.0）**。SaaS 容器以 `bun run src/index.ts` 直接跑源码，构建期 define 未注入，`InstallationVersion` 回退为 `"local"`，导致 LLM 请求 UA 为 `opencode/local`，免费模型全部 403：

```json
{"type":"error","error":{"type":"FreeTierError","message":"OpenCode's free tier can only be used from within OpenCode"}}
```

**修复**：`packages/core/src/installation/version.ts` 支持 `OPENCODE_APP_VERSION` 环境变量覆盖（优先级 `env > 构建期 define > "local"`），容器启动时注入与 `package.json` 一致的版本号。

## 验证标准

| 层级 | 方法 | 判定标准 |
|------|------|---------|
| 1. 黑盒网关 | 直接 `curl zen/v1/chat/completions`（stream + tools shell/read + session 头） | UA=local → 403 FreeTierError；UA=真实版本 → 200 流式 |
| 2. 单测 | `packages/core/test/installation-version.test.ts` | env 覆盖 / 回退 / channel 一致性 3 用例通过 |
| 3. 容器运行态 | 容器内 import `version.ts` 打印 | `InstallationVersion` = 注入的 `OPENCODE_APP_VERSION` |

## 用例

### T10.1 黑盒复现：UA 版本号为 local 时 403

```bash
SES="ses_$(openssl rand -hex 6)$(head -c 20 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 14)"
BODY='{"model":"mimo-v2.6-flash-free","stream":true,"messages":[{"role":"user","content":"hi"}],"tools":[{"type":"function","function":{"name":"shell","parameters":{"type":"object"}}},{"type":"function","function":{"name":"read","parameters":{"type":"object"}}}]}'
curl -s --noproxy '*' https://opencode.ai/zen/v1/chat/completions \
  -H "Authorization: Bearer public" -H "Content-Type: application/json" \
  -H "User-Agent: opencode/local" -H "x-opencode-session: $SES" -d "$BODY"
```

**期望**：`FreeTierError`（ Gatekeeper 拒绝）。两段式（`opencode/local`）与四段式（`opencode/local/local/cli`）均被拒。

### T10.2 黑盒放行：UA 携带真实版本号

同上，仅替换 UA 为 `opencode/1.18.30`。

**期望**：HTTP 200，`data: {"object":"chat.completion.chunk",...}` 流式响应。

### T10.3 单测

```bash
cd packages/core && bun test test/installation-version.test.ts
```

**期望**：3 pass。

### T10.4 容器运行态验证

```bash
docker run -d --name opencode-saas-test ... -e OPENCODE_APP_VERSION=1.18.30 opencode-saas-sandbox-test:<tag>
docker cp packages/core/src/installation/version.ts opencode-saas-test:/app/packages/core/src/installation/version.ts
docker restart opencode-saas-test
docker exec opencode-saas-test sh -c 'cd /app/packages/core && bun -e "import(\"./src/installation/version.ts\").then(m=>console.log(m.InstallationVersion))"'
```

**期望**：输出 `1.18.30`；`GET $BASE/` 返回 200。

### T10.5 免费模型可用性矩阵（黑盒，UA=修复后）

对官方客户端模型选择器中的 10 个免费模型逐一请求（条件同 T10.2）。

**期望**：不再出现 `FreeTierError`；失败仅来自模型自身（deprecated / 上游不可用 / 地区限制）。

## 复测记录

| 日期 | 环境 | 结果 |
|---|---|---|
| 2026-10-12 | 黑盒 + 本地容器 t1012（组合 2） | T10.1 ✅ 403 复现；T10.2 ✅ mimo-v2.6-flash-free 流式 200；T10.3 ✅ 3 pass；T10.4 ✅ 容器 `InstallationVersion=1.18.30`、健康检查 200；T10.5 ✅ 无 FreeTierError，矩阵见下 |

### 模型矩阵（2026-10-12，UA=opencode/1.18.30）

| 模型 | 结果 |
|---|---|
| longcat-2.5-preview-free | ✅ 可用 |
| space-bunny-free | ✅ 可用 |
| mimo-v2.6-flash-free | ✅ 可用 |
| nemotron-3.5-lightning-free | ✅ 可用 |
| nemotron-3-ultra-free | ✅ 可用 |
| big-pickle | ✅ 可用 |
| exo-free | ❌ ModelDeprecated（官方已弃用） |
| ling-3.1-flash-free | ❌ 429 上游端点不可用 |
| muse-spark-1.3-contributor-free | ❌ RegionError 地区限制 |
| ling-3.0-flash-fin-free | ❌ 上游模型不可用 |

## 注意事项

1. **免费模型加载前置条件**：SaaS 侧 `opencode` provider 的模型目录需 Console credential（OAuth 连接或 `OPENCODE_API_KEY`），PG `credential` 表为空时 `/provider` 不会出现 `opencode`，免费模型无从选择——这是独立于 UA 的加载层问题。
2. 合规边界：修复本质是让 SaaS 以真实版本号通过客户端校验，官方策略可能继续收紧（IP 信誉：数据中心 ASN 出口会被拒）。免费模型不作生产主力。
3. `OPENCODE_APP_VERSION` 需随发布更新，建议 CI 从 `package.json` 注入；版本 <1.17.0 会重新触发 403。
4. 免费模型名单变动频繁（models.dev 目录与网关实际路由存在滞后），以 T10.5 实测为准。
