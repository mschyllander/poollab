/* (C) 2026 by Mats Schyllander. All rights reserved. matsarlemark@gmail.com
   MIT License.

   BLE-YC01 Pool Logger Gateway for ESP32
   Mr Matzos PoolLab firmware v1.1.34-HTTPOTA-FILTER

   Changes in this build:
   - Removes ArduinoOTA / PlatformIO OTA completely.
   - Adds pull-based HTTP OTA via /httpota.
   - ESP32 downloads firmware directly from NAS/web server:
       http://192.168.1.184:8010/update/poolsniffer.bin
   - This avoids Windows firewall, host_ip, callback-port and PlatformIO OTA handshake problems.
   - Stops BLE cleanly before firmware update.
   - Keeps WiFi modem sleep ON while BLE is active.
   - Adds decodedLen debug in serial and /pairs.
   - Keeps safer pH filtering and chlorine smoothing.
   - Fixes ORP mapping using decoded[20..21] when full frame is available, with fallback to old index.

   Update flow:
   1) Build firmware.bin locally.
   2) Copy it to: /volume1/docker/pool-logger/web/update/poolsniffer.bin
   3) Open: http://<ESP-IP>/httpota
*/

#include <Arduino.h>
#include <math.h>
#include <EEPROM.h>
#include <WiFi.h>
#include <WebServer.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <map>

#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEScan.h>
#include <BLEClient.h>
#include <BLERemoteService.h>
#include <BLERemoteCharacteristic.h>

// ===================== USER CONFIG =====================

static BLEAddress sensorAddress("c0:00:00:05:97:da");
String pairedSensorMac = "c0:00:00:05:97:da";

static BLEUUID serviceUUID("0000ff01-0000-1000-8000-00805f9b34fb");
static BLEUUID charUUID("0000ff02-0000-1000-8000-00805f9b34fb");

const char* API_URL = "http://192.168.1.184:8010/api/pool/measurements";
const char* HEARTBEAT_URL = "http://192.168.1.184:8010/api/pool/heartbeat";

const char* DEVICE_ID = "pool-esp32-01";
const char* SETUP_AP_SSID = "pool-setup";
const char* SETUP_AP_PASS = "12345678";
const char* FIRMWARE_VERSION = "1.1.42";

const int TEMP_PAIR_INDEX = 13;
const int PH_PAIR_INDEX = 3;  // BLE raw pH pair.

const bool ENABLE_HTTP_OTA = true;
const char* HTTP_OTA_URL = "http://192.168.1.184:8010/update/poolsniffer.bin";
const unsigned long HEARTBEAT_INTERVAL_MS = 30000;
const unsigned long SENSOR_TRIGGER_INTERVAL_MS = 30UL * 60UL * 1000UL;
const unsigned long BATTERY_SCAN_INTERVAL_MS = 30UL * 60UL * 1000UL;
const uint32_t BATTERY_SCAN_SECONDS = 3;

const float TEMP_OFFSET_C = 0.0f;
const float PH_OFFSET = 0.0f;
const float ORP_OFFSET_MV = 0.0f;

// ===================== EEPROM CONFIG =====================

#define EEPROM_SIZE 240
#define SSID_ADDR   0
#define PASS_ADDR   64
#define BLE_MAC_ADDR 160
#define SSID_MAX    64
#define PASS_MAX    96
#define BLE_MAC_MAX 32

// ===================== GLOBALS =====================

WebServer server(80);
bool webServerStarted = false;
bool networkStackStarted = false;

BLEClient* pClient = nullptr;
BLERemoteCharacteristic* pChar = nullptr;
BLEScan* pBLEScan = nullptr;
bool bleInitialized = false;

String serialLine = "";
float batteryPct = -1.0f;
int lastBleRssi = -999;

uint8_t lastDecodedFrame[32];
size_t lastDecodedLen = 0;
bool haveLastDecodedFrame = false;

bool otaMaintenanceMode = false;
unsigned long otaMaintenanceUntil = 0;

float lastStableTemp = NAN;
float pendingTemp = NAN;
int pendingTempCount = 0;
const float TEMP_SPIKE_THRESHOLD_C = 0.8f;
const int TEMP_SPIKE_CONFIRM_COUNT = 3;

float lastStablePh = NAN;
float pendingPh = NAN;
int pendingPhCount = 0;
const float PH_SPIKE_THRESHOLD = 0.15f;      // less sticky than older 0.08/4-confirm setup
const int PH_SPIKE_CONFIRM_COUNT = 2;

float lastStableOrp = NAN;
float pendingOrp = NAN;
int pendingOrpCount = 0;
const float ORP_SPIKE_THRESHOLD_MV = 35.0f;
const int ORP_SPIKE_CONFIRM_COUNT = 3;

float lastStableCl = NAN;
const float CL_EMA_ALPHA = 0.35f;            // 0.35 = responsive but smoother than raw spikes

unsigned long lastTrigger = 0;
unsigned long lastBatteryScan = 0;
unsigned long lastHeartbeat = 0;
String currentBleStatus = "booting";

// ===================== FORWARD DECLARATIONS =====================

bool pairBleSensor();
bool connectToSensor();
void clearBlePairing();
void performHttpOta();
void setBleStatus(const String& status);
void sendHeartbeat(const String& status, bool force = false);
void printFrame(const std::string& value, const char* source);
void sendSensorTrigger();
String statusJson();
uint16_t u16RawBE(const uint8_t* d, int i);

// ===================== SERVICE / OTA HELPERS =====================

void setBleStatus(const String& status) {
  currentBleStatus = status;
}

String boolJson(bool v) {
  return v ? "true" : "false";
}

void serviceTasks() {
  if (networkStackStarted && webServerStarted) server.handleClient();
  yield();
}

void stopBleForUpdate() {
  Serial.println("Stopping BLE for firmware update...");
  pChar = nullptr;

  if (pClient != nullptr) {
    if (pClient->isConnected()) {
      Serial.println("Disconnecting BLE client...");
      pClient->disconnect();
      delay(300);
    }
    delete pClient;
    pClient = nullptr;
    delay(100);
  }

  if (bleInitialized) {
    Serial.println("Deinitializing BLE stack...");
    BLEDevice::deinit(true);
    bleInitialized = false;
    delay(500);
  }

  // Extra safety: make sure the BT controller is stopped before firmware update.
  btStop();
  delay(300);

  pBLEScan = nullptr;
  lastBleRssi = -999;
  setBleStatus("update_ble_stopped");
}

void ensureBleInitialized() {
  if (otaMaintenanceMode) return;
  if (!bleInitialized) {
    // Required by this ESP32 Arduino framework when WiFi and Bluetooth coexist.
    WiFi.setSleep(true);
    Serial.println("Initializing BLE...");
    BLEDevice::init("");
    bleInitialized = true;
    Serial.println("BLE initialized.");
  }
}

// ===================== EEPROM HELPERS =====================

void saveStringToEEPROM(int addr, const String& value, int maxLen) {
  for (int i = 0; i < maxLen; i++) EEPROM.write(addr + i, i < value.length() ? value[i] : 0);
  EEPROM.commit();
}

String loadStringFromEEPROM(int addr, int maxLen) {
  String value = "";
  for (int i = 0; i < maxLen; i++) {
    char c = EEPROM.read(addr + i);
    if (c == 0 || c == 255) break;
    value += c;
  }
  return value;
}

void clearWiFiConfig() {
  saveStringToEEPROM(SSID_ADDR, "", SSID_MAX);
  saveStringToEEPROM(PASS_ADDR, "", PASS_MAX);
}

void saveBleMacToEEPROM(const String& mac) {
  saveStringToEEPROM(BLE_MAC_ADDR, mac, BLE_MAC_MAX);
}

String loadBleMacFromEEPROM() {
  String mac = loadStringFromEEPROM(BLE_MAC_ADDR, BLE_MAC_MAX);
  mac.trim();
  mac.toLowerCase();
  if (mac.length() == 17) return mac;
  return "c0:00:00:05:97:da";
}

void clearBlePairing() {
  saveStringToEEPROM(BLE_MAC_ADDR, "", BLE_MAC_MAX);
  pairedSensorMac = "c0:00:00:05:97:da";
  sensorAddress = BLEAddress(pairedSensorMac.c_str());
}

void applyPairedSensorMac() {
  pairedSensorMac = loadBleMacFromEEPROM();
  sensorAddress = BLEAddress(pairedSensorMac.c_str());
  Serial.print("BLE sensor MAC: ");
  Serial.println(pairedSensorMac);
}

void beginWebServerOnce() {
  if (!webServerStarted) {
    server.begin();
    webServerStarted = true;
    Serial.println("WebServer started.");
  }
}

// ===================== WIFI / WEB =====================

String htmlPage() {
  int n = WiFi.scanNetworks();
  String html = "<!doctype html><html><head><meta charset='utf-8'>";
  html += "<meta name='viewport' content='width=device-width,initial-scale=1'>";
  html += "<title>Pool ESP32 Setup</title>";
  html += "<style>body{font-family:Arial;background:#111;color:#eee;padding:20px}";
  html += "input,select,button{width:100%;padding:12px;margin:8px 0;font-size:16px}";
  html += "button{background:#0af;color:#000;border:0;border-radius:8px;font-weight:bold}";
  html += ".box{max-width:560px;margin:auto;background:#222;padding:20px;border-radius:12px}";
  html += "a{color:#7df}</style></head><body><div class='box'>";
  html += "<h2>Pool ESP32 WiFi Setup</h2>";
  html += "<p>Firmware: " + String(FIRMWARE_VERSION) + "</p>";
  html += "<p>BLE sensor: " + pairedSensorMac + "</p>";
  html += "<p><a href='/status'>/status</a> &nbsp; <a href='/httpota'>/httpota</a> &nbsp; <a href='/read'>/read</a> &nbsp; <a href='/pairs'>/pairs</a> &nbsp; <a href='/trigger'>/trigger</a> &nbsp; <a href='/reboot'>/reboot</a></p>";
  html += "<form method='POST' action='/save'><label>WiFi network</label><select name='ssid'>";
  for (int i = 0; i < n; i++) html += "<option value='" + WiFi.SSID(i) + "'>" + WiFi.SSID(i) + " (" + String(WiFi.RSSI(i)) + " dBm)</option>";
  html += "</select><label>Password</label><input name='pass' type='password' placeholder='WiFi password'>";
  html += "<button type='submit'>Save and reboot</button></form>";
  html += "<form method='POST' action='/clear'><button type='submit'>Reset WiFi settings</button></form>";
  html += "</div></body></html>";
  return html;
}

String statusJson() {
  String json = "{";
  json += "\"device_id\":\"" + String(DEVICE_ID) + "\",";
  json += "\"firmware_version\":\"" + String(FIRMWARE_VERSION) + "\",";
  json += "\"uptime_ms\":" + String(millis()) + ",";
  json += "\"ble_sensor_mac\":\"" + pairedSensorMac + "\",";
  json += "\"wifi_connected\":" + boolJson(WiFi.status() == WL_CONNECTED) + ",";
  json += "\"wifi_rssi_dbm\":" + String(WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0) + ",";
  json += "\"ble_status\":\"" + currentBleStatus + "\",";
  json += "\"ble_connected\":" + boolJson(pClient && pClient->isConnected()) + ",";
  json += "\"ble_rssi_dbm\":" + String(lastBleRssi) + ",";
  json += "\"battery_pct\":";
  json += (batteryPct >= 0.0f ? String(batteryPct, 1) : "null");
  json += ",\"battery_chemistry\":\"liion_1s\"";
  json += ",\"battery_source\":\"ble_yc01_advertisement_or_decoded_frame\"";
  json += ",\"http_ota_enabled\":" + boolJson(ENABLE_HTTP_OTA);
  json += ",\"http_ota_url\":\"" + String(HTTP_OTA_URL) + "\"";
  json += ",\"firmware_update_mode\":" + boolJson(otaMaintenanceMode);
  json += ",\"temp_pair_index\":" + String(TEMP_PAIR_INDEX);
  json += ",\"ph_pair_index\":" + String(PH_PAIR_INDEX);
  json += "}";
  return json;
}

void registerWebRoutes() {
  server.on("/", HTTP_GET, []() { server.send(200, "text/html", htmlPage()); });
  server.on("/favicon.ico", HTTP_GET, []() { server.send(204, "text/plain", ""); });

  server.on("/save", HTTP_POST, []() {
    saveStringToEEPROM(SSID_ADDR, server.arg("ssid"), SSID_MAX);
    saveStringToEEPROM(PASS_ADDR, server.arg("pass"), PASS_MAX);
    server.send(200, "text/html", "<h2>Saved. Rebooting...</h2>");
    delay(1000);
    ESP.restart();
  });

  server.on("/clear", HTTP_POST, []() {
    clearWiFiConfig();
    server.send(200, "text/html", "<h2>WiFi settings cleared. Rebooting...</h2>");
    delay(1000);
    ESP.restart();
  });

  server.on("/reboot", HTTP_GET, []() {
    server.send(200, "text/plain", "Rebooting...");
    delay(500);
    ESP.restart();
  });

  server.on("/httpota", HTTP_GET, []() {
    server.send(200, "text/plain", "HTTP OTA started. ESP32 will download firmware from: " + String(HTTP_OTA_URL));
    delay(800);
    performHttpOta();
  });

  server.on("/ota", HTTP_GET, []() {
    server.send(410, "text/plain", "ArduinoOTA/PlatformIO OTA removed. Use /httpota instead.");
  });

  server.on("/status", HTTP_GET, []() { server.send(200, "application/json", statusJson()); });
  server.on("/api/status", HTTP_GET, []() { server.send(200, "application/json", statusJson()); });

  server.on("/pair", HTTP_POST, []() {
    if (otaMaintenanceMode) { server.send(409, "text/plain", "OTA maintenance active. Reboot before pairing."); return; }
    if (pClient && pClient->isConnected()) { pChar = nullptr; pClient->disconnect(); delay(300); }
    bool ok = pairBleSensor();
    if (ok) { connectToSensor(); server.send(200, "text/plain", "PAIR OK: " + pairedSensorMac); }
    else server.send(500, "text/plain", "PAIR failed: no BLE-YC01 found");
  });

  server.on("/clearpair", HTTP_POST, []() {
    clearBlePairing();
    server.send(200, "text/html", "<h2>BLE pairing cleared. Rebooting...</h2>");
    delay(1000);
    ESP.restart();
  });

  server.on("/read", HTTP_GET, []() {
    if (otaMaintenanceMode) { server.send(409, "text/plain", "OTA maintenance active."); return; }
    if (!pClient || !pClient->isConnected() || pChar == nullptr) {
      if (!connectToSensor()) { server.send(500, "text/plain", "BLE connect failed. Check /status."); return; }
    }
    if (pChar && pChar->canRead()) {
      std::string value = pChar->readValue();
      printFrame(value, "WEB_READ");
      server.send(200, "text/plain", "READ done. Open /pairs.");
    } else server.send(500, "text/plain", "FF02 not readable or BLE not connected.");
  });

  server.on("/trigger", HTTP_GET, []() {
    if (otaMaintenanceMode) { server.send(409, "text/plain", "OTA maintenance active."); return; }
    if (pClient && pClient->isConnected() && pChar && pChar->canWrite()) {
      sendSensorTrigger();
      server.send(200, "text/plain", "Trigger sent: 55 AA. Open /pairs after notify/read.");
    } else server.send(500, "text/plain", "BLE not connected or FF02 not writable.");
  });


  server.on("/api/trigger", HTTP_GET, []() {
    if (otaMaintenanceMode) { server.send(409, "application/json", "{\"ok\":false,\"error\":\"maintenance active\"}"); return; }

    if (!(pClient && pClient->isConnected() && pChar && pChar->canWrite())) {
      connectToSensor();
    }

    if (pClient && pClient->isConnected() && pChar && pChar->canWrite()) {
      sendSensorTrigger();
      server.send(200, "application/json", "{\"ok\":true,\"trigger\":\"sent\"}");
    } else {
      server.send(500, "application/json", "{\"ok\":false,\"error\":\"BLE not connected or FF02 not writable\"}");
    }
  });

  server.on("/pairs", HTTP_GET, []() {
    if (!haveLastDecodedFrame) { server.send(404, "text/plain", "No decoded frame yet. Open /read first."); return; }
    String out = "YC01 decoded pair debug\n";
    out += "Firmware: " + String(FIRMWARE_VERSION) + "\n";
    out += "Decoded length: " + String(lastDecodedLen) + "\n";
    out += "Current temp mapping: decoded[" + String(TEMP_PAIR_INDEX) + ".." + String(TEMP_PAIR_INDEX + 1) + "] / 10.0\n";
    out += "pH mapping: decoded[PH_PAIR_INDEX..PH_PAIR_INDEX+1] / 100.0 + PH_OFFSET\n";
    out += "ORP mapping: decoded[20..21] if available, else decoded[9..10] fallback\n\n";
    for (int i = 0; i < (int)lastDecodedLen - 1; i++) {
      uint16_t be = u16RawBE(lastDecodedFrame, i);
      out += "i=" + String(i) + " u16BE=" + String(be) + " /10=" + String(be / 10.0f, 1) + " /100=" + String(be / 100.0f, 2);
      if (be >= 280 && be <= 380) out += "  <-- possible temp";
      if ((be / 100.0f) >= 4.5f && (be / 100.0f) <= 9.5f) out += "  <-- possible pH";
      if (i == TEMP_PAIR_INDEX) out += "  <-- CURRENT TEMP MAPPING";
      if (i == PH_PAIR_INDEX) out += "  <-- CURRENT PH MAPPING";
      if (i == 3) out += "  <-- PH MAPPING";
      if (i == 20) out += "  <-- ORP MAPPING";
      out += "\n";
    }
    server.send(200, "text/plain", out);
  });
}

void startSetupAP() {
  Serial.println("Starting setup AP...");
  WiFi.mode(WIFI_AP_STA);
  WiFi.setSleep(true);
  WiFi.softAP(SETUP_AP_SSID, SETUP_AP_PASS);
  networkStackStarted = true;
  Serial.print("Setup AP SSID: "); Serial.println(SETUP_AP_SSID);
  Serial.print("Setup AP IP: "); Serial.println(WiFi.softAPIP());
  registerWebRoutes();
  beginWebServerOnce();
}

bool connectWiFiFromEEPROM() {
  String ssid = loadStringFromEEPROM(SSID_ADDR, SSID_MAX);
  String pass = loadStringFromEEPROM(PASS_ADDR, PASS_MAX);
  if (ssid.length() == 0) { Serial.println("No saved WiFi SSID."); return false; }

  Serial.print("Connecting WiFi: "); Serial.println(ssid);
  WiFi.mode(WIFI_STA);
  networkStackStarted = true;
  WiFi.begin(ssid.c_str(), pass.c_str());

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    serviceTasks();
    delay(250);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi connected. IP: "); Serial.println(WiFi.localIP());
    Serial.print("WiFi RSSI="); Serial.print(WiFi.RSSI()); Serial.println(" dBm");
    return true;
  }

  Serial.println("WiFi connect failed.");
  setBleStatus("wifi_failed");
  return false;
}

// ===================== HTTP OTA =====================

void performHttpOta() {
  if (!ENABLE_HTTP_OTA) {
    Serial.println("HTTP OTA disabled in firmware.");
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("HTTP OTA failed: WiFi not connected.");
    return;
  }

  otaMaintenanceMode = true;
  setBleStatus("http_ota_start");

  Serial.println("================================");
  Serial.println("HTTP OTA START");
  Serial.print("URL: ");
  Serial.println(HTTP_OTA_URL);
  Serial.println("Stopping BLE before update...");

  stopBleForUpdate();
  WiFi.setSleep(false);
  delay(500);

  WiFiClient client;
  httpUpdate.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
  t_httpUpdate_return ret = httpUpdate.update(client, HTTP_OTA_URL);

  switch (ret) {
    case HTTP_UPDATE_FAILED:
      Serial.printf("HTTP OTA failed: (%d) %s\n",
                    httpUpdate.getLastError(),
                    httpUpdate.getLastErrorString().c_str());
      setBleStatus("http_ota_failed");
      otaMaintenanceMode = false;
      WiFi.setSleep(true);
      delay(1000);
      ESP.restart();
      break;

    case HTTP_UPDATE_NO_UPDATES:
      Serial.println("HTTP OTA: no update.");
      setBleStatus("http_ota_no_update");
      otaMaintenanceMode = false;
      WiFi.setSleep(true);
      break;

    case HTTP_UPDATE_OK:
      Serial.println("HTTP OTA OK. Rebooting...");
      setBleStatus("http_ota_ok");
      break;
  }
}

// ===================== DECODE / FILTER =====================

uint16_t u16BE(const uint8_t* d, int i) { return ((uint16_t)d[i] << 8) | d[i + 1]; }
int16_t s16BE(const uint8_t* d, int i) { return (int16_t)u16BE(d, i); }
uint16_t u16RawBE(const uint8_t* d, int i) { return ((uint16_t)d[i] << 8) | d[i + 1]; }

float filterTemp(float newTemp) {
  if (isnan(lastStableTemp)) { lastStableTemp = newTemp; pendingTemp = NAN; pendingTempCount = 0; return newTemp; }
  float diff = fabs(newTemp - lastStableTemp);
  if (diff <= TEMP_SPIKE_THRESHOLD_C) { lastStableTemp = newTemp; pendingTemp = NAN; pendingTempCount = 0; return newTemp; }
  if (isnan(pendingTemp) || fabs(newTemp - pendingTemp) > 0.25f) { pendingTemp = newTemp; pendingTempCount = 1; }
  else pendingTempCount++;
  Serial.printf("Temp spike/change candidate confirming: raw=%.1f stable=%.1f count=%d\n", newTemp, lastStableTemp, pendingTempCount);
  if (pendingTempCount >= TEMP_SPIKE_CONFIRM_COUNT) { lastStableTemp = pendingTemp; pendingTemp = NAN; pendingTempCount = 0; Serial.printf("Temp new stable accepted: %.1f\n", lastStableTemp); }
  return lastStableTemp;
}

float filterPH(float newPh) {
  if (isnan(lastStablePh)) { lastStablePh = newPh; pendingPh = NAN; pendingPhCount = 0; return newPh; }
  float diff = fabs(newPh - lastStablePh);

  // pH is slow but should still show real small movement. Pass normal small changes directly.
  if (diff <= PH_SPIKE_THRESHOLD) {
    lastStablePh = newPh;
    pendingPh = NAN;
    pendingPhCount = 0;
    return newPh;
  }

  // Larger jumps need confirmation, but only two frames so real chemical changes are not hidden too long.
  if (isnan(pendingPh) || fabs(newPh - pendingPh) > 0.08f) { pendingPh = newPh; pendingPhCount = 1; }
  else pendingPhCount++;
  Serial.printf("pH change candidate confirming: raw=%.2f stable=%.2f count=%d\n", newPh, lastStablePh, pendingPhCount);
  if (pendingPhCount >= PH_SPIKE_CONFIRM_COUNT) { lastStablePh = pendingPh; pendingPh = NAN; pendingPhCount = 0; Serial.printf("pH new stable accepted: %.2f\n", lastStablePh); }
  return lastStablePh;
}

float filterORP(float newOrp) {
  if (isnan(lastStableOrp)) { lastStableOrp = newOrp; pendingOrp = NAN; pendingOrpCount = 0; return newOrp; }
  float diff = fabs(newOrp - lastStableOrp);
  if (newOrp > 900.0f || newOrp < 0.0f) { Serial.printf("ORP invalid-frame ignored: %.0f\n", newOrp); return lastStableOrp; }
  if (diff <= ORP_SPIKE_THRESHOLD_MV) { lastStableOrp = newOrp; pendingOrp = NAN; pendingOrpCount = 0; return newOrp; }
  if (isnan(pendingOrp) || fabs(newOrp - pendingOrp) > 12.0f) { pendingOrp = newOrp; pendingOrpCount = 1; }
  else pendingOrpCount++;
  Serial.printf("ORP change candidate confirming: raw=%.0f stable=%.0f count=%d\n", newOrp, lastStableOrp, pendingOrpCount);
  if (pendingOrpCount >= ORP_SPIKE_CONFIRM_COUNT) { lastStableOrp = pendingOrp; pendingOrp = NAN; pendingOrpCount = 0; Serial.printf("ORP new stable accepted: %.0f\n", lastStableOrp); }
  return lastStableOrp;
}

float filterChlorine(float newCl) {
  if (newCl < 0.0f || newCl > 20.0f || isnan(newCl)) return isnan(lastStableCl) ? 0.0f : lastStableCl;
  if (isnan(lastStableCl)) {
    lastStableCl = newCl;
  } else {
    lastStableCl = (CL_EMA_ALPHA * newCl) + ((1.0f - CL_EMA_ALPHA) * lastStableCl);
  }
  return lastStableCl;
}

static constexpr float CHLORINE_FACTOR = 2.25f;

float estimateChlorine(float orp, float ph) {
  if (orp < 500.0f || ph < 4.0f || ph > 9.5f) return 0.0f;
  float cl = 0.9f * ((orp - 650.0f) / (712.0f - 650.0f)) * powf(10.0f, 7.09f - ph);
  cl *= CHLORINE_FACTOR;
  if (cl < 0.0f) cl = 0.0f;
  if (cl > 10.0f) cl = 10.0f;
  return cl;
}

String rawToHexString(const std::string& value) {
  String raw = "";
  for (int i = 0; i < (int)value.length(); i++) {
    char buf[4]; sprintf(buf, "%02X", (uint8_t)value[i]); raw += buf;
    if (i < (int)value.length() - 1) raw += " ";
  }
  return raw;
}

String bytesToHexString(const uint8_t* data, size_t len) {
  String raw = "";
  for (size_t i = 0; i < len; i++) {
    char buf[4]; sprintf(buf, "%02X", data[i]); raw += buf;
    if (i < len - 1) raw += " ";
  }
  return raw;
}

bool decodeYC01Payload(const std::string& value, uint8_t* out, size_t& outLen, size_t maxLen) {
  if (value.length() == 0 || value.length() > maxLen) return false;
  outLen = value.length();
  for (size_t i = 0; i < outLen; i++) out[i] = (uint8_t)value[i];
  for (int i = (int)outLen - 1; i > 0; i--) {
    uint8_t tmp = out[i];
    uint8_t hibit1 = (tmp & 0x55) << 1;
    uint8_t lobit1 = (tmp & 0xAA) >> 1;
    tmp = out[i - 1];
    uint8_t hibit = (tmp & 0x55) << 1;
    uint8_t lobit = (tmp & 0xAA) >> 1;
    out[i]     = (uint8_t)~(hibit1 | lobit);
    out[i - 1] = (uint8_t)~(hibit  | lobit1);
  }
  return true;
}

void dumpDecodedYC01Pairs(const uint8_t* d, size_t len) {
  Serial.println("YC01 decoded pair debug:");
  Serial.print("decodedLen=");
  Serial.println((int)len);
  for (int i = 0; i < (int)len - 1; i++) {
    uint16_t be = u16RawBE(d, i);
    Serial.printf("  i=%d u16BE=%u /10=%.1f /100=%.2f", i, be, be / 10.0f, be / 100.0f);
    if (i == 3) Serial.print("  <-- PH");
    if (i == 20) Serial.print("  <-- ORP");
    if (i == TEMP_PAIR_INDEX) Serial.print("  <-- TEMP");
    Serial.println();
  }
}

// ===================== HTTP POST =====================

void sendHeartbeat(const String& status, bool force) {
  if (WiFi.status() != WL_CONNECTED) return;
  unsigned long nowMs = millis();
  if (!force && lastHeartbeat != 0 && nowMs - lastHeartbeat < HEARTBEAT_INTERVAL_MS) return;
  lastHeartbeat = nowMs;
  currentBleStatus = status;
  serviceTasks();

  HTTPClient http;
  http.setTimeout(3500);
  http.begin(HEARTBEAT_URL);
  http.addHeader("Content-Type", "application/json");

  String json = "{";
  json += "\"device_id\":\"" + String(DEVICE_ID) + "\",";
  json += "\"firmware_version\":\"" + String(FIRMWARE_VERSION) + "\",";
  json += "\"uptime_ms\":" + String(millis()) + ",";
  json += "\"wifi_connected\":" + boolJson(WiFi.status() == WL_CONNECTED) + ",";
  json += "\"wifi_rssi_dbm\":" + String(WiFi.RSSI()) + ",";
  json += "\"ble_status\":\"" + currentBleStatus + "\",";
  json += "\"ble_connected\":" + boolJson(pClient != nullptr && pClient->isConnected()) + ",";
  json += "\"ble_rssi_dbm\":" + String(lastBleRssi) + ",";
  json += "\"ble_sensor_mac\":\"" + pairedSensorMac + "\",";
  json += "\"battery_pct\":" + String(batteryPct >= 0.0f ? String(batteryPct, 1) : "null") + ",";
  json += "\"battery_chemistry\":\"liion_1s\",";
  json += "\"battery_source\":\"ble_yc01_advertisement_or_decoded_frame\",";
  json += "\"firmware_update_mode\":" + boolJson(otaMaintenanceMode);
  json += "}";

  int code = http.POST(json);
  Serial.print("HEARTBEAT "); Serial.print(code); Serial.print(" "); Serial.println(json);
  if (code > 0) { String response = http.getString(); Serial.print("Heartbeat response: "); Serial.println(response); }
  else Serial.println("Heartbeat POST failed.");
  http.end();
  serviceTasks();
}

void postMeasurement(float tempC, float ph, float orp, float cl, float battery, float rawTempC, float rawPhBle, float rawOrp, float rawCl, const String& rawHex) {
  if (WiFi.status() != WL_CONNECTED || otaMaintenanceMode) return;
  serviceTasks();

  HTTPClient http;
  http.setTimeout(5000);
  http.begin(API_URL);
  http.addHeader("Content-Type", "application/json");

  String json = "{";
  json += "\"device_id\":\"" + String(DEVICE_ID) + "\",";
  json += "\"uptime_ms\":" + String(millis()) + ",";
  json += "\"temp_c\":" + String(tempC, 2) + ",";
  json += "\"ph\":" + String(ph, 2) + ",";
  json += "\"orp_mv\":" + String(orp, 0) + ",";
  json += "\"cl_mg_l\":" + String(cl, 2) + ",";
  json += "\"raw_temp_c\":" + String(rawTempC, 2) + ",";
  json += "\"raw_ph\":" + String(rawPhBle, 2) + ",";
  json += "\"raw_orp_mv\":" + String(rawOrp, 0) + ",";
  json += "\"raw_cl_mg_l\":" + String(rawCl, 2) + ",";
  json += "\"battery_pct\":" + String(battery >= 0.0f ? String(battery, 1) : "null") + ",";
  json += "\"battery_chemistry\":\"liion_1s\",";
  json += "\"battery_source\":\"ble_yc01_advertisement_or_decoded_frame\",";
  json += "\"wifi_rssi_dbm\":" + String(WiFi.RSSI()) + ",";
  json += "\"ble_rssi_dbm\":" + String(lastBleRssi) + ",";
  json += "\"firmware_version\":\"" + String(FIRMWARE_VERSION) + "\",";
  json += "\"ble_sensor_mac\":\"" + pairedSensorMac + "\",";
  json += "\"raw_hex\":\"" + rawHex + "\"";
  json += "}";

  int code = http.POST(json);
  Serial.print("POST "); Serial.print(code); Serial.print(" "); Serial.println(json);
  if (code > 0) { String response = http.getString(); Serial.print("API response: "); Serial.println(response); }
  else Serial.println("POST failed.");
  http.end();
  serviceTasks();
}

// ===================== BLE =====================

void scanBattery() {
  if (otaMaintenanceMode) { Serial.println("Skipping battery scan: OTA maintenance active."); return; }
  ensureBleInitialized();
  Serial.println("Scanning battery/ad data...");
  serviceTasks();

  pBLEScan = BLEDevice::getScan();
  pBLEScan->setActiveScan(true);
  BLEScanResults results = pBLEScan->start(BATTERY_SCAN_SECONDS, false);
  serviceTasks();

  String targetMac = sensorAddress.toString().c_str();
  targetMac.toLowerCase();
  bool found = false;

  for (int i = 0; i < results.getCount(); i++) {
    serviceTasks();
    BLEAdvertisedDevice dev = results.getDevice(i);
    String mac = dev.getAddress().toString().c_str(); mac.toLowerCase();
    if (mac != targetMac) continue;
    found = true;
    setBleStatus("ble_advertisement_seen");
    lastBleRssi = dev.getRSSI();
    Serial.println("Found target BLE-YC01 by MAC.");
    std::string mfg = dev.getManufacturerData();
    Serial.print("ADV MFG RAW: ");
    for (int j = 0; j < (int)mfg.length(); j++) Serial.printf("%02X ", (uint8_t)mfg[j]);
    Serial.println();
    if (mfg.length() >= 9) {
      uint8_t raw = (uint8_t)mfg[8];
      batteryPct = raw * 0.957f;
      if (batteryPct > 100.0f) batteryPct = 100.0f;
      if (batteryPct < 0.0f) batteryPct = 0.0f;
      Serial.printf("Battery raw mfg[8]=%u Battery≈%.1f%%\n", raw, batteryPct);
    }
    break;
  }

  if (!found) {
    Serial.println("Target BLE device not found during battery scan.");
    setBleStatus("ble_advertisement_not_found");
    sendHeartbeat(currentBleStatus, true);
  }

  pBLEScan->clearResults();
  serviceTasks();
}

bool pairBleSensor() {
  if (otaMaintenanceMode) return false;
  ensureBleInitialized();
  Serial.println("PAIR: scanning for BLE-YC01 devices...");
  serviceTasks();

  BLEScan* scan = BLEDevice::getScan();
  scan->setActiveScan(true);
  BLEScanResults results = scan->start(5, false);

  String bestMac = "";
  int bestRssi = -999;

  for (int i = 0; i < results.getCount(); i++) {
    serviceTasks();
    BLEAdvertisedDevice dev = results.getDevice(i);
    String name = dev.haveName() ? dev.getName().c_str() : "";
    String mac = dev.getAddress().toString().c_str(); mac.toLowerCase();
    bool nameMatch = (name == "BLE-YC01");
    bool macLooksLikeTarget = mac.startsWith("c0:00:00:");
    if (!nameMatch && !macLooksLikeTarget) continue;
    int rssi = dev.getRSSI();
    Serial.printf("PAIR candidate: name=%s mac=%s rssi=%d\n", name.c_str(), mac.c_str(), rssi);
    if (bestMac.length() == 0 || rssi > bestRssi) { bestMac = mac; bestRssi = rssi; }
  }
  scan->clearResults();

  if (bestMac.length() != 17) {
    Serial.println("PAIR failed: no BLE-YC01 candidate found.");
    setBleStatus("pair_failed_no_sensor");
    sendHeartbeat(currentBleStatus, true);
    return false;
  }

  pairedSensorMac = bestMac;
  sensorAddress = BLEAddress(pairedSensorMac.c_str());
  saveBleMacToEEPROM(pairedSensorMac);
  lastBleRssi = bestRssi;
  setBleStatus("paired");
  sendHeartbeat(currentBleStatus, true);
  Serial.printf("PAIR saved BLE sensor MAC: %s RSSI=%d\n", pairedSensorMac.c_str(), bestRssi);
  return true;
}

void printFrame(const std::string& value, const char* source) {
  serviceTasks();
  if (value.length() < 20) { Serial.print(source); Serial.println(" | Frame too short"); return; }

  String rawHex = rawToHexString(value);
  uint8_t decoded[32];
  size_t decodedLen = 0;
  if (!decodeYC01Payload(value, decoded, decodedLen, sizeof(decoded))) {
    Serial.print(source); Serial.print(" | YC01 decode failed | RAW="); Serial.println(rawHex); return;
  }

  Serial.print("decodedLen=");
  Serial.println((int)decodedLen);

  if (decodedLen < 20) {
    Serial.print(source); Serial.print(" | Decoded frame too short | RAW="); Serial.println(rawHex); return;
  }

  uint16_t phU   = u16RawBE(decoded, PH_PAIR_INDEX);
  uint16_t ecU   = u16RawBE(decoded, 5);
  uint16_t tdsU  = u16RawBE(decoded, 7);
  uint16_t orpU  = decodedLen > 21 ? u16RawBE(decoded, 20) : u16RawBE(decoded, 9);
  uint16_t clU   = u16RawBE(decoded, 11);
  uint16_t tempU = u16RawBE(decoded, TEMP_PAIR_INDEX);
  uint16_t battU = u16RawBE(decoded, 15);

  float rawTempC = (tempU / 10.0f) + TEMP_OFFSET_C;
  float tempC = filterTemp(rawTempC);
  float rawPhBle = phU / 100.0f;

  // BLE decoded pH already matches the sensor display in current tests.
  // Keep PH_OFFSET at 0.0f unless future calibration proves a fixed offset is needed.
  float rawPh = rawPhBle + PH_OFFSET;
  float ph = rawPh;

  float rawOrp = (float)orpU + ORP_OFFSET_MV;
  float orp = filterORP(rawOrp);
  float decodedClRaw = clU / 10.0f;
  float clEst = estimateChlorine(orp, ph);
  float cl = filterChlorine(decodedClRaw);

  float decodedBattery = battU / 31.9f;
  if (decodedBattery >= 0.0f && decodedBattery <= 100.0f) batteryPct = decodedBattery;

  
  String phCandidates = "";
  for (int i = 0; i < (int)decodedLen - 1; i++) {
    uint16_t beCandidate = u16RawBE(decoded, i);
    float phCandidate = beCandidate / 100.0f;
    if (phCandidate >= 4.5f && phCandidate <= 9.5f) {
      if (phCandidates.length() > 0) phCandidates += " | ";
      phCandidates += "i=" + String(i) + ":" + String(phCandidate, 2);
    }
  }

  String decodedHex = bytesToHexString(decoded, decodedLen);
  memcpy(lastDecodedFrame, decoded, decodedLen);
  lastDecodedLen = decodedLen;
  haveLastDecodedFrame = true;

  Serial.print(source);
  Serial.printf(" | Temp≈%.1fC", tempC);
  if (fabs(rawTempC - tempC) > 0.05f) Serial.printf(" rawTemp=%.1fC", rawTempC);
  Serial.printf(" | tempPairIndex=%d | phPairIndex=%d | pH≈%.2f", TEMP_PAIR_INDEX, PH_PAIR_INDEX, ph);
  if (fabs(rawPh - ph) > 0.01f) Serial.printf(" rawPHdisplay=%.2f rawPHble=%.2f", rawPh, rawPhBle);
  Serial.printf(" | ORP≈%.0fmV", orp);
  if (fabs(rawOrp - orp) > 0.5f) Serial.printf(" rawORP=%.0fmV", rawOrp);
  Serial.printf(" | CL≈%.2fmg/L rawCL=%.2fmg/L | CL_est≈%.2fmg/L | EC=%u | TDS=%u", cl, decodedClRaw, clEst, ecU, tdsU);
  if (batteryPct >= 0.0f) Serial.printf(" | Battery≈%.1f%%", batteryPct); else Serial.print(" | Battery=N/A");
  if (WiFi.status() == WL_CONNECTED) Serial.printf(" | WiFiRSSI=%ddBm", WiFi.RSSI()); else Serial.print(" | WiFiRSSI=N/A");
  Serial.printf(" | BLERSSI=%ddBm | FW=%s | pH candidates /100: %s | DEC=%s | RAW=%s\n", lastBleRssi, FIRMWARE_VERSION, phCandidates.c_str(), decodedHex.c_str(), rawHex.c_str());

  setBleStatus("ble_ok");
  sendHeartbeat(currentBleStatus, true);
  postMeasurement(tempC, ph, orp, cl, batteryPct, rawTempC, rawPhBle, rawOrp, decodedClRaw, rawHex);
}

void notifyCallback(BLERemoteCharacteristic* characteristic, uint8_t* data, size_t length, bool isNotify) {
  std::string value((char*)data, length);
  printFrame(value, "NOTIFY");
}

bool connectToSensor() {
  if (otaMaintenanceMode) { Serial.println("BLE connect skipped: OTA maintenance active."); return false; }
  ensureBleInitialized();
  Serial.print("Connecting to BLE-YC01 at "); Serial.print(pairedSensorMac); Serial.println("...");
  serviceTasks();

  pChar = nullptr;
  if (pClient != nullptr) {
    if (pClient->isConnected()) { pClient->disconnect(); delay(500); }
    delete pClient;
    pClient = nullptr;
    delay(300);
  }

  pClient = BLEDevice::createClient();
  if (pClient == nullptr) { setBleStatus("ble_client_create_failed"); sendHeartbeat(currentBleStatus, true); return false; }

  if (!pClient->connect(sensorAddress)) {
    Serial.println("Connect failed.");
    pChar = nullptr;
    setBleStatus("ble_connect_failed");
    sendHeartbeat(currentBleStatus, true);
    return false;
  }

  Serial.println("Connected.");
  setBleStatus("ble_connected");
  sendHeartbeat(currentBleStatus, true);

  int connectedRssi = pClient->getRssi();
  if (connectedRssi != 0) lastBleRssi = connectedRssi;

  BLERemoteService* pService = pClient->getService(serviceUUID);
  if (pService == nullptr) {
    Serial.println("Service FF01 not found.");
    pChar = nullptr;
    pClient->disconnect();
    setBleStatus("ble_service_not_found");
    sendHeartbeat(currentBleStatus, true);
    return false;
  }

  pChar = pService->getCharacteristic(charUUID);
  if (pChar == nullptr) {
    Serial.println("Characteristic FF02 not found.");
    pClient->disconnect();
    setBleStatus("ble_characteristic_not_found");
    sendHeartbeat(currentBleStatus, true);
    return false;
  }

  Serial.println("FF02 found.");
  setBleStatus("ble_ready");
  sendHeartbeat(currentBleStatus, true);

  if (pChar->canNotify()) { pChar->registerForNotify(notifyCallback); delay(250); serviceTasks(); }
  if (pChar->canRead()) { std::string value = pChar->readValue(); printFrame(value, "READ"); }
  serviceTasks();
  return true;
}

void sendSensorTrigger() {
  serviceTasks();
  if (otaMaintenanceMode) { Serial.println("Trigger skipped: OTA maintenance active."); return; }
  if (pChar == nullptr || !pChar->canWrite()) {
    Serial.println("Cannot write trigger.");
    setBleStatus("ble_trigger_not_writable");
    sendHeartbeat(currentBleStatus, true);
    return;
  }
  uint8_t cmd[] = {0x55, 0xAA};
  pChar->writeValue(cmd, sizeof(cmd), true);
  Serial.println("WRITE FF02: 55 AA");
  setBleStatus("ble_trigger_sent");
  sendHeartbeat(currentBleStatus, false);
  serviceTasks();
}

// ===================== SERIAL =====================

int hexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

bool parseHexLine(String line, uint8_t* out, size_t& outLen, size_t maxLen) {
  line.trim(); line.replace(" ", ""); line.replace("-", ""); line.replace(":", "");
  if (line.length() == 0 || line.length() % 2 != 0) return false;
  outLen = 0;
  for (int i = 0; i < line.length(); i += 2) {
    if (outLen >= maxLen) return false;
    int hi = hexNibble(line[i]); int lo = hexNibble(line[i + 1]);
    if (hi < 0 || lo < 0) return false;
    out[outLen++] = (uint8_t)((hi << 4) | lo);
  }
  return outLen > 0;
}

void sendRawCommand(const uint8_t* data, size_t len) {
  if (pChar == nullptr || !pChar->canWrite()) { Serial.println("Cannot write to FF02."); return; }
  Serial.print("WRITE FF02: ");
  for (size_t i = 0; i < len; i++) { Serial.printf("%02X", data[i]); if (i < len - 1) Serial.print(" "); }
  Serial.println();
  pChar->writeValue((uint8_t*)data, len, true);
}

void dumpServices() {
  if (otaMaintenanceMode) { Serial.println("DUMP skipped: OTA maintenance active."); return; }
  if (pClient == nullptr || !pClient->isConnected()) {
    Serial.println("BLE not connected. Trying to connect first...");
    if (!connectToSensor()) { Serial.println("DUMP failed: could not connect to BLE sensor."); return; }
  }
  Serial.println("\n===== BLE SERVICES / CHARACTERISTICS =====");
  std::map<std::string, BLERemoteService*>* services = pClient->getServices();
  if (services == nullptr || services->empty()) { Serial.println("No BLE services found."); return; }
  for (auto const& servicePair : *services) {
    serviceTasks();
    BLERemoteService* service = servicePair.second;
    if (service == nullptr) continue;
    Serial.print("SERVICE: "); Serial.println(service->getUUID().toString().c_str());
    std::map<std::string, BLERemoteCharacteristic*>* chars = service->getCharacteristics();
    if (chars == nullptr || chars->empty()) { Serial.println("  No characteristics found."); continue; }
    for (auto const& charPair : *chars) {
      serviceTasks();
      BLERemoteCharacteristic* ch = charPair.second;
      if (ch == nullptr) continue;
      Serial.print("  CHAR: "); Serial.print(ch->getUUID().toString().c_str());
      Serial.print(" | read="); Serial.print(ch->canRead() ? "Y" : "N");
      Serial.print(" write="); Serial.print(ch->canWrite() ? "Y" : "N");
      Serial.print(" writeNoResp="); Serial.print(ch->canWriteNoResponse() ? "Y" : "N");
      Serial.print(" notify="); Serial.print(ch->canNotify() ? "Y" : "N");
      Serial.print(" indicate="); Serial.println(ch->canIndicate() ? "Y" : "N");
    }
  }
  Serial.println("==========================================\n");
}

void printStatus() {
  Serial.println("===== POOL LOGGER STATUS =====");
  Serial.print("Device ID: "); Serial.println(DEVICE_ID);
  Serial.print("Firmware: "); Serial.println(FIRMWARE_VERSION);
  Serial.print("Paired BLE MAC: "); Serial.println(pairedSensorMac);
  Serial.print("HTTP OTA enabled: "); Serial.println(ENABLE_HTTP_OTA ? "yes" : "no");
  Serial.print("Firmware update mode: "); Serial.println(otaMaintenanceMode ? "yes" : "no");
  Serial.print("BLE status: "); Serial.println(currentBleStatus);
  Serial.print("Uptime ms: "); Serial.println(millis());
  Serial.print("WiFi: "); Serial.println(WiFi.status() == WL_CONNECTED ? "connected" : "not connected");
  if (WiFi.status() == WL_CONNECTED) { Serial.print("WiFi IP: "); Serial.println(WiFi.localIP()); Serial.print("WiFi RSSI: "); Serial.println(WiFi.RSSI()); }
  Serial.print("BLE RSSI: "); Serial.println(lastBleRssi);
  Serial.print("Battery: "); if (batteryPct >= 0.0f) { Serial.print(batteryPct, 1); Serial.println("%"); } else Serial.println("N/A");
  Serial.print("BLE connected: "); Serial.println((pClient && pClient->isConnected()) ? "yes" : "no");
  Serial.print("Temperature decode: decoded["); Serial.print(TEMP_PAIR_INDEX); Serial.print(".."); Serial.print(TEMP_PAIR_INDEX + 1); Serial.println("] / 10.0");
  Serial.print("Calibration temp offset: "); Serial.println(TEMP_OFFSET_C);
  Serial.print("pH decode: ");
  Serial.print("decoded[");
  Serial.print(PH_PAIR_INDEX);
  Serial.print("..");
  Serial.print(PH_PAIR_INDEX + 1);
  Serial.println("] /100 + PH_OFFSET");
  Serial.println("==============================");
}

void handleNamedCommand(String cmd) {
  cmd.trim(); cmd.toUpperCase();
  if (cmd == "OTA" || cmd == "HTTPOTA") { performHttpOta(); return; }
  if (cmd == "PAIRS") { if (haveLastDecodedFrame) dumpDecodedYC01Pairs(lastDecodedFrame, lastDecodedLen); else Serial.println("No decoded frame yet. Wait for READ/NOTIFY first."); return; }
  if (cmd == "READ") { if (pChar && pChar->canRead()) { std::string value = pChar->readValue(); printFrame(value, "READ"); } else Serial.println("Cannot READ: pChar missing or not readable."); return; }
  if (cmd == "BAT") { if (pClient && pClient->isConnected()) { pChar = nullptr; pClient->disconnect(); delay(300); } scanBattery(); connectToSensor(); return; }
  if (cmd == "PAIR") { if (pClient && pClient->isConnected()) { pChar = nullptr; pClient->disconnect(); delay(300); } if (pairBleSensor()) { Serial.println("PAIR done. Reconnecting..."); connectToSensor(); } return; }
  if (cmd == "CLEARPAIR") { clearBlePairing(); Serial.println("BLE pairing cleared. Rebooting..."); delay(1000); ESP.restart(); }
  if (cmd == "CLEARWIFI") { clearWiFiConfig(); Serial.println("WiFi config cleared. Rebooting..."); delay(1000); ESP.restart(); }
  if (cmd == "DUMP") { dumpServices(); return; }
  if (cmd == "HEARTBEAT") { sendHeartbeat(currentBleStatus, true); return; }
  if (cmd == "STATUS") { printStatus(); return; }
  if (cmd == "REBOOT") { Serial.println("Rebooting..."); delay(500); ESP.restart(); }
  if (cmd == "HELP") {
    Serial.println("Commands: READ, PAIRS, BAT, STATUS, HEARTBEAT, HTTPOTA, PAIR, CLEARPAIR, DUMP, CLEARWIFI, REBOOT, or raw hex like 55 AA");
    return;
  }
  uint8_t raw[32]; size_t len = 0;
  if (parseHexLine(cmd, raw, len, sizeof(raw))) sendRawCommand(raw, len);
  else Serial.println("Unknown command.");
}

void handleSerialCommands() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      serialLine.trim();
      if (serialLine.length() > 0) { handleNamedCommand(serialLine); serialLine = ""; }
    } else serialLine += c;
  }
}

// ===================== SETUP / LOOP =====================

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n================================");
  Serial.println("BLE-YC01 Pool Logger Gateway");
  Serial.print("Firmware: "); Serial.println(FIRMWARE_VERSION);
  Serial.print("Temp decode: decoded["); Serial.print(TEMP_PAIR_INDEX); Serial.print(".."); Serial.print(TEMP_PAIR_INDEX + 1); Serial.println("] / 10.0");
  Serial.print("Temp offset: "); Serial.println(TEMP_OFFSET_C);
  Serial.print("API URL: "); Serial.println(API_URL);
  Serial.print("Heartbeat URL: "); Serial.println(HEARTBEAT_URL);
  Serial.println("================================");

  EEPROM.begin(EEPROM_SIZE);
  applyPairedSensorMac();
  setBleStatus("booting");

  // IMPORTANT ESP32 coexistence fix:
  // Start BLE before WiFi, and keep WiFi modem sleep ON while BLE is active.
  ensureBleInitialized();

  bool wifiOk = connectWiFiFromEEPROM();

  if (!wifiOk) {
    startSetupAP();
  } else {
    registerWebRoutes();
    beginWebServerOnce();
    sendHeartbeat("esp_online_booted", true);
  }

  serviceTasks();

  if (!otaMaintenanceMode) {
    scanBattery();
    lastBatteryScan = millis();
    serviceTasks();
    if (connectToSensor()) sendSensorTrigger();
    else sendHeartbeat(currentBleStatus, true);
  }

  Serial.println("Pool logger ready.");
  Serial.println("Commands: READ, PAIRS, BAT, PAIR, CLEARPAIR, STATUS, HEARTBEAT, HTTPOTA, DUMP, HELP, CLEARWIFI, REBOOT, or raw hex like 55 AA");
}

void loop() {
  serviceTasks();
  handleSerialCommands();
  serviceTasks();

  sendHeartbeat(currentBleStatus, false);

  if (millis() - lastBatteryScan > BATTERY_SCAN_INTERVAL_MS) {
    lastBatteryScan = millis();
    if (pClient && pClient->isConnected()) { pChar = nullptr; pClient->disconnect(); delay(300); serviceTasks(); }
    scanBattery();
    connectToSensor();
  }

  serviceTasks();

  if (millis() - lastTrigger > SENSOR_TRIGGER_INTERVAL_MS) {
    lastTrigger = millis();
    if (pClient != nullptr && pClient->isConnected() && pChar != nullptr && pChar->canWrite()) sendSensorTrigger();
    else {
      Serial.println("BLE not connected. Reconnecting...");
      if (connectToSensor()) sendSensorTrigger();
    }
  }

  serviceTasks();
}