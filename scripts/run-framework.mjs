import { fileURLToPath } from "node:url";

const [command, ...args] = process.argv.slice(2);
if (!["dev", "build", "preview"].includes(command)) throw new Error("Expected dev, build or preview.");

const cli = new URL("../node_modules/vite/bin/vite.js", import.meta.url);
const hasPort = args.some(argument => argument === "--port" || argument.startsWith("--port="));
const port = command !== "build" && !hasPort ? ["--port", process.env.REPOLENS_UI_PORT ?? "5173"] : [];
process.argv = [process.execPath, fileURLToPath(cli), command, ...port, ...args];
await import(cli.href);
