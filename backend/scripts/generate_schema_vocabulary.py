"""Docs request (Suggest Proposal round, "comprobación de vocabulario contra
el esquema") -- generates public/schema-vocabulary-<standard>.json from a
real XSD schema tree: every xs:element/xs:attribute name DECLARED anywhere
in the tree (never ref-only occurrences, which don't declare a new name),
resolving xs:include/xs:import transitively across the whole directory.

Design decision, documented explicitly: rather than starting from a single
"entry point" XSD and walking its include/import graph (fragile -- a
missed or wrongly-resolved include silently drops a whole module's
vocabulary, exactly the kind of silent gap HR7 forbids), this scans EVERY
.xsd file found anywhere under the given root and unions every declared
element/attribute name across all of them. For a schema root that IS the
"full schema" (the docs request's own framing for sources/D1.3/schema),
this is a safe superset by construction -- it cannot miss a file that
exists on disk, and a name declared in an unreachable/unused module is at
worst a false negative it never produces (it can only ever make the
vocabulary too permissive, never too strict) -- HR7-safe by construction:
worse case is a missed genuine typo, never a false "not found" on a real
name.

Usage (reexecutable, this IS the point -- rerun whenever the source XSDs
change):

    cd backend && source .venv/bin/activate
    python scripts/generate_schema_vocabulary.py <standard-key> <schema-root-dir> <output-json-path> [extra-elements-csv]

Example (the only standard with a full schema available in this repo):

    python scripts/generate_schema_vocabulary.py \
        "DITA 1.3" ../sources/D1.3/schema ../public/schema-vocabulary-dita.json machineryTask

Prints the file count and element/attribute counts to stdout -- the
"recuento... como comprobación de cordura" the docs request asks for in
its closeout, without needing a separate script to re-derive it.

The optional 4th argument is a small, explicitly-confirmed allowlist of
extra element names to add on top of what the scan finds -- for a real
gap in THIS schema source, not a scanning bug: cross-checking the app's
own already-curated `topic_types` list (public/schematron-dita-schema-
summary.json) against a first run of this script found that
`machineryTask` never appears as a declared element name anywhere in
sources/D1.3/schema -- confirmed by grep, not assumed. Reading
machineryTask.xsd shows why: it is a constraint MODULE (its own comment
says "It must be declared in topic-type shells"), and this OASIS module
set ships modules, not the final shell XSDs that declare each topic
type's own root element -- unlike topic/concept/task/map/bookmap, which
this module set DOES declare directly. Same principle already
established in generateSchematronDITA.js's XPATH3_ONLY_VOCAB/
XMETAL_AMBITO_MAPA_VOCAB: a name added here must be a CONFIRMED real gap,
never a guess to silence a warning.
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from lxml import etree

XSD_NS = "http://www.w3.org/2001/XMLSchema"


def _local_name(tag: str) -> str:
    return tag.split("}", 1)[1] if "}" in tag else tag


def collect_vocabulary(schema_root: Path) -> tuple[set[str], set[str], list[Path], list[str]]:
    """Returns (elements, attributes, parsed_files, parse_errors).

    parse_errors lists files that failed to parse -- never swallowed
    silently (HR7): the caller must decide whether that's acceptable
    (e.g. a non-.xsd file with an .xsd-looking name) or a real gap.
    """
    elements: set[str] = set()
    attributes: set[str] = set()
    parsed_files: list[Path] = []
    parse_errors: list[str] = []

    xsd_files = sorted(schema_root.rglob("*.xsd"))
    for xsd_path in xsd_files:
        try:
            tree = etree.parse(str(xsd_path))
        except etree.XMLSyntaxError as err:
            parse_errors.append(f"{xsd_path}: {err}")
            continue
        parsed_files.append(xsd_path)
        root = tree.getroot()
        for node in root.iter():
            if not isinstance(node.tag, str):
                continue  # skip comments/PIs, whose .tag is a callable, not a string
            if node.tag != f"{{{XSD_NS}}}element" and node.tag != f"{{{XSD_NS}}}attribute":
                continue
            name = node.get("name")
            if not name:
                continue  # a bare `ref="..."` re-uses an existing declaration, declares nothing new
            if _local_name(node.tag) == "element":
                elements.add(name)
            else:
                attributes.add(name)

    return elements, attributes, parsed_files, parse_errors


def main() -> None:
    if len(sys.argv) not in (4, 5):
        print(__doc__)
        sys.exit(1)

    standard_key, schema_root_arg, output_path_arg = sys.argv[1:4]
    extra_elements = {e.strip() for e in sys.argv[4].split(",") if e.strip()} if len(sys.argv) == 5 else set()
    schema_root = Path(schema_root_arg).resolve()
    output_path = Path(output_path_arg).resolve()

    if not schema_root.is_dir():
        print(f"ERROR: schema root not found or not a directory: {schema_root}")
        sys.exit(1)

    elements, attributes, parsed_files, parse_errors = collect_vocabulary(schema_root)
    already_present = extra_elements & elements
    if already_present:
        print(
            f"NOTE: {sorted(already_present)} passed as extra-elements but already found by the "
            "scan -- harmless (a set union), but check the allowlist is still needed."
        )
    elements |= extra_elements

    if parse_errors:
        print(f"WARNING: {len(parse_errors)} file(s) failed to parse and were skipped:")
        for msg in parse_errors:
            print(f"  {msg}")

    if not parsed_files:
        print(f"ERROR: no .xsd files found under {schema_root} -- refusing to write an empty vocabulary.")
        sys.exit(1)

    payload = {
        "_readme": (
            "Auto-generated by backend/scripts/generate_schema_vocabulary.py -- "
            "do not hand-edit. Rerun the script after the source XSDs change. "
            "`elements`/`attributes` are every xs:element/xs:attribute name "
            "DECLARED anywhere in the schema tree (ref-only occurrences excluded), "
            "scanned across every .xsd file found under the schema root, not just "
            "files reachable from a single include/import entry point. "
            "`extra_elements_allowlist` (if non-empty) lists names added on top of "
            "the scan for a confirmed real gap in this schema source -- see the "
            "generator script's own docstring for why each one was added."
        ),
        "standard": standard_key,
        "schema_root": str(schema_root),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_file_count": len(parsed_files),
        "extra_elements_allowlist": sorted(extra_elements),
        "elements": sorted(elements),
        "attributes": sorted(attributes),
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"Standard: {standard_key}")
    print(f"Schema root: {schema_root}")
    print(f"Parsed {len(parsed_files)} .xsd file(s)")
    print(f"Elements: {len(elements)}")
    print(f"Attributes: {len(attributes)}")
    print(f"Wrote: {output_path}")


if __name__ == "__main__":
    main()
