// dist/cli.js を実行可能にする
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
const p = new URL("../dist/cli.js", import.meta.url);
let s = readFileSync(p, "utf8");
if (!s.startsWith("#!")) s = "#!/usr/bin/env node\n" + s;
writeFileSync(p, s);
chmodSync(p, 0o755);
