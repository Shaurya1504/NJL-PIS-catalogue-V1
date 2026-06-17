"""
NJL Product Catalogue — FastAPI Server
=======================================
Reads BOM_Enriched parquet (new schema).
Column mapping from old → new:
  ITEMNUMBER          → ITEMID_SNQ
  DESIGNTHEME         → THEME CODE
  ITEMNUMBER Image    → ITEMID_SNQ URL
  IS Set              → Is set   (note trailing space in file)
  Set code            → Set Code
  Set colleague N     → Set collegue N  (typo in source data)
  Set colleague N Img → Set collegue N URL
  PWC_PRODUCTGROUP    → (removed — not in new file)
  COLLECTIONCODE      → COLLECTIONCODE (same)
  + new cols: DESIGNNUMBER, PRODUCTIONSTATUS, PWC_DESIGNPURITY, SERIALNUMBER, THEME CODE
BOM structure (new):
  Each row = one BOM ingredient line for one serial instance.
  ITEMID_SNQ = parent SKU, ITEMID_BOM = ingredient, QTY = qty, INVENTUNIT = unit.
  All rows from the parquet are preserved as-is in sku_global (no SKU deduplication).
  BOM lines are de-duped on (ITEMID_SNQ, ITEMID_BOM) for display only.
"""

import os, math, time, socket, logging, threading
import numpy as np
import pandas as pd
import uvicorn
from fastapi import FastAPI, Query, HTTPException, Request
from fastapi.responses import HTMLResponse, FileResponse, Response, JSONResponse
from fastapi.middleware.cors import CORSMiddleware

# ─── Logging ────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(levelname)s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("njl")

# ─── Config ─────────────────────────────────────────────────────────────────
BASE_DIR      = os.path.dirname(os.path.abspath(__file__))
HTML_FILE     = os.path.join(BASE_DIR, "index.html")

# Azure Blob URLs — override via env vars if needed
PARQUET_BLOB_URL = os.environ.get(
    "PARQUET_BLOB_URL",
    "https://njlprodimages.blob.core.windows.net/protopisfolder/BOM_Enriched_Latest_Transdate.parquet"
)
AUTH_BLOB_URL = os.environ.get(
    "AUTH_BLOB_URL",
    "https://njlprodimages.blob.core.windows.net/protopisfolder/auth.xlsx"
)

# Local fallbacks (used only when running offline / in development)
LOCAL_PARQUET = os.path.join(BASE_DIR, "BOM_Enriched_Latest_Transdate.parquet")
LOCAL_AUTH    = os.path.join(BASE_DIR, "auth.xlsx")

PORT = int(os.environ.get("PORT", 8000))
HOST = "0.0.0.0"

# ─── Auth ─────────────────────────────────────────────────────────────────────
_auth_lock = threading.Lock()
_auth_map: dict = {}   # username_lower → password (case-sensitive pwd, case-insensitive user)

def load_auth():
    global _auth_map
    import httpx, tempfile

    auth_path = None

    # Try Azure Blob first
    if AUTH_BLOB_URL.startswith("http"):
        try:
            log.info(f"[auth] Downloading auth.xlsx from {AUTH_BLOB_URL} …")
            with httpx.Client(timeout=30) as client:
                r = client.get(AUTH_BLOB_URL)
                r.raise_for_status()
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".xlsx")
            tmp.write(r.content)
            tmp.close()
            auth_path = tmp.name
            log.info("[auth] auth.xlsx downloaded from Azure Blob")
        except Exception as exc:
            log.warning(f"[auth] Azure Blob fetch failed ({exc}) — falling back to local file")

    # Fall back to local file
    if auth_path is None:
        if os.path.exists(LOCAL_AUTH):
            auth_path = LOCAL_AUTH
            log.info(f"[auth] Using local auth.xlsx at {LOCAL_AUTH}")
        else:
            log.warning("[auth] auth.xlsx not found — auth disabled")
            return

    df = pd.read_excel(auth_path, engine="openpyxl")
    # Expect columns: Username, Password (case-insensitive header match)
    df.columns = [c.strip().lower() for c in df.columns]
    if "username" not in df.columns or "password" not in df.columns:
        log.error("[auth] auth.xlsx must have 'Username' and 'Password' columns")
        return
    m = {}
    for _, row in df.iterrows():
        u = str(row["username"]).strip()
        p = str(row["password"]).strip()
        if u and p:
            m[u.lower()] = p
    with _auth_lock:
        _auth_map = m
    log.info(f"[auth] Loaded {len(m)} user(s) from auth.xlsx")

# ─── Global state ────────────────────────────────────────────────────────────
_lock = threading.Lock()
df_global:   pd.DataFrame = None   # raw enriched BOM (all rows, de-duped per SKU+ingredient)
sku_global:  pd.DataFrame = None   # one row per SKU (for catalogue cards)
bom_global:  pd.DataFrame = None   # de-duped BOM lines (ITEMID_SNQ × ITEMID_BOM)
TOTAL_SKUS:  int = 0
ROW_TEXT_CACHE = None


def _safe_str(series):
    """Coerce a series to clean string — no trailing .0 on whole floats, NaN → ''."""
    if series.dtype == bool or str(series.dtype) == "bool":
        return series.astype(str).fillna("")
    if pd.api.types.is_float_dtype(series):
        non_null = series.dropna()
        if len(non_null) == 0 or (non_null == non_null.round()).all():
            return (series.fillna(-1)
                          .astype("Int64")
                          .astype(str)
                          .replace("-1", "")
                          .replace("<NA>", ""))
    return series.fillna("").astype(str).replace("nan", "").replace("NA", "")


# ─── Data Loader ─────────────────────────────────────────────────────────────
def load_data():
    global df_global, sku_global, bom_global, TOTAL_SKUS, ROW_TEXT_CACHE

    parquet_path = PARQUET_BLOB_URL

    # Support Azure Blob URL via httpx
    if parquet_path.startswith("http"):
        import httpx, tempfile
        log.info(f"[data] Downloading parquet from {parquet_path} …")
        with httpx.Client(timeout=120) as client:
            r = client.get(parquet_path)
            r.raise_for_status()
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".parquet")
        tmp.write(r.content)
        tmp.close()
        parquet_path = tmp.name
    elif not os.path.exists(parquet_path):
        # Fall back to local file
        if os.path.exists(LOCAL_PARQUET):
            parquet_path = LOCAL_PARQUET
            log.info(f"[data] Using local parquet at {LOCAL_PARQUET}")
        else:
            raise RuntimeError(f"Parquet not found: {parquet_path}")

    log.info(f"[data] Reading {parquet_path} …")
    df = pd.read_parquet(parquet_path)
    log.info(f"[data] {len(df):,} rows, {df['ITEMID_SNQ'].nunique():,} unique SKUs")

    # ── De-dup BOM: keep first occurrence per (ITEMID_SNQ, ITEMID_BOM) ──
    # QTY varies by serial instance — we pick the first serial's qty per design.
    bom_cols = ["ITEMID_SNQ", "ITEMID_BOM", "QTY", "INVENTUNIT"]
    if "INGREDIENT_DESCRIPTION" in df.columns:
        bom_cols.append("INGREDIENT_DESCRIPTION")
    if "PDSCWQTY" in df.columns:
        bom_cols.append("PDSCWQTY")
    bom_df = (df[bom_cols]
                .drop_duplicates(subset=["ITEMID_SNQ", "ITEMID_BOM"])
                .reset_index(drop=True))
    bom_df["QTY"] = pd.to_numeric(bom_df["QTY"], errors="coerce").fillna(0.0)
    if "PDSCWQTY" in bom_df.columns:
        bom_df["PDSCWQTY"] = pd.to_numeric(bom_df["PDSCWQTY"], errors="coerce").fillna(0.0)

    # ── De-dup SKUs: keep first row per ITEMID_SNQ for catalogue cards ──
    # The parquet has one row per BOM ingredient line, so each SKU appears N times
    # (once per BOM component). We keep the first occurrence for card metadata;
    # all BOM lines are preserved separately in bom_df for the expand/PIS modal.
    sku_df = df.drop_duplicates(subset=["ITEMID_SNQ"], keep="first").reset_index(drop=True)

    # ── Weight derivation (domain-correct jewellery logic) ────────────────────
    # Raw metal prefixes: GRG = Gold Raw, PRG = Platinum Raw, SRG = Silver Raw, CRX = Copper Raw
    # NET WT  = sum of raw metal GMS lines only  → pure metal weight of finished piece
    # GROSS WT = NET WT + stone weight (CTS lines × 0.2 g/ct) → total piece weight incl. diamonds
    _RAW_METAL_PFX = {"GRG", "PRG", "SRG", "CRX"}
    bom_df["_unit_up"]  = bom_df["INVENTUNIT"].str.strip().str.upper()
    bom_df["_pfx"]      = bom_df["ITEMID_BOM"].str[:3].str.upper()

    gms_raw  = bom_df[(bom_df["_unit_up"] == "GMS") & (bom_df["_pfx"].isin(_RAW_METAL_PFX))]
    cts_lines = bom_df[bom_df["_unit_up"] == "CTS"]

    net_wt    = gms_raw.groupby("ITEMID_SNQ")["QTY"].sum().rename("NET_WEIGHT")
    stone_wt  = (cts_lines.groupby("ITEMID_SNQ")["QTY"].sum() * 0.2)
    gross_wt  = net_wt.add(stone_wt, fill_value=0).rename("GROSS_WEIGHT")

    # Drop helper columns
    bom_df.drop(columns=["_unit_up", "_pfx"], inplace=True)

    sku_df = sku_df.join(gross_wt, on="ITEMID_SNQ").join(net_wt, on="ITEMID_SNQ")

    # ── Numeric cols ──
    num_cols = ["GROSS_WEIGHT", "NET_WEIGHT"]
    for c in num_cols:
        if c in sku_df.columns:
            sku_df[c] = pd.to_numeric(sku_df[c], errors="coerce").fillna(0.0)

    # ── Stringify all other columns (no .0 artefacts) ──
    str_cols = [c for c in sku_df.columns if c not in num_cols]
    for c in str_cols:
        sku_df[c] = _safe_str(sku_df[c])

    # ── Search text cache ──
    search_fields = [
        "ITEMID_SNQ", "THEME CODE", "PRODUCTSUBNAME", "PRODUCTTYPECODE",
        "METALPURITY", "METALTYPE", "PWC_METALCOLOR", "PWC_GENDER",
        "PWC_SUBPRODUCTGROUP", "WORKSTYLECODE", "FINISHTYPECODE", "FINISH",
        "COLLECTIONCODE", "DESIGNSOURCE", "PWC_DESIGNMOTIF", "PWC_OCCASION",
        "PRIMARYDESIGNLANGUAGE", "PRIMARYVENDORACCOUNTNUMBER", "VENDORITEMID",
        "PWC_DESIGNPURITY", "DESIGNNUMBER", "PRODUCTIONSTATUS",
        "ALTERNATE_ACTIVE_SKU",
    ]
    present = [c for c in search_fields if c in sku_df.columns]
    txt = sku_df[present[0]].str.lower()
    for c in present[1:]:
        txt = txt + " " + sku_df[c].str.lower()

    with _lock:
        df_global      = df
        sku_global     = sku_df
        bom_global     = bom_df
        TOTAL_SKUS     = len(sku_df)
        ROW_TEXT_CACHE = txt.reset_index(drop=True)

    log.info(f"[data] Loaded OK — {TOTAL_SKUS:,} unique SKUs (deduplicated from {len(df):,} BOM rows), {len(bom_df):,} BOM lines")



# ─── FastAPI ─────────────────────────────────────────────────────────────────
app = FastAPI(title="NJL Catalogue", version="4.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ─── Startup ─────────────────────────────────────────────────────────────────
@app.on_event("startup")
def startup_event():
    load_auth()
    load_data()


# ─── Static files ────────────────────────────────────────────────────────────
@app.get("/", response_class=HTMLResponse)
def serve_index():
    if not os.path.exists(HTML_FILE):
        return HTMLResponse("<h2>index.html not found</h2>", status_code=404)
    return open(HTML_FILE, encoding="utf-8").read()

@app.get("/style.css")
def serve_css():
    p = os.path.join(BASE_DIR, "style.css")
    return FileResponse(p, media_type="text/css") if os.path.exists(p) else Response(status_code=404)

@app.get("/script.js")
def serve_js():
    p = os.path.join(BASE_DIR, "script.js")
    return FileResponse(p, media_type="application/javascript") if os.path.exists(p) else Response(status_code=404)

@app.get("/logo.png")
def serve_logo():
    p = os.path.join(BASE_DIR, "logo.png")
    return FileResponse(p, media_type="image/png") if os.path.exists(p) else Response(status_code=204)

@app.get("/favicon.ico")
def serve_favicon():
    p = os.path.join(BASE_DIR, "favicon.ico")
    return FileResponse(p, media_type="image/x-icon") if os.path.exists(p) else Response(status_code=204)


# ─── Health ──────────────────────────────────────────────────────────────────
@app.get("/api/health")
def health():
    with _lock: ready = sku_global is not None
    return {"status": "ok" if ready else "loading", "total_skus": TOTAL_SKUS}

@app.get("/api/stats")
def stats():
    return {"total_skus": TOTAL_SKUS}


# ─── Auth endpoint ────────────────────────────────────────────────────────────
from pydantic import BaseModel

class LoginRequest(BaseModel):
    username: str
    password: str

@app.post("/api/auth/login")
def login(req: LoginRequest):
    with _auth_lock:
        stored_pwd = _auth_map.get(req.username.strip().lower())
    if stored_pwd is None or stored_pwd != req.password.strip():
        raise HTTPException(status_code=401, detail="Invalid username or password")
    return {"success": True, "username": req.username.strip()}


# ─── Image proxy ─────────────────────────────────────────────────────────────
@app.get("/api/proxy-image")
async def proxy_image(url: str = Query(...)):
    """Fetch external image server-side to bypass CORS for PDF embedding."""
    import httpx
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "Only http/https URLs are allowed")
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
            r = await client.get(url, headers={"User-Agent": "NJL-Catalogue/2.0"})
        ct = r.headers.get("content-type", "image/jpeg")
        return Response(content=r.content, media_type=ct)
    except Exception as exc:
        log.warning(f"[proxy-image] failed for {url!r}: {exc}")
        raise HTTPException(502, "Could not fetch image")


# ─── Filter values ───────────────────────────────────────────────────────────
# Columns available in new schema for sidebar filters
# Note: "Is set " has a trailing space — we expose it as "Is set" to the API
FILTER_COLS = [
    "PRODUCTIONSTATUS", "PWC_GENDER", "PWC_SUBPRODUCTGROUP",
    "WORKSTYLECODE", "Is set ",
]

@app.get("/api/filter-values")
def filter_values():
    with _lock: df = sku_global
    if df is None: return {}
    out = {}
    for col in FILTER_COLS:
        if col not in df.columns: continue
        # Expose "Is set " as "Is set" in the JSON key for clean API surface
        api_key = col.strip()
        vals = sorted(v for v in df[col].unique()
                      if v and v.strip() and v not in ("nan", "None", "-1", "<NA>", "NA", ""))
        if vals:
            out[api_key] = vals
    return out


# ─── Catalogue ───────────────────────────────────────────────────────────────
def _apply_filters(df, txt, q, filters):
    import re as _re
    if q.strip():
        terms = [t.lower() for t in _re.split(r"[\s,]+", q.strip()) if t.strip()]
        for term in terms:
            mask = txt.reset_index(drop=True).str.contains(term, na=False, regex=False)
            df   = df[mask.values].reset_index(drop=True)
            txt  = txt[mask.values].reset_index(drop=True)
    for col, val_str in filters.items():
        if not val_str.strip(): continue
        # Map clean API key back to actual col name (handles "Is set" → "Is set ")
        actual_col = col
        if col not in df.columns:
            # Try with trailing space
            if col + " " in df.columns:
                actual_col = col + " "
            else:
                continue
        vals   = {v.strip() for v in val_str.split("|") if v.strip()}
        df     = df[df[actual_col].isin(vals)].reset_index(drop=True)
        txt    = txt.iloc[:len(df)].reset_index(drop=True) if hasattr(txt, "iloc") else txt
        # Re-align txt after filtering
        txt = pd.Series(
            ROW_TEXT_CACHE.iloc[df.index.tolist()].values if hasattr(df.index, 'tolist') else []
        ).reset_index(drop=True)
    return df

def _apply_filters_v2(df_in, txt_in, q, filters):
    """Filter on the sku_global directly, returning filtered sub-df."""
    import re as _re
    df  = df_in.copy()
    txt = txt_in.copy()

    if q.strip():
        terms = [t.lower() for t in _re.split(r"[\s,]+", q.strip()) if t.strip()]
        for term in terms:
            mask = txt.str.contains(term, na=False, regex=False)
            df   = df[mask.values].reset_index(drop=True)
            txt  = txt[mask.values].reset_index(drop=True)

    for col, val_str in filters.items():
        if not val_str.strip(): continue
        actual_col = col
        if col not in df.columns:
            if col + " " in df.columns:
                actual_col = col + " "
            else:
                log.warning(f"[filter] column {col!r} not found — skipping")
                continue
        vals = {v.strip() for v in val_str.split("|") if v.strip()}
        mask = df[actual_col].isin(vals)
        df   = df[mask].reset_index(drop=True)
        txt  = txt[mask.values].reset_index(drop=True)

    return df


@app.get("/api/catalogue")
def catalogue(
    request: Request,
    page:      int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    q:         str = Query(""),
    PRODUCTIONSTATUS:           str = Query(""),
    PWC_GENDER:                 str = Query(""),
    PWC_SUBPRODUCTGROUP:        str = Query(""),
    WORKSTYLECODE:              str = Query(""),
    Is_set:                     str = Query("", alias="Is set"),
):
    with _lock:
        df  = sku_global
        txt = ROW_TEXT_CACHE.copy() if ROW_TEXT_CACHE is not None else None

    if df is None: raise HTTPException(503, "Data loading")

    filters = {
        "PRODUCTIONSTATUS": PRODUCTIONSTATUS,
        "PWC_GENDER": PWC_GENDER,
        "PWC_SUBPRODUCTGROUP": PWC_SUBPRODUCTGROUP,
        "WORKSTYLECODE": WORKSTYLECODE,
        "Is set": Is_set,
    }

    df    = _apply_filters_v2(df.reset_index(drop=True), txt.reset_index(drop=True), q, filters)
    total = len(df)
    start = (page - 1) * page_size
    page_df = df.iloc[start: start + page_size]

    card_cols = [
        "ITEMID_SNQ", "THEME CODE", "ITEMID_SNQ URL", "METALPURITY", "METALTYPE",
        "PWC_METALCOLOR", "PRODUCTSUBNAME", "GROSS_WEIGHT", "NET_WEIGHT",
        "PRODUCTTYPECODE", "PWC_GENDER", "PWC_ITEMSTAGE", "Is set ",
        "COLLECTIONCODE", "PWC_SUBPRODUCTGROUP", "WORKSTYLECODE",
        "PRODUCTIONSTATUS", "PWC_DESIGNPURITY",
    ]
    out_cols = [c for c in card_cols if c in page_df.columns]
    records  = page_df[out_cols].replace({np.nan: None, np.inf: None, -np.inf: None}).to_dict(orient="records")

    # Rename "Is set " → "Is set" in output so frontend key is clean
    for rec in records:
        if "Is set " in rec:
            rec["Is set"] = rec.pop("Is set ")

    return {
        "total_filtered": total,
        "total_skus":     TOTAL_SKUS,
        "page":           page,
        "page_size":      page_size,
        "total_pages":    math.ceil(total / page_size) if total else 0,
        "data":           records,
    }


# ─── SKU Detail ──────────────────────────────────────────────────────────────
def _build_sku_record(item_number: str):
    """Build complete SKU detail dict including BOM, for modal display."""
    with _lock:
        sku = sku_global
        bom = bom_global

    row = sku[sku["ITEMID_SNQ"] == item_number]
    if row.empty:
        return None

    rec = row.replace({np.nan: None, np.inf: None, -np.inf: None}).to_dict(orient="records")[0]
    # Clean up "Is set " key
    if "Is set " in rec:
        rec["Is set"] = rec.pop("Is set ")
    # Ensure ALTERNATE_ACTIVE_SKU is always present for the modal (may be empty)
    if "ALTERNATE_ACTIVE_SKU" not in rec:
        rec["ALTERNATE_ACTIVE_SKU"] = ""

    # BOM lines for this SKU
    bom_rows = bom[bom["ITEMID_SNQ"] == item_number].copy()
    bom_rows["QTY"] = pd.to_numeric(bom_rows["QTY"], errors="coerce").fillna(0.0)
    bom_out_cols = ["ITEMID_BOM", "QTY", "INVENTUNIT"]
    if "INGREDIENT_DESCRIPTION" in bom_rows.columns:
        bom_out_cols.append("INGREDIENT_DESCRIPTION")
    if "PDSCWQTY" in bom_rows.columns:
        bom_rows["PDSCWQTY"] = pd.to_numeric(bom_rows["PDSCWQTY"], errors="coerce").fillna(0.0)
        bom_out_cols.append("PDSCWQTY")
    rec["BOM"] = bom_rows[bom_out_cols].replace(
        {np.nan: None, np.inf: None, -np.inf: None}
    ).to_dict(orient="records")

    return rec


@app.get("/api/sku/{item_number}")
def sku_detail(item_number: str):
    if sku_global is None: raise HTTPException(503, "Data loading")
    rec = _build_sku_record(item_number)
    if rec is None: raise HTTPException(404, f"SKU {item_number} not found")
    return rec


@app.get("/api/skus")
def skus_detail(items: str = Query(...)):
    item_list = [i.strip() for i in items.split(",") if i.strip()]
    if sku_global is None: raise HTTPException(503, "Data loading")
    results = []
    for item_number in item_list:
        rec = _build_sku_record(item_number)
        if rec: results.append(rec)
    return results


# ─── Debug ───────────────────────────────────────────────────────────────────
@app.get("/api/debug-filter/{col}")
def debug_filter(col: str, val: str = Query("")):
    with _lock: df = sku_global
    if df is None: return {"error": "not loaded"}
    actual = col if col in df.columns else (col + " " if col + " " in df.columns else None)
    if not actual: return {"error": f"column {col!r} not found", "columns": list(df.columns)}
    unique_vals = list(df[actual].unique()[:50])
    result = {"column": actual, "dtype": str(df[actual].dtype), "sample_unique": unique_vals}
    if val:
        vals_set = {v.strip() for v in val.split("|")}
        matched  = int(df[actual].isin(vals_set).sum())
        result["test_val"] = val; result["vals_set"] = list(vals_set); result["matched_rows"] = matched
    return result


# ─── Local run ────────────────────────────────────────────────────────────────
def _free_port(start):
    for p in range(start, start + 20):
        with socket.socket() as s:
            try: s.bind(("", p)); return p
            except OSError: continue
    return start

if __name__ == "__main__":
    port = _free_port(PORT)
    log.info(f"[server] Starting on http://localhost:{port}")
    uvicorn.run("server:app", host=HOST, port=port, reload=False, log_level="info")