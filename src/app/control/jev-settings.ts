import { chmod, lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { JevClassifier, readJevKey } from "../../router/core/jev-classifier.js";
import type { RouterConfig } from "../../router/core/types.js";

export async function jevStatus(config: RouterConfig) {
  const source = process.env.TYPESAFE_API_KEY?.trim() ? "environment" : "file";
  try {
    await readJevKey(config.classifier.apiKeyFile);
    return { configured: true, source };
  } catch {
    return { configured: false, source };
  }
}

export async function saveJevKey(path: string, key: unknown): Promise<void> {
  if (process.env.TYPESAFE_API_KEY?.trim()) throw new Error("当前使用 TYPESAFE_API_KEY；请先移除该环境变量再管理本机密钥。");
  if (typeof key !== "string" || !/^apikey_[A-Za-z0-9_-]{16,512}$/.test(key.trim())) {
    throw new Error("Jev Key 格式无效，未保存。");
  }
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) {
    throw new Error("凭据目录必须属于当前用户且不能是符号链接。");
  }
  await chmod(directory, 0o700);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${key.trim()}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function deleteJevKey(path: string): Promise<void> {
  if (process.env.TYPESAFE_API_KEY?.trim()) throw new Error("当前使用环境变量；删除文件不会清除环境变量密钥。");
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw new Error("无法删除 Jev 凭据文件。");
  });
}

export async function testJev(config: RouterConfig) {
  const probe = structuredClone(config);
  probe.classifier.enabled = true;
  const result = await new JevClassifier(probe).classify("请把 hello 翻译成中文。这是固定连接测试，不含用户对话。");
  return { ok: result.status === "ok", status: result.status, latencyMs: result.latencyMs ?? 0 };
}
