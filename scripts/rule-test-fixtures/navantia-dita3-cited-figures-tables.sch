<?xml version="1.0" encoding="UTF-8"?>
<!-- RECONSTRUCTED fixture, not the real Navantia file (that one is not in the
     repo). Navantia "DITA 1.3 Xpath3.0", BRDP-EXT-00014 (every figure of a
     sheet is cited) and BRDP-EXT-00015 (every table of a sheet is cited):
     dossier rules that look for the ditamap going up the folders (the same
     search as navantia-dita3-reconstructed.sch) and check, from each figure
     or table with an @id, that some <xref> of the dossier's sheets points to
     it. The shape is the reported one (a context on fig/table with @id, the
     dossier's sheets read through the ditamap); the expressions are
     reconstructed. Used by scripts/test-rule-test-loose-content.mjs. -->
<sch:schema xmlns:sch="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt3">
  <sch:title>Navantia (reconstruido): figuras y tablas citadas</sch:title>
  <sch:pattern id="p-BRDP-EXT-00014">
    <sch:let name="yo" value="base-uri()"/>
    <sch:let name="mapas" value="for $mC in (for $n in 1 to count(tokenize($yo, '/')) - 1 return string-join(subsequence(tokenize($yo, '/'), 1, count(tokenize($yo, '/')) - $n), '/') || '/')[matches(., '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')], $mU in sort(uri-collection($mC)[matches(., '\.ditamap$', 'i')]) return (if (doc-available($mU)) then doc($mU) else ())[some $mE in .//*[@href][not(@scope = 'external')] satisfies resolve-uri(substring-before(concat($mE/@href, '#'), '#'), base-uri($mE)) = $yo]"/>
    <sch:rule context="fig[@id]">
      <sch:let name="id" value="string(@id)"/>
      <sch:let name="fichas" value="for $h in $mapas//topicref[@href][not(@scope = 'external')] return (let $u := resolve-uri(substring-before(concat($h/@href, '#'), '#'), base-uri($h)) return if (doc-available($u)) then doc($u) else ())"/>
      <sch:assert id="BRDP-EXT-00014" role="error" test="empty($mapas) or exists($fichas//xref[tokenize(@href, '/')[last()] = $id])">La figura <sch:value-of select="$id"/> no se cita en ninguna ficha del dosier.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00015">
    <sch:let name="yo" value="base-uri()"/>
    <sch:let name="mapas" value="for $mC in (for $n in 1 to count(tokenize($yo, '/')) - 1 return string-join(subsequence(tokenize($yo, '/'), 1, count(tokenize($yo, '/')) - $n), '/') || '/')[matches(., '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')], $mU in sort(uri-collection($mC)[matches(., '\.ditamap$', 'i')]) return (if (doc-available($mU)) then doc($mU) else ())[some $mE in .//*[@href][not(@scope = 'external')] satisfies resolve-uri(substring-before(concat($mE/@href, '#'), '#'), base-uri($mE)) = $yo]"/>
    <sch:rule context="table[@id]">
      <sch:let name="id" value="string(@id)"/>
      <sch:let name="fichas" value="for $h in $mapas//topicref[@href][not(@scope = 'external')] return (let $u := resolve-uri(substring-before(concat($h/@href, '#'), '#'), base-uri($h)) return if (doc-available($u)) then doc($u) else ())"/>
      <sch:assert id="BRDP-EXT-00015" role="error" test="empty($mapas) or exists($fichas//xref[tokenize(@href, '/')[last()] = $id])">La tabla <sch:value-of select="$id"/> no se cita en ninguna ficha del dosier.</sch:assert>
    </sch:rule>
  </sch:pattern>
</sch:schema>
