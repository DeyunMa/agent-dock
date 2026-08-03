from __future__ import annotations

import argparse
from pathlib import Path

from router_training import DEFAULT_WORKSPACE, TrainingOptions, train_validation_baseline


def parse_args() -> TrainingOptions:
    parser = argparse.ArgumentParser(
        description="Train three local Router classifiers on train and validation only."
    )
    parser.add_argument("--workspace", type=Path, default=DEFAULT_WORKSPACE)
    parser.add_argument("--run-id", default="baseline-v1")
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--c", type=float)
    parser.add_argument("--intent-c", type=float, default=3.0)
    parser.add_argument("--category-c", type=float, default=1.0)
    parser.add_argument("--complexity-c", type=float, default=10.0)
    parser.add_argument("--max-iter", type=int, default=2_000)
    args = parser.parse_args()
    if args.batch_size < 1 or args.batch_size > 128:
        parser.error("--batch-size must be between 1 and 128")
    regularization_values = [
        value
        for value in (args.c, args.intent_c, args.category_c, args.complexity_c)
        if value is not None
    ]
    if any(value <= 0 for value in regularization_values):
        parser.error("regularization values must be positive")
    if args.max_iter < 100:
        parser.error("--max-iter must be at least 100")
    return TrainingOptions(
        workspace=args.workspace,
        run_id=args.run_id,
        batch_size=args.batch_size,
        intent_c=args.c if args.c is not None else args.intent_c,
        category_c=args.c if args.c is not None else args.category_c,
        complexity_c=args.c if args.c is not None else args.complexity_c,
        max_iter=args.max_iter,
    )


if __name__ == "__main__":
    train_validation_baseline(parse_args())
