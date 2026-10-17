<?xml version="1.0" encoding="UTF-8"?>
<!-- RECONSTRUCTED fixture, not the real Navantia rule (its text, with the
     real $pasosDosier, is not in the repo). Navantia "DITA 1.3 Xpath3.0",
     BRDP-EXT-00016: a step cited in a sheet ("paso 2.1") must exist in the
     dossier. The steps of a sheet are <concept outputclass="numbered">
     nested in the sheet's <concept> (a nested topic, after its parent's
     <conbody>); a step's number is its position among the numbered steps at
     each level ($pasosDosier). The ditamap is looked for going up the folders,
     like navantia-dita3-reconstructed.sch. Used by
     scripts/test-rule-test-nested-topic.mjs and the eval case
     rule-test-navantia-dita3-nested-topic-ext-00016. -->
<sch:schema xmlns:sch="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt3">
  <sch:title>Navantia (reconstruido): pasos citados que existen en el dosier</sch:title>
  <sch:pattern id="p-BRDP-EXT-00016">
    <sch:let name="yo" value="base-uri()"/>
    <sch:let name="mapas" value="for $mC in (for $n in 1 to count(tokenize($yo, '/')) - 1 return string-join(subsequence(tokenize($yo, '/'), 1, count(tokenize($yo, '/')) - $n), '/') || '/')[matches(., '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')], $mU in sort(uri-collection($mC)[matches(., '\.ditamap$', 'i')]) return (if (doc-available($mU)) then doc($mU) else ())[some $mE in .//*[@href][not(@scope = 'external')] satisfies resolve-uri(substring-before(concat($mE/@href, '#'), '#'), base-uri($mE)) = $yo]"/>
    <sch:let name="fichas" value="for $h in $mapas//topicref[@href][not(@scope = 'external')] return (let $u := resolve-uri(substring-before(concat($h/@href, '#'), '#'), base-uri($h)) return if (doc-available($u)) then doc($u) else ())"/>
    <sch:let name="pasosDosier" value="for $c in $fichas//concept[@outputclass = 'numbered'] return string-join(for $a in $c/ancestor-or-self::concept[@outputclass = 'numbered'] return string(count($a/preceding-sibling::concept[@outputclass = 'numbered']) + 1), '.')"/>
    <sch:rule context="p[matches(normalize-space(.), '[Pp]aso\s+[0-9]+(\.[0-9]+)*')]">
      <sch:let name="citado" value="replace(normalize-space(.), '^.*?[Pp]aso\s+([0-9]+(\.[0-9]+)*).*$', '$1')"/>
      <sch:assert id="BRDP-EXT-00016" role="error" test="empty($mapas) or $citado = $pasosDosier">El paso <sch:value-of select="$citado"/> citado no existe en el dosier.</sch:assert>
    </sch:rule>
  </sch:pattern>
</sch:schema>
