const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  vm = require("node:vm");
const { webcrypto } = require("node:crypto");
const source = fs.readFileSync(
  require.resolve("../src/browser/browser-uuid.js"),
  "utf8",
);
test("HTTP UUID fallback produces standard v4 UUIDs using the available cryptographic RNG", () => {
  const crypto = {
    getRandomValues: (array) => webcrypto.getRandomValues(array),
  };
  vm.runInNewContext(source, { crypto });
  const values = Array.from({ length: 100 }, () => crypto.randomUUID());
  for (const value of values)
    assert.match(
      value,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  assert.equal(new Set(values).size, values.length);
});
test("native UUID generation on localhost or HTTPS is preserved", () => {
  const native = () => "native-uuid";
  const crypto = {
    randomUUID: native,
    getRandomValues: () => assert.fail("Native RNG should not be replaced"),
  };
  vm.runInNewContext(source, { crypto });
  assert.equal(crypto.randomUUID, native);
});
