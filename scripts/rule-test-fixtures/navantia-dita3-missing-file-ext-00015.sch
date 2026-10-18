<?xml version="1.0" encoding="UTF-8"?>
<!-- RECONSTRUCTED fixture, not the real Navantia file (that one is not in the
     repo). Navantia "DITA 1.3 Xpath3.0", BRDP-EXT-00015 as reported in the
     encargo "un ejemplo de dosier al que le falta un fichero": a table cited
     by its number in X.Y format ("Tabla 3.1 de la ficha L00099") must belong
     to a sheet the ditamap mentions. navantia-dita3-reconstructed.sch has
     another rule under the same id (double spaces) and
     navantia-dita3-cited-figures-tables.sch another reconstruction (every
     table is cited); this one has the reported shape: the dossier search
     going up the folders (the same as those fixtures) and a check on the
     citations' sheet codes. The expressions are reconstructed. Used by
     scripts/test-rule-test-missing-file.mjs and the eval case
     rule-test-navantia-dita3-dossier-missing-file-ext-00015. -->
<sch:schema xmlns:sch="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt3">
  <sch:title>Navantia (reconstruido): tablas citadas de fichas del dosier</sch:title>
  <sch:pattern id="p-BRDP-EXT-00015">
    <sch:let name="yo" value="base-uri()"/>
    <sch:let name="mapas" value="for $mC in (for $n in 1 to count(tokenize($yo, '/')) - 1 return string-join(subsequence(tokenize($yo, '/'), 1, count(tokenize($yo, '/')) - $n), '/') || '/')[matches(., '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')], $mU in sort(uri-collection($mC)[matches(., '\.ditamap$', 'i')]) return (if (doc-available($mU)) then doc($mU) else ())[some $mE in .//*[@href][not(@scope = 'external')] satisfies resolve-uri(substring-before(concat($mE/@href, '#'), '#'), base-uri($mE)) = $yo]"/>
    <sch:rule context="*[not(*)][matches(., 'Tabla \d+\.\d+ de la ficha ')]">
      <sch:let name="codigos" value="for $t in tokenize(normalize-space(.), 'de la ficha ')[position() gt 1] return replace($t, '^([A-Za-z0-9_\-]+).*$', '$1')"/>
      <sch:assert id="BRDP-EXT-00015" role="error" test="empty($mapas) or (every $c in $codigos satisfies some $h in $mapas//topicref/@href satisfies contains($h, $c))">La tabla citada es de una ficha que no está en el dosier: <sch:value-of select="string-join($codigos, ', ')"/>.</sch:assert>
    </sch:rule>
  </sch:pattern>
</sch:schema>
