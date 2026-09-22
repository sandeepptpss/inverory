// App modules are written for Vite (extensionless relative imports) and reach
// for Prisma and a configured Shopify client at import time. This resolve hook
// lets `node --test` load the real sync code unmodified while swapping those two
// boundaries for in-memory doubles.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const OVERRIDES = {
  "db.server": new URL("./fake-db.mjs", import.meta.url).href,
  "shopify.server": new URL("./fake-shopify-server.mjs", import.meta.url).href,
};

const EXTENSIONS = [".js", ".jsx", ".mjs", "/index.js"];

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".")) {
    const base = specifier.replace(/\.jsx?$/, "").split("/").pop();
    if (OVERRIDES[base]) {
      return { url: OVERRIDES[base], shortCircuit: true, format: "module" };
    }
  }

  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!specifier.startsWith(".") || !context.parentURL) throw error;

    for (const extension of EXTENSIONS) {
      const candidate = new URL(specifier + extension, context.parentURL);
      if (fs.existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true, format: "module" };
      }
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".jsx")) {
    return {
      format: "module",
      shortCircuit: true,
      source: fs.readFileSync(fileURLToPath(url), "utf8"),
    };
  }
  return nextLoad(url, context);
}

