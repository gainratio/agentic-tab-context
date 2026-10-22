/** Capture belongs to a live daemon connection and ends when that connection does. */
import { runCommand } from "./commands.js";
import { send } from "./native.js";
import { clearWatched, runPageOp } from "./page.js";

let captureConnected = false;
let captureGeneration = 0;
let captureCleanup = Promise.resolve();

export async function setCaptureConnection(connected) {
  captureConnected = connected;
  if (!connected) {
    captureGeneration += 1;
    captureCleanup = captureCleanup.then(stopWatching);
  }
  await captureCleanup;
}

export async function runConnectedCommand(command) {
  const admitted = captureConnected;
  const generation = captureGeneration;
  await captureCleanup;
  if (!admitted || !captureConnected || generation !== captureGeneration) {
    send({ type: "result", id: command.id, ok: false, error: "CONTEXT_CLOSED", message: "the daemon connection ended; bind the tab again" });
    return;
  }
  await runCommand(command);
}

async function stopWatching() {
  const tabs = await clearWatched();
  await Promise.all([...tabs].map((tabId) => runPageOp(tabId, { op: "unwatch" }).catch(() => undefined)));
}
