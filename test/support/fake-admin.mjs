// A stateful Admin API double for the webhook (non-bulk) path. Unlike a call
// spy, it holds the product rows and applies tagsAdd/tagsRemove to them, so a
// test can assert the tag state a merchant would actually see afterwards.
//
// Tag semantics are the pessimistic reading of Shopify's: tagsAdd dedupes
// case-insensitively (adding "Sale" to a product that already has "sale" is a
// no-op), but tagsRemove only strips an exact match. A handler that guesses the
// casing therefore fails here, which is the point — removals must target the
// tag as it is stored on the product.

export class FakeAdmin {
  constructor(products = []) {
    this.products = new Map();
    /** inventory item gid -> product gid */
    this.inventoryItems = new Map();
    this.calls = [];
    this.failNext = 0;

    for (const product of products) {
      this.products.set(product.id, {
        ...product,
        tags: [...(product.tags ?? [])],
        collectionIds: [...(product.collectionIds ?? [])],
      });
      for (const itemId of product.inventoryItemIds ?? []) {
        this.inventoryItems.set(`gid://shopify/InventoryItem/${itemId}`, product.id);
      }
    }
  }

  tagsOf(id) {
    return this.products.get(id)?.tags ?? null;
  }

  countCalls(name) {
    return this.calls.filter((call) => call === name).length;
  }

  async graphql(query, { variables } = {}) {
    const name = operationName(query);
    this.calls.push(name);

    if (this.failNext > 0) {
      this.failNext -= 1;
      return json({
        errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
      });
    }

    switch (name) {
      case "getProductForInventoryItem":
      case "getProductForInventoryItemInCollection": {
        const productId = this.inventoryItems.get(variables.id);
        const product = productId ? this.products.get(productId) : null;
        return json({
          data: {
            inventoryItem: product
              ? { variant: { product: view(product, variables.collectionId) } }
              : null,
          },
        });
      }

      case "getProductForTagSync":
      case "getProductForTagSyncInCollection":
        return json({
          data: {
            product: view(
              this.products.get(variables.id) ?? null,
              variables.collectionId,
            ),
          },
        });

      case "dashboardCollection": {
        // null for an id the store does not have, exactly like the real API
        // for a collection that has been deleted.
        const found = (this.collections ?? []).find((c) => c.id === variables.id);
        return json({
          data: { collection: found ? { id: found.id, title: found.title } : null },
        });
      }

      case "dashboardCollections":
        return json({
          data: {
            collections: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: this.collections ?? [],
            },
          },
        });

      case "addOutOfStockTag": {
        const product = this.products.get(variables.id);
        if (!product) {
          return json({ data: { tagsAdd: { userErrors: [{ message: "Product not found" }] } } });
        }
        for (const tag of variables.tags) {
          if (!product.tags.some((existing) => eq(existing, tag))) product.tags.push(tag);
        }
        return json({ data: { tagsAdd: { userErrors: [] } } });
      }

      case "removeOutOfStockTag": {
        const product = this.products.get(variables.id);
        if (!product) {
          return json({ data: { tagsRemove: { userErrors: [{ message: "Product not found" }] } } });
        }
        product.tags = product.tags.filter((existing) => !variables.tags.includes(existing));
        return json({ data: { tagsRemove: { userErrors: [] } } });
      }

      default:
        return json({ errors: [{ message: `Unexpected operation ${name}` }] });
    }
  }
}

function view(product, collectionId) {
  if (!product) return null;
  return {
    id: product.id,
    status: product.status,
    tags: [...product.tags],
    totalInventory: product.totalInventory,
    tracksInventory: product.tracksInventory,
    // Only present when the caller asked for it, exactly like the real API:
    // a handler that reads it unconditionally would see `undefined` on the
    // unscoped query rather than a silently friendly `false`.
    ...(collectionId
      ? { inCollection: (product.collectionIds ?? []).includes(collectionId) }
      : {}),
  };
}

function eq(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
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
