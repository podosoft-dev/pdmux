#!/usr/bin/env bun
/**
 * Exercise a route from the adapter's final output, not Vite's intermediate
 * graph. Bun bundler regressions can pass `vite build` and fail only when a
 * lazily loaded production route is evaluated.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const buildRoot = new URL("../apps/web/build/", import.meta.url).pathname;

async function importLazyRelayChunks(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  let imported = 0;
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      imported += await importLazyRelayChunks(path);
    } else if (entry.name.endsWith(".js.map")) {
      const sourceMap = await readFile(path, "utf8");
      if (sourceMap.includes("src/lib/dashboard/terminal-relay.ts")) {
        await import(pathToFileURL(path.slice(0, -4)).href);
        imported += 1;
      }
    }
  }
  return imported;
}

const relayChunks = await importLazyRelayChunks(buildRoot);
if (relayChunks === 0) throw new Error("web build did not contain the terminal relay chunk");

const cwd = new URL("../apps/web/", import.meta.url).pathname;
const child = Bun.spawn(["bun", "./build"], {
  cwd,
  env: { ...process.env, NODE_ENV: "production", PORT: "0" },
  stdout: "pipe",
  stderr: "pipe",
});

const stderrPromise = new Response(child.stderr).text();
const stdoutReader = child.stdout.getReader();
const decoder = new TextDecoder();
let stdout = "";

async function listeningOrigin() {
  while (true) {
    const { done, value } = await stdoutReader.read();
    if (done) throw new Error(`web build exited before listening\n${stdout}`);
    stdout += decoder.decode(value, { stream: true });
    const match = /Listening on (https?:\/\/[^\s]+)/.exec(stdout);
    if (match?.[1]) return match[1];
  }
}

const timeout = new Promise((_, reject) => {
  setTimeout(() => reject(new Error("web build did not listen within 15 seconds")), 15_000);
});

let failure;
try {
  const origin = await Promise.race([listeningOrigin(), timeout]);
  const response = await fetch(new URL("/install.sh", origin), {
    headers: { host: "pdmux.example.com", "x-forwarded-proto": "https" },
  });
  const body = await response.text();

  if (response.status !== 200) throw new Error(`/install.sh returned ${response.status}: ${body.slice(0, 200)}`);
  if (!response.headers.get("content-type")?.startsWith("text/x-shellscript")) {
    throw new Error(`/install.sh returned ${response.headers.get("content-type") ?? "no content type"}`);
  }
  if (!body.startsWith("#!/bin/sh")) throw new Error("/install.sh did not return a shell script");
} catch (error) {
  failure = error;
} finally {
  await stdoutReader.cancel().catch(() => undefined);
  child.kill("SIGTERM");
}

const exited = await Promise.race([child.exited, Bun.sleep(5_000).then(() => null)]);
if (exited === null) {
  child.kill("SIGKILL");
  await child.exited;
}
const stderr = await stderrPromise;

if (failure) {
  console.error(stdout.trim());
  console.error(stderr.trim());
  throw failure;
}

console.log("web production smoke passed: GET /install.sh returned an executable script");
