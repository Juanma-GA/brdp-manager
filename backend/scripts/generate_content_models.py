"""Ruta del esquema para las reglas sobre la sección de identificación y
estado -- generates backend/schema_cards/content-models-<standard>.json: for
every element of the real XSDs, what the schema cards (generate_schema_cards
.py) do not say and the Test rule panel needs to build a valid chain of
containers down to an element:

  order     the element's child names in the order its content model lists
            them (first appearance, through sequence/choice/all/group ref and
            a complexContent extension's base first) -- where a new child
            goes among the ones already there;
  required  the children a minimal valid instance must have, in order: a
            name, or a list of names when a required xs:choice leaves the
            pick open (the consumer picks); a required choice with an
            optional or empty alternative needs nothing. minOccurs > 1 is
            repeated (capped at 3);
  text      whether the element can hold text (mixed content, simple
            content, or a simple / no type) -- where a minimal instance gets
            a "…" placeholder;
  max       (Mejoras G, Part 1.1) how many times each child can appear: a
            number or "unbounded". An upper bound, never less than a valid
            document admits: in a choice the largest of its branches, in a
            sequence the sum when the same child appears more than once,
            everything multiplied by the maxOccurs of the particles around
            it. "Either <assert> or <evaluate>, not both" is not modelled
            (each gets its own bound).

Same two resolution worlds as the cards (S1000D: each file on its own, plus
its xlink/rdf imports; DITA: one merged world with its redefines), reusing
generate_schema_cards.py's scope building and lookup, so the two files never
disagree on what a name resolves to. Variants are grouped by schemas with an
identical model, like the cards. A reference that cannot be resolved stops
that branch (the element's model is marked "resolved": false and the
consumer never builds anything from it).

    cd backend && source .venv/bin/activate
    python scripts/generate_content_models.py "S1000D 4.2" ../sources/SchemasS1000D/4.2 schema_cards/content-models-4-2.json
    python scripts/generate_content_models.py "DITA 1.3" ../sources/D1.3/schema schema_cards/content-models-dita.json --mode=merged
    # …and 4.1 / 3.0.1 (isolated)
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from generate_schema_cards import (  # noqa: E402
    QN,
    Unresolved,
    _is_xsd,
    _local,
    build_scopes,
)

_MAX_DEPTH = 60
_MAX_REPEAT = 3


def _occurs(node, attr: str, default: int = 1) -> int | None:
    value = node.get(attr)
    if value is None:
        return default
    if value == "unbounded":
        return None
    return int(value)


def _particle(node, scope, stack: frozenset, visited: frozenset, depth: int):
    """A particle as a small tree: ("el", name, min, max) | ("seq", [..], min,
    max) | ("choice", [..], min, max) | None (an xs:any, an attribute, …);
    max None = unbounded."""
    if depth > _MAX_DEPTH:
        raise Unresolved("content model too deep")
    tag = _local(node.tag)
    minimum = _occurs(node, "minOccurs") or 0
    maximum = _occurs(node, "maxOccurs")
    if tag == "element":
        ref = node.get("ref")
        name = ref.split(":", 1)[-1] if ref else node.get("name")
        return ("el", name, minimum, maximum) if name else None
    if tag in ("sequence", "all", "choice"):
        parts = [p for p in (_particle(c, scope, stack, visited, depth + 1) for c in node if _is_xsd(c)) if p]
        return ("choice" if tag == "choice" else "seq", parts, minimum, maximum)
    if tag == "group":
        ref = node.get("ref")
        if not ref:
            return None
        name = ref.split(":", 1)[-1]
        target, is_redef = scope.lookup("group", name, stack)
        if target is None:
            raise Unresolved(f"group ref not found: {name}")
        if id(target) in visited:
            raise Unresolved(f"circular group ref: {name}")
        next_stack = stack | {("group", name)} if is_redef else stack
        parts = [
            p
            for p in (_particle(c, scope, next_stack, visited | {id(target)}, depth + 1) for c in target if _is_xsd(c))
            if p
        ]
        return ("seq", parts, minimum, maximum)
    return None


def _type_particles(type_node, scope, stack: frozenset, depth: int) -> tuple[list, bool]:
    """(particles, text) of a complexType: its base's first for an extension."""
    if depth > _MAX_DEPTH:
        raise Unresolved("type recursion depth exceeded")
    text = type_node.get("mixed") == "true"
    complex_content = type_node.find(QN("complexContent"))
    if complex_content is not None:
        text = text or complex_content.get("mixed") == "true"
        extension = complex_content.find(QN("extension"))
        restriction = complex_content.find(QN("restriction"))
        body = extension if extension is not None else restriction
        particles: list = []
        if body is None:
            return particles, text
        base = body.get("base")
        if extension is not None and base and not base.startswith("xs:"):
            local = base.split(":", 1)[-1]
            base_node, is_redef = scope.lookup("complexType", local, stack)
            if base_node is None:
                raise Unresolved(f"complexType base not found: {local}")
            next_stack = stack | {("complexType", local)} if is_redef else stack
            base_particles, base_text = _type_particles(base_node, scope, next_stack, depth + 1)
            particles.extend(base_particles)
            text = text or base_text
        for child in body:
            if _is_xsd(child):
                p = _particle(child, scope, stack, frozenset(), depth + 1)
                if p:
                    particles.append(p)
        return particles, text
    if type_node.find(QN("simpleContent")) is not None:
        return [], True
    particles = [p for p in (_particle(c, scope, stack, frozenset(), depth + 1) for c in type_node if _is_xsd(c)) if p]
    return particles, text


def _order(particles: list, out: list) -> None:
    for p in particles:
        if p[0] == "el":
            if p[1] not in out:
                out.append(p[1])
        else:
            _order(p[1], out)


def _slots(p) -> list:
    """The required slots of one particle (see module docstring)."""
    kind, body, minimum, _maximum = p
    if minimum == 0:
        return []
    repeat = min(minimum, _MAX_REPEAT)
    if kind == "el":
        return [body] * repeat
    if kind == "seq":
        one = [s for child in body for s in _slots(child)]
        return one * repeat
    # choice: one alternative, whichever the consumer picks
    alternatives = [_slots(child) for child in body]
    if not alternatives or any(len(a) == 0 for a in alternatives):
        return []
    if all(len(a) == 1 for a in alternatives):
        names: list = []
        for (slot,) in alternatives:
            for name in slot if isinstance(slot, list) else [slot]:
                if name not in names:
                    names.append(name)
        return ([names] if len(names) > 1 else [names[0]]) * repeat
    # alternatives of several elements: the shortest one (first on ties)
    return min(alternatives, key=len) * repeat


def _add(a, b):
    return None if a is None or b is None else a + b


def _times(count, factor):
    return None if count is None or factor is None else count * factor


def _max_counts(p) -> dict:
    """{child: upper bound of its occurrences (None = unbounded)} of one
    particle (see module docstring)."""
    kind, body, _minimum, maximum = p
    if maximum == 0:
        return {}
    if kind == "el":
        own = {body: 1}
    elif kind == "seq":
        own = {}
        for child in body:
            for name, count in _max_counts(child).items():
                own[name] = _add(own[name], count) if name in own else count
    else:  # choice: one branch per occurrence -- the largest
        own = {}
        for child in body:
            for name, count in _max_counts(child).items():
                if name not in own:
                    own[name] = count
                elif own[name] is not None and (count is None or count > own[name]):
                    own[name] = count
    return {name: _times(count, maximum) for name, count in own.items()}


def compute_model(element_node, scope) -> dict:
    order: list = []
    required: list = []
    maxima: dict = {}
    text = False
    resolved = True
    inline = element_node.find(QN("complexType"))
    type_attr = element_node.get("type")
    try:
        if inline is not None:
            particles, text = _type_particles(inline, scope, frozenset(), 0)
        elif type_attr and not type_attr.startswith("xs:"):
            local = type_attr.split(":", 1)[-1]
            type_node, is_redef = scope.lookup("complexType", local, frozenset())
            if type_node is not None:
                stack = frozenset({("complexType", local)}) if is_redef else frozenset()
                particles, text = _type_particles(type_node, scope, stack, 0)
            else:
                particles, text = [], True  # a named simple type
        else:
            particles, text = [], True  # xs:string & co., or no type at all
        _order(particles, order)
        required = [s for p in particles for s in _slots(p)]
        maxima = _max_counts(("seq", particles, 1, 1))
    except Unresolved:
        resolved = False
    model = {
        "order": order,
        "required": required,
        "text": text,
        "max": {name: ("unbounded" if maxima.get(name) is None else maxima[name]) for name in order if name in maxima},
    }
    if not resolved:
        model["resolved"] = False
    return model


def build_models(scopes) -> dict:
    by_element: dict[str, dict[str, dict]] = {}
    for scope in scopes:
        for name, node in scope.elements.items():
            model = compute_model(node, scope)
            signature = json.dumps(model, sort_keys=True)
            variants = by_element.setdefault(name, {})
            variants.setdefault(signature, {"schemas": [], "model": model})["schemas"].append(scope.label)
    models = {}
    unresolved = 0
    for name in sorted(by_element):
        entries = []
        for variant in by_element[name].values():
            schemas = sorted(variant["schemas"]) if variant["schemas"] != ["__MERGED__"] else ["DITA 1.3"]
            entries.append({"schemas": schemas, **variant["model"]})
            if variant["model"].get("resolved") is False:
                unresolved += 1
        entries.sort(key=lambda e: (-len(e["schemas"]), e["schemas"]))
        models[name] = entries
    return {"models": models, "unresolved_count": unresolved}


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    mode = "isolated"
    for a in sys.argv[1:]:
        if a.startswith("--mode="):
            mode = a.split("=", 1)[1]
    if len(args) != 3 or mode not in ("isolated", "merged"):
        print(__doc__)
        sys.exit(1)
    standard, schema_root_arg, output_arg = args
    schema_root = Path(schema_root_arg).resolve()
    output = Path(output_arg).resolve()
    result = build_models(build_scopes(schema_root, mode))
    payload = {
        "_readme": (
            "Auto-generated by backend/scripts/generate_content_models.py -- do not hand-edit. "
            "Child order, required children, text and child maxima per element, grouped by schemas like the schema cards."
        ),
        "standard": standard,
        "mode": mode,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "element_count": len(result["models"]),
        "unresolved_count": result["unresolved_count"],
        "models": result["models"],
    }
    output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"{standard}: {len(result['models'])} elements, {result['unresolved_count']} unresolved, "
          f"{output.stat().st_size / 1024:.1f} KB -> {output}")


if __name__ == "__main__":
    for _stream in (sys.stdout, sys.stderr):  # UTF-8 on any console or pipe, Windows included (Protecciones 1c)
        _stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    main()
