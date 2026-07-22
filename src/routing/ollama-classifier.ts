import { isSemanticCategory } from "./rules.js";
import {
  type AiClassification,
  COMPLEXITIES,
  type AiDecision,
  type Complexity,
  type OllamaConfig,
} from "./types.js";
import { truncateForClassifier } from "./prompt.js";

interface OllamaGenerateResponse {
  response?: string;
}

const ROUTE_CODES = {
  RESEARCH: "RESEARCH_EXPLAIN",
  AUDIT: "AUDIT_ANALYZE",
  DIAGNOSE: "DIAGNOSE_FIX",
  PLAN: "PLAN_DESIGN",
  IMPLEMENT: "IMPLEMENT_CHANGE",
  OPERATE: "OPERATE_VERIFY",
  ARTIFACT: "CREATE_ARTIFACT",
  AGENT: "AGENT_WORKFLOW",
  PASS: "PASS_CONTEXT",
} as const;

const CLASSIFIER_GUIDE =
  "Route latest request. RESEARCH=解释研究; AUDIT=只读检查; DIAGNOSE=故障根因; " +
  "PLAN=方案讨论; IMPLEMENT=改代码配置; OPERATE=安装运行部署git; " +
  "ARTIFACT=文档图片网页; AGENT=Codex agent skill hook MCP router; PASS=继续寒暄. " +
  "Complexity simple/normal/complex/extreme. JSON only. Request: ";

function parseJsonContent(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : undefined;
  }
}

function isComplexity(value: unknown): value is Complexity {
  return typeof value === "string" && COMPLEXITIES.includes(value as Complexity);
}

export class OllamaClassifier {
  private warming = false;
  private warmed = false;
  private warmupPromise?: Promise<void>;

  constructor(
    private readonly config: OllamaConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async warmup(): Promise<void> {
    if (!this.config.enabled) return;
    if (this.warmupPromise) return this.warmupPromise;
    this.warming = true;
    this.warmupPromise = this.performWarmup();
    return this.warmupPromise;
  }

  private async performWarmup(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    timer.unref();
    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          prompt: "",
          stream: false,
          keep_alive: this.config.keepAlive,
          options: { num_ctx: this.config.contextLength },
        }),
        signal: controller.signal,
      });
      this.warmed = response.ok;
    } catch {
      // Warmup is opportunistic. The actual classification remains fail-open.
    } finally {
      this.warming = false;
      clearTimeout(timer);
    }
  }

  async classify(prompt: string): Promise<AiClassification> {
    if (!this.config.enabled) return { status: "disabled" };
    // Do not queue the first user turn behind a cold model load. Deterministic
    // rules handle it immediately and later turns use the warm model.
    if (this.warming && !this.warmed) return { status: "warming" };
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timer.unref();
    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.config.model,
          stream: false,
          think: false,
          keep_alive: this.config.keepAlive,
          format: {
            type: "object",
            properties: {
              category: {
                type: "string",
                enum: [
                  "RESEARCH",
                  "AUDIT",
                  "DIAGNOSE",
                  "PLAN",
                  "IMPLEMENT",
                  "OPERATE",
                  "ARTIFACT",
                  "AGENT",
                  "PASS",
                ],
              },
              complexity: {
                type: "string",
                enum: ["simple", "normal", "complex", "extreme"],
              },
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
            required: ["category", "complexity", "confidence"],
          },
          prompt: `${CLASSIFIER_GUIDE}${truncateForClassifier(prompt, this.config.maxPromptChars)}`,
          options: {
            temperature: 0,
            num_ctx: this.config.contextLength,
            num_predict: 64,
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return { status: "http_error", latencyMs: Math.round(performance.now() - started) };
      }
      const payload = (await response.json()) as OllamaGenerateResponse;
      const content = payload.response;
      if (!content) {
        return { status: "invalid_response", latencyMs: Math.round(performance.now() - started) };
      }
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = parseJsonContent(content) as Record<string, unknown> | undefined;
      } catch {
        return { status: "invalid_response", latencyMs: Math.round(performance.now() - started) };
      }
      const mappedCategory =
        typeof parsed?.category === "string"
          ? ROUTE_CODES[parsed.category as keyof typeof ROUTE_CODES]
          : undefined;
      if (
        !parsed ||
        !mappedCategory ||
        !isSemanticCategory(mappedCategory) ||
        !isComplexity(parsed.complexity) ||
        typeof parsed.confidence !== "number"
      ) {
        return { status: "invalid_response", latencyMs: Math.round(performance.now() - started) };
      }
      const latencyMs = Math.round(performance.now() - started);
      const decision: AiDecision = {
        category: mappedCategory,
        complexity: parsed.complexity,
        confidence: Math.max(0, Math.min(1, parsed.confidence)),
        reason: "local_qwen_classifier",
        latencyMs,
      };
      return { status: "ok", decision, latencyMs };
    } catch {
      return {
        status: controller.signal.aborted ? "timeout" : "error",
        latencyMs: Math.round(performance.now() - started),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
