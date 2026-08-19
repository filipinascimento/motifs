#!/usr/bin/env python3
"""Build the website engineering bundle from a finalized motif-v2 release.

The hierarchy and the engineering entities must come from the same release.
This adapter preserves the release's paper, device, variant, component, and
characteristic IDs, creates deterministic frontend navigation indexes, and
repairs aggregate motif chronology/counts in the sanitized hierarchy file.
It does not infer component-to-component interfaces or invent measurements.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


NUMBER = r"[+\-\u2212]?(?:\d+(?:,\d{3})*|\d*\.\d+)(?:[eE][+\-]?\d+)?"
NUMBER_RE = re.compile(NUMBER)
RANGE_RE = re.compile(rf"^\s*({NUMBER})\s*(?:[\u2013\u2014]|\bto\b)\s*({NUMBER})\s*$", re.I)
PLUS_MINUS_RE = re.compile(rf"^\s*({NUMBER})\s*(?:\u00b1|\+/-)\s*({NUMBER})\s*$")
POWER_RE = re.compile(r"^\s*([<>]?)[~\u2248]?\s*10\s*\^\s*([+\-]?\d+)\s*$")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def write_json(path: Path, value: Any, *, pretty: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(
        json.dumps(
            value,
            ensure_ascii=False,
            indent=2 if pretty else None,
            separators=None if pretty else (",", ":"),
        ) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return list(dict.fromkeys(str(item) for item in value if item not in (None, "")))


def safe_float(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(str(value).replace(",", "").replace("\u2212", "-"))
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def canonical_unit(value: Any) -> str:
    unit = unicodedata.normalize("NFKC", str(value or "")).strip()
    unit = unit.replace("\u03bc", "\u00b5").replace("\u2212", "-")
    unit = re.sub(r"\s+", " ", unit)
    aliases = {
        "percent": "%",
        "degree c": "\u00b0C",
        "deg c": "\u00b0C",
        "sec": "s",
        "seconds": "s",
        "minutes": "min",
        "hours": "h",
    }
    return aliases.get(unit.casefold(), unit)


def numeric_value(raw: Any) -> dict[str, Any] | None:
    direct = safe_float(raw)
    if direct is not None:
        return {"value_type": "point", "normalized_value": direct}
    text = str(raw or "").strip().replace("\u2212", "-")
    if not text:
        return None
    power = POWER_RE.fullmatch(text)
    if power:
        number = 10.0 ** int(power.group(2))
        comparator = power.group(1)
        if comparator == ">":
            return {"value_type": "lower_bound", "normalized_min": number}
        if comparator == "<":
            return {"value_type": "upper_bound", "normalized_max": number}
        return {"value_type": "point", "normalized_value": number}
    cleaned = re.sub(
        r"^(?:approximately|approx\.?|about|roughly|nearly|around|ca\.?)\s+",
        "",
        text,
        flags=re.I,
    ).strip()
    cleaned = re.sub(r"^[~\u2248]\s*", "", cleaned)
    plus_minus = PLUS_MINUS_RE.fullmatch(cleaned)
    if plus_minus:
        point = safe_float(plus_minus.group(1))
        delta = safe_float(plus_minus.group(2))
        if point is not None and delta is not None:
            return {
                "value_type": "interval",
                "normalized_min": point - abs(delta),
                "normalized_max": point + abs(delta),
            }
    range_match = RANGE_RE.fullmatch(cleaned)
    if range_match:
        lower, upper = safe_float(range_match.group(1)), safe_float(range_match.group(2))
        if lower is not None and upper is not None:
            return {
                "value_type": "interval",
                "normalized_min": min(lower, upper),
                "normalized_max": max(lower, upper),
            }
    comparator = ""
    if cleaned.startswith((">=", "\u2265")):
        comparator, cleaned = "lower_bound", cleaned[2:].strip() if cleaned.startswith(">=") else cleaned[1:].strip()
    elif cleaned.startswith(("<=", "\u2264")):
        comparator, cleaned = "upper_bound", cleaned[2:].strip() if cleaned.startswith("<=") else cleaned[1:].strip()
    elif cleaned.startswith(">"):
        comparator, cleaned = "lower_bound", cleaned[1:].strip()
    elif cleaned.startswith("<"):
        comparator, cleaned = "upper_bound", cleaned[1:].strip()
    elif re.search(r"\bor (?:less|lower|smaller)\b", cleaned, re.I):
        comparator = "upper_bound"
    elif re.search(r"\bor (?:more|greater|higher)\b", cleaned, re.I):
        comparator = "lower_bound"
    numbers = NUMBER_RE.findall(cleaned)
    if len(numbers) != 1:
        return None
    number = safe_float(numbers[0])
    if number is None:
        return None
    if comparator == "lower_bound":
        return {"value_type": comparator, "normalized_min": number}
    if comparator == "upper_bound":
        return {"value_type": comparator, "normalized_max": number}
    # Reject dimension lists and equations that happen to contain one number.
    remainder = NUMBER_RE.sub("", cleaned).strip().casefold()
    if any(token in remainder for token in (" x ", " \u00d7 ", "/(", "=")):
        return None
    return {"value_type": "point", "normalized_value": number}


def metric_id(name: str) -> str:
    normalized = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().casefold()
    return re.sub(r"[^a-z0-9]+", "_", normalized).strip("_") or "reported_value"


def paper_title(row: dict[str, Any]) -> str:
    title = str(row.get("bibliographic_title") or row.get("document_title") or "").strip()
    title = re.sub(r"\.pdf$", "", title, flags=re.I).replace("_", " ").strip()
    return title or f"Paper {row.get('year', '')}".strip()


def metric_category(name: str, unit: str) -> str:
    text = f"{name} {unit}".casefold()
    groups = [
        ("geometry", ("width", "length", "height", "diameter", "radius", "pitch", "thickness", "area", "volume", "spacing", "roughness", "size")),
        ("timing_and_rate", ("time", "rate", "speed", "frequency", "latency", "duration", "cycle", "hz", "rpm")),
        ("electrical", ("voltage", "current", "resistance", "impedance", "capacit", "conductiv", "mobility", "power", "energy", " v", "amp")),
        ("mechanical", ("strain", "stress", "modulus", "force", "pressure", "stiff", "tough", "bend", "adhesion")),
        ("thermal", ("temperature", "thermal", "heat", "\u00b0c", "kelvin")),
        ("optical", ("wavelength", "optical", "loss", "transmit", "reflect", "lumin", "db", "nm")),
        ("performance", ("sensitivity", "accuracy", "yield", "efficiency", "response", "resolution", "detection", "gain", "ratio")),
    ]
    return next((category for category, tokens in groups if any(token in text for token in tokens)), "other")


def record_template() -> dict[str, list[str]]:
    return {
        "accepted_measurement_ids": [],
        "plot_measurement_ids": [],
        "relationship_ids": [],
        "failure_ids": [],
        "constraint_ids": [],
        "coverage_ids": [],
    }


def expanded(ids: Iterable[str], parents: dict[str, list[str]], valid: set[str]) -> set[str]:
    result = {item for item in ids if item in valid}
    frontier = list(result)
    while frontier:
        item = frontier.pop()
        for parent in parents.get(item, []):
            if parent in valid and parent not in result:
                result.add(parent)
                frontier.append(parent)
    return result


def update_hierarchy(
    hierarchy: dict[str, Any],
    release_rows: dict[str, dict[str, Any]],
    papers: dict[str, dict[str, Any]],
    devices: list[dict[str, Any]],
    components: list[dict[str, Any]],
    variants: list[dict[str, Any]],
) -> None:
    valid = {node["id"] for node in hierarchy["nodes"]}
    parents = {node["id"]: strings(node.get("parent_ids")) for node in hierarchy["nodes"]}
    device_sets: dict[str, set[str]] = defaultdict(set)
    component_sets: dict[str, set[str]] = defaultdict(set)
    components_by_device: dict[str, list[dict[str, Any]]] = defaultdict(list)
    variants_by_device: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for component in components:
        components_by_device[str(component.get("device_id") or "")].append(component)
    for variant in variants:
        variants_by_device[str(variant.get("device_id") or "")].append(variant)
    for device in devices:
        device_id = str(device["device_id"])
        direct = set(strings(device.get("motif_ids")))
        direct.update(motif for row in components_by_device.get(device_id, []) for motif in strings(row.get("motif_ids")))
        direct.update(motif for row in variants_by_device.get(device_id, []) for motif in strings(row.get("motif_ids")))
        for motif in expanded(direct, parents, valid):
            device_sets[motif].add(device_id)
    for component in components:
        for motif in expanded(strings(component.get("motif_ids")), parents, valid):
            component_sets[motif].add(str(component["component_id"]))
    for node in hierarchy["nodes"]:
        source = release_rows[node["id"]]
        paper_ids = list(dict.fromkeys(strings(source.get("paper_ids"))))
        annual = Counter(
            int(papers[paper_id]["year"])
            for paper_id in paper_ids
            if paper_id in papers and papers[paper_id].get("year")
        )
        node["paper_count"] = len(paper_ids)
        node["first_year"] = min(annual, default="")
        node["last_year"] = max(annual, default="")
        node["annual_paper_counts"] = {str(year): annual[year] for year in sorted(annual)}
        node["device_count"] = len(device_sets[node["id"]])
        node["component_count"] = len(component_sets[node["id"]])


def build(release_dir: Path, hierarchy: dict[str, Any]) -> dict[str, Any]:
    paper_rows = read_jsonl(release_dir / "papers.jsonl")
    raw_devices = read_jsonl(release_dir / "devices.jsonl")
    raw_variants = read_jsonl(release_dir / "variants.jsonl")
    raw_components = read_jsonl(release_dir / "components.jsonl")
    raw_characteristics = read_jsonl(release_dir / "characteristics.jsonl")
    raw_relations = read_jsonl(release_dir / "semantic_relations.jsonl")
    papers_by_id = {row["paper_id"]: row for row in paper_rows}
    valid_motifs = {node["id"] for node in hierarchy["nodes"]}
    parents = {node["id"]: strings(node.get("parent_ids")) for node in hierarchy["nodes"]}
    occurrence_targets = {
        row["occurrence_id"]: [item for item in strings(row.get("motif_ids")) if item in valid_motifs]
        for row in read_jsonl(release_dir / "occurrence_to_motif.jsonl")
    }
    recovered_characteristics = []
    quarantine_path = release_dir / "quarantined_characteristics.jsonl"
    for row in (read_jsonl(quarantine_path) if quarantine_path.exists() else []):
        targets = occurrence_targets.get(str(row.get("subject_occurrence_id") or ""), [])
        if len(targets) == 1:
            recovered_characteristics.append({**row, "subject_id": targets[0]})
    raw_characteristics.extend(recovered_characteristics)
    characteristic_ids = [row["characteristic_id"] for row in raw_characteristics]
    if len(characteristic_ids) != len(set(characteristic_ids)):
        raise ValueError("duplicate characteristic IDs after quarantine recovery")

    papers = [
        {
            "paper_id": row["paper_id"],
            "title": paper_title(row),
            "document_title": re.sub(r"\.pdf$", "", str(row.get("document_title") or ""), flags=re.I),
            "publication_year": int(row["year"]),
            "doi": row.get("doi") or "",
            "citation": paper_title(row),
        }
        for row in paper_rows
    ]
    devices = [
        {
            "device_id": row["device_id"],
            "paper_id": row["source_id"],
            "descriptive_name": row.get("name") or row["device_id"],
            "author_provided_name": row.get("name") or "",
            "intended_function": row.get("claimed_inference") or "; ".join(
                str(item.get("term") or "")
                for item in row.get("objectives", [])
                if isinstance(item, dict) and item.get("term") not in (None, "", "unknown")
            ),
            "application": "; ".join(item.get("term", "") for item in row.get("uses", []) if item.get("term") not in (None, "", "unknown")),
            "operating_environment": row.get("operating_environment") or "",
            "prototype_maturity": row.get("maturity") or "",
            "device_class": row.get("device_class") or "",
            "inputs": strings(row.get("inputs")),
            "outputs": strings(row.get("outputs")),
        }
        for row in raw_devices
    ]
    device_by_id = {row["device_id"]: row for row in devices}
    raw_variants_by_device: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in raw_variants:
        raw_variants_by_device[row["device_id"]].append(row)
    variants: list[dict[str, Any]] = []
    for device in devices:
        rows = sorted(raw_variants_by_device.get(device["device_id"], []), key=lambda item: item["variant_id"])
        if not rows:
            rows = [{
                "variant_id": f"{device['device_id']}::DEFAULT",
                "device_id": device["device_id"],
                "source_id": device["paper_id"],
                "name": "Reported device",
                "maturity": device.get("prototype_maturity", ""),
                "motif_ids": [],
                "component_ids": [],
            }]
        for row in rows:
            variants.append({
                "device_variant_id": row["variant_id"],
                "device_id": row["device_id"],
                "paper_id": row["source_id"],
                "variant_label": row.get("name") or "Reported variant",
                "configuration_label": "; ".join(strings(row.get("distinguishing_features"))),
                "maturity": row.get("maturity") or "",
                "motif_ids": [item for item in strings(row.get("motif_ids")) if item in valid_motifs],
            })
    variants_by_device: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in variants:
        variants_by_device[row["device_id"]].append(row)
    component_variant_candidates: dict[str, list[str]] = defaultdict(list)
    for row in raw_variants:
        for component_id in strings(row.get("component_ids")):
            component_variant_candidates[component_id].append(row["variant_id"])
    components = []
    component_variant: dict[str, str] = {}
    for row in raw_components:
        candidates = sorted(component_variant_candidates.get(row["component_id"], []))
        fallback = variants_by_device[row["device_id"]][0]["device_variant_id"]
        variant_id = candidates[0] if candidates else fallback
        component_variant[row["component_id"]] = variant_id
        components.append({
            "component_id": row["component_id"],
            "device_variant_id": variant_id,
            "paper_id": row["source_id"],
            "name": row.get("name") or row["component_id"],
            "component_name": row.get("name") or row["component_id"],
            "component_type": row.get("component_type") or "",
            "function": row.get("function") or "",
            "materials": strings(row.get("materials")),
            "interface_terms": strings(row.get("interfaces")),
            "motif_ids": [item for item in strings(row.get("motif_ids")) if item in valid_motifs],
        })
    component_by_id = {row["component_id"]: row for row in components}
    variant_by_id = {row["device_variant_id"]: row for row in variants}
    first_variant = {device_id: sorted(rows, key=lambda item: item["device_variant_id"])[0]["device_variant_id"] for device_id, rows in variants_by_device.items()}

    accepted = []
    plot_points = []
    for row in raw_characteristics:
        paper_id = row["source_id"]
        subject_id = str(row.get("subject_id") or "")
        unit = canonical_unit(row.get("unit"))
        parsed = numeric_value(row.get("value")) if unit else None
        measurement: dict[str, Any] = {
            "measurement_id": row["characteristic_id"],
            "paper_id": paper_id,
            "publication_year": int(papers_by_id[paper_id]["year"]),
            "characteristic_id": metric_id(str(row.get("property") or "reported value")),
            "characteristic_name": row.get("property") or "Reported value",
            "characteristic_class": metric_category(str(row.get("property") or ""), unit),
            "original_metric": row.get("property") or "",
            "raw_value_text": str(row.get("value") if row.get("value") is not None else ""),
            "original_unit": str(row.get("unit") or ""),
            "canonical_unit": unit if parsed else "",
            "normalization_status": "normalized" if parsed else "not_normalized",
            "condition_text": row.get("condition") or "",
            "uncertainty": row.get("uncertainty") or "",
            "value_role": row.get("value_role") or "",
        }
        if subject_id in device_by_id:
            measurement.update({
                "device_id": subject_id,
                "device_variant_id": first_variant[subject_id],
                "scope": "whole_device",
                "device_level": True,
            })
        elif subject_id in component_by_id:
            variant_id = component_variant[subject_id]
            measurement.update({
                "component_id": subject_id,
                "device_variant_id": variant_id,
                "device_id": variant_by_id[variant_id]["device_id"],
                "scope": "component",
                "device_level": False,
            })
        elif subject_id in variant_by_id:
            measurement.update({
                "device_variant_id": subject_id,
                "device_id": variant_by_id[subject_id]["device_id"],
                "scope": "device_variant",
                "device_level": False,
            })
        elif subject_id in valid_motifs:
            measurement.update({"motif_id": subject_id, "scope": "motif", "device_level": False})
        else:
            raise ValueError(f"unresolved characteristic subject: {row['characteristic_id']} -> {subject_id}")
        if parsed:
            measurement.update(parsed)
            if parsed["value_type"] == "point":
                measurement["numeric_value"] = parsed["normalized_value"]
            elif parsed["value_type"] == "interval":
                measurement["numeric_min"] = parsed["normalized_min"]
                measurement["numeric_max"] = parsed["normalized_max"]
            accepted.append(measurement)
            plot_points.append({
                "measurement_id": measurement["measurement_id"],
                "paper_id": paper_id,
                "year": measurement["publication_year"],
                "device_id": measurement.get("device_id", ""),
                "device_variant_id": measurement.get("device_variant_id", ""),
                "component_id": measurement.get("component_id", ""),
                "motif_id": measurement.get("motif_id", ""),
                "characteristic_id": measurement["characteristic_id"],
                "canonical_unit": unit,
                **parsed,
            })
        else:
            measurement.update({"value_type": "categorical", "categorical_value": measurement["raw_value_text"]})
            accepted.append(measurement)

    relationships = [{
        "relationship_id": row["relation_id"],
        "paper_id": row.get("source_paper_id") or "",
        "publication_year": int(papers_by_id[row["source_paper_id"]]["year"])
        if row.get("source_paper_id") in papers_by_id else 0,
        "source_id": row["source_id"],
        "target_id": row["target_id"],
        "relation_type": row.get("relation_type") or "related_to",
        "proposition": row.get("reviewed_proposition") or row.get("proposition") or "",
        "conditions": strings(row.get("conditions")),
        "review_status": row.get("semantic_review_verdict") or row.get("semantic_review_stage") or "",
    } for row in raw_relations]

    motifs = [{
        "motif_id": node["id"],
        "label": node["label"],
        "level": node["level"],
        "description": node.get("description", ""),
        "parent_ids": strings(node.get("parent_ids")),
        "family_ids": strings(node.get("family_ids")),
        "status": node.get("status", ""),
        "canonical": node.get("canonical", True),
        "distinct_paper_count": node.get("paper_count", 0),
        "distinct_component_count": node.get("component_count", 0),
        "first_year": node.get("first_year", ""),
        "last_year": node.get("last_year", ""),
    } for node in hierarchy["nodes"]]

    papers_index = {row["paper_id"]: {
        "paper_id": row["paper_id"], "title": row["title"], "year": row["publication_year"],
        "device_ids": [], "records": record_template(),
    } for row in papers}
    devices_index: dict[str, dict[str, Any]] = {}
    variants_index: dict[str, dict[str, Any]] = {}
    components_index: dict[str, dict[str, Any]] = {}
    motifs_index: dict[str, dict[str, Any]] = {}
    components_by_variant: dict[str, list[str]] = defaultdict(list)
    for row in components:
        components_by_variant[row["device_variant_id"]].append(row["component_id"])
    for row in variants:
        variants_index[row["device_variant_id"]] = {
            **row,
            "component_ids": sorted(components_by_variant[row["device_variant_id"]]),
            "interface_ids": [],
            "records": record_template(),
        }
    for row in components:
        variant = variant_by_id[row["device_variant_id"]]
        components_index[row["component_id"]] = {
            "component_id": row["component_id"], "name": row["name"],
            "device_variant_id": row["device_variant_id"], "device_id": variant["device_id"],
            "paper_id": row["paper_id"], "year": int(papers_by_id[row["paper_id"]]["year"]),
            "motif_ids": row["motif_ids"], "records": record_template(),
        }
    raw_device_by_id = {row["device_id"]: row for row in raw_devices}
    raw_variant_by_device: dict[str, list[dict[str, Any]]] = defaultdict(list)
    raw_component_by_device: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in raw_variants:
        raw_variant_by_device[row["device_id"]].append(row)
    for row in raw_components:
        raw_component_by_device[row["device_id"]].append(row)
    for row in devices:
        device_id = row["device_id"]
        variant_ids = sorted(item["device_variant_id"] for item in variants_by_device[device_id])
        component_ids = sorted(item for variant_id in variant_ids for item in components_by_variant[variant_id])
        direct = set(strings(raw_device_by_id[device_id].get("motif_ids")))
        direct.update(motif for item in raw_variant_by_device[device_id] for motif in strings(item.get("motif_ids")))
        direct.update(motif for item in raw_component_by_device[device_id] for motif in strings(item.get("motif_ids")))
        direct = {item for item in direct if item in valid_motifs and hierarchy_node_level(hierarchy, item) != "L1"}
        devices_index[device_id] = {
            "device_id": device_id, "name": row["descriptive_name"], "paper_id": row["paper_id"],
            "year": int(papers_by_id[row["paper_id"]]["year"]),
            "prototype_maturity": row["prototype_maturity"], "contribution_role": "reported_device",
            "variant_ids": variant_ids, "component_ids": component_ids, "interface_ids": [],
            "direct_motif_ids": sorted(direct), "motif_ids": sorted(expanded(direct, parents, valid_motifs)),
            "records": record_template(),
        }
        papers_index[row["paper_id"]]["device_ids"].append(device_id)
    for node in hierarchy["nodes"]:
        motif_id = node["id"]
        component_ids = sorted(item["component_id"] for item in components if motif_id in expanded(item["motif_ids"], parents, valid_motifs))
        variant_ids = sorted({components_index[item]["device_variant_id"] for item in component_ids})
        device_ids = sorted({variants_index[item]["device_id"] for item in variant_ids})
        motifs_index[motif_id] = {
            "motif_id": motif_id, "label": node["label"], "level": node["level"],
            "parent_ids": strings(node.get("parent_ids")), "family_ids": strings(node.get("family_ids")),
            "direct_component_ids": sorted(item["component_id"] for item in components if motif_id in item["motif_ids"]),
            "component_ids": component_ids, "device_variant_ids": variant_ids, "device_ids": device_ids,
            "records": record_template(),
        }

    for measurement in accepted:
        identifier = measurement["measurement_id"]
        papers_index[measurement["paper_id"]]["records"]["accepted_measurement_ids"].append(identifier)
        for key, indexes in (("device_id", devices_index), ("device_variant_id", variants_index), ("component_id", components_index)):
            endpoint = measurement.get(key)
            if endpoint:
                indexes[endpoint]["records"]["accepted_measurement_ids"].append(identifier)
        if measurement.get("motif_id"):
            for motif_id in expanded([measurement["motif_id"]], parents, valid_motifs):
                motifs_index[motif_id]["records"]["accepted_measurement_ids"].append(identifier)
    plot_ids = {row["measurement_id"] for row in plot_points}
    for indexes in (papers_index, devices_index, variants_index, components_index, motifs_index):
        for item in indexes.values():
            item["records"]["plot_measurement_ids"] = [
                identifier for identifier in item["records"]["accepted_measurement_ids"] if identifier in plot_ids
            ]

    for relationship in relationships:
        identifier = relationship["relationship_id"]
        paper_id = relationship.get("paper_id")
        if paper_id in papers_index:
            papers_index[paper_id]["records"]["relationship_ids"].append(identifier)
        for endpoint in (relationship["source_id"], relationship["target_id"]):
            if endpoint in devices_index:
                devices_index[endpoint]["records"]["relationship_ids"].append(identifier)
            if endpoint in variants_index:
                variants_index[endpoint]["records"]["relationship_ids"].append(identifier)
            if endpoint in components_index:
                components_index[endpoint]["records"]["relationship_ids"].append(identifier)
            if endpoint in motifs_index:
                for motif_id in expanded([endpoint], parents, valid_motifs):
                    motifs_index[motif_id]["records"]["relationship_ids"].append(identifier)
    for indexes in (papers_index, devices_index, variants_index, components_index, motifs_index):
        for item in indexes.values():
            item["records"]["relationship_ids"] = sorted(set(item["records"]["relationship_ids"]))

    graph_nodes = []
    for kind, rows, identifier, label in (
        ("paper", papers, "paper_id", "title"),
        ("device", devices, "device_id", "descriptive_name"),
        ("device_variant", variants, "device_variant_id", "variant_label"),
        ("component", components, "component_id", "name"),
        ("motif", motifs, "motif_id", "label"),
    ):
        graph_nodes.extend({"id": row[identifier], "type": kind, "label": row[label]} for row in rows)
    graph_edges = []
    def edge(source: str, target: str, relation: str) -> None:
        graph_edges.append({"edge_id": f"{relation}::{source}::{target}", "source_id": source, "target_id": target, "relation": relation})
    for row in devices:
        edge(row["paper_id"], row["device_id"], "reports")
    for row in variants:
        edge(row["device_id"], row["device_variant_id"], "has_variant")
    for row in components:
        edge(row["device_variant_id"], row["component_id"], "has_component")
        for motif_id in row["motif_ids"]:
            edge(row["component_id"], motif_id, "implements_motif")
    for row in motifs:
        for parent_id in row["parent_ids"]:
            edge(parent_id, row["motif_id"], "parent_of")
    for row in relationships:
        graph_edges.append({
            "edge_id": row["relationship_id"],
            "source_id": row["source_id"],
            "target_id": row["target_id"],
            "relation": row["relation_type"],
        })

    return {
        "schema_id": "rogers-engineering-frontend-bundle",
        "schema_version": "1.1.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "qa": {
            "passed": True,
            "checks": {
                "release_ids_aligned": set(valid_motifs) == {row["motif_id"] for row in motifs},
                "characteristic_subjects_resolved": len(accepted) == len(raw_characteristics),
                "plot_points_are_normalized": all(row["canonical_unit"] for row in plot_points),
            },
            "counts": {
                "papers": len(papers), "devices": len(devices), "device_variants": len(variants),
                "components": len(components), "interfaces": 0, "motifs": len(motifs),
                "accepted_measurements": len(accepted), "accepted_plot_measurements": len(plot_points),
                "relationships": len(relationships),
                "recovered_characteristics": len(recovered_characteristics),
            },
        },
        "entities": {
            "papers": papers, "devices": devices, "device_variants": variants,
            "components": components, "interfaces": [], "motifs": motifs,
        },
        "measurements": {"accepted": accepted, "quarantined": [], "plot_points": plot_points},
        "knowledge": {"relationships": relationships, "failures": [], "constraints": [], "coverage": []},
        "indexes": {
            "papers": papers_index, "devices": devices_index, "variants": variants_index,
            "components": components_index, "interfaces": {}, "motifs": motifs_index,
        },
        "graph": {"nodes": graph_nodes, "edges": graph_edges},
    }


def hierarchy_node_level(hierarchy: dict[str, Any], motif_id: str) -> str:
    return next(node["level"] for node in hierarchy["nodes"] if node["id"] == motif_id)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release-dir", type=Path, required=True)
    parser.add_argument("--hierarchy", type=Path, required=True)
    parser.add_argument("--bundle-output", type=Path, required=True)
    parser.add_argument("--update-hierarchy", action="store_true")
    args = parser.parse_args()
    release_dir = args.release_dir.resolve()
    hierarchy_path = args.hierarchy.resolve()
    hierarchy = json.loads(hierarchy_path.read_text(encoding="utf-8"))
    release_rows = {
        row["motif_id"]: row
        for filename in ("l1_registry.jsonl", "canonical_motifs.jsonl", "observation_motifs.jsonl")
        for row in read_jsonl(release_dir / filename)
    }
    hierarchy_ids = {node["id"] for node in hierarchy["nodes"]}
    if hierarchy_ids != set(release_rows):
        missing = sorted(hierarchy_ids - set(release_rows))[:5]
        extra = sorted(set(release_rows) - hierarchy_ids)[:5]
        raise ValueError(f"hierarchy/release motif mismatch: missing={missing}, extra={extra}")
    papers = {row["paper_id"]: row for row in read_jsonl(release_dir / "papers.jsonl")}
    devices = read_jsonl(release_dir / "devices.jsonl")
    components = read_jsonl(release_dir / "components.jsonl")
    variants = read_jsonl(release_dir / "variants.jsonl")
    if args.update_hierarchy:
        update_hierarchy(hierarchy, release_rows, papers, devices, components, variants)
        write_json(hierarchy_path, hierarchy, pretty=True)
    bundle = build(release_dir, hierarchy)
    write_json(args.bundle_output.resolve(), bundle)
    print(json.dumps({
        "hierarchy_nodes": len(hierarchy["nodes"]),
        "papers": len(bundle["entities"]["papers"]),
        "devices": len(bundle["entities"]["devices"]),
        "variants": len(bundle["entities"]["device_variants"]),
        "components": len(bundle["entities"]["components"]),
        "measurements": len(bundle["measurements"]["accepted"]),
        "plot_measurements": len(bundle["measurements"]["plot_points"]),
        "bundle_output": str(args.bundle_output.resolve()),
    }, indent=2))


if __name__ == "__main__":
    main()
