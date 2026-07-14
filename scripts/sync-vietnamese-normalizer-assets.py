#!/usr/bin/env python3
"""Download and export pinned soe-vinorm assets for the MV3 extension."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import pickle
import shutil
import struct
import subprocess
from pathlib import Path

from huggingface_hub import HfApi, hf_hub_download


SOURCE_REPOSITORY = "https://github.com/vinhdq842/soe-vinorm"
SOURCE_VERSION = "v0.3.2"
SOURCE_COMMIT = "c2b0c1eb36cec1584416ca4652b5391f4e723727"
MODEL_REPOSITORY = "vinhdq842/soe-vinorm"
MODEL_REVISION = "cb9705b"
ASSET_BUDGET_BYTES = 5_242_880
EXPECTED_CHECKPOINT_LABELS = [
    "O",
    "B-LWRD",
    "I-LWRD",
    "B-NSCR",
    "B-NNUM",
    "B-URLE",
    "B-NDAY",
    "B-LABB",
    "B-LSEQ",
    "B-MEA",
    "B-NFRC",
    "I-LSEQ",
    "I-LABB",
    "B-NDAT",
    "B-NRNG",
    "B-ROMA",
    "B-NDIG",
    "I-NSCR",
    "B-NMON",
    "B-NPER",
    "I-NDIG",
    "B-NTIM",
    "B-MONEY",
    "B-NVER",
    "B-USS",
    "I-MEA",
    "I-NTIM",
    "I-MONEY",
    "B-NQUA",
    "I-NRNG",
]
MODEL_FILES = {
    "abbreviation_expander/v0.2/config.json": "abbreviation-config.json",
    "abbreviation_expander/v0.2/scorer.onnx": "abbreviation-scorer.onnx",
    "nsw_detector/crf.pkl": "crf.pkl",
}


def run(command: list[str], cwd: Path | None = None) -> str:
    return subprocess.run(
        command,
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def ensure_source_checkout(scratch_root: Path) -> Path:
    source_dir = scratch_root / "soe-vinorm"
    if not (source_dir / ".git").is_dir():
        if source_dir.exists():
            shutil.rmtree(source_dir)
        run(
            [
                "git",
                "clone",
                "--filter=blob:none",
                "--branch",
                SOURCE_VERSION,
                "--depth",
                "1",
                SOURCE_REPOSITORY,
                str(source_dir),
            ]
        )

    commit = run(["git", "rev-parse", "HEAD"], cwd=source_dir)
    if commit != SOURCE_COMMIT:
        raise RuntimeError(f"Unexpected soe-vinorm commit: {commit}")
    return source_dir


def resolve_model_revision() -> str:
    revision = HfApi().model_info(MODEL_REPOSITORY, revision=MODEL_REVISION).sha
    if not revision or len(revision) != 40 or any(char not in "0123456789abcdef" for char in revision):
        raise RuntimeError(f"Hugging Face returned a non-immutable revision: {revision}")
    return revision


def download_model_files(scratch_root: Path, revision: str) -> dict[str, Path]:
    cache_dir = scratch_root / "huggingface-cache"
    downloaded = {}
    for remote_path, output_name in MODEL_FILES.items():
        downloaded[output_name] = Path(
            hf_hub_download(
                repo_id=MODEL_REPOSITORY,
                filename=remote_path,
                revision=revision,
                cache_dir=cache_dir,
            )
        )
    return downloaded


def load_crf_model(pickle_path: Path):
    with pickle_path.open("rb") as handle:
        return pickle.load(handle)


def write_crf_binary(crf, output_path: Path) -> list[str]:
    labels = list(crf.classes_)
    if labels != EXPECTED_CHECKPOINT_LABELS:
        raise RuntimeError(f"Unexpected CRF checkpoint label order: {labels}")

    label_indexes = {label: index for index, label in enumerate(labels)}
    state_items = [
        (attribute, label_indexes[label], float(weight))
        for (attribute, label), weight in crf.state_features_.items()
    ]
    if any(not math.isfinite(weight) for _, _, weight in state_items):
        raise RuntimeError("CRF contains a non-finite state weight")

    attributes = sorted({attribute for attribute, _, _ in state_items})
    attribute_indexes = {attribute: index for index, attribute in enumerate(attributes)}
    state_records = sorted(
        (attribute_indexes[attribute], label_index, weight)
        for attribute, label_index, weight in state_items
    )
    transition_records = sorted(
        (label_indexes[from_label], label_indexes[to_label], float(weight))
        for (from_label, to_label), weight in crf.transition_features_.items()
    )
    if any(not math.isfinite(weight) for _, _, weight in transition_records):
        raise RuntimeError("CRF contains a non-finite transition weight")

    with output_path.open("wb") as handle:
        handle.write(
            struct.pack(
                "<4sHHIII",
                b"VCRF",
                1,
                len(labels),
                len(attributes),
                len(state_records),
                len(transition_records),
            )
        )
        for attribute in attributes:
            encoded = attribute.encode("utf-8")
            handle.write(struct.pack("<I", len(encoded)))
            handle.write(encoded)
        for attribute_index, label_index, weight in state_records:
            handle.write(struct.pack("<IB3xd", attribute_index, label_index, weight))
        for from_label, to_label, weight in transition_records:
            handle.write(struct.pack("<BBHd", from_label, to_label, 0, weight))

    verify_crf_binary(output_path, labels, attributes, state_records, transition_records)
    return labels


def verify_crf_binary(
    path: Path,
    expected_labels: list[str],
    expected_attributes: list[str],
    expected_states: list[tuple[int, int, float]],
    expected_transitions: list[tuple[int, int, float]],
) -> None:
    data = memoryview(path.read_bytes())
    offset = 0

    def unpack(fmt: str):
        nonlocal offset
        size = struct.calcsize(fmt)
        if offset + size > len(data):
            raise RuntimeError("Generated CRF binary is truncated")
        values = struct.unpack_from(fmt, data, offset)
        offset += size
        return values

    magic, version, label_count, attribute_count, state_count, transition_count = unpack("<4sHHIII")
    if (magic, version, label_count) != (b"VCRF", 1, len(expected_labels)):
        raise RuntimeError("Generated CRF binary has an invalid header")

    attributes = []
    for _ in range(attribute_count):
        (length,) = unpack("<I")
        if offset + length > len(data):
            raise RuntimeError("Generated CRF attribute is truncated")
        attributes.append(bytes(data[offset : offset + length]).decode("utf-8"))
        offset += length

    states = [unpack("<IB3xd") for _ in range(state_count)]
    transitions = [unpack("<BBHd") for _ in range(transition_count)]
    normalized_transitions = [(from_label, to_label, weight) for from_label, to_label, _, weight in transitions]
    if offset != len(data):
        raise RuntimeError("Generated CRF binary contains trailing bytes")
    if attributes != expected_attributes or states != expected_states or normalized_transitions != expected_transitions:
        raise RuntimeError("Generated CRF binary failed deterministic round-trip verification")


def checksum_record(path: Path) -> dict[str, object]:
    data = path.read_bytes()
    return {
        "path": path.name,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "license": "MIT",
    }


def export_assets(output_dir: Path, scratch_root: Path) -> None:
    source_dir = ensure_source_checkout(scratch_root)
    revision = resolve_model_revision()
    model_files = download_model_files(scratch_root, revision)

    staging_dir = scratch_root / "staging"
    if staging_dir.exists():
        shutil.rmtree(staging_dir)
    staging_dir.mkdir(parents=True)

    dictionaries_dir = source_dir / "soe_vinorm" / "data" / "dictionaries"
    shutil.copyfile(dictionaries_dir / "abbreviations.txt", staging_dir / "abbreviations.txt")
    shutil.copyfile(dictionaries_dir / "vietnamese-syllables.txt", staging_dir / "vietnamese-syllables.txt")
    shutil.copyfile(model_files["abbreviation-config.json"], staging_dir / "abbreviation-config.json")
    shutil.copyfile(model_files["abbreviation-scorer.onnx"], staging_dir / "abbreviation-scorer.onnx")
    labels = write_crf_binary(load_crf_model(model_files["crf.pkl"]), staging_dir / "crf-model.bin")

    asset_paths = sorted(path for path in staging_dir.iterdir() if path.is_file())
    records = [checksum_record(path) for path in asset_paths]
    total_bytes = sum(int(record["bytes"]) for record in records)
    if total_bytes > ASSET_BUDGET_BYTES:
        raise RuntimeError(f"Asset budget exceeded: {total_bytes} > {ASSET_BUDGET_BYTES}")

    manifest = {
        "formatVersion": 1,
        "source": {
            "repository": SOURCE_REPOSITORY,
            "version": SOURCE_VERSION,
            "commit": SOURCE_COMMIT,
            "license": "MIT",
        },
        "modelSource": {
            "repository": f"https://huggingface.co/{MODEL_REPOSITORY}",
            "revision": revision,
            "license": "MIT",
        },
        "assetBudgetBytes": ASSET_BUDGET_BYTES,
        "labels": labels,
        "abbreviation": {
            "confidenceThreshold": None,
            "confidenceMargin": None,
        },
        "files": records,
    }
    (staging_dir / "model-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    output_dir.parent.mkdir(parents=True, exist_ok=True)
    backup_dir = output_dir.with_name(f".{output_dir.name}.previous")
    if backup_dir.exists():
        shutil.rmtree(backup_dir)
    if output_dir.exists():
        output_dir.replace(backup_dir)
    try:
        staging_dir.replace(output_dir)
    except Exception:
        if backup_dir.exists() and not output_dir.exists():
            backup_dir.replace(output_dir)
        raise
    if backup_dir.exists():
        shutil.rmtree(backup_dir)
    print(json.dumps({"revision": revision, "totalBytes": total_bytes, "files": len(records)}))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    repository_root = Path(__file__).resolve().parents[1]
    output_dir = (repository_root / args.output).resolve() if not args.output.is_absolute() else args.output.resolve()
    try:
        output_dir.relative_to(repository_root)
    except ValueError as error:
        raise RuntimeError("Output directory must stay inside the repository") from error

    scratch_root = repository_root / ".tmp" / "vietnamese-normalizer-assets"
    scratch_root.mkdir(parents=True, exist_ok=True)
    export_assets(output_dir, scratch_root)


if __name__ == "__main__":
    main()
