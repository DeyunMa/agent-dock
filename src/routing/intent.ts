import type { ExecutionIntent, IntentSource } from "./types.js";

export interface IntentDecision {
  intent: ExecutionIntent;
  source: IntentSource;
  reason: string;
}

const CONTINUATION = /^(?:继续(?:吧|做|处理|修改|执行)?|接着(?:做|继续)?|做吧|开始吧|go\s+ahead|continue|proceed)[。！!？?\s]*$/iu;
const NEGATED_ACTION = /(?:(?:先|暂时|目前)?(?:不要|别|不需要|无需|不用)(?:再)?.{0,12}(?:做|改|修改|实现|修复|新增|删除|清理|安装|运行|执行|启动|部署|发布|提交|推送|创建|生成|写入|迁移|同步))|(?:只(?:分析|检查|讨论|判断|查看|研究).{0,40}(?:不要|别|不需要|无需|不用).{0,12}(?:做|改|修改|实现|修复|安装|运行|执行|部署|提交|删除|清理))/iu;
const QUESTION_ABOUT_ACTION = /(?:(?:是否|是不是|还是说|能否|可以|要不要|需不需要|怎么|如何).{0,48}(?:做|改|修改|实现|修复|新增|删除|清理|安装|运行|执行|启动|部署|发布|提交|创建|生成|迁移|同步)|(?:做|改|修改|实现|修复|新增|删除|清理|安装|运行|执行|启动|部署|发布|提交|创建|生成|迁移|同步).{0,24}(?:吗|是否|能否|可以吗|怎么|如何|对吧)[？?]?)/iu;
const FUTURE_ACTION = /(?:如果|后续|将来|之后|以后|预计|计划|准备).{0,100}(?:做|改|修改|实现|修复|新增|删除|清理|安装|运行|执行|启动|部署|发布|提交|创建|生成|迁移|同步)/iu;
const EXPLICIT_ACTION = /(?:(?:帮我|请|直接|现在|那就|就按|按照|开始|继续).{0,30}(?:做|改|修改|实现|修复|新增|添加|删除|清理|安装|运行|执行|启动|部署|发布|提交|推送|创建|生成|制作|写入|迁移|同步|替换|调整|优化|完成))|(?:(?:做|改|修改|实现|修复|新增|添加|删除|清理|安装|运行|执行|启动|部署|发布|提交|推送|创建|生成|制作|写入|迁移|同步|替换|调整|优化|完成).{0,24}(?:一下|吧|并(?:运行|执行)?(?:验证|测试|检查)|后.{0,12}(?:验证|测试|运行|跑)|完成|就行|即可)[。！!\s]*$)/iu;
const READ_ONLY = /(?:只|先|暂时)?(?:回答|解释|介绍|分析|检查|审计|评估|判断|确认|查看|研究|调研|讨论|对比)|(?:是什么|为什么|是否|是不是|怎么|如何|能否|可以吗|你认为|建议|方案|取舍|对吧)[？?]?/iu;

function normalized(prompt: string): string {
  return prompt.trim().replace(/\s+/g, " ");
}

export function classifyExecutionIntent(prompt: string): IntentDecision {
  const text = normalized(prompt);
  if (!text) return { intent: "unknown", source: "fallback", reason: "empty_request" };
  if (CONTINUATION.test(text)) {
    return { intent: "continue", source: "rule", reason: "explicit_continuation" };
  }
  if (NEGATED_ACTION.test(text)) {
    return { intent: "ask", source: "rule", reason: "negated_action" };
  }
  if (QUESTION_ABOUT_ACTION.test(text)) {
    return { intent: "ask", source: "rule", reason: "action_question" };
  }
  if (FUTURE_ACTION.test(text)) {
    return { intent: "ask", source: "rule", reason: "future_action" };
  }
  if (EXPLICIT_ACTION.test(text)) {
    return { intent: "do", source: "rule", reason: "explicit_action" };
  }
  if (READ_ONLY.test(text)) {
    return { intent: "ask", source: "rule", reason: "read_only_request" };
  }
  return { intent: "unknown", source: "fallback", reason: "intent_unclassified" };
}

export function resolveExecutionIntent(
  prompt: string,
  options: { aiIntent?: ExecutionIntent; control?: boolean } = {},
): IntentDecision {
  if (options.control) {
    return { intent: "control", source: "manual", reason: "router_control" };
  }
  const deterministic = classifyExecutionIntent(prompt);
  if (deterministic.intent !== "unknown") return deterministic;
  if (options.aiIntent === "ask" || options.aiIntent === "do") {
    return { intent: options.aiIntent, source: "ai", reason: "local_classifier" };
  }
  return deterministic;
}
