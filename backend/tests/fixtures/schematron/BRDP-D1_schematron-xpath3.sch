<?xml version="1.0" encoding="UTF-8"?>
<sch:schema xmlns:sch="http://purl.oclc.org/dsdl/schematron"
            xmlns:xs="http://www.w3.org/2001/XMLSchema"
            queryBinding="xslt3">
  <sch:title>SATEX Business Rules Schematron (BRDP-D1) — XPath 3.0</sch:title>

  <sch:ns prefix="xs" uri="http://www.w3.org/2001/XMLSchema"/>

  <!-- ==================================================================
       QUÉ ES ESTE FICHERO

       Las mismas SIETE reglas de BRDP-D1_schematron-xpath2.sch (más
       BRDP-D1_schematron-xpath2-ambito-mapa.sch), con la misma intención,
       escritas para un procesador XPath 3.0.

       NO SUSTITUYE AL JUEGO xpath2. El motor integrado de XMetaL es
       XSLT 2.0: este fichero NO corre ahí. Está para validación externa
       con un procesador XSLT 3.0 (Saxon-HE 9.8+ o superior), donde los
       documentos tienen URI base real y document() resuelve rutas
       relativas — que es lo que en XMetaL obligó al marcador
       @@URI-CARPETA-DOSIER@@ y a la segunda pasada sobre el dosier
       virtual. Aquí ni una cosa ni la otra hacen falta.

       QUÉ SE ARREGLA RESPECTO DE LA VERSIÓN ANTERIOR DE ESTE FICHERO

       1. VALOR HEREDADO. Las tablas del corpus fusionan celdas con
          morerows: una fila fusionada no tiene marcado propio para esas
          columnas. La versión anterior leía solo la fila y daba falsos
          positivos. Ahora se calcula el valor EFECTIVO.

       2. LA COLUMNA, POR @colname. La versión anterior usaba entry[1]
          como columna de exención: en una fila fusionada entry[1] no es
          la primera columna. Ahora se localiza "Part" por @colname, con
          respaldo a la primera del encabezado para las tablas que no
          declaran "Part" (IDENTIFICACIÓN DE EQUIPOS).

       3. UNA FILA, UN AVISO. El contexto de las reglas de tabla es la
          FILA, no la tabla: la versión anterior daba un solo aviso por
          tabla con un every/satisfies y no se podía saber qué fila lo
          causó.

       4. VARIAS FIGURAS. El formato del LCA admite varias figuras en la
          misma celda, una por párrafo, con su marca. La versión anterior
          exigía exactamente una.

       5. EL ESCALÓN, ENTRE LAS DOS HOJAS. 00004a exigía
          <ph keyref="Escalon"/> en la planificación (Navantia no lo pide)
          y 00004b comparaba el procedimiento contra la clave del ditamap,
          no contra la otra hoja. Ambas se retiran: 00004 compara el VALOR
          de las dos hojas, que es el requisito literal.

       6. LAS ADVERTENCIAS, CONTRA EL <cmd>. En la ficha de precauciones
          las advertencias NO son <note type="warning">: cada una es el
          <cmd> de un paso. La versión anterior comparaba note contra note
          y por eso no llegaba a comparar nada. Además ahora se resuelve
          el conref (diez de las dieciséis advertencias del LCA llegan
          así), se excluye la propia ficha de precauciones y los
          componentes reutilizables, y hay centinela.

       LO QUE APORTA XPATH 3.0 Y AQUÍ SE USA

       - FUNCIONES ANÓNIMAS (inline function expressions) y funciones de
         orden superior. Son la razón de ser de este fichero: en XPath 2.0
         no hay funciones propias, así que el cálculo del valor efectivo
         va INLINEADO una vez por columna — siete copias de la misma forma
         en el .sch de xpath2, a propósito y con el riesgo que eso lleva.
         Aquí se declara UNA VEZ como variable global y se invoca.
       - Expresiones "let ... return" dentro del propio XPath, que en 2.0
         solo existen en XQuery.
       - fn:analyze-string, para no depender de una regex con grupos
         repetidos donde lo que se quiere decir es "todas las piezas
         casan".
       - fn:head y el operador de mapa simple "!".

       NO se usan fn:for-each, fn:filter ni fn:fold-left aunque sean 3.0:
       exigen funciones que admitan item(), y estas están tipadas
       element(). Un "for ... return" y un predicado hacen lo mismo sin
       relajar el tipo. Nada de mapas, arrays ni el operador "=>": eso es
       XPath 3.1.


       SIN NAMESPACES en los patrones: el corpus DITA llega sin prefijos.
       ================================================================== -->


  <!-- ==================================================================
       FUNCIONES COMPARTIDAS

       Declaradas como variables globales. Son funciones puras: todo lo
       que necesitan entra por parámetro, no por contexto.
       ================================================================== -->

  <!-- @colname de la columna cuyo rótulo es exactamente $rotulo. -->
  <sch:let name="colDe"
           value="function($cab as element()*, $rotulo as xs:string) as xs:string {
                    string(($cab/entry[normalize-space(.) = $rotulo]/@colname)[1])
                  }"/>

  <!-- @colname de la columna cuyo rótulo CONTIENE $fragmento. El rótulo
       de la figura es largo y varía; se busca por fragmento estable. -->
  <sch:let name="colContiene"
           value="function($cab as element()*, $fragmento as xs:string) as xs:string {
                    string(($cab/entry[contains(normalize-space(.), $fragmento)]/@colname)[1])
                  }"/>

  <!-- La columna de exención: "Part" si la tabla la declara; si no, la
       primera del encabezado. Hay tablas con Cant./NOC/NCAGE y sin
       columna "Part", y sin este respaldo la regla enmudecería ahí. -->
  <sch:let name="colPart"
           value="function($cab as element()*) as xs:string {
                    string(($cab/entry[normalize-space(.) = 'Part']/@colname,
                            $cab/entry[1]/@colname)[1])
                  }"/>

  <!-- EL VALOR EFECTIVO DE UNA CELDA.

       Si la fila tiene celda propia para esa columna, su texto. Si no la
       tiene, la fusionó una fila anterior: se busca la última fila
       anterior que sí la declara y se comprueba que su @morerows alcance
       hasta aquí. Si no alcanza (o no hay tal fila), la celda está
       realmente vacía y vale ''.

       Es lo que el lector ve en pantalla, y es lo que se juzga. -->
  <sch:let name="valor"
           value="function($fila as element(), $col as xs:string) as xs:string {
                    if ($col = '') then ''
                    else if ($fila/entry[@colname = $col]) then
                      normalize-space($fila/entry[@colname = $col][1])
                    else
                      let $abre  := ($fila/preceding-sibling::row[entry[@colname = $col]])[last()],
                          $salto := count($fila/preceding-sibling::row)
                                    - count($abre/preceding-sibling::row)
                      return
                        if (empty($abre)) then ''
                        else if (number(($abre/entry[@colname = $col][1]/@morerows, '0')[1]) ge $salto)
                             then normalize-space($abre/entry[@colname = $col][1])
                             else ''
                  }"/>

  <!-- El documento al que apunta un topicref, o la secuencia vacía si no
       se puede abrir. Se descartan las referencias externas y se recorta
       el fragmento. -->
  <sch:let name="docFicha"
           value="function($tr as element()) as document-node()* {
                    let $h    := string($tr/@href),
                        $ruta := if (contains($h, '#')) then substring-before($h, '#') else $h
                    return
                      if ($ruta = '' or $tr/@scope = 'external' or starts-with($ruta, 'http'))
                      then ()
                      else let $u := resolve-uri($ruta, base-uri($tr))
                           return if (doc-available($u)) then doc($u) else ()
                  }"/>

  <!-- El elemento al que apunta un @conref, o la secuencia vacía si no se
       puede resolver. El fragmento DITA es "idTema/idElemento". -->
  <sch:let name="nodoConref"
           value="function($n as element()) as element()* {
                    if (empty($n/@conref)) then ()
                    else
                      let $c    := string($n/@conref),
                          $ruta := if (contains($c, '#')) then substring-before($c, '#') else $c,
                          $frag := if (contains($c, '#')) then substring-after($c, '#') else '',
                          $id   := if (contains($frag, '/')) then substring-after($frag, '/') else $frag,
                          $doc  := if ($ruta = '') then root($n)
                                   else let $u := resolve-uri($ruta, base-uri($n))
                                        return if (doc-available($u)) then doc($u) else ()
                      return
                        if (empty($doc) or $id = '') then ()
                        else ($doc//*[@id = $id])[1]
                  }"/>

  <!-- El texto de una nota: el del componente si llega por conref, el
       suyo si está escrita en la ficha. Siempre normalizado. -->
  <sch:let name="textoNota"
           value="function($n as element()) as xs:string {
                    let $ref := $nodoConref($n)
                    return normalize-space(string(($ref, $n)[1]))
                  }"/>

  <!-- Una nota es advertencia si lo dice ella o si lo dice el componente
       que reutiliza: en la ficha, la nota con conref llega vacía y sin
       @type. -->
  <sch:let name="esAdvertencia"
           value="function($n as element()) as xs:boolean {
                    let $ref := $nodoConref($n)
                    return $n/@type = 'warning' or $ref/@type = 'warning'
                  }"/>

  <!-- Nota que se reutiliza y cuyo componente no se ha podido leer. -->
  <sch:let name="conrefRoto"
           value="function($n as element()) as xs:boolean {
                    exists($n/@conref) and empty($nodoConref($n))
                  }"/>


  <!-- ==================================================================
       BRDP-EXT-00001 — Campo cantidad de repuestos no vacío

       Contexto: la FILA. Un aviso por fila.
       ================================================================== -->
  <sch:pattern id="p-BRDP-EXT-00001">
    <sch:rule context="*[title = ('LISTA DE MATERIAL OBLIGATORIO',
                                  'LISTA DE MATERIAL IMPREVISTO',
                                  'HERRAMIENTAS Y EQUIPOS DE PRUEBA')]
                        //table[tgroup/thead/row/entry[normalize-space(.) = 'Cant.']]
                        /tgroup/tbody/row">
      <sch:let name="cab"  value="ancestor::tgroup[1]/thead/row[1]"/>
      <sch:let name="part" value="$valor(., $colPart($cab))"/>
      <sch:let name="cant" value="$valor(., $colDe($cab, 'Cant.'))"/>

      <sch:assert role="error" id="BRDP-EXT-00001" test="$part = '' or $cant != ''">
        En tablas con columna "Cant." dentro de los temas "LISTA DE MATERIAL OBLIGATORIO", "LISTA DE MATERIAL IMPREVISTO" o "HERRAMIENTAS Y EQUIPOS DE PRUEBA", la columna "Cant." no puede estar vacía cuando la columna "Part" tenga contenido.
      </sch:assert>
    </sch:rule>
  </sch:pattern>


  <!-- ==================================================================
       BRDP-EXT-00002 — Valores permitidos para NCAGE

       Se aplica a CUALQUIER tabla que declare la columna, sin acotar por
       título de tema: un NCAGE es un NCAGE lo ponga quien lo ponga.
       Acotar por título es lo que dejó muda a la regla de la figura en
       Template Digital; no se repite el error.

       EL CENTINELA DE DATO DESCONOCIDO ES EL GUION A SECAS, "-". "-." es
       un valor mal puesto, no un centinela.
       ================================================================== -->
  <sch:pattern id="p-BRDP-EXT-00002">
    <sch:rule context="table[tgroup/thead/row/entry[normalize-space(.) = 'NCAGE']]/tgroup/tbody/row">
      <sch:let name="cab"   value="ancestor::tgroup[1]/thead/row[1]"/>
      <sch:let name="part"  value="$valor(., $colPart($cab))"/>
      <sch:let name="ncage" value="$valor(., $colDe($cab, 'NCAGE'))"/>

      <sch:assert role="error" id="BRDP-EXT-00002"
                  test="$part = '' or $ncage = '-' or matches($ncage, '^[A-Z0-9]{5}$')">
        En tablas con columna "NCAGE", cada fila debe contener exactamente 5 caracteres alfanuméricos en mayúsculas (A-Z, 0-9) o "-" (solo si el dato es desconocido). Filas con la columna "Part" vacía están exentas.
      </sch:assert>
    </sch:rule>
  </sch:pattern>


  <!-- ==================================================================
       BRDP-EXT-00003 — Valores obligatorios para Part Number

       OJO: la regla exige valor, no exige que el centinela sea "-". El
       mensaje lo pide; el test acepta cualquier texto no vacío. Se
       mantiene el comportamiento del juego xpath2 a propósito: cambiarlo
       aquí haría que los dos ficheros dijeran cosas distintas.
       ================================================================== -->
  <sch:pattern id="p-BRDP-EXT-00003">
    <sch:rule context="table[tgroup/thead/row/entry[normalize-space(.) = 'Part Number']]/tgroup/tbody/row">
      <sch:let name="cab"        value="ancestor::tgroup[1]/thead/row[1]"/>
      <sch:let name="part"       value="$valor(., $colPart($cab))"/>
      <sch:let name="partNumber" value="$valor(., $colDe($cab, 'Part Number'))"/>

      <sch:assert role="error" id="BRDP-EXT-00003" test="$part = '' or $partNumber != ''">
        En tablas con columna "Part Number", cada fila debe indicar un valor; si se desconoce, debe indicarse con el carácter "-" en lugar de dejarse vacío. Filas con la columna "Part" vacía están exentas.
      </sch:assert>
    </sch:rule>
  </sch:pattern>


  <!-- ==================================================================
       BRDP-EXT-00004 — El escalón de mantenimiento de la planificación
       coincide con el del procedimiento.

       EL REQUISITO, LITERAL: «El valor del "escalón de mantenimiento" de
       la "HOJA DE DATOS DE PLANIFICACIÓN CONSOLIDADA" debe coincidir con
       el indicado en el de la "HOJA RESUMEN DE PROCEDIMIENTO".» Es una
       comparación de VALORES. No pide <ph keyref="Escalon"/> en ninguna
       de las dos: por eso 00004a y 00004b están retiradas.

       CONTEXTO: EL DITAMAP. Mira dos fichas a la vez y, cuando una celda
       usa keyref, el <keydef> del mapa. Con un procesador XSLT 3.0 las
       tres cosas se alcanzan desde el mapa con document(), sin necesidad
       del dosier virtual de la segunda pasada. Validando una ficha suelta
       esta regla no dispara: no hay desde dónde mirar.

       DÓNDE ESTÁ EL ESCALÓN EN CADA HOJA (LCA de referencia):
         - Planificación, tema "DATOS PARA LA PLANIFICACIÓN": rótulo en
           thead, valor en la primera fila de tbody, misma columna.
         - Procedimiento: rótulo y valor en la MISMA celda —
           <entry><p><b>ESCALÓN DE MANTENIMIENTO</b></p><p>2RRTT</p></entry>.

       EL VALOR DE UNA CELDA: si lleva ph[@keyref = 'Escalon'], el
       <keyword> del primer <keydef> cuya @keys contenga el token Escalon;
       si no, su texto normalizado. Un keyref que ningún keydef resuelve
       vale '': no hay valor.

       CALLA solo si ninguna de las dos hojas trae el escalón: eso no es
       un dosier con estas hojas.
       ================================================================== -->
  <sch:pattern id="p-BRDP-EXT-00004">
    <sch:rule context="map">

      <sch:let name="docs"
               value="for $tr in //topicref[@href] return $docFicha($tr)"/>

      <sch:let name="clave"
               value="normalize-space((//keydef[tokenize(normalize-space(@keys), '\s+') = 'Escalon']
                                       //keyword)[1])"/>

      <sch:let name="tablasPlan"
               value="$docs//*[normalize-space(title) = 'DATOS PARA LA PLANIFICACIÓN']
                      //table[tgroup/thead/row/entry[normalize-space(.) = 'ESCALÓN DE MANTENIMIENTO']]"/>

      <sch:let name="celdasProc"
               value="$docs//entry[not(parent::row/parent::thead)]
                                  [p/b[normalize-space(.) = 'ESCALÓN DE MANTENIMIENTO']]"/>

      <!-- Localización de la celda de la planificación: por @colname del
           rótulo; si el rótulo no lo lleva, por posición. En el .sch de
           xpath2 esto está escrito dos veces porque no hay funciones
           propias; aquí va una sola vez. -->
      <sch:let name="escalonPlan"
               value="function($t as element()) as xs:string {
                        let $rotulo := ($t/tgroup/thead/row[1]
                                          /entry[normalize-space(.) = 'ESCALÓN DE MANTENIMIENTO'])[1],
                            $celda  := (if ($rotulo/@colname)
                                        then $t/tgroup/tbody/row[1]/entry[@colname = $rotulo/@colname]
                                        else ($t/tgroup/tbody/row[1]/entry)
                                                [count($rotulo/preceding-sibling::entry) + 1])[1]
                        return if ($celda//ph[@keyref = 'Escalon'])
                               then $clave
                               else normalize-space($celda)
                      }"/>

      <sch:let name="escalonProc"
               value="function($c as element()) as xs:string {
                        if ($c//ph[@keyref = 'Escalon'])
                        then $clave
                        else normalize-space(($c/p[not(b)])[1])
                      }"/>

      <!-- Con "for ... return", no con fn:for-each: las funciones de orden
           superior de XPath 3.0 exigen que el parámetro admita item(), y
           estas están tipadas element(). Coercionarlas para lucir la
           llamada sería cambiar el tipo por la forma. -->
      <sch:let name="valoresPlan" value="for $t in $tablasPlan return $escalonPlan($t)"/>
      <sch:let name="valoresProc" value="for $c in $celdasProc return $escalonProc($c)"/>

      <sch:assert role="error" id="BRDP-EXT-00004a"
                  test="exists($tablasPlan) = exists($celdasProc)">
        El escalón de mantenimiento aparece solo en una de las dos hojas: la "HOJA DE DATOS DE PLANIFICACIÓN CONSOLIDADA" (tema "DATOS PARA LA PLANIFICACIÓN") y la "HOJA RESUMEN DE PROCEDIMIENTO" tienen que indicarlo las dos, y con el mismo valor.
      </sch:assert>

      <sch:assert role="error" id="BRDP-EXT-00004b"
                  test="empty($tablasPlan) or (every $v in $valoresPlan satisfies $v != '')">
        La hoja de planificación no indica el escalón de mantenimiento: la celda está vacía, o usa &lt;ph keyref="Escalon"/&gt; y ningún ditamap declara esa clave. Sin ese valor no se puede comprobar que coincida con la HOJA RESUMEN DE PROCEDIMIENTO.
      </sch:assert>

      <sch:assert role="error" id="BRDP-EXT-00004c"
                  test="empty($celdasProc) or (every $v in $valoresProc satisfies $v != '')">
        La HOJA RESUMEN DE PROCEDIMIENTO no indica el escalón de mantenimiento: la celda no trae valor, o usa &lt;ph keyref="Escalon"/&gt; y ningún ditamap declara esa clave. Sin ese valor no se puede comprobar que coincida con la hoja de planificación.
      </sch:assert>

      <!-- Los vacíos se descartan: de esos ya avisan las dos asserts
           anteriores, y arrastrarlos aquí daría dos avisos por el mismo
           hecho. -->
      <sch:assert role="error" id="BRDP-EXT-00004d"
                  test="every $p in $valoresPlan[. != ''],
                              $q in $valoresProc[. != ''] satisfies $p = $q">
        El escalón de mantenimiento de la HOJA RESUMEN DE PROCEDIMIENTO no coincide con el de la HOJA DE DATOS DE PLANIFICACIÓN CONSOLIDADA (tema "DATOS PARA LA PLANIFICACIÓN"). Planificación: <sch:value-of select="string-join(distinct-values($valoresPlan[. != '']), ', ')"/>. Procedimiento: <sch:value-of select="string-join(distinct-values($valoresProc[. != '']), ', ')"/>.
      </sch:assert>
    </sch:rule>
  </sch:pattern>


  <!-- ==================================================================
       BRDP-EXT-00005 — Valores permitidos para NOC

       Como NCAGE: cualquier tabla que declare la columna, sin acotar por
       título. Trece dígitos, o el guion a secas.
       ================================================================== -->
  <sch:pattern id="p-BRDP-EXT-00005">
    <sch:rule context="table[tgroup/thead/row/entry[normalize-space(.) = 'NOC']]/tgroup/tbody/row">
      <sch:let name="cab"  value="ancestor::tgroup[1]/thead/row[1]"/>
      <sch:let name="part" value="$valor(., $colPart($cab))"/>
      <sch:let name="noc"  value="$valor(., $colDe($cab, 'NOC'))"/>

      <sch:assert role="error" id="BRDP-EXT-00005"
                  test="$part = '' or $noc = '-' or matches($noc, '^[0-9]{13}$')">
        En tablas con columna "NOC", cada fila debe contener exactamente 13 valores numéricos (0-9) o "-" (solo si el dato es desconocido). Filas con la columna "Part" vacía están exentas.
      </sch:assert>
    </sch:rule>
  </sch:pattern>


  <!-- ==================================================================
       BRDP-EXT-00006 — Figuras y marcas tras la fila "Repuestos"

       LA FILA SEPARADORA MANDA. La figura solo se exige a las filas
       POSTERIORES a la fila "Repuestos". Si esa fila no existe, la lista
       no declara repuestos y la regla calla: es correcto, no un fallo.

       EL FORMATO ES EL DEL LCA: "Figura N". Se admiten VARIAS cuando la
       pieza sale en varias figuras, que es como el LCA lo escribe: una
       figura por párrafo en la misma celda, con su marca. El
       normalize-space del valor efectivo las deja separadas por un
       espacio, y por eso el patrón se repite.

       La comprobación va con analyze-string en lugar de una sola
       expresión regular con grupos repetidos: separa el valor en piezas y
       exige que TODAS casen, que es lo que de verdad se quiere decir, y
       deja de depender de cómo el motor cuente los grupos.
       ================================================================== -->
  <sch:pattern id="p-BRDP-EXT-00006">
    <sch:rule context="*[title = 'LISTA DE MATERIAL OBLIGATORIO']
                        //table[tgroup/thead/row/entry[contains(normalize-space(.), 'Documento Técnico')]
                            and tgroup/thead/row/entry[normalize-space(.) = 'Marca']]
                        /tgroup/tbody/row[preceding-sibling::row[entry[normalize-space(.) = 'Repuestos']]]">

      <sch:let name="cab"    value="ancestor::tgroup[1]/thead/row[1]"/>
      <sch:let name="part"   value="$valor(., $colPart($cab))"/>
      <sch:let name="docTec" value="$valor(., $colContiene($cab, 'Documento Técnico'))"/>
      <sch:let name="marca"  value="$valor(., $colDe($cab, 'Marca'))"/>

      <!-- analyze-string parte el valor en las piezas que casan y las que
           no. Vale si hay al menos una figura y lo que queda fuera es
           solo el espacio que las separa: un "Figura 9 y la 10" tiene
           sobrante con contenido y no pasa. -->
      <sch:let name="figurasHalladas"
               value="analyze-string($docTec, 'Figura\s+[0-9]+')/*[local-name() = 'match']"/>
      <sch:let name="sobraEnDocTec"
               value="analyze-string($docTec, 'Figura\s+[0-9]+')
                        /*[local-name() = 'non-match'][normalize-space(.) != '']"/>
      <sch:let name="marcas"
               value="tokenize(normalize-space($marca), '\s+')[. != '']"/>

      <sch:assert role="error" id="BRDP-EXT-00006a"
                  test="$part = ''
                        or (exists($figurasHalladas) and empty($sobraEnDocTec))">
        En "LISTA DE MATERIAL OBLIGATORIO", tras la fila "Repuestos", la columna "Documento Técnico / Manual Técnico / Número de Plano" debe contener un valor con formato "Figura &lt;Número&gt;" (ej. "Figura 9") y no puede estar vacía, salvo cuando la columna "Part" esté vacía. Si la pieza sale en varias figuras, se indican todas con ese mismo formato. Valor leído: "<sch:value-of select="$docTec"/>".
      </sch:assert>

      <sch:assert role="error" id="BRDP-EXT-00006b"
                  test="$part = ''
                        or ($marca != '' and (every $m in $marcas satisfies matches($m, '^[0-9]+$')))">
        En "LISTA DE MATERIAL OBLIGATORIO", tras la fila "Repuestos", la columna "Marca" debe contener un valor numérico y no puede estar vacía, salvo cuando la columna "Part" esté vacía. Si la pieza sale en varias figuras, lleva una marca por figura. Valor leído: "<sch:value-of select="$marca"/>".
      </sch:assert>
    </sch:rule>
  </sch:pattern>


  <!-- ==================================================================
       BRDP-EXT-00007 — Toda advertencia del procedimiento, recogida en
       PRECAUCIONES DE SEGURIDAD.

       DÓNDE ESTÁN RECOGIDAS. En la ficha titulada "PRECAUCIONES DE
       SEGURIDAD", y NO como <note type="warning"> sino en texto plano:
       cada advertencia es el <cmd> de un paso. Comparar note contra note
       —lo que hacía la versión anterior de este fichero— no llega a
       comparar nada.

       CONTRA EL <cmd>, NO CONTRA EL <step>. El texto de un paso es su
       <cmd>; el <info> que lo acompaña es la explicación. En el LCA el
       último paso lleva un <info> largo, y comparar contra cualquier
       elemento del paso daría por recogida una advertencia que solo
       aparece dentro de esa explicación.

       EL ALCANCE ES TODA FICHA, no solo Procedimiento/, y es deliberado
       aunque el requisito hable del procedimiento: en el LCA las
       advertencias están repartidas por Ficha_E\ y Ficha_T\. Vigilar de
       más aquí es seguro; acotar dejaría la regla muda sobre el corpus
       que decide.

       SE EXCLUYEN: las de la propia ficha de precauciones (compararla
       consigo misma no dice nada), las que están dentro de un componente
       reutilizable (la advertencia se juzga donde el lector la ve, en la
       ficha que la reutiliza) y las de conref roto (de esas avisa 00007b;
       decir además que no está en Precauciones sería un segundo aviso, y
       falso).

       LA DIRECCIÓN CONTRARIA NO SE VIGILA: Precauciones tiene pasos que
       no son advertencia de ninguna ficha ("cumplimentará las
       precauciones generales", "OPNAVINST 5100"...). Vigilarla al revés
       los marcaría todos como defecto.

       POR TEXTO NORMALIZADO: una diferencia de espacios o un salto de
       línea entre las dos copias de la misma advertencia no es un defecto
       de contenido. Un punto de más o de menos sí.

       CONTEXTO: EL DITAMAP. Igual que 00004. Un aviso por ditamap, no uno
       por advertencia — es lo que permite el contexto, porque las
       advertencias viven en documentos que este no es. A cambio, el
       mensaje las nombra: la información por advertencia no se pierde.
       ================================================================== -->
  <sch:pattern id="p-BRDP-EXT-00007">
    <sch:rule context="map">

      <sch:let name="docs"
               value="for $tr in //topicref[@href] return $docFicha($tr)"/>

      <sch:let name="docPrec"
               value="head($docs[normalize-space(*/title) = 'PRECAUCIONES DE SEGURIDAD'])"/>

      <sch:let name="pasosPrec"
               value="$docPrec//cmd ! normalize-space(.)"/>

      <!-- Las notas candidatas, ya filtradas. Con predicados y no con
           fn:filter, por lo mismo que en 00004: las funciones están
           tipadas element() y fn:filter exige item(). -->
      <sch:let name="notas"
               value="$docs//note[not(ancestor::ditacomponent)]
                                 [not(ancestor::*[normalize-space(title) = 'PRECAUCIONES DE SEGURIDAD'])]
                                 [$esAdvertencia(.)]
                                 [not($conrefRoto(.))]"/>

      <sch:let name="huerfanas"
               value="distinct-values(
                        for $n in $notas
                        return (if ($textoNota($n) = $pasosPrec) then () else $textoNota($n)))"/>

      <sch:let name="rotas"
               value="$docs//note[$conrefRoto(.)]"/>

      <!-- 00007a — EL CENTINELA. No es un adorno: es la regla.

           Cuando la ficha de precauciones no se puede abrir, "la
           advertencia está recogida" y "no se pudo abrir el fichero" se
           ven igual desde el informe: silencio. Y sustituye a 00007, no
           la acompaña: marcar las advertencias una a una cuando no hay
           contra qué compararlas sería ruido, no información. -->
      <sch:assert role="error" id="BRDP-EXT-00007a" test="exists($docPrec)">
        El dosier no tiene la ficha titulada "PRECAUCIONES DE SEGURIDAD" entre las que referencia el ditamap, o no se ha podido leer. Mientras falte, NINGUNA advertencia está comprobada: este aviso sustituye a la comprobación, no la acompaña.
      </sch:assert>

      <sch:assert role="error" id="BRDP-EXT-00007"
                  test="empty($docPrec) or empty($huerfanas)">
        Toda advertencia del procedimiento debe estar recogida, como paso, en "Precauciones de seguridad". Estas no aparecen allí (<sch:value-of select="count($huerfanas)"/>): <sch:value-of select="string-join($huerfanas, ' | ')"/>. La comparación es por texto normalizado: los espacios y los saltos de línea no cuentan.
      </sch:assert>

      <!-- 00007b — LA ADVERTENCIA REUTILIZADA QUE NO SE PUDO LEER.

           Diez de las dieciséis advertencias del LCA no están escritas en
           la ficha: llegan por conref desde NOTAS_COMUNES. Cuando el
           componente no está, no parsea o el id no aparece, no se sabe
           siquiera si esa nota es una advertencia: por eso el aviso dice
           que no está comprobada, no que falte. -->
      <sch:assert role="error" id="BRDP-EXT-00007b" test="empty($rotas)">
        Hay notas que se reutilizan por conref y cuyo componente no se ha podido leer (<sch:value-of select="count($rotas)"/>): <sch:value-of select="string-join(distinct-values($rotas/@conref), ' | ')"/>. Si alguna es una advertencia, NO está comprobada contra Precauciones de seguridad. Mire que NOTAS_COMUNES esté donde la ficha dice.
      </sch:assert>
    </sch:rule>
  </sch:pattern>

</sch:schema>
