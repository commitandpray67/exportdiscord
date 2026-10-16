// Discord IDs ("snowflakes") encode their creation time, which lets us ask the
// API for messages after/before a point in time.
(function (root) {
  const DISCORD_EPOCH = 1420070400000n;

  function snowflakeFromTime(ms) {
    const delta = BigInt(Math.floor(ms)) - DISCORD_EPOCH;
    return delta > 0n ? delta << 22n : 0n;
  }

  function timeFromSnowflake(id) {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
  }

  function compareSnowflakes(a, b) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }

  const api = { snowflakeFromTime, timeFromSnowflake, compareSnowflakes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DXSnowflake = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
