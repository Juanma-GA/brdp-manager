from pydantic import BaseModel


class SchemaCardAttributeOut(BaseModel):
    name: str
    required: bool
    enum: list[str] | None = None
    # Truncation is a compact-output concern (docs request point 2): the
    # generator itself always keeps the full enum; the endpoint decides
    # what "a lot" means and says so explicitly whenever it cuts something,
    # never in silence.
    enum_truncated: bool = False
    enum_omitted: int = 0


class SchemaCardVariantOut(BaseModel):
    schemas: list[str]
    attributes: list[SchemaCardAttributeOut]
    attributes_truncated: bool = False
    attributes_omitted: int = 0
    children: list[str]
    children_truncated: bool = False
    children_omitted: int = 0
    resolved: bool


class SchemaCardEntryOut(BaseModel):
    variants: list[SchemaCardVariantOut]
    # The reverse index (docs request point 1: "Padres: índice inverso de
    # los hijos") -- which elements allow THIS name as a child, across
    # every schema variant combined (not itself split by variant: the
    # generator's own `parents` index is a single flat list per name).
    parents: list[str]
    parents_truncated: bool = False
    parents_omitted: int = 0


class SchemaCardsOut(BaseModel):
    standard: str
    # False means this standard has no generated schema cards at all
    # (S1000D 5.0/6.0 -- no schema in this repo) -- distinct from a
    # requested name simply not being a real element (that lands in
    # `unknown` with `available=True`).
    available: bool
    cards: dict[str, SchemaCardEntryOut]
    unknown: list[str]
    # Suggest Rule part 2: every document-type schema of the standard (the
    # variants a rule can be limited to), so the client can tell whether an
    # element exists in ALL of them. [] when not available.
    document_schemas: list[str] = []
    # DITA (T4): for each requested name, the topic types whose graph has it
    # (the card variants of the merged DITA schema cannot say). {} otherwise.
    element_schemas: dict[str, list[str]] = {}


class SchemaAttributeOwnerOut(BaseModel):
    element: str
    schemas: list[str]
    required: bool
    enum: list[str] | None = None


class SchemaAttributeOut(BaseModel):
    """C1: the elements that declare one attribute, with its values
    (Ask's deterministic "which values does @x take" answer)."""

    standard: str
    name: str
    available: bool
    owners: list[SchemaAttributeOwnerOut] = []


class SchemaStructureElementOut(BaseModel):
    children: list[str]
    attributes: list[str]


class MetadataNodeOut(BaseModel):
    """One element of the minimal identification and status section."""

    name: str
    # [[name, value], ...] -- the element's required attributes.
    attributes: list[list[str]] = []
    text: str | None = None
    children: list["MetadataNodeOut"] = []


class MetadataSkeletonOut(BaseModel):
    """Rule test on DM metadata: the minimal identification and status
    section every assembled data module carries (rule_test_skeletons.py)."""

    element: str
    tree: MetadataNodeOut


class RuleTestSkeletonOut(BaseModel):
    root: str
    # Element names from the root down to the insertion point, inclusive.
    path: list[str]
    insertion: str
    # "para" (a chain down to <para>), "step" (DITA task) or the fallback
    # used when the schema has none: "body", "content" or "root" (see
    # rule_test_skeletons.py).
    derivation: str
    # T4b: elements of the path the application gives their required
    # <title> as first child (DITA topics; [] for S1000D and maps).
    titled: list[str] = []
    # The data module's identification and status section (None for DITA and
    # for documents that are not data modules).
    metadata: MetadataSkeletonOut | None = None


class SchemaStructureOut(BaseModel):
    """Test rule (T2b): one schema's derived skeleton and its complete
    element graph (children and attribute names, no truncation)."""

    standard: str
    schema_name: str
    available: bool
    skeleton: RuleTestSkeletonOut | None = None
    elements: dict[str, SchemaStructureElementOut] = {}


class SchemaRelationSchemaOut(BaseModel):
    schema_name: str
    direct: bool
    # parent … child, the shortest chain when not direct (None if none).
    path: list[str] | None = None


class SchemaRelationOut(BaseModel):
    """C2: can <parent> contain <child> directly, schema by schema (Ask's
    deterministic yes/no answer)."""

    standard: str
    parent: str
    child: str
    available: bool
    parent_exists: bool
    child_exists: bool
    schemas: list[SchemaRelationSchemaOut] = []
