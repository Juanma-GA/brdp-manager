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
