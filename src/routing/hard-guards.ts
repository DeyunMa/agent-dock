export type HardGuardReason =
  | "empty_request"
  | "explicit_suppression"
  | "internal_context";

export interface HardGuardDecision {
  reason: HardGuardReason;
}

const ROUTER_SUPPRESSION =
  /(?:不要|不用|关闭|停用|跳过).{0,8}(?:这个)?(?:路由|router|routing)|(?:路由|router|routing).{0,8}(?:关闭|停用|off)/isu;

const INTERNAL_CONTEXT = /^(?:You are a memory extractor\b|# Instructions \(read first\)|<codex_internal_context\b|<environment_context\b)/iu;

const CONTINUATION =
  /^(?:继续(?:吧|做|处理|修改|执行)?|接着(?:做|继续)?|做吧|开始吧|go\s+ahead|continue|proceed)[。！!？?\s]*$/iu;

export function hardGuard(prompt: string): HardGuardDecision | undefined {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  if (!normalized) return { reason: "empty_request" };
  if (ROUTER_SUPPRESSION.test(normalized)) {
    return { reason: "explicit_suppression" };
  }
  if (INTERNAL_CONTEXT.test(normalized)) {
    return { reason: "internal_context" };
  }
  return undefined;
}

export function isExplicitContinuation(prompt: string): boolean {
  return CONTINUATION.test(prompt.trim().replace(/\s+/g, " "));
}
