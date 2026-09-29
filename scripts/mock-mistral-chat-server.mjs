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
  if (/LONGRULE/.test(proposal)) {
    return '<structureObjectRule id="MOCK-LONG-RULE"><objectPath allowedObjectFlag="1">/dmodule/content/description/verylongunbrokenxpathsegmentnamewithnowhitespaceatallxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx[@attr=\'value\']</objectPath><objectUse>MOCK-LONG-RULE</objectUse></structureObjectRule>';
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
//   MISMATCH     "proposalMismatch" filled in
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
function metadataReply(systemPrompt, rule, answer) {
  const element = (systemPrompt.match(/your "metadata" is the WHOLE <([\w-]+)>/) || [])[1];
  if (!element) return null;
  const schema = (systemPrompt.match(/- schema "([\w-]+)": (?:the application builds the rest|your content goes directly inside)/) || [])[1];
  const lines = systemPrompt.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`    <${element}>`)) - 1;
  const minimal = [];
  for (let i = start + 1; i < lines.length && lines[i].startsWith("    "); i += 1) minimal.push(lines[i].slice(4));
  const base = minimal.join("\n");
  const ex = (label, expected, metadata, content) => ({ label, expected, schema, metadata, ...(content !== undefined ? { content } : {}) });
  const ownCode = (attr, value) => base.replace(new RegExp(`(<dmIdent>\\s*<dmCode [^>]*?)${attr}="[^"]*"`), `$1${attr}="${value}"`);
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
  if (/@assyCode/.test(rule)) {
    const dmRef = (assy) => `See <dmRef><dmRefIdent><dmCode modelIdentCode="EXAMPLE" systemDiffCode="A" systemCode="00" subSystemCode="0" subSubSystemCode="0" assyCode="${assy}" disassyCode="00" disassyCodeVariant="A" infoCode="520" infoCodeVariant="A" itemLocationCode="A"/></dmRefIdent></dmRef>.`;
    return answer([ex("Two-character codes", "accept", base, dmRef("01")), ex("Four characters in a reference", "reject", base, dmRef("0301")), ex("Three characters in the own code", "reject", ownCode("assyCode", "001"), dmRef("01"))]);
  }
  return null;
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
    return '{"proposalMismatch": null, "examples": [ {"label": "cut", "expected": "accept", "content": "<para>';
  }
  const mismatch = /MISMATCH/.test(proposal)
    ? "This rule does not seem to implement the Proposal (the Proposal is about CAGE codes; the rule checks <emphasis>)."
    : null;
  const answer = (examples) => JSON.stringify({ proposalMismatch: mismatch, examples });
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
  const metadata = metadataReply(systemPrompt, rule, answer);
  if (metadata) return metadata;
  // T4, DITA Schematron: the topic type the prompt offers; the examples
  // follow the rule's context (step, the document root, or note).
  const ditaType = (systemPrompt.match(/Every example is a DITA ([\w-]+) \("schema"/) || [])[1];
  if (ditaType) {
    // T4b: a context that depends on an element's title and checks table
    // rows (the real template rule BRDP-EXT-00001). The first answer puts
    // the title on the table itself (table/title, the real run: nothing
    // matches); the correction round -- which names the reject example --
    // wraps the table in a <section> with the context's first title.
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
    if (/context="step"/.test(rule)) {
      return answer([
        { label: "Step with one command", expected: "accept", schema: ditaType, content: "<step><cmd>Remove the four bolts from the pump cover.</cmd></step>" },
        { label: "Step with two commands", expected: "reject", schema: ditaType, content: "<step><cmd>Remove the bolts.</cmd><cmd>Lift the pump cover.</cmd></step>" },
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
    const table = (head) =>
      `<table><title>Torque values</title><tgroup cols="3"><colspec colname="c1"/><colspec colname="c2"/><colspec colname="c3"/>${head ? '<thead><row><entry colname="c1">Panel</entry><entry colname="c2">Bolt</entry><entry colname="c3">Torque</entry></row></thead>' : ""}<tbody><row><entry colname="c1" morerows="1">Access panel</entry><entry colname="c2">M6</entry><entry colname="c3">10 N.m</entry></row><row><entry colname="c1">Access panel</entry><entry colname="c2">M8</entry><entry colname="c3">25 N.m</entry></row></tbody></tgroup></table>`;
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
let slowNextArmed = false;
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

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/last-request") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(lastRequest));
    return;
  }
  if (req.method === "POST" && req.url === "/reset") {
    lastRequest = null;
    slowNextArmed = false;
    errorNextArmed = false;
    stepNextArmed = false;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === "POST" && req.url === "/slow-next") {
    slowNextArmed = true;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, delayMs: SLOW_RESPONSE_DELAY_MS }));
    return;
  }
  if (req.method === "POST" && req.url === "/error-next") {
    errorNextArmed = true;
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
    } else if (isSuggestDefinition(userText)) {
      reply =
        "MOCK-LONG-DEFINITION: This decision point governs the applicability and scope of the allowedObjectFlag attribute across every structureObjectRule and nonContextRule in the data module, including split-rule variants, and must be evaluated consistently for every objectPath regardless of dmCode context or system differences. " +
        "Alsounabrokenverylongsingletokenwithnowhitespaceatallxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
    } else if (isSuggestRule(userText)) {
      reply = suggestRuleReply(messages.find((m) => m.role === "system")?.content || "");
    } else if (isRuleTestReview(userText)) {
      reply = ruleTestReviewReply(messages.find((m) => m.role === "system")?.content || "");
    } else if (isRuleTest(userText)) {
      reply = ruleTestReply(messages.find((m) => m.role === "system")?.content || "", messages);
    } else if (hasPriorTurn) {
      reply = `MOCK-FOLLOWUP: Building on my previous answer, here is more detail in response to: "${userText}"`;
    } else {
      reply = `MOCK-ANSWER: Here is information about this BRDP, in response to: "${userText}"`;
    }

    console.log(`chat call -- offTopic=${isOffTopic(userText)} hasPriorTurn=${hasPriorTurn}`);
    const send = () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      // OpenAI/Mistral-compatible shape -- matches what llmAPI.js's
      // sendMessage() parses for any non-Anthropic provider:
      // data.choices[0].message.content
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    };
    if (slowNextArmed) {
      slowNextArmed = false; // one-shot -- doesn't affect the next unrelated call
      console.log(`chat call -- delaying ${SLOW_RESPONSE_DELAY_MS}ms (armed via /slow-next)`);
      setTimeout(send, SLOW_RESPONSE_DELAY_MS);
    } else {
      send();
    }
  });
});

server.listen(PORT, () => console.log(`Mock Mistral chat server listening on :${PORT}`));
