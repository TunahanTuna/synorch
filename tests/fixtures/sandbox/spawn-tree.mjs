import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [pidFile] = process.argv.slice(2);
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(pidFile, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
process.stdout.write("tree ready\n");
setInterval(() => {}, 1000);
