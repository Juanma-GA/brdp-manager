"""Project "Schema location" (project_config.schemaLocation, S1000D only).

Mirror of src/utils/ruleSchemaContext.js (SCHEMA_LOCATION_OPTIONS,
validateSchemaPattern) -- keep both in sync. The frontend builds and
recognizes the URLs; the backend only refuses a configuration the app could
not use:

  - schemaLocation must be one of the options of the project's standard:
    S1000D 3.0.1 flat / master / custom; S1000D 4.1 and 4.2 flat / custom
    (S1000D publishes no master schema set for 4.x). DITA and S1000D 5.0/6.0
    have no schema location: the key is not checked there.
  - "custom" needs schemaLocationPattern with {schema} exactly once, no line
    break and none of " < & (they would break the XML attribute the URL is
    written into).
"""

SCHEMA_PLACEHOLDER = "{schema}"

SCHEMA_LOCATION_OPTIONS = {
    "S1000D 4.2": ("flat", "custom"),
    "S1000D 4.1": ("flat", "custom"),
    "S1000D 3.0.1": ("flat", "master", "custom"),
}


def schema_pattern_problem(pattern) -> str | None:
    """None when valid, else the reason (English, shown as the 422 detail)."""
    value = pattern if isinstance(pattern, str) else ""
    if not value.strip():
        return "Write the pattern of the schema URL."
    if "\r" in value or "\n" in value:
        return "The pattern cannot contain line breaks."
    for char in value:
        if char in '"<&':
            return f"The pattern cannot contain the character {char}: it would break the XML attribute it is written into."
    count = value.count(SCHEMA_PLACEHOLDER)
    if count == 0:
        return "The pattern must contain {schema} where the schema name goes."
    if count > 1:
        return "The pattern must contain {schema} exactly once."
    return None


def schema_location_problem(standard: str, project_config: dict) -> str | None:
    options = SCHEMA_LOCATION_OPTIONS.get(standard)
    if options is None or not isinstance(project_config, dict):
        return None
    location = project_config.get("schemaLocation")
    if location is None:
        return None
    if location not in options:
        return f"Schema location \"{location}\" is not available for {standard}: use {', '.join(options)}."
    if location == "custom":
        return schema_pattern_problem(project_config.get("schemaLocationPattern"))
    return None
