# Project BREXdoc - S1000D Issue 4.2 (extract)

This extract of the project BREXdoc explains how the business rules of the project are presented to the authors of the aircraft maintenance manual. The full BREXdoc follows the order of the chapters of S1000D and lists every decision taken by the project together with its rationale. Only the parts about procedures, warnings and tables are reproduced here. The other chapters, about applicability, illustrations and the publication modules, are kept in the complete document that the project issues with every delivery.

## Procedures

Procedural data modules are written by the authoring team in the central repository and are reviewed by the engineering department before every delivery to the customer.

Each procedural step shall describe one action only. A step that needs two actions is split into two consecutive <proceduralStep> elements.

In line with BRDP-S1-00187, a <proceduralStep> that contains sub-steps shall contain at least two of them; a single sub-step is written as part of its parent step instead.

The project uses an XML editor shared by all the authors, and the publications are delivered to the customer as an interactive electronic technical publication and as PDF files. Training on the authoring tools is given to new authors during their first week in the team.

## Warnings and cautions

Warnings shall always be placed before the step they apply to, never after it.

Cautions shall be written in a <caution> element; a <note> must never be used to give a caution.

## Tables

Every table must have a title in its <title> element, even when the table is short.

## Reminder

Remember that one <proceduralStep> never combines two different actions: every action has its own step, however short the actions are.

Questions about these rules are sent to the project's documentation manager. Change requests to the BREXdoc are discussed in the monthly meeting of the authoring team and are included in the next issue of the document.
