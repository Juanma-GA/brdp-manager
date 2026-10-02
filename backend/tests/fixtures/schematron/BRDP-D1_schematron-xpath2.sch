<?xml version="1.0" encoding="UTF-8"?>
<schema xmlns="http://purl.oclc.org/dsdl/schematron" queryBinding="xslt2">
  <title>SATEX Business Rules Schematron (BRDP-D1) — XPath 2.0, sin prefijo</title>

  <!-- ==================================================================
       Cuatro cosas que hay que saber antes de tocar nada. El porqué largo
       NO vive aquí: está en docs/adr/0016-lca-fuente-de-verdad-de-las-reglas.md,
       schematron/README.md y schematron/fixtures/README.md. Este fichero
       contiene reglas que funcionan, no documentación.

       1. VALOR HEREDADO. Las tablas del corpus fusionan celdas con
          morerows. Una fila fusionada NO TIENE MARCADO PROPIO para esas
          columnas: el valor está en la fila que abrió la fusión. Leer solo
          la fila da vacío, y ahí nacen los falsos positivos. Cada <let>
          "vHeredado" calcula el valor EFECTIVO. XPath 2.0 no admite
          funciones propias, así que la expresión va INLINEADA una vez por
          columna: son varias copias de la misma forma, a propósito.

       2. LA COLUMNA SE IDENTIFICA POR @colname, NUNCA POR POSICIÓN. En
          una fila fusionada entry[1] no es la primera columna.

       3. UNA FILA, UN AVISO. El contexto de las reglas de tabla es la
          FILA. Con un every/satisfies sobre la tabla el motor da un solo
          aviso por tabla y no se puede saber qué fila lo causó.

       4. EL CENTINELA ES EL GUION A SECAS, "-", no "-.".
       ================================================================== -->

  <!-- BRDP-EXT-00001 — Campo cantidad repuestos no vacío -->
  <pattern id="p-BRDP-EXT-00001">
    <rule context="*[title = ('LISTA DE MATERIAL OBLIGATORIO', 'LISTA DE MATERIAL IMPREVISTO', 'HERRAMIENTAS Y EQUIPOS DE PRUEBA')]
      //table[tgroup/thead/row/entry[normalize-space(.) = 'Cant.']]
      /tgroup/tbody/row">

      <let name="cabecera" value="ancestor::tgroup[1]/thead/row[1]"/>
      <!-- La columna de exención es "Part" si la tabla la declara. Si no,
           la primera del encabezado: hay tablas con Cant./NOC/NCAGE y sin
           columna "Part" (IDENTIFICACIÓN DE EQUIPOS), y sin este respaldo
           la regla enmudecería justo ahí. -->
      <let name="colPart" value="($cabecera/entry[normalize-space(.) = 'Part']/@colname,
                                  $cabecera/entry[1]/@colname)[1]"/>
      <let name="colCant" value="$cabecera/entry[normalize-space(.) = 'Cant.']/@colname"/>

      <let name="part" value="string-join(
        if (entry[@colname = $colPart])
        then normalize-space(entry[@colname = $colPart][1])
        else for $p in preceding-sibling::row[entry[@colname = $colPart]][1]
             return if (number($p/entry[@colname = $colPart][1]/@morerows)
                        &gt;= count(preceding-sibling::row) - count($p/preceding-sibling::row))
                    then normalize-space($p/entry[@colname = $colPart][1]) else '', '')"/>

      <let name="cant" value="string-join(
        if (entry[@colname = $colCant])
        then normalize-space(entry[@colname = $colCant][1])
        else for $p in preceding-sibling::row[entry[@colname = $colCant]][1]
             return if (number($p/entry[@colname = $colCant][1]/@morerows)
                        &gt;= count(preceding-sibling::row) - count($p/preceding-sibling::row))
                    then normalize-space($p/entry[@colname = $colCant][1]) else '', '')"/>

      <assert role="error" id="BRDP-EXT-00001" test="$part = '' or $cant != ''">
        En tablas con columna "Cant." dentro de los temas "LISTA DE MATERIAL OBLIGATORIO", "LISTA DE MATERIAL IMPREVISTO" o "HERRAMIENTAS Y EQUIPOS DE PRUEBA", la columna "Cant." no puede estar vacía cuando la columna "Part" tenga contenido.
      </assert>
    </rule>
  </pattern>

  <!-- BRDP-EXT-00002 — Valores permitidos para NCAGE

       Se aplica a CUALQUIER tabla que declare la columna, sin acotar por
       título del tema: un NCAGE es un NCAGE lo ponga quien lo ponga.
       Acotar por título es lo que dejó muda a la regla de la figura en
       Template Digital; no se repite el error. -->
  <pattern id="p-BRDP-EXT-00002">
    <rule context="table[tgroup/thead/row/entry[normalize-space(.) = 'NCAGE']]/tgroup/tbody/row">

      <let name="cabecera" value="ancestor::tgroup[1]/thead/row[1]"/>
      <let name="colPart" value="($cabecera/entry[normalize-space(.) = 'Part']/@colname,
                                  $cabecera/entry[1]/@colname)[1]"/>
      <let name="colNCAGE" value="$cabecera/entry[normalize-space(.) = 'NCAGE']/@colname"/>

      <let name="part" value="string-join(
        if (entry[@colname = $colPart])
        then normalize-space(entry[@colname = $colPart][1])
        else for $p in preceding-sibling::row[entry[@colname = $colPart]][1]
             return if (number($p/entry[@colname = $colPart][1]/@morerows)
                        &gt;= count(preceding-sibling::row) - count($p/preceding-sibling::row))
                    then normalize-space($p/entry[@colname = $colPart][1]) else '', '')"/>

      <let name="ncage" value="string-join(
        if (entry[@colname = $colNCAGE])
        then normalize-space(entry[@colname = $colNCAGE][1])
        else for $p in preceding-sibling::row[entry[@colname = $colNCAGE]][1]
             return if (number($p/entry[@colname = $colNCAGE][1]/@morerows)
                        &gt;= count(preceding-sibling::row) - count($p/preceding-sibling::row))
                    then normalize-space($p/entry[@colname = $colNCAGE][1]) else '', '')"/>

      <assert role="error" id="BRDP-EXT-00002"
        test="$part = '' or $ncage = '-' or matches($ncage, '^[A-Z0-9]{5}$')">
        En tablas con columna "NCAGE", cada fila debe contener exactamente 5 caracteres alfanuméricos en mayúsculas (A-Z, 0-9) o "-" (solo si el dato es desconocido). Filas con la columna "Part" vacía están exentas.
      </assert>
    </rule>
  </pattern>

  <!-- BRDP-EXT-00003 — Valores obligatorios para Part Number -->
  <pattern id="p-BRDP-EXT-00003">
    <rule context="table[tgroup/thead/row/entry[normalize-space(.) = 'Part Number']]/tgroup/tbody/row">

      <let name="cabecera" value="ancestor::tgroup[1]/thead/row[1]"/>
      <let name="colPart" value="($cabecera/entry[normalize-space(.) = 'Part']/@colname,
                                  $cabecera/entry[1]/@colname)[1]"/>
      <let name="colPartNumber" value="$cabecera/entry[normalize-space(.) = 'Part Number']/@colname"/>

      <let name="part" value="string-join(
        if (entry[@colname = $colPart])
        then normalize-space(entry[@colname = $colPart][1])
        else for $p in preceding-sibling::row[entry[@colname = $colPart]][1]
             return if (number($p/entry[@colname = $colPart][1]/@morerows)
                        &gt;= count(preceding-sibling::row) - count($p/preceding-sibling::row))
                    then normalize-space($p/entry[@colname = $colPart][1]) else '', '')"/>

      <let name="partNumber" value="string-join(
        if (entry[@colname = $colPartNumber])
        then normalize-space(entry[@colname = $colPartNumber][1])
        else for $p in preceding-sibling::row[entry[@colname = $colPartNumber]][1]
             return if (number($p/entry[@colname = $colPartNumber][1]/@morerows)
                        &gt;= count(preceding-sibling::row) - count($p/preceding-sibling::row))
                    then normalize-space($p/entry[@colname = $colPartNumber][1]) else '', '')"/>

      <assert role="error" id="BRDP-EXT-00003" test="$part = '' or $partNumber != ''">
        En tablas con columna "Part Number", cada fila debe indicar un valor; si se desconoce, debe indicarse con el carácter "-" en lugar de dejarse vacío. Filas con la columna "Part" vacía están exentas.
      </assert>
    </rule>
  </pattern>

  <!-- BRDP-EXT-00004 — NO ESTÁ AQUÍ: está en
       BRDP-D1_schematron-xpath2-ambito-mapa.sch, el .sch de la segunda
       pasada. Compara el escalón de DOS fichas y resuelve el <keydef> del
       ditamap, y nada de eso entra en una pasada ficha a ficha (#63).
       Sustituye a 00004a, que exigía <ph keyref> en la planificación:
       Navantia no lo pide. -->

  <!-- BRDP-EXT-00005 — Valores permitidos para NOC

       Como NCAGE: cualquier tabla que declare la columna, sin acotar por
       título. -->
  <pattern id="p-BRDP-EXT-00005">
    <rule context="table[tgroup/thead/row/entry[normalize-space(.) = 'NOC']]/tgroup/tbody/row">

      <let name="cabecera" value="ancestor::tgroup[1]/thead/row[1]"/>
      <let name="colPart" value="($cabecera/entry[normalize-space(.) = 'Part']/@colname,
                                  $cabecera/entry[1]/@colname)[1]"/>
      <let name="colNOC" value="$cabecera/entry[normalize-space(.) = 'NOC']/@colname"/>

      <let name="part" value="string-join(
        if (entry[@colname = $colPart])
        then normalize-space(entry[@colname = $colPart][1])
        else for $p in preceding-sibling::row[entry[@colname = $colPart]][1]
             return if (number($p/entry[@colname = $colPart][1]/@morerows)
                        &gt;= count(preceding-sibling::row) - count($p/preceding-sibling::row))
                    then normalize-space($p/entry[@colname = $colPart][1]) else '', '')"/>

      <let name="noc" value="string-join(
        if (entry[@colname = $colNOC])
        then normalize-space(entry[@colname = $colNOC][1])
        else for $p in preceding-sibling::row[entry[@colname = $colNOC]][1]
             return if (number($p/entry[@colname = $colNOC][1]/@morerows)
                        &gt;= count(preceding-sibling::row) - count($p/preceding-sibling::row))
                    then normalize-space($p/entry[@colname = $colNOC][1]) else '', '')"/>

      <assert role="error" id="BRDP-EXT-00005"
        test="$part = '' or $noc = '-' or matches($noc, '^[0-9]{13}$')">
        En tablas con columna "NOC", cada fila debe contener exactamente 13 valores numéricos (0-9) o "-" (solo si el dato es desconocido). Filas con la columna "Part" vacía están exentas.
      </assert>
    </rule>
  </pattern>

  <!-- BRDP-EXT-00006 — Valores permitidos para Figuras y Marcas tras la fila "Repuestos"

       LA FILA SEPARADORA MANDA. La figura solo se exige a las filas
       POSTERIORES a la fila "Repuestos". Si esa fila no existe, la lista
       no declara repuestos y la regla calla: es correcto, no un fallo. -->
  <pattern id="p-BRDP-EXT-00006">
    <rule context="*[title = 'LISTA DE MATERIAL OBLIGATORIO']
      //table[tgroup/thead/row/entry[contains(normalize-space(.), 'Documento Técnico')]
          and tgroup/thead/row/entry[normalize-space(.) = 'Marca']]
      /tgroup/tbody/row[preceding-sibling::row[entry[normalize-space(.) = 'Repuestos']]]">

      <let name="cabecera" value="ancestor::tgroup[1]/thead/row[1]"/>
      <let name="colPart"   value="($cabecera/entry[normalize-space(.) = 'Part']/@colname,
                                    $cabecera/entry[1]/@colname)[1]"/>
      <let name="colDocTec" value="$cabecera/entry[contains(normalize-space(.), 'Documento Técnico')]/@colname"/>
      <let name="colMarca"  value="$cabecera/entry[normalize-space(.) = 'Marca']/@colname"/>

      <!-- El string-join externo no es adorno: sin él, una fila sin celda
           propia y sin fila anterior que la alcance devolvería la secuencia
           vacía, cuyo valor booleano es falso, y la regla avisaría de una
           fila que no tiene nada que declarar. -->
      <let name="part" value="string-join(
        if (entry[@colname = $colPart])
        then normalize-space(entry[@colname = $colPart][1])
        else for $p in preceding-sibling::row[entry[@colname = $colPart]][1]
             return if (number($p/entry[@colname = $colPart][1]/@morerows)
                        &gt;= count(preceding-sibling::row) - count($p/preceding-sibling::row))
                    then normalize-space($p/entry[@colname = $colPart][1]) else '', '')"/>

      <let name="docTec" value="string-join(
        if (entry[@colname = $colDocTec])
        then normalize-space(entry[@colname = $colDocTec][1])
        else for $p in preceding-sibling::row[entry[@colname = $colDocTec]][1]
             return if (number($p/entry[@colname = $colDocTec][1]/@morerows)
                        &gt;= count(preceding-sibling::row) - count($p/preceding-sibling::row))
                    then normalize-space($p/entry[@colname = $colDocTec][1]) else '', '')"/>

      <let name="marca" value="string-join(
        if (entry[@colname = $colMarca])
        then normalize-space(entry[@colname = $colMarca][1])
        else for $p in preceding-sibling::row[entry[@colname = $colMarca]][1]
             return if (number($p/entry[@colname = $colMarca][1]/@morerows)
                        &gt;= count(preceding-sibling::row) - count($p/preceding-sibling::row))
                    then normalize-space($p/entry[@colname = $colMarca][1]) else '', '')"/>

      <!-- El formato es el del LCA (ADR-016): "Figura N". Se admiten VARIAS
           cuando la pieza sale en varias figuras, que es como el LCA lo
           escribe: una figura por párrafo en la misma celda, con su marca. -->
      <assert role="error" id="BRDP-EXT-00006a"
        test="$part = '' or matches($docTec, '^Figura\s+[0-9]+(\s+Figura\s+[0-9]+)*$')">
        En "LISTA DE MATERIAL OBLIGATORIO", tras la fila "Repuestos", la columna "Documento Técnico / Manual Técnico / Número de Plano" debe contener un valor con formato "Figura &lt;Número&gt;" (ej. "Figura 9") y no puede estar vacía, salvo cuando la columna "Part" esté vacía. Si la pieza sale en varias figuras, se indican todas con ese mismo formato.
      </assert>

      <assert role="error" id="BRDP-EXT-00006b"
        test="$part = '' or matches($marca, '^[0-9]+(\s+[0-9]+)*$')">
        En "LISTA DE MATERIAL OBLIGATORIO", tras la fila "Repuestos", la columna "Marca" debe contener un valor numérico y no puede estar vacía, salvo cuando la columna "Part" esté vacía. Si la pieza sale en varias figuras, lleva una marca por figura.
      </assert>

    </rule>
  </pattern>

  <!-- ==================================================================
       BRDP-EXT-00007 — Toda advertencia del procedimiento, recogida en
       PRECAUCIONES DE SEGURIDAD.

       DONDE ESTAN RECOGIDAS (#62). En la ficha
       Documento_S80/Procedimiento/Ficha_T/PRECAUCIONES_CONTENIDO.dita,
       titulada "PRECAUCIONES DE SEGURIDAD", y NO como <note
       type="warning"> sino en texto plano: cada advertencia es el <cmd> de
       un paso. #53 apuntaba a Intro/PaginaAdvertencias.dita, una ficha que
       no existe en ningun dosier, y la regla no llego a comparar nunca.
       Medido el 2026-09-14: las seis advertencias ESCRITAS en las fichas
       del LCA estan las seis en esos pasos; de las diez que llegan por
       conref, dos no (ver 00007b).

       COMO MIRA ESTA REGLA OTRO FICHERO. El motor integrado no recibe un
       fichero sino una CADENA sin prologo ni DOCTYPE, y por tanto sin URI
       base: document() con ruta relativa no tiene contra que resolverse
       y la regla SUSPENDE TODO (medido, 3 avisos donde se esperaba 1 —
       docs/mediciones-del-motor-schematron.md). Con URI ABSOLUTA si
       resuelve, aunque el documento llegue como cadena: una URI absoluta
       no necesita base, que es la definicion de absoluta.

       De ahi el marcador. La operacion MFO escribe una COPIA DE TRABAJO
       de este fichero sustituyendo @@URI-CARPETA-DOSIER@@ por la URI
       file:/// de la carpeta del ditamap. El .sch versionado NUNCA lleva
       rutas absolutas: si las llevara, solo valdria en una maquina.

       EL MARCADOR ES UNO SOLO Y GENERICO: la carpeta del dosier, no la
       ficha de precauciones. Donde vive esa ficha es conocimiento de
       DISPOSICION, y la disposicion vive aqui — junto a los titulos de
       tema y los nombres de columna —, no en el .js. Ponerlo en la
       operacion la ataria a una regla concreta.

       SIN MARCADOR SUSTITUIDO, LAS DOS REGLAS CALLAN. Es lo que pasa con
       Ctrl+F9 suelto, que valida UNA ficha y no sabe donde vive el dosier.
       Callar ahi es correcto: la alternativa seria avisar de algo que no
       se ha podido mirar. Quien no puede callarse es la operacion, que
       dice en su resumen con que .sch y con que URI corrio cada pasada.
       ================================================================== -->

  <!-- BRDP-EXT-00007a — EL CENTINELA. No es un adorno: es la regla.

       Medido en los dos motores: cuando document() no puede abrir el otro
       fichero NO aborta ni avisa — doc-available() devuelve falso y ya.
       Sin centinela, "la advertencia esta recogida" y "no se pudo abrir el
       fichero" se ven exactamente igual desde el informe: silencio.

       Y el centinela decide la conducta cuando falta la ficha de
       precauciones. El contexto es el tema titulado "PROCEDIMIENTO", y
       por eso este aviso sale una vez y no una por advertencia. El LCA
       tiene seis <note type="warning">; marcarlas las seis porque no se
       pudo abrir la otra ficha seria el "suspende todo" que ya mordio una
       vez.

       CUANTAS VECES SALE, CON PRECISION: una por FICHA cuyo tema se
       titule "PROCEDIMIENTO". Que eso sea una vez por dosier es una
       MEDICION del corpus (preProcedimiento.dita, unico en los dos), no
       una garantia del mecanismo. Un dosier con dos temas asi titulados
       daria dos avisos identicos. Se acepta: es ruido, no un falso
       veredicto, y la alternativa — colgar el centinela del envoltorio,
       en la segunda pasada — lo desactivaria con Ctrl+F9 suelto, que es
       justo cuando mas falta hace. -->
  <pattern id="p-BRDP-EXT-00007a">
    <rule context="*[normalize-space(title) = 'PROCEDIMIENTO']">
      <let name="uriDosier" value="'@@URI-CARPETA-DOSIER@@'"/>
      <let name="uriPrecauciones" value="concat($uriDosier, 'Documento_S80/Procedimiento/Ficha_T/PRECAUCIONES_CONTENIDO.dita')"/>

      <assert role="error" id="BRDP-EXT-00007a"
        test="not(starts-with($uriDosier, 'file:')) or doc-available($uriPrecauciones)">
        El dosier no tiene la ficha de Precauciones de seguridad en "Documento_S80/Procedimiento/Ficha_T/PRECAUCIONES_CONTENIDO.dita", o no se ha podido leer. Mientras falte, NINGUNA advertencia está comprobada: este aviso sustituye a la comprobación, no la acompaña.
      </assert>
    </rule>
  </pattern>

  <!-- BRDP-EXT-00007 — La comparacion, una por advertencia.

       POR TEXTO NORMALIZADO. Es donde nacen los falsos positivos de esta
       regla: una diferencia de espacios o un salto de linea distinto entre
       las dos copias de la misma advertencia no es un defecto de
       contenido.

       CONTRA EL <cmd>, NO CONTRA EL <step>. El texto de un paso es su
       <cmd>; el <info> que lo acompaña es la explicacion. En el LCA el
       ultimo paso lleva un <info> largo, y comparar contra cualquier
       elemento de los pasos daria por recogida una advertencia que solo
       aparece dentro de esa explicacion. El fixture 04 lo fija.

       Se excluyen las advertencias de la PROPIA ficha de precauciones:
       compararla consigo misma no dice nada.

       Y no dispara cuando la ficha falta: de eso ya avisa 00007a, una
       sola vez. Dos avisos por el mismo hecho es ruido.

       EL ALCANCE ES TODA FICHA, NO SOLO "Procedimiento/", y es
       deliberado aunque el requisito hable del procedimiento. En el LCA
       las seis <note type="warning"> estan repartidas por Ficha_E\ y
       Ficha_T\: acotar por carpeta o por titulo de tema
       dejaria la regla MUDA sobre el corpus que decide (ADR-016):
       exactamente el error que dejo muda a la regla de la figura en
       Template Digital, y que no se repite. Vigilar de mas aqui es
       seguro: una advertencia recogida en Precauciones no dispara venga de
       donde venga, y una que no lo esta es un riesgo para quien ejecuta
       el trabajo, este en la ficha que este.

       LA DIRECCION CONTRARIA NO SE VIGILA, y aqui no es opcional:
       Precauciones tiene pasos que no son advertencias de ninguna ficha
       ("cumplimentara las precauciones generales", "OPNAVINST 5100"...).
       Vigilarla al reves los marcaria todos como defecto.

       NI LAS NOTAS MARCADAS conref-no-resuelto. Una cadena de conref que
       falla en el segundo salto deja la nota con el type del primero y
       vacia. De eso avisa 00007b; decir ademas "no esta en Precauciones"
       seria dos avisos por el mismo hecho, y el segundo, falso.

       NI EL COMPONENTE REUTILIZABLE POR SU CUENTA. La operacion sigue los
       ficheros referenciados, y los ADV...xml de NOTAS_COMUNES entran como
       si fueran fichas. Medido dentro de XMetaL el 2026-09-14 sobre el LCA:
       "Titulo 5." salia dos veces, en Preliminares y en el componente. La
       advertencia se juzga donde el lector la ve, en la ficha que la
       reutiliza; y un componente que no reutiliza nadie no esta en el
       procedimiento. -->
  <pattern id="p-BRDP-EXT-00007">
    <rule context="note[@type = 'warning'][not(@conref-no-resuelto)][not(ancestor::ditacomponent)][not(ancestor::*[normalize-space(title) = 'PRECAUCIONES DE SEGURIDAD'])]">
      <let name="uriDosier" value="'@@URI-CARPETA-DOSIER@@'"/>
      <let name="uriPrecauciones" value="concat($uriDosier, 'Documento_S80/Procedimiento/Ficha_T/PRECAUCIONES_CONTENIDO.dita')"/>

      <assert role="error" id="BRDP-EXT-00007"
        test="not(starts-with($uriDosier, 'file:'))
              or not(doc-available($uriPrecauciones))
              or (some $c in document($uriPrecauciones)//cmd
                  satisfies normalize-space($c) = normalize-space(.))">
        Toda advertencia del procedimiento debe estar recogida en Precauciones de seguridad. Esta no aparece allí. La comparación es por texto normalizado: los espacios y los saltos de línea no cuentan.
      </assert>
    </rule>
  </pattern>

  <!-- BRDP-EXT-00007b — LA ADVERTENCIA REUTILIZADA QUE NO SE PUDO LEER.

       Diez de las dieciseis advertencias del LCA no estan escritas en la
       ficha: llegan por conref desde NOTAS_COMUNES, y en la ficha la nota
       esta vacia y sin type="warning". El conref es relativo a la ficha y
       el motor no sabe donde vive la ficha, asi que lo resuelve ANTES la
       operacion (VWS_resuelveConrefs; el banco, tools\resuelve-conref.js):
       le pone a la nota el texto y el type del componente, y 00007 la
       compara como a cualquier otra.

       Cuando no puede —el componente no esta, no parsea, el id no
       aparece— marca la nota con @conref-no-resuelto, y ESTA regla lo
       dice. Sin ella, "resuelta y recogida" y "no se pudo leer" serian el
       mismo silencio. No se sabe si esa nota es una advertencia: por eso
       el aviso dice que no esta comprobada, no que falte.

       El atributo solo lo pone el paso previo, y el paso previo solo
       corre armado. Con Ctrl+F9 suelto no hay marca, y la regla calla
       como las otras dos. El mensaje no lleva value-of con el motivo: no
       esta medido que el parcheado del motor integrado lo respete, y el
       motivo sale en el log de la operacion. -->
  <pattern id="p-BRDP-EXT-00007b">
    <rule context="note[@conref-no-resuelto]">
      <let name="uriDosier" value="'@@URI-CARPETA-DOSIER@@'"/>

      <assert role="error" id="BRDP-EXT-00007b"
        test="not(starts-with($uriDosier, 'file:'))">
        Esta nota se reutiliza por conref y no se ha podido leer el componente al que apunta. Si es una advertencia, NO está comprobada contra Precauciones de seguridad.
      </assert>
    </rule>
  </pattern>

</schema>
