from __future__ import annotations

import unittest

from router_training import (
    EMBEDDING_MAX_CHARS,
    embedding_text,
    loopback_ollama_url,
    observed_contract_labels,
    route_for_labels,
    select_validation_coverage_moves,
    validated_run_id,
)


PROJECTION = {
    "routeOrder": ["quick", "balanced", "deep", "max"],
    "categoryRoutes": {
        "RESEARCH_EXPLAIN": "quick",
        "AUDIT_ANALYZE": "balanced",
        "DIAGNOSE_FIX": "deep",
        "PLAN_DESIGN": "deep",
        "IMPLEMENT_CHANGE": "balanced",
        "OPERATE_VERIFY": "balanced",
        "CREATE_ARTIFACT": "deep",
        "AGENT_WORKFLOW": "deep",
        "PASS_CONTEXT": "inherit",
    },
    "complexityRoutes": {
        "simple": "quick",
        "normal": "inherit",
        "complex": "deep",
        "extreme": "max",
    },
}


class RouterTrainingTest(unittest.TestCase):
    def test_route_projection_matches_router_contract(self) -> None:
        self.assertEqual(
            route_for_labels("RESEARCH_EXPLAIN", "normal", PROJECTION), "quick"
        )
        self.assertEqual(
            route_for_labels("IMPLEMENT_CHANGE", "complex", PROJECTION), "deep"
        )
        self.assertEqual(
            route_for_labels("PLAN_DESIGN", "extreme", PROJECTION), "max"
        )
        self.assertEqual(
            route_for_labels("PASS_CONTEXT", "extreme", PROJECTION), "native"
        )

    def test_ollama_host_is_loopback_only(self) -> None:
        self.assertEqual(loopback_ollama_url(None), "http://127.0.0.1:11434")
        self.assertEqual(
            loopback_ollama_url("localhost:11434"), "http://localhost:11434"
        )
        with self.assertRaisesRegex(ValueError, "non-loopback"):
            loopback_ollama_url("https://example.com")

    def test_run_id_cannot_escape_private_training_root(self) -> None:
        self.assertEqual(validated_run_id("baseline-v1.1"), "baseline-v1.1")
        for value in ("", "../escape", "nested/run", "-leading"):
            with self.subTest(value=value), self.assertRaisesRegex(
                ValueError, "run id"
            ):
                validated_run_id(value)

    def test_embedding_text_matches_the_tail_focused_runtime_contract(self) -> None:
        self.assertEqual(embedding_text("  hello\n\nworld  "), "hello world")
        source = "first " + ("x" * EMBEDDING_MAX_CHARS) + " latest"
        result = embedding_text(source)
        self.assertEqual(len(result), EMBEDDING_MAX_CHARS)
        self.assertTrue(result.endswith(" latest"))
        self.assertNotIn("first", result)

    def test_metrics_only_average_labels_observed_in_validation(self) -> None:
        labels = ["ask", "do", "continue", "control", "unknown"]
        self.assertEqual(
            observed_contract_labels(labels, ["do", "ask", "do"]),
            ["ask", "do"],
        )

    def test_validation_coverage_moves_only_reviewed_synthetic_records(self) -> None:
        validation = []
        labels_by_target = {
            "intent": ["ask", "do", "continue", "control"],
            "category": list(PROJECTION["categoryRoutes"]),
            "complexity": list(PROJECTION["complexityRoutes"]),
        }
        for target, labels in labels_by_target.items():
            for label in labels:
                for index in range(5):
                    record_labels = {
                        "intent": "ask",
                        "category": "RESEARCH_EXPLAIN",
                        "complexity": "normal",
                    }
                    record_labels[target] = label
                    validation.append(
                        {
                            "id": f"validation-{target}-{label}-{index}",
                            "provenance": "real_teacher_reviewed",
                            "labels": record_labels,
                        }
                    )
        train = [
            {
                "id": f"synthetic-unknown-{index}",
                "provenance": "synthetic_v1",
                "labels": {
                    "intent": "unknown",
                    "category": "PASS_CONTEXT",
                    "complexity": "simple",
                },
            }
            for index in range(10)
        ]
        moved = select_validation_coverage_moves(train, validation)
        self.assertEqual(len(moved), 5)
        self.assertTrue(all(value.startswith("synthetic-unknown-") for value in moved))


if __name__ == "__main__":
    unittest.main()
