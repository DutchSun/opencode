# AI 对话与工具调用

> 公共测试环境和配置请参考 [`00-preamble.md`](./00-preamble.md)。
>
> **注意**：文档中的 `bun -e "fetch('http://127.0.0.1:4096/...')"` 原使用容器内部端口。本地测试时改用 `http://localhost:14096`（宿主机映射端口）。下方用例已统一为 `$BASE` 变量。

### 通用变量

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"
```

## 四、AI 对话与工具调用

### T4.1 简单文本对话
```bash
curl -s --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"1+1等于几"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}'
```
**期望**：AI 返回包含 `2` 的文本

### T4.2 多轮上下文记忆
```bash
# 第一轮
curl -s --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"记住我叫张三"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}'

# 第二轮
curl -s --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"我叫什么？"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}'
```
**期望**：第二轮回复中含「张三」

### T4.3 写文件工具
```bash
# 发送消息
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"在 /workspace 创建 t4-3.txt 内容是 hello"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}'

# 验证工具调用（POST /message 返回的是文字总结，工具调用在前一条消息中）
curl -s "$BASE/session/$SID/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin, strict=False)
tools = []
for m in msgs[-3:]:
    for p in m.get('parts', []):
        if p.get('type') == 'tool':
            tools.append(p['tool'] + '(' + p.get('state', {}).get('status', '?') + ')')
print('tools:', tools if tools else '❌ NO TOOLS')
"
```
**期望**：`tools` 包含 `write(completed)` 或 `bash(completed)`；文字总结确认文件已创建

### T4.4 读文件工具
```bash
curl -s --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"读 /workspace/t4-3.txt"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}'
```
**期望**：`tools` 包含 `read(completed)`；回复中含 `hello`

### T4.5 bash 命令执行
```bash
curl -s --max-time 30 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"执行 ls /workspace 命令"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}'
```
**期望**：`tools` 包含 `bash(completed)` 或 `read(completed)`；回复中含文件列表或 `t4-3.txt`

### T4.6 异步消息（不等结果）
```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"写一首五言绝句"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}'
```
**期望**：`status: 204`

### T4.7 中断会话
```bash
# 先异步发送一个长任务
curl -s -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"写一篇1万字的文章"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}'

# 立即中断
sleep 1 && curl -s -X POST "$BASE/session/$SID/abort"
```
**期望**：abort 返回 `true`，session 不再是 `busy`。如果中断前 assistant message 已落库，最后一条消息应为 `finish=abort`、`finish=error` 或类似终止状态；如果在首个 assistant message 落库前中断，历史中可以没有 assistant message。

**2026-07-22 实测**：等待 session 进入 `busy` 后调用 abort，返回 `true`，随后 session 从 busy status 列表移除；本次中断发生在首个 assistant message 落库前，因此没有 `finish` 字段，符合上述早期中断语义。

**2026-08-19 复测**（镜像 `dd06ab0`，commit dd06ab076b，T4.1–T4.7 全部通过）：

| 用例 | 结果 | 备注 |
|---|---|---|
| T4.1 简单文本对话 | ✅ | 回复 `2` |
| T4.2 多轮上下文记忆 | ✅ | 第二轮回复「张三」 |
| T4.3 写文件工具 | ✅ | `write(completed)` |
| T4.4 读文件工具 | ✅ | 回复含 `hello` |
| T4.5 bash 命令执行 | ✅ | 回复含 `t4-3.txt` |
| T4.6 异步消息 | ✅ | HTTP 204 |
| T4.7 中断会话 | ✅ | abort 返回 `true`；中断发生在 assistant message 落库后，`finish` 为空，parts 数量 8s 内无增长，确认已停止生成 |

---

**2026-08-31 复测**（镜像 `basesroute`，commit `cc0d5fecda` + docs `7aab8b011f`，组合 1，全新 session `ses_fa87b0780ffe…`，T4.1–T4.7 全部通过）：

| 用例 | 结果 | 备注 |
|---|---|---|
| T4.1 简单文本对话 | ✅ | 回复 `2` |
| T4.2 多轮上下文记忆 | ✅ | 第二轮回复「张三」 |
| T4.3 写文件工具 | ✅ | `write(completed)`；沙箱内 `cat` 实锤内容 `hello` |
| T4.4 读文件工具 | ✅ | `read(completed)`，回复含 `hello` |
| T4.5 bash 命令执行 | ✅ | 回复含 `t4-3.txt` |
| T4.6 异步消息 | ✅ | HTTP 204，异步完成后五言绝句正常落库 |
| T4.7 中断会话 | ✅ | abort 返回 `true`；中断发生在 assistant message 落库后（parts=`step-start`,`reasoning`，无 `step-finish`），`finish` 为空，parts 8s 内无增长，确认停止生成 |

> ⚠️ 发现：`GET /session?is_busy=true` 的过滤参数**未生效**（与无参数请求同样返回全量 100 条，limit 截断），无法用于 busy 判定。T4.7 改用文档期望的替代判据（abort=true + 最后 assistant 消息 `finish` 为空 + parts 停止增长）。该接口问题与本次改动无关（既有行为），建议后续修复或改用其他状态查询端点。


> 复测记录（2026-09-06，merge upstream/dev v1.18.29 后，镜像 `t0906-merged-1.18.29`，组合 3）：T4.1 ✅（finish=stop）/ T4.2 ✅（上下文记忆「蓝鲸47号」）/ T4.3+T4.4 ✅（write→read 闭环回读 `hello_merge_2026`）/ T4.6 ✅（async 204 + assistant 落库）。
> ⚠️ T4.5 bash 本轮模型未真实调用（tools=0）：经 merge 前镜像（tool-input-stream）A/B 对照（各 3 次同 prompt，均 0/3 触发）+ 模型自报工具清单含 bash + config 无禁用，定性为 **deepseek-v4-flash 行为波动**，非 merge 回归；工具链路健康由 T4.3 write 闭环 + sse.md T9.6（早间真实触发 pending→running→completed）覆盖。T4.7 本轮未复测。

> 复测记录（2026-09-07，镜像 `opencode-saas-sandbox-test:so-test`（含 NUL guard / format 读回修复 / session event + prompt_stream 新端点），本地 PG + 远端沙箱（K8s 30040 转发），真实 LLM `Yd-DeepSeek/deepseek-v4-flash`）：**T4.1–T4.7 全部通过**。
> | 用例 | 结果 | 备注 |
> |---|---|---|
> | T4.1 | ✅ | 回复 `2` |
> | T4.2 | ✅ | 第二轮回复「张三」 |
> | T4.3 | ✅ | `write(completed)`，回复确认创建 |
> | T4.4 | ✅ | `read(completed)`，回复含 `hello` |
> | T4.5 | ✅ | `bash(completed)`，`ls /workspace` 列出 `t4-3.txt` |
> | T4.6 | ✅ | HTTP 204，异步五言绝句落库（finish=stop） |
> | T4.7 | ✅ | abort=true，8s parts 无增长（3→3），确认停止生成 |
>
> ⚠️ **prompt 措辞踩坑（本轮实测）**：T4.3 若在原文后附加「只回复：已创建」这类限定语，模型会跳过工具直接文字作答（tools=NONE，文件不落盘），进而连带 T4.4 无文件可读（模型凭上下文直答 hello 的假象）、T4.5 `ls` 如实报空目录。复测务必使用文档原文 prompt。

> **复测记录（2026-09-14，镜像 `hitl-cbf2276a-wip2`（含 pgJsonb/LEASE_TOOLS/四偏离修复 + maintain 首刷 delay），本地 PG + 远端沙箱，真实 LLM `Yd-DeepSeek/deepseek-v4-flash`，文档原文 prompt）：T4.1–T4.7 全部通过。**
> | 用例 | 结果 | 备注 |
> |---|---|---|
> | T4.1 | ✅ | 回复 `2` |
> | T4.2 | ✅ | 第二轮回复「张三。」 |
> | T4.3 | ✅ | `write(completed)` |
> | T4.4 | ✅ | `read(completed)`，回复含 `hello` |
> | T4.5 | ✅ | bash `ls /workspace`，回复含 `t4-3.txt` |
> | T4.6 | ✅ | HTTP 204；异步五言绝句落库（春晨/朝露润青芽…）。判定脚本注意：消息 JSON 无顶层 `role` 字段（PG data 结构），用「末条消息含非空 text part」而非 `role=='assistant'` 判完成，否则误报 |
> | T4.7 | ✅ | abort=true；parts 52→52（8s 零增长）确认停止生成 |

> **复测记录（2026-09-16，镜像 `person-model`（feat/opencode-1.18.31 工作区：个人模型 x-user-id 隔离 + 公共优先 + provider 脱敏 + autokeepalive），本地 PG + 远端 K8s 沙箱，真实 LLM `Yd-DeepSeek/deepseek-v4-flash`，文档原文 prompt，session `ses_f55f0191fffeI2pvfWamUzwU8E`）：T4.1–T4.7 全部通过。**
> | 用例 | 结果 | 备注 |
> |---|---|---|
> | T4.1 | ✅ | 回复含 `2` |
> | T4.2 | ✅ | 第二轮回复含「张三」 |
> | T4.3 | ✅ | `write(completed)` |
> | T4.4 | ✅ | `read(completed)`，回复 `hello` |
> | T4.5 | ✅ | `bash(completed)`，回复含 `t4-3.txt`（本轮 bash 真实触发，无 09-06 的行为波动） |
> | T4.6 | ✅ | HTTP 204；异步五言绝句落库（「寒窗映雪光，孤影对残墙」）；用「末条消息含非空 text part」判完成 |
> | T4.7 | ✅ | abort=true；parts 零增长（8s）确认停止生成 |
>
> 附注：本轮起 session 创建默认自动 keepalive + boot 沙箱（autokeepalive），全程工具调用无沙箱冷启动等待/502。

> **复测记录（2026-10-12，镜像 `opencode-saas-sandbox-test:152c8587db`，组合 1（远端 PG + 远端 K8s 沙箱），模型切换为 `Yd-GLM/glm-5.3`（非默认 deepseek-v4-flash），文档原文 prompt，session `ses_ed1df1d9dffegPQd7kg7JAuY9B`）：T4.1–T4.7 全部通过。**
> | 用例 | 结果 | 备注 |
> |---|---|---|
> | T4.1 | ✅ | 回复 `2` |
> | T4.2 | ✅ | 第二轮回复「你叫张三。」 |
> | T4.3 | ✅ | `write(completed)`，总结确认创建 |
> | T4.4 | ✅ | `read(completed)`，回复含 `hello` |
> | T4.5 | ✅ | `bash(completed)`，`ls /workspace` 列出 `t4-3.txt` |
> | T4.6 | ✅ | HTTP 204；异步五言绝句落库（「秋月照寒江，孤舟泛晚霜」） |
> | T4.7 | ✅ | abort=true；中断发生在首个 assistant message 落库前（末条消息仍为 T4.6 产物，parts 1→1，8s 零增长），符合早期中断语义 |
>
> 结论：GLM-5.3（glm-5.3）在该链路上行为正常，文本对话/上下文记忆/write-read-bash 工具闭环/异步/中断均无异常。
