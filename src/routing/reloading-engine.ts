import { stat } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_CONFIG_PATH, expandHome, loadConfig } from "./config.js";
import { EmbeddingClassifier } from "./embedding-classifier.js";
import {
  RouterEngine,
  RouterSessionState,
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

async function artifactSignature(config: RouterConfig): Promise<string> {
  return (
    await Promise.all(
      ["intent.json", "category.json", "complexity.json"].map((name) =>
        fileSignature(join(config.classifier.modelDirectory, name)),
      ),
    )
  ).join("|");
}

export type ClassifierFactory = (config: RouterConfig) => AiClassifier;

const defaultClassifierFactory: ClassifierFactory = (config) =>
  new EmbeddingClassifier(config.classifier);

/**
 * Keeps the data plane hot while making control-plane edits and private model
 * updates visible on the next turn. Reload failures bubble to ProtocolRouter,
 * whose contract is byte-for-byte fail-open.
 */
export class ReloadingRouterEngine implements RoutingEngine {
  private engine: RouterEngine;
  private configSignature: string;
  private artifactSignature: string;
  private catalog?: ModelCatalog;
  private reloadTask: Promise<void> | undefined;
  private readonly sessionState: RouterSessionState;
  private classifier: AiClassifier;
  private classifierConfigSignature: string;

  private constructor(
    private readonly configPath: string,
    private readonly classifierFactory: ClassifierFactory,
    engine: RouterEngine,
    configSignature: string,
    classifierArtifactSignature: string,
    sessionState: RouterSessionState,
    classifier: AiClassifier,
    classifierConfigSignature: string,
  ) {
    this.engine = engine;
    this.configSignature = configSignature;
    this.artifactSignature = classifierArtifactSignature;
    this.sessionState = sessionState;
    this.classifier = classifier;
    this.classifierConfigSignature = classifierConfigSignature;
  }

  static async create(
    path = process.env.CODEX_ROUTER_CONFIG ?? DEFAULT_CONFIG_PATH,
    classifierFactory: ClassifierFactory = defaultClassifierFactory,
  ): Promise<ReloadingRouterEngine> {
    const configPath = expandHome(path);
    const config = await loadConfig(configPath);
    const sessionState = new RouterSessionState();
    const classifier = classifierFactory(config);
    const classifierConfigSignature = JSON.stringify(config.classifier);
    return new ReloadingRouterEngine(
      configPath,
      classifierFactory,
      new RouterEngine(config, classifier, sessionState),
      await fileSignature(configPath),
      await artifactSignature(config),
      sessionState,
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
    const nextArtifactSignature = configChanged
      ? this.artifactSignature
      : await artifactSignature(this.engine.config);
    if (!configChanged && nextArtifactSignature === this.artifactSignature) return;

    const config = await loadConfig(this.configPath);
    const resolvedArtifactSignature = await artifactSignature(config);
    const classifierConfigSignature = JSON.stringify(config.classifier);
    if (
      classifierConfigSignature !== this.classifierConfigSignature ||
      resolvedArtifactSignature !== this.artifactSignature
    ) {
      this.classifier = this.classifierFactory(config);
      this.classifierConfigSignature = classifierConfigSignature;
    }
    const replacement = new RouterEngine(config, this.classifier, this.sessionState);
    if (this.catalog) replacement.setModelCatalog(this.catalog);
    replacement.warmup();

    this.engine = replacement;
    this.configSignature = nextConfigSignature;
    this.artifactSignature = resolvedArtifactSignature;
  }

  async routeTurn(
    params: TurnStartParams,
    options: RouteOptions = {},
  ): Promise<RouteDecision> {
    await this.reloadIfChanged();
    return this.engine.routeTurn(params, options);
  }
}
