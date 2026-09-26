import { generateBREX301 } from "./generateBREX301.js";
import { brexToSchematron } from "./brexToSchematron.js";
import { checkWellFormed } from "./generateBREX.js";

// Genera Schematron (S1000D) en dos pasos deterministas:
// 1) genera un BREX real reutilizando el generador base del standard real
//    del proyecto -- generateBREX (4.2), generateBREX41, o generateBREX301,
//    seleccionado por el llamador vía options.baseGenerator (LLM +
//    finalización determinista, sin cambios en ninguno de los tres).
//    Por defecto generateBREX301, por compatibilidad con el uso histórico
//    de esta función cuando el llamador no especifica otro.
// 2) convierte ese BREX a ISO Schematron con brexToSchematron (sin LLM, sin
//    error de XPath) -- el conversor es agnóstico de versión BREX desde
//    siempre (lee indistintamente objrule/structureObjectRule,
//    objpath/objectPath, objval/objectValue, objappl/allowedObjectFlag).
//
// No existe un formato de aprobación "SCH-S1000D" independiente: un único
// conjunto de reglas aprobadas por proyecto, bajo el formato BREX del
// standard real (BREX-3.0.1/BREX-4.1/BREX-4.2), alimenta tanto la salida
// BREX como su conversión a Schematron (docs request, confirmado con el
// usuario) -- options.approvalsFormat/options.approvals se reenvían tal
// cual al generador base, sin forzar aquí ningún valor propio.
export async function generateBREXSch(brdps, projectConfig, options = {}) {
  const { baseGenerator = generateBREX301, ...baseOptions } = options;
  const brexResult = await baseGenerator(brdps, projectConfig, baseOptions);
  if (!brexResult || !brexResult.xml) {
    throw new Error("No se pudo generar el BREX base para el Schematron.");
  }

  let sch;
  try {
    sch = brexToSchematron(brexResult.xml, { preserveBrdpId: true, carryComments: true });
  } catch (err) {
    throw new Error(`Conversión BREX -> Schematron fallida: ${err.message}`);
  }

  const { valid, error } = checkWellFormed(sch);
  return { xml: sch, valid, error, brdpCount: brexResult.brdpCount };
}
