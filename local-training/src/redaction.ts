const SECRET_MARKER = "[REDACTED_SECRET]";

function redactContextualHighEntropy(value: string): string {
  return value.replace(
    /[A-Za-z0-9_-]{32,}/g,
    (candidate: string, offset: number, source: string) => {
      if (!/[A-Za-z]/.test(candidate) || !/\d/.test(candidate)) {
        return candidate;
      }
      const prefix = source.slice(Math.max(0, offset - 100), offset);
      return /(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|token|secret|credential|密码|口令|密钥|环境变量)/iu.test(
        prefix,
      )
        ? SECRET_MARKER
        : candidate;
    },
  );
}

export function redactSensitiveText(value: string): string {
  const redacted = value
    .replace(/\/Users\/mdy(?=\/|\b)/g, "<HOME>")
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
      "[REDACTED_EMAIL]",
    )
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g, SECRET_MARKER)
    .replace(/\bjina_[A-Za-z0-9_-]{20,}\b/g, SECRET_MARKER)
    .replace(/\bhf_[A-Za-z0-9_-]{20,}\b/g, SECRET_MARKER)
    .replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, SECRET_MARKER)
    .replace(/\bnpm_[A-Za-z0-9_-]{20,}\b/g, SECRET_MARKER)
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, SECRET_MARKER)
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, SECRET_MARKER)
    .replace(
      /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g,
      SECRET_MARKER,
    )
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, SECRET_MARKER)
    .replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/giu,
      `Bearer ${SECRET_MARKER}`,
    )
    .replace(
      /\bBasic\s+[A-Za-z0-9+/=]{16,}\b/giu,
      `Basic ${SECRET_MARKER}`,
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
      SECRET_MARKER,
    )
    .replace(
      /((?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|password|密码|口令|密钥)\s*(?:[:=]|是|为)\s*)["']?[^\s"',;，。；()（）]{4,}["']?/giu,
      `$1${SECRET_MARKER}`,
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|key)=)[^&\s"'，。；]+/giu,
      `$1${SECRET_MARKER}`,
    )
    .replace(
      /\b(?:admin123|password123|changeme|test1234)\b/giu,
      SECRET_MARKER,
    );
  return redactContextualHighEntropy(redacted);
}
