# Multi-tool Agent Runtime（个人项目）

一套**共享 Agent Loop** 驱动的轻量 Agent 运行时：同一套循环驱动 4 类 Agent（代码 / 调研 / 杂项 / 编排），内置工具权限、编排工作流、知识检索（RAG）、MCP 桥接、可观测指标，以及**"Docker 沙箱 + 三级人工审批"的受控写能力**。

> 个人学习与求职项目（非生产系统）。仓库内**不含任何密钥或个人数据**；`.env` 需按 `.env.example` 自行配置。

## 这个项目想解决什么

AI 能干活，但平台上落地时三件事没人管：**不可控**（改错谁负责）、**不可评估**（换模型/改提示词后是变好还是变坏）、**不可追责**（做了什么、为什么这么做）。本项目的每个模块都对着这三件事：

- **可控**：工具注册表（权限/参数/超时/重试）+ 写操作走"沙箱试跑 → 一次性批量人工审批（三态：完全同意此文件 / 仅同意本次 / 拒绝）→ 原子落盘 → 宿主复验失败自动回滚"。
- **可评估**：真实模型任务台账（成功率 / P95 / 单次成本）、RAG 离线评测（Recall@5 / MRR / nDCG）、Provider 横评、并行 vs 串行 A/B。
- **可追责**：全链路事件流（可回放）、错误聚合（按错误码+位置排序）、每 run 审计与复盘。

## 结构

```
multi-tool-agent/
  src/
    runtime/      # 共享 Agent Loop、预算、编排、子 Agent 循环、审批服务
    tools/        # 19 个工具（只读 + 6 个写工具，按权限/风险分级）
    sandbox/      # Docker 沙箱：快照、检查阶梯 L0/L1/L2、错误分类器
    knowledge/    # RAG：切块 / embedding / 混合检索 / rerank / 索引 / 审计
    mcp/          # MCP：协议、传输（stdio / Streamable HTTP）、ToolRegistry 桥接
    llm/          # 多 Provider（DeepSeek/OpenAI/Qwen/Moonshot/Zhipu/Ollama）
    trace/        # 事件流、实时通道、trace span
  tests/          # 50 个测试文件（含对抗套件、并发、性能、沙箱端到端）
  docs/           # 架构、设计决策、错误报告、RAG、写能力与审批等
  reports/        # 能力/指标/风险/竞品/成本等可复现报告
```

## 快速开始

要求 **Node 24**（`better-sqlite3` 的原生模块按 ABI 编译）。

```bash
cd multi-tool-agent
npm install
npm run typecheck      # 0 错误
npm test               # 全量测试（含对抗套件）
npm run demo:codebase  # Mock 演示，无需 Key
npm start              # 工作台：http://localhost:3000
```

启用真实模型与写能力（可选）：

```bash
# 真实模型：环境变量提供 Key（不要写进仓库）
LLM_MODE=openai npm run smoke:llm

# 写能力：需要 Docker + 沙箱镜像（Linux ABI 的 node_modules 烧进镜像）
node scripts/sandbox/build-image.mjs
CODEBASE_WRITE_ENABLED=true npm start
```

## 证据与文档（都在 `multi-tool-agent/`）

| 想看什么 | 文件 |
|---|---|
| 一页读懂：能力 / 实测指标 / 风险 / 下一步 | `reports/PROJECT_REPORT.md` |
| 写能力与三级审批的设计与终验清单 | `docs/WRITE_AND_APPROVAL.md` |
| 编辑评测：管线 7/7 + 真实模型 20/20（`npm run eval:edit:real -- --tasks=20 --budget-usd=1 --timeout-ms=240000`） | `reports/EDIT_EVAL.md`、`reports/EDIT_EVAL_REAL.md` |
| RAG 评测（三模式对比）与切块消融 | `reports/RAG_EVAL.md`、`reports/RAG_ABLATION.md` |
| 并行 vs 串行 A/B（结论：该任务下编排贵 7×） | `reports/PARALLEL_AB.md` |
| Provider 横评与复现命令 | `reports/PROVIDER_BENCHMARK.md` |
| Agent 效果台账（任务成功率 / 成本） | `reports/AGENT_REPORT.md` |
| 架构与设计取舍 | `docs/ARCHITECTURE.md`、`docs/DESIGN_DECISIONS.md` |
| 错误码与排查顺序 | `docs/ERROR_REPORTING.md` |

## 说明

- 本项目刻意**不追求"什么都能做"**：写能力默认关闭、敏感文件永久逐次审批、编排默认不可派发写子 Agent（fail-closed）。"知道不做什么"同样是产品决策。
- 部分报告是在特定机器/模型上的实测值（DeepSeek），换模型需重测；所有数字都标注了来源与复现命令。
- 本仓库不含 `.env`、数据库、运行时日志与个人绝对路径。
