/**
 * Real XSD schema validation for generated BREX XML (not well-formedness --
 * that's checkWellFormed() in generateBREX.js). Requires the Express server
 * (npm start); not available in `npm run dev` since there's no Node backend
 * behind the Vite dev server for this route.
 */
export async function validateAgainstXSD(xml, format) {
  const res = await fetch('/api/validate-brex', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ xml, format }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || body.message || `XSD validation request failed (${res.status})`);
  }

  return res.json();
}
