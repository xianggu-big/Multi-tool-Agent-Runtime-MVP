// src/sandbox/classify.ts — 沙箱检查失败的错误分类器（纯函数，可单测；M1 Step2）
//
// 职责：把「检查阶梯」的原始输出（tsc/test/command 的 exitCode+stdout+stderr+超时标记）
// 归类成机器可读的结论，供上层决定「重生成 / 交 LLM 判定 / 升级到人」。
//
// 设计（对照评审）：
//   - 规则表覆盖常见错误类别；每条带**修复提示**（回喂模型用）；
//   - `ENV_MISMATCH` 单列：容器(Linux)与宿主(Windows)差异导致的环境性失败**不算模型改错**
//     （评审 P0/P1 要求：沙箱绿≠宿主绿，环境性失败必须如实标注，不能误导重生成）；
//   - 无法归类 → `UNKNOWN`：上层据此走 LLM 判定，再不行升级 human（沿用 escalateTo 契约）。

export type CheckSource = 'l0-syntax' | 'l1-tsc' | 'l1-tests' | 'l2-tests' | 'command';

export type FailureClass =
  | 'SYNTAX'
  | 'TYPE'
  | 'TEST_FAIL'
  | 'TIMEOUT_HANG'
  | 'CRASH'
  | 'PATH_ESCAPE'
  | 'SENSITIVE_FILE'
  | 'OUTPUT_LIMIT'
  | 'ENV_MISMATCH'
  | 'UNKNOWN';

export interface RawCheckResult {
  source: CheckSource;
  /** 进程退出码（null = 被信号/超时终止） */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** 是否因超时被终止（死循环/挂起的判定依据） */
  timedOut: boolean;
  /** 被检查的目标（文件路径/测试文件/命令），用于报告 */
  target?: string;
}

export interface Verdict {
  ok: boolean;
  class?: FailureClass;
  /** 一句话结论（进事件/审批卡） */
  summary: string;
  /** 回喂模型的修复提示（ok=false 时才有意义） */
  repairHint?: string;
  /** 是否环境性问题（不算模型改错；上层不应据此重生成，应标注并可能升级） */
  environmentIssue?: boolean;
  /** 摘要证据（截断后的关键输出，供审批卡/事件使用） */
  excerpt?: string;
}

const REPAIR_HINTS: Record<FailureClass, string> = {
  SYNTAX: '语法错误：按报错行修正括号/引号/关键字，或整段重写该文件；不要留下半截代码。',
  TYPE: '类型错误：按 tsc 报错逐条修正类型标注/导入；若是类型定义变了，同步更新所有引用点。',
  TEST_FAIL: '测试失败：先读失败断言与期望值，判断是"实现改错了"还是"测试本身过时"；不要为了让测试变绿而删测试。',
  TIMEOUT_HANG: '超时/疑似死循环：检查循环终止条件、await 是否漏了、是否有同步死等；缩小改动范围重试。',
  CRASH: '进程崩溃：读堆栈定位第一处「项目内」帧，修根因；不要用 try/catch 吞掉。',
  PATH_ESCAPE: '路径越界：只能改仓库内文件；相对路径用仓库根形态。',
  SENSITIVE_FILE: '敏感文件拒写：.env/密钥/凭据类文件不允许修改。',
  OUTPUT_LIMIT: '输出超限：减少单次输出/拆分任务。',
  ENV_MISMATCH: '环境性失败（容器 Linux vs 宿主 Windows 差异）：不是你的改动逻辑错误；如实上报，必要时换等价的跨平台写法。',
  UNKNOWN: '未归类的失败：把完整报错原文带回，交给上层判定。',
};

/** 交付给上层的"截断证据"：保留最有信息量的尾部（编译/测试错误的总结通常在尾部） */
export function excerptOf(r: RawCheckResult, maxChars = 1500): string {
  const raw = [r.stderr.trim(), r.stdout.trim()].filter(Boolean).join('\n').trim();
  if (raw.length <= maxChars) return raw;
  return raw.slice(0, maxChars * 0.35) + '\n…[截断]…\n' + raw.slice(-maxChars * 0.65);
}

const ENV_MISMATCH_PATTERNS: RegExp[] = [
  /ERR_DLOPEN_FAILED/i, // 原生模块 ABI（Windows vs Linux）
  /invalid ELF header/i,
  /not a valid Win32 application/i,
  /EPERM: operation not permitted, (rename|unlink)/i, // Windows 文件锁（容器内少见，宿主复验常见）
  /junction/i,
  /only supported on Windows/i,
  /EBADPLATFORM|platform.*not supported/i,
  /Cannot find module.*\.node\b/i,
];

/** 测试套件来源（l1/l2）：输出里会串入**测试名与断言文本**，不能拿"关键词"当失败类别 */
const isTestSuiteSource = (r: RawCheckResult): boolean => r.source === 'l1-tests' || r.source === 'l2-tests';

/** 关键词必须出现在"错误行"上（行内含 error/code:/errno 之类的实况标记），而非测试名/断言文本 */
const hitOnErrorLine = (text: string, re: RegExp): boolean =>
  text.split('\n').some((line) => re.test(line) && /error|Error|code:|errno/i.test(line));

const RULES: Array<{ cls: FailureClass; test: (r: RawCheckResult, text: string) => boolean }> = [
  { cls: 'TIMEOUT_HANG', test: (r) => r.timedOut },
  // 实测修复（2026-10-15 端到端）：SENSITIVE_FILE / PATH_ESCAPE / OUTPUT_LIMIT 是**工具层拒绝**的类别，
  // 只该由单条命令输出判定。全量测试套件的输出会打印测试名（如 tests/39a「敏感文件拒写…」），
  // 于是"套件因任何原因失败"都会被误判成 SENSITIVE_FILE，修复提示把模型引向"敏感文件拒写"——
  // 实测中 code-edit 子 Agent 因此拿到错误提示并放弃。测试套件来源一律走 TEST_FAIL（下面的规则）。
  { cls: 'SENSITIVE_FILE', test: (r, t) => !isTestSuiteSource(r) && /敏感文件|SENSITIVE_FILE/.test(t) },
  { cls: 'PATH_ESCAPE', test: (r, t) => !isTestSuiteSource(r) && /PATH_ESCAPE|路径越权/.test(t) },
  { cls: 'OUTPUT_LIMIT', test: (r, t) => !isTestSuiteSource(r) && /OUTPUT_LIMIT|输出超限|maxOutputBytes/.test(t) },
  // 环境性失败优先于"看起来像类型/语法错"的形态（否则会误导重生成）。
  // 同样防"测试名误伤"（tests/40e 的名字里就有 ERR_DLOPEN_FAILED）：套件来源要求命中错误行。
  {
    cls: 'ENV_MISMATCH',
    test: (r, t) => ENV_MISMATCH_PATTERNS.some((re) => (isTestSuiteSource(r) ? hitOnErrorLine(t, re) : re.test(t))),
  },
  { cls: 'SYNTAX', test: (r, t) => r.source === 'l0-syntax' || /error TS1\d{3}|SyntaxError|Unexpected token|Expected .*but found/i.test(t) },
  { cls: 'TYPE', test: (r, t) => r.source === 'l1-tsc' || /error TS2\d{3}|error TS\d{4}/i.test(t) },
  { cls: 'TEST_FAIL', test: (r) => isTestSuiteSource(r) },
  { cls: 'CRASH', test: (r) => (r.exitCode ?? 0) !== 0 && /Error:|at .*\(.*:\d+:\d+\)/.test(r.stderr) },
];

/**
 * 归类一次检查结果。`ok=true` 表示这次检查通过（无需修复）。
 */
export function classify(r: RawCheckResult): Verdict {
  if (!r.timedOut && r.exitCode === 0) {
    return { ok: true, summary: `${r.source} 通过` };
  }
  const text = `${r.stderr}\n${r.stdout}`;
  for (const rule of RULES) {
    if (rule.test(r, text)) {
      const environmentIssue = rule.cls === 'ENV_MISMATCH';
      return {
        ok: false,
        class: rule.cls,
        environmentIssue,
        summary: `${r.source} 失败：${rule.cls}${r.timedOut ? '（超时终止）' : `（exit=${r.exitCode}）`}`,
        repairHint: REPAIR_HINTS[rule.cls],
        excerpt: excerptOf(r),
      };
    }
  }
  return {
    ok: false,
    class: 'UNKNOWN',
    summary: `${r.source} 失败：UNKNOWN（exit=${r.exitCode}${r.timedOut ? '，超时' : ''}）`,
    repairHint: REPAIR_HINTS.UNKNOWN,
    excerpt: excerptOf(r),
  };
}

/** 供上层做「重生成预算」判断：环境性问题不该消耗重生成轮次 */
export function shouldRegenerate(v: Verdict): boolean {
  return !v.ok && !v.environmentIssue;
}
