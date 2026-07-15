/**
 * Mock BRDP Records
 * Contains realistic S1000D Issue 4.2 Business Rules Data Package records
 */

/**
 * @typedef {Object} BRDPRecord
 * @property {string} id - BRDP identifier
 * @property {string} title - BRDP title
 * @property {string} definition - BRDP definition with S1000D terminology
 * @property {string} proposal - ATX decision proposal
 * @property {string} validation - Validation status
 * @property {string} comment - Additional comments
 */

/**
 * Array of 10 S1000D BRDP records from specification
 * Mix of validation statuses: 7 Validated, 1 Refused, 2 Pending
 * @type {BRDPRecord[]}
 */
export const mockBRDPs = [
  {
    id: 'BRDP-S1-00001',
    title: 'Use of "I" and "O"',
    definition: 'Decide whether and when to use the alpha characters "I" and "O".',
    proposal: 'The use of alpha  characters "I" and "O" in S1000D data shall be compliant with ATA iSpec 2200, Specification 2000, and the CSDD.',
    validation: 'Refused',
    comment: 'The characters "I" and "O" shall not be used for coding. There are no restrictions on the use of characters "I" and "O" for textual writing.',
  },
  {
    id: 'BRDP-S1-00002',
    title: 'List of permitted CAGE codes and/or names to be used for the technical publication project',
    definition: 'Create a list of permitted CAGE codes and/or names of the enterprises.',
    proposal: 'XXXXX is permitted as CAGE code in this project.',
    validation: 'Validated',
    comment: 'The list of permit CAGE codes and/or names of the enterprises shall be defined in the project-specific IPSP or TPDP.',
  },
  {
    id: 'BRDP-S1-00003',
    title: 'Issue of S1000D to be used',
    definition: 'Decide which issue or issues of S1000D to be used.',
    proposal: 'S1000D issue 4.2 shall be used.',
    validation: 'Pending',
    comment: 'S1000D Issue No. 4.01 shall be used.',
  },
  {
    id: 'BRDP-S1-00004',
    title: 'Information sets to be used',
    definition: 'Decide which information sets, given in S1000D and/or project specific, to be used.',
    proposal: 'Equipment Information shall be used',
    validation: 'Validated',
    comment: 'Information sets to be used are defined in the S1000D Agency Instruction.',
  },
  {
    id: 'BRDP-S1-00005',
    title: 'Publications to be produced',
    definition: 'Decide which publications to be produced.',
    proposal: 'One CMP per LRU (=project) as XML delivery package\nInstallation Publication per customer listing the specifics of the component installation allowed.\nPDF export optional.',
    validation: 'Validated',
    comment: 'The list of publications to be produced shall be stipulated in the contract SOW or, if the required information is not available at the time of the bidding, they shall be defined in the project-specific. Default is Operations and Maintenance Manual (OMM)',
  },
  {
    id: 'BRDP-S1-00006',
    title: 'Schemas to be used',
    definition: 'Decide which Schemas to be used and in which information set they are to be used.',
    proposal: 'Descriptive, Procedural and IPD schemas shall be used as per Writing Style Guide',
    validation: 'Validated',
    comment: 'Default schemas are defined in the S1000D Agency Instruction  Information code index.',
  },
  {
    id: 'BRDP-S1-00007',
    title: 'Use of optional elements and attributes',
    definition: 'Decide whether and how to use each optional element and attribute in its structural context.',
    proposal: 'Refer to Section 2-3 for General Civil Aviation rules for element and attribute usage.',
    validation: 'Validated',
    comment: 'Optional elements and attributes shall be described individually, when used.',
  },
  {
    id: 'BRDP-S1-00008',
    title: 'Possible deliverables',
    definition: 'Decide on the possible deliverables, such as: \nS1000D objects (eg, data modules, publication modules, illustration sheets and multimedia objects, data management lists) using file based transfer. Refer to Chap 7.5.1.\nPage-oriented publications and/or interactive electronic technical publications',
    proposal: 'As per Spec 1000BR Section 3-2-3, LHT expects and sends a Transfer Package including DDN , PM, Content DM, ACT, CIR Enterprise and ICN when referenced within a DM. PDF export optional.',
    validation: 'Validated',
    comment: 'Required deliverables are defined in the  S1000D Agency Instruction.',
  },
  {
    id: 'BRDP-S1-00009',
    title: 'Frequency of data exchanges',
    definition: 'Decide on the frequency of data exchanges.',
    proposal: 'Exchange on demand.',
    validation: 'Validated',
    comment: 'The frequency of data exchanges shall be defined in the project-specifi.',
  },
  {
    id: 'BRDP-S1-00010',
    title: 'Zone and access point identification system',
    definition: 'Decide whether to use a zoning and access identification system.',
    proposal: 'Zoning rules shall not be applied for CMPs',
    validation: 'Validated',
    comment: 'Zoning and access identification shall not be used',
  },
];
