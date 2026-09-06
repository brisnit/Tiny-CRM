/**
 * The data layer is marked `server-only` so it can never be pulled into a client
 * bundle. That guard throws outside Next's runtime, so scripts that legitimately
 * run this code on the server (the scale probe) neutralise it here.
 */
const Module = require("node:module");
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "server-only" || request === "client-only") return {};
  return load.call(this, request, ...rest);
};
