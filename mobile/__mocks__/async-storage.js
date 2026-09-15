const values = new Map();

module.exports = {
  getItem: async (key) => values.get(key) ?? null,
  setItem: async (key, value) => {
    values.set(key, value);
  },
  removeItem: async (key) => {
    values.delete(key);
  },
  clear: async () => {
    values.clear();
  },
};
