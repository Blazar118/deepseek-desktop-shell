'use strict';

/**
 * The agent loop.
 *
 * The model has no function-calling channel here (the official site is a chat
 * UI), so the protocol is plain text: the model is told to answer a tool call
 * with a single fenced tool block containing JSON. This file parses that,
 * runs the tool locally, and feeds the result back as the next user turn.
 *
 * Deliberate limits:
 *  - a hard cap on iterations, so a confused model cannot burn the day;
 *  - `dangerous` tools pause and wait for an explicit yes from the user;
 *  - the whole run can be aborted between steps.
 */

const { sendAndWaitForReply } = require('./page-bridge');
const { toolCatalogue, callTool, isDangerous } = require('./tools');

const MAX_STEPS = 12;

const SYSTEM_PROMPT = (root, tools) => `你现在是一个运行在用户电脑上的本地 Agent。你可以通过调用工具直接读写文件、执行命令，而不是只给出建议。

## 工作目录
所有相对路径都相对于：${root}
你只能在这个目录里操作。

## 可用工具
${tools.map((t) => `- ${t.name}${t.dangerous ? '（需用户确认）' : ''}：${t.does}\n  参数：${t.args}`).join('\n')}

## 输出格式（必须严格遵守）
需要调用工具时，只输出一个 \`\`\`tool 代码块，里面是 JSON，不要输出别的内容：

\`\`\`tool
{"tool": "read_file", "args": {"path": "notes.txt"}}
\`\`\`

一次只能调用一个工具。拿到结果后你会继续下一步。

任务全部完成时，用普通文字给出最终答复，不要包含 tool 代码块。答复要简短，说清做了什么、结果如何。

## 规则
- 动手前先看清现状（列目录、读文件），不要凭猜写文件。
- 修改文件前先读出原内容，避免覆盖掉有用的东西。
- 命令执行失败时，读报错再改，不要原样重试。
- 不要调用你没被列出的工具。
- 不要尝试访问工作目录之外的位置。`;

/**
 * Pull the first fenced tool block out of a model reply.
 * Tolerates the usual model sloppiness: missing language tag, surrounding prose,
 * smart quotes around keys, trailing commas.
 */
function parseToolCall(text) {
  if (!text) return { kind: 'final', text: '' };

  const fenced = /```(?:tool|json)?\s*\n?([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : null;
  if (!candidate) {
    // A bare JSON object that names a tool also counts.
    const bare = /\{[\s\S]*"tool"[\s\S]*\}/.exec(text);
    if (!bare) return { kind: 'final', text: text.trim() };
    return parseJsonCall(bare[0], text);
  }
  return parseJsonCall(candidate, text);
}

function parseJsonCall(raw, wholeText) {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1'); // trailing commas

  try {
    const obj = JSON.parse(cleaned);
    if (!obj || typeof obj.tool !== 'string') {
      return { kind: 'final', text: wholeText.trim(), note: 'block-without-tool-name' };
    }
    return { kind: 'call', tool: obj.tool, args: obj.args || {}, raw: cleaned };
  } catch (err) {
    return { kind: 'final', text: wholeText.trim(), note: 'unparsable-tool-block: ' + err.message };
  }
}

/**
 * Run one agent task to completion.
 *
 * @param {object} opts
 * @param {import('electron').WebContents} opts.webContents  the chat page
 * @param {string} opts.root             workspace root the tools are confined to
 * @param {string} opts.task             the user's request
 * @param {(evt) => void} opts.onEvent   progress/log callback
 * @param {(req) => Promise<boolean>} opts.approve  resolves danger confirmations
 * @param {AbortSignal} opts.signal
 */
async function runAgent(opts) {
  const {
    webContents,
    root,
    task,
    onEvent = () => {},
    approve = async () => false,
    signal = null,
    maxSteps = MAX_STEPS,
  } = opts;

  const tools = toolCatalogue();
  const transcript = [];

  const kickoff = `${SYSTEM_PROMPT(root, tools)}

---

## 任务
${task}

现在开始。如果需要工具就输出 tool 代码块，否则直接给最终答复。`;

  let prompt = kickoff;

  for (let step = 1; step <= maxSteps; step++) {
    if (signal && signal.aborted) {
      onEvent({ type: 'aborted', step });
      return { ok: false, error: 'aborted', steps: step - 1, transcript };
    }

    onEvent({ type: 'thinking', step, prompt });

    const reply = await sendAndWaitForReply(webContents, prompt, {
      signal,
      onProgress: (phase, info) => onEvent({ type: 'page', step, phase, info }),
    });

    if (!reply.ok) {
      onEvent({ type: 'page-error', step, error: reply.error, detail: reply.detail });
      return { ok: false, error: reply.error, detail: reply.detail, steps: step, transcript };
    }

    const text = reply.reply || '';
    transcript.push({ role: 'assistant', step, text });
    onEvent({ type: 'reply', step, text, chars: text.length });

    const parsed = parseToolCall(text);

    if (parsed.kind === 'final') {
      onEvent({ type: 'final', step, text: parsed.text, note: parsed.note });
      return { ok: true, answer: parsed.text, steps: step, transcript };
    }

    const { tool, args } = parsed;
    onEvent({ type: 'tool-call', step, tool, args });

    if (!tools.some((t) => t.name === tool)) {
      prompt = `工具 "${tool}" 不存在。可用工具：${tools.map((t) => t.name).join('、')}。\n请重新输出一个合法的 tool 代码块。`;
      transcript.push({ role: 'tool', step, tool, result: { ok: false, error: 'unknown-tool' } });
      continue;
    }

    if (isDangerous(tool)) {
      const approved = await approve({ tool, args, step });
      onEvent({ type: 'approval', step, tool, args, approved });
      if (!approved) {
        prompt = `用户拒绝了 ${tool} 的调用。不要重试同一个操作，换一种方式，或直接说明你被挡住了。`;
        transcript.push({ role: 'tool', step, tool, result: { ok: false, error: 'user-denied' } });
        continue;
      }
    }

    const result = await callTool(tool, args, { root });
    transcript.push({ role: 'tool', step, tool, args, result });
    onEvent({ type: 'tool-result', step, tool, result });

    prompt = `工具 ${tool} 的执行结果：

\`\`\`json
${JSON.stringify(result, null, 2).slice(0, 12000)}
\`\`\`

继续下一步。需要工具就输出 tool 代码块，任务完成就用普通文字答复。`;
  }

  onEvent({ type: 'step-limit', steps: maxSteps });
  return { ok: false, error: 'step-limit', steps: maxSteps, transcript };
}

module.exports = { runAgent, parseToolCall, SYSTEM_PROMPT, MAX_STEPS };
