// Minimal in-memory stand-in for the Prisma client, covering exactly the calls
// the sync service makes. Records every write so tests can assert on the
// progress timeline the UI would have polled.

const store = new Map();
export const writeLog = [];

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function matches(row, where) {
  for (const [key, condition] of Object.entries(where)) {
    if (key === "OR") {
      if (!condition.some((clause) => matches(row, clause))) return false;
      continue;
    }
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      if ("lt" in condition && !(row[key] !== null && row[key] < condition.lt)) return false;
      if ("gt" in condition && !(row[key] !== null && row[key] > condition.gt)) return false;
      if ("in" in condition && !condition.in.includes(row[key])) return false;
      if ("notIn" in condition && condition.notIn.includes(row[key])) return false;
      continue;
    }
    if (row[key] !== condition) return false;
  }
  return true;
}

function table(name) {
  if (!store.has(name)) store.set(name, new Map());
  return store.get(name);
}

function makeModel(name, key) {
  const rows = () => table(name);

  return {
    async findUnique({ where }) {
      return clone(rows().get(where[key])) ?? null;
    },

    async create({ data }) {
      if (rows().has(data[key])) {
        // Mirrors Prisma's unique-constraint violation, which the atomic start
        // claim relies on.
        const error = new Error(`Unique constraint failed on ${name}.${key}`);
        error.code = "P2002";
        throw error;
      }
      const next = { failed: 0, ...data, updatedAt: new Date() };
      rows().set(data[key], next);
      writeLog.push({ model: name, op: "create", row: clone(next) });
      return clone(next);
    },

    async update({ where, data }) {
      const existing = rows().get(where[key]);
      if (!existing) throw new Error(`${name}: no row for ${where[key]}`);
      const next = { ...existing, ...data, updatedAt: new Date() };
      rows().set(where[key], next);
      writeLog.push({ model: name, op: "update", data: clone(data), row: clone(next) });
      return clone(next);
    },

    async updateMany({ where, data }) {
      let count = 0;
      for (const [id, row] of rows()) {
        if (!matches(row, where)) continue;
        rows().set(id, { ...row, ...data, updatedAt: new Date() });
        count += 1;
      }
      writeLog.push({ model: name, op: "updateMany", data: clone(data), count });
      return { count };
    },

    async upsert({ where, create, update }) {
      const existing = rows().get(where[key]);
      const next = existing
        ? { ...existing, ...update, updatedAt: new Date() }
        : { failed: 0, ...create, updatedAt: new Date() };
      rows().set(where[key], next);
      writeLog.push({ model: name, op: "upsert", row: clone(next) });
      return clone(next);
    },
  };
}

export function resetDb() {
  store.clear();
  writeLog.length = 0;
}

/** Bypasses the log, for arranging test state. */
export function seed(name, key, row) {
  table(name).set(row[key], row);
}

const prisma = {
  bulkSyncJob: makeModel("bulkSyncJob", "shop"),
  tagAutomationSetting: makeModel("tagAutomationSetting", "shop"),
  session: makeModel("session", "id"),
};

export default prisma;
