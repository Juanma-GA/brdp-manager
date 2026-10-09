// Hand-written DITA dossiers for the four dossier rules of the DITA XPath 3.0
// template (BRDP-EXT-00004, 00007, 00008, 00009). Used by
// scripts/test-rule-test-dossier.mjs (Node, xmldom) and
// scripts/verify-rule-test-dossier.mjs (Chromium's DOMParser): the same
// dossiers must give the same verdicts in both.
//
// Every case: { name, status, files: [{ path, xml }], main?, ids?, message? }.
// The main document (the ditamap) is DOSSIER_MAP unless `main` is given; the
// dossier's folder is file:///dossier/, the ditamap is dosier.ditamap.

export const DOSSIER_MAP =
  '<map><title>Dosier de mantenimiento</title>' +
  '<topicref href="fichas/precauciones.dita"/>' +
  '<topicref href="fichas/procedimiento.dita#procedimiento"/>' +
  '</map>';

const precauciones = (steps = ['No fumar en la zona de trabajo.', 'Usar gafas de protección.']) =>
  '<task id="precauciones"><title>PRECAUCIONES DE SEGURIDAD</title><taskbody><steps>' +
  steps.map((s) => `<step><cmd>${s}</cmd></step>`).join('') +
  '</steps></taskbody></task>';

const procedimiento = (info) =>
  '<task id="procedimiento"><title>PROCEDIMIENTO</title><taskbody><steps>' +
  `<step><cmd>Desmontar la tapa de la bomba.</cmd><info>${info}</info></step>` +
  '</steps></taskbody></task>';

const NOTAS_COMUNES =
  '<topic id="notas"><title>NOTAS COMUNES</title><body>' +
  '<note id="w1" type="warning">Usar gafas de protección.</note>' +
  '<note id="w2" type="warning">Desconectar la alimentación eléctrica.</note>' +
  '</body></topic>';

const PREC = { path: 'fichas/precauciones.dita', xml: precauciones() };
const proc = (info) => ({ path: 'fichas/procedimiento.dita', xml: procedimiento(info) });
const NOTAS = { path: 'comunes/notas.dita', xml: NOTAS_COMUNES };

// BRDP-EXT-00004: the planning sheet and the procedure sheet give the same
// maintenance level ("escalón").
const planificacion = (escalon) =>
  '<topic id="planificacion"><title>HOJA DE DATOS DE PLANIFICACIÓN CONSOLIDADA</title><body>' +
  '<section><title>DATOS PARA LA PLANIFICACIÓN</title>' +
  '<table><tgroup cols="2"><colspec colname="c1"/><colspec colname="c2"/>' +
  '<thead><row><entry colname="c1">EQUIPO</entry><entry colname="c2">ESCALÓN DE MANTENIMIENTO</entry></row></thead>' +
  `<tbody><row><entry colname="c1">Bomba de achique</entry><entry colname="c2">${escalon}</entry></row></tbody>` +
  '</tgroup></table></section></body></topic>';
const resumen = (escalon) =>
  '<topic id="resumen"><title>HOJA RESUMEN DE PROCEDIMIENTO</title><body>' +
  '<table><tgroup cols="1"><colspec colname="c1"/><tbody><row>' +
  `<entry colname="c1"><p><b>ESCALÓN DE MANTENIMIENTO</b></p><p>${escalon}</p></entry>` +
  '</row></tbody></tgroup></table></body></topic>';
const MAP_00004 =
  '<map><title>Dosier de mantenimiento</title>' +
  '<topicref href="fichas/planificacion.dita"/><topicref href="fichas/resumen.dita"/>' +
  '</map>';
const sheets = (plan, proc2) => [
  { path: 'fichas/planificacion.dita', xml: planificacion(plan) },
  { path: 'fichas/resumen.dita', xml: resumen(proc2) },
];

export const DOSSIER_CASES = {
  'BRDP-EXT-00004': [
    { name: 'different escalón in the two sheets', status: 'rejected', main: MAP_00004, files: sheets('2º escalón', '3er escalón'), ids: ['BRDP-EXT-00004d'], message: /Planificación: 2º escalón\. Procedimiento: 3er escalón\./ },
    { name: 'same escalón in the two sheets', status: 'accepted', main: MAP_00004, files: sheets('2º escalón', '2º escalón') },
    { name: 'only the planning sheet gives it', status: 'rejected', main: MAP_00004, files: [sheets('2º escalón', '')[0]], ids: ['BRDP-EXT-00004a'] },
  ],
  'BRDP-EXT-00007': [
    { name: 'no PRECAUCIONES DE SEGURIDAD topic', status: 'rejected', files: [proc('<p>Nada.</p>')], ids: ['BRDP-EXT-00007'], message: /PRECAUCIONES DE SEGURIDAD/ },
    { name: 'with the PRECAUCIONES DE SEGURIDAD topic', status: 'accepted', files: [PREC, proc('<p>Nada.</p>')] },
    {
      name: 'the topic exists but the ditamap points to another folder',
      status: 'rejected',
      main: '<map><topicref href="../otra/precauciones.dita"/></map>',
      files: [PREC],
      ids: ['BRDP-EXT-00007'],
    },
    {
      name: 'topicref with #fragment',
      status: 'accepted',
      main: '<map><topicref href="fichas/precauciones.dita#precauciones"/></map>',
      files: [PREC],
    },
    {
      name: 'scope="external" and http topicrefs are skipped',
      status: 'rejected',
      main: '<map><topicref href="fichas/precauciones.dita" scope="external"/><topicref href="http://example.com/precauciones.dita"/></map>',
      files: [PREC],
      ids: ['BRDP-EXT-00007'],
    },
    {
      name: 'a topicref to a file not in the dossier (doc-available false)',
      status: 'accepted',
      main: '<map><topicref href="fichas/no-esta.dita"/><topicref href="fichas/precauciones.dita"/></map>',
      files: [PREC],
    },
  ],
  'BRDP-EXT-00008': [
    { name: 'a warning not in the PRECAUCIONES topic', status: 'rejected', files: [PREC, proc('<note type="warning">Calzar la bomba antes de soltarla.</note>')], ids: ['BRDP-EXT-00008'], message: /Calzar la bomba antes de soltarla\./ },
    { name: 'a warning that is in the PRECAUCIONES topic', status: 'accepted', files: [PREC, proc('<note type="warning">Usar   gafas de\n protección.</note>')] },
    {
      name: 'a warning by conref to another file that is in the topic',
      status: 'accepted',
      files: [PREC, proc('<note conref="../comunes/notas.dita#notas/w1"/>'), NOTAS],
    },
    {
      name: 'a warning by conref to another file that is NOT in the topic',
      status: 'rejected',
      files: [PREC, proc('<note conref="../comunes/notas.dita#notas/w2"/>'), NOTAS],
      ids: ['BRDP-EXT-00008'],
      message: /Desconectar la alimentación eléctrica\./,
    },
  ],
  'BRDP-EXT-00009': [
    { name: 'conref to a missing file', status: 'rejected', files: [PREC, proc('<note conref="../comunes/notas.dita#notas/w1"/>')], ids: ['BRDP-EXT-00009'], message: /comunes\/notas\.dita#notas\/w1/ },
    { name: 'conref to an existing file and id', status: 'accepted', files: [PREC, proc('<note conref="../comunes/notas.dita#notas/w1"/>'), NOTAS] },
    { name: 'conref to a non-existent id in an existing file', status: 'rejected', files: [PREC, proc('<note conref="../comunes/notas.dita#notas/w9"/>'), NOTAS], ids: ['BRDP-EXT-00009'] },
  ],
};
