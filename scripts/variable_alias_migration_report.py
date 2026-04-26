#!/usr/bin/env python3
"""
Generate variable alias migration suggestions for GB Studio projects.

Usage:
  python scripts/variable_alias_migration_report.py \
    --project-root "C:/path/to/project" \
    --output "C:/path/to/report.md"
"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Set, Tuple


GLOBAL_ID_RE = re.compile(r"^\d+$")
LOCAL_ID_RE = re.compile(r"^L[0-5]$")
SCRATCH_HINT_RE = re.compile(
    r"(temp|tmp|loop|counter|index|state|mode|scratch|scene|x|y)", re.IGNORECASE
)


@dataclass
class GlobalVariable:
    id: str
    name: str
    symbol: str


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def iter_project_files(project_root: Path) -> Iterable[Path]:
    project = project_root / "project"
    for rel in ("scenes", "scripts", "prefabs"):
        target = project / rel
        if target.exists():
            yield from target.rglob("*.gbsres")


def scene_slug(path: Path) -> str | None:
    parts = path.parts
    if "scenes" in parts:
        i = parts.index("scenes")
        if i + 1 < len(parts):
            return parts[i + 1]
    return None


def walk_variable_tokens(node: Any, output: List[str]) -> None:
    if isinstance(node, dict):
        if node.get("type") == "variable" and isinstance(node.get("value"), str):
            output.append(node["value"])
        if isinstance(node.get("variable"), str):
            output.append(node["variable"])
        for value in node.values():
            walk_variable_tokens(value, output)
    elif isinstance(node, list):
        for value in node:
            walk_variable_tokens(value, output)


def classify(token: str) -> str | None:
    if GLOBAL_ID_RE.match(token):
        return "global"
    if LOCAL_ID_RE.match(token):
        return "local"
    if token in ("T0", "T1"):
        return "temp"
    if re.match(r"^V\d$", token):
        return "custom_event_arg"
    return None


def to_alias_hint(var: GlobalVariable) -> str:
    name = var.name.strip() or var.symbol.strip() or f"var_{var.id}"
    alias = re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_")
    if not alias:
        alias = f"var_{var.id}"
    if alias[0].isdigit():
        alias = f"var_{alias}"
    return alias.lower()


def build_report(project_root: Path) -> str:
    variables_file = project_root / "project" / "variables.gbsres"
    variables_data = read_json(variables_file)
    rows = variables_data.get("variables", [])

    global_vars: Dict[str, GlobalVariable] = {}
    local_rows = 0
    for row in rows:
        row_id = str(row.get("id", ""))
        if GLOBAL_ID_RE.match(row_id):
            global_vars[row_id] = GlobalVariable(
                id=row_id,
                name=str(row.get("name", "")),
                symbol=str(row.get("symbol", "")),
            )
        elif "__L" in row_id:
            local_rows += 1

    use_count: Counter[str] = Counter()
    use_scenes: Dict[str, Set[str]] = defaultdict(set)
    use_files: Dict[str, Set[str]] = defaultdict(set)
    local_code_count: Counter[str] = Counter()
    temp_code_count: Counter[str] = Counter()

    for file_path in iter_project_files(project_root):
        try:
            data = read_json(file_path)
        except Exception:
            continue
        tokens: List[str] = []
        walk_variable_tokens(data, tokens)
        scene = scene_slug(file_path)
        for token in tokens:
            token_type = classify(token)
            if token_type == "global":
                use_count[token] += 1
                use_files[token].add(str(file_path))
                if scene:
                    use_scenes[token].add(scene)
            elif token_type == "local":
                local_code_count[token] += 1
            elif token_type == "temp":
                temp_code_count[token] += 1

    used_globals = set(use_count.keys())
    unused_globals = sorted(set(global_vars.keys()) - used_globals, key=lambda x: int(x))

    single_scene_globals = []
    multi_scene_globals = []
    for gid in sorted(used_globals, key=lambda x: int(x)):
        scene_span = len(use_scenes[gid])
        entry = (gid, scene_span, use_count[gid], len(use_files[gid]))
        if scene_span <= 1:
            single_scene_globals.append(entry)
        else:
            multi_scene_globals.append(entry)

    scratch_candidates = []
    for gid, span, refs, _file_count in single_scene_globals:
        var = global_vars.get(gid)
        if not var:
            continue
        haystack = f"{var.name} {var.symbol}"
        if not SCRATCH_HINT_RE.search(haystack):
            continue
        only_scene = next(iter(use_scenes[gid])) if use_scenes[gid] else "n/a"
        alias = to_alias_hint(var)
        scratch_candidates.append((gid, refs, only_scene, var, alias))

    scratch_candidates.sort(key=lambda row: (-row[1], int(row[0])))
    multi_scene_globals.sort(key=lambda row: (-row[1], -row[2], int(row[0])))

    lines: List[str] = []
    lines.append("# Variable Alias Migration Report")
    lines.append("")
    lines.append(f"Project root: `{project_root}`")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(f"- Total variable rows: `{len(rows)}`")
    lines.append(f"- Numeric global rows: `{len(global_vars)}`")
    lines.append(f"- Entity local rows (`__Lx`): `{local_rows}`")
    lines.append(f"- Unique globals referenced in scripts/events: `{len(used_globals)}`")
    lines.append(f"- Globals used in one scene: `{len(single_scene_globals)}`")
    lines.append(f"- Globals used across multiple scenes: `{len(multi_scene_globals)}`")
    lines.append(
        f"- Local event code usage: {', '.join(f'`{k}`={v}' for k, v in sorted(local_code_count.items())) or 'none'}"
    )
    lines.append(
        f"- Temp code usage: {', '.join(f'`{k}`={v}' for k, v in sorted(temp_code_count.items())) or 'none'}"
    )
    lines.append("")

    lines.append("## 1) Unused Global Variable Rows")
    lines.append("")
    if not unused_globals:
        lines.append("- None.")
    else:
        lines.append("- These globals appear in `variables.gbsres` but were not referenced in scene/script/prefab events.")
        lines.append("")
        for gid in unused_globals:
            var = global_vars[gid]
            lines.append(f"- `{gid}`: `{var.name}` (`{var.symbol}`)")
    lines.append("")

    lines.append("## 2) Top Shared Globals (keep as `P_` candidates)")
    lines.append("")
    lines.append("| id | scenes | refs | name | symbol |")
    lines.append("|---:|---:|---:|---|---|")
    for gid, scene_span, refs, _files in multi_scene_globals[:30]:
        var = global_vars.get(gid, GlobalVariable(gid, "", ""))
        lines.append(f"| {gid} | {scene_span} | {refs} | {var.name} | {var.symbol} |")
    lines.append("")

    lines.append("## 3) Single-Scene Scratch Candidates (`T_` aliasable)")
    lines.append("")
    lines.append("| id | refs | scene | name | symbol | alias example |")
    lines.append("|---:|---:|---|---|---|---|")
    for gid, refs, scene_name, var, alias in scratch_candidates[:80]:
        lines.append(
            f"| {gid} | {refs} | {scene_name} | {var.name} | {var.symbol} | `T_{alias} => {gid} !reset` |"
        )
    lines.append("")

    lines.append("## 4) Suggested Migration Workflow")
    lines.append("")
    lines.append("1. Remove or repurpose truly unused globals first.")
    lines.append("2. Keep heavily shared globals as persistent (`P_`) targets.")
    lines.append("3. For one-scene scratch globals, rename local `L0..L5` rows with alias bindings, e.g. `T_enemy_index => 203 !reset`.")
    lines.append("4. Add explicit reset events in scene init for all `T_... !reset` aliases.")
    lines.append("5. Build and check compiler warnings for unresolved targets or missing reset markers.")
    lines.append("")

    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate variable alias migration suggestions.")
    parser.add_argument("--project-root", required=True, help="Path to GB Studio project root (contains project/ and assets/).")
    parser.add_argument("--output", required=True, help="Output markdown report path.")
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    output_path = Path(args.output).resolve()

    report = build_report(project_root)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(report, encoding="utf-8")
    print(f"Wrote report: {output_path}")


if __name__ == "__main__":
    main()
