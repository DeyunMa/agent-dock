import { stat } from "node:fs/promises";
import { DEFAULT_CONFIG_PATH, expandHome, loadConfig } from "./config.js";
import {
  RouterEngine,
  RouterSessionState,
  type AiClassifier,
  type RouteOptions,
  type RoutingEngine,
} from "./engine.js";
import { OllamaClassifier } from "./ollama-classifier.js";
import { loadRules } from "./rules.js";
import type {
  ModelCatalog,
  RouteDecision,
  RouterConfig,
  TurnStartParams,
} from "./types.js";

async function fileSignature(path: string): Promise<string> {
  try {
    const details = await stat(path);
    return `${details.ino}:${details.size}:${details.mtimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/**
 * Keeps the data plane hot while making control-plane TOML edits visible on the
 * next turn. The only steady-state cost is two local stat calls; no gateway or
 * network health check is allowed on this path.
 */
export class ReloadingRouterEngine implements RoutingEngine {
  private engine: RouterEngine;
  private configSignature: string;
  private rulesSignature: string;
  private catalog?: ModelCatalog;
  private reloadTask: Promise<void> | undefined;
  private readonly sessionState: RouterSessionState;
  private classifier: AiClassifier;
  private classifierSignature: string;

  private constructor(
    private readonly configPath: string,
    engine: RouterEngine,
    configSignature: string,
    rulesSignature: string,
    sessionState: RouterSessionState,
    classifier: AiClassifier,
    classifierSignature: string,
  ) {
    this.engine = engine;
    this.configSignature = configSignature;
    this.rulesSignature = rulesSignature;
    this.sessionState = sessionState;
    this.classifier = classifier;
    this.classifierSignature = classifierSignature;
  }

  static async create(
    path = process.env.CODEX_ROUTER_CONFIG ?? DEFAULT_CONFIG_PATH,
  ): Promise<ReloadingRouterEngine> {
    const configPath = expandHome(path);
    const config = await loadConfig(configPath);
    const rules = await loadRules(config.rulesFile);
    const sessionState = new RouterSessionState();
    const classifier = new OllamaClassifier(config.ollama);
    const classifierSignature = JSON.stringify(config.ollama);
    return new ReloadingRouterEngine(
      configPath,
      new RouterEngine(config, rules, classifier, sessionState),
      await fileSignature(configPath),
      await fileSignature(config.rulesFile),
      sessionState,
      classifier,
      classifierSignature,
    );
  }

  get config(): RouterConfig {
    return this.engine.config;
  }

  warmup(): void {
    this.engine.warmup();
  }

  setModelCatalog(catalog: ModelCatalog): void {
    this.catalog = catalog;
    this.engine.setModelCatalog(catalog);
  }

  private async reloadIfChanged(): Promise<void> {
    if (this.reloadTask) return this.reloadTask;
    this.reloadTask = this.reloadIfChangedUnserialized().finally(() => {
      this.reloadTask = undefined;
    });
    return this.reloadTask;
  }

  private async reloadIfChangedUnserialized(): Promise<void> {
    const nextConfigSignature = await fileSignature(this.configPath);
    const configChanged = nextConfigSignature !== this.configSignature;
    const nextRulesSignature = configChanged
      ? this.rulesSignature
      : await fileSignature(this.engine.config.rulesFile);
    if (!configChanged && nextRulesSignature === this.rulesSignature) return;

    // Parse and validate everything before replacing the live engine. Any
    // error bubbles to ProtocolRouter, whose contract is byte-for-byte fail-open.
    const config = await loadConfig(this.configPath);
    const rules = await loadRules(config.rulesFile);
    const classifierSignature = JSON.stringify(config.ollama);
    if (classifierSignature !== this.classifierSignature) {
      this.classifier = new OllamaClassifier(config.ollama);
      this.classifierSignature = classifierSignature;
    }
    const replacement = new RouterEngine(
      config,
      rules,
      this.classifier,
      this.sessionState,
    );
    if (this.catalog) replacement.setModelCatalog(this.catalog);
    replacement.warmup();

    this.engine = replacement;
    this.configSignature = nextConfigSignature;
    this.rulesSignature = await fileSignature(config.rulesFile);
  }

  async routeTurn(
    params: TurnStartParams,
    options: RouteOptions = {},
  ): Promise<RouteDecision> {
    await this.reloadIfChanged();
    return this.engine.routeTurn(params, options);
  }
}
