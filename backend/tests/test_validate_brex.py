"""POST /api/validate-brex against the real reference XSD files under
sources/ -- not mocked. VALID_BREX_42_XML below was produced by actually
running the untouched JS engine (src/api/generateBREX.js's generateBREX(),
called with a single validated BRDP and zero approvals so it falls back to
its deterministic empty-skeleton + traceability-comment path) and captured
verbatim -- it is real output from the engine this v2 explicitly must never
modify, not hand-written XML that might not reflect what the engine
actually emits. Cross-validating it here confirms the relative xlink/rdf/dc
xs:import resolution (server.js's old xmllint-wasm preload list) also works
with lxml's real filesystem-based resolution.
"""
from pathlib import Path

import pytest

from app.core.security import hash_password
from app.db.base import async_session_factory
from app.models import User

VALID_BREX_42_XML = """<?xml version="1.0" encoding="UTF-8"?>
<dmodule xsi:noNamespaceSchemaLocation="http://www.s1000d.org/S1000D_4-2/xml_schema_flat/brex.xsd" xmlns:dc="http://www.purl.org/dc/elements/1.1/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<identAndStatusSection>
<dmAddress>
<dmIdent>
<dmCode modelIdentCode="TST" systemDiffCode="A" systemCode="00" subSystemCode="0" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="0A" infoCode="022" infoCodeVariant="A" itemLocationCode="D"/>
<language languageIsoCode="en" countryIsoCode="US"/>
<issueInfo issueNumber="001" inWork="00"/>
</dmIdent>
<dmAddressItems>
<issueDate year="2026" month="09" day="09"/>
<dmTitle>
<techName>TST</techName>
<infoName>Business Rules Exchange</infoName>
</dmTitle>
</dmAddressItems>
</dmAddress>
<dmStatus issueType="new">
<security securityClassification="01"/>
<responsiblePartnerCompany/>
<originator/>
<applic><displayText><simplePara>All</simplePara></displayText></applic>
<brexDmRef>
<dmRef>
<dmRefIdent>
<dmCode modelIdentCode="TST" systemDiffCode="A" systemCode="00" subSystemCode="0" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="0A" infoCode="022" infoCodeVariant="A" itemLocationCode="D"/>
<issueInfo issueNumber="001" inWork="00"/>
</dmRefIdent>
</dmRef>
</brexDmRef>
<qualityAssurance><unverified/></qualityAssurance>
</dmStatus>
</identAndStatusSection>
<content>
<brex>

<!-- BRDP-T-00001: pendiente de aprobación de regla, no incluida en este documento -->
</brex>
</content>
</dmodule>
"""


@pytest.fixture
async def auth_headers():
    async with async_session_factory() as session:
        user = User(
            email="validate-brex-test@example.com",
            password_hash=hash_password("irrelevant-password"),
            display_name="Validate Test",
            global_role="user",
        )
        session.add(user)
        await session.commit()
        await session.refresh(user)
        user_id = user.id

    from app.core.security import create_access_token

    token = create_access_token(user_id)
    yield {"Authorization": f"Bearer {token}"}

    async with async_session_factory() as session:
        db_user = await session.get(User, user_id)
        if db_user is not None:
            await session.delete(db_user)
            await session.commit()


async def test_valid_real_engine_output_validates_true(client, auth_headers):
    response = await client.post(
        "/api/validate-brex",
        json={"xml": VALID_BREX_42_XML, "format": "4.2"},
        headers=auth_headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is True
    assert body["errors"] == []


async def test_wrong_root_element_rejected_with_real_schema_error(client, auth_headers):
    response = await client.post(
        "/api/validate-brex", json={"xml": "<notbrex/>", "format": "4.2"}, headers=auth_headers
    )
    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is False
    assert len(body["errors"]) == 1
    assert "notbrex" in body["errors"][0]["message"]


async def test_malformed_xml_reported_as_invalid_not_a_500(client, auth_headers):
    response = await client.post(
        "/api/validate-brex", json={"xml": "<notclosed>", "format": "4.2"}, headers=auth_headers
    )
    assert response.status_code == 200
    body = response.json()
    assert body["valid"] is False
    assert len(body["errors"]) == 1


async def test_unknown_format_rejected(client, auth_headers):
    response = await client.post(
        "/api/validate-brex", json={"xml": "<x/>", "format": "9.9"}, headers=auth_headers
    )
    assert response.status_code == 400


async def test_requires_authentication(client):
    response = await client.post("/api/validate-brex", json={"xml": "<x/>", "format": "4.2"})
    assert response.status_code == 401


@pytest.mark.parametrize("format_value", ["3.0.1", "4.1", "4.2"])
async def test_every_supported_format_loads_its_own_schema_without_error(client, auth_headers, format_value):
    """Not asserting valid=True (each issue's root/structure differs) --
    just that the right XSD set loads and runs without a 500, proving the
    per-issue sources/S<issue>/ directory resolution works for all three.
    """
    response = await client.post(
        "/api/validate-brex", json={"xml": "<x/>", "format": format_value}, headers=auth_headers
    )
    assert response.status_code == 200
    assert response.json()["valid"] is False


def test_no_xsd_in_sources_declares_an_absolute_url_schemalocation():
    """Cheap static guard against a future XSD file swap silently
    reintroducing the exact risk the network test below rules out today:
    lxml resolves an absolute http(s) schemaLocation over the network by
    default, and would either hang or fail in a locked-down deployment with
    no outbound internet. If this ever fails, the real fix is dropping a
    local copy next to the importing XSD and changing schemaLocation to a
    relative path -- not adding a custom Resolver as a band-aid.
    """
    import re

    from app.core.config import get_settings

    sources_dir = Path(get_settings().sources_dir)
    offenders = []
    for subdir in ("S3.0.1", "S4.1", "S4.2"):
        for xsd_file in (sources_dir / subdir).glob("*.xsd"):
            text = xsd_file.read_text()
            for match in re.finditer(r'schemaLocation="(https?://[^"]+)"', text):
                offenders.append(f"{xsd_file}: {match.group(1)}")
    assert offenders == [], f"Absolute-URL schemaLocation found (network dependency risk): {offenders}"


def test_xsd_schema_loading_and_validation_works_with_zero_network_access():
    """The concrete risk: lxml.etree.XMLSchema resolves an absolute-URL
    schemaLocation over the network when a referenced import is actually
    needed to complete the schema. A Python-level socket monkeypatch does
    NOT catch this -- confirmed empirically while writing this test:
    libxml2 (the C library lxml binds) does its own network I/O in C,
    completely bypassing Python's socket module, so a schema with a real
    http:// import still "loaded successfully" with socket.socket patched
    to raise. The only reliable way to prove zero network dependency is to
    remove the network at the OS level, below both Python and libxml2 --
    hence shelling out to a real `unshare --net` subprocess (no network
    namespace at all, not even loopback) rather than trying to fake it
    in-process.

    Skips (doesn't fail) if `unshare --net` isn't usable in this
    environment (needs root or unprivileged user namespaces) -- this is a
    strong extra check when it can run, not the primary guard. The
    primary, environment-independent guard is
    test_no_xsd_in_sources_declares_an_absolute_url_schemalocation above:
    since our real XSDs only ever use relative schemaLocation, whether
    libxml2 *would* hit the network for an absolute one is moot.
    """
    import shutil
    import subprocess
    import sys
    import textwrap

    if shutil.which("unshare") is None:
        pytest.skip("unshare not available in this environment")

    from app.core.config import get_settings

    script = textwrap.dedent(f"""
        from pathlib import Path
        from lxml import etree
        for subdir, filename in (("S3.0.1", "brex.xsd"), ("S4.1", "brex4.1.xsd"), ("S4.2", "brex4.2.xsd")):
            path = Path({str(get_settings().sources_dir)!r}) / subdir / filename
            doc = etree.parse(str(path))
            schema = etree.XMLSchema(doc)
            schema.validate(etree.fromstring(b"<x/>"))
        print("OK")
    """)

    result = subprocess.run(
        ["unshare", "--net", sys.executable, "-c", script],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if result.returncode != 0 and "Operation not permitted" in result.stderr:
        pytest.skip(f"unshare --net not permitted in this environment: {result.stderr.strip()}")

    assert result.returncode == 0, f"stdout={result.stdout!r} stderr={result.stderr!r}"
    assert "OK" in result.stdout
