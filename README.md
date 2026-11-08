# 🧬 Skill Evolution (`skill-evolution`)

[![CI](https://github.com/veritaswiki/skill-evolution/actions/workflows/ci.yml/badge.svg)](https://github.com/veritaswiki/skill-evolution/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-purple.svg)](./LICENSE)
[![Tests: 61 Passed](https://img.shields.io/badge/tests-61%20passed-34d399.svg)](#测试与保真度审计)
[![Hermes Parity: 41/41](https://img.shields.io/badge/Hermes%20Parity-41%2F41-8b7cf6.svg)](#能力对齐矩阵4141)

**Skill Evolution** 是一套面向 AI Coding Agent 的**闭环程序性记忆自进化引擎（Closed-Loop Procedural Memory & Self-Evolution Engine）**。

它完整移植并强化了 Nous Research `hermes-agent` 的 **Closed Learning Loop**：在每次有效会话回合结束后，自动采集有界轨迹快照、在只读沙箱中蒸馏可复用的类级别技能（`SKILL.md`）、生成**大白话中文审阅简报**、通过**强制人工批示与 AI 二次融合**完成经验沉淀，并提供**四道安全闸门**、**SHA-256 内容寻址账本（支持单条原子回滚）**、**Curator 生命周期维护与 LLM 建伞合并（Umbrella Consolidation）**，以及适配桌面端、手机端与远程客户端的全功能可视化工作台。

[English Documentation (README.en.md)](./README.en.md)

---

## ✨ 核心特性

- 🔄 **六步闭环自进化流水线（Closed Learning Loop）**
  - `回合结束监听 (turn/end & session/flush)` → `有界快照采集 (Collector)` → `只读复盘蒸馏 (Reflector)` → `四道安全闸门 (Gatekeeper)` → `中文简报与强制批示融合 (ReviewBrief)` → `SHA-256 账本与热更新落盘 (Applier & Ledger)`。
- 📋 **中文审阅简报 + 强制批示 + AI 二次融合（Human-in-the-Loop Directive Fusion）**
  - 打开待审草稿时，首先展示结构化**中文审阅简报**：用大白话讲清楚**「这是什么技能」**、**「核心提炼出的铁律」**、**「同意采纳会如何」**、**「不同意驳回会如何」**；
  - **强制填写批示**：必须填写您的审阅批示/想法（支持一键快捷批示胶囊）后才解锁操作按钮；
  - **AI 批示融合进化**：支持点击「AI 按批示修订草稿（先看效果）」或「按批示进化并采纳进正式库」，AI 会先阅读您的批示重写技能正文并给出中文修订汇报，再升入正式技能库。
- 🛡️ **四道代码级安全硬闸门（4-Stage Hard Gatekeeper）**
  - 将提示词软约束升级为不可绕过的代码级正则与结构拦截：
    1. **Frontmatter 结构校验**：强制校验 `name`（kebab-case）与非空 `description`；
    2. **类级别命名校验（Class-Level Naming）**：硬性拒绝 `fix-xxx`、`debug-yyy`、PR 号、日期戳等一次性会话产物命名；
    3. **负面断言与环境错误硬拦截（Forbidden Content Scan）**：拦截 `"X tool does not work"`、`"command not found"` 等一旦写入就会让 Agent 自我设限数月的负面断言；
    4. **体积预算与归属保护（Provenance & Size Cap）**：限制单技能正文 `<= 24,000` 字符（引导拆分 `references/`），且严格校验 `metadata.createdBy === "agent"`，**绝不自动篡改用户手写技能**。
- ☂️ **Curator 技能生命周期与 LLM 建伞合并（Umbrella Consolidation）**
  - 旁路遥测 `.usage.json`（不污染 `SKILL.md`），自动执行 `active → stale (14d) → archived (30d)` 状态转换（遵循 `useCount === 0` 零使用不归档、`pinned` 豁免、内置技能受保护、**只归档永不删除**四大不变量）；
  - 内置 **LLM 建伞合并工作台**：自动扫描前缀聚类，将多个零散窄技能蒸馏合并为类级别伞技能，支持 `Dry-Run` 计划预览与一键确认执行。
- 🧾 **SHA-256 内容寻址账本与 Fail-Closed 单条回滚（Skill Ledger）**
  - 每次创建、补丁、批示修订、采纳、合并或归档均在 `.evolution_ledger.jsonl` 记录前后文件清单，文件内容按 SHA-256 去重存入 `.evolution_backups/blobs/`；
  - UI 内置**文件级 SHA-256 结构化 Diff 表格**，支持任意历史记录一键原子回滚（当安全快照捕获失败时严格 Fail-Closed）。
- 💻📱 **全端原生适配（Desktop Web GUI + 手机端独立 PWA + 远程客户端原生卡片）**
  - **桌面端顶部视图栏**：直接挂载于会话顶部导航栏（「对话 · 轨迹 · 上下文 · 编队 · 专家团 · **自进化**」）与「设置 → 自进化」；
  - **移动端独立触屏工作台**：内置固定端口 `18890`（及 `/dsh-evolution/mobile` 路由），支持底部 Tab 栏、iOS `16px` 防自动缩放与大尺寸触控热区；
  - **远程客户端（Remote / Mobile App）原生交互**：内置 `evolution_review_center` 工具（弹出原生 `ask_user_question` 审批卡片）与 `/evolution` 斜杠命令。

---

## 🏗️ 架构与数据流

```text
会话回合结束 (turn/end) + 短生命周期退出屏障 (session/flush)
   │
   ▼
[1. Collector 采集器]   lib/collector.js
   │  · 自动剥离系统注入块 (<system-reminder> / runtime context)
   │  · 信号识别：user-correction / new-technique (≥3次或≥2种工具) / skill-was-wrong
   │  · 跨进程持久化节流 (.throttle.json) + 历史摘要压缩 (_digest_history)
   ▼
[2. Reflector 复盘器]   lib/reflector.js + lib/prompts.js
   │  · 逐字移植 Hermes 三段审查宪法 (SKILL_REVIEW / LESSON_LAYER / DO_NOT_CAPTURE)
   │  · 输出结构化 JSON + 中文审阅简报 (.briefing.json)
   ▼
[3. Synthesizer & Gatekeeper 四道闸门]   lib/synthesizer.js + lib/gatekeeper.js
   │  · 类级别命名校验 · 负面断言/环境错误硬拦截 · 24k 长度上限 · Provenance 归属检查
   ▼
[4. 中文简报与强制批示中心]   client.js + lib/http-api.js
   │  · 展示「这是什么 / 核心铁律 / 同意后果 / 驳回后果」
   │  · 强制填写用户批示 -> AI 融合批示二次修订 (/refine-draft) -> 正式采纳 (/promote)
   ▼
[5. Ledger 账本 & Curator 建伞]   lib/ledger.js + lib/usage.js + lib/consolidation.js
   │  · .evolution_ledger.jsonl + SHA-256 blobs + 单条回滚
   └  · .usage.json 遥测 + active/stale/archived + LLM 建伞合并 (CURATOR_REVIEW_PROMPT)
```

---

## 🚀 安装与快速上手

### 1. 通过插件管理器安装

从 npm 或 GitHub 仓库直接安装到当前 Profile：

```bash
# 从 GitHub 仓库安装
dsh plugin add github:veritaswiki/skill-evolution

# 或从本地克隆目录安装
git clone https://github.com/veritaswiki/skill-evolution.git
dsh plugin add ./skill-evolution
```

### 2. 三种使用入口

1. **桌面端 Web GUI**：
   - 打开任意会话顶部视图栏，点击 **「自进化」** 标签页（位于「专家团」旁）；
   - 或打开左下角 **「设置 (Settings) → 自进化」**。
2. **手机端 / 远程连接（Remote App）**：
   - **自然语言卡片审批**：直接在聊天框发送 `审阅自进化草稿` 或 `看看自进化待审稿`，AI 会调用 `evolution_review_center` 弹出原生交互卡片；
   - **斜杠命令秒查秒批**：
     ```text
     /evolution brief                              # 查看所有待审草稿的中文简报
     /evolution refine <skill-name> <您的批示想法>    # 让 AI 按批示修订草稿并汇报分析
     /evolution approve <skill-name> <您的批示想法>   # AI 融合批示后升入正式技能库
     /evolution reject <skill-name> <您的驳回理由>    # 按批示驳回并记入账本
     /evolution consolidate                        # 预览 LLM 建伞合并计划 (dry-run)
     /evolution consolidate --apply                # 执行 LLM 建伞合并
     /evolution ledger                             # 查看最近 SHA-256 账本记录
     /evolution rollback <entry-id>                # 原子回滚指定账本记录
     ```
   - **独立手机触屏网页台**：浏览器或远程端口预览访问 `http://127.0.0.1:18890/dsh-evolution/mobile`。

---

## ⚙️ 配置项说明 (`cordis.patch.yml`)

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否启用回合后自动复盘采集 |
| `mode` | `"draft"` | `"draft"`：只写 `.staging/` 草稿等人工批示采纳（推荐）；`"apply"`：通过闸门后自动落盘 |
| `skillsRoot` | `""` | 技能根目录（留空默认使用 `~/.dsh/skills`） |
| `minTurnsBetween` | `3` | 两次自动复盘之间至少间隔多少个有效回合（跨进程持久化） |
| `minMinutesBetween` | `5` | 两次自动复盘之间至少间隔多少分钟 |
| `maxMessages` | `24` | 快照保留的最近原文消息条数（更早轮次自动折叠为摘要） |
| `maxChars` | `24000` | 单次复盘快照的最大字符预算 |
| `reviewTimeoutSeconds` | `180` | 单次后台复盘超时时间（秒） |
| `curatorEnabled` | `true` | 是否启用技能生命周期维护（`active` / `stale` / `archived`） |
| `consolidate` | `false` | 是否在定时 Curator 中自动运行 LLM 建伞合并 |
| `consolidateDryRun` | `true` | 建伞合并默认仅输出预览计划而不直接改动磁盘 |
| `staleAfterDays` | `14` | 多少天未使用标记为 `stale` |
| `archiveAfterDays` | `30` | 多少天未使用移入 `.archive/`（永不删除） |

---

## 🔌 HTTP API 路由表 (`/dsh-evolution/api/*`)

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/dsh-evolution/mobile` | 独立手机端 PWA 触屏审批台页面 |
| `GET` | `/dsh-evolution/api/status` | 完整状态快照（统计、配置、带全文与中文简报的草稿、技能列表、SHA 账本、最近复盘状态） |
| `GET` | `/dsh-evolution/api/drafts` | 待审草稿列表（含 `body`、`frontmatter`、`resources`、`briefing`） |
| `GET` | `/dsh-evolution/api/skills` | 正式技能列表 |
| `GET` | `/dsh-evolution/api/skill/:name` | 单个正式技能详情 |
| `GET` | `/dsh-evolution/api/ledger` | 账本历史记录列表 |
| `GET` | `/dsh-evolution/api/ledger/:id` | 单条账本详情（含 `before` / `after` 文件 SHA 清单） |
| `GET` | `/dsh-evolution/api/candidates` | 可参与 LLM 建伞合并的候选技能列表 |
| `POST` | `/dsh-evolution/api/refine-draft` | 根据用户强制批示（`comment`）调用 AI 重写草稿并更新中文简报 |
| `POST` | `/dsh-evolution/api/promote` | 带用户批示采纳草稿至正式技能库（支持 `evolveWithComment: true`） |
| `POST` | `/dsh-evolution/api/discard` | 带用户批示驳回并销毁草稿 |
| `POST` | `/dsh-evolution/api/rollback` | 按账本 `id` 原子回滚技能变更 |
| `POST` | `/dsh-evolution/api/pin` | 固定 / 取消固定技能（豁免自动归档与合并） |
| `POST` | `/dsh-evolution/api/adopt` | 将外部/手写无标记技能纳入生命周期管理 |
| `POST` | `/dsh-evolution/api/disown` | 取消纳管技能 |
| `POST` | `/dsh-evolution/api/consolidate` | 执行 LLM 建伞合并（`dryRun: true` 预览 / `dryRun: false` 执行） |
| `POST` | `/dsh-evolution/api/review` | 手动触发当前活跃会话复盘 |
| `POST` | `/dsh-evolution/api/config` | 实时保存并持久化引擎配置 |

---

## 📊 能力对齐矩阵（41/41）

运行 `npm run audit:parity` 可随时验证与 Nous Research `hermes-agent` 的逐项对齐状态：

- **复盘引擎（4/4）**：回合后异步复盘、只读工具白名单、新回合自动打断取消、历史摘要压缩；
- **审查宪法（9/9）**：三段审查提示词逐字移植、`Be ACTIVE` 反惰性、类级别技能形态、四级更新优先级、`Read-before-write`、用户偏好嵌入、负面断言禁令、环境失败禁令、未解决失败禁令；
- **账本与安全（6/6）**：技能落盘、JSONL 账本、SHA-256 内容寻址 blob 去重、单条回滚、回滚 Fail-Closed、账本轮转与 blob GC；
- **生命周期与建伞合并（13/13）**：旁路 `.usage.json`、`active/stale/archived` 三态、零使用不归档、`pinned` 豁免、内置技能保护、只归档不删除、Provenance 写来源溯源、用户手写技能保护、LLM 建伞合并、前缀聚类、三种合并方式、包完整性检查、`absorbedInto` 强制校验、`adopt/disown`；
- **增强能力（5+）**：`session/flush` 短生命周期进程退出屏障、中文审阅简报 + 强制批示 AI 融合、代码级禁词硬拦截、全功能桌面/移动端可视化工作台、原生交互卡片工具 `evolution_review_center`。

---

## 🧪 测试与保真度审计

本项目零外部测试框架依赖，使用 Node.js 原生测试运行器：

```bash
# 运行全部 61 个单元测试
npm test

# 运行 41 项能力对齐审计
npm run audit:parity

# 运行 Hermes 提示词逐字节保真度审计
npm run audit:prompts
```

---

## 📄 开源许可 (License)

本项目基于 [MIT License](./LICENSE) 开源。其中 `vendor/hermes/` 目录下的参考源码引自 Nous Research `hermes-agent`（同样遵循 MIT 许可，详见 [`vendor/hermes/PROVENANCE.md`](./vendor/hermes/PROVENANCE.md)）。
