import { readFileSync, writeFileSync } from "fs";

// Run by `npm version`: copies the new package.json version into manifest.json
// and records the Obsidian version it needs in versions.json.
const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
  throw new Error("version-bump.mjs must be run through `npm version`");
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
