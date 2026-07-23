from __future__ import annotations

import hashlib
import json
import math
import os
import platform
import re
import resource
import secrets
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "4")
os.environ.setdefault("VECLIB_MAXIMUM_THREADS", "4")
os.environ.setdefault("NUMEXPR_NUM_THREADS", "4")

import numpy as np
import sklearn
from sklearn.exceptions import ConvergenceWarning
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
    f1_score,
)


SCHEMA_VERSION = 1
RANDOM_STATE = 42
TARGET_LABELS: dict[str, list[str]] = {
    "intent": ["ask", "do", "continue", "control", "unknown"],
    "category": [
        "RESEARCH_EXPLAIN",
        "AUDIT_ANALYZE",
        "DIAGNOSE_FIX",
        "PLAN_DESIGN",
        "IMPLEMENT_CHANGE",
        "OPERATE_VERIFY",
        "CREATE_ARTIFACT",
        "AGENT_WORKFLOW",
        "PASS_CONTEXT",
    ],
    "complexity": ["simple", "normal", "complex", "extreme"],
}
CONFIDENCE_THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9]
EMBEDDING_MAX_CHARS = 2_000
EMBEDDING_PREPROCESSING = "collapse_whitespace_then_tail_v1"
VALIDATION_MIN_PER_LABEL = 5

LOCAL_TRAINING_ROOT = Path(__file__).resolve().parents[1]
WORK_ROOT = LOCAL_TRAINING_ROOT / "work"
DEFAULT_WORKSPACE = WORK_ROOT / "v1"
MODEL_LOCK_PATH = LOCAL_TRAINING_ROOT / "model-lock.json"


@dataclass(frozen=True)
class TrainingOptions:
    workspace: Path
    run_id: str
    batch_size: int = 32
    intent_c: float = 3.0
    category_c: float = 1.0
    complexity_c: float = 10.0
    max_iter: int = 2_000

    def regularization_for(self, target: str) -> float:
        return {
            "intent": self.intent_c,
            "category": self.category_c,
            "complexity": self.complexity_c,
        }[target]


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_text(value: str) -> str:
    return sha256_bytes(value.encode("utf-8"))


def json_bytes(value: Any, *, indent: int | None = 2) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=indent, sort_keys=True) + "\n").encode(
        "utf-8"
    )


def records_sha256(records: Iterable[dict[str, Any]]) -> str:
    return sha256_bytes(b"".join(json_bytes(record, indent=None) for record in records))


def embedding_text(value: str) -> str:
    normalized = " ".join(value.strip().split())
    if len(normalized) <= EMBEDDING_MAX_CHARS:
        return normalized
    return normalized[-EMBEDDING_MAX_CHARS:]


def ensure_inside(root: Path, candidate: Path) -> Path:
    root_resolved = root.resolve(strict=True)
    candidate_absolute = candidate.absolute()
    try:
        candidate_absolute.relative_to(root.absolute())
    except ValueError as error:
        raise ValueError(f"path must remain inside {root}") from error

    current = root.absolute()
    relative_parts = candidate_absolute.relative_to(root.absolute()).parts
    for part in relative_parts:
        current = current / part
        if not current.exists() and not current.is_symlink():
            break
        metadata = current.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise ValueError(f"path contains symlink: {current}")
        resolved = current.resolve(strict=True)
        try:
            resolved.relative_to(root_resolved)
        except ValueError as error:
            raise ValueError(f"path escapes private root: {current}") from error
    return candidate_absolute


def ensure_private_directory(path: Path) -> None:
    safe_path = ensure_inside(WORK_ROOT, path)
    safe_path.mkdir(parents=True, exist_ok=True, mode=0o700)
    safe_path.chmod(0o700)


def validated_run_id(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", value):
        raise ValueError(
            "run id must be 1-64 characters using letters, digits, dot, underscore, or hyphen"
        )
    return value


def write_private_bytes(path: Path, value: bytes) -> None:
    safe_path = ensure_inside(WORK_ROOT, path)
    ensure_private_directory(safe_path.parent)
    safe_path = ensure_inside(WORK_ROOT, safe_path)
    temporary = safe_path.with_name(
        f"{safe_path.name}.tmp-{os.getpid()}-{secrets.token_hex(8)}"
    )
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        try:
            temporary.unlink(missing_ok=True)
        finally:
            raise
    os.replace(temporary, safe_path)
    safe_path.chmod(0o600)


def write_private_json(path: Path, value: Any) -> None:
    write_private_bytes(path, json_bytes(value))


def write_private_jsonl(path: Path, records: Iterable[dict[str, Any]]) -> None:
    source = b"".join(json_bytes(record, indent=None) for record in records)
    write_private_bytes(path, source)


def read_json(path: Path) -> tuple[dict[str, Any], bytes]:
    if path.is_symlink():
        raise ValueError(f"refusing symlink input: {path}")
    source = path.read_bytes()
    value = json.loads(source)
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value, source


def read_jsonl(path: Path, expected_sha256: str) -> tuple[list[dict[str, Any]], bytes]:
    if path.is_symlink():
        raise ValueError(f"refusing symlink input: {path}")
    source = path.read_bytes()
    actual_sha256 = sha256_bytes(source)
    if actual_sha256 != expected_sha256:
        raise ValueError(
            f"{path.name} hash mismatch: expected {expected_sha256}, got {actual_sha256}"
        )
    records: list[dict[str, Any]] = []
    for index, line in enumerate(source.splitlines(), start=1):
        try:
            value = json.loads(line)
        except json.JSONDecodeError as error:
            raise ValueError(f"{path}:{index} is invalid JSON") from error
        if not isinstance(value, dict):
            raise ValueError(f"{path}:{index} must be an object")
        records.append(value)
    return records, source


def loopback_ollama_url(raw: str | None) -> str:
    value = (raw or "http://127.0.0.1:11434").strip()
    if "://" not in value:
        value = f"http://{value}"
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError(f"refusing non-loopback Ollama host: {parsed.hostname}")
    return value.rstrip("/")


def request_json(
    url: str,
    *,
    body: dict[str, Any] | None = None,
    timeout: float = 120.0,
) -> dict[str, Any]:
    data = None if body is None else json_bytes(body, indent=None)
    request = urllib.request.Request(
        url,
        data=data,
        headers={"content-type": "application/json"} if data is not None else {},
        method="POST" if data is not None else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Ollama request failed with HTTP {error.code}") from error
    if not isinstance(payload, dict):
        raise RuntimeError("Ollama returned a non-object response")
    return payload


def verify_ollama_model(base_url: str, model_lock: dict[str, Any]) -> str:
    payload = request_json(f"{base_url}/api/tags", timeout=30.0)
    models = payload.get("models")
    if not isinstance(models, list):
        raise RuntimeError("Ollama tags response has no model list")
    expected_name = model_lock["embedding_model"]
    expected_digest = model_lock["ollama_manifest_digest"]
    for model in models:
        if not isinstance(model, dict):
            continue
        if model.get("name") == expected_name or model.get("model") == expected_name:
            digest = model.get("digest")
            if digest != expected_digest:
                raise RuntimeError(
                    f"embedding model digest mismatch: expected {expected_digest}, got {digest}"
                )
            return str(digest)
    raise RuntimeError(f"embedding model is not installed: {expected_name}")


def normalized_embeddings(
    texts: list[str],
    *,
    base_url: str,
    model_lock: dict[str, Any],
    batch_size: int,
) -> np.ndarray:
    expected_dimensions = int(model_lock["expected_dimensions"])
    endpoint = str(model_lock["endpoint"])
    model_name = str(model_lock["embedding_model"])
    vectors = np.empty((len(texts), expected_dimensions), dtype=np.float32)
    started_at = time.perf_counter()
    total_batches = math.ceil(len(texts) / batch_size)
    for batch_index, offset in enumerate(range(0, len(texts), batch_size), start=1):
        batch = texts[offset : offset + batch_size]
        payload = request_json(
            f"{base_url}{endpoint}",
            body={
                "model": model_name,
                "input": batch,
                "keep_alive": "5m",
                "truncate": True,
            },
        )
        raw_embeddings = payload.get("embeddings")
        if not isinstance(raw_embeddings, list) or len(raw_embeddings) != len(batch):
            raise RuntimeError(
                f"Ollama returned {len(raw_embeddings) if isinstance(raw_embeddings, list) else 0} "
                f"embeddings for {len(batch)} records"
            )
        matrix = np.asarray(raw_embeddings, dtype=np.float32)
        if matrix.shape != (len(batch), expected_dimensions):
            raise RuntimeError(
                f"embedding shape mismatch: expected {(len(batch), expected_dimensions)}, "
                f"got {matrix.shape}"
            )
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        if not np.isfinite(norms).all() or np.any(norms == 0):
            raise RuntimeError("Ollama returned invalid embedding vectors")
        vectors[offset : offset + len(batch)] = matrix / norms
        if batch_index == 1 or batch_index % 10 == 0 or batch_index == total_batches:
            elapsed = time.perf_counter() - started_at
            print(
                f"embedding {batch_index}/{total_batches} batches "
                f"({offset + len(batch)}/{len(texts)} records, {elapsed:.1f}s)",
                flush=True,
            )
    return vectors


def cache_key(
    model_digest: str,
    train_sha256: str,
    validation_sha256: str,
    dimensions: int,
) -> str:
    return sha256_text(
        f"{model_digest}:{train_sha256}:{validation_sha256}:{dimensions}:"
        f"{EMBEDDING_PREPROCESSING}:{EMBEDDING_MAX_CHARS}"
    )[:24]


def save_embedding_cache(
    path: Path,
    metadata_path: Path,
    *,
    train_embeddings: np.ndarray,
    validation_embeddings: np.ndarray,
    metadata: dict[str, Any],
) -> None:
    ensure_private_directory(path.parent)
    safe_path = ensure_inside(WORK_ROOT, path)
    temporary = safe_path.with_name(
        f"{safe_path.name}.tmp-{os.getpid()}-{secrets.token_hex(8)}"
    )
    descriptor = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        with os.fdopen(descriptor, "wb") as handle:
            np.savez_compressed(
                handle,
                train=train_embeddings.astype(np.float32, copy=False),
                validation=validation_embeddings.astype(np.float32, copy=False),
            )
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        try:
            temporary.unlink(missing_ok=True)
        finally:
            raise
    os.replace(temporary, safe_path)
    safe_path.chmod(0o600)
    write_private_json(metadata_path, metadata)


def load_or_create_embeddings(
    train_records: list[dict[str, Any]],
    validation_records: list[dict[str, Any]],
    *,
    workspace: Path,
    model_lock: dict[str, Any],
    train_sha256: str,
    validation_sha256: str,
    batch_size: int,
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    base_url = loopback_ollama_url(os.environ.get("OLLAMA_HOST"))
    actual_digest = verify_ollama_model(base_url, model_lock)
    dimensions = int(model_lock["expected_dimensions"])
    key = cache_key(actual_digest, train_sha256, validation_sha256, dimensions)
    cache_directory = workspace / "embedding-cache"
    cache_path = cache_directory / f"{key}.npz"
    metadata_path = cache_directory / f"{key}.json"
    train_ids_hash = sha256_text("\n".join(str(record["id"]) for record in train_records))
    validation_ids_hash = sha256_text(
        "\n".join(str(record["id"]) for record in validation_records)
    )
    expected_metadata = {
        "schema_version": SCHEMA_VERSION,
        "model": model_lock["embedding_model"],
        "model_digest": actual_digest,
        "dimensions": dimensions,
        "preprocessing": EMBEDDING_PREPROCESSING,
        "max_chars": EMBEDDING_MAX_CHARS,
        "train_sha256": train_sha256,
        "validation_sha256": validation_sha256,
        "train_ids_sha256": train_ids_hash,
        "validation_ids_sha256": validation_ids_hash,
        "train_records": len(train_records),
        "validation_records": len(validation_records),
    }
    if cache_path.exists() and metadata_path.exists():
        existing_metadata, _ = read_json(metadata_path)
        if existing_metadata == expected_metadata:
            with np.load(cache_path, allow_pickle=False) as cache:
                train_embeddings = np.asarray(cache["train"], dtype=np.float32)
                validation_embeddings = np.asarray(
                    cache["validation"], dtype=np.float32
                )
            if train_embeddings.shape == (len(train_records), dimensions) and (
                validation_embeddings.shape == (len(validation_records), dimensions)
            ):
                print(f"reusing embedding cache {cache_path.name}", flush=True)
                return train_embeddings, validation_embeddings, expected_metadata

    all_records = [*train_records, *validation_records]
    all_embeddings = normalized_embeddings(
        [embedding_text(str(record["text"])) for record in all_records],
        base_url=base_url,
        model_lock=model_lock,
        batch_size=batch_size,
    )
    train_embeddings = all_embeddings[: len(train_records)]
    validation_embeddings = all_embeddings[len(train_records) :]
    save_embedding_cache(
        cache_path,
        metadata_path,
        train_embeddings=train_embeddings,
        validation_embeddings=validation_embeddings,
        metadata=expected_metadata,
    )
    return train_embeddings, validation_embeddings, expected_metadata


def class_distribution(values: Iterable[str]) -> dict[str, int]:
    distribution: dict[str, int] = {}
    for value in values:
        distribution[value] = distribution.get(value, 0) + 1
    return dict(sorted(distribution.items()))


def observed_contract_labels(labels: list[str], values: Iterable[str]) -> list[str]:
    observed = set(values)
    return [label for label in labels if label in observed]


def select_validation_coverage_moves(
    train_records: list[dict[str, Any]],
    validation_records: list[dict[str, Any]],
    *,
    minimum_per_label: int = VALIDATION_MIN_PER_LABEL,
) -> list[str]:
    selected: list[str] = []
    selected_ids: set[str] = set()
    for target, labels in TARGET_LABELS.items():
        validation_counts = Counter(
            str(record["labels"][target]) for record in validation_records
        )
        validation_counts.update(
            str(record["labels"][target])
            for record in train_records
            if str(record["id"]) in selected_ids
        )
        for label in labels:
            needed = minimum_per_label - validation_counts[label]
            if needed <= 0:
                continue
            candidates = [
                record
                for record in train_records
                if record["id"] not in selected_ids
                and record.get("provenance") == "synthetic_v1"
                and str(record["labels"][target]) == label
            ]
            candidates.sort(key=lambda record: sha256_text(str(record["id"])))
            train_count = sum(
                str(record["labels"][target]) == label for record in train_records
            )
            already_selected = sum(
                str(record["labels"][target]) == label
                for record in train_records
                if record["id"] in selected_ids
            )
            movable = max(
                0,
                train_count - already_selected - minimum_per_label,
            )
            chosen = candidates[: min(needed, movable)]
            if len(chosen) < needed:
                raise ValueError(
                    f"cannot cover validation label {target}={label} without "
                    "using frozen test or depleting training coverage"
                )
            for record in chosen:
                record_id = str(record["id"])
                selected.append(record_id)
                selected_ids.add(record_id)
                validation_counts[label] += 1
    return selected


def apply_validation_coverage_overlay(
    train_records: list[dict[str, Any]],
    validation_records: list[dict[str, Any]],
    train_embeddings: np.ndarray,
    validation_embeddings: np.ndarray,
) -> tuple[
    list[dict[str, Any]],
    list[dict[str, Any]],
    np.ndarray,
    np.ndarray,
    dict[str, Any],
]:
    moved_ids = select_validation_coverage_moves(train_records, validation_records)
    moved_id_set = set(moved_ids)
    train_indices = [
        index
        for index, record in enumerate(train_records)
        if str(record["id"]) not in moved_id_set
    ]
    moved_indices = [
        index
        for index, record in enumerate(train_records)
        if str(record["id"]) in moved_id_set
    ]
    effective_train = [train_records[index] for index in train_indices]
    moved_records = [
        {**train_records[index], "split": "validation"} for index in moved_indices
    ]
    effective_validation = [*validation_records, *moved_records]
    effective_train_embeddings = train_embeddings[train_indices]
    effective_validation_embeddings = np.concatenate(
        [validation_embeddings, train_embeddings[moved_indices]],
        axis=0,
    )
    coverage = {
        target: {
            "before": class_distribution(
                str(record["labels"][target]) for record in validation_records
            ),
            "after": class_distribution(
                str(record["labels"][target]) for record in effective_validation
            ),
        }
        for target in TARGET_LABELS
    }
    overlay = {
        "minimum_per_label": VALIDATION_MIN_PER_LABEL,
        "moved_records": [
            {
                "id": str(record["id"]),
                "provenance": str(record["provenance"]),
                "from": "train",
                "to": "validation",
            }
            for record in moved_records
        ],
        "coverage": coverage,
    }
    return (
        effective_train,
        effective_validation,
        effective_train_embeddings,
        effective_validation_embeddings,
        overlay,
    )


def confidence_curve(
    truth: np.ndarray,
    predictions: np.ndarray,
    confidence: np.ndarray,
    labels: list[str],
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for threshold in CONFIDENCE_THRESHOLDS:
        selected = confidence >= threshold
        count = int(selected.sum())
        if count == 0:
            rows.append(
                {
                    "threshold": threshold,
                    "records": 0,
                    "coverage": 0.0,
                    "accuracy": None,
                    "macro_f1": None,
                }
            )
            continue
        rows.append(
            {
                "threshold": threshold,
                "records": count,
                "coverage": round(count / len(truth), 6),
                "accuracy": round(float(accuracy_score(truth[selected], predictions[selected])), 6),
                "macro_f1": round(
                    float(
                        f1_score(
                            truth[selected],
                            predictions[selected],
                            labels=labels,
                            average="macro",
                            zero_division=0,
                        )
                    ),
                    6,
                ),
            }
        )
    return rows


def train_target(
    target: str,
    *,
    train_records: list[dict[str, Any]],
    validation_records: list[dict[str, Any]],
    train_embeddings: np.ndarray,
    validation_embeddings: np.ndarray,
    regularization_c: float,
    max_iter: int,
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    labels = TARGET_LABELS[target]
    train_truth = np.asarray(
        [str(record["labels"][target]) for record in train_records], dtype=str
    )
    validation_truth = np.asarray(
        [str(record["labels"][target]) for record in validation_records], dtype=str
    )
    missing_train = sorted(set(labels) - set(train_truth.tolist()))
    missing_validation = sorted(set(labels) - set(validation_truth.tolist()))
    if missing_train:
        raise ValueError(f"{target} training split is missing classes: {missing_train}")
    evaluated_labels = observed_contract_labels(labels, validation_truth.tolist())
    if not evaluated_labels:
        raise ValueError(f"{target} validation split has no contract labels")

    estimator = LogisticRegression(
        C=regularization_c,
        class_weight="balanced",
        max_iter=max_iter,
        random_state=RANDOM_STATE,
        solver="lbfgs",
        tol=1e-4,
    )
    fit_started = time.perf_counter()
    with warnings.catch_warnings(record=True) as captured_warnings:
        warnings.simplefilter("always", ConvergenceWarning)
        estimator.fit(train_embeddings, train_truth)
    fit_ms = round((time.perf_counter() - fit_started) * 1000, 3)

    predict_started = time.perf_counter()
    probabilities = estimator.predict_proba(validation_embeddings)
    predictions = estimator.classes_[probabilities.argmax(axis=1)]
    predict_ms = round((time.perf_counter() - predict_started) * 1000, 3)
    confidence = probabilities.max(axis=1)
    sorted_probabilities = np.sort(probabilities, axis=1)
    margins = sorted_probabilities[:, -1] - sorted_probabilities[:, -2]
    report = classification_report(
        validation_truth,
        predictions,
        labels=labels,
        output_dict=True,
        zero_division=0,
    )
    matrix = confusion_matrix(validation_truth, predictions, labels=labels)
    metrics = {
        "target": target,
        "labels": labels,
        "evaluated_labels": evaluated_labels,
        "validation_missing_labels": missing_validation,
        "train_distribution": class_distribution(train_truth.tolist()),
        "validation_distribution": class_distribution(validation_truth.tolist()),
        "accuracy": round(float(accuracy_score(validation_truth, predictions)), 6),
        "macro_f1": round(
            float(
                f1_score(
                    validation_truth,
                    predictions,
                    labels=evaluated_labels,
                    average="macro",
                    zero_division=0,
                )
            ),
            6,
        ),
        "weighted_f1": round(
            float(
                f1_score(
                    validation_truth,
                    predictions,
                    labels=labels,
                    average="weighted",
                    zero_division=0,
                )
            ),
            6,
        ),
        "classification_report": report,
        "confusion_matrix": {
            "labels": labels,
            "matrix": matrix.tolist(),
        },
        "confidence_curve": confidence_curve(
            validation_truth, predictions, confidence, evaluated_labels
        ),
        "fit_ms": fit_ms,
        "predict_ms": predict_ms,
        "iterations": [int(value) for value in estimator.n_iter_.tolist()],
        "convergence_warnings": [str(item.message) for item in captured_warnings],
    }
    prediction_rows = [
        {
            "id": str(record["id"]),
            "truth": str(validation_truth[index]),
            "prediction": str(predictions[index]),
            "confidence": round(float(confidence[index]), 6),
            "margin": round(float(margins[index]), 6),
            "correct": bool(validation_truth[index] == predictions[index]),
        }
        for index, record in enumerate(validation_records)
    ]
    model_export = {
        "schema_version": SCHEMA_VERSION,
        "kind": "multinomial_logistic_regression",
        "target": target,
        "classes": [str(value) for value in estimator.classes_.tolist()],
        "coefficients": estimator.coef_.tolist(),
        "intercepts": estimator.intercept_.tolist(),
        "normalization": "l2_unit_embedding",
        "regularization_c": regularization_c,
        "class_weight": "balanced",
        "solver": "lbfgs",
        "max_iter": max_iter,
        "random_state": RANDOM_STATE,
    }
    return metrics, prediction_rows, model_export


def route_for_labels(
    category: str,
    complexity: str,
    projection: dict[str, Any],
) -> str:
    if category == "PASS_CONTEXT":
        return "native"
    category_route = projection["categoryRoutes"].get(category)
    complexity_route = projection["complexityRoutes"].get(complexity)
    if complexity_route == "inherit":
        return category_route or "native"
    if not category_route:
        return complexity_route or "native"
    route_order = projection["routeOrder"]
    try:
        category_index = route_order.index(category_route)
        complexity_index = route_order.index(complexity_route)
    except ValueError:
        return "native"
    return category_route if category_index >= complexity_index else complexity_route


def teacher_report(
    metrics: dict[str, dict[str, Any]],
    route_metrics: dict[str, Any],
    run_manifest: dict[str, Any],
) -> str:
    lines = [
        "# Baseline validation report",
        "",
        "Frozen test was not read or evaluated in this run.",
        "",
        "## Summary",
        "",
        "| Target | Accuracy | Macro F1 | Weighted F1 |",
        "|---|---:|---:|---:|",
    ]
    for target in ("intent", "category", "complexity"):
        item = metrics[target]
        lines.append(
            f"| {target} | {item['accuracy']:.4f} | {item['macro_f1']:.4f} | "
            f"{item['weighted_f1']:.4f} |"
        )
    lines.extend(
        [
            "",
            f"Downstream route accuracy: {route_metrics['accuracy']:.4f}",
            (
                "Validation coverage overlay: "
                f"{len(run_manifest['validation_coverage_overlay']['moved_records'])} "
                "reviewed synthetic records moved from train to validation."
            ),
            "",
            "## Per-class recall",
            "",
        ]
    )
    for target in ("intent", "category", "complexity"):
        lines.extend([f"### {target}", ""])
        report = metrics[target]["classification_report"]
        for label in TARGET_LABELS[target]:
            values = report[label]
            if int(values["support"]) == 0:
                lines.append(f"- `{label}`: not evaluated (support 0)")
                continue
            lines.append(
                f"- `{label}`: precision {values['precision']:.4f}, "
                f"recall {values['recall']:.4f}, f1 {values['f1-score']:.4f}, "
                f"support {int(values['support'])}"
            )
        lines.append("")
    lines.extend(
        [
            "## Run",
            "",
            f"- Run id: `{run_manifest['run_id']}`",
            f"- Duration: {run_manifest['duration_ms'] / 1000:.2f}s",
            f"- Peak RSS (platform raw): {run_manifest['peak_rss_raw']}",
            f"- scikit-learn: `{run_manifest['environment']['scikit_learn']}`",
            f"- numpy: `{run_manifest['environment']['numpy']}`",
            "",
        ]
    )
    return "\n".join(lines)


def train_validation_baseline(options: TrainingOptions) -> dict[str, Any]:
    started_at = time.perf_counter()
    ensure_private_directory(WORK_ROOT)
    workspace = ensure_inside(WORK_ROOT, options.workspace)
    run_id = validated_run_id(options.run_id)
    manifest_path = workspace / "pretraining-v1" / "manifest.json"
    manifest, manifest_source = read_json(manifest_path)
    if manifest.get("status") != "ready_for_training":
        raise ValueError("pretraining manifest is not ready_for_training")
    if manifest.get("training_executed") is not False:
        raise ValueError("pretraining manifest unexpectedly reports training_executed")
    datasets = manifest["datasets"]
    train_path = workspace / "pretraining-v1" / "datasets" / "train.jsonl"
    validation_path = workspace / "pretraining-v1" / "datasets" / "validation.jsonl"
    train_records, _ = read_jsonl(train_path, datasets["train"]["sha256"])
    validation_records, _ = read_jsonl(
        validation_path, datasets["validation"]["sha256"]
    )
    if len(train_records) != datasets["train"]["records"]:
        raise ValueError("train record count does not match pretraining manifest")
    if len(validation_records) != datasets["validation"]["records"]:
        raise ValueError("validation record count does not match pretraining manifest")
    if any(record.get("split") != "train" for record in train_records):
        raise ValueError("train dataset contains a non-train record")
    if any(record.get("split") != "validation" for record in validation_records):
        raise ValueError("validation dataset contains a non-validation record")

    model_lock, model_lock_source = read_json(MODEL_LOCK_PATH)
    train_embeddings, validation_embeddings, embedding_metadata = (
        load_or_create_embeddings(
            train_records,
            validation_records,
            workspace=workspace,
            model_lock=model_lock,
            train_sha256=datasets["train"]["sha256"],
            validation_sha256=datasets["validation"]["sha256"],
            batch_size=options.batch_size,
        )
    )
    (
        train_records,
        validation_records,
        train_embeddings,
        validation_embeddings,
        coverage_overlay,
    ) = apply_validation_coverage_overlay(
        train_records,
        validation_records,
        train_embeddings,
        validation_embeddings,
    )
    effective_train_sha256 = records_sha256(train_records)
    effective_validation_sha256 = records_sha256(validation_records)
    run_directory = workspace / "training-runs" / run_id
    ensure_private_directory(run_directory)
    metrics: dict[str, dict[str, Any]] = {}
    predictions_by_target: dict[str, list[dict[str, Any]]] = {}
    for target in ("intent", "category", "complexity"):
        print(f"training {target} classifier", flush=True)
        target_metrics, predictions, model_export = train_target(
            target,
            train_records=train_records,
            validation_records=validation_records,
            train_embeddings=train_embeddings,
            validation_embeddings=validation_embeddings,
            regularization_c=options.regularization_for(target),
            max_iter=options.max_iter,
        )
        metrics[target] = target_metrics
        predictions_by_target[target] = predictions
        model_export["embedding_model"] = embedding_metadata["model"]
        model_export["embedding_model_digest"] = embedding_metadata["model_digest"]
        model_export["embedding_dimensions"] = embedding_metadata["dimensions"]
        model_export["embedding_preprocessing"] = embedding_metadata["preprocessing"]
        model_export["embedding_max_chars"] = embedding_metadata["max_chars"]
        model_export["source_train_sha256"] = datasets["train"]["sha256"]
        model_export["effective_train_sha256"] = effective_train_sha256
        write_private_json(run_directory / "models" / f"{target}.json", model_export)

    route_projection = manifest["route_projection"]
    combined_predictions: list[dict[str, Any]] = []
    route_truth: list[str] = []
    route_predictions: list[str] = []
    for index, record in enumerate(validation_records):
        intent_prediction = predictions_by_target["intent"][index]
        category_prediction = predictions_by_target["category"][index]
        complexity_prediction = predictions_by_target["complexity"][index]
        predicted_route = route_for_labels(
            str(category_prediction["prediction"]),
            str(complexity_prediction["prediction"]),
            route_projection,
        )
        actual_route = str(record["labels"]["route"])
        route_truth.append(actual_route)
        route_predictions.append(predicted_route)
        combined_predictions.append(
            {
                "schema_version": SCHEMA_VERSION,
                "id": str(record["id"]),
                "provenance": str(record["provenance"]),
                "text": str(record["text"]),
                "truth": record["labels"],
                "prediction": {
                    "intent": intent_prediction["prediction"],
                    "category": category_prediction["prediction"],
                    "complexity": complexity_prediction["prediction"],
                    "route": predicted_route,
                },
                "confidence": {
                    "intent": intent_prediction["confidence"],
                    "category": category_prediction["confidence"],
                    "complexity": complexity_prediction["confidence"],
                },
                "margin": {
                    "intent": intent_prediction["margin"],
                    "category": category_prediction["margin"],
                    "complexity": complexity_prediction["margin"],
                },
                "correct": {
                    "intent": intent_prediction["correct"],
                    "category": category_prediction["correct"],
                    "complexity": complexity_prediction["correct"],
                    "route": actual_route == predicted_route,
                },
            }
        )
    route_labels = ["native", "quick", "balanced", "deep", "max"]
    route_metrics = {
        "accuracy": round(float(accuracy_score(route_truth, route_predictions)), 6),
        "confusion_matrix": {
            "labels": route_labels,
            "matrix": confusion_matrix(
                route_truth, route_predictions, labels=route_labels
            ).tolist(),
        },
    }
    duration_ms = round((time.perf_counter() - started_at) * 1000, 3)
    run_manifest = {
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "phase": "validation_baseline",
        "frozen_test_read": False,
        "runtime_integration_changed": False,
        "started_from_pretraining_manifest_sha256": sha256_bytes(manifest_source),
        "model_lock_sha256": sha256_bytes(model_lock_source),
        "inputs": {
            "source_train_records": datasets["train"]["records"],
            "source_train_sha256": datasets["train"]["sha256"],
            "source_validation_records": datasets["validation"]["records"],
            "source_validation_sha256": datasets["validation"]["sha256"],
            "effective_train_records": len(train_records),
            "effective_train_sha256": effective_train_sha256,
            "effective_validation_records": len(validation_records),
            "effective_validation_sha256": effective_validation_sha256,
        },
        "validation_coverage_overlay": coverage_overlay,
        "embedding": embedding_metadata,
        "classifier": {
            "kind": "multinomial_logistic_regression",
            "regularization_c": {
                target: options.regularization_for(target) for target in TARGET_LABELS
            },
            "class_weight": "balanced",
            "solver": "lbfgs",
            "max_iter": options.max_iter,
            "random_state": RANDOM_STATE,
        },
        "environment": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "numpy": np.__version__,
            "scikit_learn": sklearn.__version__,
            "thread_limits": {
                "OMP_NUM_THREADS": os.environ.get("OMP_NUM_THREADS"),
                "OPENBLAS_NUM_THREADS": os.environ.get("OPENBLAS_NUM_THREADS"),
                "VECLIB_MAXIMUM_THREADS": os.environ.get(
                    "VECLIB_MAXIMUM_THREADS"
                ),
                "NUMEXPR_NUM_THREADS": os.environ.get("NUMEXPR_NUM_THREADS"),
            },
        },
        "duration_ms": duration_ms,
        "peak_rss_raw": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "metrics": {
            target: {
                "accuracy": values["accuracy"],
                "macro_f1": values["macro_f1"],
                "weighted_f1": values["weighted_f1"],
            }
            for target, values in metrics.items()
        },
        "route_accuracy": route_metrics["accuracy"],
    }
    write_private_json(run_directory / "metrics.json", metrics)
    write_private_json(run_directory / "route-metrics.json", route_metrics)
    write_private_jsonl(
        run_directory / "validation-predictions.jsonl", combined_predictions
    )
    write_private_json(run_directory / "manifest.json", run_manifest)
    write_private_bytes(
        run_directory / "teacher-report.md",
        teacher_report(metrics, route_metrics, run_manifest).encode("utf-8"),
    )
    print(json.dumps(run_manifest["metrics"], ensure_ascii=False), flush=True)
    print(f"route_accuracy={route_metrics['accuracy']}", flush=True)
    return run_manifest
