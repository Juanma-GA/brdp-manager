from fastapi import APIRouter, Depends, Query

from app.api.deps import get_current_user
from app.models import User
from app.schemas.schema_cards import SchemaAttributeOut, SchemaCardsOut, SchemaGraphOut, SchemaRelationOut, SchemaStructureOut
from app.services.rule_test_skeletons import get_element_relation, get_element_schemas, get_schema_structure, get_standard_graph
from app.services.schema_cards import get_attribute_owners, get_document_schemas, get_schema_cards

router = APIRouter(prefix="/api/schema-cards", tags=["schema-cards"])


@router.get("", response_model=SchemaCardsOut)
async def read_schema_cards(
    standard: str = Query(...),
    names: str = Query(..., description="Comma-separated element names to look up."),
    full: bool = Query(False, description="No list is cut (Ask's deterministic structural answers)."),
    _current_user: User = Depends(get_current_user),
) -> SchemaCardsOut:
    """Docs request ("Servicio de fichas de esquema"): structural facts
    (attributes with required/enum, direct children) for the requested
    element names, from the real XSD-derived cards
    (backend/schema_cards/*.json, loaded once at startup -- see
    app.services.schema_cards). Any authenticated user can read this --
    it's reference data about a standard, not project-scoped or secret,
    same posture as GET /api/config/ai-provider.
    """
    name_list = [n.strip() for n in names.split(",") if n.strip()]
    available, cards, unknown = get_schema_cards(standard, name_list, full=full)
    return SchemaCardsOut(
        standard=standard,
        available=available,
        cards=cards,
        unknown=unknown,
        document_schemas=get_document_schemas(standard),
        element_schemas=get_element_schemas(standard, name_list),
    )


@router.get("/attribute", response_model=SchemaAttributeOut)
async def read_schema_attribute(
    standard: str = Query(...),
    name: str = Query(...),
    _current_user: User = Depends(get_current_user),
) -> SchemaAttributeOut:
    """C1: every element that declares attribute `name`, with its complete
    values -- the data behind Ask's "which values does @x take" answer."""
    available, owners = get_attribute_owners(standard, name)
    return SchemaAttributeOut(standard=standard, name=name, available=available, owners=owners)


@router.get("/relation", response_model=SchemaRelationOut)
async def read_schema_relation(
    standard: str = Query(...),
    parent: str = Query(...),
    child: str = Query(...),
    _current_user: User = Depends(get_current_user),
) -> SchemaRelationOut:
    """C2: whether <parent> can contain <child> as a DIRECT child, per
    document schema where the parent is defined, with the shortest chain of
    elements that reaches the child when it is not direct -- the data behind
    Ask's "can <para> contain <table>?" answer. Reference data, same posture
    as GET /api/schema-cards."""
    data = get_element_relation(standard, parent, child)
    return SchemaRelationOut(
        standard=standard,
        parent=parent,
        child=child,
        available=data["available"],
        parent_exists=data["parent_exists"],
        child_exists=data["child_exists"],
        schemas=[{"schema_name": s["schema"], "direct": s["direct"], "path": s["path"]} for s in data["schemas"]],
    )


@router.get("/structure", response_model=SchemaStructureOut)
async def read_schema_structure(
    standard: str = Query(...),
    schema: str = Query(..., description="Schema name, e.g. proced, descript."),
    _current_user: User = Depends(get_current_user),
) -> SchemaStructureOut:
    """Test rule (T2b): the skeleton the application builds the examples on
    (root → insertion point, derived from the cards) and the schema's
    complete element graph, used to check each example's structure (every
    child allowed inside its parent, every attribute declared on its
    element), and each element's content model (child order, required
    children, text, required attributes) to build a valid chain down to an
    element. Reference data, same posture as GET /api/schema-cards."""
    data = get_schema_structure(standard, schema)
    return SchemaStructureOut(
        standard=standard,
        schema_name=schema,
        available=data["available"],
        skeleton=data["skeleton"],
        elements=data["elements"],
        models=data["models"],
    )


@router.get("/graph", response_model=SchemaGraphOut)
async def read_schema_graph(
    standard: str = Query(...),
    _current_user: User = Depends(get_current_user),
) -> SchemaGraphOut:
    """Mejoras C, Part 1: every document schema's element graph (children
    and attribute names per card variant) and roots, so the client can tell
    a rule whose path cannot exist (<trade> inside <perscat>, /techstd as a
    root). Reference data, same posture as GET /api/schema-cards."""
    return SchemaGraphOut(**get_standard_graph(standard))
