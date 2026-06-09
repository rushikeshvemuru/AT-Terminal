import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const executableName =
  process.platform === "win32" ? "at-terminal-base-module.exe" : "at-terminal-base-module";
const sourcePath = join(rootDir, "target", "release", executableName);
const destinationDir = join(rootDir, "AT-modules", "base", "server", "bin");
const destinationPath = join(destinationDir, executableName);

execFileSync("cargo", ["build", "-p", "at-terminal-base-module", "--release"], {
  cwd: rootDir,
  stdio: "inherit",
});

if (!existsSync(sourcePath)) {
  throw new Error(`Expected base module server binary was not built: ${sourcePath}`);
}

mkdirSync(destinationDir, { recursive: true });
copyFileSync(sourcePath, destinationPath);

if (!existsSync(destinationPath)) {
  throw new Error(`Failed to copy base module server binary to: ${destinationPath}`);
}

console.log(`Prepared ${process.platform} base module server: ${sourcePath} -> ${destinationPath}`);
