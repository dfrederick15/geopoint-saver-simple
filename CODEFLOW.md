# GeoPoint Saver Simple — Code Flow

A plain-English walkthrough of how the application works, from a file drop to a downloaded CSV.

---

## Project Structure

```
server.js        — Express server: all HTTP endpoints, session store, logging, admin pages
lib-parse.js     — KML/KMZ → flat row array (XML parsing, ZIP extraction)
lib-convert.js   — Row array → CSV / KML bytes, spatial filter logic
lib-zip.js       — In-memory ZIP writer (no dependencies)
app.js           — Browser JS: UI interactions, map, upload/download flow
index.html       — Single-page HTML shell
app.css          — Styles
worker.js        — Unused / legacy (safe to ignore)
zip.js           — Unused / legacy (safe to ignore)
```

---

## 1. Upload Flow (`POST /inspect`)

```
Browser                         server.js                    lib-parse.js
  │                                 │                              │
  │  POST /inspect                  │                              │
  │  multipart/form-data            │                              │
  │  (one or more .kml/.kmz files)  │                              │
  │────────────────────────────────>│                              │
  │                                 │  rate limiter (30/15 min)    │
  │                                 │  multer reads files to RAM   │
  │                                 │  validate extensions         │
  │                                 │                              │
  │                                 │  parseKmlBuffer(name, buf) ─>│
  │                                 │                              │ .kmz? unzip (lib-parse)
  │                                 │                              │   walk ZIP local headers
  │                                 │                              │   inflate DEFLATE entries
  │                                 │                              │   decode UTF-8
  │                                 │                              │
  │                                 │                              │ fast-xml-parser → JS tree
  │                                 │                              │ walkContainer()
  │                                 │                              │   Document → Folder → Placemark
  │                                 │                              │   extract ExtendedData fields
  │                                 │                              │   extract coordinates
  │                                 │                              │   one row per coordinate tuple
  │                                 │<─────────────────────────────│
  │                                 │  { rows[], fields[] }        │
  │                                 │                              │
  │                                 │  store in sessions Map       │
  │                                 │  (sessionId → rows, TTL 1h)  │
  │                                 │  writeLog(inspect)           │
  │                                 │                              │
  │<────────────────────────────────│                              │
  │  { sessionId, rows, fields,     │                              │
  │    layers }                     │                              │
```

**What a row looks like:**
```js
{
  source:        "buildings.kmz",
  layer:         "City / Addresses",
  geometry_type: "Point",
  placemark_id:  "pm_001",
  placemark_uid: "buildings.kmz\x00\x001",  // internal dedup key
  name:          "123 Main St",
  lat:           38.123456,
  lon:           -94.654321,
  alt:           null,
  // any ExtendedData fields:
  UNIT_COUNT:    "4",
  SPEED_TIER:    "1G",
}
```

---

## 2. What Happens in the Browser After Inspect

`app.js` receives the JSON response and:

1. **Stores rows** in memory for the session duration.
2. **Populates the field list** — checkboxes for every field key, sorted with standard fields first.
3. **Populates the layer tree** — collapsible by first path segment; address/household layers are auto-selected.
4. **Renders the map** — `updateMapMarkers()` plots up to 5,000 points as Leaflet circle markers. Layers above the cap are noted in the log but not drawn (prevents browser freeze on large files).
5. **Shows the polygon selector** — any layer containing Polygon/LinearRing geometry appears in a `<select>` dropdown. Choosing one activates it as a spatial filter on the map.

---

## 3. Spatial Filtering (optional)

Two ways to define a filter region:

| Method | How |
|--------|-----|
| Draw rectangle | Leaflet.draw rectangle tool; bounds sent as `[[latSW,lngSW],[latNE,lngNE]]` |
| Draw polygon | Leaflet.draw polygon tool; coords sent as `[[lat,lng],...]` |
| Pick a layer | Choose a polygon layer from the dropdown → its coordinates become the filter |
| Upload polygon file | `POST /parse-polygon` → server extracts first polygon from the file |

The active filter is stored client-side and included in the `/convert` request body.

---

## 4. Export Flow (`POST /convert`)

```
Browser                         server.js                lib-convert.js    lib-zip.js
  │                                 │                          │                │
  │  POST /convert                  │                          │                │
  │  { sessionId,                   │                          │                │
  │    fieldKeys[],                 │                          │                │
  │    layerKeys[],                 │                          │                │
  │    spatialFilter,               │                          │                │
  │    delimiter, precision, … }    │                          │                │
  │────────────────────────────────>│                          │                │
  │                                 │  look up session         │                │
  │                                 │  validate inputs         │                │
  │                                 │                          │                │
  │                                 │  for each selected layer:│                │
  │                                 │    filter rows by layerKey                │
  │                                 │    applySpatialFilter() ─>│               │
  │                                 │                          │ rectangle:     │
  │                                 │                          │   bounds check │
  │                                 │                          │ polygon:       │
  │                                 │                          │   ray-cast     │
  │                                 │<─────────────────────────│                │
  │                                 │  filtered rows           │                │
  │                                 │                          │                │
  │                                 │  layerHasLines()?        │                │
  │                                 │    yes → rowsToKml()     │                │
  │                                 │    no  → rowsToCsv()     │                │
  │                                 │                          │                │
  │                                 │  1 layer:  send file directly             │
  │                                 │  >1 layer: ZipWriter ────────────────────>│
  │                                 │                          │  addFile(name, │
  │                                 │                          │    bytes) ×N   │
  │                                 │                          │  finish() ────>│
  │                                 │<──────────────────────────────────────────│
  │                                 │  Uint8Array ZIP          │                │
  │                                 │  writeLog(ok/error)      │                │
  │<────────────────────────────────│                          │                │
  │  .csv / .kml / .zip download    │                          │                │
```

**Output format rules:**

| Condition | Output format |
|-----------|---------------|
| 1 layer, no line geometry | `<name>.csv` |
| 1 layer, has LineString/LinearRing | `<name>.kml` |
| Multiple layers | `.zip` with one `.csv` or `.kml` per layer |

---

## 5. KMZ / ZIP Parsing Detail (lib-parse.js)

KMZ is just a ZIP containing one or more `.kml` files. The parser handles it entirely in memory:

```
Buffer (raw bytes)
  │
  ├─ looksLikeZip()  checks PK magic bytes (0x50 0x4B)
  │
  ├─ [KMZ path]
  │   buildCentralDirectoryOffsets()   — scan EOCD → parse central directory
  │                                      builds name → {compSize, uncompSize} map
  │   walk local file headers
  │     method=0 (STORE):  slice bytes directly
  │     method=8 (DEFLATE): inflateRaw() → Uint8Array
  │   collect all .kml entries → [{name, bytes}]
  │
  └─ [KML path]
      decode buffer (UTF-8, fallback latin-1)
      return [{name, text}]

For each KML text:
  fast-xml-parser → JS object tree
  walkContainer(tree, layerStack=[])
    Document / Folder  → push name onto layerStack, recurse
    Placemark          → extract ExtendedData, walk geometry
      Point / LineString / LinearRing / Track
        → pushCoordRows(coordinates, geometryType, base)
      Polygon
        → outerBoundaryIs / innerBoundaryIs → LinearRing → pushCoordRows
      MultiGeometry
        → recurse into nested geometry elements
```

Each `pushCoordRows` call splits a `<coordinates>` text string on whitespace, parses `lon,lat[,alt]` tuples, validates WGS-84 range, and pushes one row per valid tuple.

---

## 6. ZIP Writing Detail (lib-zip.js)

A minimal, dependency-free ZIP writer using the **STORE** method (no compression):

```
ZipWriter
  addFile(name, bytes)
    → buildLocalFileHeader()  (PK\x03\x04 signature)
    → push nameBytes + fileBytes
    → record {localOffset, crc32, size}

  finish()
    → write central directory records  (PK\x01\x02 per file)
    → write end-of-central-directory   (PK\x05\x06)
    → concat all chunks → single Uint8Array
```

CRC-32 uses the standard ZIP polynomial (0xEDB88320, Castagnoli).

---

## 7. Spatial Filter Logic (lib-convert.js)

**Rectangle filter:** simple lat/lng bounding box comparison.

**Polygon filter:** ray-casting algorithm. For point `(lat, lon)`, cast a horizontal ray to the right (+∞ longitude). Count how many polygon edges cross the ray. Odd count = inside.

**`keepCrossingLines` mode:** for line geometry (LineString, LinearRing), the entire Placemark is kept if *any* of its points are inside the filter. This prevents lines from being split at the filter boundary.

---

## 8. Session Store

Sessions live in a `Map` in the Express process. There is no database.

```
sessions: Map<sessionId (hex UUID), {
  rows:       object[],   // all parsed rows, kept in RAM
  createdAt:  number,     // Date.now() at inspect time
  ip:         string,
  userId:     string,     // cookie-based stable user ID
  files:      string[],   // original filenames
}>

MAX_SESSIONS = 50         // refuse /inspect if at capacity
TTL          = 1 hour     // sessions.delete() runs on a 5-min interval
```
