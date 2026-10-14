<?xml version="1.0" encoding="UTF-8"?>
<!-- RECONSTRUCTED fixture, not the real Navantia file (that one is not in the
     repo). It reproduces the shape reported for the project "DITA 1.3 Xpath3.0"
     (26 Verified/Draft rules, BRDP-EXT-00010 to 00035): 17 rules that look for
     the ditamap going up the folders with sort(uri-collection(...)) (00012 to
     00025, 00027, 00033, 00035), one with matches(..., 'i') (00010) and 8 that
     use neither. The ditamap search is the one quoted in the report; contexts
     and asserts are plausible but invented, except the contexts of 00011
     and 00034, which are the real ones (their lets and asserts are
     reconstructed). Used by
     scripts/test-xpath-functions.mjs and scripts/test-rule-test-dossier.mjs. -->
<sch:schema xmlns:sch="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt3">
  <sch:title>Navantia (reconstruido)</sch:title>
  <sch:pattern id="p-BRDP-EXT-00010">
    <sch:rule context="topic/title">
      <sch:assert id="BRDP-EXT-00010" role="error" test="not(matches(normalize-space(.), '^(nota|aviso)\s*:', 'i'))">El título de la ficha no puede empezar por «Nota:» ni «Aviso:».</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00011">
    <sch:rule context="*[normalize-space(title) = 'LISTA DE REFERENCIAS CONSOLIDADAS'] //section//*[self::p or self::entry[not(p)]][matches(normalize-space(.), '^\([a-z]\)')]">
      <sch:let name="letra" value="substring(normalize-space(.), 2, 1)"/>
      <sch:let name="seccion" value="ancestor::section[1]"/>
      <sch:let name="previos" value="count(preceding::*[self::p or self::entry[not(p)]][matches(normalize-space(.), '^\([a-z]\)')][ancestor::section[1] is $seccion])"/>
      <sch:assert id="BRDP-EXT-00011" role="error" test="string-to-codepoints($letra) = $previos + 97">En la lista de referencias consolidadas el apartado (<sch:value-of select="$letra"/>) está fuera de orden: los apartados van (a), (b), (c)… sin saltos ni repeticiones.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00012">
    <sch:let name="yo" value="base-uri()"/>
    <sch:let name="mapas" value="for $mC in (for $n in 1 to count(tokenize($yo, '/')) - 1 return string-join(subsequence(tokenize($yo, '/'), 1, count(tokenize($yo, '/')) - $n), '/') || '/')[matches(., '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')], $mU in sort(uri-collection($mC)[matches(., '\.ditamap$', 'i')]) return (if (doc-available($mU)) then doc($mU) else ())[some $mE in .//*[@href][not(@scope = 'external')] satisfies resolve-uri(substring-before(concat($mE/@href, '#'), '#'), base-uri($mE)) = $yo]"/>
    <sch:rule context="row[not(parent::thead)][ancestor::*[normalize-space(title) = 'LISTA DE MATERIAL OBLIGATORIO']]">
      <sch:let name="item" value="normalize-space(entry[1])"/>
      <sch:let name="texto" value="string-join(ancestor::*[last()]//(cmd | p)[not(ancestor::table)] ! normalize-space(.), ' ')"/>
      <sch:assert id="BRDP-EXT-00012" role="warning" test="empty($mapas) or $item = '' or contains(lower-case($texto), lower-case($item)) or matches(normalize-space(entry[last()]), '^exento$', 'i')">Da aviso (warning, no error): el material «<sch:value-of select="$item"/>» de la lista de material obligatorio no se nombra en ningún paso de la ficha.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00013">
    <sch:let name="yo" value="base-uri()"/>
    <sch:let name="mapas" value="for $mC in (for $n in 1 to count(tokenize($yo, '/')) - 1 return string-join(subsequence(tokenize($yo, '/'), 1, count(tokenize($yo, '/')) - $n), '/') || '/')[matches(., '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')], $mU in sort(uri-collection($mC)[matches(., '\.ditamap$', 'i')]) return (if (doc-available($mU)) then doc($mU) else ())[some $mE in .//*[@href][not(@scope = 'external')] satisfies resolve-uri(substring-before(concat($mE/@href, '#'), '#'), base-uri($mE)) = $yo]"/>
    <sch:rule context="row[not(parent::thead)][ancestor::*[normalize-space(title) = 'LISTA DE HERRAMIENTAS ESPECIALES']]">
      <sch:let name="item" value="normalize-space(entry[1])"/>
      <sch:let name="texto" value="string-join(ancestor::*[last()]//(cmd | p)[not(ancestor::table)] ! normalize-space(.), ' ')"/>
      <sch:assert id="BRDP-EXT-00013" role="warning" test="empty($mapas) or $item = '' or contains(lower-case($texto), lower-case($item)) or matches(normalize-space(entry[last()]), '^exento$', 'i')">Da aviso (warning, no error): la herramienta «<sch:value-of select="$item"/>» de la lista de herramientas especiales no se nombra en ningún paso de la ficha.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00014">
    <sch:let name="yo" value="base-uri()"/>
    <sch:let name="mapas" value="for $mC in (for $n in 1 to count(tokenize($yo, '/')) - 1 return string-join(subsequence(tokenize($yo, '/'), 1, count(tokenize($yo, '/')) - $n), '/') || '/')[matches(., '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')], $mU in sort(uri-collection($mC)[matches(., '\.ditamap$', 'i')]) return (if (doc-available($mU)) then doc($mU) else ())[some $mE in .//*[@href][not(@scope = 'external')] satisfies resolve-uri(substring-before(concat($mE/@href, '#'), '#'), base-uri($mE)) = $yo]"/>
    <sch:rule context="entry">
      <sch:assert id="BRDP-EXT-00014" role="error" test="empty($mapas) or not(matches(normalize-space(.), '^TBD$', 'i'))">Celda con «TBD» en una ficha del dosier.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00015">
    <sch:let name="yo" value="base-uri()"/>
    <sch:let name="mapas" value="for $mC in (for $n in 1 to count(tokenize($yo, '/')) - 1 return string-join(subsequence(tokenize($yo, '/'), 1, count(tokenize($yo, '/')) - $n), '/') || '/')[matches(., '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')], $mU in sort(uri-collection($mC)[matches(., '\.ditamap$', 'i')]) return (if (doc-available($mU)) then doc($mU) else ())[some $mE in .//*[@href][not(@scope = 'external')] satisfies resolve-uri(substring-before(concat($mE/@href, '#'), '#'), base-uri($mE)) = $yo]"/>
    <sch:rule context="*[text()][not(self::title)]">
      <sch:assert id="BRDP-EXT-00015" role="error" test="empty($mapas) or not(contains(., '  '))">Texto con dobles espacios en una ficha del dosier.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00016">
    <sch:let name="yo" value="base-uri()"/>
    <sch:let name="mapas" value="for $mC in (for $n in 1 to count(tokenize($yo, '/')) - 1 return string-join(subsequence(tokenize($yo, '/'), 1, count(tokenize($yo, '/')) - $n), '/') || '/')[matches(., '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')], $mU in sort(uri-collection($mC)[matches(., '\.ditamap$', 'i')]) return (if (doc-available($mU)) then doc($mU) else ())[some $mE in .//*[@href][not(@scope = 'external')] satisfies resolve-uri(substring-before(concat($mE/@href, '#'), '#'), base-uri($mE)) = $yo]"/>
    <sch:rule context="p">
      <sch:assert id="BRDP-EXT-00016" role="error" test="empty($mapas) or string-length(normalize-space(.)) gt 0">Párrafo vacío en una ficha del dosier.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00017">
    <sch:let name="yo" value="base-uri()"/>
    <sch:let name="mapas" value="for $mC in (for $n in 1 to count(tokenize($yo, '/')) - 1 return string-join(subsequence(tokenize($yo, '/'), 1, count(tokenize($yo, '/')) - $n), '/') || '/')[matches(., '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')], $mU in sort(uri-collection($mC)[matches(., '\.ditamap$', 'i')]) return (if (doc-available($mU)) then doc($mU) else ())[some $mE in .//*[@href][not(@scope = 'external')] satisfies resolve-uri(substring-before(concat($mE/@href, '#'), '#'), base-uri($mE)) = $yo]"/>
    <sch:rule context="entry[matches(normalize-space(.), '^FT-[0-9]{3}$')]">
      <sch:let name="fichas" value="for $h in $mapas//topicref[@href][not(@scope = 'external')] return (let $u := resolve-uri(substring-before(concat($h/@href, '#'), '#'), base-uri($h)) return if (doc-available($u)) then doc($u) else ())"/>
      <sch:assert id="BRDP-EXT-00017" role="error" test="empty($mapas) or normalize-space(.) = $fichas/*/@id">La ficha cita el código <sch:value-of select="normalize-space(.)"/>, que no corresponde a ninguna ficha del dosier.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00018">
    <sch:let name="yo" value="base-uri()"/>
    <sch:let name="mapas" value="for $mC in (for $n in 1 to count(tokenize($yo, '/')) - 1 return string-join(subsequence(tokenize($yo, '/'), 1, count(tokenize($yo, '/')) - $n), '/') || '/')[matches(., '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')], $mU in sort(uri-collection($mC)[matches(., '\.ditamap$', 'i')]) return (if (doc-available($mU)) then doc($mU) else ())[some $mE in .//*[@href][not(@scope = 'external')] satisfies resolve-uri(substring-before(concat($mE/@href, '#'), '#'), base-uri($mE)) = $yo]"/>
    <sch:rule context="note[@type = 'warning']">
      <sch:let name="fichas" value="for $h in $mapas//topicref[@href][not(@scope = 'external')] return (let $u := resolve-uri(substring-before(concat($h/@href, '#'), '#'), base-uri($h)) return if (doc-available($u)) then doc($u) else ())"/>
      <sch:assert id="BRDP-EXT-00018" role="error" test="empty($mapas) or exists($fichas/*[@id = 'precauciones'])">Hay avisos pero el dosier no tiene la ficha de precauciones.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00019">
    <sch:let name="yo" value="base-uri()"/>
    <sch:let name="mapas" value="for $mC in (for $n in 1 to count(tokenize($yo, '/')) - 1 return string-join(subsequence(tokenize($yo, '/'), 1, count(tokenize($yo, '/')) - $n), '/') || '/')[matches(., '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')], $mU in sort(uri-collection($mC)[matches(., '\.ditamap$', 'i')]) return (if (doc-available($mU)) then doc($mU) else ())[some $mE in .//*[@href][not(@scope = 'external')] satisfies resolve-uri(substring-before(concat($mE/@href, '#'), '#'), base-uri($mE)) = $yo]"/>
    <sch:rule context="step">
      <sch:assert id="BRDP-EXT-00019" role="error" test="empty($mapas) or exists(cmd)">Paso sin &lt;cmd&gt; en una ficha del dosier.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00020">
    <sch:let name="yo" value="base-uri()"/>
    <sch:let name="mapas" value="for $mC in (for $n in 1 to count(tokenize($yo, '/')) - 1 return string-join(subsequence(tokenize($yo, '/'), 1, count(tokenize($yo, '/')) - $n), '/') || '/')[matches(., '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')], $mU in sort(uri-collection($mC)[matches(., '\.ditamap$', 'i')]) return (if (doc-available($mU)) then doc($mU) else ())[some $mE in .//*[@href][not(@scope = 'external')] satisfies resolve-uri(substring-before(concat($mE/@href, '#'), '#'), base-uri($mE)) = $yo]"/>
    <sch:rule context="table">
      <sch:assert id="BRDP-EXT-00020" role="error" test="empty($mapas) or exists(title)">Tabla sin título en una ficha del dosier.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00021">
    <sch:let name="yo" value="base-uri()"/>
    <sch:let name="mapas" value="for $mC in (for $n in 1 to count(tokenize($yo, '/')) - 1 return string-join(subsequence(tokenize($yo, '/'), 1, count(tokenize($yo, '/')) - $n), '/') || '/')[matches(., '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')], $mU in sort(uri-collection($mC)[matches(., '\.ditamap$', 'i')]) return (if (doc-available($mU)) then doc($mU) else ())[some $mE in .//*[@href][not(@scope = 'external')] satisfies resolve-uri(substring-before(concat($mE/@href, '#'), '#'), base-uri($mE)) = $yo]"/>
    <sch:rule context="xref[not(@scope = 'external')]">
      <sch:assert id="BRDP-EXT-00021" role="error" test="empty($mapas) or exists(@href)">Referencia interna sin @href.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00022">
    <sch:let name="yo" value="base-uri()"/>
    <sch:let name="mapas" value="for $mC in (for $n in 1 to count(tokenize($yo, '/')) - 1 return string-join(subsequence(tokenize($yo, '/'), 1, count(tokenize($yo, '/')) - $n), '/') || '/')[matches(., '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')], $mU in sort(uri-collection($mC)[matches(., '\.ditamap$', 'i')]) return (if (doc-available($mU)) then doc($mU) else ())[some $mE in .//*[@href][not(@scope = 'external')] satisfies resolve-uri(substring-before(concat($mE/@href, '#'), '#'), base-uri($mE)) = $yo]"/>
    <sch:rule context="section">
      <sch:assert id="BRDP-EXT-00022" role="error" test="empty($mapas) or exists(title)">Sección sin título en una ficha del dosier.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00023">
    <sch:let name="yo" value="base-uri()"/>
    <sch:let name="mapas" value="for $mC in (for $n in 1 to count(tokenize($yo, '/')) - 1 return string-join(subsequence(tokenize($yo, '/'), 1, count(tokenize($yo, '/')) - $n), '/') || '/')[matches(., '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')], $mU in sort(uri-collection($mC)[matches(., '\.ditamap$', 'i')]) return (if (doc-available($mU)) then doc($mU) else ())[some $mE in .//*[@href][not(@scope = 'external')] satisfies resolve-uri(substring-before(concat($mE/@href, '#'), '#'), base-uri($mE)) = $yo]"/>
    <sch:rule context="topic">
      <sch:assert id="BRDP-EXT-00023" role="error" test="empty($mapas) or count($mapas) = 1">La ficha está referenciada desde más de un ditamap.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00024">
    <sch:let name="yo" value="base-uri()"/>
    <sch:let name="mapas" value="for $mC in (for $n in 1 to count(tokenize($yo, '/')) - 1 return string-join(subsequence(tokenize($yo, '/'), 1, count(tokenize($yo, '/')) - $n), '/') || '/')[matches(., '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')], $mU in sort(uri-collection($mC)[matches(., '\.ditamap$', 'i')]) return (if (doc-available($mU)) then doc($mU) else ())[some $mE in .//*[@href][not(@scope = 'external')] satisfies resolve-uri(substring-before(concat($mE/@href, '#'), '#'), base-uri($mE)) = $yo]"/>
    <sch:rule context="fig">
      <sch:assert id="BRDP-EXT-00024" role="error" test="empty($mapas) or exists(image)">Figura sin imagen en una ficha del dosier.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00025">
    <sch:let name="yo" value="base-uri()"/>
    <sch:let name="mapas" value="for $mC in (for $n in 1 to count(tokenize($yo, '/')) - 1 return string-join(subsequence(tokenize($yo, '/'), 1, count(tokenize($yo, '/')) - $n), '/') || '/')[matches(., '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')], $mU in sort(uri-collection($mC)[matches(., '\.ditamap$', 'i')]) return (if (doc-available($mU)) then doc($mU) else ())[some $mE in .//*[@href][not(@scope = 'external')] satisfies resolve-uri(substring-before(concat($mE/@href, '#'), '#'), base-uri($mE)) = $yo]"/>
    <sch:rule context="ul">
      <sch:assert id="BRDP-EXT-00025" role="error" test="empty($mapas) or count(li) ge 2">Lista con un solo elemento en una ficha del dosier.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00026">
    <sch:rule context="table">
      <sch:assert id="BRDP-EXT-00026" role="error" test="exists(title)">Toda tabla lleva título.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00027">
    <sch:let name="yo" value="base-uri()"/>
    <sch:let name="mapas" value="for $mC in (for $n in 1 to count(tokenize($yo, '/')) - 1 return string-join(subsequence(tokenize($yo, '/'), 1, count(tokenize($yo, '/')) - $n), '/') || '/')[matches(., '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')], $mU in sort(uri-collection($mC)[matches(., '\.ditamap$', 'i')]) return (if (doc-available($mU)) then doc($mU) else ())[some $mE in .//*[@href][not(@scope = 'external')] satisfies resolve-uri(substring-before(concat($mE/@href, '#'), '#'), base-uri($mE)) = $yo]"/>
    <sch:rule context="cmd">
      <sch:assert id="BRDP-EXT-00027" role="error" test="empty($mapas) or not(ends-with(normalize-space(.), '.'))">La instrucción del paso termina en punto.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00028">
    <sch:rule context="xref[@scope = 'external']">
      <sch:assert id="BRDP-EXT-00028" role="error" test="exists(@format)">Una referencia externa lleva @format.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00029">
    <sch:rule context="image">
      <sch:assert id="BRDP-EXT-00029" role="error" test="exists(@href)">Toda imagen lleva @href.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00030">
    <sch:rule context="step">
      <sch:assert id="BRDP-EXT-00030" role="error" test="exists(cmd)">Todo paso lleva &lt;cmd&gt;.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00031">
    <sch:rule context="section">
      <sch:assert id="BRDP-EXT-00031" role="error" test="exists(title)">Toda sección lleva título.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00032">
    <sch:rule context="ul">
      <sch:assert id="BRDP-EXT-00032" role="error" test="count(li) ge 2">Una lista tiene al menos dos elementos.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00033">
    <sch:let name="yo" value="base-uri()"/>
    <sch:let name="mapas" value="for $mC in (for $n in 1 to count(tokenize($yo, '/')) - 1 return string-join(subsequence(tokenize($yo, '/'), 1, count(tokenize($yo, '/')) - $n), '/') || '/')[matches(., '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')], $mU in sort(uri-collection($mC)[matches(., '\.ditamap$', 'i')]) return (if (doc-available($mU)) then doc($mU) else ())[some $mE in .//*[@href][not(@scope = 'external')] satisfies resolve-uri(substring-before(concat($mE/@href, '#'), '#'), base-uri($mE)) = $yo]"/>
    <sch:rule context="ph[@outputclass = 'codigo']">
      <sch:assert id="BRDP-EXT-00033" role="error" test="empty($mapas) or matches(normalize-space(.), '^FT-[0-9]{3}$')">Código mal formado en una ficha del dosier.</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00034">
    <sch:rule context="/*[matches(translate(lower-case(string(normalize-space(concat(@base, ' ', title)))), 'áéíóúüñ', 'aeiouun'), 'registro de inspecciones, pruebas y acciones de (reparacion|reacondicionamiento) en taller')]">
      <sch:let name="campos" value=".//thead//entry ! lower-case(normalize-space(.))"/>
      <sch:assert id="BRDP-EXT-00034a" role="error" test="$campos = 'fecha'">El registro de inspecciones, pruebas y acciones en taller no tiene el campo obligatorio «Fecha».</sch:assert>
      <sch:assert id="BRDP-EXT-00034b" role="error" test="$campos = 'firma'">El registro de inspecciones, pruebas y acciones en taller no tiene el campo obligatorio «Firma».</sch:assert>
    </sch:rule>
    <sch:rule context="/*[matches(translate(lower-case(string(normalize-space(concat(@base, ' ', title)))), 'áéíóúüñ', 'aeiouun'), 'registro de inspecciones, pruebas y acciones de (reparacion|reacondicionamiento) a bordo')]">
      <sch:let name="campos" value=".//thead//entry ! lower-case(normalize-space(.))"/>
      <sch:assert id="BRDP-EXT-00034c" role="error" test="$campos = 'fecha'">El registro de inspecciones, pruebas y acciones a bordo no tiene el campo obligatorio «Fecha».</sch:assert>
      <sch:assert id="BRDP-EXT-00034d" role="error" test="$campos = 'firma'">El registro de inspecciones, pruebas y acciones a bordo no tiene el campo obligatorio «Firma».</sch:assert>
    </sch:rule>
  </sch:pattern>
  <sch:pattern id="p-BRDP-EXT-00035">
    <sch:let name="yo" value="base-uri()"/>
    <sch:let name="mapas" value="for $mC in (for $n in 1 to count(tokenize($yo, '/')) - 1 return string-join(subsequence(tokenize($yo, '/'), 1, count(tokenize($yo, '/')) - $n), '/') || '/')[matches(., '^file:/+[A-Za-z]:/.+/$|^file:/+[^:]+/.+/$')], $mU in sort(uri-collection($mC)[matches(., '\.ditamap$', 'i')]) return (if (doc-available($mU)) then doc($mU) else ())[some $mE in .//*[@href][not(@scope = 'external')] satisfies resolve-uri(substring-before(concat($mE/@href, '#'), '#'), base-uri($mE)) = $yo]"/>
    <sch:rule context="li">
      <sch:assert id="BRDP-EXT-00035" role="error" test="empty($mapas) or string-length(normalize-space(.)) gt 0">Elemento de lista vacío.</sch:assert>
    </sch:rule>
  </sch:pattern>
</sch:schema>
