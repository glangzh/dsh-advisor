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
export const inject = ['tools', 'subagents', 'systemPrompt'];

// 配置 schema：Cordis 加载时校验并填充默认值（规范：默认值写在 schema 中）
export const Config = Schema.object({
  advisorProvider: Schema.string().default('deepseek-official'),
  advisorModel: Schema.string().default('deepseek-v4-pro'),
  maxTokens: Schema.number().default(4096),
  timeoutMs: Schema.number().default(180000),
  windowMessages: Schema.number().default(8),
  windowChars: Schema.number().default(8000),
});

export function apply(ctx, config = {}) {
  const provider = config.advisorProvider || 'deepseek-official';
  const model = config.advisorModel || 'deepseek-v4-pro';
  const maxTokens = Number.isFinite(config.maxTokens) ? config.maxTokens : 4096;
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 180000;
  const windowMessages = Number.isFinite(config.windowMessages) ? config.windowMessages : 8;
  const windowChars = Number.isFinite(config.windowChars) ? config.windowChars : 8000;

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

  // ── 顾问调用：官方 subagents 机制（spawn v4-pro 子代理，完整审计）────────
  // 子代理由 agent-loop 驱动：请求/响应/usage 记录进其独立 session 并计入
  // token-meter，失败重试走 llm-retry；spawn 为独立上下文，prompt 自带全部
  // 蒸馏后的上下文，maxDepth: 1 禁止顾问再委派。
  async function consult(question, context, parent, signal) {
    const task = [
      'You are the advisor in an executor+advisor architecture.',
      'The executor runs on a cheaper model and escalated to you for judgment.',
      'Give decision-ready guidance: what to do, what to avoid, edge cases, and a review checklist.',
      'Answer the specific question directly; do not rewrite the whole task.',
      'Do NOT call any tools; reply with your guidance as plain text only.',
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
        throw new Error('advisor subagent ended with stop reason ' + String(result.stopReason) + (partial ? '\nPartial output:\n' + partial : ''));
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
      const cwd = (session && session.header && session.header.cwd) || '';
      let agentModel = '';
      try {
        const header = session && session.requestHeader();
        if (header && header.config && header.config.model) agentModel = header.config.model;
      } catch {
        // requestHeader is best-effort; ignore failures.
      }
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
      const advice = await consult(args.question, context, agent, signal);
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
