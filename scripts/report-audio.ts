// Le résumé audio que ferait le collecteur pour un rapport, sans rien envoyer :
//   node scripts/report-audio.ts <rapport.md> <sortie.mp3>   (le texte dit est écrit à côté, en .txt)
import fs from 'node:fs';
import { reportAudioOf } from '../collector/reports.ts';

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('usage : node scripts/report-audio.ts <rapport.md> <sortie.mp3>'); process.exit(2); }
const a = await reportAudioOf(src);
if (!a) { console.error('pas un rapport (en-tête « rapport: » absent ?)'); process.exit(1); }
fs.writeFileSync(out, a.mp3);
fs.writeFileSync(out.replace(/\.mp3$/, '') + '.txt', a.script);
console.log(`${out} : ${a.seconds} s, ${(a.mp3.length / 1024).toFixed(0)} Ko, ${a.script.split(/\s+/).length} mots`);
process.exit(0);
