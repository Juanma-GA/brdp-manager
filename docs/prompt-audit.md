# Auditoría de prompts (Consolidación C2, Parte 1)

Informe, no cambio: ningún prompt se ha tocado en este encargo (`node scripts/check-prompt-snapshot.mjs` sigue 33/33 idéntico). Las recomendaciones se aplican en un encargo posterior.

## Criterio

- **Eliminar** solo si se cumplen las dos condiciones:
  - el código ya impide el fallo que motivó la instrucción, y
  - el caso de `scripts/prompt-eval/cases.json` que la protege seguiría pasando sin ella.

  Que el fallo se **detecte** después (un aviso, un Accept desactivado, la ronda de corrección) no basta: detectar no es evitar. Una instrucción que evita un error frecuente se mantiene aunque el error se detecte más tarde.
- **Acortar**: parte de la instrucción ya la cubre el código; el resto sigue haciendo falta.
- **Fusionar**: la misma instrucción aparece dos o más veces en el mismo prompt.
- **Mantener**: todo lo demás.

## Leyenda de columnas

- **Origen**: commit que la introdujo (`git log -S`). Las reglas de formato marcadas *STRICT RULES* vienen copiadas de los prompts de los generadores de Generate (`generateBREX*.js`, `generateSchematronDITA.js`, anteriores a v2).
- **Cubierto por código**:
  - *impide*: el código hace imposible el fallo;
  - *detecta*: el código avisa o bloquea después;
  - *no*: ninguna comprobación determinista lo cubre.
- **Caso eval**: el caso de `cases.json` que protege la instrucción.
  - *(determinista)*: ese caso ya no llega al LLM porque Ask lo contesta desde las fichas (C1 Parte 2 / C2 Parte 3), así que ya no protege la instrucción.

## Temperaturas (`src/prompts/shared.js`)

No son instrucciones, pero forman parte del comportamiento:

| Constante | Valor | Origen y motivo | Recomendación |
|---|---|---|---|
| `ASK_TEMPERATURE` | 0.7 | `ee5b516`: con 1, una respuesta en español coló "Entscheidungspunkte" (`ask-para-placement`). | Mantener. |
| `SUGGEST_TEMPERATURE` | 0.3 | `66cac92`: escribe directamente en un campo de la BRDP. | Mantener. |
| `RULE_TEST_TEMPERATURE` | 0.5 | `973e2c5`: los ejemplos deben variar al regenerar. | Mantener. |
| `RULE_TEST_REVIEW_TEMPERATURE` | 0.3 | `2cb3d02`: es un diagnóstico, no un texto creativo. | Mantener. |

---

## 1. Ask — `src/prompts/askPrompt.js` + bloques de `shared.js`

| # | Instrucción (resumen) | Origen / fallo real que la motivó | ¿Cubierto por código? | Recomendación | Caso eval |
|---|---|---|---|---|---|
| A1 | Rol: "an S1000D and DITA business-rules expert assistant" | `c09bd8e` (primer prompt de Ask). | — | **Acortar** a "expert in ${standard}". Nombrar los dos mundos choca con A13 ("do not mix other versions"): el fallo de `01d08a5` era precisamente que el modelo mezclaba S1000D y DITA. | — |
| A2 | SCOPE: preguntas sobre la BRDP y sobre elementos/atributos de SCHEMA FACTS; si no tiene nada que ver, decirlo y pedir que se reformule | `c8f86dc`: "Where can `<para>` go?" se rechazaba como ajena a la BRDP. | *impide* para preguntas estructurales de un nombre (C1) y de relación/propietarios (C2): ya no llegan al LLM. Las preguntas abiertas sobre el esquema sí llegan. | Mantener. | `ask-off-topic-weather` (rechazo de lo ajeno) |
| A3 | "Never add scope reminders or disclaimers to an answer you have given" | `c8f86dc`: tras una respuesta correcta de esquema, coletilla "si no es sobre esta BRDP, reformula". | *no* | Mantener. **Su protección se ha perdido**: los casos que la comprobaban (`not_ends_with_any` en `ask-table-attributes` y `ask-step-children-dita`) son ahora deterministas. Añadir un caso abierto (no estructural) con el mismo check antes de tocarla. | ~~`ask-table-attributes`~~, ~~`ask-step-children-dita`~~ *(determinista)* |
| A4 | Con comparación: "The BRDP being compared against … is also in scope" + cierre "both are in scope" | `c09bd8e`. | — | **Fusionar**: son dos frases con el mismo contenido (una tras SCOPE y otra al final del bloque de comparación); dejar una. | — |
| A5 | "Answer exactly what is asked: where → parents; contain → children; which attributes → attributes. Do not list other facts." | `c8f86dc`. Pasada `007a9b1`: las respuestas a "What can `<identAndStatusSection>` contain?" listaban sus padres (2/3). | *impide*: C1 contesta sin LLM hijos/padres/atributos/valores de un nombre; C2 contesta relación y propietarios. | **Eliminar (candidata, por C1/C2)**. Los casos que la protegían son ahora deterministas y seguirían pasando. Solo quedan en el LLM las preguntas con dos tipos a la vez ("¿qué atributos tiene y cuáles son sus hijos?") o con formas no reconocidas. Si se quiere cubrir ese resto, añadir primero un caso eval mixto. | `ask-para-placement`, `ask-children-vary-by-schema`, `ask-table-attributes`, `ask-step-children-dita`, `ask-para-attributes-3-0-1` *(todos deterministas)* |
| A6 | "When the facts contain several schema variants, summarize … common … notable differences" | `c8f86dc`: el `<para>` de 8 variantes se volcaba entero. | *no* (las fichas siguen llegando al LLM en preguntas abiertas que nombran un elemento). | Mantener. Acortable cuando haya un caso abierto que lo mida. | — |
| A7 | "If a schema-facts list is marked as a partial list, say so … never invent or state how many more" | `5ad9db0`: Mistral copió "+3 más" en la respuesta. | *detecta* a medias: las respuestas deterministas usan la ficha completa (`full=true`); el prompt del LLM sigue llevando listas cortadas con "(partial list: N of M shown)". | Mantener la primera frase. | ~~`ask-para-placement`~~ (`not_contains +N`) *(determinista)* |
| A8 | ">15 names: group or summarize … cite the most representative … the complete list is in the expandable card" | `5ad9db0`: "¿Dónde puede ir `<para>`?" volcaba 40 nombres. | *impide* para las preguntas de listas (padres/hijos/atributos/propietarios), que ya se contestan sin LLM con la lista completa agrupada por inicial. | **Eliminar (candidata, por C1/C2)**. `ask-para-placement` (`max_paragraphs`) es determinista y seguiría pasando. | ~~`ask-para-placement`~~ *(determinista)* |
| A9 | "Keep the 3-paragraph limit even when the facts are long" | `c8f86dc`. | *no* | **Fusionar** con A10: repite el mismo límite. | ~~`ask-para-placement`~~ *(determinista)* |
| A10 | "Answer in at most 3 short paragraphs — be direct, no padding, no restating the question" | `c09bd8e`. | *no* | Mantener (absorbe A9). | ~~`ask-para-placement`~~ *(determinista)* |
| A11 | Capítulos: nunca citar números de capítulo/sección salvo que aparezcan "in the BRDP content above" | `63ab3c3`: Ask sugería "Capítulo 5.2 / 6.3" con "podría". | *no* | Mantener, pero **corregir "above" → "below"**: en Ask el contexto de la BRDP va DESPUÉS de la instrucción. El mismo error está en Suggest Definition (D6) y Suggest Proposal (P8). | `ask-no-chapter-numbers` |
| A12 | "Answer in the same language as the question" | `c09bd8e` | *no* | Mantener. | `ask-english-question`, `ask-spanish-question-english-brdp` |
| A13 | "This project uses the standard: X … do not mix in other versions of S1000D or DITA" | `01d08a5`: en un proyecto 3.0.1 el modelo respondía "`<originator>` en S1000D o `<prodinfo>` en DITA". | *detecta*: `checkAnswerNames` avisa de nombres que no existen en el vocabulario del standard (aviso rojo bajo la respuesta). | Mantener (detectar no es evitar). | `ask-concept-without-facts-3-0-1`; ~~`ask-para-attributes-3-0-1`~~ *(determinista)* |
| A14 | "When your answer names an element or attribute … it must appear in SCHEMA FACTS or be quoted from the BRDP … concept without facts: say you cannot confirm the name" | `9069f66`: "ncage es un atributo del elemento `<identAndStatusSection>`" en 3.0.1 (doblemente falso). | *detecta*: `checkAnswerNames` (C1 lo dejó sin heurísticas de negación). | Mantener. **Fusionar** con la última frase de la cabecera de SCHEMA FACTS (A15), que dice lo mismo con otras palabras. | `ask-concept-without-facts-3-0-1` (`answer_names_in_vocabulary`, `not_contains identAndStatusSection`) |
| A15 | Cabecera SCHEMA FACTS: "authoritative … rely on these facts over your own knowledge. If the facts do not cover what is asked, say so plainly instead of guessing" | `8da1189` | *no* | Mantener; fusionar su última frase con A14 (ver arriba). La cabecera se comparte con Suggest Rule y con el test de reglas, así que la fusión va en `askPrompt.js`, no en `shared.js`. | — |
| A16 | Fichas multivariante: "allowed-inside parents never differ by schema", dicho en dos sitios del bloque | `6fc8325`: Mistral dijo que las variantes de `<para>` "differ in additional allowed parents (e.g. footnote)" (footnote es un hijo). | *no* | Mantener. La repetición es deliberada (commit `6fc8325`: "dicho en los dos extremos"); revisarla solo si un caso abierto muestra que una mención basta. | — |
| A17 | "content model not fully resolved …" (líneas condicionales de la ficha) | `8da1189` | — | Mantener (defensivo). Hoy **nunca se emite**: los cuatro ficheros de fichas tienen 0 casos sin resolver. | — |
| A18 | Regla cortada a 6000 caracteres con "[Rule truncated at 6000 characters]" | `c09bd8e` (HR7: nunca en silencio) | *impide* (el corte lo hace el código). | Mantener. | — |
| A19 | Nombres inexistentes de la BRDP: "Point this out explicitly … Never describe any of them as existing in any form (sin @, otra capitalización) … never say which element they belong to" | `582a25b` (bloque); `9069f66` (segunda frase: el caso ncage). | *no*: `checkAnswerNames` excluye a propósito los nombres que ya avisa la BRDP. | Mantener. | `ask-unknown-name-pokemon`, `ask-concept-without-facts-3-0-1` (manual) |
| A20 | Tipo equivocado: "The following names were used as the wrong kind in the text: …" | `0c7744e` | *detecta* (aviso de la BRDP). | Mantener. | — |

**Repeticiones y contradicciones en Ask**

- **Repeticiones**:
  - A9 + A10: límite de 3 párrafos.
  - A4: alcance de la comparación, dos veces.
  - A14 + A15: nombres fuera de SCHEMA FACTS.
- **Choque**: A1 ("S1000D and DITA expert") contra A13 ("no mezclar").
- **Error de redacción**: A11 dice "above" cuando la BRDP va debajo.

**Candidatas a eliminar por las preguntas estructurales deterministas (C1 y C2 Parte 3)**: A5 y A8. Además, A3 y A7 han perdido su caso protector y conviene reponerlo con un caso abierto.

**Decisión (C2b, antes de la pasada de referencia)**: A5 y A8 no se eliminan sin más; en la Parte 5 de la Entrega 2 se sustituyen por una sola frase que conserva la correspondencia pregunta → relación: "Answer only what is asked: contain/inside it → its children, where/in which → its parents. Do not list schema facts nobody asked for; never dump long lists of names — the full lists are in the card shown to the user." La protege `ask-open-question-no-dump` (`max_names`, `no_parent_as_child`).

---

## 2. Suggest Definition — `src/prompts/suggestDefinitionPrompt.js`

| # | Instrucción | Origen / fallo | ¿Cubierto por código? | Recomendación | Caso eval |
|---|---|---|---|---|---|
| D1 | Rol + qué es una Definition (qué se decide, alcance; no la respuesta, no XML) | `66cac92` | *no* | Mantener. | — |
| D2 | "Use this project's standard only … do not mix in other versions" | `66cac92` (mismo motivo que A13) | *no* (la vía determinista de la BRDP avisa del texto guardado, no de la sugerencia antes de aceptarla). | Mantener. | — |
| D3 | SIMILAR BRDPs: "Follow their style, length and level of detail" | `66cac92` | — | Mantener. | — |
| D4 | STYLE REFERENCES: "use them only to see how Definitions are written … do not copy" | `66cac92` | *no* | Mantener. | — |
| D5 | Sin referencias: "write from your knowledge of X alone" | `66cac92` | — | Mantener. | — |
| D6 | Capítulos (igual que A11) | `63ab3c3` | *no* | Mantener; **corregir "above" → "below"** (la BRDP va al final). | `suggest-definition-spanish-title-english-refs` (`not_contains_any`) |
| D7 | LANGUAGE: idioma del Title, con prioridad sobre las referencias; si no está claro, el de la Proposal | `27393ff`: Title en español y Proposal vacía daban una Definition en inglés. | *no* | Mantener. | `suggest-definition-spanish-title-english-refs` (`language=es`) |
| D8 | "Return ONLY the Definition text — no preamble, no references list, no quotes, no markdown" | `66cac92` | *no*: el texto se guarda tal cual al aceptarlo. | Mantener. | `suggest-definition-spanish-title-english-refs` (`no_markdown`, `not_contains_any`) |
| D9 | Bloque Suggest de nombres: "The user has already been warned … Do NOT mention their validity … do not take any decision" | `0afada3`: Suggest Proposal escribía "`<pokemon>` no existe … no se utilizará" DENTRO del campo. | *no* | Mantener. | `suggest-proposal-pokemon` (mismo bloque, en Proposal) |

**Repeticiones y contradicciones**: ninguna dentro del prompt. Error de redacción: D6 "above".

---

## 3. Suggest Proposal — `src/prompts/suggestProposalPrompt.js`

| # | Instrucción | Origen / fallo | ¿Cubierto por código? | Recomendación | Caso eval |
|---|---|---|---|---|---|
| P1 | Qué es una Proposal: "states the decision THIS project takes … the concrete answer, in concise normative terms (e.g. '... shall not be used')" | `aeec2e6` | — | **Reescribir: contradice P7.** P1 pide "la respuesta concreta" y P7 prohíbe tomar la decisión. Tras `582a25b` la Proposal sugerida es una plantilla: P1 debería decir "the normative sentence of the decision, with the choices left as placeholders". | `suggest-proposal-cage-code`, `-schemas-list` |
| P2 | "Use this project's standard only" | `aeec2e6` | *no* | Mantener. | — |
| P3 | SAME BRDP IN OTHER PROJECTS: "understand the usual options; do not copy their project-specific values" | `aeec2e6` | *no* | **Fusionar** con la última frase de P7 ("never present another project's choice as this project's decision"), que dice lo mismo. | `suggest-proposal-schemas-list` (manual) |
| P4 | SIMILAR DECISIONS IN OTHER PROJECTS (encabezado descriptivo) | `aeec2e6` | — | Mantener. | — |
| P5 | THIS PROJECT'S RELATED DECISIONS: "must be consistent with them and must not contradict them" | `aeec2e6` | *no* | Mantener. | — |
| P6 | Rechazada: Proposal y motivo; "must address the reason for refusal"; restricción concreta → el hueco la recoge ("at least 2" → `[VALUE: at least 2]`) | `aeec2e6`; segunda parte `6fc8325`: con "at least 2 levels" salió `[VALUE: e.g. 5, 8]`. | *no* | Mantener. Tensión leve con P7: "address the reason" podría leerse como decidir; la segunda frase lo resuelve con el hueco. | `suggest-proposal-refused-with-reason` (manual) |
| P7 | DO NOT MAKE THE DECISION: plantilla con huecos `[LIST:…]`, `[SHALL/SHALL NOT]`, `[VALUE:…]`, `[UNIT:…]` + 4 ejemplos | `582a25b`: copiaba la lista concreta de Lufthansa y se posicionaba ("no se utilizará"). Ejemplos cambiados en `6fc8325`: el modelo copiaba los antiguos, uno de ellos gramaticalmente roto. | *no*: `UNFILLED_MARKER_RE` bloquea Suggest Rule con huecos sin rellenar, pero nada comprueba que la sugerencia tenga huecos. | Mantener. | `suggest-proposal-cage-code` (`contains \[…\]`), `suggest-proposal-schemas-list` (`[LIST:`), `suggest-proposal-pokemon` |
| P8 | Capítulos (igual que A11) | `63ab3c3` | *no* | Mantener; corregir **"above" → "below"** (aquí el bloque BRDP va después). | — |
| P9 | LANGUAGE: idioma del Title, con prioridad; si no, el de la Definition | `aeec2e6` (patrón de `27393ff`) | *no* | Mantener. **Sin caso eval**: añadir uno de Proposal con Title en español y referencias en inglés. | — |
| P10 | "Return ONLY the Proposal text — no preamble, no references list, no quotes, no markdown" | `aeec2e6` | *no* | Mantener. | — |
| P11 | Bloque Suggest de nombres (= D9) | `0afada3` | *no* | Mantener. | `suggest-proposal-pokemon` |

**Contradicción**: P1 ("la respuesta concreta") contra P7 ("no tomes la decisión"). **Repetición**: P3 y el final de P7. **Error de redacción**: P8 "above".

---

## 4. Suggest Rule — `src/prompts/suggestRulePrompt.js`

| # | Instrucción | Origen / fallo | ¿Cubierto por código? | Recomendación | Caso eval |
|---|---|---|---|---|---|
| R1 | Rol | `7c0fea3` | — | Mantener. | — |
| R2 | TASK: implementar como UNA regla la decisión de la Proposal; no cambiarla, ensancharla ni estrecharla, ni añadir comprobaciones | `7c0fea3` | *detecta* a medias: el test de reglas (T2–T4) juzga ejemplos escritos desde la decisión. | Mantener. | Todos los `rule-*` (`contains`) |
| R3 | Regla general: "applies to every schema" / limitada: "applies ONLY to … schemas", sin predicado ni paso que filtre por esquema (ejemplo con `acmeElement`) | `7bd6f39`; filtro por esquema en `ee5b516` (`//emphasis[ancestor-or-self::descript]` en 3.0.1). | *no* | Mantener. | `rule-4-2-limited-to-proced`, `rule-3-0-1-limited-to-descript` (`not_contains ancestor\|…`, `target: xpath`) |
| R3b | "The application places your rule inside one context block … write only the rule element, never a context block" | `7bd6f39` | *no*: un `<contextRules>` con regla dentro es BREX válido y la comprobación de la Parte 0 lo acepta. | **Fusionar**: lo mismo aparece tres veces (R3b; regla de formato 1 "never a `<contextRules>` wrapper"; R6 "Never output a context block yourself"). Dejar una sola frase, en la regla de formato 1. | `rule-4-2-limited-to-proced`, `rule-3-0-1-limited-to-descript` (`not_contains <contextRules` en la respuesta) |
| R4 | Reglas de formato (ver sección 5) | — | — | — | — |
| R5 | NAMES: solo nombres de la BRDP, SCHEMA FACTS y los precedentes Same/Similar; nunca de los ejemplos de formato; nunca inventar | `7c0fea3`. El propio snapshot encontró la contradicción con los ejemplos de formato en ese mismo commit. | *detecta*: `checkRuleNames` avisa en rojo; Accept sigue disponible. | Mantener. **Fusionar** su segunda frase con la cabecera de "Format examples" ("never copy their element or attribute names"): se dice dos veces. | Todos los `rule-*` (`names_in_vocabulary`) |
| R6 | CONTEXT BLOCKS: el bloque solo limita al esquema de su URL, ver "Applies to" | `7bd6f39`: `BRDP-S1-00006` llegaba como "`//dmodule` prohibido en todas partes". | — | Mantener; su última frase entra en la fusión de R3b. | — |
| R7 | Bloques Same BRDP / Similar decisions / Format examples ("unrelated … never copy their names") | `7c0fea3`. Descarte de precedentes que no son reglas en `6c58688`: `BRDP-EXT-00066`, `BRDP-S1-00489`. | *impide* la parte "precedente que no es regla" (`rule_precedents.extract_format_rules`). | Mantener; fusión con R5 (ver arriba). | — |
| R8 | PREVIOUS RULE FAILED ITS TEST (regla anterior, ejemplos fallidos, diagnóstico) | `2cb3d02` | — | Mantener. | — (lo cubre el snapshot `suggestRule/brex-4-2-corrected-after-failed-test`) |
| R9 | NOT CHECKABLE: `NOT_CHECKABLE: <motivo>` si la decisión no se puede verificar sobre el XML | `7c0fea3` | *impide* el guardado (`parseSuggestRuleResponse` no da Accept). | Mantener. | `rule-not-checkable` |
| R10 | OUTPUT: "only the XML fragment — no markdown, no explanation, no XML declaration"; texto humano en el idioma de la Proposal | `7c0fea3` | *impide* markdown y declaración: `parseSuggestRuleResponse` quita el bloque de código y el `<?xml?>`. *Detecta* la explicación: el texto suelto da `rule_format_text` (Parte 0, Accept desactivado). | **Acortar**: quitar "no markdown, no XML declaration" (el código los elimina, y `xml_well_formed` seguiría pasando). Mantener "no explanation" (solo se detecta) y la frase del idioma. | Todos los `rule-*` (`xml_well_formed`) |

---

## 5. Reglas de formato — `src/prompts/ruleFormatRules.js`

`ruleFormatRules.js` es la única fuente viva de reglas de formato: la usa Suggest Rule. Las copias que quedan en los generadores no las usa Generate; ver el inventario, sección 2.

| # | Instrucción | Origen / fallo | ¿Cubierto por código? | Recomendación | Caso eval |
|---|---|---|---|---|---|
| F1 (4.2/4.1) | Exactamente UN `<structureObjectRule id="{ID}">`; nunca `<contextRules>`, `<nonContextRule>` ni `dmodule` | STRICT RULES → `7c0fea3` | *detecta* (Parte 0): `dmodule`, `<rules>` o `structureObjectRuleGroup` envolventes → error rojo y Accept desactivado. `<nonContextRule>` y `<contextRules>` con regla son BREX válido y pasan. | Mantener; absorbe la fusión de R3b. | `rule-4-2-prohibit-element` (`not_contains <contextRules\|<nonContextRule`) |
| F2 (4.2) | Orden de hijos; `brDecisionRef` como atributo, nunca como texto | STRICT RULES → `7c0fea3` | *no*: no se valida contra XSD al aceptar; solo Generate valida el documento entero. | Mantener. | — |
| F2 (4.1) | Sin `brDecisionRef` ni `brSeverityLevel` en 4.1 | STRICT RULES (`generateBREX41.js`) | *no* | Mantener. | — |
| F3 | UNA `<objectPath>`; `allowedObjectFlag` 0/1/2 y su significado | STRICT RULES | *no* | Mantener. | `rule-4-2-prohibit-element`, `rule-4-2-attribute-value-list` |
| F4 | objectUse: `@nombre` y `&lt;nombre&gt;` | `6c58688`: nombres de atributo sin "@". | *no* | Mantener. | — |
| F5 | Lista de valores: `allowedObjectFlag="2"` + un `<objectValue valueForm="single">` por valor; nunca un predicado; ejemplo `@acmeCode` | `6c58688`: `[. != 'a' and . != 'b']` en el objectPath. | *no*: el motor de test lo juzga si se prueba, pero no avisa al sugerir. | Mantener. | `rule-4-2-attribute-value-list` (`uses_object_value`) |
| F6 | Nombres desnudos en objectPath; `&lt;nombre&gt;` solo en objectUse | `0c19b28`: `//&lt;emphasis&gt;` en 3 de 3 pasadas. | *detecta*: `invalidRuleXPaths` desactiva Accept; y desde la Parte 0, un `//&lt;emphasis&gt;` suelto sin elemento es "falta structureObjectRule". | Mantener: fallo frecuente (3/3). | `rule-4-2-limited-to-proced` (`xpath_valid`, todos los `rule-*`) |
| F1–F6 (3.0.1) | Equivalentes para `objrule` / `objpath` / `objappl` 0/1 / `objuse` / `objval`; "Leave objappl out unless mandatory" | STRICT RULES; `6c58688` (listas); `0c19b28` (nombres desnudos) | Igual que en 4.x. | Mantener. | `rule-3-0-1-objrule`, `rule-3-0-1-limited-to-descript` |
| S1 (DITA) | UN `<sch:pattern>` con UNA `<sch:rule>`; sin `<sch:schema>` ni comentarios; línea de XPath 2.0 o 3.0 según el dialecto | STRICT RULES → `7c0fea3`; dialecto en la ronda del split XPath | *detecta*: un envoltorio `<sch:schema>` da `rule_format_wrapper` (Parte 0). La sintaxis 3.x en un proyecto 2.0 solo se avisa en el test de reglas (`xpath3_syntax`). | Mantener. | `rule-dita-xpath2-schematron` |
| S2 | Varias comprobaciones en la misma rule; ids `{ID}` o `{ID}-slug`, nunca repetidos | STRICT RULES | *no* en Suggest (los ids duplicados solo los detecta Generate). | Mantener. | — |
| S3 | `context` como patrón válido; nunca un eje inverso al principio | STRICT RULES | *no*: es XPath sintácticamente válido, así que `xpath_valid` no lo ve. | Mantener. | — |
| S4 | `@context` selecciona y `@test` expresa la condición; nunca la condición en el contexto con `test="false()"` | `ee5b516`: 2 de 3 pasadas escribieron `note[not(@type)]` + `false()`. | *no* | Mantener. | `rule-dita-xpath2-schematron` (`not_contains test="false()"`) |
| S5–S7 | Lista cerrada `@a = ('v1','v2')`; `matches()` anclado; profundidad con `count(ancestor::…)` | STRICT RULES | *no* | Mantener. | `rule-dita-xpath2-schematron` (S5) |
| S8 | Polaridad assert/report | STRICT RULES | *detecta* en el test de reglas (veredicto incorrecto). | Mantener. | `rule-test-dita-wrong-inverted-assert` |
| S9 | `role="error"` / `role="warning"` | STRICT RULES | *no* | Mantener. | — |
| S10 | `&lt;elemento&gt;` en los mensajes; escapar `<` y `&` en test/context/let | STRICT RULES | *detecta*: un `<` sin escapar deja el XML mal formado y Accept se desactiva. | Mantener. | `rule-dita-xpath2-schematron` (`xml_well_formed`) |
| S11 | Nunca un test vacío de contenido | `7c0fea3` | *detecta* en el test de reglas: `describeRule` marca "constant" / "cannot reject". | Mantener. | — |
| S12 | Tablas fila a fila por el texto de la cabecera (`sch:let` + `every $row`) | `7c0fea3` (patrón de las reglas reales de Navantia) | *no* | Mantener. Muy específica y sin caso eval: **revisar** si merece un caso con una tabla. | — |

**Repeticiones**: "never a context block", tres veces (F1, R3b, R6); nombres de los ejemplos de formato, dos veces (R5 y la cabecera de R7).

---

## 6. Ejemplos del test de reglas — `src/prompts/ruleTestExamplesPrompt.js`

| # | Instrucción | Origen / fallo | ¿Cubierto por código? | Recomendación | Caso eval |
|---|---|---|---|---|---|
| T1 | "You never judge the rule: you only write the examples" | `973e2c5` | *impide*: el veredicto lo da el motor. | Mantener. | — |
| T2 | La decisión primero; la regla "only to know which elements, attributes and schemas are involved" | `2cb3d02`: con ejemplos escritos desde la regla, una regla equivocada pasaba el test. | — | Mantener. | `rule-test-4-2-wrong-rule-flag2` (`rule_test_verdict_incorrect`) |
| T3 | `proposalMismatch` (orientativo, una frase en el idioma de la Proposal) | `77f947b` / `2cb3d02` | — | Mantener. | — |
| T4 | Al menos un `accept` y un `reject`, desde la DECISIÓN, aunque la regla no la implemente | `2cb3d02` | *detecta*: el veredicto `inconclusive`/`no_runnable` si falta uno. | Mantener. | Todos los `rule-test-*` (`rule_test_accept_and_reject`) |
| T5 | Una restricción de valores no hace obligatorio el nodo; el `reject` incumple exactamente lo que decide la Proposal | `2cb3d02`: ejemplo "sin `@emphasisType`" esperando rechazo. | *no* (la revisión con el asistente lo diagnostica después). | Mantener. | `rule-test-4-2-emphasis-type-values` (`rule_test_reject_examples_contain`), `rule-review-example-missing-attribute` |
| T6 | Esquema(s) de los ejemplos y tercer ejemplo de otro esquema para reglas con contexto | `973e2c5` / `77f947b` | *impide*: el esquema lo elige el código (`chooseTestSchemas`). | Mantener (le dice al LLM qué `schema` poner). | `rule-test-4-2-limited-to-proced` (`rule_test_other_schema_accepted`) |
| T7 | HOW EACH EXAMPLE IS BUILT: solo el contenido del punto de inserción, con la lista de hijos permitidos | `77f947b`: el LLM escribía documentos enteros con `<procedure><step>`, que no existe en 4.2. | *impide* el esqueleto (lo monta la app); *detecta* hijos no permitidos (comprobación estructural + una ronda de corrección). | Mantener. | Todos (`rule_test_examples_valid`) |
| T8 | Manual de mantenimiento aeronáutico (naval o aeronáutico en DITA), en inglés, ≤10 líneas | `973e2c5` | *no* | Mantener. | — |
| T9 | Marcado real: nombres de la regla, de las listas o de SCHEMA FACTS; cada elemento en un padre que lo admita | `973e2c5` / `77f947b` | *detecta y repara*: vocabulario + estructura + una ronda de corrección. | Mantener: evita gastar la ronda de corrección (el primer informe real traía `<procedure><step>` y `<content>` dentro de `<warning>`). | Todos (`rule_test_examples_valid`) |
| T10 | Nunca texto directo en `<dmRef>`, `<dmCode>`, `<internalRef>`… (`NO_TEXT_ELEMENTS`) | `77f947b`: `<dmRef>screw</dmRef>`. | *no*: la comprobación estructural no ve el texto. | Mantener. | — |
| T11 | El `reject` incumple la decisión de una forma clara; el `accept` es parecido | `973e2c5` | *no* | Mantener. | — |
| T12 | Sin datos de clientes, fabricantes reales, part numbers ni códigos CAGE | `973e2c5` | *no* | Mantener. | — |
| T13 | THE RULE DEPENDS ON A TITLE (crear una `<section>` con ese título) | `007a9b1`: título puesto en `table/title` y veredicto no concluyente. | *detecta y repara*: `missesRuleProblem` entra en la ronda de corrección. | Mantener. | `rule-test-dita-xpath3-titled-context` |
| T14 | Título del topic ya escrito por la app ("never write another one") / documento completo con `<title>` obligatorio | `007a9b1` | *impide* el título del esqueleto (lo escribe la app). | Mantener. | `rule-test-dita-*` |
| T15 | PREVIOUS EXAMPLES WERE WRONG (diagnóstico de la revisión) | `2cb3d02` | — | Mantener. | — (snapshot `brex-4-2-value-list-previous-review`) |
| T16 | OUTPUT: "strict JSON only — no markdown, no comments, nothing before or after" | `973e2c5` | *impide* a medias: `parseRuleTestResponse` tolera el bloque de código y el texto alrededor; un comentario dentro del JSON rompe `JSON.parse`. | **Acortar**: quitar "no markdown … nothing before or after", mantener "strict JSON, no comments" y el esquema de salida. | Todos (`rule_test_json_valid`) |
| T17 | Mensaje de la ronda de corrección: "fix exactly these problems … same order, same expected/schema" | `77f947b` | — | Mantener. | — |

**Repeticiones y contradicciones**: ninguna relevante.

---

## 7. Revisión del test — `src/prompts/ruleTestReviewPrompt.js`

| # | Instrucción | Origen / fallo | ¿Cubierto por código? | Recomendación | Caso eval |
|---|---|---|---|---|---|
| V1 | Decidir si el fallo está en la REGLA o en los EJEMPLOS | `2cb3d02` | — | Mantener. | `rule-review-example-missing-attribute` |
| V2 | "What the rule checks (computed by the application from its XML — exact)" (`describeRule`) | `2cb3d02` (la explicación del LLM describía la Proposal, no la regla) | *impide*: la descripción es determinista. | Mantener. | — |
| V3 | HOW TO DECIDE, con el ejemplo del atributo ausente | `2cb3d02` (el desacuerdo real del informe T3) | *no* | Mantener. | `rule-review-example-missing-attribute` (`review_cause=example`) |
| V4 | "Judge against the Proposal, not against the example's label" | `2cb3d02` | *no* | Mantener. | — |
| V5 | OUTPUT: JSON estricto "no markdown, nothing before or after"; explicación en el idioma de la Proposal | `2cb3d02` | *impide* a medias: `parseRuleTestReviewResponse` tolera el bloque de código y el texto alrededor. | **Acortar** la parte de markdown (igual que T16). Mantener el idioma. | `rule-review-example-missing-attribute` (`review_json_valid`, `language=es`) |

---

## Resumen de recomendaciones

| Tipo | Instrucciones |
|---|---|
| **Eliminar (candidatas)** | A5, A8. Ask ya contesta sin LLM las preguntas estructurales (C1, y C2 Parte 3) y sus casos eval son deterministas. |
| **Acortar** | A1 (rol "S1000D and DITA"), R10 (markdown/declaración), T16 y V5 (markdown/texto alrededor del JSON). |
| **Fusionar** | A9 con A10, A4 (dos frases), A14 con A15, P3 con el final de P7, "never a context block" (F1/R3b/R6), R5 con la cabecera de Format examples. |
| **Corregir** | "above" → "below" en la regla de capítulos (A11, D6, P8); P1 contradice P7. |
| **Casos eval que faltan** | Pregunta abierta de Ask con `not_ends_with_any` (A3) y con lista cortada (A7); Proposal con Title en español y referencias en inglés (P9); pregunta mixta de dos tipos (resto de A5); regla DITA de tabla fila a fila (S12). |
| **Mantener** | Todo lo demás, en particular las instrucciones que evitan errores frecuentes aunque ahora se detecten después: F6 (objectPath escapado, 3/3), F5, S4, T9, A13/A14. |
