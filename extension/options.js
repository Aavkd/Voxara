const tokenInput = document.getElementById("token");
const portInput = document.getElementById("port");
const saveButton = document.getElementById("save");
const statusBox = document.getElementById("status");

async function load() {
  const stored = await chrome.storage.local.get({
    token: "",
    port: 7863,
    bridgeStatus: "not connected yet",
  });
  tokenInput.value = stored.token;
  portInput.value = stored.port;
  statusBox.textContent = `Status: ${stored.bridgeStatus}`;
}

saveButton.addEventListener("click", async () => {
  const port = Number.parseInt(portInput.value, 10);
  await chrome.storage.local.set({
    token: tokenInput.value.trim(),
    port: Number.isInteger(port) && port > 0 ? port : 7863,
  });
  statusBox.textContent = "Status: saved — reconnecting…";
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.bridgeStatus) {
    statusBox.textContent = `Status: ${changes.bridgeStatus.newValue}`;
  }
});

load();
