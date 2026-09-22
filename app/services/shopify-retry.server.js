// Retry/backoff for the two ways this app talks to Shopify: the Admin GraphQL
// API (which throttles on a leaky bucket and returns THROTTLED rather than 429)
// and the signed storage URL that serves bulk-operation results.

const DEFAULT_ATTEMPTS = 6;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;

export class RetryableError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = "RetryableError";
    this.retryable = true;
  }
}

export class FatalError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = "FatalError";
    this.retryable = false;
  }
}

export function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    // Unref so a pending backoff never keeps the process alive on shutdown.
    timer.unref?.();

    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Aborted"));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Full jitter: without it, every shop that hit the same throttle retries in
// lockstep and throttles again.
export function backoffDelay(attempt) {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

function retryAfterMs(response) {
  const header = response?.headers?.get?.("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  return Number.isFinite(seconds)
    ? Math.min(MAX_DELAY_MS, seconds * 1000)
    : null;
}

function isThrottled(errors) {
  if (!Array.isArray(errors)) return false;
  return errors.some(
    (error) =>
      error?.extensions?.code === "THROTTLED" ||
      /throttl/i.test(String(error?.message || "")),
  );
}

function isTransientNetworkError(error) {
  if (error?.retryable) return true;
  const code = error?.cause?.code || error?.code;
  return [
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "EAI_AGAIN",
    "ENOTFOUND",
    "UND_ERR_SOCKET",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
  ].includes(code);
}

/**
 * Runs an Admin GraphQL operation, retrying throttles, 429s, 5xx and dropped
 * sockets. Resolves to `data`; throws FatalError for anything a retry cannot fix
 * (bad query, revoked scope, userErrors are left to the caller).
 */
export async function graphqlWithRetry(admin, query, options = {}) {
  const {
    variables,
    label = "graphql",
    attempts = DEFAULT_ATTEMPTS,
    signal,
  } = options;

  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await sleep(lastError?.retryAfterMs ?? backoffDelay(attempt - 1), signal);
    }

    let response;
    try {
      response = await admin.graphql(query, { variables });
    } catch (error) {
      // The Shopify client throws GraphqlQueryError for non-2xx responses.
      const status = error?.response?.status ?? error?.status;
      if (
        status === 429 ||
        (status >= 500 && status < 600) ||
        isTransientNetworkError(error)
      ) {
        lastError = new RetryableError(`${label}: ${error.message}`, {
          cause: error,
        });
        continue;
      }
      throw new FatalError(`${label}: ${error.message}`, { cause: error });
    }

    if (response.status === 429 || response.status >= 500) {
      lastError = new RetryableError(`${label}: HTTP ${response.status}`);
      lastError.retryAfterMs = retryAfterMs(response);
      continue;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new FatalError(
        `${label}: HTTP ${response.status} ${body.slice(0, 500)}`,
      );
    }

    let body;
    try {
      body = await response.json();
    } catch (error) {
      lastError = new RetryableError(`${label}: malformed response body`, {
        cause: error,
      });
      continue;
    }

    if (body?.errors) {
      const errors = Array.isArray(body.errors) ? body.errors : [body.errors];
      if (isThrottled(errors)) {
        lastError = new RetryableError(`${label}: throttled`);
        // Shopify tells us how far the bucket has to refill; wait exactly that.
        const cost = body.extensions?.cost;
        if (cost?.throttleStatus) {
          const { currentlyAvailable, restoreRate } = cost.throttleStatus;
          const needed =
            (cost.requestedQueryCost || 0) - (currentlyAvailable || 0);
          if (needed > 0 && restoreRate > 0) {
            lastError.retryAfterMs = Math.min(
              MAX_DELAY_MS,
              Math.ceil((needed / restoreRate) * 1000),
            );
          }
        }
        continue;
      }
      throw new FatalError(`${label}: ${JSON.stringify(errors).slice(0, 500)}`);
    }

    return body.data;
  }

  throw exhausted(label, attempts, lastError);
}

/**
 * Retries are spent, but the condition that caused them (throttle, 5xx, dropped
 * socket) was transient. Flagged so a caller with a longer retry budget of its
 * own — Shopify's webhook redelivery — can pick the work back up.
 */
function exhausted(label, attempts, lastError) {
  const error = new FatalError(
    `${label}: giving up after ${attempts} attempts (${lastError?.message || "unknown"})`,
    { cause: lastError },
  );
  error.exhausted = true;
  return error;
}

/**
 * Whether a webhook handler should hand Shopify a non-2xx so the delivery is
 * retried. `graphqlWithRetry` has already exhausted in-process retries by the
 * time this is consulted, and it tags the underlying cause as retryable, so a
 * throttle or outage becomes a redelivery instead of a lost inventory change.
 * A fatal error (bad query, revoked scope) must return false: Shopify would
 * redeliver it 19 times over 48h and can drop the subscription entirely.
 */
export function shouldRedeliverWebhook(error) {
  // `retryable` alone is not enough: exhaustion is reported as a FatalError
  // (retryable === false, because *this* process must stop trying) even though
  // the underlying condition was transient. `exhausted` marks exactly that case.
  return Boolean(error?.exhausted || error?.retryable === true);
}

/** Same policy, for the signed result URL that serves the JSONL export. */
export async function fetchWithRetry(url, options = {}) {
  const {
    attempts = DEFAULT_ATTEMPTS,
    signal,
    label = "fetch",
    ...init
  } = options;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await sleep(lastError?.retryAfterMs ?? backoffDelay(attempt - 1), signal);
    }

    let response;
    try {
      response = await fetch(url, { ...init, signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (isTransientNetworkError(error)) {
        lastError = new RetryableError(`${label}: ${error.message}`, {
          cause: error,
        });
        continue;
      }
      throw new FatalError(`${label}: ${error.message}`, { cause: error });
    }

    if (response.status === 429 || response.status >= 500) {
      lastError = new RetryableError(`${label}: HTTP ${response.status}`);
      lastError.retryAfterMs = retryAfterMs(response);
      continue;
    }

    if (!response.ok) {
      throw new FatalError(`${label}: HTTP ${response.status}`);
    }

    return response;
  }

  throw exhausted(label, attempts, lastError);
}
