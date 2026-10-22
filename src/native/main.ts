/**
 * Native messaging host entrypoint. The browser starts this process (via the
 * launcher written by `atc setup`) when the extension calls connectNative.
 */
import { createConnection } from "node:net";
import { resolvePaths } from "../contracts/paths.js";
import { NativeRelay } from "./relay.js";

const paths = resolvePaths();
const relay = new NativeRelay({
  writeToBrowser: (frame) => process.stdout.write(frame),
  connectToDaemon: () => createConnection(paths.extensionSocket),
  schedule: (task, ms) => setTimeout(task, ms),
});

process.stdin.on("data", (chunk: Buffer) => relay.fromBrowser(chunk));
process.stdin.on("end", () => process.exit(0));
relay.start();
