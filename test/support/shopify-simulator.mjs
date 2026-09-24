// A Shopify Admin API double good enough to exercise the whole bulk-operation
// flow: it serves real JSONL over a real HTTP socket (so the streaming reader is
// genuinely streaming), enforces the one-bulk-operation-per-type rule, and can
// be told to throttle or fail.

import http from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

export const TAG = "out-of-stock-hidden";

/**
 * Deterministic synthetic catalog.
 *   i % 3 === 0            -> out of stock, untagged   => needs "add"
 *   i % 5 === 0 (not %3)   -> in stock, already tagged => needs "remove"
 *   otherwise              -> correct already          => no action
 */
export function productAt(index) {
  const id = `gid://shopify/Product/${1_000_000 + index}`;
  if (index % 3 === 0) {
    return { id, status: "ACTIVE", tags: [], totalInventory: 0, tracksInventory: true };
  }
  if (index % 5 === 0) {
    return { id, status: "ACTIVE", tags: [TAG, "seasonal"], totalInventory: 12, tracksInventory: true };
  }
  return { id, status: "ACTIVE", tags: ["seasonal"], totalInventory: 7, tracksInventory: true };
}

/**
 * Worst case for this app: every Active product is out of stock and untagged,
 * so all of them need the tag added and none need it removed.
 */
export function zeroInventoryProductAt(index) {
  return {
    id: `gid://shopify/Product/${1_000_000 + index}`,
    status: "ACTIVE",
    tags: [],
    totalInventory: 0,
    tracksInventory: true,
  };
}

export const CATALOGS = {
  mixed: productAt,
  zeroInventory: zeroInventoryProductAt,
};

export function expectedCounts(total) {
  let toTag = 0;
  let toUntag = 0;
  for (let i = 0; i < total; i += 1) {
    if (i % 3 === 0) toTag += 1;
    else if (i % 5 === 0) toUntag += 1;
  }
  return { toTag, toUntag };
}

export class ShopifySimulator {
  constructor(options = {}) {
    this.productCount = options.productCount ?? 1000;
    // How many status polls each operation reports RUNNING before completing.
    this.queryPolls = options.queryPolls ?? 2;
    this.mutationPolls = options.mutationPolls ?? 1;
    this.queryOutcome = options.queryOutcome ?? "COMPLETED";
    this.mutationFailureRate = options.mutationFailureRate ?? 0;
    // Number of leading GraphQL calls that answer with a THROTTLED error.
    this.throttleCount = options.throttleCount ?? 0;
    this.hangQuery = options.hangQuery ?? false;
    // Keep the query operation in CREATED (queued at Shopify, never started).
    this.queueQueryForever = options.queueQueryForever ?? false;
    // Which synthetic catalog the export serves: a name from CATALOGS, or a
    // bespoke `(index) => product` builder supplied by the test.
    this.catalog =
      typeof options.catalog === "function"
        ? options.catalog
        : (CATALOGS[options.catalog ?? "mixed"] ?? CATALOGS.mixed);

    // Collection-scoped runs: how many products the filtered export returns,
    // and the builder for them. Left unset, a scoped query is still recorded
    // but serves the same catalog, so existing suites are unaffected.
    this.collectionProductCount = options.collectionProductCount ?? null;
    this.collectionCatalog =
      typeof options.collectionCatalog === "function"
        ? options.collectionCatalog
        : null;
    /** Every `products(query: …)` filter the service asked Shopify for. */
    this.bulkQueries = [];

    this.calls = [];
    this.operations = new Map();
    this.uploads = new Map();
    this.current = { QUERY: null, MUTATION: null };
    this.nextId = 1;
    this.server = null;
    this.origin = null;
  }

  async start() {
    this.server = http.createServer((req, res) => this.#handle(req, res));
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    const { port } = this.server.address();
    this.origin = `http://127.0.0.1:${port}`;
    return this;
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
  }

  countCalls(name) {
    return this.calls.filter((call) => call === name).length;
  }

  get admin() {
    return { graphql: (query, options) => this.graphql(query, options) };
  }

  // -- GraphQL -------------------------------------------------------------

  async graphql(query, { variables } = {}) {
    const name = operationName(query);
    this.calls.push(name);

    if (this.throttleCount > 0) {
      this.throttleCount -= 1;
      return json({
        errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
        extensions: { cost: { requestedQueryCost: 10, throttleStatus: { currentlyAvailable: 0, restoreRate: 100 } } },
      });
    }

    switch (name) {
      case "startBulkProductQuery": {
        const filter = (variables.query.match(/products\(query:\s*"([^"]*)"/) || [])[1] ?? "";
        this.bulkQueries.push(filter);
        const scoped = /collection_id:(\d+)/.test(filter);
        return json({
          data: {
            bulkOperationRunQuery: this.#createOperation("QUERY", {
              rows:
                scoped && this.collectionProductCount !== null
                  ? this.collectionProductCount
                  : this.productCount,
              catalog: scoped && this.collectionCatalog ? "collection" : "default",
            }),
          },
        });
      }

      case "bulkOperationStatus":
        return json({ data: { node: this.#pollOperation(variables.id) } });

      case "currentBulkOperation":
        return json({ data: { currentBulkOperation: this.current[variables.type] } });

      case "cancelBulkOperation": {
        const op = this.operations.get(variables.id);
        if (op) op.status = "CANCELED";
        return json({ data: { bulkOperationCancel: { bulkOperation: op, userErrors: [] } } });
      }

      case "stageJsonlUpload": {
        const key = `tmp/upload-${this.nextId++}`;
        return json({
          data: {
            stagedUploadsCreate: {
              stagedTargets: [
                {
                  url: `${this.origin}/staged-upload`,
                  parameters: [{ name: "key", value: key }],
                },
              ],
              userErrors: [],
            },
          },
        });
      }

      case "runBulkMutation": {
        if (this.current.MUTATION && ["CREATED", "RUNNING"].includes(this.current.MUTATION.status)) {
          return json({
            data: {
              bulkOperationRunMutation: {
                bulkOperation: null,
                userErrors: [{ message: "A bulk mutation is already in progress", code: "OPERATION_IN_PROGRESS" }],
              },
            },
          });
        }
        const rows = this.uploads.get(variables.stagedUploadPath) ?? 0;
        const field = /tagsAdd/.test(variables.mutation) ? "tagsAdd" : "tagsRemove";
        return json({
          data: {
            bulkOperationRunMutation: this.#createOperation("MUTATION", { rows, field }),
          },
        });
      }

      default:
        return json({ errors: [{ message: `Unexpected operation ${name}` }] });
    }
  }

  #createOperation(type, extra = {}) {
    const id = `gid://shopify/BulkOperation/${this.nextId++}`;
    const op = {
      id,
      type,
      status: "CREATED",
      errorCode: null,
      url: null,
      objectCount: "0",
      polls: 0,
      rows: type === "QUERY" ? (extra.rows ?? this.productCount) : extra.rows,
      field: extra.field,
      catalog: extra.catalog ?? "default",
    };
    this.operations.set(id, op);
    this.current[type] = op;
    return { bulkOperation: { id, status: op.status }, userErrors: [] };
  }

  #pollOperation(id) {
    const op = this.operations.get(id);
    if (!op) return null;
    if (op.status === "CANCELED") return publicView(op);

    op.polls += 1;
    const limit = op.type === "QUERY" ? this.queryPolls : this.mutationPolls;

    if (op.type === "QUERY" && this.queueQueryForever) {
      op.status = "CREATED";
      op.objectCount = "0";
      return publicView(op);
    }

    if (op.type === "QUERY" && this.hangQuery) {
      // Never completes and never moves objectCount: the wedged-operation case
      // the watchdog exists for.
      op.status = "RUNNING";
      op.objectCount = "0";
      return publicView(op);
    }

    if (op.polls <= limit) {
      op.status = "RUNNING";
      // Report partial progress so the test can assert the count climbs.
      op.objectCount = String(Math.floor((op.rows * op.polls) / (limit + 1)));
      return publicView(op);
    }

    if (op.type === "QUERY" && this.queryOutcome !== "COMPLETED") {
      op.status = this.queryOutcome;
      op.errorCode = "INTERNAL_SERVER_ERROR";
      return publicView(op);
    }

    op.status = "COMPLETED";
    op.objectCount = String(op.rows);
    op.url =
      op.type === "QUERY"
        ? `${this.origin}/export/${op.rows}/${op.catalog}`
        : `${this.origin}/mutation-result/${op.field}/${op.rows}`;
    return publicView(op);
  }

  // -- HTTP ----------------------------------------------------------------

  async #handle(req, res) {
    const url = new URL(req.url, this.origin);

    if (req.method === "POST" && url.pathname === "/staged-upload") {
      let bytes = 0;
      let lines = 0;
      let key = null;
      let buffer = "";
      let carry = "";
      req.on("data", (chunk) => {
        bytes += chunk.length;
        const text = chunk.toString("utf8");

        buffer += text;
        const matchedKey = buffer.match(/name="key"\r?\n\r?\n(.+?)\r?\n/);
        if (matchedKey) key = matchedKey[1];
        // Keep only a tail, so the simulator does not buffer the whole upload.
        if (buffer.length > 4096) buffer = buffer.slice(-2048);

        // Count rows across chunk boundaries: a naive per-chunk match loses any
        // marker split between two chunks.
        const window = carry + text;
        lines += (window.match(/"tags"/g) || []).length;
        carry = window.slice(-5);
      });
      await once(req, "end");
      this.uploads.set(key, lines);
      this.lastUploadBytes = bytes;
      this.uploadBytes = (this.uploadBytes ?? new Map()).set(key, bytes);
      res.writeHead(204).end();
      return;
    }

    const exportMatch = url.pathname.match(/^\/export\/(\d+)(?:\/(\w+))?$/);
    if (exportMatch) {
      const build =
        exportMatch[2] === "collection" && this.collectionCatalog
          ? this.collectionCatalog
          : this.catalog;
      res.writeHead(200, { "content-type": "application/jsonl" });
      await streamLines(res, Number(exportMatch[1]), (i) => JSON.stringify(build(i)));
      return;
    }

    const mutationMatch = url.pathname.match(/^\/mutation-result\/(\w+)\/(\d+)$/);
    if (mutationMatch) {
      const [, field, rows] = mutationMatch;
      const failEvery = this.mutationFailureRate ? Math.round(1 / this.mutationFailureRate) : 0;
      res.writeHead(200, { "content-type": "application/jsonl" });
      await streamLines(res, Number(rows), (i) =>
        JSON.stringify(
          failEvery && i % failEvery === 0
            ? { data: { [field]: { userErrors: [{ message: "Product not found" }] } }, __lineNumber: i }
            : { data: { [field]: { userErrors: [] } }, __lineNumber: i },
        ),
      );
      return;
    }

    res.writeHead(404).end();
  }
}

// Writes n lines honouring backpressure, so the response is genuinely streamed
// rather than assembled in memory first.
async function streamLines(res, count, render) {
  for (let i = 0; i < count; i += 1) {
    if (!res.write(`${render(i)}\n`)) {
      await once(res, "drain");
    }
  }
  res.end();
}

function publicView(op) {
  return {
    id: op.id,
    status: op.status,
    errorCode: op.errorCode,
    url: op.url,
    objectCount: op.objectCount,
  };
}

function operationName(query) {
  const match = query.match(/(?:query|mutation)\s+(\w+)/);
  return match ? match[1] : "anonymous";
}

function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export { delay };
