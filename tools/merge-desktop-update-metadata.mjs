#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";

function assertRecord(value, source) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} does not contain an update metadata object`);
  }
  return value;
}

function parseMetadata(source, contents) {
  const metadata = assertRecord(Bun.YAML.parse(contents), source);
  if (typeof metadata.version !== "string" || metadata.version.length === 0) {
    throw new Error(`${source} does not declare a version`);
  }
  if (!Array.isArray(metadata.files) || metadata.files.length === 0) {
    throw new Error(`${source} does not declare update files`);
  }
  for (const file of metadata.files) {
    const entry = assertRecord(file, source);
    if (typeof entry.url !== "string" || typeof entry.sha512 !== "string") {
      throw new Error(`${source} contains an invalid update file`);
    }
  }
  return metadata;
}

export function mergeUpdateMetadata(inputs) {
  if (inputs.length < 2) throw new Error("At least two update metadata files are required");
  const parsed = inputs.map(({ source, contents }) => parseMetadata(source, contents));
  const primary = parsed[0];
  const version = primary.version;
  if (parsed.some((metadata) => metadata.version !== version)) {
    throw new Error("Desktop update metadata versions do not match");
  }

  const files = [];
  const urls = new Set();
  for (const metadata of parsed) {
    for (const file of metadata.files) {
      if (urls.has(file.url)) throw new Error(`Duplicate desktop update file: ${file.url}`);
      urls.add(file.url);
      files.push(file);
    }
  }

  const preferred = files.find((file) => file.url.includes("x64")) ?? files[0];
  return Bun.YAML.stringify({
    ...primary,
    files,
    path: preferred.url,
    sha512: preferred.sha512,
  });
}

async function main(args) {
  const [output, ...inputPaths] = args;
  if (!output || inputPaths.length < 2) {
    throw new Error("Usage: merge-desktop-update-metadata.mjs <output> <input> <input> [...]");
  }
  const inputs = await Promise.all(inputPaths.map(async (source) => ({
    source,
    contents: await readFile(source, "utf8"),
  })));
  await writeFile(output, mergeUpdateMetadata(inputs), "utf8");
}

if (import.meta.main) await main(process.argv.slice(2));
