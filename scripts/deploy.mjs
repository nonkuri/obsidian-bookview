// Copies the built plugin into a vault.
//   npm run deploy -- "C:/path/to/Vault"
// or set OBSIDIAN_VAULT once and just run `npm run deploy`.
import fs from "fs/promises";
import path from "path";
import process from "process";

const vault = process.argv[2] ?? process.env.OBSIDIAN_VAULT;
if (!vault) {
  console.error('Usage: npm run deploy -- "C:/path/to/Vault"   (or set OBSIDIAN_VAULT)');
  process.exit(1);
}

const manifest = JSON.parse(await fs.readFile("manifest.json", "utf8"));
const target = path.join(vault, ".obsidian", "plugins", manifest.id);

try {
  await fs.access(path.join(vault, ".obsidian"));
} catch {
  console.error(`Not an Obsidian vault (no .obsidian directory): ${vault}`);
  process.exit(1);
}

await fs.mkdir(target, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  await fs.copyFile(file, path.join(target, file));
}
console.log(`Deployed ${manifest.id} v${manifest.version} to ${target}`);
