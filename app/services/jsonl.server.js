import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fetchWithRetry } from "./shopify-retry.server";

const TEMP_DIR = path.join(os.tmpdir(), "inventory-bulk-sync");

export async function tempJsonlPath(shop, name) {
  await fsp.mkdir(TEMP_DIR, { recursive: true });
  const safeShop = shop.replace(/[^a-z0-9.-]/gi, "_");
  return path.join(TEMP_DIR, `${safeShop}-${name}-${Date.now()}.jsonl`);
}

export async function removeFile(filePath) {
  if (!filePath) return;
  await fsp.rm(filePath, { force: true }).catch(() => {});
}

export async function fileExists(filePath) {
  if (!filePath) return false;
  return fsp
    .access(filePath, fs.constants.R_OK)
    .then(() => true)
    .catch(() => false);
}

/**
 * Streams a newline-delimited JSON document, yielding one parsed object at a
 * time. Only the current chunk plus one partial line is ever held, so a
 * 150k-product export costs the same memory as a 100-product one.
 */
export async function* streamJsonlFromResponse(response, { signal } = {}) {
  const decoder = new TextDecoder();
  let buffer = "";
  let lineNumber = 0;

  for await (const chunk of response.body) {
    if (signal?.aborted) throw signal.reason ?? new Error("Aborted");

    buffer += decoder.decode(chunk, { stream: true });

    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      lineNumber += 1;
      if (line) yield parseLine(line, lineNumber);
      newline = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail) yield parseLine(tail, lineNumber + 1);
}

function parseLine(line, lineNumber) {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`Malformed JSONL at line ${lineNumber}: ${error.message}`);
  }
}

export async function* streamJsonlFromUrl(url, { signal, label = "jsonl" } = {}) {
  const response = await fetchWithRetry(url, { signal, label });
  yield* streamJsonlFromResponse(response, { signal });
}

/**
 * Buffered JSONL writer that respects backpressure, so building a 150k-line
 * mutation input never materialises the file as one giant string.
 */
export class JsonlWriter {
  constructor(filePath) {
    this.filePath = filePath;
    this.stream = fs.createWriteStream(filePath, { encoding: "utf8" });
    this.count = 0;
    this.error = null;
    // Writes already queued in libuv can land after a destroy(). Without a
    // listener that surfaces as an unhandled 'error' event and takes the
    // process down; capture it and let close()/write() report it instead.
    this.stream.on("error", (error) => {
      this.error = this.error ?? error;
    });
  }

  async write(value) {
    if (this.error) throw this.error;
    if (this.stream.destroyed) throw new Error("JSONL writer was closed");

    this.count += 1;
    if (!this.stream.write(`${JSON.stringify(value)}\n`)) {
      // Wait for drain, but also unblock on close so an abort during
      // backpressure cannot hang here. The AbortController detaches whichever
      // listener lost the race — without it they accumulate on every drain.
      const settled = new AbortController();
      const drained = once(this.stream, "drain", { signal: settled.signal }).catch(() => {});
      const closed = once(this.stream, "close", { signal: settled.signal }).catch(() => {});
      await Promise.race([drained, closed]);
      settled.abort();

      if (this.error) throw this.error;
    }
  }

  async close() {
    await new Promise((resolve, reject) => {
      this.stream.end((error) => (error ? reject(error) : resolve()));
    });
    if (this.error) throw this.error;
    return this.count;
  }

  /** Abandons the file: used when a step is cancelled or fails part-way. */
  async destroy() {
    if (!this.stream.destroyed) {
      this.stream.destroy();
      await once(this.stream, "close").catch(() => {});
    }
    await removeFile(this.filePath);
  }
}

/**
 * A Blob backed by the file on disk rather than by a copy of its bytes, so the
 * staged upload streams instead of loading the whole payload.
 */
export async function fileAsBlob(filePath, type = "text/jsonl") {
  if (typeof fs.openAsBlob === "function") {
    return fs.openAsBlob(filePath, { type });
  }
  const contents = await fsp.readFile(filePath);
  return new Blob([contents], { type });
}
