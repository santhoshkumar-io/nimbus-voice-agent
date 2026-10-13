// Backend URL the playground / voice / RAG pages and the landing widget talk to.
//
// Auto-detects so one file works in both environments and there is no hardcoded
// URL to forget: served from localhost -> talk to a local backend on :8100;
// served from anywhere else -> the deployed backend.
// Still overridable from the "API keys" dialog (persisted to localStorage), which
// takes precedence over this value.
(function () {
  var h = location.hostname;
  var isLocal = h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "";
  window.NIMBUS_API_BASE = isLocal
    ? "http://127.0.0.1:8100"
    : "https://nimbus-api-production-0295.up.railway.app";
})();
