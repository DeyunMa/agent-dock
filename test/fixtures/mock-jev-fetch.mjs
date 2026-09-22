const original = globalThis.fetch;
globalThis.fetch = (url, init) => {
  if (String(url) === "https://api.typesafe.ai/v1/systemone") return original(process.env.AGENT_DOCK_TEST_JEV_URL + "/v1/systemone", init);
  return original(url, init);
};
