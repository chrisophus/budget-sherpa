/**
 * Extracts the stable, reusable prefix from a raw bank payee string by
 * stripping common variable suffixes (transaction codes, store numbers,
 * location codes, etc.).
 *
 * Examples:
 *   "AMAZON MKTPL*0C2091XO3"       → "AMAZON MKTPL"
 *   "TST* CORIANDER GOLDEN - N"    → "TST* CORIANDER GOLDEN"
 *   "TST* JAMBA JUICE - 1286 -"    → "TST* JAMBA JUICE"
 *   "TST* CHIRINGUITO LLC  ARL"    → "TST* CHIRINGUITO LLC"
 *   "A-B PETROLEUM #34"            → "A-B PETROLEUM"
 *   "2ND AND CHARLES 2149"         → "2ND AND CHARLES"
 */
export function extractMatchValue(rawPayee: string): string {
  let s = rawPayee.trim();
  let prev: string;
  let iterations = 0;

  do {
    prev = s;
    iterations++;

    // 1. *XXXXXXXX — alphanumeric transaction code after asterisk (no space)
    //    e.g. AMAZON MKTPL*0C2091XO3, Amazon.com*0K3MH0VR3, Amazon Kids+*4R0KO2MY3
    let next = s.replace(/\*[A-Za-z0-9]{3,}$/, '').trim();
    if (next.length >= 4) s = next;

    // 2. Trailing isolated dash (truncated payee): "TST* THE HAMPTON SOCIAL -"
    next = s.replace(/\s+-\s*$/, '').trim();
    if (next.length >= 4) s = next;

    // 3. - CODE or - CODE - suffix (dash-separated location/store code, 1-6 chars)
    //    e.g. " - N", " - PLA", " - 1286 -", " - GC37 - 4"
    next = s.replace(/\s+-\s+[A-Z0-9]{1,6}\s*(?:-\s*)?$/i, '').trim();
    if (next.length >= 4) s = next;

    // 4. #NUMBER — store/location number after hash
    //    e.g. "A-B PETROLEUM #34", "WHOLEFDS #1234"
    next = s.replace(/\s+#[0-9A-Z]{1,6}$/i, '').trim();
    if (next.length >= 4) s = next;

    // 5. Location code after double space (bank padding pattern)
    //    e.g. "TST* CHIRINGUITO LLC  ARL", "TST* SOME PLACE  BWI"
    next = s.replace(/\s{2,}[A-Z]{2,4}$/, '').trim();
    if (next.length >= 4) s = next;

    // 6. Trailing 4+ digit number (store/location ID without #)
    //    e.g. "2ND AND CHARLES 2149"
    next = s.replace(/\s+\d{4,}$/, '').trim();
    if (next.length >= 4) s = next;

  } while (s !== prev && iterations < 5);

  return s;
}
