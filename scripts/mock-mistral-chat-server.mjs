// Ad hoc, throwaway local mock of Mistral's chat-completions endpoint --
// same "mock only the Mistral HTTP transport" convention as
// mock-mistral-embed-server.mjs (which already mocks the embeddings
// endpoint for imports), applied here to Ask a Question. Needed because
// this sandbox's outbound network cannot reach api.mistral.ai at all --
// confirmed via the real backend log, which shows the agent proxy itself
// rejecting the request with a 403, before it even gets to the "invalid
// API key" question:
//   httpcore.ProxyError: 403 Forbidden
// So this isn't a stand-in for a missing/invalid key -- the real provider
// is categorically unreachable from here, same class of sandbox
// limitation CLAUDE.md already documents elsewhere (Navantia SOPTE scale,
// production-only data, etc.), not an app bug.
//
// GET /last-request exposes the most recently received request body
// (model/messages/system as actually built by buildRequestBody in
// llmAPI.js) so a verification script can assert on the EXACT system
// prompt and message array the app sent -- not just that some request was
// sent -- which is the real thing this docs request needs verified (BRDP
// scoping, one-turn chaining, the compare block).
import http from "node:http";

const PORT = 8902;
let lastRequest = null;
let lastProposalCheck = null;
let proposalCheckCalls = 0;
let proposalCheckFailNext = false;

function isOffTopic(text) {
  return /what'?s the weather|qué tiempo hace|weather like/i.test(text || "");
}

// Two deterministic triggers, checked by the verify script for markdown
// rendering and for the "raw HTML in the answer must render as literal
// text, never be interpreted" edge case (same principle as the Generate
// Report HTML-injection fix, commit 90b7e12).
function isMarkdownTest(text) {
  return /MARKDOWN_TEST/.test(text || "");
}
function isHtmlTest(text) {
  return /HTML_TEST/.test(text || "");
}

// Suggest Definition always sends this exact fixed user message (docs
// request round: language/wrap/dedup) -- used here, not a trigger phrase
// inside it (there's no room for one), to return a deliberately LONG,
// unbroken reply so a verification script can confirm the suggestion box
// actually wraps it instead of cutting it off at the panel's right edge.
function isSuggestDefinition(text) {
  return text === "Write the Definition for this BRDP.";
}

// Suggest Title: its fixed user message. The reply comes from the current
// Title in the system prompt ("Current Title: …"), like a model following
// the prompt: a reference prefix in brackets is kept; an "avee" Title
// becomes the decision on the order of its children; a "hotspot"/"apsname"
// Title the decision on @applicationStructureName; "ALREADYOK" in the Title
// returns it unchanged; "MULTILINE" answers two lines; "POKEMON" names an
// element that does not exist. Anything else: "Decide whether <Title>".
function isSuggestTitle(text) {
  return text === "Write the Title for this BRDP.";
}

function suggestTitleReply(systemPrompt) {
  const current = (/\nCurrent Title: ([^\n]*)/.exec(systemPrompt || "") || [])[1] || "";
  if (/ALREADYOK/.test(current)) return current;
  const prefixMatch = /^(\([^)]*\))\s*/.exec(current);
  const prefix = prefixMatch ? `${prefixMatch[1]} ` : "";
  const rest = current.slice(prefixMatch ? prefixMatch[0].length : 0);
  if (/MULTILINE/.test(current)) return `${prefix}Decidir el orden de <avee>\nEste título describe la decisión.`;
  if (/POKEMON/.test(current)) return `${prefix}Decidir si se usa el elemento <pokemon>`;
  if (/avee/i.test(rest)) return `${prefix}Definir el orden de los elementos hijos de <avee>`;
  if (/hotspot|apsname/i.test(rest)) return `${prefix}Decide on the attribute @applicationStructureName for the element <hotspot>`;
  return `${prefix}Decide whether ${rest}`;
}

// Suggest Rule round (docs request): Suggest Rule's fixed user message.
// The reply is chosen deterministically from the BRDP's Proposal, read
// from the tail of the system prompt ("BRDP:\n...\nProposal: <text>"), so
// a verification script picks the scenario through the BRDP it seeds:
//   - "calibration"  -> NOT_CHECKABLE: <reason>
//   - "MALFORMED"    -> an unclosed element (Accept must be disabled)
//   - "ESCAPEDPATH"  -> well-formed, but objectPath is //&lt;emphasis&gt;
//                       (not XPath -- Accept must be disabled)
//   - "pokemon"      -> a well-formed rule naming an invented element
//   - "LONGRULE"     -> one long unbroken XML line (box-scroll check)
//   - anything else  -> a valid rule in the format the prompt asks for
//                       (BREX 4.2 / 4.1 / 3.0.1 or DITA Schematron).
function isSuggestRule(text) {
  return text === "Write the rule for this BRDP.";
}

// AI Extract (1/2): "Write the texts for these BRDPs." -- one item per
// "BRDP key=…" block of the prompt. The proposal is built from the block's
// decision text (or its first rule), so the review table shows something
// recognisable; the texts are in Spanish when the decision text is.
// EXTRACT_BROKEN in a decision text → an answer that is not JSON (every
// time, so the batch ends "not written").
// AI Extract (2/2): "Find the decisions in this text." -- the sentences of
// the text between the markers that read like a decision (shall / must /
// debe / siempre / nunca …), each as its literal quote (whitespace
// collapsed, as an AI usually writes it) with a short title. Markers in
// the text:
//   INVENTQUOTE                       one more decision whose quote is not
//                                     in the text
//   TRUNCATEFIND-START … -END         the whole text is "cut by its length"
//                                     (finish_reason length); each half,
//                                     having only one marker, is not
//   TRUNCATEALWAYS                    every answer is cut
const DECISION_SENTENCE_RE = /\b(shall|must|never|always|debe|deben|siempre|nunca|se marcan|se redacta|se divide|no se mezclan|no se admiten)\b/i;
const TITLE_TOPICS = [
  [/\b(una sola acción|dos acciones|acciones distintas)\b/i, "Una sola acción por paso"],
  [/\bone action\b/i, "One action per step"],
];

function findDecisionsReply(systemPrompt) {
  const text = (systemPrompt.split("<<<TEXT\n")[1] || "").split("\nTEXT>>>")[0];
  const truncate = /TRUNCATEALWAYS/.test(text) || (/TRUNCATEFIND-START/.test(text) && /TRUNCATEFIND-END/.test(text));
  const decisions = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    if (/^#/.test(paragraph.trim())) continue;
    for (const sentence of paragraph.replace(/\s+/g, " ").trim().split(/(?<=[.!?»])\s+(?=[A-ZÁÉÍÓÚ¿¡«])/)) {
      if (!DECISION_SENTENCE_RE.test(sentence)) continue;
      const words = sentence.replace(/[«»"“”.,:;]/g, "").split(" ").filter((w) => !/^BRDP-/.test(w));
      // A real model names the same decision the same way: a sentence about
      // one action per step (the Spanish guide says it twice, the second
      // time in its closing reminder) always gets the same title.
      const topic = TITLE_TOPICS.find(([re]) => re.test(sentence));
      decisions.push({ quote: sentence, title: topic ? topic[1] : words.slice(0, 6).join(" ") });
    }
  }
  if (/INVENTQUOTE/.test(text)) decisions.push({ quote: "Every figure shall have a caption with its number.", title: "Invented figure captions" });
  return { reply: JSON.stringify({ decisions }), truncate };
}

function extractReply(systemPrompt) {
  if (/EXTRACT_BROKEN/.test(systemPrompt)) return "Sorry, here are the texts: {not json";
  const blocks = systemPrompt.split(/\n(?=BRDP key=)/).slice(1);
  const items = blocks.map((block) => {
    const key = (block.match(/^BRDP key=(\S+)/) || [])[1];
    const origin = (block.match(/Identifier (?:in the source file|named in the document): (\S+)/) || [])[1] || key;
    const write = ((block.match(/\n {2}Write: ([^\n]*)/) || [])[1] || "proposal").split(/,\s*/);
    const writeAll = write.includes("title");
    // A free text (AI Extract 2/2) gives the quote instead of a decision text.
    const decisionBlock = (block.match(/(?:Decision text in the file|Quote from the document)[^\n]*\n((?: {2}> .*\n?)+)/) || [])[1] || "";
    const decisionLines = decisionBlock.split("\n").map((l) => l.replace(/^ {2}> /, "")).filter(Boolean);
    const decision = (decisionLines.find((l) => /Decision made by|shall|must|debe/.test(l)) || decisionLines.join(" ") || "").replace(/^Decision made by \w+\.\s*/, "");
    const firstRule = (block.match(/\n {2}- (\/\/?[^ ]+)/) || [])[1] || "";
    // A real model writes in the language of the quote: any Spanish word or
    // accent in the decision is enough to answer in Spanish.
    const spanish = /[áéíóúñ¿¡]|\b(Decidir|debe|deben|el|la|los|las|de|del|se|en|un|una|cada|sin|con)\b/i.test(decision);
    const proposal = spanish
      ? `MOCK-PROPUESTA ${origin}: ${decision || "se aplicará la regla"}.`
      : `MOCK-PROPOSAL ${origin}: ${decision || (firstRule ? `${firstRule} shall be used as the rule enforces` : "the rule shall apply")}.`;
    return {
      key,
      title: writeAll ? (spanish ? `Título MOCK de ${origin}` : `Mock title of ${origin}`) : "",
      definition: write.includes("definition") ? (spanish ? `Decidir sobre ${origin}.` : `Decide on ${origin}.`) : "",
      proposal: write.includes("proposal") ? proposal : "",
    };
  });
  return JSON.stringify({ items });
}

function suggestRuleReply(systemPrompt) {
  const id = (systemPrompt.match(/\nBRDP:\nID: (.*)/) || [])[1] || "BRDP-MOCK";
  const proposal = (systemPrompt.match(/\nProposal: (.*)\s*$/) || [])[1] || "";
  if (/calibration/i.test(proposal)) {
    return "NOT_CHECKABLE: tool calibration intervals are a workshop process, not something in the XML document";
  }
  if (/MALFORMED/.test(proposal)) {
    return `<structureObjectRule id="${id}"><objectPath allowedObjectFlag="0">//para</objectPath><objectUse>Broken`;
  }
  if (/ESCAPEDPATH/.test(proposal)) {
    return `<structureObjectRule id="${id}" brSeverityLevel="brsl01"><brDecisionRef brDecisionIdentNumber="${id}"/><objectPath allowedObjectFlag="0">//&lt;emphasis&gt;</objectPath><objectUse>MOCK-RULE: &lt;emphasis&gt; is not used.</objectUse></structureObjectRule>`;
  }
  // Mejoras A, Part 3 (real case BRDP-S1-00186): two decisions in one
  // Proposal -- like Mistral, ONE structureObjectRule with two objectPath
  // and two objectUse, which the app splits; "NOTSPLITTABLE" gives two
  // paths and one use (not mechanical: the format error stays).
  if (/maximum of five levels|NOTSPLITTABLE/.test(proposal)) {
    const second = /NOTSPLITTABLE/.test(proposal) ? '' : '<objectUse>MOCK-RULE: the fifth level has no title.</objectUse>';
    return `<structureObjectRule id="${id}" brSeverityLevel="brsl01">\n  <brDecisionRef brDecisionIdentNumber="${id}"/>\n  <objectPath allowedObjectFlag="0">//proceduralStep[count(ancestor::proceduralStep) &gt; 4]</objectPath>\n  <objectUse>MOCK-RULE: at most five levels.</objectUse>\n  <objectPath allowedObjectFlag="0">//proceduralStep[count(ancestor::proceduralStep) = 4]/title</objectPath>\n  ${second}\n</structureObjectRule>`;
  }
  if (/LONGRULE/.test(proposal)) {
    return '<structureObjectRule id="MOCK-LONG-RULE"><objectPath allowedObjectFlag="1">/dmodule/content/description/verylongunbrokenxpathsegmentnamewithnowhitespaceatallxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx[@attr=\'value\']</objectPath><objectUse>MOCK-LONG-RULE</objectUse></structureObjectRule>';
  }
  // Remates de Mejoras G, Part 1.2: "every <orig> carries @origname with one
  // of these values". With the new rule 9 (several values → the list in
  // {ID}-1 and the attribute required in {ID}-2) two rules; without it, the
  // list as a condition -- what rule 9 said before.
  if (/@origname/.test(proposal) && /FORMAT — S1000D Issue 3\.0\.1/.test(systemPrompt)) {
    if (/\{ID\}-2 with objappl="0" on X\[not\(@a\)\]/.test(systemPrompt)) {
      return `<objrule id="${id}-1"><objpath>//orig/@origname</objpath><objuse>MOCK-RULE: @origname only takes the listed values.</objuse><objval valtype="single" val1="ACME SL"/><objval valtype="single" val1="BETA SA"/><objval valtype="single" val1="GAMMA SL"/></objrule>\n<objrule id="${id}-2"><objpath objappl="0">//orig[not(@origname)]</objpath><objuse>MOCK-RULE: every orig carries @origname.</objuse></objrule>`;
    }
    return `<objrule id="${id}"><objpath objappl="0">//orig[not(@origname='ACME SL' or @origname='BETA SA' or @origname='GAMMA SL')]</objpath><objuse>MOCK-RULE: origname values.</objuse></objrule>`;
  }
  // Mejoras F, Part 2.2a (BRDP-EXT-02636): "every <row> of a <tbody>
  // carries @rowsep 0". With the prompt's rule 9 ("never objappl="1" with
  // values") the rule forbids the opposite with objappl="0"; without it,
  // objappl="1" with an objval -- the real mistake.
  if (/@rowsep/.test(proposal) && /FORMAT — S1000D Issue 3\.0\.1/.test(systemPrompt)) {
    if (/never objappl="1" with values/.test(systemPrompt)) {
      return `<objrule id="${id}"><objpath objappl="0">/dmodule/content//tbody/row[not(@rowsep='0')]</objpath><objuse>MOCK-RULE: every row of a tbody carries rowsep 0.</objuse></objrule>`;
    }
    return `<objrule id="${id}"><objpath objappl="1">/dmodule/content//tbody/row/@rowsep</objpath><objuse>MOCK-RULE: every row of a tbody carries rowsep 0.</objuse><objval valtype="single" val1="0"/></objrule>`;
  }
  // Mejoras F, Part 1.1 (c) (BRDP-EXT-02651): the corrected rule really
  // offered for the inverted one -- objappl="1" on //reqconds[…], which
  // also rejects a descript data module with nothing written in it.
  if (/<reqconds>/.test(proposal) && /PREVIOUS RULE FAILED ITS TEST/.test(systemPrompt) && /FORMAT — S1000D Issue 3\.0\.1/.test(systemPrompt)) {
    // Mejoras G, Part 2.2 (BRDP-EXT-02651 again): the real corrected rule came
    // back with XML-R-2652, the id of BRDP-S1-00024's rule (CLASH2652 in the
    // Proposal) -- the application keeps the previous rule's id instead.
    const rid = /CLASH2652/.test(proposal) ? "XML-R-2652" : id;
    return `<objrule id="${rid}"><objpath objappl="1">//reqconds[ /dmodule/content/proced or /dmodule/content/schedule ]</objpath><objuse>MOCK-RULE: procedures and scheduled maintenance declare their required conditions.</objuse></objrule>`;
  }
  // Mejoras C: the real rule BRDP-EXT-00087, whose path cannot exist
  // (/techstd is never a document root) -- for the amber warning and its
  // "Change /techstd to //techstd" button.
  if (/<techstd>/.test(proposal) && /FORMAT — S1000D Issue 3\.0\.1/.test(systemPrompt)) {
    return `<objrule id="${id}"><objpath objappl="0">/techstd[not(authex) or not(notes)]</objpath><objuse>MOCK-RULE: a technical standard record gives its exceptions and notes.</objuse></objrule>`;
  }
  // Mejoras C: the values of <trade> (BRDP-EXT-00013) -- a 3.0.1 rule
  // whose path the schemas allow (<trade> inside <reqpers>).
  if (/<trade>/.test(proposal) && /FORMAT — S1000D Issue 3\.0\.1/.test(systemPrompt)) {
    return `<objrule id="${id}"><objpath>//reqpers/trade</objpath><objuse>MOCK-RULE: the trade is Mechanic or Electrician.</objuse><objval valtype="single" val1="Mechanic"/><objval valtype="single" val1="Electrician"/></objrule>`;
  }
  // Mejoras D, Part 2.5 (BRDP-EXT-02815): "de su <figure>". With the prompt's
  // rule 7 ("reach X … with ancestor::X") the rule says ancestor::figure;
  // without it, //figure -- the real mistake (every figure of the document).
  if (/<term>/.test(proposal) && /<hotspot>/.test(proposal) && /FORMAT — S1000D Issue 3\.0\.1/.test(systemPrompt)) {
    const own = /with ancestor::X, never with \/\/X/.test(systemPrompt) ? "ancestor::figure" : "//figure";
    return `<objrule id="${id}"><objpath objappl="0">//figure//legend/deflist/term[not(. = ${own}//graphic//hotspot/@apsname)]</objpath><objuse>MOCK-RULE: every &lt;term&gt; matches a @apsname of a &lt;hotspot&gt; of its &lt;figure&gt;.</objuse></objrule>`;
  }
  // Suggest Rule part 2: a Proposal naming one of these elements gets a
  // prohibition rule on it (schema-context verification: <emphasis> exists
  // in every 4.2 schema, <partSegment> only in ipd).
  const prohibited = (proposal.match(/<(emphasis|partSegment)>/) || [])[1];
  if (prohibited) {
    if (/FORMAT — S1000D Issue 3\.0\.1/.test(systemPrompt)) {
      return `<objrule id="${id}"><objpath objappl="0">//${prohibited}</objpath><objuse>MOCK-RULE: &lt;${prohibited}&gt; is not used.</objuse></objrule>`;
    }
    const ref = /FORMAT — S1000D Issue 4\.2/.test(systemPrompt) ? `<brDecisionRef brDecisionIdentNumber="${id}"/>` : "";
    return `<structureObjectRule id="${id}"${ref ? ' brSeverityLevel="brsl01"' : ""}>${ref}<objectPath allowedObjectFlag="0">//${prohibited}</objectPath><objectUse>MOCK-RULE: &lt;${prohibited}&gt; is not used.</objectUse></structureObjectRule>`;
  }
  // T4: a DITA Proposal about <note>/@type gets the note rule -- INVERTED
  // in the Proposal gives the wrong (inverted) assert, unless the prompt
  // carries the failed test (Suggest a corrected rule).
  if (/FORMAT — ISO Schematron/.test(systemPrompt) && /<note>/.test(proposal) && /@type/.test(proposal)) {
    const inverted = /INVERTED/.test(proposal) && !/PREVIOUS RULE FAILED ITS TEST/.test(systemPrompt);
    return `<sch:pattern id="p-${id}"><sch:rule context="note"><sch:assert id="${id}" role="error" test="${inverted ? "not(@type)" : "@type"}">Every note must declare its type (@type).</sch:assert></sch:rule></sch:pattern>`;
  }
  const element = /pokemon/i.test(proposal) ? "pokemon" : "table";
  if (/FORMAT — ISO Schematron/.test(systemPrompt)) {
    return `<sch:pattern id="p-${id}"><sch:rule context="${element}"><sch:assert id="${id}" role="error" test="@frame">MOCK-RULE: &lt;${element}&gt; must declare @frame.</sch:assert></sch:rule></sch:pattern>`;
  }
  if (/FORMAT — S1000D Issue 3\.0\.1/.test(systemPrompt)) {
    return `<objrule id="${id}"><objpath objappl="1">//${element}/@frame</objpath><objuse>MOCK-RULE: every &lt;${element}&gt; has a frame.</objuse></objrule>`;
  }
  const ref = /FORMAT — S1000D Issue 4\.2/.test(systemPrompt) ? `<brDecisionRef brDecisionIdentNumber="${id}"/>` : "";
  return `<structureObjectRule id="${id}"${ref ? ' brSeverityLevel="brsl01"' : ""}>${ref}<objectPath allowedObjectFlag="1">//${element}/@frame</objectPath><objectUse>MOCK-RULE: every &lt;${element}&gt; has a frame.</objectUse><objectValue valueForm="single" valueAllowed="all">All</objectValue></structureObjectRule>`;
}

// Test rule: the examples prompt ("Write the test examples for this rule.",
// or the correction round that follows it) gets fixed examples.
function isRuleTest(text) {
  return text === "Write the test examples for this rule." || text.startsWith("Some examples are not valid.");
}

// Test rule (T2b): the LLM writes only the content of an insertion point.
// The examples follow the rule quoted in the prompt and the schemas it
// offers ('- schema "proced": your content goes directly inside <para>');
// T3b: no "explanation" any more (describeRule gives it). Proposal markers
// pick a scenario:
//   BROKENJSON   truncated answer
//   BROKENSTRUCT the reject example is <warning><content> inside <para>
//                (the first real run); the correction round fixes it
//   STUBBORN     same, but the correction keeps it broken
//   MISMATCH     the Proposal check (its own call) says the rule does
//                not implement the Proposal
//   SIBLINGLISTS (//randomList//randomList) the reject example is two
//                sibling lists, also after the correction round
//   SPANNEDCELLS (C3b, //thead rule) both examples carry a table whose row 2
//                repeats a cell a morerows above already covers (the real
//                titled-context run at 297df74); the app removes it itself
//                (with NOCOLSPECS too: the tables have no <colspec>)
//   ALLINVALID   every example (first answer and correction) has
//                <levelledPara> inside <sbSummary>, invalid in its schema:
//                the "none of the examples could be run" verdict
// A rule split by schema ("the examples are split by schema"): nested
// levels of <levelledPara> / <proceduralStep> (Lufthansa S1-00120), one set
// per schema offered.
//   MISSINGATTR  (@emphasisType rule) the reject example relies on the
//                attribute's ABSENCE -- the real disagreement of the T3
//                report; a regeneration carrying "PREVIOUS EXAMPLES WERE
//                WRONG" writes correct examples
// Rule test on DM metadata: when the prompt asks for the whole
// identification and status section ('your "metadata" is the WHOLE
// <identAndStatusSection>'), the examples start from the minimal section
// the prompt quotes and change what the rule looks at (@infoCode,
// @issueType, the responsible partner company, applic / applicRef,
// @assyCode -- the Lufthansa S1-00052/53/70/316/338 cases).
const lastUserOf = (messages) => [...(messages || [])].reverse().find((m) => m.role === "user")?.content || "";
function metadataReply(systemPrompt, rule, answer, messages = []) {
  const element = (systemPrompt.match(/your "metadata" is the WHOLE <([\w-]+)>/) || [])[1];
  if (!element) return null;
  // Condiciones con raíz absoluta, y cabecera de pm/ddn/dml (BRDP-EXT-00029,
  // CMP ATA): the applicability of a DM or PM must be stated; a DDN or DML
  // always passes. The examples of each schema start from ITS minimal
  // section (descript's identAndStatusSection with dmStatus, pm's with
  // pmStatus); ddn and dml ("ONE example only") come with no content.
  // Test de reglas: atributos obligatorios (GMC 4.2 BRDP-EXT-00160): like
  // the real run, the example meant to be rejected writes
  // <firstVerification/> without its required @verificationType; the one
  // meant to be accepted, with it.
  if (/qualityAssurance\/firstVerification/.test(rule)) {
    const lines = systemPrompt.split("\n");
    const at = lines.findIndex((l) => l.startsWith('- schema "descript": the application builds the rest'));
    const start = lines.findIndex((l, i) => i > at && l.startsWith(`    <${element}>`));
    const base = [];
    for (let i = start; at !== -1 && start !== -1 && i < lines.length && lines[i].startsWith("    "); i += 1) base.push(lines[i].slice(4));
    const section = base.join("\n");
    const examples = [
      { label: "First verification stated with its type", expected: "accept", schema: "descript", metadata: section.replace("<unverified/>", '<firstVerification verificationType="tabtop"/>') },
      { label: "First verification without its type", expected: "reject", schema: "descript", metadata: section.replace("<unverified/>", "<firstVerification/>") },
    ];
    for (const schema of ["ddn", "dml", "comment"]) {
      if (systemPrompt.includes(`- "${schema}": for <${schema}> — ONE example only`)) examples.push({ label: `Any ${schema.toUpperCase()}`, expected: "accept", schema });
    }
    return answer(examples);
  }
  if (/\/ddn or \/dml/.test(rule)) {
    const minimalOf = (schema) => {
      const lines = systemPrompt.split("\n");
      const at = lines.findIndex((l) => l.startsWith(`- schema "${schema}": the application builds the rest`));
      if (at === -1) return null;
      const start = lines.findIndex((l, i) => i > at && l.startsWith(`    <${element}>`));
      const out = [];
      for (let i = start; i < lines.length && lines[i].startsWith("    "); i += 1) out.push(lines[i].slice(4));
      return out.join("\n");
    };
    const withText = (x, text) => x.replace("<simplePara>All</simplePara>", `<simplePara>${text}</simplePara>`);
    const examples = [];
    for (const schema of ["descript", "pm"]) {
      const base = minimalOf(schema);
      if (!base) continue;
      const kind = schema === "pm" ? "PM" : "DM";
      examples.push({ label: `${kind} applicable to All`, expected: "accept", schema, metadata: base });
      examples.push({ label: `${kind} with free applicability text`, expected: "reject", schema, metadata: withText(base, "Some text") });
      if (schema === "descript") {
        examples.push({ label: "DM with an assert", expected: "accept", schema, metadata: base.replace(/<applic>[\s\S]*?<\/applic>/, '<applic><assert applicPropertyIdent="model" applicPropertyType="prodattr" applicPropertyValues="A"/></applic>') });
        examples.push({ label: "DM with an applicRef", expected: "accept", schema, metadata: base.replace(/<applic>[\s\S]*?<\/applic>/, '<applicRef applicIdentValue="app-001"/>') });
      }
    }
    for (const schema of ["ddn", "dml"]) {
      if (systemPrompt.includes(`- "${schema}": for <${schema}> — ONE example only`)) examples.push({ label: `Any ${schema.toUpperCase()}`, expected: "accept", schema });
    }
    return answer(examples);
  }
  const schema = (systemPrompt.match(/- schema "([\w-]+)": (?:the application builds the rest|your content goes directly inside)/) || [])[1];
  const lines = systemPrompt.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`    <${element}>`)) - 1;
  const minimal = [];
  for (let i = start + 1; i < lines.length && lines[i].startsWith("    "); i += 1) minimal.push(lines[i].slice(4));
  const base = minimal.join("\n");
  const ex = (label, expected, metadata, content) => ({ label, expected, schema, metadata, ...(content !== undefined ? { content } : {}) });
  const ownCode = (attr, value) => base.replace(new RegExp(`(<dmIdent>\\s*<dmCode [^>]*?)${attr}="[^"]*"`), `$1${attr}="${value}"`);
  // Templates round: the curated 4.1 rules. The data update file's tool
  // CIR (updateCode/@infoCode 00N, section + content), change marks in a
  // data module that is not "changed" (section + content), issue 001 new.
  if (/updateCode/.test(rule)) {
    const cir = (code) => base.replace(/(<updateCode [^>]*?)infoCode="[^"]*"/, `$1infoCode="${code}"`);
    // Plantillas, Part 3: like the real run, without the valid way down in
    // the prompt the CIR elements go straight inside <update> (invalid);
    // with it, along insertObjectGroup/insertObject with real attributes.
    if (!systemPrompt.includes("The valid way down in this schema")) {
      const bad = (el) => `<insertObject><${el}/></insertObject>`;
      return answer([ex("Tool in the tool CIR", "accept", cir("00N"), bad("toolSpec")), ex("Part in the tool CIR", "reject", cir("00N"), bad("partSpec"))]);
    }
    const insert = (el) => `<insertObjectGroup><insertObject insertionOrder="1" targetPath="/">${el}</insertObject></insertObjectGroup>`;
    // El juez de la Propuesta: the zone CIR (00H, BRDP-EXT-00019).
    if (/infoCode="00H"/.test(rule)) {
      const zoneSpec = '<zoneSpec><zoneIdent zoneNumber="100"/><zoneAlts><zone><itemDescr>Lower fuselage</itemDescr></zone></zoneAlts></zoneSpec>';
      const partSpec0 = '<partSpec><partIdent manufacturerCodeValue="K0001" partNumberValue="P-100"/></partSpec>';
      return answer([ex("Zone in the zone CIR", "accept", cir("00H"), insert(zoneSpec)), ex("Part in the zone CIR", "reject", cir("00H"), insert(partSpec0))]);
    }
    const toolSpec = '<toolSpec><toolIdent manufacturerCodeValue="K0001" toolNumber="T-100"/></toolSpec>';
    const partSpec = '<partSpec><partIdent manufacturerCodeValue="K0001" partNumberValue="P-100"/></partSpec>';
    return answer([ex("Tool in the tool CIR", "accept", cir("00N"), insert(toolSpec)), ex("Part in the tool CIR", "reject", cir("00N"), insert(partSpec)), ex("Part in the parts CIR", "accept", cir("00E"), insert(partSpec))]);
  }
  if (/changeMark/.test(rule) && /issueType/.test(rule)) {
    const type = (value) => base.replace("<dmStatus>", `<dmStatus issueType="${value}">`);
    const marked = 'Torque the bolts <changeInline changeMark="1">to 25 N.m</changeInline>.';
    return answer([ex("Change mark in a changed issue", "accept", type("changed"), marked), ex("Change mark in a new issue", "reject", type("new"), marked)]);
  }
  if (/issueNumber = "001"/.test(rule)) {
    const type = (value) => base.replace("<dmStatus>", `<dmStatus issueType="${value}">`);
    return answer([ex("Issue 001, new", "accept", type("new")), ex("Issue 001, changed", "reject", type("changed"))]);
  }
  // Ruta del esquema (BRDP-S1-00065, //copyright): with the way down in the
  // prompt, the notice goes along it with the required children; with
  // MISPLACED in the Proposal (or without the way), straight inside the
  // status element right after <security> -- the real run's mistake, which
  // the application now moves without the LLM.
  if (/\/\/copyright\b/.test(rule)) {
    const para = element === "idstatus" ? "para" : "copyrightPara";
    const notice = (year) => `<copyright><${para}>Copyright © ${year} by Lufthansa Technik AG.</${para}></copyright>`;
    const route = systemPrompt.match(/right after <security>,\n {2}with its required children[^\n]*\n((?: {4}.*\n)+)/);
    const place = (year) => {
      if (!route || systemPrompt.includes("MISPLACED")) return base.replace(/(<security [^>]*\/>)/, `$1\n    ${notice(year)}`);
      const block = route[1].split("\n").map((l) => l.slice(4)).join("\n").replace(/<copyright>[\s\S]*<\/copyright>/, notice(year)).replace(/…/g, "Distribution statement A.");
      return base.replace(/(<security [^>]*\/>)/, `$1\n${block}`);
    };
    return answer([ex("Current Lufthansa notice", "accept", place(2024)), ex("Notice with the wrong year", "reject", place(2023))]);
  }
  if (/@infoCode/.test(rule)) {
    return answer([ex("Info code 055", "accept", ownCode("infoCode", "055")), ex("Info code 930", "accept", ownCode("infoCode", "930")), ex("Info code 040", "reject", ownCode("infoCode", "040"))]);
  }
  if (/issueType/.test(rule)) {
    return answer([ex("Changed data module", "accept", base.replace("<dmStatus>", '<dmStatus issueType="changed">')), ex("Revised data module", "reject", base.replace("<dmStatus>", '<dmStatus issueType="revised">'))]);
  }
  if (/responsiblePartnerCompany/.test(rule)) {
    const rpc = (code, name) => base.replace(/<responsiblePartnerCompany>\s*<enterpriseName>[^<]*<\/enterpriseName>/, `<responsiblePartnerCompany enterpriseCode="${code}">\n      <enterpriseName>${name}</enterpriseName>`);
    return answer([ex("Lufthansa Technik as partner", "accept", rpc("C1008", "LUFTHANSA TECHNIK AG"), ""), ex("Another partner", "reject", rpc("K0001", "ACME AERO"), "")]);
  }
  // Secciones de comment/SCORM/icnmetadata: a rule on the comment's status
  // (//commentStatus/commentResponse) -- the examples start from the
  // comment's minimal section the prompt quotes.
  if (/commentResponse/.test(rule) && /applicRef/.test(rule)) {
    // Also on dmStatus: one pair per schema, each from ITS minimal section.
    const minimalOf = (sch) => {
      const at = lines.findIndex((l) => l.startsWith(`- schema "${sch}": the application builds the rest`));
      if (at === -1) return null;
      const from = lines.findIndex((l, i) => i > at && l.startsWith(`    <${element}>`));
      const out = [];
      for (let i = from; i < lines.length && lines[i].startsWith("    "); i += 1) out.push(lines[i].slice(4));
      return out.join("\n");
    };
    const examples = [];
    const comment = minimalOf("comment");
    if (comment) {
      examples.push({ label: "Comment without a response", expected: "accept", schema: "comment", metadata: comment });
      examples.push({ label: "Comment with a response", expected: "reject", schema: "comment", metadata: comment.replace(/(<commentPriority [^>]*\/>)/, '$1\n    <commentResponse responseType="rt01"/>') });
    }
    const dm = minimalOf("descript");
    if (dm) {
      examples.push({ label: "Applicability written in the status", expected: "accept", schema: "descript", metadata: dm });
      examples.push({ label: "Applicability referenced", expected: "reject", schema: "descript", metadata: dm.replace(/<applic>[\s\S]*?<\/applic>/, '<applicRef applicIdentValue="app-001"/>') });
    }
    return answer(examples);
  }
  if (/commentResponse/.test(rule)) {
    return answer([ex("Comment without a response", "accept", base), ex("Comment with a response", "reject", base.replace(/(<commentPriority [^>]*\/>)/, '$1\n    <commentResponse responseType="rt01"/>'))]);
  }
  if (/applicRef/.test(rule)) {
    return answer([ex("Applicability written in the status", "accept", base), ex("Applicability referenced", "reject", base.replace(/<applic>[\s\S]*?<\/applic>/, '<applicRef applicIdentValue="app-001"/>'))]);
  }
  if (/issno/.test(rule)) {
    // 3.0.1 idstatus: the issue type of the data module.
    return answer([ex("New issue", "accept", base.replace("<issno ", '<issno type="new" ')), ex("Revised issue", "reject", base.replace("<issno ", '<issno type="revised" '))]);
  }
  if (/brexDmRef/.test(rule) && /@disassyCodeVariant/.test(rule)) {
    // A rule on the brexDmRef itself: the value is written there.
    const brexCode = (value) => base.replace(/(<brexDmRef>[\s\S]*?<dmCode [^>]*?disassyCodeVariant=")[^"]*"/, `$1${value}"`);
    return answer([ex("Two characters in the BREX reference", "accept", brexCode("AB"), "Remove the panel."), ex("One character in the BREX reference", "reject", base, "Remove the panel.")]);
  }
  if (/@disassyCodeVariant/.test(rule)) {
    // S1-00342: like a real LLM, only the data module's own code changes --
    // the brexDmRef keeps the minimal section's "A" (the application makes
    // it follow the own code).
    return answer([ex("Two-character variant", "accept", ownCode("disassyCodeVariant", "AB"), "Remove the panel."), ex("One-character variant", "reject", base, "Remove the panel.")]);
  }
  if (/@systemDiffCode/.test(rule)) {
    // Plantillas 4.1/4.2, row 5: only A, on the data module's own code and
    // on any code it references (F in a normal data module is rejected).
    const dmRef = (sdc) => `See <dmRef><dmRefIdent><dmCode modelIdentCode="EXAMPLE" systemDiffCode="${sdc}" systemCode="00" subSystemCode="0" subSubSystemCode="0" assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="520" infoCodeVariant="A" itemLocationCode="A"/></dmRefIdent></dmRef>.`;
    return answer([
      ex("Default system difference code A", "accept", ownCode("systemDiffCode", "A"), dmRef("A")),
      ex("System difference code F in a normal data module", "reject", ownCode("systemDiffCode", "F"), dmRef("A")),
      ex("Own code with B", "reject", ownCode("systemDiffCode", "B"), dmRef("A")),
      ex("Reference with C", "reject", ownCode("systemDiffCode", "A"), dmRef("C")),
    ]);
  }
  if (/@assyCode/.test(rule)) {
    const dmRef = (assy) => `See <dmRef><dmRefIdent><dmCode modelIdentCode="EXAMPLE" systemDiffCode="A" systemCode="00" subSystemCode="0" subSubSystemCode="0" assyCode="${assy}" disassyCode="00" disassyCodeVariant="A" infoCode="520" infoCodeVariant="A" itemLocationCode="A"/></dmRefIdent></dmRef>.`;
    return answer([ex("Two-character codes", "accept", base, dmRef("01")), ex("Four characters in a reference", "reject", base, dmRef("0301")), ex("Three characters in the own code", "reject", ownCode("assyCode", "001"), dmRef("01"))]);
  }
  if (/\/\/@commercialClassification/.test(rule)) {
    // GMC EXT-00037: the first answer puts cc99 on <language>, which has no
    // such attribute (the real run); the correction round -- which now
    // carries where @commercialClassification goes -- moves it to a
    // <changeInline> in the content. Since the correction names the carriers
    // near <language> instead (atributo, desde donde la IA lo puso), it moves
    // it to the one it names there, <techName>, in the same section.
    const last = lastUserOf(messages);
    const fixed = /@commercialClassification goes on:/.test(last);
    const near = /@commercialClassification is not allowed on <language>[^\n]*<techName>/.test(last);
    const inline = (cc) => `Torque the bolts to <changeInline commercialClassification="${cc}">10 N.m</changeInline>.`;
    const reject = fixed
      ? ex("Other commercial classification", "reject", base, inline("cc99"))
      : near
        ? ex("Other commercial classification", "reject", base.replace("<techName>", '<techName commercialClassification="cc99">'), "Torque the bolts to 10 N.m.")
        : ex("Other commercial classification", "reject", base.replace("<language ", '<language commercialClassification="cc99" '), "Torque the bolts to 10 N.m.");
    return answer([ex("COC-marked torque value", "accept", base, inline("cc51")), reject]);
  }
  return null;
}

function dossierExamples(rule, correcting, lastUser, systemPrompt = "") {
  const map = (hrefs) => `<map><title>Dosier de mantenimiento</title>${hrefs.map((h) => `<topicref href="${h}"/>`).join("")}</map>`;
  const prec = '<task id="precauciones"><title>PRECAUCIONES DE SEGURIDAD</title><taskbody><steps><step><cmd>No fumar en la zona de trabajo.</cmd></step><step><cmd>Usar gafas de protección.</cmd></step></steps></taskbody></task>';
  const proc = (info) => `<task id="procedimiento"><title>PROCEDIMIENTO</title><taskbody><steps><step><cmd>Desmontar la tapa de la bomba.</cmd><info>${info}</info></step></steps></taskbody></task>`;
  const PREC = { path: "fichas/precauciones.dita", content: prec };
  // Reglas que solo avisan (reconstructed Navantia BRDP-EXT-00012/00013): a
  // role="warning" rule on the rows of a list under an ancestor titled
  // 'LISTA DE …'. The first answer repeats the real failure: a <sectiondiv>
  // with that title directly in <taskbody> (a sectiondiv goes in neither
  // and takes no title). The correction round fixes it -- the list in an
  // <example> of <taskbody> -- only when it carries the card of <taskbody>
  // and where the title can go in a task file.
  const listTitle = (rule.match(/ancestor::\*\[normalize-space\(title\) = '(LISTA DE [^']+)'\]/) || [])[1];
  if (listTitle && /role="warning"/.test(rule)) {
    // Since the app puts a loose <sectiondiv> in a container of <taskbody>
    // itself (contenido suelto), the problem left is its <title>: either
    // message, with where the title can go, fixes it.
    const fixed = correcting && (/card of <taskbody> in the task schema/.test(lastUser) || /<title> is not allowed inside <sectiondiv>/.test(lastUser)) && /goes on the file's own <task>/.test(lastUser);
    const item = /HERRAMIENTAS/.test(listTitle) ? "Llave dinamométrica L-7" : "Junta tórica J-12";
    const row = (a, b = "") => `<row><entry colname="c1">${a}</entry><entry colname="c2">${b}</entry></row>`;
    const list = (rows) => `<title>${listTitle}</title><table><tgroup cols="2"><colspec colname="c1"/><colspec colname="c2"/><tbody>${rows}</tbody></tgroup></table>`;
    const steps = (cmds) => `<steps>${cmds.map((c) => `<step><cmd>${c}</cmd></step>`).join("")}</steps>`;
    const sheet = (rows, cmds) => fixed
      ? `<task id="ft-001"><title>Desmontaje de la bomba de achique</title><taskbody>${steps(cmds)}<example>${list(rows)}</example></taskbody></task>`
      : `<task id="ft-001"><title>Desmontaje de la bomba de achique</title><taskbody><sectiondiv>${list(rows)}</sectiondiv>${steps(cmds)}</taskbody></task>`;
    const content = map(["fichas/ft-001.dita"]);
    const file = (rows, cmds) => [{ path: "fichas/ft-001.dita", content: sheet(rows, cmds) }];
    return [
      { label: "Every item named in a step", expected: "accept", schema: "map", content, files: file(row(item), [`Sustituir ${item}.`]) },
      { label: "Exempt item", expected: "accept", schema: "map", content, files: file(row("Grasa G-3", "Exento"), ["Desmontar la tapa."]) },
      { label: "Item no step names", expected: "reject", schema: "map", content, files: file(row(item) + row("Arandela A-4"), [`Sustituir ${item}.`]) },
    ];
  }
  // Un ejemplo de dosier al que le falta un fichero (reconstructed Navantia
  // BRDP-EXT-00015: a table cited as "Tabla X.Y de la ficha N" belongs to a
  // sheet the ditamap mentions). As in the real run, the example meant to be
  // rejected points to topics/procedimiento_L00009.dita and never writes it;
  // the file is added only when the correction round names that path.
  if (/uri-collection/.test(rule) && /Tabla \\d\+\\\.\\d\+ de la ficha/.test(rule)) {
    const L9 = "topics/procedimiento_L00009.dita";
    const L10 = "topics/procedimiento_L00010.dita";
    const sheet = (id, text) => `<topic id="${id}"><title>Procedimiento ${id}</title><body><p>${text}</p></body></topic>`;
    const content = map([L9, L10]);
    const fixed = correcting && lastUser.includes(`points to ${L9}, which is not in the dossier`);
    const rejectFiles = [{ path: L10, content: sheet("L00010", "Montar la bomba de achique.") }];
    if (fixed) rejectFiles.push({ path: L9, content: sheet("L00009", "Véase la Tabla 3.1 de la ficha L00099.") });
    return [
      { label: "Cita a tabla de una ficha mencionada", expected: "accept", schema: "map", content, files: [{ path: L9, content: sheet("L00009", "Desmontar la bomba de achique.") }, { path: L10, content: sheet("L00010", "Véase la Tabla 2.1 de la ficha L00009.") }] },
      { label: "Cita a tabla con número en formato X.Y en ficha NO mencionada", expected: "reject", schema: "map", content, files: rejectFiles },
    ];
  }
  // Un topic anidado dentro del cuerpo (reconstructed Navantia
  // BRDP-EXT-00016: a step cited in a sheet, "paso 2.1", exists in the
  // dossier). As Mistral wrote it: the numbered steps -- nested
  // <concept outputclass="numbered"> -- inside the sheet's <conbody>, and
  // never corrected: the application moves them out itself.
  if (/pasosDosier/.test(rule) && /uri-collection/.test(rule)) {
    const sheet = (cited) =>
      `<concept id="ft-001"><title>Desmontaje de la bomba</title><conbody><p>Antes de desmontar, véase el paso ${cited}.</p>` +
      '<concept id="p1" outputclass="numbered"><title>Preparar</title><conbody><p>Cerrar la válvula.</p></conbody></concept>' +
      '<concept id="p2" outputclass="numbered"><title>Desmontar</title><conbody><p>Retirar la tapa.</p>' +
      '<concept id="p21" outputclass="numbered"><title>Aflojar</title><conbody><p>Aflojar los tornillos.</p></conbody></concept>' +
      '<concept id="p22" outputclass="numbered"><title>Retirar</title><conbody><p>Retirar la bomba.</p></conbody></concept>' +
      "</conbody></concept></conbody></concept>";
    const content = map(["fichas/ft-001.dita"]);
    return [
      { label: "Cites step 2.1, which exists", expected: "accept", schema: "map", content, files: [{ path: "fichas/ft-001.dita", content: sheet("2.1") }] },
      { label: "Cites step 2.3, which does not exist", expected: "reject", schema: "map", content, files: [{ path: "fichas/ft-001.dita", content: sheet("2.3") }] },
    ];
  }
  // Contenido suelto en el cuerpo de las fichas (reconstructed Navantia
  // BRDP-EXT-00014/00015: every figure / table with an @id is cited by an
  // <xref> of the dossier's sheets). As Mistral wrote them: <p>, <table> and
  // <fig> straight in <taskbody>, and never corrected -- the application
  // puts them in a <context> itself.
  const cited = /context="(fig|table)\[@id\]"/.exec(rule);
  // No meter un <title> suelto en un contenedor (BRDP-EVAL-RT-LOOSETITLE):
  // as Mistral wrote the table sheet, its <title> loose before the <table>
  // in <taskbody>; only when the correction round says where that title
  // goes is it written inside the <table> (and the content in <context>).
  if (cited && cited[1] === "table" && /uri-collection/.test(rule) && /BRDP-EVAL-RT-LOOSETITLE/.test(systemPrompt)) {
    const fixed = correcting && /If this <title> belongs to the <table> that follows, write it as the first child of that <table>\./.test(lastUser);
    const grid = '<tgroup cols="1"><colspec colname="c1"/><tbody><row><entry colname="c1"><p>Junta tórica J-12</p></entry></row></tbody></tgroup>';
    const xref = (yes) => (yes ? '<p>Ver la <xref href="#desmontaje/t1"/>.</p>' : "<p>Desmontar la bomba de achique.</p>");
    const sheet = (yes) =>
      fixed
        ? `<task id="desmontaje"><title>Desmontaje de la bomba</title><taskbody><context>${xref(yes)}<table id="t1"><title>Tabla 1</title>${grid}</table></context></taskbody></task>`
        : `<task id="desmontaje"><title>Desmontaje de la bomba</title><taskbody>${xref(yes)}<title>Tabla 1</title><table id="t1">${grid}</table></taskbody></task>`;
    const content = map(["fichas/desmontaje.dita"]);
    return [
      { label: "The table is cited", expected: "accept", schema: "map", content, files: [{ path: "fichas/desmontaje.dita", content: sheet(true) }] },
      { label: "The table is not cited", expected: "reject", schema: "map", content, files: [{ path: "fichas/desmontaje.dita", content: sheet(false) }] },
    ];
  }
  if (cited && /uri-collection/.test(rule)) {
    const kind = cited[1];
    const target = kind === "fig" ? "f1" : "t1";
    const xref = (yes) => (yes ? `<p>Ver la <xref href="#desmontaje/${target}"/>.</p>` : "<p>Desmontar la bomba de achique.</p>");
    const table = '<table id="t1"><title>Juntas</title><tgroup cols="1"><colspec colname="c1"/><tbody><row><entry colname="c1">Junta tórica J-12</entry></row></tbody></tgroup></table>';
    const fig = '<fig id="f1"><title>Bomba de achique</title></fig>';
    const sheet = (yes) => `<task id="desmontaje"><title>Desmontaje de la bomba</title><taskbody>${xref(yes)}${kind === "fig" ? fig : table}</taskbody></task>`;
    const content = map(["fichas/desmontaje.dita"]);
    const file = (yes) => [{ path: "fichas/desmontaje.dita", content: sheet(yes) }];
    return [
      { label: `The ${kind === "fig" ? "figure" : "table"} is cited`, expected: "accept", schema: "map", content, files: file(true) },
      { label: `The ${kind === "fig" ? "figure" : "table"} is not cited`, expected: "reject", schema: "map", content, files: file(false) },
    ];
  }
  // Funciones XPath que faltan, Part 2: a rule on the topics' cells that
  // finds the ditamap going up the folders (reconstructed Navantia
  // BRDP-EXT-00017): each sheet cites another sheet's code in a table cell.
  if (/uri-collection/.test(rule) && /FT-\[0-9\]\{3\}/.test(rule)) {
    const sheet = (id, cite) => `<topic id="${id}"><title>Ficha ${id}</title><body><table><tgroup cols="1"><colspec colname="c1"/><tbody><row><entry colname="c1">${cite}</entry></row></tbody></tgroup></table></body></topic>`;
    const content = map(["fichas/ft-001.dita", "fichas/ft-002.dita"]);
    return [
      { label: "Cites a sheet of the dossier", expected: "accept", schema: "map", content, files: [{ path: "fichas/ft-001.dita", content: sheet("FT-001", "FT-002") }, { path: "fichas/ft-002.dita", content: sheet("FT-002", "FT-001") }] },
      { label: "Cites a sheet that does not exist", expected: "reject", schema: "map", content, files: [{ path: "fichas/ft-001.dita", content: sheet("FT-001", "FT-009") }, { path: "fichas/ft-002.dita", content: sheet("FT-002", "FT-001") }] },
    ];
  }
  if (/escalonPlan/.test(rule)) {
    const plan = (v) => `<topic id="planificacion"><title>HOJA DE DATOS DE PLANIFICACIÓN CONSOLIDADA</title><body><section><title>DATOS PARA LA PLANIFICACIÓN</title><table><tgroup cols="2"><colspec colname="c1"/><colspec colname="c2"/><thead><row><entry colname="c1">EQUIPO</entry><entry colname="c2">ESCALÓN DE MANTENIMIENTO</entry></row></thead><tbody><row><entry colname="c1">Bomba</entry><entry colname="c2">${v}</entry></row></tbody></tgroup></table></section></body></topic>`;
    const resumen = (v) => `<topic id="resumen"><title>HOJA RESUMEN DE PROCEDIMIENTO</title><body><table><tgroup cols="1"><colspec colname="c1"/><tbody><row><entry colname="c1"><p><b>ESCALÓN DE MANTENIMIENTO</b></p><p>${v}</p></entry></row></tbody></tgroup></table></body></topic>`;
    const files = (a, b) => [{ path: "fichas/planificacion.dita", content: plan(a) }, { path: "fichas/resumen.dita", content: resumen(b) }];
    return [
      { label: "Same level in both sheets", expected: "accept", schema: "map", content: map(["fichas/planificacion.dita", "fichas/resumen.dita"]), files: files("2º escalón", "2º escalón") },
      { label: "Different level in the sheets", expected: "reject", schema: "map", content: map(["fichas/planificacion.dita", "fichas/resumen.dita"]), files: files("2º escalón", "3er escalón") },
    ];
  }
  if (/huerfanas/.test(rule)) {
    const fixed = correcting && /file "comunes\/notas\.dita"/.test(lastUser);
    const notes = fixed
      ? '<topic id="notas"><title>NOTAS COMUNES</title><body><note id="w1" type="warning">Usar gafas de protección.</note></body></topic>'
      : '<notes id="notas"><note id="w1" type="warning">Usar gafas de protección.</note></notes>';
    return [
      { label: "Warning by conref, listed in the safety topic", expected: "accept", schema: "map", content: map(["fichas/precauciones.dita", "fichas/procedimiento.dita"]), files: [PREC, { path: "fichas/procedimiento.dita", content: proc('<note conref="../comunes/notas.dita#notas/w1"/>') }, { path: "comunes/notas.dita", content: notes }] },
      { label: "Warning missing from the safety topic", expected: "reject", schema: "map", content: map(["fichas/precauciones.dita", "fichas/procedimiento.dita"]), files: [PREC, { path: "fichas/procedimiento.dita", content: proc('<note type="warning">Calzar la bomba antes de soltarla.</note>') }] },
    ];
  }
  if (/conrefRoto/.test(rule)) {
    const NOTES = { path: "comunes/notas.dita", content: '<topic id="notas"><title>NOTAS COMUNES</title><body><note id="w1" type="warning">Usar gafas de protección.</note></body></topic>' };
    return [
      { label: "Conref that resolves", expected: "accept", schema: "map", content: map(["fichas/procedimiento.dita"]), files: [{ path: "fichas/procedimiento.dita", content: proc('<note conref="../comunes/notas.dita#notas/w1"/>') }, NOTES] },
      { label: "Conref to a missing file", expected: "reject", schema: "map", content: map(["fichas/procedimiento.dita"]), files: [{ path: "fichas/procedimiento.dita", content: proc('<note conref="../comunes/no-esta.dita#notas/w1"/>') }] },
    ];
  }
  return [
    { label: "Dossier with the safety topic", expected: "accept", schema: "map", content: map(["fichas/precauciones.dita", "fichas/procedimiento.dita"]), files: [PREC, { path: "fichas/procedimiento.dita", content: proc("<p>Tapa desmontada.</p>") }] },
    { label: "Dossier without the safety topic", expected: "reject", schema: "map", content: map(["fichas/procedimiento.dita"]), files: [{ path: "fichas/procedimiento.dita", content: proc("<p>Tapa desmontada.</p>") }] },
  ];
}

function ruleTestReply(systemPrompt, messages) {
  const rule = (systemPrompt.match(/\nThe rule under test \([^)]*\)[^\n]*\n[^\n]*\n([\s\S]*?)\n\nWHAT TO WRITE/) || [])[1] || "";
  const proposal = (systemPrompt.match(/\nProposal: (.*)\n/) || [])[1] || "";
  const schemas = [...systemPrompt.matchAll(/- schema "([\w-]+)": your content goes directly inside/g)].map((m) => m[1]);
  const [ruleSchema, otherSchema] = schemas;
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  const correcting = lastUser.startsWith("Some examples are not valid.");
  const reviewed = /\nPREVIOUS EXAMPLES WERE WRONG:/.test(systemPrompt);
  if (/BROKENJSON/.test(proposal)) {
    return '{"examples": [ {"label": "cut", "expected": "accept", "content": "<para>';
  }
  const answer = (examples) => JSON.stringify({ examples });
  // Mejoras E, Part 1.4: a rule the schema already covers -- the prompt
  // asks for accept examples only ("NO example meant to be rejected").
  // BRDP-EXT-02805 (//inlineapplics outside <idstatus>): an
  // <inlineapplics> in its place, in <status>. BRDP-EXT-02802 (<avee> with
  // children other than the listed ones): a complete <avee> in a <refdm>.
  if (/NO example meant to be rejected/.test(systemPrompt)) {
    const wholeOf = (systemPrompt.match(/your "metadata" is the WHOLE <([\w-]+)>/) || [])[1];
    const minimal = (() => {
      if (!wholeOf) return null;
      const lines = systemPrompt.split("\n");
      const start = lines.findIndex((l) => l.startsWith(`    <${wholeOf}>`));
      if (start === -1) return null;
      const out = [];
      for (let i = start; i < lines.length && lines[i].startsWith("    "); i += 1) out.push(lines[i].slice(4));
      return out.join("\n");
    })();
    const withMeta = (ex, metadata = minimal) => (metadata ? { ...ex, metadata } : ex);
    if (/inlineapplics/.test(rule) && minimal) {
      const inline = minimal.replace("</applic>", '</applic><inlineapplics><applic id="app-0001"><displaytext><p>All</p></displaytext></applic></inlineapplics>');
      return answer([withMeta({ label: "Inline applicabilities in the status section", expected: "accept", schema: ruleSchema || "descript", content: "Remove the access panel." }, inline)]);
    }
    // Mejoras F, Part 2.1 (BRDP-EXT-02640 b): <issno> is required in
    // <dmaddres>, so only an accept example: the minimal section as it is.
    if (/\/\/dmaddres\[not\(issno\)\]/.test(rule) && minimal) {
      return answer([withMeta({ label: "Data module with its issue number", expected: "accept", schema: ruleSchema || "descript", content: "Remove the access panel." })]);
    }
    if (/\/\/avee\/\*/.test(rule)) {
      const avee = "<avee><modelic>AA</modelic><sdc>A</sdc><chapnum>00</chapnum><section>0</section><subsect>0</subsect><subject>00</subject><discode>00</discode><discodev>A</discodev><incode>040</incode><incodev>A</incodev><itemloc>D</itemloc></avee>";
      return answer([withMeta({ label: "Reference with a complete code", expected: "accept", schema: ruleSchema || "descript", content: `See <refdm>${avee}</refdm> for the removal.` })]);
    }
  }
  // Mejoras F, Part 1.3 (BRDP-EXT-02651): a condition on proced/schedule
  // and <reqconds>. Written in proced (the schema the condition needs): the
  // accept example has the preliminary requirements, the reject one not.
  if (/reqconds/.test(rule) && /proced/.test(rule)) {
    const prelreqs = "<prelreqs><reqconds><noconds/></reqconds><reqpers><person man=\"A\"/></reqpers><supequip><nosupeq/></supequip><supplies><nosupply/></supplies><spares><nospares/></spares><safety><nosafety/></safety></prelreqs>";
    const main = "<mainfunc><step1><para>Remove the access panel.</para></step1></mainfunc>";
    return answer([
      { label: "Procedure with its required conditions", expected: "accept", schema: "proced", content: prelreqs + main },
      { label: "Procedure without required conditions", expected: "reject", schema: "proced", content: main },
    ]);
  }
  // Remates B, Part 1: a rule whose path is a condition
  // (//emphasis and //randomList, flag 0). Written from the decision ("no
  // emphasis"), the reject example has an <emphasis> and no random list:
  // the condition is false there, the example contains a name it looks at
  // (case b) -- never sent to the correction round. If a correction ever
  // asked to make the condition TRUE, the simulator would add the
  // <randomList> (pushing the example toward the rule).
  if (/\/\/emphasis and \/\/randomList/.test(rule)) {
    const pushed = correcting && /condition TRUE/.test(lastUser);
    return answer([
      { label: "Step without emphasis", expected: "accept", schema: ruleSchema, content: "Remove the four bolts from the access panel." },
      { label: "Step with emphasis", expected: "reject", schema: ruleSchema, content: pushed ? "Remove the <emphasis>four</emphasis> bolts.<randomList><listItem><para>Panel</para></listItem></randomList>" : "Remove the <emphasis>four</emphasis> bolts from the access panel." },
    ]);
  }
  // "Dentro/fuera de X" (S1000D 3.0.1, general rule
  // //descendant-or-self::seqlist[not(ancestor-or-self::descript)]), as
  // Mistral answered. With one schema (descript, content at <dmodule>, the
  // outside case only in idstatus) the "outside" example goes directly in
  // <content> -- not valid -- and the correction puts it in
  // <descript>/<para>, inside <descript>. Split by schema, the outside one
  // goes in proced; SIDESWAP: first not valid, then the correction writes
  // it in descript (the other side).
  if (/seqlist\[not\(ancestor-or-self::descript\)\]/.test(rule)) {
    const list = "<seqlist><item><para>Open the panel.</para></item><item><para>Remove the filter.</para></item></seqlist>";
    const inDescript = `<content><descript><para0><title>Overview</title><para>${list}</para></para0></descript></content>`;
    if (/examples where <seqlist> is NOT inside <descript>/.test(systemPrompt)) {
      const outside = !/SIDESWAP/.test(proposal)
        ? { schema: "proced", content: list }
        : correcting
          ? { schema: "descript", content: list }
          : { schema: "proced", content: "<seqlist><para>Open the panel.</para></seqlist>" };
      return answer([
        { label: "Sequential list in a procedure", expected: "reject", ...outside },
        { label: "Sequential list in a description", expected: "accept", schema: "descript", content: list },
      ]);
    }
    return answer([
      { label: "Sequential list outside the description", expected: "reject", schema: ruleSchema || "descript", content: correcting ? inDescript : `<content>${list}</content>` },
      { label: "Sequential list in the description", expected: "accept", schema: ruleSchema || "descript", content: inDescript },
    ]);
  }
  if (/ALLINVALID/.test(proposal)) {
    const bad = "<sbSummary><levelledPara><para>Remove the panel.</para></levelledPara></sbSummary>";
    return answer([
      { label: "Invalid accept", expected: "accept", schema: ruleSchema, content: bad },
      { label: "Invalid reject", expected: "reject", schema: ruleSchema, content: bad },
    ]);
  }
  if (/examples are split by schema/.test(systemPrompt) && /ancestor-or-self::(levelledPara|proceduralStep)/.test(rule)) {
    const nest = (el, depth, titleAt = null) => {
      let inner = "";
      for (let level = depth; level >= 1; level -= 1) {
        inner = `<${el}>${level === titleAt ? `<title>Level ${level}</title>` : ""}<para>Level ${level} text.</para>${inner}</${el}>`;
      }
      return inner;
    };
    const split = [...systemPrompt.matchAll(/^- "([\w-]+)": for (.*)$/gm)].map((m) => [m[1], m[2]]);
    const examples = [];
    for (const [schema, names] of split) {
      const el = /proceduralStep/.test(names) ? "proceduralStep" : "levelledPara";
      const what = el === "proceduralStep" ? "step" : "paragraph";
      examples.push(
        { label: `Five ${what} levels`, expected: "accept", schema, content: nest(el, 5) },
        { label: `Six ${what} levels`, expected: "reject", schema, content: nest(el, 6) },
        { label: `Title on ${what} level 5`, expected: "reject", schema, content: nest(el, 5, 5) }
      );
    }
    return answer(examples);
  }
  // Attribute-only rules (S1-00151 //@materialUsage, S1-00563
  // //@timeLimitCategoryValue): the carriers along the way the prompt gives
  // -- inside <preliminaryRqmts> in proced, <timeLimitInfo> in schedul.
  if (/^[^<]*<structureObjectRule[^>]*>\s*<objectPath[^>]*>\/\/@materialUsage</.test(rule)) {
    const equip = (attr) => `<preliminaryRqmts><reqCondGroup><noConds/></reqCondGroup><reqSupportEquips><supportEquipDescrGroup><supportEquipDescr${attr}><name>Torque wrench</name><reqQuantity>1</reqQuantity></supportEquipDescr></supportEquipDescrGroup></reqSupportEquips><reqSupplies><noSupplies/></reqSupplies><reqSpares><noSpares/></reqSpares><reqSafety><noSafety/></reqSafety></preliminaryRqmts><mainProcedure><proceduralStep><para>Tighten the nut.</para></proceduralStep></mainProcedure>`;
    return answer([
      { label: "Support equipment without material usage", expected: "accept", schema: ruleSchema, content: equip("") },
      { label: "Support equipment with material usage", expected: "reject", schema: ruleSchema, content: equip(' materialUsage="mu01"') },
    ]);
  }
  if (/\/\/@timeLimitCategoryValue/.test(rule)) {
    const limit = (value) => `<timeLimitInfo timeLimitIdent="tl-001"><equipGroup><equip><name>Main landing gear</name></equip></equipGroup><timeLimitCategory timeLimitCategoryValue="${value}"/><timeLimit><limitType limitUnitType="lt01"><threshold thresholdUnitOfMeasure="th06"><thresholdValue>6000</thresholdValue></threshold></limitType></timeLimit></timeLimitInfo>`;
    return answer([
      { label: "Hard time limit (category 1)", expected: "accept", schema: ruleSchema, content: limit("1") },
      { label: "Soft time limit (category 2)", expected: "reject", schema: ruleSchema, content: limit("2") },
    ]);
  }
  // Mejoras D, Part 1.1 (BRDP-EXT-02816, //figure//legend/deflist/def[…]):
  // a figure written where the prompt says the content goes; its <def>
  // either matches the @title of a hotspot of the same figure or not.
  if (/\/\/figure\/\/legend\/deflist\/def/.test(rule)) {
    const schema = (systemPrompt.match(/- schema "([\w-]+)": your content goes directly inside/) || [])[1] || "descript";
    const figure = (defs) => `<figure><title>Fuel pump</title><graphic boardno="ICN-EXAMPLE-00001"><hotspot apsid="hs-1" apsname="Pump" title="Pump"/><hotspot apsid="hs-2" apsname="Filter" title="Filter"/></graphic><legend><deflist>${defs.map((d) => `<term>${d}</term><def>${d}</def>`).join("")}</deflist></legend></figure>`;
    return answer([
      { label: "Every definition matches a hotspot title of its figure", expected: "accept", schema, content: figure(["Pump", "Filter"]) },
      { label: "A definition matches no hotspot title", expected: "reject", schema, content: figure(["Pump", "Valve"]) },
    ]);
  }
  // Mejoras C (BRDP-EXT-02613, /dmodule[not(//actref)]): whole documents
  // from the minimal section the prompt quotes. With the prompt's "<actref>
  // goes inside <status>" the reference goes there; without it, inside the
  // content -- the real run's mistake, which the application now moves.
  if (/not\(\/\/actref\)/.test(rule)) {
    const schema = (systemPrompt.match(/- schema "([\w-]+)": your content is the WHOLE document/) || [])[1] || "descript";
    const lines = systemPrompt.split("\n");
    const at = lines.findIndex((l) => l.includes("this minimal, valid one:"));
    const section = [];
    for (let i = at + 1; at !== -1 && i < lines.length && lines[i].startsWith("    "); i += 1) section.push(lines[i].slice(4));
    const base = section.join("\n");
    const actref = "<actref><refdm><avee><modelic>EXAMPLE</modelic><sdc>A</sdc><chapnum>00</chapnum><section>0</section><subsect>0</subsect><subject>00</subject><discode>00</discode><discodev>A</discodev><incode>00W</incode><incodev>A</incodev><itemloc>A</itemloc></avee></refdm></actref>";
    const told = /<actref> goes inside <status>/.test(systemPrompt);
    const doc = (withRef) => `<dmodule>\n${withRef && told ? base.replace(/(<\/orig>)/, `$1\n${actref}`) : base}\n<content><descript><para0><title>Removal</title><para>Remove the cover.</para>${withRef && !told ? actref : ""}</para0></descript></content>\n</dmodule>`;
    return answer([
      { label: "Data module with its ACT reference", expected: "accept", schema, content: doc(true) },
      { label: "Data module without an ACT reference", expected: "reject", schema, content: doc(false) },
    ]);
  }
  // Mejoras G, Part 1.2 (BRDP-EXT-02786): the real run wrote two loose
  // <evaluate> as children of <applic>, which allows only one. The
  // correction round fixes it -- nesting them in one <evaluate> -- only when
  // it brings the maximum ("allows at most 1 <evaluate>").
  if (/count\(evaluate\/evaluate/.test(rule)) {
    const wholeOf = (systemPrompt.match(/your "metadata" is the WHOLE <([\w-]+)>/) || [])[1] || "idstatus";
    const lines = systemPrompt.split("\n");
    const start = lines.findIndex((l) => l.startsWith(`    <${wholeOf}>`));
    const section = [];
    for (let i = start; start !== -1 && i < lines.length && lines[i].startsWith("    "); i += 1) section.push(lines[i].slice(4));
    const base = section.join("\n");
    const told = correcting && /allows at most 1 <evaluate>/.test(lastUser);
    const and = (v) => `<evaluate operator="and"><assert actidref="model" actreftype="prodattr" actvalues="${v}"/><assert actidref="serialno" actreftype="prodattr" actvalues="1-99"/></evaluate>`;
    const evaluations = (n) => (told ? `<evaluate operator="or">${Array.from({ length: n }, (_, i) => and(String.fromCharCode(65 + i))).join("")}</evaluate>` : Array.from({ length: n }, (_, i) => and(String.fromCharCode(65 + i))).join(""));
    const applic = (n) => `<applic><displaytext><p>Model A, serial 1-99</p><p>Model B, serial 1-99</p></displaytext>${evaluations(n)}</applic>`;
    const metadata = (n) => base.replace(/<applic>[\s\S]*?<\/applic>/, applic(n));
    return answer([
      { label: "Two display paragraphs, two evaluations", expected: "accept", schema: ruleSchema || "descript", metadata: metadata(2), content: "Remove the access panel." },
      { label: "Two display paragraphs, one evaluation", expected: "reject", schema: ruleSchema || "descript", metadata: metadata(1), content: "Remove the access panel." },
    ]);
  }
  // Dosier, Part 2: a rule that reads the files of its ditamap -- each
  // example is a dossier (the ditamap as "content" and its "files"). The
  // rule decides which dossier (the template rows BRDP-EXT-00004/7/8/9 of
  // the XPath 3.0 template). For 00008 the first answer gives the common
  // notes file an unknown root (<notes>); the correction round, which names
  // that file, gives it a real <topic>.
  if (/each example is a\s+DOSSIER/.test(systemPrompt)) return answer(dossierExamples(rule, correcting, lastUser, systemPrompt));
  // Test de reglas: referencias, antepasados y reglas de esquema prohibido
  // (CMP 4.2). EXT-00039: like the real run, without the destinations line
  // the referenced <figure> is written inside the <para> (where it cannot
  // go); with it, next to the paragraph, where the prompt says the content
  // goes (<levelledPara>).
  if (/attribute::internalRefId = \/\/figure\/@id/.test(rule)) {
    const told = /The rule compares @internalRefId of <internalRef> with the @id of/.test(systemPrompt);
    const schema = ruleSchema || "descript";
    const figure = '<figure id="fig-0001"><title>Fuel pump</title><graphic infoEntityIdent="ICN-EXAMPLE-00001"/></figure>';
    return answer([
      { label: "Reference to a figure", expected: "accept", schema, content: told ? `${figure}<para>See <internalRef internalRefId="fig-0001"/>.</para>` : `<para>${figure}See <internalRef internalRefId="fig-0001"/>.</para>` },
      { label: "Reference to a paragraph", expected: "reject", schema, content: told ? '<para id="par-0001">Remove the cover.</para><para>See <internalRef internalRefId="par-0001"/>.</para>' : '<para id="par-0001">Remove the cover. See <internalRef internalRefId="par-0001"/>.</para>' },
    ]);
  }
  // EXT-00008: the chain figure/legend/definitionList/title around the
  // <internalRef>. With the chain line the reference goes in the title of
  // the legend's definition list; without it, in the figure's own title.
  if (/ancestor::title\/parent::definitionList\/parent::legend/.test(rule)) {
    const told = /The rule's condition looks at figure\/legend\/definitionList\/title around <internalRef>/.test(systemPrompt);
    const schema = ruleSchema || "descript";
    const figure = (target, inLegend) => `<figure id="fig-0001"><title>Fuel pump${inLegend ? "" : ` <internalRef internalRefId="${target}"/>`}</title><graphic infoEntityIdent="ICN-EXAMPLE-00001"/><legend><definitionList><title>Key${inLegend ? ` to <internalRef internalRefId="${target}"/>` : ""}</title><definitionListItem><listItemTerm>1</listItemTerm><listItemDefinition><para>Valve</para></listItemDefinition></definitionListItem></definitionList></legend></figure>`;
    const other = '<figure id="fig-0002"><title>Valve</title><graphic infoEntityIdent="ICN-EXAMPLE-00002"/></figure>';
    return answer([
      { label: "Legend title pointing to its own figure", expected: "accept", schema, content: figure("fig-0001", told) },
      { label: "Legend title pointing to another figure", expected: "reject", schema, content: `${figure("fig-0002", told)}${other}` },
    ]);
  }
  // Colocación (CMP 4.2). EXT-00030: //assert/child::text(). The examples
  // are an applicability group with an empty / non-empty <assert>, written
  // wherever the prompt says the content goes -- like the real run, in
  // <para> (the old placement) they are invalid, and the correction cannot
  // move them out of it.
  if (/\/\/assert\/child::text\(\)/.test(rule)) {
    const group = (text) => `<referencedApplicGroup><applic id="app-0001"><assert applicPropertyIdent="model" applicPropertyType="prodattr" applicPropertyValues="A"${text === null ? "/>" : `>${text}</assert>`}</applic></referencedApplicGroup>`;
    const schema = ruleSchema || "descript";
    return answer([
      { label: "Empty assert", expected: "accept", schema, content: group(null) },
      { label: "Assert with text", expected: "reject", schema, content: group("Model A") },
      { label: "Assert with only a space", expected: "reject", schema, content: group(" ") },
    ]);
  }
  // EXT-00023: footnotes only in tables (and preliminary requirements).
  // With the way line ("<footnote> inside <table>: …") the table goes where
  // the way starts; without it (the old placement in <para>) the table is
  // written inside the paragraph, which the schema does not allow.
  if (/footnote\[not\(ancestor::table\)/.test(rule)) {
    const way = (systemPrompt.match(/<footnote> inside <table>: ([\w/]+)/) || [])[1];
    const footnote = "<footnote><para>Dry threads.</para></footnote>";
    const table = `<table><title>Torque values${footnote}</title><tgroup cols="1"><tbody><row><entry><para>25</para></entry></row></tbody></tgroup></table>`;
    const schema = ruleSchema || "descript";
    return answer([
      { label: "Footnote in a table", expected: "accept", schema, content: way ? table : `Tighten the bolt. ${table}` },
      { label: "Footnote in a paragraph", expected: "reject", schema, content: way ? `<para>Tighten the bolt${footnote}.</para>` : `Tighten the bolt${footnote}.` },
    ]);
  }
  // Caminos de la sección (CMP 4.2). EXT-00188 / EXT-00189: a caption
  // group / caption inside a <para> of the status section. The reject
  // example follows the first way the prompt (or the correction) gives to
  // the element -- like the real run, the old ways (copyrightPara/emphasis/
  // captionGroup, through no <para>) give a valid example the rule does not
  // select.
  if (/dmStatus\/\/para\/caption/.test(rule)) {
    const leafName = /para\/captionGroup/.test(rule) ? "captionGroup" : "caption";
    const lines = systemPrompt.split("\n");
    const start = lines.findIndex((l) => l.startsWith("    <identAndStatusSection>"));
    const section = [];
    for (let i = start; start !== -1 && i < lines.length && lines[i].startsWith("    "); i += 1) section.push(lines[i].slice(4));
    const source = correcting ? lastUser : systemPrompt;
    const after = source.slice(source.indexOf(`<${leafName}> is not directly inside any element of that section.`));
    const way = ((after.match(/\b(dmStatus\/[\w/]+)/) || [])[1] || `dmStatus/dataRestrictions/restrictionInfo/copyright/copyrightPara/emphasis/${leafName}`).split("/");
    const leaf = leafName === "captionGroup"
      ? '<captionGroup cols="1"><captionBody><captionRow><captionEntry><caption><captionLine>CAUTION</captionLine></caption></captionEntry></captionRow></captionBody></captionGroup>'
      : "<caption><captionLine>CAUTION</captionLine></caption>";
    const open = (name) => (name === "dataRestrictions" ? "<dataRestrictions><restrictionInstructions><dataDistribution>Unlimited</dataDistribution></restrictionInstructions>" : name === "para" ? "<para>Note" : `<${name}>`);
    let inner = leaf;
    for (const name of way.slice(1, -1).reverse()) inner = `${open(name)}${inner}</${name}>`;
    const metadata = section.join("\n");
    const reject = metadata.replace(/(<security [^>]*\/>)/, `$1${inner}`);
    return answer([
      { label: "No caption in the status section", expected: "accept", schema: ruleSchema || "descript", metadata },
      { label: `A ${leafName} inside a paragraph of the status section`, expected: "reject", schema: ruleSchema || "descript", metadata: reject },
    ]);
  }
  // EXT-00291 / EXT-00292: at most six part references in an optional part
  // or a preferred spare part. Like the real run, the <itemSeqNumber> is
  // written straight in <illustratedPartsCatalog>; it is only wrapped in its
  // <catalogSeqNumber> when the correction says so without forbidding it
  // ("goes inside <catalogSeqNumber>" and no "do not change … its nesting").
  if (/partRefGroup\/(?:optionalPart|preferredSparePart)\/partRef\[7\]/.test(rule)) {
    const group = /preferredSparePart/.test(rule) ? "preferredSparePart" : "optionalPart";
    const wrap = correcting && /goes inside <catalogSeqNumber>/.test(lastUser) && !/its nesting/.test(lastUser);
    const refs = (n) => Array.from({ length: n }, (_, i) => `<partRef manufacturerCodeValue="12345" partNumberValue="PN-${i + 1}"/>`).join("");
    const isn = (n) => `<itemSeqNumber itemSeqNumberValue="00A"><quantityPerNextHigherAssy>1</quantityPerNextHigherAssy><partRef manufacturerCodeValue="12345" partNumberValue="PN-0"/><partSegment><itemIdentData><descrForPart>Bolt</descrForPart></itemIdentData><partRefGroup><${group}>${refs(n)}</${group}></partRefGroup></partSegment></itemSeqNumber>`;
    const content = (n) => (wrap ? `<catalogSeqNumber figureNumber="01" indenture="1" item="001">${isn(n)}</catalogSeqNumber>` : isn(n));
    return answer([
      { label: "Six part references", expected: "accept", schema: ruleSchema || "ipd", content: content(6) },
      { label: "Seven part references", expected: "reject", schema: ruleSchema || "ipd", content: content(7) },
      { label: "A procedure", expected: "accept", schema: "proced", content: "Remove the bolt." },
    ]);
  }
  // EXT-00181 / EXT-00224: a changed module whose <reasonForUpdate> is
  // referenced (or not) from the content by @reasonForUpdateRefIds. With
  // the carriers line, on a <para>/<dmRef> of the content; without it, on
  // the status element itself (where it does not exist).
  if (/reasonForUpdateRefIds\/tokenize/.test(rule)) {
    const wholeOf = (systemPrompt.match(/your "metadata" is the WHOLE <([\w-]+)>/) || [])[1] || "identAndStatusSection";
    const lines = systemPrompt.split("\n");
    const start = lines.findIndex((l) => l.startsWith(`    <${wholeOf}>`));
    const section = [];
    for (let i = start; start !== -1 && i < lines.length && lines[i].startsWith("    "); i += 1) section.push(lines[i].slice(4));
    const status = /<pmStatus>/.test(section.join("\n")) ? "pmStatus" : "dmStatus";
    const told = /@reasonForUpdateRefIds goes on:/.test(systemPrompt);
    const metadata = section.join("\n")
      .replace(`<${status}>`, told ? `<${status} issueType="changed">` : `<${status} issueType="changed" reasonForUpdateRefIds="rfu-0001">`)
      .replace("</qualityAssurance>", '</qualityAssurance><reasonForUpdate id="rfu-0001"><simplePara>Torque value changed.</simplePara></reasonForUpdate>');
    const schema = ruleSchema || (status === "pmStatus" ? "pm" : "descript");
    const dmRef = (ref) => `<dmRef${ref ? ' reasonForUpdateRefIds="rfu-0001"' : ""}><dmRefIdent><dmCode assyCode="00" disassyCode="00" disassyCodeVariant="A" infoCode="040" infoCodeVariant="A" itemLocationCode="A" modelIdentCode="EXAMPLE" subSubSystemCode="0" subSystemCode="0" systemCode="00" systemDiffCode="A"/></dmRefIdent></dmRef>`;
    const content = (ref) => (status === "pmStatus" ? dmRef(ref && told) : ref && told ? 'Tighten to <quantity reasonForUpdateRefIds="rfu-0001">25 N.m</quantity>.' : "Tighten the bolt.");
    return answer([
      { label: "Reason for update referenced from the content", expected: "accept", schema, metadata, content: content(true) },
      { label: "Reason for update not referenced", expected: "reject", schema, metadata: metadata.replace(' reasonForUpdateRefIds="rfu-0001"', ""), content: content(false) },
    ]);
  }
  // Default S1000D 4.2 BREX pass, Part 2.1 (BRDP-EXT-00046): a reference
  // of type irtt04 to a supply. Like the real run, the first answer's accept
  // example points to an id no <supplyDescr> has; the correction round that
  // names it ("points to SE123 … no <supplyDescr>") points to the supply.
  // Formato del texto y valores compuestos con concat() (SOPTE, S1000D
  // 3.0.1): the rule compares concat(chapnum, section, subsect, subject)
  // with an SNS. Like the real runs, without the split the SNS is split
  // wrong, one character per element and a two-character subject that
  // loses the rest (<chapnum>A</chapnum><section>9</section><subsect>1
  // </subsect><subject>25</subject>: joined, not the SNS any more); with "is
  // split as …" in the prompt or in the correction request, as said there.
  if (/concat\(/.test(rule) && /chapnum/.test(rule)) {
    const told = (`${systemPrompt}\n${correcting ? lastUser : ""}`.match(/is split as <chapnum>([^<]*)<\/chapnum>, <section>([^<]*)<\/section>, <subsect>([^<]*)<\/subsect>, <subject>([^<]*)<\/subject>/) || []).slice(1);
    const literal = (rule.match(/=\s*'([^']+)'/) || [])[1] || "A91251";
    const pieces = told.length === 4 ? told : [literal.slice(0, 1), literal.slice(1, 2), literal.slice(2, 3), literal.slice(3, 5)];
    const lines = systemPrompt.split("\n");
    const start = lines.findIndex((l) => l === "    <idstatus>");
    const section = [];
    for (let i = start; start !== -1 && i < lines.length && lines[i].startsWith("    "); i += 1) section.push(lines[i].slice(4));
    const minimal = section.join("\n");
    const sns = ([c, se, ss, sj]) => `<chapnum>${c}</chapnum><section>${se}</section><subsect>${ss}</subsect><subject>${sj}</subject>`;
    const avee = (snsPieces, incode = "040") => `<avee><modelic>EXAMPLE</modelic><sdc>A</sdc>${sns(snsPieces)}<discode>00</discode><discodev>A</discodev><incode>${incode}</incode><incodev>A</incodev><itemloc>A</itemloc></avee>`;
    const schema = ruleSchema || "descript";
    if (/\/\/refdm\[/.test(rule)) {
      return answer([
        { label: "Reference to another subject", expected: "accept", schema, metadata: minimal, content: `See <refdm>${avee(["B3", "1", "2", "22"])}</refdm>.` },
        { label: `Reference to SNS ${literal}`, expected: "reject", schema, metadata: minimal, content: `See <refdm>${avee(pieces)}</refdm>.` },
      ]);
    }
    const own = (incode) => minimal.replace(/<dmc>\s*<avee>[\s\S]*?<\/avee>/, `<dmc>${avee(pieces, incode)}`);
    return answer([
      { label: `SNS ${literal} with an allowed information code`, expected: "accept", schema, metadata: own("040") },
      { label: `SNS ${literal} with information code 941`, expected: "reject", schema, metadata: own("941") },
    ]);
  }
  if (/attribute::internalRefId = \/\/supplyDescr\/@id/.test(rule)) {
    const fixed = correcting && /points to SE123/.test(lastUser);
    const procedure = (refId) => `<preliminaryRqmts><reqCondGroup><noConds/></reqCondGroup><reqSupportEquips><noSupportEquips/></reqSupportEquips><reqSupplies><supplyDescrGroup><supplyDescr id="SUP-0001"><name>Sealant</name><identNumber><manufacturerCode>12345</manufacturerCode><partAndSerialNumber><partNumber>PN-0001</partNumber></partAndSerialNumber></identNumber><reqQuantity>1</reqQuantity></supplyDescr></supplyDescrGroup></reqSupplies><reqSpares><noSpares/></reqSpares><reqSafety><noSafety/></reqSafety></preliminaryRqmts><mainProcedure><proceduralStep><para>Apply the sealant <internalRef internalRefId="${refId}" internalRefTargetType="irtt04"/>.</para></proceduralStep></mainProcedure><closeRqmts><reqCondGroup><noConds/></reqCondGroup></closeRqmts>`;
    return answer([
      { label: "Reference to the supply of the procedure", expected: "accept", schema: ruleSchema || "proced", content: procedure(fixed ? "SUP-0001" : "SE123") },
      { label: "Reference to a supply that does not exist", expected: "reject", schema: ruleSchema || "proced", content: procedure("SE123") },
    ]);
  }
  // Atributo, desde donde la IA lo puso (BRDP-EXT-00033): like the real
  // run, @changeMark (and @changeType="reinstate") on <dmStatus>, where 4.2
  // does not allow them. The correction round moves them to <applic> only
  // when it names <applic> inside <dmStatus>, and gives @changeType a value
  // of its list only when the list is in the same message.
  if (/attribute::issueType="rinstate-status"/.test(rule)) {
    const lines = systemPrompt.split("\n");
    const start = lines.findIndex((l) => l === "    <identAndStatusSection>");
    const section = [];
    for (let i = start; start !== -1 && i < lines.length && lines[i].startsWith("    "); i += 1) section.push(lines[i].slice(4));
    const moved = correcting && /Inside <dmStatus> it can go on: <applic>/.test(lastUser);
    const value = moved && /@changeType allowed values: add, delete, modify/.test(lastUser) ? "modify" : "reinstate";
    const marks = ` changeMark="1" changeType="${value}"`;
    const doc = (issueType) => {
      const base = section.join("\n").replace(/<dmStatus\b([^>]*)>/, (_m, a) => `<dmStatus${a.replace(/\s*issueType="[^"]*"/, "")} issueType="${issueType}"${moved ? "" : marks}>`);
      const marked = moved ? base.replace("<applic>", `<applic${marks}>`) : base;
      return `<dmodule>${marked}<content><description><levelledPara><title>Pump</title><para>The pump supplies fuel.</para></levelledPara></description></content></dmodule>`;
    };
    return answer([
      { label: "Status updated, issue type status", expected: "accept", schema: ruleSchema || "descript", content: doc("status") },
      { label: "Status updated, issue type changed", expected: "reject", schema: ruleSchema || "descript", content: doc("changed") },
    ]);
  }
  // Test de reglas: condiciones sobre la sección de identificación del
  // propio documento (BRDP-EXT-00134). Like the real run, the section is
  // written with the minimal one's old infoCode 040 -- never the 0A2 the
  // rule's condition asks for -- so the rule can only apply if the
  // application sets it (and keeps the section at all: the insertion point
  // is the root). The reject example has an <expression> in dmStatus/applic,
  // the only place outside <referencedApplicGroup> in comrep.
  if (/attribute::infoCode="0A2"/.test(rule) && /referencedApplicGroup/.test(rule)) {
    const lines = systemPrompt.split("\n");
    const start = lines.findIndex((l) => l === "    <identAndStatusSection>");
    const section = [];
    for (let i = start; start !== -1 && i < lines.length && lines[i].startsWith("    "); i += 1) section.push(lines[i].slice(4));
    const base = section.join("\n").replace(/(<dmIdent>\s*<dmCode\b[^>]*)infoCode="[^"]*"/, '$1infoCode="040"');
    const expression = '<expression><assert applicPropertyIdent="model" applicPropertyType="prodattr" applicPropertyValues="A"/></expression>';
    const inStatus = base.replace(/(<simplePara>All<\/simplePara>\s*<\/displayText>)/, `$1${expression}`);
    const repo = '<commonRepository><warningRepository><warningSpec><warningIdent warningIdentNumber="W-001"/><warningAndCautionPara>Do not touch the hot surface.</warningAndCautionPara></warningSpec></warningRepository></commonRepository>';
    // La recolocación no debe duplicar un elemento que la app ya creó
    // (BRDP-EVAL-RT-RELOCREPO): like the real run, the repository and the
    // group straight inside <dmodule>, with no <content> -- the group
    // first, so moving it builds <content> with a minimal
    // <commonRepository> before the LLM's own one is moved.
    if (/BRDP-EVAL-RT-RELOCREPO/.test(systemPrompt)) {
      const supply = '<commonRepository><supplyRepository><supplySpec><supplyIdent supplyNumber="S-001" supplyNumberType="sp01"/><name>Grease</name></supplySpec></supplyRepository></commonRepository>';
      const bare = (withExpression) => `<referencedApplicGroup><applic id="app-0001"><displayText><simplePara>Model A</simplePara></displayText>${withExpression ? expression : '<assert applicPropertyIdent="model" applicPropertyType="prodattr" applicPropertyValues="A"/>'}</applic></referencedApplicGroup>\n${supply}`;
      return answer([
        { label: "Expression in the referenced applicability group", expected: "accept", schema: ruleSchema || "comrep", metadata: base, content: bare(true) },
        { label: "Expression in the applicability of the status section", expected: "reject", schema: ruleSchema || "comrep", metadata: inStatus, content: bare(false) },
      ]);
    }
    const group = (withExpression) => `<content>${repo}<referencedApplicGroup><applic id="app-0001"><displayText><simplePara>Model A</simplePara></displayText>${withExpression ? expression : '<assert applicPropertyIdent="model" applicPropertyType="prodattr" applicPropertyValues="A"/>'}</applic></referencedApplicGroup></content>`;
    return answer([
      { label: "Expression in the referenced applicability group", expected: "accept", schema: ruleSchema || "comrep", metadata: base, content: group(true) },
      { label: "Expression in the applicability of the status section", expected: "reject", schema: ruleSchema || "comrep", metadata: inStatus, content: group(false) },
    ]);
  }
  // Part 2.2 (BRDP-EXT-00152): the information code of a BREX data module,
  // in its own identification section (the brex schema, chosen by the
  // rule's predicate /dmodule[content/brex]).
  if (/\/dmodule\[content\/brex\]/.test(rule)) {
    const lines = systemPrompt.split("\n");
    const start = lines.findIndex((l) => l.startsWith("    <identAndStatusSection>"));
    const section = [];
    for (let i = start; start !== -1 && i < lines.length && lines[i].startsWith("    "); i += 1) section.push(lines[i].slice(4));
    const base = section.join("\n");
    const own = (code) =>
      base.replace(/(<dmIdent>\s*<dmCode\b[^>]*>)/, (tag) => tag.replace(/infoCode="[^"]*"/, `infoCode="${code}"`).replace(/itemLocationCode="[^"]*"/, 'itemLocationCode="D"'));
    return answer([
      { label: "BREX with information code 022", expected: "accept", schema: ruleSchema || "brex", metadata: own("022"), content: "The rules of the project." },
      { label: "BREX with information code 040", expected: "reject", schema: ruleSchema || "brex", metadata: own("040"), content: "The rules of the project." },
    ]);
  }
  // Part 2.3 (BRDP-EXT-00127): with the exact way, the <pmRef> goes in the
  // front matter list; without it, nowhere valid (a bare <pmRef> in
  // <frontMatter>).
  // Lo que la app arregla sola (real case EXT-00127 of «Official Default
  // S1000D 4.2 - 001", three generations in a row): <pmCode>PM-001</pmCode>
  // (text, no required attributes) and frontMatterType values outside
  // fm01-fm99. The application fixes all of it on its own; without that,
  // no example could run.
  if (/descendant-or-self::pmRef\[attribute::id/.test(rule) && /BRDP-EVAL-RT-PMCODE/.test(systemPrompt)) {
    const fm = (attr, type) => `<frontMatter><frontMatterList frontMatterType="${type}"><frontMatterSubList><frontMatterPmEntry><pmRef${attr}><pmRefIdent><pmCode>PM-001</pmCode></pmRefIdent></pmRef></frontMatterPmEntry></frontMatterSubList></frontMatterList></frontMatter>`;
    return answer([
      { label: "Reference to a publication module without the attributes", expected: "accept", schema: ruleSchema || "frontmatter", content: fm("", "general") },
      { label: "Reference to a publication module with @id", expected: "reject", schema: ruleSchema || "frontmatter", content: fm(' id="pm-0001"', "tableOfContents") },
      { label: "Reference to a publication module with @authorityName", expected: "reject", schema: ruleSchema || "frontmatter", content: fm(' authorityName="Example authority"', "toc") },
    ]);
  }
  if (/descendant-or-self::pmRef\[attribute::id/.test(rule)) {
    const told = /write it by exactly this way: content\/frontMatter\/frontMatterList\/frontMatterSubList\/frontMatterPmEntry\/pmRef/.test(systemPrompt);
    const pmRef = (attr) => `<pmRef${attr}><pmRefIdent><pmCode modelIdentCode="EXAMPLE" pmIssuer="12345" pmNumber="00001" pmVolume="00"/></pmRefIdent></pmRef>`;
    const fm = (attr) => (told ? `<frontMatter><frontMatterList frontMatterType="fm01"><frontMatterSubList><frontMatterPmEntry>${pmRef(attr)}</frontMatterPmEntry></frontMatterSubList></frontMatterList></frontMatter>` : `<frontMatter>${pmRef(attr)}</frontMatter>`);
    return answer([
      { label: "Reference to a publication module without the attributes", expected: "accept", schema: ruleSchema || "frontmatter", content: fm("") },
      { label: "Reference to a publication module with @id", expected: "reject", schema: ruleSchema || "frontmatter", content: fm(' id="pm-0001"') },
    ]);
  }
  // GMC (pasada «Official Default GMC ATA - 1000BR 4.2 - 015»), Part 1.
  // EXT-00022: like the real run, without the VALUES block the values are
  // written as the objectValue's text ("One-Way"); with it, as
  // @valueAllowed ("1").
  if (/\/\/interchangeability</.test(rule)) {
    const legend = /VALUES: in this rule, the value of each <objectValue> is its @valueAllowed/.test(systemPrompt);
    const csn = (value) => `<catalogSeqNumber figureNumber="01" indenture="1" item="001"><itemSeqNumber itemSeqNumberValue="00A"><applicabilitySegment><interchangeability>${value}</interchangeability></applicabilitySegment></itemSeqNumber></catalogSeqNumber>`;
    return answer([
      { label: "One-way interchangeable part", expected: "accept", schema: ruleSchema, content: csn(legend ? "1" : "One-Way") },
      { label: "Code not allowed by ATA Spec 2000", expected: "reject", schema: ruleSchema, content: csn(legend ? "3" : "Three-Way") },
    ]);
  }
  // Remates: EXT-00043 (CMP 4.2) -- <levelledParaAlts> only directly in
  // <description>. The application writes the content inside the skeleton's
  // <levelledPara>, so the example meant to be accepted always sits inside
  // one: the (correct) rule rejects it -- inconclusive, never failed.
  if (/levelledPara\/levelledParaAlts</.test(rule)) {
    return answer([
      { label: "Alternatives directly in the description", expected: "accept", schema: ruleSchema || "descript", content: "<levelledParaAlts><levelledPara><title>Alternative A</title><para>Text of the first alternative.</para></levelledPara></levelledParaAlts>" },
      { label: "Alternatives inside a levelled paragraph", expected: "reject", schema: ruleSchema || "descript", content: "<levelledPara><title>Outer</title><levelledParaAlts><levelledPara><para>Nested alternative.</para></levelledPara></levelledParaAlts></levelledPara>" },
    ]);
  }
  // EXT-00057: @pmType only goes on the <pm> root -- the values go in
  // "rootAttributes" when the prompt asks for them (never in a content).
  if (/\/\/@pmType</.test(rule)) {
    const schema = (systemPrompt.match(/every example uses the "([\w-]+)" schema/) || [])[1] || "pm";
    if (!/"rootAttributes"/.test(systemPrompt)) {
      return answer([
        { label: "Publication of type pt02", expected: "accept", schema, content: '<pmEntry pmType="pt02"/>' },
        { label: "Publication of type pt09", expected: "reject", schema, content: '<pmEntry pmType="pt09"/>' },
      ]);
    }
    return answer([
      { label: "Publication of type pt02", expected: "accept", schema, rootAttributes: { pmType: "pt02" } },
      { label: "Publication of type pt09", expected: "reject", schema, rootAttributes: { pmType: "pt09" } },
    ]);
  }
  // EXT-00107: //…/partRepository//@unitOfMeasure -- the carrier the prompt
  // names, along the way it gives from <commonRepository>.
  if (/partRepository\/\/@unitOfMeasure/.test(rule)) {
    const part = (unit) => `<partRepository><partSpec><partIdent manufacturerCodeValue="K0001" partNumberValue="P-100"/><itemIdentData><descrForPart>Bolt</descrForPart></itemIdentData><techData><unitOfIssueQualificationSegment unitOfMeasure="${unit}"/></techData></partSpec></partRepository>`;
    const way = /partRepository\/partSpec\/techData\/unitOfIssueQualificationSegment/.test(systemPrompt);
    return answer([
      { label: "Bolts issued by each", expected: "accept", schema: ruleSchema, content: way ? part("EA") : '<partRepository unitOfMeasure="EA"/>' },
      { label: "Bolts issued by pound", expected: "reject", schema: ruleSchema, content: way ? part("LB") : '<partRepository unitOfMeasure="LB"/>' },
    ]);
  }
  const metadata = metadataReply(systemPrompt, rule, answer, messages);
  if (metadata) return metadata;
  // T4, DITA Schematron: the topic type the prompt offers; the examples
  // follow the rule's context (step, the document root, or note).
  const ditaType = (systemPrompt.match(/Every example is a DITA ([\w-]+) \("schema"/) || [])[1];
  if (ditaType) {
    // El título del topic montado (Navantia BRDP-EXT-00011): the context
    // asks an ancestor's title to be 'LISTA DE REFERENCIAS CONSOLIDADAS'
    // and then //section//p. The real run: Mistral gives the <section>
    // itself that title -- with the topic titled "Example topic" nothing
    // was selected; with the topic's title written by the app, the same
    // content is selected.
    // El contexto en la raíz (Navantia BRDP-EXT-00034): the rule applies
    // only to documents whose ROOT <title> (or @base) is the record's. The
    // real run: Mistral puts the record title in a <section> and leaves the
    // topic as "Maintenance Procedures" -- it only writes the title in the
    // root when the prompt says the title is the root's own, or when the
    // correction round says the example must be a document the rule
    // applies to.
    if (/registro de inspecciones, pruebas y acciones/.test(rule) && /context="\/\*\[/.test(rule)) {
      // ROOTSTUBBORN in the Proposal: it never does, not even when corrected.
      const told = !/ROOTSTUBBORN/.test(proposal) && (/write\s+that text in the topic's own <title>/.test(systemPrompt) || messages.some((m) => /must be a document the rule applies to/.test(m.content || "")));
      const T = "Registro de inspecciones, pruebas y acciones de reparación en taller";
      const table = (heads) => `<table><tgroup cols="${heads.length}">${heads.map((_, i) => `<colspec colname="c${i + 1}"/>`).join("")}<thead><row>${heads.map((h, i) => `<entry colname="c${i + 1}">${h}</entry>`).join("")}</row></thead><tbody><row>${heads.map((_, i) => `<entry colname="c${i + 1}">bomba de achique</entry>`).join("")}</row></tbody></tgroup></table>`;
      const doc = (heads) =>
        told
          ? `<${ditaType} id="r1"><title>${T}</title><body><section>${table(heads)}</section></body></${ditaType}>`
          : `<${ditaType} id="r1"><title>Maintenance Procedures</title><body><section><title>${T}</title>${table(heads)}</section></body></${ditaType}>`;
      return answer([
        { label: "Registro con Fecha y Firma", expected: "accept", schema: ditaType, content: doc(["Fecha", "Firma", "Resultado"]) },
        { label: "Registro sin Fecha", expected: "reject", schema: ditaType, content: doc(["Firma", "Resultado"]) },
        { label: "Registro sin Firma", expected: "reject", schema: ditaType, content: doc(["Fecha", "Resultado"]) },
      ]);
    }
    if (/LISTA DE REFERENCIAS CONSOLIDADAS/.test(rule) && /\/\/section\/\//.test(rule)) {
      const list = (...letters) => `<section><title>LISTA DE REFERENCIAS CONSOLIDADAS</title>${letters.map((l) => `<p>(${l}) Manual de mantenimiento de la bomba de achique, edición ${l.toUpperCase()}.</p>`).join("")}</section>`;
      return answer([
        { label: "Apartados en orden", expected: "accept", schema: ditaType, content: list("a", "b", "c") },
        { label: "Falta el apartado (b)", expected: "reject", schema: ditaType, content: list("a", "c") },
        { label: "No empieza por (a)", expected: "reject", schema: ditaType, content: list("b", "c") },
        { label: "Apartado repetido", expected: "reject", schema: ditaType, content: list("a", "a") },
      ]);
    }
    // T4b: a context that depends on an element's title and checks table
    // rows (the real template rule BRDP-EXT-00001). The first answer puts
    // the title on the table itself (table/title, the real run: nothing
    // matches); the correction round -- which names the reject example --
    // wraps the table in a <section> with the context's first title.
    // Barrido final 1/2: MERGEDROWS -- tables with merged rows as Mistral
    // wrote them (c8e8fac): the accept example uses colnames with no
    // <colspec>, a cols lower than its columns and a morerows past the last
    // row (all three fixed by the app); the reject example has a row
    // entirely covered by the morerows above (the app cannot fix it) --
    // the correction round, which gets the exact cells and the pointer to
    // the MODEL TABLE, writes a valid merged row (MERGEDROWSSTUBBORN: it
    // keeps it broken).
    if (/MERGEDROWS/.test(proposal) && /\/\/table/.test(rule)) {
      const title = (rule.match(/context="[^"]*?'([^']+)'/) || [])[1] || "Parts list";
      const head = '<thead><row><entry colname="c1">Part</entry><entry colname="c2">Descripción</entry><entry colname="c3">Cant.</entry></row></thead>';
      const specs = '<colspec colname="c1"/><colspec colname="c2"/><colspec colname="c3"/>';
      const accept = `<section><title>${title}</title><table><tgroup cols="2">${head}<tbody><row><entry colname="c1">P-100</entry><entry colname="c2">Junta tórica</entry><entry colname="c3" morerows="1">2</entry></row><row><entry colname="c1">P-101</entry><entry colname="c2">Arandela</entry></row><row><entry colname="c1">P-102</entry><entry colname="c2">Tuerca</entry><entry colname="c3" morerows="2">4</entry></row></tbody></tgroup></table></section>`;
      const covered = `<section><title>${title}</title><table><tgroup cols="3">${specs}${head}<tbody><row><entry colname="c1" morerows="1">P-100</entry><entry colname="c2" morerows="1">Junta tórica</entry><entry colname="c3">2</entry></row><row><entry colname="c2">Arandela</entry></row><row><entry colname="c1">P-101</entry><entry colname="c2">Tuerca</entry></row></tbody></tgroup></table></section>`;
      const fixed = `<section><title>${title}</title><table><tgroup cols="3">${specs}${head}<tbody><row><entry colname="c1" morerows="1">P-100</entry><entry colname="c2">Junta tórica</entry><entry colname="c3">2</entry></row><row><entry colname="c2">Arandela</entry><entry colname="c3">1</entry></row><row><entry colname="c1">P-101</entry><entry colname="c2">Tuerca</entry></row></tbody></tgroup></table></section>`;
      const gotModel = correcting && /MODEL TABLE/.test(lastUser) && !/MERGEDROWSSTUBBORN/.test(proposal);
      return answer([
        { label: "Merged quantity", expected: "accept", schema: ditaType, content: accept },
        { label: "Part without quantity", expected: "reject", schema: ditaType, content: gotModel ? fixed : covered },
      ]);
    }
    if (/THE RULE DEPENDS ON A TITLE/.test(systemPrompt) && /\/\/table/.test(rule)) {
      const title = (rule.match(/context="[^"]*?'([^']+)'/) || [])[1] || "Parts list";
      const table = (caption, qty) =>
        `<table>${caption ? `<title>${caption}</title>` : ""}<tgroup cols="3"><colspec colname="c1"/><colspec colname="c2"/><colspec colname="c3"/><thead><row><entry colname="c1">Part</entry><entry colname="c2">Descripción</entry><entry colname="c3">Cant.</entry></row></thead><tbody><row><entry colname="c1">P-100</entry><entry colname="c2">Junta tórica</entry>${qty ? `<entry colname="c3">${qty}</entry>` : ""}</row></tbody></tgroup></table>`;
      const wrap = (qty) => (correcting ? `<section><title>${title}</title>${table("", qty)}</section>` : table(title, qty));
      return answer([
        { label: "Part row with quantity", expected: "accept", schema: ditaType, content: wrap("2") },
        { label: "Part row without quantity", expected: "reject", schema: ditaType, content: wrap("") },
      ]);
    }
    // Subir topics anidados aunque cambie el resultado de la regla
    // (BRDP-EVAL-RT-FIRSTLEVEL: a generic rule on the root's first-level
    // nested topics). As Mistral wrote them: the numbered steps inside the
    // procedure's <conbody>, and never corrected -- the application moves them
    // out itself, even though the rule only sees them once moved.
    if (/context="\/concept"/.test(rule) && /count\(concept\[@outputclass = 'numbered'\]\)/.test(rule)) {
      const step = (i) => `<concept id="s${i}" outputclass="numbered"><title>Step ${i}</title><conbody><p>Do step ${i}.</p></conbody></concept>`;
      const procedure = (n) => `<concept id="proc"><title>Pump removal</title><conbody><p>Remove the pump.</p>${Array.from({ length: n }, (_, i) => step(i + 1)).join("")}</conbody></concept>`;
      return answer([
        { label: "Three first-level steps", expected: "accept", schema: ditaType, content: procedure(3) },
        { label: "Four first-level steps", expected: "reject", schema: ditaType, content: procedure(4) },
      ]);
    }
    // Remates, Part 1 (TABLEINCMD): the real case -- a <table> written
    // directly in <cmd>. The application used to wrap it in <draft-comment>
    // (the only child of <cmd> that admits a table); now it does not, and
    // the correction round says where it can go inside <step>. Told
    // "Inside <step> it can go in <info>", the example puts it there.
    if (/TABLEINCMD/.test(proposal) && /context="step"/.test(rule)) {
      const told = correcting && /Inside <step> it can go in <info>/.test(lastUser);
      const table = (v) => `<table><tgroup cols="1"><colspec colname="c1"/><tbody><row><entry colname="c1">${v}</entry></row></tbody></tgroup></table>`;
      return answer([
        { label: "Torque table with the step", expected: "accept", schema: ditaType, content: told ? `<step><cmd>Torque the pump bolts.</cmd><info>${table("25 N.m")}</info></step>` : `<step><cmd>Torque the pump bolts. ${table("25 N.m")}</cmd></step>` },
        { label: "Torque table in the step example", expected: "reject", schema: ditaType, content: `<step><cmd>Torque the pump bolts.</cmd><stepxmp>${table("25 N.m")}</stepxmp></step>` },
      ]);
    }
    if (/context="step"/.test(rule)) {
      // Mejoras H: told "<step> allows at most 1 <cmd>", the correction
      // merges the two commands into one -- what Mistral did (08/10). The
      // app discards that correction: it removed what the schema limits.
      const merged = correcting && /allows at most 1 <cmd>/.test(lastUser);
      return answer([
        { label: "Step with one command", expected: "accept", schema: ditaType, content: "<step><cmd>Remove the four bolts from the pump cover.</cmd></step>" },
        { label: "Step with two commands", expected: "reject", schema: ditaType, content: merged ? "<step><cmd>Remove the bolts and lift the pump cover.</cmd></step>" : "<step><cmd>Remove the bolts.</cmd><cmd>Lift the pump cover.</cmd></step>" },
      ]);
    }
    if (/is the WHOLE document/.test(systemPrompt)) {
      return answer([
        { label: "Topic with xml:lang", expected: "accept", schema: ditaType, content: '<topic id="bilge-pump" xml:lang="en-GB"><title>Bilge pump</title><body><p>Check the pump seals.</p></body></topic>' },
        { label: "Topic without xml:lang", expected: "reject", schema: ditaType, content: '<topic id="bilge-pump"><title>Bilge pump</title><body><p>Check the pump seals.</p></body></topic>' },
      ]);
    }
    const broken = /BROKENSTRUCT|STUBBORN/.test(proposal) && (!correcting || /STUBBORN/.test(proposal));
    return answer([
      { label: "Note with a type", expected: "accept", schema: ditaType, content: '<note type="caution"><p>Isolate the bilge pump before removal.</p></note>' },
      broken
        ? { label: "Note without a type", expected: "reject", schema: ditaType, content: "<note><cmd>Isolate the bilge pump.</cmd></note>" }
        : { label: "Note without a type", expected: "reject", schema: ditaType, content: "<note><p>Isolate the bilge pump before removal.</p></note>" },
    ]);
  }
  if (/SPANNEDCELLS/.test(proposal)) {
    // Cell text inside <para>: S1000D's <entry> takes no text of its own
    // (79e5873, "texto donde el esquema no lo admite"); before that commit
    // the cells held bare text.
    const table = (head) =>
      `<table><title>Torque values</title><tgroup cols="3"><colspec colname="c1"/><colspec colname="c2"/><colspec colname="c3"/>${head ? '<thead><row><entry colname="c1"><para>Panel</para></entry><entry colname="c2"><para>Bolt</para></entry><entry colname="c3"><para>Torque</para></entry></row></thead>' : ""}<tbody><row><entry colname="c1" morerows="1"><para>Access panel</para></entry><entry colname="c2"><para>M6</para></entry><entry colname="c3"><para>10 N.m</para></entry></row><row><entry colname="c1"><para>Access panel</para></entry><entry colname="c2"><para>M8</para></entry><entry colname="c3"><para>25 N.m</para></entry></row></tbody></tgroup></table>`;
    // NOCOLSPECS (C3b follow-up): the same tables with colname c1/c2/c3 and
    // no <colspec> at all (the EXT-00001 run of 29/09); the app adds them.
    const strip = (xml) => (/NOCOLSPECS/.test(proposal) ? xml.replace(/<colspec colname="c\d"\/>/g, "") : xml);
    return answer([
      { label: "Torque table without headings", expected: "accept", schema: ruleSchema, content: strip(table(false)) },
      { label: "Torque table with headings", expected: "reject", schema: ruleSchema, content: strip(table(true)) },
    ]);
  }
  // C3, Part 1a: the real <quantity> case. The first answer is the real
  // run's (@quantityValue as an attribute, @unitOfMeasure that <quantity>
  // does not have); the correction fixes it only when the request carries
  // the card of <quantity> (its allowed children), and otherwise repeats
  // the real second attempt (<quantity><quantityValue>, still invalid).
  if (/@quantityUnitOfMeasure/.test(rule)) {
    const card = /card of <quantity> in the \w+ schema: allowed children: quantityGroup/.test(lastUser);
    const qty = (unit) =>
      !correcting
        ? `<quantity quantityValue="25" unitOfMeasure="${unit}"/>`
        : card
          ? `<quantity><quantityGroup><quantityValue quantityUnitOfMeasure="${unit}">25</quantityValue></quantityGroup></quantity>`
          : `<quantity><quantityValue>25</quantityValue></quantity>`;
    return answer([
      { label: "Torque in N.m", expected: "accept", schema: ruleSchema, content: `Torque the bolts to ${qty("N.m")}.` },
      { label: "Torque in lbf.in", expected: "reject", schema: ruleSchema, content: `Torque the bolts to ${qty("lbf.in")}.` },
    ]);
  }
  if (/@emphasisType/.test(rule)) {
    const broken = /BROKENSTRUCT|STUBBORN/.test(proposal) && (!correcting || /STUBBORN/.test(proposal));
    const examples = [
      { label: "Sealant step with em01", expected: "accept", schema: ruleSchema, content: 'Apply <emphasis emphasisType="em01">sealant</emphasis> to the fastener threads.' },
      broken
        ? { label: "Hot surface warning with em03", expected: "reject", schema: ruleSchema, content: '<warning emphasisType="em03"><content>Hot surface.</content></warning>' }
        : { label: "Sealant step with em03", expected: "reject", schema: ruleSchema, content: 'Apply <emphasis emphasisType="em03">sealant</emphasis> to the fastener threads.' },
    ];
    if (/MISSINGATTR/.test(proposal) && !reviewed) {
      examples.push({ label: "Sealant step without emphasisType", expected: "reject", schema: ruleSchema, content: "Apply <emphasis>sealant</emphasis> to the fastener threads." });
    }
    if (otherSchema) {
      examples.push({ label: "Description with em03", expected: "accept", schema: otherSchema, content: 'The <emphasis emphasisType="em03">sealant</emphasis> is applied to the threads.' });
    }
    return answer(examples);
  }
  // Templates round: the curated content rules.
  // The real run (929d9c5): the first reject example wraps an invalid
  // element in the changeInline; corrected without "Keep a node matched
  // by", the LLM dropped the changeInline and the test was inconclusive.
  if (/\/\/changeInline\[/.test(rule)) {
    const reject = !correcting
      ? '<changeInline changeMark="1"><dmRefCode>Warning lights</dmRefCode></changeInline> come on.'
      : /Keep a node matched by/.test(lastUser)
        ? '<changeInline changeMark="1"><emphasis>Warning lights</emphasis></changeInline> come on.'
        : "Warning lights come on.";
    return answer([
      { label: "Changed words", expected: "accept", schema: ruleSchema, content: 'Set the valve <changeInline changeMark="1">to the open position</changeInline>.' },
      { label: "Whole element in changeInline", expected: "reject", schema: ruleSchema, content: reject },
    ]);
  }
  if (/\/\/internalRef\[/.test(rule)) {
    return answer([
      { label: "Reference to live text", expected: "accept", schema: ruleSchema, content: 'See <internalRef internalRefId="fig-0001"/>; <changeInline changeType="delete" id="chg-0001">old text</changeInline>.' },
      { label: "Reference to deleted text", expected: "reject", schema: ruleSchema, content: 'See <internalRef internalRefId="chg-0001"/>; <changeInline changeType="delete" id="chg-0001">old text</changeInline>.' },
    ]);
  }
  // Plantillas 4.1/4.2: the rows of the rebuilt templates, written along
  // the valid way down the prompt gives.
  if (/\/\/parameter</.test(rule)) {
    const media = (param) => `<para>The animation shows the pump in operation.</para><multimedia><title>Pump operation</title><multimediaObject infoEntityIdent="ICN-EXAMPLE-00001-A-00001-01" multimediaType="3D">${param}</multimediaObject></multimedia>`;
    return answer([
      { label: "Animation without parameters", expected: "accept", schema: ruleSchema, content: media("") },
      { label: "Animation with a parameter", expected: "reject", schema: ruleSchema, content: media('<parameter id="par-0001" parameterName="speed" parameterValue="slow"/>') },
    ]);
  }
  if (/\/\/title\/internalRef/.test(rule)) {
    const list = (title) => `Torque the bolts to the values in the list.<definitionList><title>${title}</title><definitionListItem><listItemTerm>M6 bolt</listItemTerm><listItemDefinition><para>10 N.m, see <internalRef internalRefId="fig-0001"/>.</para></listItemDefinition></definitionListItem></definitionList>`;
    return answer([
      { label: "Reference in the text", expected: "accept", schema: ruleSchema, content: list("Torque values") },
      { label: "Reference in a title", expected: "reject", schema: ruleSchema, content: list('Torque values (<internalRef internalRefId="fig-0001"/>)') },
    ]);
  }
  if (/supportEquipDescr\[not\(@id\)\]/.test(rule)) {
    const rqmts = (attr) => `<preliminaryRqmts><reqSupportEquips><supportEquipDescrGroup><supportEquipDescr${attr}><name>Hydraulic jack</name></supportEquipDescr></supportEquipDescrGroup></reqSupportEquips></preliminaryRqmts><mainProcedure><proceduralStep><para>Lift the aircraft with the hydraulic jack.</para></proceduralStep></mainProcedure>`;
    return answer([
      { label: "Support equipment with an id", expected: "accept", schema: ruleSchema, content: rqmts(' id="seq-0001"') },
      { label: "Support equipment without id", expected: "reject", schema: ruleSchema, content: rqmts("") },
    ]);
  }
  // Mejoras B, Part 6: S1-00219 as Lufthansa writes it (flag 1,
  // //itemSeqNumber/partSegment). The reject example is minimal (an item
  // with a part reference only): the rule already rejects it. If a
  // correction ever named the rule's path ("must contain a node matched by
  // `//itemSeqNumber/partSegment`") the simulator would add the
  // <partSegment>, as a real LLM did, and the example would no longer be a
  // reject -- the test proves it never receives that line. BADEXAMPLE in
  // the title: the reject example has <partSegment/> in every item (a bad
  // example: the rule accepts it, and the panel says why).
  if (/\/\/itemSeqNumber\/partSegment/.test(rule)) {
    const title = (systemPrompt.match(/\nTitle: (.*)\n/) || [])[1] || "";
    const csn = (inner) => `<catalogSeqNumber figureNumber="01" indenture="1" item="001"><itemSeqNumber itemSeqNumberValue="00A">${inner}</itemSeqNumber></catalogSeqNumber>`;
    const segment = "<partSegment><itemIdentData><descrForPart>O-ring</descrForPart></itemIdentData></partSegment>";
    const pushed = correcting && /matched by: `\/\/itemSeqNumber\/partSegment`/.test(lastUser);
    const reject = /BADEXAMPLE/.test(title) ? csn('<partRef manufacturerCodeValue="K0001" partNumberValue="P-100"/><partSegment/>')
      : pushed ? csn(segment) : csn('<partRef manufacturerCodeValue="K0001" partNumberValue="P-100"/>');
    const examples = [
      { label: "Item with its part data", expected: "accept", schema: ruleSchema, content: csn(segment) },
      { label: "Item with a part reference only", expected: "reject", schema: ruleSchema, content: reject },
    ];
    if (otherSchema) examples.push({ label: "Description without parts data", expected: "accept", schema: otherSchema, content: "The pump is held by four bolts." });
    return answer(examples);
  }
  // Mejoras B, Part 6: S1-00123 (//entry/*[@applicRefId]). Written from the
  // decision ("no applicability at entry level"), the reject example puts
  // @applicRefId on the <entry> itself: the rule, which looks at the
  // entry's children, accepts it. If a correction named the rule's full
  // path the simulator would move the attribute to the child <para> (and
  // hide that the rule misses the decision); it never receives it.
  if (/\/\/entry\/\*\[@applicRefId\]/.test(rule)) {
    const moved = correcting && /entry\/\*\[@applicRefId\]/.test(lastUser);
    const table = (cell) => `<table><title>Torque values</title><tgroup cols="2"><colspec colname="c1"/><colspec colname="c2"/><tbody><row><entry colname="c1"><para>M6</para></entry>${cell}</row></tbody></tgroup></table>`;
    return answer([
      { label: "Applicability on the whole table", expected: "accept", schema: ruleSchema, content: table('<entry colname="c2"><para>10 N.m</para></entry>') },
      { label: "Applicability on one entry", expected: "reject", schema: ruleSchema, content: table(moved ? '<entry colname="c2"><para applicRefId="app-0001">12 N.m</para></entry>' : '<entry colname="c2" applicRefId="app-0001"><para>12 N.m</para></entry>') },
    ]);
  }
  if (/itemSeqNumber\[not\(partSegment\)\]/.test(rule)) {
    const csn = (inner) => `<catalogSeqNumber figureNumber="01" indenture="1" item="001"><itemSeqNumber itemSeqNumberValue="00A">${inner}</itemSeqNumber></catalogSeqNumber>`;
    const segment = "<partSegment><itemIdentData><descrForPart>O-ring</descrForPart></itemIdentData></partSegment>";
    const examples = [
      { label: "Item with its part data", expected: "accept", schema: ruleSchema, content: csn(segment) },
      { label: "Item with a part reference only", expected: "reject", schema: ruleSchema, content: csn('<partRef manufacturerCodeValue="K0001" partNumberValue="P-100"/>') },
    ];
    if (otherSchema) examples.push({ label: "Description without parts data", expected: "accept", schema: otherSchema, content: "The pump is held by four bolts." });
    return answer(examples);
  }
  if (/count\(proceduralStep\) = 1/.test(rule)) {
    const step = (n) => `<proceduralStep><para>Remove the panel.</para>${Array.from({ length: n }, (_, i) => `<proceduralStep><para>Substep ${i + 1}.</para></proceduralStep>`).join("")}</proceduralStep>`;
    return answer([
      { label: "Two substeps", expected: "accept", schema: ruleSchema, content: step(2) },
      { label: "One substep", expected: "reject", schema: ruleSchema, content: step(1) },
    ]);
  }
  // Mejoras A, Part 1 (S1-00223 / S1-00224, //optionalPart/catalogSeqNumberRef
  // and //preferredSparePart/catalogSeqNumberRef): written in ipd, along
  // the way the prompt gives (itemSeqNumber/partSegment/partRefGroup).
  const csn = /\/\/(optionalPart|preferredSparePart)\/catalogSeqNumberRef/.exec(rule);
  if (csn) {
    const first = csn[1];
    const content = (x) => `<catalogSeqNumber figureNumber="01" indenture="1" item="001"><itemSeqNumber itemSeqNumberValue="00A"><quantityPerNextHigherAssy>1</quantityPerNextHigherAssy><partRef manufacturerCodeValue="12345" partNumberValue="P1"/><partSegment><itemIdentData><descrForPart>Bolt</descrForPart></itemIdentData><partRefGroup><${first}>${x}<partRef manufacturerCodeValue="12345" partNumberValue="P2"/></${first}></partRefGroup></partSegment><applicabilitySegment><usableOnCodeAssy>A</usableOnCodeAssy></applicabilitySegment></itemSeqNumber></catalogSeqNumber>`;
    return answer([
      { label: `${first} without a CSN reference`, expected: "accept", schema: ruleSchema, content: content("") },
      { label: `${first} with a CSN reference`, expected: "reject", schema: ruleSchema, content: content('<catalogSeqNumberRef figureNumber="02" item="003"/>') },
    ]);
  }
  // Mejoras A, Part 2 (S1-00177, //commonInfo[not(ancestor::procedure)]):
  // the prompt splits the examples by schema -- the one outside a
  // procedure in process, the one inside in proced.
  if (/commonInfo\[not\(ancestor::procedure\)\]/.test(rule)) {
    const ci = "<commonInfo><para>Read the general safety information first.</para></commonInfo>";
    const out = /^- "([\w-]+)": examples where <commonInfo> is NOT inside/m.exec(systemPrompt)?.[1] || ruleSchema;
    const inside = /^- "([\w-]+)": examples where <commonInfo> is inside/m.exec(systemPrompt)?.[1] || ruleSchema;
    return answer([
      { label: "Common information outside a procedure", expected: "reject", schema: out, content: ci },
      { label: "Common information in a procedure", expected: "accept", schema: inside, content: ci },
    ]);
  }
  // Mejoras A, Part 4 (rule-test-4-2-levels-off-by-one): "a maximum of
  // five levels" with count(ancestor::proceduralStep) > 5, which only
  // rejects level 7 and deeper. The examples come from the decision: five
  // levels accepted, six rejected -- the engine accepts the six, so the
  // verdict is never "Correct".
  if (/count\(ancestor::proceduralStep\)/.test(rule) && !/examples are split by schema/.test(systemPrompt)) {
    const nest = (depth) => {
      let inner = "";
      for (let level = depth; level >= 1; level -= 1) inner = `<proceduralStep><para>Level ${level} step.</para>${inner}</proceduralStep>`;
      return inner;
    };
    // Mejoras B, Part 6: a correction naming the rule's full path (with its
    // count(ancestor::…) threshold) would make the simulator add a seventh
    // level, so the reject example would pass and hide the off-by-one; it
    // never receives that line (case b: kept out of the correction round).
    const pushed = correcting && /count\(ancestor::proceduralStep\)/.test(lastUser);
    return answer([
      { label: "Five step levels", expected: "accept", schema: ruleSchema, content: nest(5) },
      { label: "Six step levels", expected: "reject", schema: ruleSchema, content: nest(pushed ? 7 : 6) },
    ]);
  }
  // Pending of the test rule, Part 1: //randomList//randomList (the real
  // S1-00507 run). The first answer puts a <randomList> straight inside
  // another one (invalid). Corrected WITH the valid nesting and "Keep the
  // nesting", it nests it through listItem/para; without it, it moves the
  // list out (valid, but no longer nested: "accepted ✗").
  if (/\/\/randomList\/\/randomList/.test(rule) && !/listItemPrefix/.test(rule)) {
    const single = "<randomList><listItem><para>Remove the access panel.</para></listItem></randomList>";
    const flat = "<randomList><listItem><para>Remove the access panel.</para></listItem><randomList><listItem><para>Remove the screws.</para></listItem></randomList></randomList>";
    const nested = "<randomList><listItem><para>Remove the access panel.<randomList><listItem><para>Remove the screws.</para></listItem></randomList></para></listItem></randomList>";
    const moved = "<randomList><listItem><para>Remove the access panel.</para></listItem></randomList><randomList><listItem><para>Remove the screws.</para></listItem></randomList>";
    // SIBLINGLISTS: the "nested" list is two sibling lists from the start
    // (the real S1-00507 failure the user corrects by hand) and stays so.
    const reject = /SIBLINGLISTS/.test(proposal) ? moved : !correcting ? flat : /Keep the nesting/.test(lastUser) ? nested : moved;
    return answer([
      { label: "One list", expected: "accept", schema: ruleSchema, content: single },
      { label: "List inside a list", expected: "reject", schema: ruleSchema, content: reject },
    ]);
  }
  if (/listItemPrefix/.test(rule)) {
    const list = (attr) => `<randomList${attr}><listItem><para>Item</para></listItem></randomList>`;
    return answer([
      { label: "Default prefix", expected: "accept", schema: ruleSchema, content: list("") },
      { label: "Prefix pf02", expected: "accept", schema: ruleSchema, content: list(' listItemPrefix="pf02"') },
      { label: "Prefix pf07", expected: "reject", schema: ruleSchema, content: list(' listItemPrefix="pf07"') },
    ]);
  }
  if (otherSchema) {
    return answer([
      { label: "Step without emphasis", expected: "accept", schema: ruleSchema, content: "Remove the four bolts from the access panel." },
      { label: "Step with emphasis", expected: "reject", schema: ruleSchema, content: "Remove the <emphasis>four</emphasis> bolts from the access panel." },
      { label: "Description with emphasis", expected: "accept", schema: otherSchema, content: "The access panel is held by <emphasis>four</emphasis> bolts." },
    ]);
  }
  return answer([
    { label: "Torque step without emphasis", expected: "accept", schema: ruleSchema, content: "Torque the bolts to 25 N.m." },
    { label: "Torque step with emphasis", expected: "reject", schema: ruleSchema, content: "Torque the bolts to <emphasis>25 N.m</emphasis>." },
  ]);
}

// Barrido final 1/2: the separate "does the rule implement the Proposal?"
// call. MISMATCH and "at most three substeps" (the real "Revisar" case: the
// rule only forbids exactly one substep) → implements false; PROPCHECKFAIL
// → an answer that is not JSON (the check failed); anything else → true.
// Barrido final 3: three levels with their reason ("yes" / "partly" /
// "no"). PARTLY in the Proposal, or a Proposal that asks to mark values up
// with <quantity> (no rule can check it), answers "partly"; CTRLCHARS
// writes a raw line break inside the reason string.
function ruleProposalCheckReply(systemPrompt) {
  const proposal = (systemPrompt.match(/\nProposal: (.*)\n/) || [])[1] || "";
  if (/PROPCHECKFAIL/.test(proposal)) return "I think the rule is probably fine.";
  let reply;
  if (/MISMATCH/.test(proposal)) {
    reply = { implements: "no", reason: "The Proposal is about CAGE codes; the rule checks <emphasis>." };
  } else if (/at most three substeps|como m[aá]ximo tres subpasos/i.test(proposal)) {
    reply = { implements: "no", reason: "The Proposal allows at most three substeps; the rule only rejects a step with exactly one substep, so four or more are accepted." };
  } else if (/none of these may appear/.test(systemPrompt)) {
    // El juez de la Propuesta y las listas cerradas: like the real run on
    // BRDP-EXT-00019, without the computed PROPOSAL vs RULE lists the
    // rule's forbidden list is read as the allowed one ("no"); with them,
    // "no" only when an element the Proposal names is forbidden.
    const forbidden = (systemPrompt.match(/\n- named in the Proposal and forbidden by the rule: (.*)\n/) || [])[1];
    if (forbidden === undefined) reply = { implements: "no", reason: "The rule allows only partSpec, functionalItemSpec, … while the Proposal allows zoneSpec, zoneIdent, …" };
    else if (forbidden === "(none)") reply = { implements: "yes", reason: "" };
    else reply = { implements: "no", reason: `The rule forbids ${forbidden}, which the Proposal allows.` };
  } else if (/PARTLY|marked up with <quantity>/.test(proposal)) {
    reply = { implements: "partly", reason: "Marking the torque values up with <quantity> cannot be checked by a rule; the rule checks the unit." };
  } else {
    reply = { implements: "yes", reason: "" };
  }
  const text = JSON.stringify(reply);
  return /CTRLCHARS/.test(proposal) ? rawControlChars(text.replace('"reason":"', '"reason":"First line.\\n')) : text;
}

// The JSON escapes \n and \t inside strings written as the raw characters.
function rawControlChars(json) {
  return json.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

// T3b "Review with the assistant": the cause follows the deterministic
// description the prompt carries -- a rule that "cannot reject any content"
// is the rule's fault; otherwise the examples'. UNCLEAR in the Proposal
// forces "unclear".
function isRuleTestReview(text) {
  return text === "Review this failed rule test.";
}

function ruleTestReviewReply(systemPrompt) {
  const proposal = (systemPrompt.match(/\nProposal: (.*)\n/) || [])[1] || "";
  if (/UNCLEAR/.test(proposal)) {
    return JSON.stringify({ cause: "unclear", explanation: "MOCK-REVIEW: the Proposal does not say whether the attribute is required." });
  }
  // T4: an inverted Schematron assert (the Proposal requires @type; the
  // rule rejects every note that has it) is the rule's fault.
  if (/not\(@type\)/.test(systemPrompt)) {
    return JSON.stringify({ cause: "rule", explanation: "MOCK-REVIEW: the assert is inverted: it requires notes WITHOUT @type, but the Proposal requires @type on every note." });
  }
  // Mejoras F (BRDP-EXT-02651): the rule asks for //reqconds the wrong way round.
  if (/reqconds/.test(systemPrompt)) {
    return JSON.stringify({ cause: "rule", explanation: "MOCK-REVIEW: the rule rejects the procedures that HAVE <reqconds>; the Proposal requires it." });
  }
  if (/cannot reject any content/.test(systemPrompt)) {
    return JSON.stringify({ cause: "rule", explanation: "MOCK-REVIEW: the rule allows <emphasis> (allowedObjectFlag 2 without values), but the Proposal forbids it; it should use allowedObjectFlag 0." });
  }
  const spanish = /\b(el|la|los|las|solo|admitirá|atributo)\b/i.test(proposal);
  return JSON.stringify({
    cause: "example",
    explanation: spanish
      ? "MOCK-REVIEW: la Proposal solo restringe los valores de @emphasisType; un <emphasis> sin el atributo cumple la decisión."
      : "MOCK-REVIEW: the Proposal only restricts the values of @emphasisType; an <emphasis> without the attribute follows the decision.",
  });
}

// "Suggest: clear state on BRDP change" round (docs request): opt-in
// per-call delay, armed via POST /slow-next (disarms itself after being
// consumed once) so a verification script has a real window to switch to
// a different BRDP row (or back again) BEFORE a Suggest request resolves
// -- exercising the stale-response-discard path for real instead of
// relying on timing luck. Not tied to any particular BRDP's content
// (Suggest Definition's user message is always the same fixed string
// regardless of which BRDP it's for), so a flag armed/consumed per call
// is simpler and more reliable than a content marker here.
const SLOW_RESPONSE_DELAY_MS = 2500;
let slowNextArmed = 0;
let chatCalls = 0;
// The last user message of every chat call since /reset (GET /chat-requests),
// so a browser script can read the real correction request.
let chatRequests = [];
let slowNextDelayMs = SLOW_RESPONSE_DELAY_MS;
// "Aviso ligado al texto" round: content-independent trigger, armed via
// POST /step-next (one-shot, same convention as /slow-next/-error-next
// above) -- Suggest Definition/Rule's own fixed messages already own a
// dedicated reply (long-text-wrap / long-XML tests, never touched here),
// and Suggest Proposal's fixed user message ("Write the Proposal for this
// BRDP.") carries no room for a content marker either, so this is the
// only way to make ONE Suggest Proposal call return a specific, real
// `<step>`-bearing reply on demand -- needed to actually ACCEPT that text
// into a BRDP's Proposal and observe the vocabulary notice react. Applies
// to whichever call comes next regardless of its own content, exactly
// like /slow-next/-error-next; unarmed, Suggest Proposal keeps its
// existing generic "MOCK-ANSWER: ..." fallback reply unchanged.
let stepNextArmed = false;
let invertNextArmed = false;
// "Suggest: la sugerencia se queda en su BRDP" round (docs request):
// content-independent error trigger, armed via POST /error-next
// (one-shot, like /slow-next). ERROR_TEST above only fires if the
// literal marker ends up inside a user message, but Suggest Definition's
// user message is always the same fixed string regardless of BRDP -- no
// content to embed a marker into -- and Suggest Proposal/Rule's own
// message only forms at all once /similar reports sufficient precedent,
// which the encargo's error-entry edge case doesn't need to set up. This
// flag forces the NEXT call to fail regardless of its content.
let errorNextArmed = false;
// Respuestas cortadas por el límite de tokens: the mock honours the
// request's max_tokens like a real provider -- an answer longer than
// max_tokens * CHARS_PER_TOKEN (3.2, measured on the real EXT-00029 cut:
// "position 12827" at max_tokens 4000) comes back cut there with
// finish_reason "length". POST /truncate-next cuts the NEXT answer in half
// whatever its size (one-shot), for the message of a cut answer.
const CHARS_PER_TOKEN = 3.2;
let truncateNextArmed = false;
// The XML of each example re-indented, and the JSON pretty-printed, as a
// real model writes them (REALSIZE in the prompt, and always for
// BRDP-EXT-00029): the size of the real EXT-00029 answer, which 4000
// tokens could not hold.
function realSize(reply) {
  let data;
  try {
    data = JSON.parse(reply);
  } catch {
    return reply;
  }
  const indent = (xml) => {
    let depth = 0;
    return String(xml)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        if (/^<\//.test(line)) depth = Math.max(0, depth - 1);
        const out = "    ".repeat(depth) + line;
        if (/^<[^/!?][^>]*[^/]>$/.test(line) && !/<\/[^>]+>$/.test(line)) depth += 1;
        return out;
      })
      .join("\n");
  };
  data.examples = (data.examples || []).map((ex) => ({ ...ex, ...(ex.metadata ? { metadata: indent(ex.metadata) } : {}) }));
  return JSON.stringify(data, null, 2);
}

// AI Extract drafting, for interrupting and resuming it in the browser:
//   POST /extract-delay {"ms": N}  every "Write the texts…" answer waits N ms
//                                  (until /reset or ms 0);
//   POST /extract-broken {"on": true|false}  every such answer is not JSON
//                                  (its batches end "failed").
let extractDelayMs = 0;
let extractBroken = false;
let extractCalls = 0;

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && (req.url === "/extract-delay" || req.url === "/extract-broken")) {
    readJsonBody(req).then((body) => {
      if (req.url === "/extract-delay") extractDelayMs = Number(body.ms) || 0;
      else extractBroken = !!body.on;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, extractDelayMs, extractBroken }));
    });
    return;
  }
  if (req.method === "GET" && req.url === "/extract-calls") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ calls: extractCalls }));
    return;
  }
  if (req.method === "GET" && req.url === "/last-proposal-check") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(lastProposalCheck));
    return;
  }
  if (req.method === "GET" && req.url === "/proposal-check-calls") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ calls: proposalCheckCalls }));
    return;
  }
  if (req.method === "POST" && req.url === "/proposal-check-fail-next") {
    proposalCheckFailNext = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "GET" && req.url === "/chat-calls") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ calls: chatCalls }));
    return;
  }
  if (req.method === "GET" && req.url === "/chat-requests") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ requests: chatRequests }));
    return;
  }
  if (req.method === "GET" && req.url === "/last-request") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(lastRequest));
    return;
  }
  if (req.method === "POST" && req.url === "/reset") {
    lastRequest = null;
    lastProposalCheck = null;
    proposalCheckCalls = 0;
    proposalCheckFailNext = false;
    slowNextArmed = 0;
    chatCalls = 0;
    chatRequests = [];
    extractDelayMs = 0;
    extractBroken = false;
    extractCalls = 0;
    errorNextArmed = false;
    stepNextArmed = false;
    truncateNextArmed = false;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && (req.url === "/slow-next" || req.url.startsWith("/slow-next?"))) {
    // ?ms=N (progreso y límite de tiempo): a longer delay, to go past the
    // proxy's LLM_REQUEST_TIMEOUT_SECONDS; ?count=N delays the next N calls.
    const params = new URL(req.url, "http://x").searchParams;
    slowNextArmed = Number(params.get("count")) || 1;
    slowNextDelayMs = Number(params.get("ms")) || SLOW_RESPONSE_DELAY_MS;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, delayMs: slowNextDelayMs, count: slowNextArmed }));
    return;
  }
  if (req.method === "POST" && req.url === "/error-next") {
    errorNextArmed = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && req.url === "/truncate-next") {
    truncateNextArmed = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && req.url === "/invert-next") {
    invertNextArmed = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && req.url === "/step-next") {
    stepNextArmed = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end("bad json");
      return;
    }
    // Every chat call, counted (GET /chat-calls; progreso y límite de
    // tiempo: "Cancel" sends nothing more).
    chatCalls += 1;
    chatRequests.push({ lastUser: [...(parsed.messages || [])].reverse().find((m) => m.role === "user")?.content || "" });
    // Barrido final 1/2: the Proposal check runs in parallel with the
    // examples of every rule test. It is answered here, apart: it never
    // becomes the /last-request and never consumes a one-shot flag armed
    // for the examples (/truncate-next, /error-next, /slow-next…), so the
    // existing scripts see the same requests as before. GET
    // /last-proposal-check and /proposal-check-calls show it; POST
    // /proposal-check-fail-next makes the next one answer something that
    // is not JSON.
    const checkUser = [...(parsed.messages || [])].reverse().find((m) => m.role === "user")?.content;
    if (checkUser === "Check whether the rule implements the Proposal.") {
      lastProposalCheck = parsed;
      proposalCheckCalls += 1;
      const system = (parsed.messages || []).find((m) => m.role === "system")?.content || "";
      const content = proposalCheckFailNext ? "I think the rule is probably fine." : ruleProposalCheckReply(system);
      proposalCheckFailNext = false;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }));
      return;
    }
    lastRequest = parsed;
    const messages = parsed.messages || [];
    const nonSystem = messages.filter((m) => m.role !== "system");
    const lastUser = [...nonSystem].reverse().find((m) => m.role === "user");
    const userText = lastUser?.content || "";
    const hasPriorTurn = nonSystem.length > 1; // prev user+assistant, plus the new question

    // Deterministic failure trigger -- exercises askGeneric's catch branch
    // (the real network-failure path) without relying on a flaky real
    // network condition.
    if (/ERROR_TEST/.test(userText)) {
      console.log("chat call -- simulated 500 (ERROR_TEST)");
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "simulated failure for ERROR_TEST" }));
      return;
    }
    if (errorNextArmed) {
      errorNextArmed = false; // one-shot
      console.log("chat call -- simulated 500 (armed via /error-next)");
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "simulated failure (armed via /error-next)" }));
      return;
    }

    let reply;
    if (stepNextArmed) {
      stepNextArmed = false; // one-shot -- doesn't affect the next unrelated call
      reply = "MOCK-STEP-PROPOSAL: The <step> [YES/NO] be used.";
    } else if (isOffTopic(userText)) {
      reply =
        "MOCK-OFFTOPIC: That question is not about this BRDP. Please select the correct BRDP, or rephrase your question so it's about this one.";
    } else if (isMarkdownTest(userText)) {
      reply =
        "**MOCK-MARKDOWN** answer with real structure:\n\n" +
        "- First point about `allowedObjectFlag`\n" +
        "- Second point, *emphasized*\n\n" +
        "Use `objectPath` for the context.";
    } else if (isHtmlTest(userText)) {
      reply = "MOCK-HTML-TEST: the element <table> and the tag <originator> must render as literal text, never as real HTML.";
    } else if (/NCAGE_CORRECT/.test(userText)) {
      // The shape of the real correct answers (bold name, "does not
      // contain ... including @ncage").
      reply = "The attribute **@ncage** does not exist in the S1000D 3.0.1 schema. The schema facts do not contain any element or attribute for the NCAGE code, including @ncage, so I cannot confirm the name; look up NCAGE in the S1000D 3.0.1 specification.";
    } else if (/NCAGE/.test(userText)) {
      // "Ask: comprobar los nombres de la respuesta": the real wrong answer
      // (S1000D 3.0.1) -- a 4.x element and the BRDP's nonexistent @ncage.
      reply = "ncage es un atributo del elemento `<identAndStatusSection>`, que agrupa los datos de identificación y estado del módulo de datos.";
    } else if (/IDSTATUS_TEST/.test(userText)) {
      reply = "En S1000D 3.0.1 los datos de identificación y estado van en `<idstatus>`, dentro de `<dmodule>`.";
    } else if (isSuggestTitle(userText)) {
      reply = suggestTitleReply(messages.find((m) => m.role === "system")?.content);
    } else if (isSuggestDefinition(userText)) {
      reply =
        "MOCK-LONG-DEFINITION: This decision point governs the applicability and scope of the allowedObjectFlag attribute across every structureObjectRule and nonContextRule in the data module, including split-rule variants, and must be evaluated consistently for every objectPath regardless of dmCode context or system differences. " +
        "Alsounabrokenverylongsingletokenwithnowhitespaceatallxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    } else if (userText === "Find the decisions in this text.") {
      const found = findDecisionsReply(messages.find((m) => m.role === "system")?.content || "");
      reply = found.reply;
      if (found.truncate) truncateNextArmed = true;
    } else if (userText === "Write the texts for these BRDPs.") {
      extractCalls += 1;
      reply = extractBroken ? "Sorry, here are the texts: {not json" : extractReply(messages.find((m) => m.role === "system")?.content || "");
    } else if (isSuggestRule(userText)) {
      reply = suggestRuleReply(messages.find((m) => m.role === "system")?.content || "");
    } else if (isRuleTestReview(userText)) {
      reply = ruleTestReviewReply(messages.find((m) => m.role === "system")?.content || "");
    } else if (isRuleTest(userText)) {
      reply = ruleTestReply(messages.find((m) => m.role === "system")?.content || "", messages);
      // POST /invert-next: the next examples come back with accept and
      // reject swapped, so a correct rule gets an "incorrect" verdict (a
      // passed test followed by a failed one, for "do not replace a passed
      // test without asking").
      if (invertNextArmed && userText === "Write the test examples for this rule.") {
        invertNextArmed = false;
        try {
          const data = JSON.parse(reply);
          data.examples = data.examples.map((ex) => ({ ...ex, expected: ex.expected === "accept" ? "reject" : "accept" }));
          reply = JSON.stringify(data);
        } catch {
          // not JSON (BROKENJSON): left as it is
        }
      }
      // BRDP-EXT-00029 always at its real size (the case that was cut).
      if (/REALSIZE|\/ddn or \/dml/.test(messages.find((m) => m.role === "system")?.content || "")) reply = realSize(reply);
      // Barrido final 3, Part 2: CTRLCHARS in the Proposal writes the line
      // breaks inside the JSON strings raw, as Mistral did ("Bad control
      // character in string literal"); the app's reader escapes them.
      if (/CTRLCHARS/.test(messages.find((m) => m.role === "system")?.content || "")) reply = rawControlChars(reply);
    } else if (hasPriorTurn) {
      reply = `MOCK-FOLLOWUP: Building on my previous answer, here is more detail in response to: "${userText}"`;
    } else if (/<warning> y cu[aá]ndo conviene/.test(userText) || /SCHEMAFACTSNAME/.test(userText)) {
      // Barrido final 1/2: the two real patterns of a Mistral answer that
      // named the cards block (ask-open-question-no-disclaimer, c8e8fac);
      // the app cleans them from what the user sees.
      reply =
        "MOCK-ANSWER: El elemento <warning> sirve para avisar de un peligro para las personas. Puede ir dentro de varios elementos, según los **SCHEMA FACTS**:\n- <proceduralStep>\n- <levelledPara>\n\nConviene usarlo antes del paso al que se refiere, como indica la tarjeta de esquema proporcionada (SCHEMA FACTS).";
    } else {
      reply = `MOCK-ANSWER: Here is information about this BRDP, in response to: "${userText}"`;
    }

    console.log(`chat call -- offTopic=${isOffTopic(userText)} hasPriorTurn=${hasPriorTurn}`);
    const send = () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      // OpenAI/Mistral-compatible shape -- matches what llmAPI.js's
      // sendMessage() parses for any non-Anthropic provider:
      // data.choices[0].message.content
      let finishReason = "stop";
      const limit = Math.floor((Number(parsed.max_tokens) || Infinity) * CHARS_PER_TOKEN);
      if (truncateNextArmed) {
        truncateNextArmed = false; // one-shot
        reply = reply.slice(0, Math.floor(reply.length / 2));
        finishReason = "length";
      } else if (reply.length > limit) {
        reply = reply.slice(0, limit);
        finishReason = "length";
      }
      if (finishReason === "length") console.log(`chat call -- answer cut at ${reply.length} chars (max_tokens ${parsed.max_tokens})`);
      res.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: finishReason }] }));
    };
    if (extractDelayMs && userText === "Write the texts for these BRDPs.") {
      setTimeout(send, extractDelayMs);
    } else if (slowNextArmed > 0) {
      slowNextArmed -= 1; // one-shot by default -- doesn't affect later unrelated calls
      console.log(`chat call -- delaying ${slowNextDelayMs}ms (armed via /slow-next)`);
      setTimeout(send, slowNextDelayMs);
    } else {
      send();
    }
  });
});

server.listen(PORT, () => console.log(`Mock Mistral chat server listening on :${PORT}`));
