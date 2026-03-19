# GeoPoint Saver Simple

A simplified, self-contained web application for converting KML and KMZ files to CSV. Upload files directly through the browser — no email integration, no Google Drive, no database required.

## What It Does

- Accepts KML and KMZ file uploads via drag-and-drop or file browser
- Parses all placemarks and layers from the uploaded files
- Displays points on an interactive Leaflet map
- Supports spatial filtering via drawn rectangles or polygons
- Exports selected layers and fields as CSV (or KML for line geometry)
- Multiple files/layers are bundled into a ZIP archive automatically

## Stack

- **Runtime:** Node.js 18+
- **Framework:** Express
- **File parsing:** `fast-xml-parser`, `@xmldom/xmldom`
- **Upload handling:** Multer (memory storage)
- **Rate limiting:** `express-rate-limit`
- **Logging:** File-based JSON log (`DATA_DIR/logs/access.log`), in-memory ring buffer (last 1000 entries)
- **Database:** None
- **Frontend:** Vanilla JS, Leaflet, Leaflet.draw

## Quick Start (deploy.sh)

Run as root on a Debian/Ubuntu server:

```bash
git clone https://github.com/dfrederick15/geopoint-saver-simple.git
cd geopoint-saver-simple
bash deploy.sh
```

The script will:
1. Install Node.js 20 if not present
2. Create the data directory (`/opt/geopoint-saver-simple`)
3. Run `npm install`
4. Generate a `.env` file
5. Install and start a systemd service (`geopoint-saver-simple`)

## Manual Setup

```bash
npm install
cp .env.example .env   # or create .env manually
npm start
```

### .env file

```env
PORT=3001
DATA_DIR=/opt/geopoint-saver-simple
```

## Environment Variables

| Variable             | Default                       | Description                                                             |
|----------------------|-------------------------------|-------------------------------------------------------------------------|
| `PORT`               | `3001`                        | TCP port the server listens on (binds to 127.0.0.1)                    |
| `DATA_DIR`           | `/opt/geopoint-saver-simple`  | Directory for log files (`logs/access.log`)                             |

## API Endpoints

| Method | Path             | Description                                                   |
|--------|------------------|---------------------------------------------------------------|
| POST   | `/inspect`       | Upload KML/KMZ files; returns parsed rows, fields, and layers |
| POST   | `/convert`       | Convert a parsed session to CSV/KML/ZIP using a `sessionId`   |
| POST   | `/parse-polygon` | Upload a KML/KMZ file; extract the first polygon for spatial filtering |
| GET    | `/load`          | Returns current server load percentage                        |

## Upload Data Flow

```mermaid
flowchart TD
    A([Browser\ndrops or selects file]) --> B["POST /inspect\nmultipart/form-data"]
    B --> C[Rate limiter\n30 req / 15 min]
    C --> D[Multer\nreads file into memory]
    D --> E{KMZ or KML?}

    E -->|KMZ| F[Walk ZIP local headers\nextract .kml entries\ndecompress DEFLATE]
    E -->|KML| G[Decode UTF-8 text]

    F --> H[fast-xml-parser\nparse XML]
    G --> H

    H --> I[Walk Document / Folder / Placemark tree\nextract coordinates + ExtendedData]
    I --> J[Flat rows array\nstored in server session\n30-min TTL]
    J --> K[Return sessionId · rows · fields · layers]

    K --> L([Browser\nrenders map + field/layer picker])

    L --> M["POST /convert\nsessionId + field/layer selection + options"]
    M --> N[Rate limiter\n60 req / 15 min]
    N --> O[Session lookup]

    O --> P{Spatial filter?}
    P -->|Rectangle| Q[Bounding-box test]
    P -->|Polygon| R[Ray-cast point-in-polygon]
    P -->|None| S[All rows pass]

    Q --> T{Line geometry?}
    R --> T
    S --> T

    T -->|Yes| U[rowsToKml\nreconstruct Placemarks]
    T -->|No| V[rowsToCsv\nserialise selected fields]

    U --> W{Multiple outputs?}
    V --> W

    W -->|Yes| X[ZipWriter\nbundle files — STORE method]
    W -->|No| Y[Single file]

    X --> Z([Download .zip])
    Y --> Z2([Download .csv or .kml])
```

## Security

- **No cookies or sessions stored client-side:** User identity uses a UUID stored in `localStorage` and sent as `X-User-Id`.
- **Rate limiting:** `/inspect` is limited to 30 requests per 15 minutes per IP; `/convert` to 60 requests per 15 minutes.
- **Security headers:** `X-Content-Type-Options`, `X-Frame-Options`, and a strict `Content-Security-Policy` are set on every response.
- **No file persistence:** Uploaded files are held in memory only for the duration of the session (max 30 minutes) and never written to disk.
