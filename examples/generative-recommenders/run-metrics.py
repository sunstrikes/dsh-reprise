#!/usr/bin/env python3
# Copyright (c) the dsh-reprise authors. Apache-2.0.
"""Run the domain repository's training entry point and report the number the metric contract names.

The loop's executor contract is small (``packages/exec/lib/platform-local.js``): a job runs one
process in the candidate's worktree, and it reports its result by writing ``{ "metrics": {...} }`` to
``$REPRISE_METRICS_PATH``. ``main.py`` does neither — it writes to stdout and to tensorboard — so this
file is the glue, and it is deliberately the *only* place that knows how a training log becomes a
metric. That knowledge is the metric contract's window (``metric-contract.json`` › ``window``):

  * the value is the **last epoch whose eval was not truncated**;
  * ``train.py`` truncates an epoch's eval to ``partial_eval_num_iters`` batches unless the epoch is a
    full-eval epoch, and logs ``Truncating epoch N eval to M iters to save cost..`` just before it;
  * the truncated number is measured on a different, shuffled subset of the eval loader, so it is
    reported in the counts but never as the metric.

Usage, as the pack's executor entry runs it (after ``run-metrics.py`` has been copied to the root of
the checkout that ``runner.repo`` points at):

    python3 run-metrics.py python3 main.py \\
        --gin_config_file=configs/ml-1m/hstu-sampled-softmax-n128-final.gin --master_port={free_port}

Or against a log that already exists, which is how a finished run is re-derived (and how the test
exercises the window without a GPU):

    python3 run-metrics.py --from-log driver.log --out metrics.json

``{free_port}`` in the child argv is replaced by a port this process found free, because two jobs on
one node otherwise collide on the master port. The metrics are also printed as a single line
``REPRISE_METRICS {json}`` — the cluster has no shared filesystem, so the driver log is the only
channel results come back through (see the ticket-14 cluster notes).

Written for the standard library only: the job runs on the training nodes, where nothing may be
installed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import subprocess
import sys
import time

# `rank 0: eval @ epoch 3 in 41.20s: NDCG@10 0.1720, NDCG@50 0.2307, HR@10 0.3097, HR@50 0.5754, MRR 0.2601`
EVAL_LINE = re.compile(
    r"eval @ epoch (?P<epoch>\d+) in [\d.]+s: "
    r"NDCG@10 (?P<ndcg10>[\d.]+), NDCG@50 (?P<ndcg50>[\d.]+), "
    r"HR@10 (?P<hr10>[\d.]+), HR@50 (?P<hr50>[\d.]+), MRR (?P<mrr>[\d.]+)"
)

# The line train.py prints immediately *before* a truncated epoch's numbers. It has no epoch suffix
# other than the id, so it is matched on its own and consumed by the next eval line for that epoch.
TRUNCATED_LINE = re.compile(r"Truncating epoch (?P<epoch>\d+) eval to \d+ iters")

MARKER = "REPRISE_METRICS"


def parse_log(text: str) -> dict:
    """The contract's number: the last full eval epoch, plus the counts that say which it was.

    Deterministic and IO-free so a run's metric can be re-derived from its log later — the fact plane
    keeps the log, and a reader nobody can re-run is a number nobody can check.
    """
    truncated_pending: set[int] = set()
    last_full: dict | None = None
    full_epochs = 0
    truncated_epochs = 0
    last_epoch: int | None = None

    for line in text.splitlines():
        truncation = TRUNCATED_LINE.search(line)
        if truncation is not None:
            truncated_pending.add(int(truncation.group("epoch")))
            continue
        match = EVAL_LINE.search(line)
        if match is None:
            continue
        epoch = int(match.group("epoch"))
        last_epoch = epoch
        if epoch in truncated_pending:
            truncated_pending.discard(epoch)
            truncated_epochs += 1
            continue
        full_epochs += 1
        last_full = {
            "hr@10": float(match.group("hr10")),
            "ndcg@10": float(match.group("ndcg10")),
            "hr@50": float(match.group("hr50")),
            "ndcg@50": float(match.group("ndcg50")),
            "mrr": float(match.group("mrr")),
            "epoch": epoch,
        }

    if last_full is None:
        raise LookupError(
            "no full eval epoch in the log"
            + ("" if last_epoch is None else f" (the last epoch seen, {last_epoch}, was truncated)")
        )

    return {
        **last_full,
        "full_eval_epochs": full_epochs,
        "truncated_eval_epochs": truncated_epochs,
    }


def free_port() -> int:
    """A port that was free a moment ago — enough to keep two jobs on one node apart."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("", 0))
        return int(probe.getsockname()[1])


def expand(argv: list[str]) -> list[str]:
    return [str(free_port()) if argument == "{free_port}" else argument for argument in argv]


def write_metrics(metrics: dict, out: str | None) -> None:
    document = json.dumps({"metrics": metrics}, indent=2, sort_keys=True) + "\n"
    target = out or os.environ.get("REPRISE_METRICS_PATH")
    if target:
        # Atomic, because a reader may be looking at the job directory while this job finishes.
        temporary = f"{target}.tmp-{os.getpid()}"
        with open(temporary, "w", encoding="utf-8") as handle:
            handle.write(document)
        os.replace(temporary, target)
    # The driver log is the only channel off the training node: one line, parseable, always printed.
    sys.stdout.write(f"{MARKER} {json.dumps(metrics, sort_keys=True)}\n")
    sys.stdout.flush()


def run(command: list[str]) -> tuple[dict, int]:
    started = time.time()
    child = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    lines: list[str] = []
    # Keep the last N lines only: a 101-epoch run prints a lot, and the answer is always near the end.
    limit = 20000
    assert child.stdout is not None
    for line in child.stdout:
        lines.append(line)
        if len(lines) > limit:
            del lines[: len(lines) - limit]
        sys.stdout.write(line)
        sys.stdout.flush()
    assert child.stderr is not None
    stderr = child.stderr.read()
    if stderr:
        sys.stderr.write(stderr)
        sys.stderr.flush()
    code = child.wait()

    metrics = parse_log("".join(lines))
    metrics["train_seconds"] = round(time.time() - started, 3)
    return metrics, code


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--from-log", metavar="PATH", help="read a training log instead of running one")
    parser.add_argument("--out", metavar="PATH", help="also write the metrics document here (default: $REPRISE_METRICS_PATH)")
    parser.add_argument(
        "command",
        nargs=argparse.REMAINDER,
        help="the training command, e.g. `python3 main.py --gin_config_file=configs/ml-1m/...gin`",
    )
    options = parser.parse_args(argv)

    if options.from_log:
        with open(options.from_log, encoding="utf-8") as handle:
            metrics = parse_log(handle.read())
        write_metrics(metrics, options.out)
        return 0

    command = expand(list(options.command))
    if not command:
        parser.error("no training command: pass one after the script name, or use --from-log")

    try:
        metrics, code = run(command)
    except LookupError as error:
        # A run that produced no full eval produced no metric. Exit non-zero and say so: the executor
        # classifies a job that ends 0 without metrics as a `data` failure, and a fabricated number
        # would be worse than a failed run.
        sys.stderr.write(f"run-metrics: {error}\n")
        return 3

    write_metrics(metrics, options.out)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))