// Baut die öffentliche Demo nach dist/: die echten Oberflächendateien plus demo/demo-start.js (Beispieldaten im Arbeitsspeicher).
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
const dist = "dist";
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const f of ["styles.css", "core.js", "app.js", "vie-boot.js", "vie-actions.js", "vie-agent-ui.js", "vie-assistant.js"]) await cp(f, `${dist}/${f}`);
await cp("demo/demo-start.js", `${dist}/demo-start.js`);
await cp("site/favicon.svg", `${dist}/favicon.svg`);
await writeFile(`${dist}/.nojekyll`, "");
let html = await readFile("index.html", "utf8");
const anker = '<script defer src="app.js"></script>';
if (!html.includes(anker)) throw new Error("Einfügestelle für demo-start.js fehlt in index.html");
html = html.replace(anker, '<script defer src="demo-start.js"></script>\n  ' + anker);
html = html.replace("</title>", '</title>\n  <link rel="icon" href="favicon.svg" type="image/svg+xml">');
await writeFile(`${dist}/index.html`, html);
console.log("Demo gebaut: dist/");
