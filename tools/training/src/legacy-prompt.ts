export interface ScoringText {
  text: string;
  preprocessing?: string;
}

export function scoringText(prompt: string): ScoringText {
  const normalized = prompt.trim().replace(/\s+/g, " ");
  const markers = ["## My request for Codex:", "# User request", "## user"];
  for (const marker of markers) {
    const index = prompt.lastIndexOf(marker);
    if (index >= 0) {
      const candidate = prompt.slice(index + marker.length).trim();
      if (candidate) {
        return {
          text: candidate.replace(/\s+/g, " "),
          preprocessing: `marker:${marker}`,
        };
      }
    }
  }
  if (normalized.length <= 2000 || /^Automation:\s/im.test(prompt)) {
    return { text: normalized };
  }

  const tail = prompt.slice(-1200).trim();
  const requestSignal =
    /(?:^|[。！？!?\n])\s*(?:请|帮我|给我|我要|你(?:先|现在)?|现在|继续|修复|解决|修改|改下|实现|执行|运行|部署|检查|分析|判断|生成|创建|写|输出|参考这个|结合项目)|(?:为什么|怎么|如何|是否|能否|可以吗|很难实现吗).{0,80}[？?]/isu;
  if (!requestSignal.test(tail)) {
    return { text: "", preprocessing: "long_prompt_without_request_tail" };
  }
  return {
    text: tail.replace(/\s+/g, " "),
    preprocessing: "long_prompt_tail",
  };
}

export function truncateForClassifier(prompt: string, maxChars: number): string {
  const scored = scoringText(prompt).text || prompt.trim();
  if (scored.length <= maxChars) return scored;
  return scored.slice(-maxChars);
}

const COMPLEX_HINTS = [
  /(?:跨仓|跨 repo|多仓|架构|迁移|兼容性|安全|生产|线上|协议|并发|长对话|状态机|数据库)/iu,
  /(?:重构|根因|系统设计|技术选型|完整实现|端到端|透明代理)|(?:设计|实现|构建).{0,20}(?:router|app-server)/iu,
];

const EXTREME_HINTS = [
  /(?:全量迁移|生产事故|严重安全|大规模重构|跨多个系统|不可逆)/iu,
  /(?:ultra|maximum|最难|最高强度)/iu,
];

export function deterministicComplexity(
  prompt: string,
): "simple" | "normal" | "complex" | "extreme" {
  if (EXTREME_HINTS.some((pattern) => pattern.test(prompt))) return "extreme";
  if (prompt.length > 2200 || COMPLEX_HINTS.some((pattern) => pattern.test(prompt))) {
    return "complex";
  }
  if (prompt.length < 90 && !/[，,；;].{20,}[，,；;]/u.test(prompt)) return "simple";
  return "normal";
}
