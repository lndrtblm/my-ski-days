// Versleutelt de webapp-data voor de internetversie.
//   node versleutel.mjs <bronmap publish/data> <doelmap site/data> <salt-bestand>
// Het wachtwoord komt via stdin (nooit als argument of omgevingsvariabele).
// Uitvoer per bestand X.js -> X.bin = 12 bytes IV + AES-256-GCM(ciphertext+tag);
// plus check.bin ("ok") om het wachtwoord te controleren en meta.json (salt, iterations).
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pbkdf2Sync, randomBytes, createCipheriv } from "node:crypto";

const [src, dst, saltFile] = process.argv.slice(2);
const ITER = 600000;
// Strip a byte-order mark and the line ending that PowerShell may add when piping.
const password = readFileSync(0, "utf8").replace(/^﻿/, "").replace(/[\r\n]+$/, "");
if (password.length < 8) { console.error("Wachtwoord ontbreekt of is te kort."); process.exit(2); }
const salt = readFileSync(saltFile, "utf8").trim();
const key = pbkdf2Sync(password, Buffer.from(salt, "base64"), ITER, 32, "sha256");

function encrypt(data) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  return Buffer.concat([iv, c.update(data), c.final(), c.getAuthTag()]);
}

mkdirSync(dst, { recursive: true });
let n = 0;
for (const f of readdirSync(src)) {
  if (!f.endsWith(".js")) continue;
  writeFileSync(join(dst, f.replace(/\.js$/, ".bin")), encrypt(readFileSync(join(src, f))));
  n++;
}
writeFileSync(join(dst, "check.bin"), encrypt(Buffer.from("ok")));
writeFileSync(join(dst, "meta.json"), JSON.stringify({ salt, iterations: ITER }));
console.log(`Versleuteld: ${n} databestanden.`);
