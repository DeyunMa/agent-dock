import { stat } from "node:fs/promises";
import { configuredConfigPath, expandHome, loadConfig } from "./config.js";
import { JevClassifier } from "./jev-classifier.js";
import {
  RouterEngine,
  type AiClassifier,
  type RouteOptions,
  type RoutingEngine,
} from "./engine.js";
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

export type ClassifierFactory = (config: RouterConfig) => AiClassifier;

const defaultClassifierFactory: ClassifierFactory = (config) =>
  new JevClassifier(config);

/**
 * Makes control-plane edits visible to new tasks; existing profiles live in
 * the durable thread store. Reload failures bubble to ProtocolRouter,
 * whose contract is byte-for-byte fail-open.
 */
export class ReloadingRouterEngine implements RoutingEngine {
  private engine: RouterEngine;
  private configSignature: string;
  private catalog?: ModelCatalog;
  private reloadTask: Promise<void> | undefined;
  private classifier: AiClassifier;
  private classifierConfigSignature: string;

  private constructor(
    private readonly configPath: string,
    private readonly classifierFactory: ClassifierFactory,
    engine: RouterEngine,
    configSignature: string,
    classifier: AiClassifier,
    classifierConfigSignature: string,
  ) {
    this.engine = engine;
    this.configSignature = configSignature;
    this.classifier = classifier;
    this.classifierConfigSignature = classifierConfigSignature;
  }

  static async create(
    path = configuredConfigPath(),
    classifierFactory: ClassifierFactory = defaultClassifierFactory,
  ): Promise<ReloadingRouterEngine> {
    const configPath = expandHome(path);
    const config = await loadConfig(configPath);
    const classifier = classifierFactory(config);
    const classifierConfigSignature = JSON.stringify({ classifier: config.classifier, routes: config.routes });
    return new ReloadingRouterEngine(
      configPath,
      classifierFactory,
      new RouterEngine(config, classifier),
      await fileSignature(configPath),
      classifier,
      classifierConfigSignature,
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
    if (!configChanged) return;

    const config = await loadConfig(this.configPath);
    const classifierConfigSignature = JSON.stringify({ classifier: config.classifier, routes: config.routes });
    if (
      classifierConfigSignature !== this.classifierConfigSignature
    ) {
      this.classifier = this.classifierFactory(config);
      this.classifierConfigSignature = classifierConfigSignature;
    }
    const replacement = new RouterEngine(config, this.classifier);
    if (this.catalog) replacement.setModelCatalog(this.catalog);
    replacement.warmup();

    this.engine = replacement;
    this.configSignature = nextConfigSignature;
  }

  async routeTurn(
    params: TurnStartParams,
    options: RouteOptions = {},
  ): Promise<RouteDecision> {
    await this.reloadIfChanged();
    return this.engine.routeTurn(params, options);
  }
}
