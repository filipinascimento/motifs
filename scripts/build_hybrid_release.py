#!/usr/bin/env python3
"""Build the reviewed hierarchy-v2 atlas with the complete engineering corpus.

The August hierarchy release is authoritative for recurrent L1/L2/L3 motifs
and device-to-motif extraction.  The protocol-repair engineering bundle is
authoritative for papers, device records, variants, components, interfaces,
and normalized measurements.  This adapter joins those two reviewed products
without promoting single-paper observations into the recurrent registry.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import importlib.util
import json
import re
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from itertools import combinations
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[3]
DEFAULT_RELEASE = ROOT / "runs/rogers_hierarchical_motifs/20260812T210324Z_evidence_v2/postprocessing/reviewed_release_candidate.hierarchy_v2_20260818T201000Z"
DEFAULT_ENGINEERING = ROOT / "runs/rogers_hierarchical_motifs/20260730T_protocol_repair_v1/public_exports/frontend_engineering_bundle.json"
GENERIC_BUILDER = ROOT / "test_wound_voc/hierarchical_motif_knowledge_base/scripts/build_engineering_frontend_bundle.py"


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def strings(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return list(dict.fromkeys(str(item) for item in value if item not in (None, "")))


def normalized(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").casefold()).strip()


def name_score(left: str, right: str) -> float:
    a, b = normalized(left), normalized(right)
    if not a or not b:
        return 0.0
    at, bt = set(a.split()), set(b.split())
    jaccard = len(at & bt) / max(1, len(at | bt))
    return 0.65 * SequenceMatcher(None, a, b).ratio() + 0.35 * jaccard


def old_device_label(row: dict[str, Any]) -> str:
    return str(row.get("author_provided_name") or row.get("descriptive_name") or row.get("device_id") or "")


def sha1(*values: Any) -> str:
    return hashlib.sha1("\x1f".join(map(str, values)).encode()).hexdigest()[:16]


def load_builder():
    spec = importlib.util.spec_from_file_location("engineering_bundle_builder", GENERIC_BUILDER)
    if not spec or not spec.loader:
        raise RuntimeError(f"Could not load {GENERIC_BUILDER}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def structural_validation(papers, devices, variants, components, interfaces, motifs) -> None:
    errors: list[str] = []
    for device_id, row in devices.items():
        if str(row.get("paper_id") or "") not in papers:
            errors.append(f"device {device_id}: unknown paper")
    variant_counts = Counter()
    for variant_id, row in variants.items():
        device_id, paper_id = str(row.get("device_id") or ""), str(row.get("paper_id") or "")
        if device_id not in devices or str(devices.get(device_id, {}).get("paper_id") or "") != paper_id:
            errors.append(f"variant {variant_id}: invalid paper/device")
        variant_counts[device_id] += 1
    for device_id in devices:
        if not variant_counts[device_id]:
            errors.append(f"device {device_id}: no variant")
    for component_id, row in components.items():
        variant_id, paper_id = str(row.get("device_variant_id") or ""), str(row.get("paper_id") or "")
        if variant_id not in variants or str(variants.get(variant_id, {}).get("paper_id") or "") != paper_id:
            errors.append(f"component {component_id}: invalid paper/variant")
        if any(motif_id not in motifs for motif_id in strings(row.get("motif_ids"))):
            errors.append(f"component {component_id}: unknown motif")
    for interface_id, row in interfaces.items():
        variant_id = str(row.get("device_variant_id") or "")
        source, target = str(row.get("source_component_id") or ""), str(row.get("target_component_id") or "")
        if variant_id not in variants or source not in components or target not in components or source == target:
            errors.append(f"interface {interface_id}: invalid endpoints")
    if errors:
        raise ValueError("structural validation failed:\n- " + "\n- ".join(errors[:100]))


def release_registry(release: Path, paper_years: dict[str, int]):
    l1_rows = read_jsonl(release / "l1_registry.jsonl")
    recurrent = read_jsonl(release / "canonical_motifs.jsonl")
    observations = read_jsonl(release / "observation_motifs.jsonl")
    examples = read_jsonl(release / "motif_examples.jsonl")
    l1_by_name = {row["name"]: row for row in l1_rows}
    observation_by_id = {row["motif_id"]: row for row in observations}
    examples_by_motif: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for example in examples:
        for motif_id in strings(example.get("motif_ids")):
            examples_by_motif[motif_id].append(example)

    nodes: list[dict[str, Any]] = []
    source_rows: dict[str, dict[str, Any]] = {}
    for row in l1_rows + recurrent:
        motif_id, level = row["motif_id"], row["level"]
        if level == "L1":
            parents, families = [], [motif_id]
            description = str(row.get("scope_definition") or "")
            status = "controlled_family"
        else:
            l1_id = l1_by_name[str(row["l1_family"])]["motif_id"]
            parents = [l1_id] if level == "L2" else [str(row["parent_l2_id"])]
            families = [l1_id]
            description = str(row.get("reusable_proposition") or row.get("function") or "")
            status = "canonical_recurrent"
        paper_ids = strings(row.get("paper_ids"))
        years = sorted(paper_years[item] for item in paper_ids if item in paper_years)
        annual = Counter(years)
        node = {
            "id": motif_id,
            "label": str(row.get("name") or motif_id),
            "level": level,
            "status": status,
            "canonical": True,
            "description": description,
            "function": str(row.get("function") or ""),
            "mechanism": str(row.get("mechanism") or ""),
            "aliases": strings(row.get("aliases")),
            "motif_type": str(row.get("motif_type") or "family"),
            "parent_ids": parents,
            "family_ids": families,
            "paper_count": len(set(paper_ids)),
            "annual_paper_counts": {str(year): annual[year] for year in sorted(annual)},
            "first_year": min(years, default=""),
            "last_year": max(years, default=""),
            "device_count": 0,
            "component_count": 0,
            "design_handles": strings(row.get("design_handles"))[:12],
            "failure_modes": strings(row.get("failure_modes"))[:12],
        }
        nodes.append(node)
        source_rows[motif_id] = row

    valid = {node["id"] for node in nodes}
    obs_public: list[dict[str, Any]] = []
    for row in observations:
        parent = str(row.get("parent_l2_id") or "")
        if parent not in valid:
            continue
        motif_examples = examples_by_motif.get(row["motif_id"], [])
        example = motif_examples[0] if motif_examples else {}
        years = sorted({int(item.get("source_year")) for item in motif_examples if item.get("source_year")})
        obs_public.append({
            "id": row["motif_id"],
            "label": str(row.get("name") or row["motif_id"]),
            "level": "L3 example",
            "year": min(years, default=""),
            "review_status": "reviewed",
            "registry_status": "single_source_observation",
            "confidence": "source-grounded",
            "decision": "folded_into_recurrent_parent",
            "exclusion_reason": "Single-paper implementation; retained as an example rather than a recurrent motif.",
            "rationale": str(example.get("paper_local_proposition") or row.get("reusable_proposition") or ""),
            "parent_ids": [parent],
            "family_ids": strings(next(node["family_ids"] for node in nodes if node["id"] == parent)),
            "related_node_id": parent,
            "anchor_ids": [parent],
        })
    return nodes, source_rows, observation_by_id, obs_public


def resolve_map(release: Path, valid: set[str], observations: dict[str, dict[str, Any]]) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for row in read_jsonl(release / "baseline_to_v2_crosswalk.jsonl"):
        targets: list[str] = []
        for target in strings(row.get("new_ids")):
            if target in valid:
                targets.append(target)
            elif target in observations and observations[target].get("parent_l2_id") in valid:
                targets.append(str(observations[target]["parent_l2_id"]))
        result[str(row["old_id"])] = list(dict.fromkeys(targets))
    return result


def resolve_ids(values: Iterable[str], mapping: dict[str, list[str]], valid: set[str], observations: dict[str, dict[str, Any]]) -> list[str]:
    resolved: list[str] = []
    for value in values:
        if value in valid:
            resolved.append(value)
        elif value in observations and observations[value].get("parent_l2_id") in valid:
            resolved.append(str(observations[value]["parent_l2_id"]))
        else:
            resolved.extend(mapping.get(value, []))
    return list(dict.fromkeys(item for item in resolved if item in valid))


def match_devices(old_devices: list[dict[str, Any]], new_devices: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    old_by_paper: dict[str, list[dict[str, Any]]] = defaultdict(list)
    new_by_paper: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in old_devices:
        old_by_paper[str(row["paper_id"])].append(row)
    for row in new_devices:
        new_by_paper[str(row["source_id"])].append(row)
    matches: dict[str, dict[str, Any]] = {}
    scores: list[float] = []
    for paper_id, old_rows in old_by_paper.items():
        new_rows = new_by_paper.get(paper_id, [])
        if not new_rows:
            continue
        if len(old_rows) == len(new_rows) == 1:
            matches[old_rows[0]["device_id"]] = new_rows[0]
            scores.append(1.0)
            continue
        candidates = sorted(
            ((name_score(old_device_label(old), str(new.get("name") or "")), old, new)
             for old in old_rows for new in new_rows),
            key=lambda item: (-item[0], str(item[1]["device_id"]), str(item[2]["device_id"])),
        )
        used_old, used_new = set(), set()
        for score, old, new in candidates:
            if old["device_id"] in used_old or new["device_id"] in used_new:
                continue
            matches[old["device_id"]] = new
            used_old.add(old["device_id"])
            used_new.add(new["device_id"])
            scores.append(score)
    return matches, {
        "matched_old_devices": len(matches),
        "old_devices": len(old_devices),
        "new_devices": len(new_devices),
        "mean_name_similarity": round(sum(scores) / max(1, len(scores)), 4),
    }


def remap_record(row: dict[str, Any], mapping, valid, observations) -> dict[str, Any]:
    result = copy.deepcopy(row)
    old_ids = strings(result.get("motif_ids"))
    if result.get("motif_id"):
        old_ids.append(str(result["motif_id"]))
    mapped = resolve_ids(old_ids, mapping, valid, observations)
    if mapped:
        result["motif_ids"] = mapped
        if len(mapped) == 1:
            result["motif_id"] = mapped[0]
        else:
            result.pop("motif_id", None)
    else:
        result.pop("motif_id", None)
        result.pop("motif_ids", None)
    return result


def ancestry(nodes: list[dict[str, Any]]) -> tuple[dict[str, list[str]], dict[str, set[str]]]:
    parents = {node["id"]: strings(node.get("parent_ids")) for node in nodes}
    expanded: dict[str, set[str]] = {}
    for motif_id in parents:
        values, frontier = {motif_id}, [motif_id]
        while frontier:
            for parent in parents.get(frontier.pop(), []):
                if parent not in values:
                    values.add(parent)
                    frontier.append(parent)
        expanded[motif_id] = values
    return parents, expanded


def enrich_projection(bundle: dict[str, Any], nodes: list[dict[str, Any]]) -> None:
    valid = {node["id"] for node in nodes}
    parents, expanded = ancestry(nodes)
    motif_entity = {row["motif_id"]: row for row in bundle["entities"]["motifs"]}
    variants = {row["device_variant_id"]: row for row in bundle["entities"]["device_variants"]}
    components = {row["component_id"]: row for row in bundle["entities"]["components"]}
    devices = {row["device_id"]: row for row in bundle["entities"]["devices"]}
    variants_by_device: dict[str, list[str]] = defaultdict(list)
    components_by_variant: dict[str, list[str]] = defaultdict(list)
    for variant in variants.values():
        variants_by_device[variant["device_id"]].append(variant["device_variant_id"])
    for component in components.values():
        components_by_variant[component["device_variant_id"]].append(component["component_id"])

    direct_by_variant: dict[str, set[str]] = {}
    expanded_by_variant: dict[str, set[str]] = {}
    for variant_id, variant in variants.items():
        direct = set(strings(variant.get("motif_ids")))
        direct.update(motif for component_id in components_by_variant[variant_id] for motif in strings(components[component_id].get("motif_ids")))
        direct &= valid
        direct_by_variant[variant_id] = direct
        expanded_by_variant[variant_id] = set().union(*(expanded[item] for item in direct)) if direct else set()
        index = bundle["indexes"]["variants"][variant_id]
        index["direct_motif_ids"] = sorted(direct)
        index["motif_ids"] = sorted(expanded_by_variant[variant_id])

    for device_id, index in bundle["indexes"]["devices"].items():
        direct = set().union(*(direct_by_variant[item] for item in variants_by_device[device_id]))
        index["direct_motif_ids"] = sorted(direct)
        index["motif_ids"] = sorted(set().union(*(expanded[item] for item in direct)) if direct else set())
        index["unresolved_motif_ids"] = []

    years_by_variant = {variant_id: int(index["year"]) for variant_id, index in bundle["indexes"]["variants"].items()}
    for motif_id, index in bundle["indexes"]["motifs"].items():
        variant_ids = sorted(item for item, motifs in expanded_by_variant.items() if motif_id in motifs)
        direct_variant_ids = sorted(item for item, motifs in direct_by_variant.items() if motif_id in motifs)
        component_ids = sorted(
            component_id for component_id, component in components.items()
            if motif_id in set().union(*(
                expanded[item] for item in strings(component.get("motif_ids")) if item in expanded
            ))
        )
        index["direct_device_variant_ids"] = direct_variant_ids
        index["device_variant_ids"] = variant_ids
        index["device_ids"] = sorted({variants[item]["device_id"] for item in variant_ids})
        index["component_ids"] = component_ids
        index["direct_component_ids"] = sorted(component_id for component_id, component in components.items() if motif_id in strings(component.get("motif_ids")))
        annual_variants = Counter(years_by_variant[item] for item in variant_ids)
        annual_papers: dict[int, set[str]] = defaultdict(set)
        for variant_id in variant_ids:
            annual_papers[years_by_variant[variant_id]].add(variants[variant_id]["paper_id"])
        index["activity_by_year"] = [
            {"year": year, "paper_count": len(annual_papers[year]), "device_count": annual_variants[year]}
            for year in sorted(annual_variants)
        ]
        motif_entity[motif_id]["distinct_component_count"] = len(component_ids)

    graph = bundle["graph"]
    existing = {edge["edge_id"] for edge in graph["edges"]}
    for variant_id, motif_ids in direct_by_variant.items():
        for motif_id in sorted(motif_ids):
            edge_id = f"implements_motif::{variant_id}::{motif_id}"
            if edge_id not in existing:
                graph["edges"].append({"edge_id": edge_id, "source_id": variant_id, "target_id": motif_id, "relation": "implements_motif"})
                existing.add(edge_id)
    graph["edges"].sort(key=lambda row: row["edge_id"])

    device_sets = {motif_id: set(index["device_ids"]) for motif_id, index in bundle["indexes"]["motifs"].items()}
    component_sets = {motif_id: set(index["component_ids"]) for motif_id, index in bundle["indexes"]["motifs"].items()}
    for node in nodes:
        node["device_count"] = len(device_sets[node["id"]])
        node["component_count"] = len(component_sets[node["id"]])


def hierarchy_edges(release: Path, nodes: list[dict[str, Any]], observations: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    valid = {node["id"] for node in nodes}
    edges: list[dict[str, Any]] = []
    for node in nodes:
        for parent in strings(node.get("parent_ids")):
            edges.append({"id": f"E-parent-{sha1(parent, node['id'])}", "source": parent, "target": node["id"], "type": "parent_of", "group": "parent_of", "directed": True, "weight": 1})
    aggregate: dict[tuple[str, str], dict[str, Any]] = {}
    for row in read_jsonl(release / "observed_couse_default_weight_ge_2.jsonl"):
        resolved = []
        for endpoint in (str(row["source_id"]), str(row["target_id"])):
            if endpoint in observations:
                endpoint = str(observations[endpoint].get("parent_l2_id") or "")
            resolved.append(endpoint)
        source, target = sorted(resolved)
        if source not in valid or target not in valid or source == target:
            continue
        key = source, target
        item = aggregate.setdefault(key, {"paper_count": 0, "device_count": 0})
        item["paper_count"] += int(row.get("distinct_paper_count") or 0)
        item["device_count"] += int(row.get("distinct_device_count") or 0)
    for (source, target), counts in sorted(aggregate.items()):
        if counts["paper_count"] < 2:
            continue
        edges.append({
            "id": f"E-used-with-{sha1(source, target)}", "source": source, "target": target,
            "type": "used_with", "group": "used_with", "directed": False,
            "weight": counts["paper_count"], "paper_count": counts["paper_count"], "device_count": counts["device_count"],
        })
    return edges


def l2_device_rollup_edges(
    devices: list[dict[str, Any]],
    nodes: list[dict[str, Any]],
    release_rows: dict[str, dict[str, Any]],
    observations: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """Roll device motif compositions up to recurrent L2 co-use.

    Each extracted device contributes at most once to an L2 pair and each paper
    contributes at most once to its published edge weight.  This preserves the
    direct L3 co-use layer while exposing the hierarchy-aware L2 projection.
    """
    level_by_id = {node["id"]: node["level"] for node in nodes}
    support: dict[tuple[str, str], dict[str, set[Any]]] = defaultdict(
        lambda: {"papers": set(), "devices": set(), "years": set()}
    )

    for device in devices:
        l2_ids: set[str] = set()
        for motif_id in strings(device.get("motif_ids")):
            row = release_rows.get(motif_id) or observations.get(motif_id) or {}
            if level_by_id.get(motif_id) == "L2":
                l2_ids.add(motif_id)
            else:
                parent = str(row.get("parent_l2_id") or "")
                if level_by_id.get(parent) == "L2":
                    l2_ids.add(parent)
        for source, target in combinations(sorted(l2_ids), 2):
            item = support[(source, target)]
            item["papers"].add(str(device["source_id"]))
            item["devices"].add(str(device["device_id"]))
            if device.get("source_year"):
                item["years"].add(int(device["source_year"]))

    edges: list[dict[str, Any]] = []
    for (source, target), item in sorted(support.items()):
        paper_count = len(item["papers"])
        if paper_count < 2:
            continue
        years = sorted(item["years"])
        edges.append({
            "id": f"E-l2-device-rollup-{sha1(source, target)}",
            "source": source,
            "target": target,
            "type": "used_with_rollup",
            "group": "l2_co_use",
            "directed": False,
            "weight": paper_count,
            "paper_count": paper_count,
            "device_count": len(item["devices"]),
            "first_year": min(years, default=""),
            "last_year": max(years, default=""),
            "rollup_level": "L2",
            "support_unit": "distinct_papers",
            "evidence_basis": "same_extracted_device",
        })
    return edges


def validate_release(hierarchy: dict[str, Any], bundle: dict[str, Any]) -> None:
    nodes = hierarchy["nodes"]
    by_level = Counter(node["level"] for node in nodes)
    if not by_level["L1"] < by_level["L2"] < by_level["L3"]:
        raise ValueError(f"hierarchy count invariant failed: {dict(by_level)}")
    ids = {node["id"] for node in nodes}
    levels = {node["id"]: node["level"] for node in nodes}
    if len(ids) != len(nodes):
        raise ValueError("duplicate recurrent motif IDs")
    for node in nodes:
        if node["level"] == "L3" and (len(node["parent_ids"]) != 1 or levels.get(node["parent_ids"][0]) != "L2"):
            raise ValueError(f"L3 does not have exactly one L2 parent: {node['id']}")
        if len(node["label"].split()) > 8:
            raise ValueError(f"motif label is not generalized: {node['label']}")
    if any(edge["group"] == "used_with" and int(edge.get("paper_count") or 0) < 2 for edge in hierarchy["edges"]):
        raise ValueError("co-occurrence edge below default weight 2")
    l2_rollups = [edge for edge in hierarchy["edges"] if edge["group"] == "l2_co_use"]
    if any(
        int(edge.get("paper_count") or 0) < 2
        or levels.get(edge["source"]) != "L2"
        or levels.get(edge["target"]) != "L2"
        for edge in l2_rollups
    ):
        raise ValueError("invalid L2 device co-use roll-up")
    engineering_ids = {row["motif_id"] for row in bundle["entities"]["motifs"]}
    if ids != engineering_ids:
        raise ValueError("hierarchy/engineering motif registries differ")
    required = {"Power and Energy", "Electronics and Signal Conditioning", "Computing, Control, and Decision Support", "Communication and Data Transfer"}
    l1_labels = {node["label"] for node in nodes if node["level"] == "L1"}
    if not required <= l1_labels:
        raise ValueError("power/electronics/computing/communication families are not separated")


def build(args) -> None:
    old = json.loads(args.engineering.read_text(encoding="utf-8"))
    papers = copy.deepcopy(old["entities"]["papers"])
    paper_years = {row["paper_id"]: int(row.get("publication_year") or row.get("year")) for row in papers}
    nodes, release_rows, observations, public_observations = release_registry(args.release, paper_years)
    valid = {node["id"] for node in nodes}
    mapping = resolve_map(args.release, valid, observations)

    old_devices = copy.deepcopy(old["entities"]["devices"])
    new_devices = read_jsonl(args.release / "devices.jsonl")
    matches, match_qa = match_devices(old_devices, new_devices)
    paper_new_motifs: dict[str, list[str]] = defaultdict(list)
    for device in new_devices:
        paper_new_motifs[device["source_id"]].extend(resolve_ids(strings(device.get("motif_ids")), mapping, valid, observations))
    paper_new_motifs = {key: list(dict.fromkeys(value)) for key, value in paper_new_motifs.items()}

    variants = copy.deepcopy(old["entities"]["device_variants"])
    variants_by_device: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for variant in variants:
        variants_by_device[variant["device_id"]].append(variant)
    for device in old_devices:
        matched = matches.get(device["device_id"])
        motif_ids = resolve_ids(strings(matched.get("motif_ids")) if matched else [], mapping, valid, observations)
        if not motif_ids:
            motif_ids = paper_new_motifs.get(device["paper_id"], [])
        for variant in variants_by_device[device["device_id"]]:
            variant["motif_ids"] = motif_ids

    # A few recurrent motifs are supported by a paper occurrence but are not
    # present in the compact device compositions. Attach each such residual to
    # the closest named device in that same paper, never across papers.
    old_by_paper: dict[str, list[dict[str, Any]]] = defaultdict(list)
    new_by_paper: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for device in old_devices:
        old_by_paper[device["paper_id"]].append(device)
    for device in new_devices:
        new_by_paper[device["source_id"]].append(device)
    release_paper_motifs: dict[str, set[str]] = defaultdict(set)
    for motif_id, row in release_rows.items():
        if row["level"] in {"L2", "L3"}:
            for paper_id in strings(row.get("paper_ids")):
                release_paper_motifs[paper_id].add(motif_id)
    for paper_id, expected in release_paper_motifs.items():
        paper_variants = [variant for device in old_by_paper.get(paper_id, []) for variant in variants_by_device[device["device_id"]]]
        assigned = {motif for variant in paper_variants for motif in strings(variant.get("motif_ids"))}
        for motif_id in sorted(expected - assigned):
            candidate_new = [
                device for device in new_by_paper.get(paper_id, [])
                if motif_id in resolve_ids(strings(device.get("motif_ids")), mapping, valid, observations)
            ]
            candidate_old = old_by_paper.get(paper_id, [])
            if not candidate_old:
                continue
            if candidate_new:
                target = max(
                    candidate_old,
                    key=lambda old_device: max(name_score(old_device_label(old_device), str(new_device.get("name") or "")) for new_device in candidate_new),
                )
            else:
                target = candidate_old[0]
            for variant in variants_by_device[target["device_id"]]:
                variant["motif_ids"] = list(dict.fromkeys(strings(variant.get("motif_ids")) + [motif_id]))

    components = copy.deepcopy(old["entities"]["components"])
    for component in components:
        component["motif_ids"] = [item for item in resolve_ids(strings(component.get("motif_ids")), mapping, valid, observations) if item.startswith(("L2-", "L3-"))]
    interfaces = copy.deepcopy(old["entities"]["interfaces"])
    motif_rows = [{
        "motif_id": node["id"], "label": node["label"], "level": node["level"], "description": node["description"],
        "parent_ids": node["parent_ids"], "family_ids": node["family_ids"], "canonical": True,
        "distinct_paper_count": node["paper_count"], "distinct_component_count": 0,
        "first_year": node["first_year"], "last_year": node["last_year"],
    } for node in nodes]

    accepted = [remap_record(row, mapping, valid, observations) for row in old["measurements"]["accepted"]]
    quarantined = [remap_record(row, mapping, valid, observations) for row in old["measurements"]["quarantined"]]
    # Measurements remain anchored to their exact paper/device/variant/component.
    # Motif scope is derived from those implementation endpoints after the new
    # hierarchy projection, avoiding false precision when an old motif splits.
    for measurement in accepted + quarantined:
        measurement.pop("motif_id", None)
        measurement.pop("motif_ids", None)
    knowledge = {
        key: [remap_record(row, mapping, valid, observations) for row in old["knowledge"][key]]
        for key in ("relationships", "failures", "constraints", "coverage")
    }
    known_endpoints = {
        *(row["paper_id"] for row in papers), *(row["device_id"] for row in old_devices),
        *(row["device_variant_id"] for row in variants), *(row["component_id"] for row in components),
        *(row["interface_id"] for row in interfaces), *valid,
    }
    endpoint_fields = (
        "device_id", "device_variant_id", "component_id", "interface_id", "motif_id",
        "implementation_id", "device_ids", "device_variant_ids", "component_ids",
        "interface_ids", "motif_ids",
    )
    for key, rows in knowledge.items():
        knowledge[key] = [
            row for row in rows
            if any(
                value in known_endpoints
                for field in endpoint_fields
                for value in ([str(row[field])] if row.get(field) and not isinstance(row[field], list) else strings(row.get(field)))
            )
        ]

    builder = load_builder()
    builder.validate_entities = structural_validation
    bundle = builder.build_bundle(
        papers, old_devices, variants, components, interfaces, accepted, quarantined, motif_rows,
        knowledge["relationships"], knowledge["failures"], knowledge["constraints"], knowledge["coverage"],
    )
    enrich_projection(bundle, nodes)
    bundle["schema_version"] = "2.2.0-hierarchy-v2-rich-engineering"
    bundle["qa"]["projection"] = match_qa
    bundle["qa"]["projection"]["components_with_recurrent_mapping"] = sum(bool(row["motif_ids"]) for row in components)
    bundle["qa"]["projection"]["variants_with_recurrent_mapping"] = sum(bool(row["motif_ids"]) for row in variants)
    bundle["qa"]["projection"]["policy"] = "New extraction assigns recurrent motifs at device/variant level; reviewed crosswalks retain exact component assignments."
    bundle["sources"] = {
        "hierarchy_release_id": "rogers_core_v2.1.2-hierarchy-rebuilt",
        "engineering_source": "protocol-repair-v1 rich engineering extraction",
        "projection_policy": "reviewed crosswalk plus within-paper device-name matching",
    }

    edges = hierarchy_edges(args.release, nodes, observations)
    edges.extend(l2_device_rollup_edges(new_devices, nodes, release_rows, observations))
    corpus = Counter(paper_years.values())
    hierarchy = {
        "schema_version": "2.2.0",
        "release_id": "rogers_core_v2.1.2-hierarchy-rebuilt-rich-engineering",
        "generated_at": bundle["generated_at"],
        "source": {"release_id": "rogers_core_v2.1.2-hierarchy-rebuilt", "note": "New recurrent hierarchy joined to the complete reviewed engineering extraction."},
        "counts": {"nodes": len(nodes), "edges": len(edges), "by_level": dict(sorted(Counter(node["level"] for node in nodes).items()))},
        "corpus_papers_by_year": {str(year): corpus[year] for year in sorted(corpus)},
        "timeline_policy": {"recent_start_year": 2022, "top_n": 10, "emerging_prior_share_threshold": 0.01},
        "nodes": nodes,
        "edges": edges,
        "observations": public_observations,
        "public_release": {
            "schema_version": "2.2", "contains_article_pdfs": False, "contains_evidence_samples": False,
            "contains_full_text": False, "contains_paper_ids": False, "contains_reviewed_observations": True,
            "reviewed_observation_count": len(public_observations),
        },
        "review_policy": {
            "hierarchy": "L1 broad families; L2 recurrent functional motifs; L3 recurrent implementation variants.",
            "single_source": "Single-paper method fragments are retained as examples anchored to recurrent L2 parents.",
            "cooccurrence": "Direct L3 co-use and device-derived L2 roll-ups are separate layers; both require at least two distinct papers.",
        },
    }
    validate_release(hierarchy, bundle)
    write_json(args.hierarchy_output, hierarchy)
    write_json(args.bundle_output, bundle)
    print(json.dumps({
        "hierarchy": hierarchy["counts"], "observations": len(public_observations),
        "engineering": bundle["qa"]["counts"], "projection": bundle["qa"]["projection"],
    }, indent=2))


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--release", type=Path, default=DEFAULT_RELEASE)
    result.add_argument("--engineering", type=Path, default=DEFAULT_ENGINEERING)
    result.add_argument("--hierarchy-output", type=Path, required=True)
    result.add_argument("--bundle-output", type=Path, required=True)
    return result


if __name__ == "__main__":
    build(parser().parse_args())
