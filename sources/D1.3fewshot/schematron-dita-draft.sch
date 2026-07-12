<?xml version="1.0" encoding="UTF-8"?>
<sch:schema xmlns:sch="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt2">
  <sch:title>Draft DITA Business Rules Schematron (BRDP-D1) — combined, all 6 topic types</sch:title>

  <!-- NOTE: draft for review in oXygen. Rules marked needs-review in the source JSON
       (BRDP-D1-00186, 00031, 00128, 00065, 00131, 00344, 00359, 00107) are best-effort
       interpretations of ambiguous source text — verify against real project decisions
       before treating as final. -->

  <sch:pattern>
    <sch:rule context="ol//ol//ol//ol//ol">
      <sch:assert role="error" id="BRDP-D1-00186" test="not(preceding::title or child::title) and count(ancestor-or-self::ol) &gt;= 5">Nested lists must not exceed 5 levels, and level 5 must not carry a title.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="substeps">
      <sch:assert role="error" id="BRDP-D1-00187" test="count(substep) >= 2">A &lt;substeps&gt; element must contain at least two &lt;substep&gt; children; single substeps are not allowed.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="hazardstatement | note[@type=('warning','caution','danger')]">
      <sch:assert role="warning" id="BRDP-D1-00031" test="ancestor::safety or (ancestor::taskbody and (parent::prereq or ancestor::context))">Danger/warning/caution/notice elements in a task should appear within the safety requirements section (safety, or prereq/context in generic task).</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="fig[@id] | table[@id]">
      <sch:assert role="warning" id="BRDP-D1-00092" test="matches(@id, '^(fig|tbl)-[0-9]{3,}$')">Figure and table IDs must follow the pattern fig-NNN / tbl-NNN (e.g. fig-001, tbl-001).</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="note[@type='warning']">
      <sch:assert role="warning" id="BRDP-D1-00033" test="false()">Use &lt;hazardstatement type="warning"&gt; instead of &lt;note type="warning"&gt; for warnings in technical content.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="title">
      <sch:assert role="error" id="BRDP-D1-00095" test="not(descendant::xref)">The &lt;xref&gt; element must not be used inside &lt;title&gt;.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="fig | table">
      <sch:assert role="warning" id="BRDP-D1-00095b" test="child::title">Figures and tables should include a &lt;title&gt; element.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="fig | table">
      <sch:assert role="warning" id="BRDP-D1-00128" test="not(desc) or normalize-space(desc) != ''">If a &lt;desc&gt; is present in a figure or table, it must not be empty.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="area">
      <sch:assert role="error" id="BRDP-D1-00132" test="count(shape) = 1">Each &lt;area&gt; in an imagemap must define exactly one &lt;shape&gt; (circle, poly, or rect).</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="footnote | fn">
      <sch:assert role="error" id="BRDP-D1-00172" test="false()">The &lt;footnote&gt;/&lt;fn&gt; element must not be used.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="draft-comment">
      <sch:assert role="error" id="BRDP-D1-00356" test="false()">The &lt;draft-comment&gt; element must not appear in final output.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="xref[ancestor::p or ancestor::li]">
      <sch:assert role="warning" id="BRDP-D1-00524" test="@href or @keyref">SIR elements (parts, supplies, tools) should be referenced by name or ID using &lt;xref&gt;.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="i | u | tt | sup | sub">
      <sch:assert role="warning" id="BRDP-D1-00026" test="false()">Only &lt;b&gt; (bold) should be used to emphasize text; other highlight elements are discouraged.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="copyright[not(ancestor::topic[@id='copyright']) and not(@conref)]">
      <sch:assert role="warning" id="BRDP-D1-00065" test="false()">Use a reusable &lt;copyright&gt; topic (referenced via conref) instead of inline copyright metadata.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <!-- BRDP-D1-00089 DESACTIVADA: revised es EMPTY en el DTD/XSD base de DITA
       (confirmado por error real de oXygen: "content of element type revised
       must match EMPTY"). No admite ni comment hijo ni texto. El "motivo del
       cambio" no tiene sitio formal en DITA base; si el proyecto lo necesita,
       habria que usar otro elemento (p.ej. data name="reason-for-update"
       value="..." en prolog) o un atributo custom de una especializacion
       propia. Pendiente de decidir con el usuario antes de reactivar.

    sch:pattern
    sch:rule context="critdates/revised"
      sch:assert role="warning" id="BRDP-D1-00089" test="not(@modified) or comment": If revised metadata is used, it should include a comment explaining the reason for update. /sch:assert
    /sch:rule
  /sch:pattern
  -->

  <sch:pattern>
    <sch:rule context="object/@type | video/@format | audio/@format">
      <sch:assert role="error" id="BRDP-D1-00130" test="matches(., '(mp4|wav|mp3)$', 'i')">Only video (mp4) and audio (wav, mp3) formats are permitted for multimedia objects.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="choicetable[.//xref]">
      <sch:assert role="warning" id="BRDP-D1-00131" test="false()">Use &lt;dl&gt; (definition list) instead of &lt;choicetable&gt; for download components.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="image/@href">
      <sch:assert role="warning" id="BRDP-D1-00344" test="matches(tokenize(., '[\\/]')[last()], '^ICN-[A-Za-z0-9]+-[0-9]{3}\.[A-Za-z0-9]+$')">Illustration filenames should follow the ICN pattern: ICN-&lt;model-code&gt;-&lt;issue-number&gt;.&lt;ext&gt; (e.g. ICN-A320-001.png).</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="object/@type">
      <sch:assert role="warning" id="BRDP-D1-00359" test="matches(., '(xlsx|py)$', 'i')">Only the listed attachment file types are permitted (e.g. .xlsx, .py) outside of multimedia files.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="image/@href">
      <sch:assert role="error" id="BRDP-D1-00361" test="matches(., '\.(jpe?g|gif|png)$', 'i')">Photographs must use JPEG, GIF, or PNG format.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="topic | concept | task | map">
      <sch:report role="warning" id="BRDP-D1-00313-shortdesc" test="not(shortdesc) and not(topicmeta/shortdesc)">Missing &lt;shortdesc&gt; metadata.</sch:report>
      <sch:report role="warning" id="BRDP-D1-00313-author" test="not(.//author)">Missing &lt;author&gt; metadata.</sch:report>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="critdates">
      <sch:assert role="warning" id="BRDP-D1-00049" test="child::created and child::revised">If &lt;critdates&gt; is used, it should include both &lt;created&gt; and &lt;revised&gt;.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="topic | concept | task | map | reference | glossentry">
      <sch:assert role="error" id="BRDP-D1-00118" test="child::title and normalize-space(child::title) != ''">A non-empty &lt;title&gt; is mandatory on the topic/section root element.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="topic | concept | task | map | bookmap">
      <sch:assert role="error" id="BRDP-D1-00020" test="@xml:lang = 'en-US' or ancestor::*/@xml:lang = 'en-US'">Content must be written in U.S. English (xml:lang="en-US").</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="xref[not(ancestor::title)]">
      <sch:assert role="warning" id="BRDP-D1-00107" test="matches(preceding-sibling::text()[1], 'Refer to:\s*$')">Cross-references should be preceded by the text "Refer to: ".</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="topicref | chapter | part">
      <sch:assert role="warning" id="BRDP-D1-00180" test="count(ancestor::topicref | ancestor::chapter | ancestor::part) &lt; 2">Topic nesting should not exceed 2 levels within a map/bookmap.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="topicmeta[not(data[@name='security-classification'])]">
      <sch:assert role="warning" id="BRDP-D1-00016" test="false()">Consider adding a &lt;data name="security-classification" value="..."/&gt; element in topicmeta.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="data[@name='quality-assurance']">
      <sch:assert role="error" id="BRDP-D1-00017" test="@value = ('Unverified','tabletop','onObject','tableTopAndOnObject')">quality-assurance data value must be one of: Unverified, tabletop, onObject, tableTopAndOnObject.</sch:assert>
    </sch:rule>
  </sch:pattern>

  <sch:pattern>
    <sch:rule context="reltable">
      <sch:assert role="warning" id="BRDP-D1-00037" test="child::relrow and relrow/child::relcell">If &lt;reltable&gt; is used, it must contain properly structured &lt;relrow&gt;/&lt;relcell&gt; elements.</sch:assert>
    </sch:rule>
  </sch:pattern>

</sch:schema>
