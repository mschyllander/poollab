from __future__ import annotations

import os
import sqlite3
import time
from pathlib import Path
from typing import Any, Optional

from fastapi import Body, FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

APP_VERSION = "pool-backend-1.1.50-chlorine-diagnostics"

DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
DB_FILE = Path(os.getenv("DB_FILE", str(DATA_DIR / "pool_logger.db")))
DATA_DIR.mkdir(parents=True, exist_ok=True)

# Keep only the newest N measurements so the Synology database does not grow forever.
# Override with environment variable POOL_MAX_MEASUREMENTS if needed.
MAX_MEASUREMENTS = int(os.getenv("POOL_MAX_MEASUREMENTS", "10000"))

# Safety: keep database/history when the Docker container restarts.
# Change to True only if you intentionally want to wipe all measurements on backend startup.
CLEAR_DB_ON_START = False

app = FastAPI(title="Mr Matzos PoolLab API", version=APP_VERSION, docs_url="/swagger")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

pool_heartbeat: dict[str, Any] = {}


def now_unix() -> int:
    return int(time.time())


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn


def row_to_dict(row: sqlite3.Row | None) -> Optional[dict[str, Any]]:
    return dict(row) if row is not None else None


def column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(row["name"] == column for row in rows)


def add_column_if_missing(conn: sqlite3.Connection, table: str, column: str, col_type: str) -> None:
    if not column_exists(conn, table, column):
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}")


def cleanup_old_measurements(conn: sqlite3.Connection) -> None:
    """Keep only the newest MAX_MEASUREMENTS rows."""
    if MAX_MEASUREMENTS <= 0:
        return

    conn.execute(
        """
        DELETE FROM pool_measurements
        WHERE id NOT IN (
            SELECT id
            FROM pool_measurements
            ORDER BY ts_unix DESC, id DESC
            LIMIT ?
        )
        """,
        (MAX_MEASUREMENTS,),
    )


def init_db() -> None:
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS pool_measurements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                ts_unix INTEGER NOT NULL,
                uptime_ms INTEGER,
                temp_c REAL,
                ph REAL,
                orp_mv REAL,
                cl_mg_l REAL,
                raw_temp_c REAL,
                raw_ph REAL,
                raw_orp_mv REAL,
                raw_cl_mg_l REAL,
                cl_est_mg_l REAL,
                chlorine_valid INTEGER,
                chlorine_status TEXT,
                filter_status TEXT,
                battery_pct REAL,
                wifi_rssi_dbm INTEGER,
                ble_rssi_dbm INTEGER,
                firmware_version TEXT,
                ble_sensor_mac TEXT,
                raw_hex TEXT
            )
            """
        )

        add_column_if_missing(conn, "pool_measurements", "uptime_ms", "INTEGER")
        add_column_if_missing(conn, "pool_measurements", "firmware_version", "TEXT")
        add_column_if_missing(conn, "pool_measurements", "ble_sensor_mac", "TEXT")
        add_column_if_missing(conn, "pool_measurements", "raw_hex", "TEXT")
        add_column_if_missing(conn, "pool_measurements", "raw_temp_c", "REAL")
        add_column_if_missing(conn, "pool_measurements", "raw_ph", "REAL")
        add_column_if_missing(conn, "pool_measurements", "raw_orp_mv", "REAL")
        add_column_if_missing(conn, "pool_measurements", "raw_cl_mg_l", "REAL")
        add_column_if_missing(conn, "pool_measurements", "cl_est_mg_l", "REAL")
        add_column_if_missing(conn, "pool_measurements", "chlorine_valid", "INTEGER")
        add_column_if_missing(conn, "pool_measurements", "chlorine_status", "TEXT")
        add_column_if_missing(conn, "pool_measurements", "filter_status", "TEXT")

        conn.execute("CREATE INDEX IF NOT EXISTS idx_pool_measurements_ts ON pool_measurements(ts_unix)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_pool_measurements_device ON pool_measurements(device_id)")

        if CLEAR_DB_ON_START:
            conn.execute("DELETE FROM pool_measurements")

        cleanup_old_measurements(conn)
        conn.commit()


class PoolMeasurementIn(BaseModel):
    device_id: str = Field(default="pool-esp32-01")
    uptime_ms: Optional[int] = None
    temp_c: Optional[float] = None
    ph: Optional[float] = None
    orp_mv: Optional[float] = None
    cl_mg_l: Optional[float] = None

    # Optional raw values. Firmware may omit these; backend stays backward compatible.
    # temp_c/ph/orp_mv/cl_mg_l are the stabilized dashboard values.
    raw_temp_c: Optional[float] = None
    raw_ph: Optional[float] = None
    raw_orp_mv: Optional[float] = None
    raw_cl_mg_l: Optional[float] = None
    cl_est_mg_l: Optional[float] = None
    chlorine_valid: Optional[bool] = None
    chlorine_status: Optional[str] = None
    filter_status: Optional[str] = Field(default="smoothed")

    battery_pct: Optional[float] = None
    wifi_rssi_dbm: Optional[int] = None
    ble_rssi_dbm: Optional[int] = None
    firmware_version: Optional[str] = None
    ble_sensor_mac: Optional[str] = None
    raw_hex: Optional[str] = None


class PoolHeartbeatIn(BaseModel):
    device_id: str = Field(default="pool-esp32-01")
    firmware_version: Optional[str] = None
    uptime_ms: Optional[int] = None
    wifi_connected: Optional[bool] = None
    wifi_rssi_dbm: Optional[int] = None
    ble_status: Optional[str] = "unknown"
    ble_connected: Optional[bool] = None
    ble_rssi_dbm: Optional[int] = None
    ble_sensor_mac: Optional[str] = None
    battery_pct: Optional[float] = None
    ota_maintenance_mode: Optional[bool] = None


@app.on_event("startup")
def startup() -> None:
    init_db()


@app.get("/")
def root() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "Mr Matzos PoolLab API",
        "backend_version": APP_VERSION,
        "db_file": str(DB_FILE),
        "max_measurements": MAX_MEASUREMENTS,
        "clear_db_on_start": CLEAR_DB_ON_START,
    }


@app.get("/api/pool/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "backend_version": APP_VERSION,
        "db_file": str(DB_FILE),
        "max_measurements": MAX_MEASUREMENTS,
        "clear_db_on_start": CLEAR_DB_ON_START,
    }


@app.post("/api/pool/heartbeat")
def pool_heartbeat_post(payload: PoolHeartbeatIn = Body(...)) -> dict[str, Any]:
    ts = now_unix()
    pool_heartbeat.clear()
    pool_heartbeat.update(
        {
            "ok": True,
            "device_id": payload.device_id,
            "firmware_version": payload.firmware_version,
            "uptime_ms": payload.uptime_ms,
            "wifi_connected": payload.wifi_connected,
            "wifi_rssi_dbm": payload.wifi_rssi_dbm,
            "ble_status": payload.ble_status or "unknown",
            "ble_connected": payload.ble_connected,
            "ble_rssi_dbm": payload.ble_rssi_dbm,
            "ble_sensor_mac": payload.ble_sensor_mac,
            "battery_pct": payload.battery_pct,
            "ota_maintenance_mode": payload.ota_maintenance_mode,
            "last_heartbeat_unix": ts,
        }
    )
    return {"ok": True, "backend_version": APP_VERSION, "heartbeat": pool_heartbeat}


@app.get("/api/pool/heartbeat")
def pool_heartbeat_get() -> dict[str, Any]:
    age = now_unix() - pool_heartbeat.get("last_heartbeat_unix", 0) if pool_heartbeat else None
    return {
        "ok": bool(pool_heartbeat),
        "backend_version": APP_VERSION,
        "heartbeat": pool_heartbeat,
        "heartbeat_age_seconds": age,
    }


@app.post("/api/pool/measurements")
def create_measurement(payload: PoolMeasurementIn = Body(...)) -> dict[str, Any]:
    ts = now_unix()

    with get_db() as conn:
        cur = conn.execute(
            """
            INSERT INTO pool_measurements (
                device_id, ts_unix, uptime_ms, temp_c, ph, orp_mv, cl_mg_l,
                raw_temp_c, raw_ph, raw_orp_mv, raw_cl_mg_l,
                cl_est_mg_l, chlorine_valid, chlorine_status, filter_status,
                battery_pct, wifi_rssi_dbm, ble_rssi_dbm, firmware_version,
                ble_sensor_mac, raw_hex
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                payload.device_id,
                ts,
                payload.uptime_ms,
                payload.temp_c,
                payload.ph,
                payload.orp_mv,
                payload.cl_mg_l,
                payload.raw_temp_c,
                payload.raw_ph,
                payload.raw_orp_mv,
                payload.raw_cl_mg_l,
                payload.cl_est_mg_l,
                None if payload.chlorine_valid is None else int(payload.chlorine_valid),
                payload.chlorine_status,
                payload.filter_status or "smoothed",
                payload.battery_pct,
                payload.wifi_rssi_dbm,
                payload.ble_rssi_dbm,
                payload.firmware_version,
                payload.ble_sensor_mac,
                payload.raw_hex,
            ),
        )

        mid = cur.lastrowid
        cleanup_old_measurements(conn)
        conn.commit()

    pool_heartbeat.clear()
    pool_heartbeat.update(
        {
            "ok": True,
            "device_id": payload.device_id,
            "firmware_version": payload.firmware_version,
            "uptime_ms": payload.uptime_ms,
            "wifi_connected": True,
            "wifi_rssi_dbm": payload.wifi_rssi_dbm,
            "ble_status": "ble_ok_measurement_received",
            "ble_connected": True,
            "ble_rssi_dbm": payload.ble_rssi_dbm,
            "ble_sensor_mac": payload.ble_sensor_mac,
            "battery_pct": payload.battery_pct,
            "ota_maintenance_mode": False,
            "last_heartbeat_unix": ts,
        }
    )

    return {
        "ok": True,
        "id": mid,
        "ts_unix": ts,
        "backend_version": APP_VERSION,
        "filter_status": payload.filter_status or "smoothed",
        "max_measurements": MAX_MEASUREMENTS,
    }


@app.get("/api/pool/latest")
def latest_measurement() -> dict[str, Any]:
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM pool_measurements ORDER BY ts_unix DESC, id DESC LIMIT 1"
        ).fetchone()

    latest = row_to_dict(row)
    if not latest:
        return {"ok": False, "backend_version": APP_VERSION, "message": "No measurements yet"}

    latest["ok"] = True
    latest["backend_version"] = APP_VERSION
    latest["filter_status"] = latest.get("filter_status") or "smoothed"
    latest["last_seen_seconds_ago"] = now_unix() - int(latest.get("ts_unix") or now_unix())
    return latest


@app.get("/api/pool/history")
def history(
    range: str = Query("day", pattern="^(day|week|month)$"),
    limit: int = Query(2000, ge=1, le=10000),
) -> dict[str, Any]:
    seconds = {"day": 24 * 3600, "week": 7 * 24 * 3600, "month": 31 * 24 * 3600}[range]
    since = now_unix() - seconds

    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM pool_measurements WHERE ts_unix >= ? ORDER BY ts_unix ASC LIMIT ?",
            (since, limit),
        ).fetchall()

    return {
        "ok": True,
        "backend_version": APP_VERSION,
        "range": range,
        "data": [dict(r) for r in rows],
    }


@app.get("/api/pool/state")
def pool_state() -> dict[str, Any]:
    with get_db() as conn:
        latest_row = conn.execute(
            "SELECT * FROM pool_measurements ORDER BY ts_unix DESC, id DESC LIMIT 1"
        ).fetchone()
        count = conn.execute("SELECT COUNT(*) AS c FROM pool_measurements").fetchone()["c"]

    latest = row_to_dict(latest_row)
    latest_age = now_unix() - int(latest["ts_unix"]) if latest and latest.get("ts_unix") else None
    heartbeat_age = now_unix() - pool_heartbeat.get("last_heartbeat_unix", 0) if pool_heartbeat else None

    return {
        "ok": True,
        "backend_version": APP_VERSION,
        "measurement_count": count,
        "max_measurements": MAX_MEASUREMENTS,
        "clear_db_on_start": CLEAR_DB_ON_START,
        "latest": latest,
        "last_seen_seconds_ago": latest_age,
        "heartbeat": pool_heartbeat,
        "heartbeat_age_seconds": heartbeat_age,
    }


@app.delete("/api/pool/measurements")
def clear_measurements() -> dict[str, Any]:
    with get_db() as conn:
        conn.execute("DELETE FROM pool_measurements")
        conn.commit()

    return {"ok": True, "message": "pool measurements cleared", "backend_version": APP_VERSION}
