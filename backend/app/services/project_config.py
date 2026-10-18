"""The shape of project.project_config (AACF 1, Part 5).

What the app stores there is a flat object of texts: the identification
fields of Project Configuration (src/pages/ProjectConfigPage.jsx FULL_FIELDS
and DITA_FIELDS) and the schema location (schemaLocation,
schemaLocationPattern -- checked on their own in schema_location.py). Every
generator reads these as strings.

Only the type is checked: a known key must hold a text. Two things are NOT
checked, because they would be product decisions (listed in the AACF 1
report): keys the app does not know (a project may carry keys from an older
version; refusing them would block saving that project) and the format or
length of each value (e.g. a modelIdentCode pattern; the generators already
fall back to a valid value).
"""

KNOWN_PROJECT_CONFIG_KEYS = (
    "projectName",
    "modelIdentCode",
    "systemDiffCode",
    "issueNumber",
    "inWork",
    "languageIsoCode",
    "countryIsoCode",
    "securityClassification",
    "enterpriseCode",
    "schemaLocation",
    "schemaLocationPattern",
)


def project_config_problem(project_config) -> dict | None:
    """None when the shape is right, else an error detail (code + params)."""
    if not isinstance(project_config, dict):
        return {"code": "project_config_not_object"}
    for key in KNOWN_PROJECT_CONFIG_KEYS:
        if key in project_config and not isinstance(project_config[key], str):
            return {"code": "project_config_value_not_text", "key": key}
    return None
