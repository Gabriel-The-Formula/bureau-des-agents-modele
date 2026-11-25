// Le PDF qu'imprimerait le collecteur pour un rapport, sans rien envoyer : node scripts/report-pdf.ts <rapport.md> <sortie.pdf>
import fs from 'node:fs';
import { reportPdfOf } from '../collector/reports.ts';

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('usage : node scripts/report-pdf.ts <rapport.md> <sortie.pdf>'); process.exit(2); }
const pdf = await reportPdfOf(src);
if (!pdf) { console.error('pas un rapport (en-tête « rapport: » absent ?)'); process.exit(1); }
fs.writeFileSync(out, pdf);
console.log(`${out} : ${(pdf.length / 1024).toFixed(0)} Ko`);
