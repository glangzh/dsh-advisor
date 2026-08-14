// dsh-advisor — 顾问策略插件
//
// 注册 `advisor` 工具：执行者遇到难题时调用，本插件通过官方 ctx.subagents 机制
// （agentOptions.model 覆盖）启动 deepseek-v4-pro 子代理提供决策判断。
// 子代理由 agent-loop 驱动：请求/响应/usage 记录进独立 session 并计入 token-meter，
// 失败重试走 llm-retry，全程可审计。
//
// context 由两部分组成：执行者自述（可选）+ 会话最近历史自动蒸馏
// （session.deriveMessages 窗口化 + 纯文本 + 保头保尾截断）。
// 仅升级点启动 v4-pro 子代理，其余步骤仍由执行者完成。

import Schema from '@deepseek-ai/schemastery';

export const name = 'advisor';
export const inject = ['tools', 'subagents', 'systemPrompt', 'llm'];

// 配置 schema：Cordis 加载时校验并填充默认值（默认值写在 schema 中）
export const Config = Schema.object({
  advisorProvider: Schema.string().default('deepseek-official'),
  advisorModel: Schema.string().default('deepseek-v4-pro'),
  maxTokens: Schema.number().default(4096),
  timeoutMs: Schema.number().default(180000),
  windowMessages: Schema.number().default(8),
  windowChars: Schema.number().default(8000),
  maxAdviceChars: Schema.number().default(4000),
});

export function apply(ctx, config = {}) {
  const provider = config.advisorProvider || 'deepseek-official';
  const model = config.advisorModel || 'deepseek-v4-pro';
  const maxTokens = Number.isFinite(config.maxTokens) ? config.maxTokens : 4096;
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 180000;
  const windowMessages = Number.isFinite(config.windowMessages) ? config.windowMessages : 8;
  const windowChars = Number.isFinite(config.windowChars) ? config.windowChars : 8000;
  const maxAdviceChars = Number.isFinite(config.maxAdviceChars) ? config.maxAdviceChars : 4000;

  // ── 配置预检（非阻塞）：provider 是否注册、model 是否可解析 ─────────────
  // 失败只告警不阻断：配置错误会在实际调用时以清晰错误暴露。
  (async () => {
    try {
      const providers = ctx.llm.listProviders();
      if (!providers.some((p) => p.id === provider)) {
        console.warn(`[advisor] provider "${provider}" 未注册（已注册: ${providers.map((p) => p.id).join(', ')}）——顾问调用将失败`);
        return;
      }
      await ctx.llm.resolveModelInfo(provider, model, AbortSignal.timeout(5000));
    } catch (e) {
      console.warn(`[advisor] 配置预检失败: ${e && e.message ? e.message : String(e)}（顾问仍会尝试实际调用）`);
    }
  })();

  // ── 自动蒸馏：最近 N 条消息的纯文本，保头保尾截断 ──────────────────────
  function distillHistory(session) {
    let messages;
    try {
      messages = session.deriveMessages();
    } catch {
      return '(unavailable)';
    }
    if (!Array.isArray(messages) || messages.length === 0) return '(empty session)';
    const parts = [];
    for (const m of messages.slice(-windowMessages)) {
      const text = (m.content || [])
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      if (!text) continue;
      parts.push((m.role === 'assistant' ? 'assistant' : 'user') + ': ' + text);
    }
    let out = parts.join('\n');
    if (out.length > windowChars) {
      const head = out.slice(0, Math.floor(windowChars * 0.4));
      const tail = out.slice(out.length - Math.floor(windowChars * 0.6));
      out = head + '\n...[history truncated]...\n' + tail;
    }
    return out;
  }

  // ── 顾问调用：官方 subagents 机制（spawn v4-pro 子代理，全程审计）────────
  // 风险控制：
  //   - toolFilter { allow: [] } 屏蔽 host 全局工具；
  //   - 提示词硬约束不得调用任何工具（preset 作用域工具无法在服务层收窄，
  //     由提示词 + maxTokens + 蒸馏窗口兜底）；
  //   - maxDepth: 1 禁止顾问再委派；delegationDepth 硬拒绝（见 execute）；
  //   - 不自动重试：SubagentResult 无 failure code，无法区分瞬时/永久错误，
  //     宁可让执行者拿到清晰的失败（含部分输出）也不重复消耗。
  async function consult(question, context, parent, signal) {
    const task = [
      'You are the advisor in an executor+advisor architecture.',
      'The executor runs on a cheaper model and escalated to you for judgment.',
      'Give decision-ready guidance: what to do, what to avoid, edge cases, and a review checklist.',
      'Answer the specific question directly; do not rewrite the whole task.',
      'CRITICAL: Do NOT call any tools, do NOT read files, do NOT run commands, do NOT spawn subagents. ' +
        'This is a pure advisory call; any tool use is a failure. Reply with guidance as plain text only.',
      'Keep the reply focused and actionable; prefer concise bullets over long prose.',
      '',
      '## Context from the executor',
      context,
      '',
      '## Specific question (answer this directly)',
      question,
    ].join('\n');
    const run = await ctx.subagents.start('spawn', {
      label: 'advisor-consult',
      prompt: [{ type: 'text', text: task }],
      parent,
      agentOptions: {
        provider,
        model,
        maxTokens,
      },
      toolFilter: { allow: [] },
      maxDepth: 1,
      signal,
    });
    const [execution] = await Promise.allSettled([run.result.then((result) => {
      if (result.stopReason !== 'completed') {
        const partial = (result.output || [])
          .filter((b) => b && b.type === 'text')
          .map((b) => b.text)
          .join('')
          .trim();
        throw new Error(
          'advisor subagent ended with stop reason ' + String(result.stopReason) +
          '（请检查 advisorProvider/advisorModel 配置与模型可用性）' +
          (partial ? '\nPartial output:\n' + partial : '')
        );
      }
      const text = (result.output || [])
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      if (!text) throw new Error('advisor returned no text');
      return text;
    })]);
    const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())]);
    if (execution.status === 'rejected') {
      if (disposal.status === 'rejected') throw new AggregateError([execution.reason, disposal.reason], 'advisor run failed');
      throw execution.reason;
    }
    if (disposal.status === 'rejected') throw disposal.reason;
    return execution.value;
  }

  // ── 结果截断：限制 advice 大小，防止污染主会话上下文 ───────────────────
  function clipAdvice(text) {
    if (text.length <= maxAdviceChars) return text;
    return text.slice(0, maxAdviceChars) + '\n…[advisor output truncated]…';
  }

  // ── 工具注册（fiber 绑定，随会话/预设卸载自动清理）──────────────────────
  ctx.tools.register({
    name: 'advisor',
    description:
      'Escalate a hard decision to the advisor model (' + model + '). Use it before proceeding when you encounter: ' +
      'architectural decisions affecting multiple files; ambiguous requirements with multiple valid interpretations; ' +
      'security-sensitive code (authentication, authorization, data validation); or complex problems where you are not confident. ' +
      'Pass one specific question and optional distilled context; the session history is attached automatically. ' +
      'You get back decision-ready guidance. Do not use it for routine work.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The specific decision or question to escalate. One question per call.' },
        context: { type: 'string', description: 'Optional distilled context: task, what you have done, files involved, why this is hard. The recent session history is appended automatically, so only add what the history cannot show.' },
      },
      required: ['question'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          advice: { type: 'string' },
          model: { type: 'string' },
        },
        required: ['advice', 'model'],
      },
      render: (_args, value) => [{ type: 'text', text: 'Advisor (' + value.model + ') advice:\n' + value.advice }],
    },
    timeoutMs,
    isConcurrencySafe: true,
    async execute(args, exec) {
      const agent = exec.agent;
      const session = agent && agent.session;
      const depth = (session && session.header && session.header.delegationDepth) || 0;
      if (depth > 0) {
        throw new Error('advisor tool is executor-only: subagents must never call the advisor. Let the top-level executor escalate instead.');
      }
      // 执行者与顾问同模型时升级无意义：直接拒绝，避免浪费一次子代理调用。
      let agentProvider = '';
      let agentModel = '';
      try {
        const header = session && session.requestHeader();
        if (header && header.config) {
          agentProvider = header.config.provider || '';
          agentModel = header.config.model || '';
        }
      } catch {
        // requestHeader is best-effort; ignore failures.
      }
      if (agentProvider === provider && agentModel === model) {
        throw new Error('当前执行者模型已是 ' + provider + '/' + model + '，与顾问模型相同，顾问升级没有意义——请直接自行判断，无需调用 advisor。');
      }
      const cwd = (session && session.header && session.header.cwd) || '';
      const context = [
        '## Working directory',
        cwd || '(unknown)',
        '## Executor model',
        agentModel || '(unknown)',
        "## Executor's own context",
        (args.context || '').trim() || '(none)',
        '## Recent session history (auto-distilled)',
        session ? distillHistory(session) : '(unavailable)',
      ].join('\n');
      const signal = exec.signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([exec.signal, AbortSignal.timeout(timeoutMs)])
        : exec.signal;
      const advice = clipAdvice(await consult(args.question, context, agent, signal));
      return { advice, model };
    },
  });

  // ── 升级准则提示词段（工具引导区）──────────────────────────────────────
  ctx.systemPrompt.section({
    name: 'advisor-escalation-guidance',
    order: 118,
    text:
      'You are the executor in an executor+advisor setup. For routine, well-defined work proceed directly. ' +
      'Call the `advisor` tool before proceeding when you encounter: architectural decisions affecting multiple ' +
      'files or components; ambiguous requirements with multiple valid interpretations; security-sensitive code ' +
      '(authentication, authorization, data validation); complex algorithmic problems or bugs where you are not ' +
      'confident. Integrate the returned guidance and continue. Never delegate simple tasks to the advisor. ' +
      'Subagents must never call the advisor tool; only the top-level executor escalates.',
  });
}
